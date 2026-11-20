'use strict';
/**
 * #B1139 — lib/ws-session bounds the automatic Pongs waiting to be written.
 *
 * A session answers inbound Pings automatically (RFC 6455 § 5.5.2). It now
 * counts the Pongs handed to the stream until each write completes, and at
 * `maxPendingAutoPongs` (60 by default, 0 = no cap) one more Ping closes the
 * session with 1006 and resets the stream with RST_STREAM ENHANCE_YOUR_CALM.
 * No automatic Pong follows our own Close frame, and a close the peer leaves
 * unanswered past `closeTimeout` resets the stream (RST_STREAM CANCEL)
 * instead of half-closing it.
 *
 * Two layers, both on the real lib/ws-session + lib/ws-framing:
 *  - a stream double whose writes complete only when the test releases them,
 *    asynchronously, as Node completes a write;
 *  - a real HTTP/2 loopback (extended CONNECT, live Http2Stream): a peer that
 *    sends Pings and does not read the Pongs, a peer in lockstep, and the
 *    instrument arm proving that a peer which does not read holds the
 *    server's bytes back on this runtime.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var http2 = require('http2');
var EventEmitter = require('events').EventEmitter;

var FW = require('../fw');
var wsSess = require(path.join(FW, 'lib/ws-session/src/main'));
var wsf = require(path.join(FW, 'lib/ws-framing/src/main'));

var KEY = Buffer.from([4, 3, 2, 1]);
var ENHANCE_YOUR_CALM = http2.constants.NGHTTP2_ENHANCE_YOUR_CALM;
var CANCEL = http2.constants.NGHTTP2_CANCEL;
var REASON = 'too many pending automatic pongs';

/**
 * A stream double. `write(buf, cb)` keeps `cb` until `release()` (or
 * `fail()`) completes the held writes on a later turn, as Node does; `close`
 * records the RST code; `destroy` fails the writes still held.
 *
 * @returns {EventEmitter}
 */
function heldStream() {
    var s = new EventEmitter();
    s.destroyed = false;
    s.closed = false;
    s.writableEnded = false;
    s.written = [];
    s.held = [];
    s.rstCode = undefined;
    s.respond = function() {};
    s.write = function(buf, cb) {
        s.written.push(buf);
        if (typeof cb === 'function') { s.held.push(cb); }
        return true;
    };
    s.end = function() { s.writableEnded = true; };
    s.close = function(code) { s.closed = true; s.rstCode = code; };
    s.destroy = function() {
        if (s.destroyed) { return; }
        s.destroyed = true;
        var cbs = s.held.splice(0);
        process.nextTick(function() {
            cbs.forEach(function(cb) { cb(new Error('stream destroyed')); });
            s.emit('close');
        });
    };
    s.complete = function(err) {
        var cbs = s.held.splice(0);
        return new Promise(function(resolve) {
            setImmediate(function() {
                cbs.forEach(function(cb) { if (err) { cb(err); } else { cb(); } });
                resolve();
            });
        });
    };
    return s;
}

/** A masked client PING frame. */
function ping(n) {
    return wsf.encodePing(Buffer.from('p' + n), { mask: true, maskKey: KEY });
}

/**
 * Counts the PONG frames the session wrote. Each write is one frame, so each
 * buffer is decoded on its own (a Close frame cannot hide what follows it).
 *
 * @param {object} stream
 * @returns {number}
 */
function pongsWritten(stream) {
    var n = 0;
    stream.written.forEach(function(buf) {
        var parser = wsf.createParser({ isServer: false, onPong: function() { n++; } });
        parser.feed(buf);
    });
    return n;
}

/**
 * Accepts a session over a stream double and records its events.
 *
 * @param {object} [options] - session options
 * @returns {{stream: object, session: object, ev: object}}
 */
function setup(options) {
    var stream = heldStream();
    var request = { headers: { ':method': 'CONNECT', ':protocol': 'websocket', ':path': '/live' }, stream: stream };
    var session = wsSess.accept(request, options);
    var ev = { pings: [], closes: [], errors: [], messages: [] };
    session
        .onPing(function(p) { ev.pings.push(p); })
        .onMessage(function(d) { ev.messages.push(d); })
        .onClose(function(code, reason) { ev.closes.push({ code: code, reason: reason }); })
        .onError(function(e) { ev.errors.push(e); });
    return { stream: stream, session: session, ev: ev };
}

function feed(s, from, count) {
    for (var i = from; i < from + count; i++) { s.stream.emit('data', ping(i)); }
}

