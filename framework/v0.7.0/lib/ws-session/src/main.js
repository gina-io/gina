/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/ws-session
 *
 * WebSocket-over-HTTP/2 session bridge (RFC 8441 §5: the extended-CONNECT
 * stream is used "as if it were the TCP connection" of RFC 6455).
 *
 * Responsibilities:
 *  - `accept(request)`: answer the extended CONNECT with `:status 200` on the
 *    raw Http2Stream and wrap the stream + a `lib/ws-framing` parser into a
 *    {@link WsSession} with a send / ping / close API.
 *  - Protocol housekeeping: auto-pong (§5.5.2), close-handshake echo and a
 *    timed initiated close (§5.5.1 / §7), protocol violations answered with
 *    the prescribed status code then torn down.
 *  - Lifecycle: teardown on stream `close` / `error` / `aborted` (the HTTP/2
 *    analogs of TCP close/RST per RFC 8441 §5), and registration into the
 *    framework's graceful-shutdown drain registry
 *    (`process.gina._sseConnections`) so SIGTERM closes live sessions with a
 *    `1001 going away` instead of blocking the server drain.
 *  - Containment: consumer callbacks and transport writes are guarded —
 *    nothing thrown by a handler or a dying stream escalates to an
 *    uncaughtException (which would take the whole bundle down).
 *
 * Out of scope (by design):
 *  - Frame parsing/building rules — `lib/ws-framing` owns RFC 6455 §5/§7/§8.
 *  - The extended-CONNECT detection and refusal table — the Isaac engine owns
 *    those; this module only ever sees an already-accepted websocket stream.
 *  - Authentication — the consumer decides from the request it is handed.
 *
 * @example
 *  // from a bundle's onInitialize (app is the raw HTTP/2 server):
 *  app.onWebSocket('/live', function(session, request) {
 *      session.onMessage(function(data, isBinary) { session.send('echo: ' + data); });
 *      session.onClose(function(code, reason) { ... });
 *  });
 */

var wsf = require('../../ws-framing/src/main');

/** @private no-op default handler */
function noop() {}

/**
 * Session options.
 *
 * @typedef {object} WsSessionOptions
 * @property {number}  [maxPayload] - forwarded to the ws-framing parser (§10.4 cap)
 * @property {number}  [maxFragments] - forwarded to the ws-framing parser (§10.4 cap)
 * @property {number}  [closeTimeout=5000] - ms to wait for the peer's Close frame after an initiated close before force-ending the stream
 * @property {boolean} [autoPong=true] - answer inbound PINGs automatically (§5.5.2)
 * @property {string}  [protocol] - subprotocol to echo in the `sec-websocket-protocol` response header
 */

/**
 * One live WebSocket-over-HTTP/2 session. Construct via
 * {@link module:gina/lib/ws-session~accept} — never directly.
 *
 * Consumer callbacks are registered with the chainable `onMessage` /
 * `onPing` / `onPong` / `onClose` / `onError` setters. `onClose` is the
 * single TERMINAL event (normal close, protocol failure, or transport
 * teardown — exactly once); `onError` is diagnostic and may precede it.
 *
 * @class
 * @constructor
 * @param {object} stream - the raw Http2Stream of the accepted extended CONNECT
 * @param {WsSessionOptions} [options]
 */
