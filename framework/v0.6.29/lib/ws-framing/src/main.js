/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/ws-framing
 *
 * RFC 6455 WebSocket framing codec — frame encoder + incremental parser.
 *
 * Responsibilities:
 *  - Build frames (§5.2 base framing): minimal length encoding across the
 *    7-bit / 16-bit / 64-bit forms, control-frame constraints, optional
 *    masking (client direction / tests).
 *  - Parse an inbound byte stream incrementally: fragmentation reassembly
 *    (§5.4), control frames (§5.5), close-code validation (§7.4), UTF-8
 *    validation of text payloads and close reasons (§8.1), client-masking
 *    enforcement (§5.1).
 *  - Enforce implementation-specific limits (§10.4): `maxPayload` across a
 *    reassembled message — rejected at header time from the DECLARED length,
 *    before any payload is buffered — and `maxFragments` per message.
 *
 * Out of scope (by design):
 *  - Transport I/O — consumers feed received bytes to a parser instance and
 *    write encoded buffers to their own stream. Per RFC 8441 §5 an HTTP/2
 *    extended-CONNECT stream is used "as if it were the TCP connection"
 *    of RFC 6455, so the codec is transport-agnostic.
 *  - permessage-deflate / extension negotiation — an inbound non-zero RSV
 *    bit is a 1002 protocol error.
 *  - The opening handshake (HTTP/1.1 Upgrade or RFC 8441 extended CONNECT)
 *    and masking-key unpredictability (a client obligation, §10.3).
 *
 * This module is pure — node builtins only (`buffer`, `crypto`), no lib
 * registry requires, no framework globals — so it is unit-testable by a
 * direct require. Same contract as {@link module:gina/lib/routing-introspect}.
 *
 * @example
 *  var wsf = require('lib/ws-framing'); // or lib.wsFraming from the registry
 *  var parser = wsf.createParser({
 *      onMessage : function(data, isBinary) { ... },
 *      onPing    : function(payload) { stream.write(wsf.encodePong(payload)); },
 *      onClose   : function(code, reason) { ... },
 *      onError   : function(err) { stream.write(wsf.encodeClose(err.closeCode)); }
 *  });
 *  stream.on('data', function(chunk) { parser.feed(chunk); });
 *  stream.write(wsf.encodeText('hello'));
 */

var crypto = require('crypto');
// Core UTF-8 validator — ships with node >= 18.14 (gina's engines floor is higher).
var isUtf8 = require('buffer').isUtf8;

/**
 * RFC 6455 §5.2 opcodes (0x3-0x7 and 0xB-0xF are reserved and rejected).
 *
 * @constant
 * @type {object}
 */
var OPCODES = {
    CONTINUATION : 0x0,
    TEXT         : 0x1,
    BINARY       : 0x2,
    CLOSE        : 0x8,
    PING         : 0x9,
    PONG         : 0xA
};

/**
 * Default cap on a reassembled message payload, in bytes (§10.4).
 *
 * @constant
 * @type {number}
 */
var DEFAULT_MAX_PAYLOAD = 1048576; // 1 MiB

/**
 * Default cap on the number of fragments a single message may span (§10.4).
 *
 * @constant
 * @type {number}
 */
var DEFAULT_MAX_FRAGMENTS = 100;

/**
 * §7.4 — is `code` a status code an endpoint may legitimately put on the
 * wire in a Close frame body? 1000-1003 and 1007-1014 are defined or
 * IANA-registered; 1004 is reserved; 1005, 1006 and 1015 are reserved for
 * code-absent / abnormal-closure / TLS-failure reporting and MUST NOT be
 * sent; 3000-4999 are the registered-use and private-use ranges.
 *
 * @function isValidCloseCode
 * @param {number} code - candidate Close status code
 * @returns {boolean} true when the code is valid on the wire
 * @example
 *  isValidCloseCode(1000); // true
 *  isValidCloseCode(1005); // false — reserved, never on the wire
 *  isValidCloseCode(4000); // true — private use
 */
