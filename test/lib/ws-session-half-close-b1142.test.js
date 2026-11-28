/**
 * #B1142 — a WebSocket-over-HTTP/2 session notices a peer that ends its stream without a
 * Close frame.
 *
 * RFC 8441 §5 maps the stream's END_STREAM to the TCP FIN, and RFC 6455 §7.1.5 reports a
 * connection that closes with no Close frame received as 1006. The session listened for the
 * stream's `close`, which comes only once BOTH sides have ended, so after such a half-close it
 * stayed open until the application or the HTTP/2 connection closed it (measured on a node
 * loopback: the stream's `end` at 19 ms, `onClose` silent until the client connection was
 * destroyed). It now ends its own side on `end` and reports 1006 at once.
 *
 *   §01 the half-close arms — `end` alone, `end` after the session's own close(), `end` with a
 *       frame cut short — each delivers `onClose(1006)` exactly once and ends our side.
 *   §02 controls — a Close frame followed by `end` still closes with the peer's code, once; a
 *       `close` alone still reports 1006 (the instrument fires).
 *
 * Harness: the mock Http2Stream of test/lib/ws-session.test.js (an EventEmitter recording what
 * the session writes and whether it ended its side).
 */
'use strict';

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var FW = require('../fw');
var wsSess = require(path.join(FW, 'lib/ws-session/src/main'));
var wsf = require(path.join(FW, 'lib/ws-framing/src/main'));

/** @inner @returns {EventEmitter} a mock Http2Stream (mirrors test/lib/ws-session.test.js) */
function mockStream() {
    var stream = new EventEmitter();
    stream.destroyed = false;
    stream.closed = false;
    stream.writableEnded = false;
    stream.written = [];
    stream.writeReturn = true;
    stream.respond = function() {};
    stream.write = function(buf) { stream.written.push(buf); return stream.writeReturn; };
    stream.end = function() { stream.writableEnded = true; };
    stream.close = function() { stream.closed = true; };
    stream.destroy = function() { stream.destroyed = true; };
    return stream;
}

/**
 * Accepts a session on a mock stream and records its terminal closes.
 * @inner @param {object} [options] WsSessionOptions
 * @returns {{stream: EventEmitter, session: object, closes: Array<{code: number, reason: string}>}}
 */
function setupSession(options) {
    var stream = mockStream();
    var closes = [];
    var session = wsSess.accept({ headers: { ':method': 'CONNECT', ':protocol': 'websocket', ':path': '/ws' }, stream: stream }, options);
    session.onClose(function(c, r) { closes.push({ code: c, reason: r }); });
    return { stream: stream, session: session, closes: closes };
}

var KEY = Buffer.from([9, 8, 7, 6]);
/** @inner @param {string} text @returns {Buffer} a masked client TEXT frame */
function clientText(text) {
    return wsf.encodeFrame({ opcode: wsf.OPCODES.TEXT, payload: text, mask: true, maskKey: KEY });
}
/** @inner @param {number} code @param {string} reason @returns {Buffer} a masked client Close frame */
function clientClose(code, reason) {
    var reasonBuf = Buffer.from(reason, 'utf8');
    var payload = Buffer.alloc(2 + reasonBuf.length);
    payload.writeUInt16BE(code, 0);
    reasonBuf.copy(payload, 2);
    return wsf.encodeFrame({ opcode: wsf.OPCODES.CLOSE, payload: payload, mask: true, maskKey: KEY });
}

describe('01 - a peer that ends its stream without a Close frame', function() {

    it('end alone: onClose(1006) at once, our side ended, exactly once', function() {
        var s = setupSession();
        s.stream.emit('end');
        assert.deepEqual(s.closes, [{ code: 1006, reason: '' }]);
        assert.equal(s.stream.writableEnded, true, 'the session ends its own side');
        assert.equal(s.session.isClosed(), true);
        s.stream.emit('close'); // the stream closes once both sides have ended
        assert.equal(s.closes.length, 1, 'the terminal close stays exactly-once');
    });

    it('end after the session sent its own Close: onClose(1006) at once, no wait for closeTimeout', function() {
        var s = setupSession();
        s.session.close(1000, 'done');
        assert.deepEqual(s.closes, [], 'an initiated close waits for the peer');
        s.stream.emit('end'); // the peer ends without echoing the Close frame
        assert.deepEqual(s.closes, [{ code: 1006, reason: '' }]);
        s.stream.emit('close');
        assert.equal(s.closes.length, 1);
    });

    it('end with a frame cut short: onClose(1006), exactly once', function() {
        var s = setupSession();
        s.stream.emit('data', clientText('hello').subarray(0, 3));
        s.stream.emit('end');
        assert.deepEqual(s.closes, [{ code: 1006, reason: '' }]);
        assert.equal(s.stream.writableEnded, true);
    });
});

describe('02 - controls', function() {

    it('a Close frame then end: the peer\'s code, exactly once', function() {
        var s = setupSession();
        s.stream.emit('data', clientClose(1000, 'bye'));
        assert.deepEqual(s.closes, [{ code: 1000, reason: 'bye' }]);
        s.stream.emit('end');
        s.stream.emit('close');
        assert.deepEqual(s.closes, [{ code: 1000, reason: 'bye' }]);
    });

    it('a close alone: onClose(1006) (the instrument fires)', function() {
        var s = setupSession();
        s.stream.emit('close');
        assert.deepEqual(s.closes, [{ code: 1006, reason: '' }]);
    });
});