function WsSession(stream, options) {
    options = options || {};
    var self = this;

    /** @private */
    this._stream = stream;
    /** @private @type {number} */
    this._closeTimeout = (typeof options.closeTimeout === 'number' && options.closeTimeout > 0)
        ? options.closeTimeout
        : 5000;
    /** @private @type {boolean} */
    this._autoPong = options.autoPong !== false;
    /** @private consumer callbacks (chainable setters below) */
    this._handlers = { message: noop, ping: noop, pong: noop, close: noop, error: noop, drain: noop };
    /** @private @type {boolean} a Close frame has been written to the wire */
    this._closeSent = false;
    /** @private @type {boolean} the terminal onClose has been delivered */
    this._finished = false;
    /** @private @type {object|null} */
    this._closeTimer = null;
    /** @private graceful-shutdown drain callback registered on process.gina._sseConnections */
    this._shutdownCloser = function() {
        try { self.close(1001, 'server shutting down'); } catch (err) { /* already torn down */ }
    };

    /** @private the per-connection RFC 6455 parser */
    this._parser = wsf.createParser({
        maxPayload   : options.maxPayload,
        maxFragments : options.maxFragments,
        isServer     : true,
        onMessage : function(data, isBinary) {
            self._invoke('message', data, isBinary);
        },
        onPing : function(payload) {
            if (self._autoPong) {
                self._write(wsf.encodePong(payload));
            }
            self._invoke('ping', payload);
        },
        onPong : function(payload) {
            self._invoke('pong', payload);
        },
        onClose : function(code, reason) {
            // §5.5.1 — echo the peer's status code (empty body back when the
            // peer sent none: 1005 is reserved and never goes on the wire).
            if (!self._closeSent) {
                self._closeSent = true;
                self._write(
                    (code === 1005)
                        ? wsf.encodeFrame({ opcode: wsf.OPCODES.CLOSE })
                        : wsf.encodeClose(code)
                );
            }
            self._endStream();
            self._finish(code, reason);
        },
        onError : function(err) {
            // Protocol violation: best-effort Close frame with the prescribed
            // code ("Fail the WebSocket Connection", §7.1.7), then teardown.
            if (!self._closeSent) {
                self._closeSent = true;
                try { self._write(wsf.encodeClose(err.closeCode || 1002)); } catch (encErr) { /* best-effort */ }
            }
            self._invoke('error', err);
            self._endStream();
            self._finish(err.closeCode || 1002, err.message);
        }
    });

    stream.on('data', function(chunk) {
        self._parser.feed(chunk);
    });
    // Transport teardown (HTTP/2 END_STREAM / RST_STREAM / session GOAWAY all
    // surface here per RFC 8441 §5). 1006 = abnormal closure — reserved on the
    // wire, legitimate as a LOCAL report (§7.4.1).
    stream.on('close', function() {
        self._finish(1006, '');
    });
    stream.on('error', function(err) {
        // Absorb — a dying client stream must never escalate to uncaughtException.
        self._finish(1006, String((err && err.message) || ''));
    });
    stream.on('aborted', function() {
        self._finish(1006, '');
    });
    if (typeof stream.on === 'function') {
        stream.on('drain', function() {
            self._invoke('drain');
        });
    }

    // Graceful-shutdown drain: proc.js's SIGTERM path iterates this registry
    // and invokes every closer before _httpServer.close(), so live WebSocket
    // sessions end with a clean `1001 going away` instead of blocking the
    // drain until the hard shutdown timeout.
    if (typeof process !== 'undefined' && process.gina) {
        if (!process.gina._sseConnections) {
            process.gina._sseConnections = new Set();
        }
        process.gina._sseConnections.add(this._shutdownCloser);
    }
}

/**
 * Registers the message handler — `(data, isBinary)`: text arrives as a
 * validated UTF-8 string, binary as a Buffer.
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 * @example
 *  session.onMessage(function(data, isBinary) { ... });
 */