function isValidCloseCode(code) {
    return (
        (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006)
        || (code >= 3000 && code <= 4999)
    );
}

/**
 * Builds a single RFC 6455 frame (§5.2) with minimal length encoding.
 *
 * Encode-side constraint violations throw (they are consumer bugs, not wire
 * data): unknown opcode, control frame above 125 bytes, fragmented control
 * frame.
 *
 * @function encodeFrame
 * @param {object} options
 * @param {number} options.opcode - one of the {@link module:gina/lib/ws-framing~OPCODES} values
 * @param {Buffer|string} [options.payload] - frame payload (strings are encoded as UTF-8)
 * @param {boolean} [options.fin=true] - FIN bit
 * @param {boolean} [options.mask=false] - mask the payload (client direction / tests)
 * @param {Buffer} [options.maskKey] - 4-byte masking key; random when omitted
 * @returns {Buffer} the encoded frame
 * @throws {TypeError|RangeError} on encode-side constraint violations
 * @example
 *  encodeFrame({ opcode: OPCODES.TEXT, payload: 'abc' });
 *  // → <Buffer 81 03 61 62 63>
 */
function encodeFrame(options) {
    if (!options || typeof options !== 'object') {
        throw new TypeError('encodeFrame(options) requires an options object');
    }
    var opcode = options.opcode;
    if (
        opcode !== OPCODES.CONTINUATION && opcode !== OPCODES.TEXT
        && opcode !== OPCODES.BINARY && opcode !== OPCODES.CLOSE
        && opcode !== OPCODES.PING && opcode !== OPCODES.PONG
    ) {
        throw new TypeError('unknown or reserved opcode: ' + opcode);
    }

    var payload = options.payload;
    if (payload == null) {
        payload = Buffer.alloc(0);
    } else if (typeof payload === 'string') {
        payload = Buffer.from(payload, 'utf8');
    } else if (!Buffer.isBuffer(payload)) {
        throw new TypeError('payload must be a Buffer or a string');
    }

    var fin  = options.fin !== false;
    var mask = options.mask === true;
    var isControl = (opcode & 0x8) === 0x8;
    if (isControl) {
        if (payload.length > 125) {
            throw new RangeError('control frame payload must be <= 125 bytes (RFC 6455 §5.5)');
        }
        if (!fin) {
            throw new RangeError('control frames must not be fragmented (RFC 6455 §5.5)');
        }
    }

    var len = payload.length;
    var extLen = (len >= 65536) ? 8 : ((len >= 126) ? 2 : 0);
    var header = Buffer.allocUnsafe(2 + extLen + (mask ? 4 : 0));
    header[0] = (fin ? 0x80 : 0x00) | opcode;
    var offset = 2;
    if (extLen === 0) {
        header[1] = len;
    } else if (extLen === 2) {
        header[1] = 126;
        header.writeUInt16BE(len, 2);
        offset = 4;
    } else {
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(len), 2);
        offset = 10;
    }

    if (!mask) {
        return Buffer.concat([header, payload]);
    }

    header[1] |= 0x80;
    var key = (Buffer.isBuffer(options.maskKey) && options.maskKey.length === 4)
        ? options.maskKey
        : crypto.randomBytes(4);
    key.copy(header, offset);
    var masked = Buffer.allocUnsafe(len);
    for (var i = 0; i < len; i++) {
        masked[i] = payload[i] ^ key[i & 3];
    }
    return Buffer.concat([header, masked]);
}

/**
 * Builds a TEXT frame (UTF-8).
 *
 * @function encodeText
 * @param {string|Buffer} text
 * @param {object} [options] - forwarded to {@link module:gina/lib/ws-framing~encodeFrame} (fin/mask/maskKey)
 * @returns {Buffer}
 * @example
 *  stream.write(encodeText('hello'));
 */
function encodeText(text, options) {
    options = options || {};
    return encodeFrame({
        opcode  : OPCODES.TEXT,
        payload : text,
        fin     : options.fin,
        mask    : options.mask,
        maskKey : options.maskKey
    });
}