describe('#B1139 - automatic Pongs waiting to be written are bounded (stream double)', function() {

    it('the 61st Ping with 60 Pongs pending resets the stream (ENHANCE_YOUR_CALM) and closes the session once with 1006', function() {
        var s = setup();
        feed(s, 0, 61);
        assert.equal(pongsWritten(s.stream), 60);
        assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM);
        assert.equal(s.stream.destroyed, true);
        assert.deepEqual(s.ev.closes, [{ code: 1006, reason: REASON }]);
        assert.equal(s.ev.pings.length, 60, 'the Ping that met the cap is not reported');
        assert.equal(s.ev.errors.length, 0);
        assert.equal(s.session.isClosed(), true);
    });

    it('nothing reaches the consumer after the reset', async function() {
        var s = setup();
        feed(s, 0, 61);
        await new Promise(function(resolve) { setImmediate(resolve); }); // the reset's own 'close' has run
        feed(s, 100, 5);
        s.stream.emit('data', wsf.encodeText('late', { mask: true, maskKey: KEY }));
        assert.equal(s.ev.pings.length, 60);
        assert.equal(s.ev.messages.length, 0);
        assert.equal(s.ev.closes.length, 1);
        assert.equal(pongsWritten(s.stream), 60);
    });

    it('CONTROL: a peer whose Pongs are written as they come is never reset', async function() {
        var s = setup();
        for (var i = 0; i < 200; i++) {
            s.stream.emit('data', ping(i));
            await s.stream.complete();
        }
        assert.equal(pongsWritten(s.stream), 200);
        assert.equal(s.stream.rstCode, undefined);
        assert.equal(s.ev.closes.length, 0);
        assert.equal(s.ev.pings.length, 200);
    });

    it('the count follows the write callbacks: 60 pending, written, 60 more, then the next Ping resets', async function() {
        var s = setup();
        feed(s, 0, 60);
        assert.equal(s.stream.rstCode, undefined);
        await s.stream.complete();
        feed(s, 60, 60);
        assert.equal(s.stream.rstCode, undefined, 'written Pongs freed their slots');
        assert.equal(pongsWritten(s.stream), 120);
        feed(s, 120, 1);
        assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM);
        assert.deepEqual(s.ev.closes, [{ code: 1006, reason: REASON }]);
    });

    it('one read carrying 61 Pings resets the stream, as in ws: no write completes inside the read', function() {
        var s = setup();
        var frames = [];
        for (var i = 0; i < 61; i++) { frames.push(ping(i)); }
        s.stream.emit('data', Buffer.concat(frames));
        assert.equal(pongsWritten(s.stream), 60);
        assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM);
        assert.equal(s.ev.closes.length, 1);
    });

    it('maxPendingAutoPongs: 3 resets at the 4th pending Pong', function() {
        var s = setup({ maxPendingAutoPongs: 3 });
        feed(s, 0, 4);
        assert.equal(pongsWritten(s.stream), 3);
        assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM);
    });

    it('maxPendingAutoPongs: 0 disables the cap', function() {
        var s = setup({ maxPendingAutoPongs: 0 });
        feed(s, 0, 1000);
        assert.equal(pongsWritten(s.stream), 1000);
        assert.equal(s.stream.rstCode, undefined);
        assert.equal(s.ev.closes.length, 0);
    });

    it('a value that is not a non-negative integer falls back to 60', function() {
        ['5', -1, 2.5, NaN, null, Infinity, true, {}].forEach(function(value) {
            var s = setup({ maxPendingAutoPongs: value });
            feed(s, 0, 61);
            assert.equal(pongsWritten(s.stream), 60, 'value ' + String(value));
            assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM, 'value ' + String(value));
        });
    });

    it('autoPong: false sends no Pong and never resets', function() {
        var s = setup({ autoPong: false });
        feed(s, 0, 1000);
        assert.equal(pongsWritten(s.stream), 0);
        assert.equal(s.stream.rstCode, undefined);
        assert.equal(s.ev.pings.length, 1000);
    });

    it('a write that fails still frees its slot', async function() {
        var s = setup();
        feed(s, 0, 60);
        await s.stream.complete(new Error('write failed'));
        feed(s, 60, 60);
        assert.equal(s.stream.rstCode, undefined);
    });

    it('a write that throws holds no slot', function() {
        var s = setup({ maxPendingAutoPongs: 2 });
        var write = s.stream.write;
        s.stream.write = function() { throw new Error('boom'); };
        feed(s, 0, 5);
        s.stream.write = write;
        assert.equal(s.stream.rstCode, undefined, 'a thrown write is not pending');
        feed(s, 5, 2);
        assert.equal(s.stream.rstCode, undefined);
        feed(s, 7, 1);
        assert.equal(s.stream.rstCode, ENHANCE_YOUR_CALM);
    });

    it('no automatic Pong once the session has sent its Close; the Ping is still reported', function() {
        var s = setup();
        s.session.close(1000, 'bye');
        feed(s, 0, 1);
        assert.equal(pongsWritten(s.stream), 0);
        assert.equal(s.ev.pings.length, 1);
    });

    it('the close timeout resets the stream (CANCEL) instead of half-closing it', async function() {
        var s = setup({ closeTimeout: 25 });
        s.session.close(1001, 'going away');
        await new Promise(function(resolve) { setTimeout(resolve, 60); });
        assert.deepEqual(s.ev.closes, [{ code: 1001, reason: 'going away' }]);
        assert.equal(s.stream.rstCode, CANCEL);
        assert.equal(s.stream.destroyed, true);
        assert.equal(s.stream.writableEnded, false);
    });

});