WsSession.prototype.onMessage = function(fn) { this._handlers.message = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Registers the ping handler — `(payload Buffer)`. The pong is already sent
 * automatically unless the session was created with `autoPong: false`.
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 */
WsSession.prototype.onPing = function(fn) { this._handlers.ping = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Registers the pong handler — `(payload Buffer)`.
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 */
WsSession.prototype.onPong = function(fn) { this._handlers.pong = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Registers the TERMINAL close handler — `(code, reason)`, delivered exactly
 * once: peer close (the peer's code; 1005 when its Close body was empty),
 * protocol failure (the violation's code), initiated-close completion, or
 * transport teardown (1006).
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 */
WsSession.prototype.onClose = function(fn) { this._handlers.close = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Registers the diagnostic error handler — `(err)` with `err.closeCode` on
 * protocol violations. Always followed by the terminal `onClose`.
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 */
WsSession.prototype.onError = function(fn) { this._handlers.error = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Registers the backpressure-relief handler, forwarded from the underlying
 * stream's `drain` event. Pair with {@link WsSession#send}'s boolean return.
 *
 * @param {function} fn
 * @returns {WsSession} this (chainable)
 */
WsSession.prototype.onDrain = function(fn) { this._handlers.drain = (typeof fn === 'function') ? fn : noop; return this; };

/**
 * Sends a message: a string goes as a TEXT frame, a Buffer as a BINARY frame.
 *
 * @param {string|Buffer} data
 * @returns {boolean} false when the frame could not be written or the
 *  underlying stream signalled backpressure (`stream.write` returned false —
 *  wait for {@link WsSession#onDrain}); true otherwise
 * @example
 *  if (!session.send(bigPayload)) { session.onDrain(resumeSending); }
 */
WsSession.prototype.send = function(data) {
    if (this._finished || this._closeSent) {
        return false;
    }
    var frame = (typeof data === 'string') ? wsf.encodeText(data) : wsf.encodeBinary(data);
    return this._write(frame);
};

/**
 * Sends a PING (§5.5.2). Payload must be <= 125 bytes.
 *
 * @param {string|Buffer} [payload]
 * @returns {boolean} as {@link WsSession#send}
 */
WsSession.prototype.ping = function(payload) {
    if (this._finished || this._closeSent) {
        return false;
    }
    return this._write(wsf.encodePing(payload));
};

/**
 * Initiates the close handshake (§7): sends a Close frame, then waits up to
 * `closeTimeout` ms for the peer's echo before force-ending the stream.
 * Idempotent.
 *
 * @param {number} [code] - §7.4 status code; omit for an empty Close body
 * @param {string} [reason]
 * @returns {void}
 * @example
 *  session.close(1000, 'done');
 */
WsSession.prototype.close = function(code, reason) {
    if (this._finished || this._closeSent) {
        return;
    }
    this._closeSent = true;
    try {
        this._write(
            (typeof code === 'undefined')
                ? wsf.encodeFrame({ opcode: wsf.OPCODES.CLOSE })
                : wsf.encodeClose(code, reason)
        );
    } catch (err) {
        // invalid code/reason from the consumer — still proceed with teardown
    }
    var self = this;
    this._closeTimer = setTimeout(function() {
        self._endStream();
        self._finish((typeof code === 'undefined') ? 1000 : code, reason || '');
    }, this._closeTimeout);
    if (typeof this._closeTimer.unref === 'function') {
        this._closeTimer.unref();
    }
};

/**
 * Whether the session has delivered its terminal close.
 *
 * @returns {boolean}
 */
WsSession.prototype.isClosed = function() {
    return this._finished;
};

/**
 * Invokes a consumer callback with containment: a throwing handler is
 * reported (diagnostic onError, itself guarded) and the session is closed
 * with `1011 internal error` — never an uncaughtException.
 *
 * @private
 */
WsSession.prototype._invoke = function(name) {
    var args = Array.prototype.slice.call(arguments, 1);
    try {
        this._handlers[name].apply(null, args);
    } catch (err) {
        if (name !== 'error') {
            try { this._handlers.error(err); } catch (err2) { /* contained */ }
        }
        console.warn('[ WS-SESSION ] handler `' + name + '` threw: ' + (err && err.message));
        if (name !== 'close') {
            this.close(1011, 'internal error');
        }
    }
};

/**
 * Guarded write to the underlying stream.
 *
 * @private
 * @param {Buffer} buf
 * @returns {boolean} stream.write's backpressure boolean; false when the
 *  stream is gone or the write threw
 */
WsSession.prototype._write = function(buf) {
    var stream = this._stream;
    if (!stream || stream.destroyed || stream.closed || stream.writableEnded) {
        return false;
    }
    try {
        return stream.write(buf) !== false;
    } catch (err) {
        return false;
    }
};

/**
 * Half-closes the transport (HTTP/2 END_STREAM).
 *
 * @private
 */
WsSession.prototype._endStream = function() {
    var stream = this._stream;
    try {
        if (stream && !stream.destroyed && !stream.writableEnded) {
            stream.end();
        }
    } catch (err) { /* already gone */ }
};

/**
 * Delivers the terminal onClose exactly once and releases session resources
 * (close timer, shutdown-drain registration).
 *
 * @private
 * @param {number} code
 * @param {string} reason
 */
WsSession.prototype._finish = function(code, reason) {
    if (this._finished) {
        return;
    }
    this._finished = true;
    if (this._closeTimer) {
        clearTimeout(this._closeTimer);
        this._closeTimer = null;
    }
    if (typeof process !== 'undefined' && process.gina && process.gina._sseConnections) {
        process.gina._sseConnections.delete(this._shutdownCloser);
    }
    this._invoke('close', code, reason || '');
};

/**
 * Accepts an extended-CONNECT websocket request: answers `:status 200`
 * (RFC 8441 §5 — the stream then IS the bidirectional WebSocket channel) and
 * returns the wrapped session.
 *
 * @function accept
 * @param {object} request - the Http2ServerRequest of the extended CONNECT (`request.stream` is the raw Http2Stream)
 * @param {WsSessionOptions} [options]
 * @returns {WsSession}
 * @throws {TypeError} when the request carries no respondable HTTP/2 stream
 * @throws {Error} when the stream is already closed
 * @example
 *  var session = lib.wsSession.accept(request, { maxPayload: 262144 });
 */
function accept(request, options) {
    var stream = request && request.stream;
    if (!stream || typeof stream.respond !== 'function') {
        throw new TypeError('accept(request) requires an HTTP/2 extended-CONNECT request carrying a respondable request.stream');
    }
    if (stream.destroyed || stream.closed) {
        throw new Error('accept(request): the stream is already closed');
    }
    var headers = { ':status': 200 };
    if (options && typeof options.protocol === 'string' && options.protocol.length > 0) {
        headers['sec-websocket-protocol'] = options.protocol;
    }
    stream.respond(headers);
    return new WsSession(stream, options);
}

module.exports = {
    accept    : accept,
    WsSession : WsSession
};