/**
 * Builds a BINARY frame.
 *
 * @function encodeBinary
 * @param {Buffer} data
 * @param {object} [options] - forwarded to {@link module:gina/lib/ws-framing~encodeFrame} (fin/mask/maskKey)
 * @returns {Buffer}
 * @example
 *  stream.write(encodeBinary(Buffer.from([1, 2, 3])));
 */
function encodeBinary(data, options) {
    options = options || {};
    return encodeFrame({
        opcode  : OPCODES.BINARY,
        payload : data,
        fin     : options.fin,
        mask    : options.mask,
        maskKey : options.maskKey
    });
}

/**
 * Builds a PING frame (§5.5.2). Payload must be <= 125 bytes.
 *
 * @function encodePing
 * @param {Buffer|string} [payload]
 * @param {object} [options] - forwarded to {@link module:gina/lib/ws-framing~encodeFrame} (mask/maskKey)
 * @returns {Buffer}
 * @example
 *  stream.write(encodePing());
 */
function encodePing(payload, options) {
    options = options || {};
    return encodeFrame({
        opcode  : OPCODES.PING,
        payload : payload,
        mask    : options.mask,
        maskKey : options.maskKey
    });
}

/**
 * Builds a PONG frame (§5.5.3) — echo the ping's application data verbatim.
 *
 * @function encodePong
 * @param {Buffer|string} [payload]
 * @param {object} [options] - forwarded to {@link module:gina/lib/ws-framing~encodeFrame} (mask/maskKey)
 * @returns {Buffer}
 * @example
 *  parser = createParser({ onPing: function(p) { stream.write(encodePong(p)); } });
 */
function encodePong(payload, options) {
    options = options || {};
    return encodeFrame({
        opcode  : OPCODES.PONG,
        payload : payload,
        mask    : options.mask,
        maskKey : options.maskKey
    });
}

/**
 * Builds a CLOSE frame (§5.5.1): empty body, or a 2-byte status code
 * followed by an optional UTF-8 reason (reason capped at 123 bytes so the
 * control-frame limit holds).
 *
 * @function encodeClose
 * @param {number} [code] - Close status code; omit for an empty body
 * @param {string} [reason] - UTF-8 close reason
 * @param {object} [options] - forwarded to {@link module:gina/lib/ws-framing~encodeFrame} (mask/maskKey)
 * @returns {Buffer}
 * @throws {RangeError} on an invalid/unsendable code (e.g. 1005, 1006, 1015) or an oversized reason
 * @example
 *  stream.write(encodeClose(1000, 'bye'));
 */