/**
 * Starts an HTTP/2 server with extended CONNECT, as Isaac does (a compat
 * request listener coexists with the 'connect' handler).
 *
 * @param {object} [sessionOptions]
 * @param {function} onAccept - (session, stream)
 * @returns {Promise<{port: number, stop: function}>}
 */
function startServer(sessionOptions, onAccept) {
    var server = http2.createServer({ settings: { enableConnectProtocol: true } });
    var h2sessions = [];
    server.on('session', function(h2session) { h2sessions.push(h2session); });
    server.on('request', function(req, res) { if (req.method !== 'CONNECT') { res.end('ok'); } });
    server.on('connect', function(request) {
        onAccept(wsSess.accept(request, sessionOptions), request.stream);
    });
    return new Promise(function(resolve) {
        server.listen(0, '127.0.0.1', function() {
            resolve({
                port: server.address().port,
                stop: function() {
                    h2sessions.forEach(function(h2session) { try { h2session.destroy(); } catch (e) { /* gone */ } });
                    return new Promise(function(done) { server.close(function() { done(); }); });
                }
            });
        });
    });
}

/**
 * Opens a WebSocket over HTTP/2 extended CONNECT.
 *
 * @param {number} port
 * @param {object} [settings] - client SETTINGS
 * @returns {Promise<{client: object, req: object}>}
 */
function openSocket(port, settings) {
    var client = http2.connect('http://127.0.0.1:' + port, { settings: settings || {} });
    client.on('error', function() { /* teardown noise */ });
    return new Promise(function(resolve, reject) {
        var guard = setTimeout(function() { reject(new Error('no handshake within 3 s')); }, 3000);
        client.once('remoteSettings', function() {
            var req = client.request({
                ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'http',
                ':path': '/live', ':authority': '127.0.0.1:' + port
            });
            req.on('error', function() { /* the reset under test */ });
            req.on('response', function(headers) {
                clearTimeout(guard);
                if (headers[':status'] !== 200) { return reject(new Error('handshake status ' + headers[':status'])); }
                resolve({ client: client, req: req });
            });
        });
    });
}

function delay(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

describe('#B1139 - real HTTP/2 loopback (extended CONNECT, live Http2Stream)', function() {

    it('INSTRUMENT: a peer that does not read holds the server\'s bytes back on this runtime', async function() {
        var held = null;
        var srv = await startServer(undefined, function(session, stream) {
            stream.write(Buffer.alloc(200000, 0x62));
            held = stream;
        });
        try {
            var sock = await openSocket(srv.port, { initialWindowSize: 0 });
            sock.req.pause();
            await delay(300);
            assert.ok(held, 'the server accepted the stream');
            assert.ok(held.writableLength >= 150000, 'writableLength ' + held.writableLength);
            sock.client.destroy();
        } finally {
            await srv.stop();
        }
    });

    it('a peer that sends Pings and does not read the Pongs is reset with ENHANCE_YOUR_CALM', async function() {
        var seen = { closes: [], stream: null };
        var srv = await startServer(undefined, function(session, stream) {
            seen.stream = stream;
            session.onClose(function(code, reason) { seen.closes.push({ code: code, reason: reason }); });
        });
        try {
            var sock = await openSocket(srv.port, { initialWindowSize: 0 });
            sock.req.pause();
            var closed = new Promise(function(resolve) { sock.req.on('close', resolve); });
            var payload = Buffer.alloc(125, 0x61);
            for (var i = 0; i < 5000; i++) { sock.req.write(wsf.encodePing(payload, { mask: true })); }
            await Promise.race([closed, delay(5000)]);
            assert.equal(sock.req.rstCode, ENHANCE_YOUR_CALM, 'client rstCode ' + sock.req.rstCode);
            assert.deepEqual(seen.closes, [{ code: 1006, reason: REASON }]);
            assert.equal(seen.stream.destroyed, true);
            sock.client.destroy();
        } finally {
            await srv.stop();
        }
    });

    it('CONTROL: a peer in lockstep (each Ping after the previous Pong) gets 200 Pongs and is never reset', async function() {
        var seen = { closes: [] };
        var srv = await startServer(undefined, function(session) {
            session.onClose(function(code, reason) { seen.closes.push({ code: code, reason: reason }); });
        });
        try {
            var sock = await openSocket(srv.port);
            var pongs = 0;
            var waiting = null;
            var parser = wsf.createParser({
                isServer : false,
                onPong   : function() {
                    pongs++;
                    if (waiting) { var next = waiting; waiting = null; next(); }
                }
            });
            sock.req.on('data', function(chunk) { parser.feed(chunk); });
            for (var i = 0; i < 200; i++) {
                await Promise.race([
                    new Promise(function(resolve) {
                        waiting = resolve;
                        sock.req.write(wsf.encodePing('n' + i, { mask: true }));
                    }),
                    delay(3000).then(function() { throw new Error('no Pong within 3 s at Ping ' + i); })
                ]);
            }
            assert.equal(pongs, 200);
            assert.equal(seen.closes.length, 0);
            assert.ok(!sock.req.rstCode, 'no reset (rstCode ' + sock.req.rstCode + ')');
            sock.client.destroy();
        } finally {
            await srv.stop();
        }
    });

});