function encodeClose(code, reason, options) {
    options = options || {};
    var payload;
    if (typeof code === 'undefined') {
        payload = Buffer.alloc(0);
    } else {
        if (typeof code !== 'number' || !isValidCloseCode(code)) {
            throw new RangeError('invalid Close frame status code: ' + code + ' (RFC 6455 §7.4)');
        }
        var reasonBuf = (typeof reason === 'string' && reason.length > 0)
            ? Buffer.from(reason, 'utf8')
            : Buffer.alloc(0);
        if (reasonBuf.length > 123) {
            throw new RangeError('Close frame reason must be <= 123 bytes (RFC 6455 §5.5)');
        }
        payload = Buffer.allocUnsafe(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
    }
    return encodeFrame({
        opcode  : OPCODES.CLOSE,
        payload : payload,
        mask    : options.mask,
        maskKey : options.maskKey
    });
}

/** @private no-op default handler */
function noop() {}

/**
 * Parser options.
 *
 * @typedef {object} WsParserOptions
 * @property {number}   [maxPayload=1048576] - cap on a reassembled message payload in bytes (§10.4)
 * @property {number}   [maxFragments=100] - cap on fragments per message (§10.4)
 * @property {boolean}  [isServer=true] - server mode: inbound frames MUST be masked (§5.1); client mode: inbound frames MUST NOT be masked
 * @property {function} [onMessage] - (data, isBinary): text arrives as a validated UTF-8 string, binary as a Buffer
 * @property {function} [onPing] - (payload Buffer) — the consumer answers with a PONG echoing the payload
 * @property {function} [onPong] - (payload Buffer)
 * @property {function} [onClose] - (code, reason): code is 1005 when the Close body was empty (§7.4.1 "no status code was actually present")
 * @property {function} [onError] - (err): err.closeCode carries the §7.4 status code to send back before tearing down
 */

/**
 * Incremental RFC 6455 frame parser for one connection.
 *
 * Feed inbound bytes with {@link WsParser#feed}; results surface through the
 * option callbacks. On a protocol violation the parser reports `onError`
 * with `err.closeCode` and goes permanently dead ("Fail the WebSocket
 * Connection", §7.1.7 — no further input is processed). After a valid Close
 * frame it reports `onClose` and likewise stops processing.
 *
 * @class
 * @constructor
 * @param {WsParserOptions} [options]
 */
function WsParser(options) {
    options = options || {};
    /** @private @type {number} */
    this._maxPayload = (typeof options.maxPayload === 'number' && options.maxPayload > 0)
        ? options.maxPayload
        : DEFAULT_MAX_PAYLOAD;
    /** @private @type {number} */
    this._maxFragments = (typeof options.maxFragments === 'number' && options.maxFragments > 0)
        ? options.maxFragments
        : DEFAULT_MAX_FRAGMENTS;
    /** @private @type {boolean} */
    this._isServer = options.isServer !== false;
    /** @private */
    this._onMessage = (typeof options.onMessage === 'function') ? options.onMessage : noop;
    /** @private */
    this._onPing = (typeof options.onPing === 'function') ? options.onPing : noop;
    /** @private */
    this._onPong = (typeof options.onPong === 'function') ? options.onPong : noop;
    /** @private */
    this._onClose = (typeof options.onClose === 'function') ? options.onClose : noop;
    /** @private */
    this._onError = (typeof options.onError === 'function') ? options.onError : noop;
    /** @private @type {Buffer|null} buffered inbound bytes (bounded by maxPayload + frame header) */
    this._buf = null;
    /** @private @type {object|null} open fragmented message { opcode, chunks, length, count } */
    this._fragments = null;
    /** @private @type {boolean} failed or close-received — all further input is ignored */
    this._dead = false;
}

/**
 * Feeds inbound transport bytes to the parser. Partial frames are buffered;
 * multiple complete frames in one chunk are all processed. Never throws on
 * wire data — protocol violations surface through `onError`.
 *
 * @param {Buffer} chunk
 * @returns {void}
 * @example
 *  stream.on('data', function(chunk) { parser.feed(chunk); });
 */
WsParser.prototype.feed = function(chunk) {
    if (this._dead) {
        return;
    }
    if (!Buffer.isBuffer(chunk)) {
        chunk = Buffer.from(chunk);
    }
    this._buf = this._buf ? Buffer.concat([this._buf, chunk]) : chunk;
    var frame;
    while (!this._dead && (frame = this._readFrame()) !== null) {
        this._processFrame(frame);
    }
};

/**
 * Whether the parser has stopped processing input (protocol failure or a
 * received Close frame).
 *
 * @returns {boolean}
 */
WsParser.prototype.isDead = function() {
    return this._dead;
};

/**
 * Attempts to read one complete frame off the buffer. Returns null when more
 * bytes are needed OR when the parser failed (callers must re-check state).
 * Header-time validations run before any payload is buffered: RSV bits,
 * control-frame constraints, minimal length encoding, masking direction, and
 * the §10.4 declared-length cap.
 *
 * @private
 * @returns {object|null} `{ fin, opcode, payload }` with the payload unmasked
 */
WsParser.prototype._readFrame = function() {
    var buf = this._buf;
    if (!buf || buf.length < 2) {
        return null;
    }
    var b0 = buf[0];
    var b1 = buf[1];
    var opcode = b0 & 0x0F;
    var fin    = (b0 & 0x80) === 0x80;
    var rsv    = b0 & 0x70;
    var masked = (b1 & 0x80) === 0x80;
    var len7   = b1 & 0x7F;
    var isControl = (opcode & 0x8) === 0x8;

    if (rsv !== 0) {
        return this._fail(1002, 'non-zero RSV bits with no negotiated extension (RFC 6455 §5.2)');
    }
    if (isControl && (len7 > 125 || !fin)) {
        return this._fail(1002, 'control frames must be unfragmented with payload <= 125 bytes (RFC 6455 §5.5)');
    }
    if (this._isServer && !masked) {
        return this._fail(1002, 'unmasked client frame (RFC 6455 §5.1)');
    }
    if (!this._isServer && masked) {
        return this._fail(1002, 'masked server frame (RFC 6455 §5.1)');
    }

    var headerLen = 2;
    var len = len7;
    if (len7 === 126) {
        if (buf.length < 4) {
            return null;
        }
        len = buf.readUInt16BE(2);
        headerLen = 4;
        if (len < 126) {
            return this._fail(1002, 'non-minimal 16-bit length encoding (RFC 6455 §5.2)');
        }
    } else if (len7 === 127) {
        if (buf.length < 10) {
            return null;
        }
        var hi = buf.readUInt32BE(2);
        var lo = buf.readUInt32BE(6);
        if ((hi & 0x80000000) !== 0) {
            return this._fail(1002, '64-bit length with the most significant bit set (RFC 6455 §5.2)');
        }
        len = hi * 4294967296 + lo;
        headerLen = 10;
        if (len < 65536) {
            return this._fail(1002, 'non-minimal 64-bit length encoding (RFC 6455 §5.2)');
        }
    }

    // §10.4 — reject an oversized DECLARED length now, before buffering the
    // payload (a 2**60-byte announcement must not cost 2**60 bytes of memory).
    if (!isControl) {
        var already = this._fragments ? this._fragments.length : 0;
        if (len > this._maxPayload - already) {
            return this._fail(1009, 'message exceeds maxPayload (' + this._maxPayload + ' bytes)');
        }
    }

    var maskLen = masked ? 4 : 0;
    var total = headerLen + maskLen + len;
    if (buf.length < total) {
        return null; // wait for more bytes
    }

    // Copy the payload out so the retained slice does not pin the whole buffer.
    var payload = Buffer.allocUnsafe(len);
    buf.copy(payload, 0, headerLen + maskLen, total);
    if (masked) {
        for (var i = 0; i < len; i++) {
            payload[i] ^= buf[headerLen + (i & 3)];
        }
    }
    this._buf = (total === buf.length) ? null : buf.slice(total);
    return { fin: fin, opcode: opcode, payload: payload };
};

/**
 * Routes one complete, unmasked frame through the §5.4/§5.5 rules.
 *
 * @private
 * @param {object} frame - `{ fin, opcode, payload }`
 * @returns {void}
 */
WsParser.prototype._processFrame = function(frame) {
    var opcode = frame.opcode;

    if (opcode === OPCODES.TEXT || opcode === OPCODES.BINARY) {
        if (this._fragments) {
            return this._fail(1002, 'new data frame interleaved within a fragmented message (RFC 6455 §5.4)');
        }
        if (frame.fin) {
            return this._deliver(opcode, frame.payload);
        }
        this._fragments = {
            opcode : opcode,
            chunks : [frame.payload],
            length : frame.payload.length,
            count  : 1
        };
        return;
    }

    if (opcode === OPCODES.CONTINUATION) {
        if (!this._fragments) {
            return this._fail(1002, 'continuation frame with no message in progress (RFC 6455 §5.4)');
        }
        this._fragments.count++;
        if (this._fragments.count > this._maxFragments) {
            return this._fail(1008, 'message exceeds maxFragments (' + this._maxFragments + ')');
        }
        this._fragments.chunks.push(frame.payload);
        this._fragments.length += frame.payload.length;
        if (frame.fin) {
            var message = Buffer.concat(this._fragments.chunks, this._fragments.length);
            var dataOpcode = this._fragments.opcode;
            this._fragments = null;
            return this._deliver(dataOpcode, message);
        }
        return;
    }

    // Control frames MAY be injected between fragments (§5.4) — they do not
    // touch this._fragments.
    if (opcode === OPCODES.CLOSE) {
        return this._handleClose(frame.payload);
    }
    if (opcode === OPCODES.PING) {
        this._onPing(frame.payload);
        return;
    }
    if (opcode === OPCODES.PONG) {
        this._onPong(frame.payload);
        return;
    }

    return this._fail(1002, 'reserved opcode 0x' + opcode.toString(16) + ' (RFC 6455 §5.2)');
};

/**
 * Delivers a complete message: text is UTF-8-validated (§8.1, whole-message
 * validation after reassembly) and handed over as a string; binary as a Buffer.
 *
 * @private
 * @param {number} opcode - TEXT or BINARY
 * @param {Buffer} payload
 * @returns {void}
 */
WsParser.prototype._deliver = function(opcode, payload) {
    if (opcode === OPCODES.TEXT) {
        if (!isUtf8(payload)) {
            return this._fail(1007, 'text message payload is not valid UTF-8 (RFC 6455 §8.1)');
        }
        this._onMessage(payload.toString('utf8'), false);
        return;
    }
    this._onMessage(payload, true);
};

/**
 * Handles a Close frame body (§5.5.1): empty → code 1005 ("no status code
 * was actually present"); a 1-byte body is malformed; otherwise a 2-byte
 * code validated against §7.4 plus a UTF-8-validated reason.
 *
 * @private
 * @param {Buffer} payload
 * @returns {void}
 */
WsParser.prototype._handleClose = function(payload) {
    var code = 1005;
    var reason = '';
    if (payload.length === 1) {
        return this._fail(1002, '1-byte Close frame body (RFC 6455 §5.5.1)');
    }
    if (payload.length >= 2) {
        code = payload.readUInt16BE(0);
        if (!isValidCloseCode(code)) {
            return this._fail(1002, 'invalid Close frame status code ' + code + ' (RFC 6455 §7.4)');
        }
        var reasonBuf = payload.slice(2);
        if (!isUtf8(reasonBuf)) {
            return this._fail(1007, 'Close frame reason is not valid UTF-8 (RFC 6455 §8.1)');
        }
        reason = reasonBuf.toString('utf8');
    }
    this._dead = true;
    this._buf = null;
    this._fragments = null;
    this._onClose(code, reason);
};

/**
 * "Fail the WebSocket Connection" (§7.1.7): report the violation with the
 * §7.4 status code the consumer should send back, drop all buffered state,
 * and stop processing input permanently.
 *
 * @private
 * @param {number} closeCode - §7.4 status code (1002, 1007, 1008, 1009, ...)
 * @param {string} message
 * @returns {null} so `_readFrame` callers uniformly stop their read loop
 */
WsParser.prototype._fail = function(closeCode, message) {
    this._dead = true;
    this._buf = null;
    this._fragments = null;
    var err = new Error(message);
    err.closeCode = closeCode;
    this._onError(err);
    return null;
};

/**
 * Creates an incremental parser for one connection.
 *
 * @function createParser
 * @param {WsParserOptions} [options]
 * @returns {WsParser}
 * @example
 *  var parser = createParser({ onMessage: function(data, isBinary) { ... } });
 *  parser.feed(chunkFromTheWire);
 */
function createParser(options) {
    return new WsParser(options);
}

module.exports = {
    OPCODES               : OPCODES,
    DEFAULT_MAX_PAYLOAD   : DEFAULT_MAX_PAYLOAD,
    DEFAULT_MAX_FRAGMENTS : DEFAULT_MAX_FRAGMENTS,
    isValidCloseCode      : isValidCloseCode,
    encodeFrame           : encodeFrame,
    encodeText            : encodeText,
    encodeBinary          : encodeBinary,
    encodePing            : encodePing,
    encodePong            : encodePong,
    encodeClose           : encodeClose,
    createParser          : createParser
};
