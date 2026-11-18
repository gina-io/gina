/**
 * lib/ws-session — WebSocket-over-HTTP/2 session bridge suite (#H13).
 *
 * Require-by-path like the sibling lib suites. Two layers:
 *  - mock-stream unit tests (accept contract, send/ping/close, auto-pong,
 *    close handshake both directions, protocol-violation teardown, handler
 *    containment, backpressure, shutdown-drain registration);
 *  - a real HTTP/2 loopback (extended CONNECT against a live
 *    http2.createServer with enableConnectProtocol) proving the bridge works
 *    against a genuine Http2Stream end to end.
 *
 * Outbound frames are asserted by parsing the mock stream's written bytes
 * with a CLIENT-mode lib/ws-framing parser (server frames are unmasked).
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var http2 = require('http2');
var EventEmitter = require('events').EventEmitter;

var FW = require('../fw');
var wsSess = require(path.join(FW, 'lib/ws-session/src/main'));
var wsf = require(path.join(FW, 'lib/ws-framing/src/main'));

function mockStream() {
    var stream = new EventEmitter();
    stream.destroyed = false;
    stream.closed = false;
    stream.writableEnded = false;
    stream.written = [];
    stream.respondedWith = null;
    stream.writeReturn = true;
    stream.respond = function(headers) { stream.respondedWith = headers; };
    stream.write = function(buf) { stream.written.push(buf); return stream.writeReturn; };
    stream.end = function() { stream.writableEnded = true; };
    // #B1139: a reset is RST_STREAM (close(code)) then destroy()
    stream.rstCode = undefined;
    stream.close = function(code) { stream.closed = true; stream.rstCode = code; };
    stream.destroy = function() { stream.destroyed = true; };
    return stream;
}

function mockRequest(stream, reqPath) {
    return {
        headers : { ':method': 'CONNECT', ':protocol': 'websocket', ':path': reqPath || '/ws' },
        stream  : stream
    };
}

// Decodes everything the session wrote to the wire with a client-mode parser.
function decodeWritten(stream) {
    var out = { messages: [], pings: [], pongs: [], closes: [], errors: [] };
    var parser = wsf.createParser({
        isServer  : false,
        onMessage : function(d, b) { out.messages.push({ data: d, isBinary: b }); },
        onPing    : function(p) { out.pings.push(p); },
        onPong    : function(p) { out.pongs.push(p); },
        onClose   : function(c, r) { out.closes.push({ code: c, reason: r }); },
        onError   : function(e) { out.errors.push(e); }
    });
    if (stream.written.length > 0) {
        parser.feed(Buffer.concat(stream.written));
    }
    return out;
}

function setupSession(options, reqPath) {
    var stream = mockStream();
    var events = { messages: [], pings: [], pongs: [], closes: [], errors: [], drains: 0 };
    var session = wsSess.accept(mockRequest(stream, reqPath), options);
    session
        .onMessage(function(d, b) { events.messages.push({ data: d, isBinary: b }); })
        .onPing(function(p) { events.pings.push(p); })
        .onPong(function(p) { events.pongs.push(p); })
        .onClose(function(c, r) { events.closes.push({ code: c, reason: r }); })
        .onError(function(e) { events.errors.push(e); })
        .onDrain(function() { events.drains++; });
    return { stream: stream, session: session, events: events };
}

var KEY = Buffer.from([9, 8, 7, 6]);
function clientText(text) {
    return wsf.encodeFrame({ opcode: wsf.OPCODES.TEXT, payload: text, mask: true, maskKey: KEY });
}
function clientClose(code, reason) {
    var payload;
    if (typeof code === 'undefined') {
        payload = Buffer.alloc(0);
    } else {
        var reasonBuf = reason ? Buffer.from(reason, 'utf8') : Buffer.alloc(0);
        payload = Buffer.alloc(2 + reasonBuf.length);
        payload.writeUInt16BE(code, 0);
        reasonBuf.copy(payload, 2);
    }
    return wsf.encodeFrame({ opcode: wsf.OPCODES.CLOSE, payload: payload, mask: true, maskKey: KEY });
}


// 01 — accept() contract
describe('01 - accept(): the RFC 8441 §5 success response', function() {

    it('responds :status 200 on the raw stream and returns a session', function() {
        var stream = mockStream();
        var session = wsSess.accept(mockRequest(stream));
        assert.deepEqual(stream.respondedWith, { ':status': 200 });
        assert.equal(session instanceof wsSess.WsSession, true);
    });

    it('echoes a selected subprotocol in sec-websocket-protocol', function() {
        var stream = mockStream();
        wsSess.accept(mockRequest(stream), { protocol: 'chat' });
        assert.deepEqual(stream.respondedWith, { ':status': 200, 'sec-websocket-protocol': 'chat' });
    });

    it('throws on a request with no respondable stream (e.g. the HTTP/1.1 CONNECT signature)', function() {
        assert.throws(function() { wsSess.accept({ headers: {} }); }, TypeError);
    });

    it('throws when the stream is already closed', function() {
        var stream = mockStream();
        stream.destroyed = true;
        assert.throws(function() { wsSess.accept(mockRequest(stream)); }, /already closed/);
    });

});


// 02 — outbound: send / ping
describe('02 - send and ping write well-formed unmasked server frames', function() {

    it('send(string) goes out as a TEXT frame, send(Buffer) as BINARY', function() {
        var s = setupSession();
        assert.equal(s.session.send('hello'), true);
        assert.equal(s.session.send(Buffer.from([1, 2, 3])), true);
        var out = decodeWritten(s.stream);
        assert.equal(out.errors.length, 0);
        assert.deepEqual(out.messages[0], { data: 'hello', isBinary: false });
        assert.equal(out.messages[1].isBinary, true);
        assert.deepEqual(out.messages[1].data, Buffer.from([1, 2, 3]));
    });

    it('ping() writes a PING frame the peer can parse', function() {
        var s = setupSession();
        assert.equal(s.session.ping('beat'), true);
        var out = decodeWritten(s.stream);
        assert.equal(out.pings[0].toString(), 'beat');
    });

    it('send() reports backpressure when the stream write returns false', function() {
        var s = setupSession();
        s.stream.writeReturn = false;
        assert.equal(s.session.send('pressure'), false);
        s.stream.writeReturn = true;
        s.stream.emit('drain');
        assert.equal(s.events.drains, 1);
    });

});


// 03 — inbound: messages and auto-pong
describe('03 - inbound dispatch and auto-pong (§5.5.2)', function() {

    it('delivers inbound masked text to onMessage', function() {
        var s = setupSession();
        s.stream.emit('data', clientText('inbound'));
        assert.deepEqual(s.events.messages, [{ data: 'inbound', isBinary: false }]);
    });

    it('answers an inbound PING with a PONG echoing the payload, and still reports it', function() {
        var s = setupSession();
        s.stream.emit('data', wsf.encodePing('hb', { mask: true, maskKey: KEY }));
        assert.equal(s.events.pings[0].toString(), 'hb');
        var out = decodeWritten(s.stream);
        assert.equal(out.pongs.length, 1);
        assert.equal(out.pongs[0].toString(), 'hb');
    });

    it('subtract: autoPong false suppresses the automatic PONG', function() {
        var s = setupSession({ autoPong: false });
        s.stream.emit('data', wsf.encodePing('hb', { mask: true, maskKey: KEY }));
        assert.equal(s.events.pings.length, 1);
        assert.equal(decodeWritten(s.stream).pongs.length, 0);
    });

});


// 04 — close handshake, both directions
describe('04 - close handshake (§5.5.1 / §7)', function() {

    it('peer-initiated close: echoes the code, ends the stream, fires onClose once', function() {
        var s = setupSession();
        s.stream.emit('data', clientClose(1000, 'bye'));
        assert.deepEqual(s.events.closes, [{ code: 1000, reason: 'bye' }]);
        assert.equal(decodeWritten(s.stream).closes[0].code, 1000);
        assert.equal(s.stream.writableEnded, true);
        assert.equal(s.session.isClosed(), true);
        // terminal is exactly-once even if the transport close event follows
        s.stream.emit('close');
        assert.equal(s.events.closes.length, 1);
    });

    it('peer close with an EMPTY body reports 1005 locally but echoes an empty Close (1005 never goes on the wire)', function() {
        var s = setupSession();
        s.stream.emit('data', clientClose());
        assert.deepEqual(s.events.closes, [{ code: 1005, reason: '' }]);
        var echoed = decodeWritten(s.stream).closes[0];
        assert.equal(echoed.code, 1005, 'an empty echoed Close body decodes as 1005 client-side');
    });

    it('initiated close: peer echo completes the handshake', function() {
        var s = setupSession({ closeTimeout: 5000 });
        s.session.close(1000, 'done');
        assert.equal(decodeWritten(s.stream).closes[0].code, 1000);
        assert.equal(s.events.closes.length, 0, 'not terminal until the peer answers');
        s.stream.emit('data', clientClose(1000, 'done'));
        assert.equal(s.events.closes.length, 1);
        assert.equal(s.stream.writableEnded, true);
    });

    it('initiated close: a silent peer is force-ended after closeTimeout', async function() {
        var s = setupSession({ closeTimeout: 25 });
        s.session.close(1001, 'going away');
        await new Promise(function(resolve) { setTimeout(resolve, 60); });
        assert.deepEqual(s.events.closes, [{ code: 1001, reason: 'going away' }]);
        // #B1139: the stream is reset (RST_STREAM CANCEL), not half-closed
        assert.equal(s.stream.rstCode, http2.constants.NGHTTP2_CANCEL);
        assert.equal(s.stream.destroyed, true);
        assert.equal(s.stream.writableEnded, false);
    });

    it('send() and ping() refuse after a close was sent', function() {
        var s = setupSession();
        s.session.close(1000);
        assert.equal(s.session.send('late'), false);
        assert.equal(s.session.ping(), false);
    });

});


// 05 — protocol violations and transport teardown
describe('05 - violations answer with the prescribed code; transport loss is 1006', function() {

    it('an unmasked client frame fails 1002: error + close frame + terminal close', function() {
        var s = setupSession();
        s.stream.emit('data', wsf.encodeText('unmasked'));
        assert.equal(s.events.errors[0].closeCode, 1002);
        assert.equal(decodeWritten(s.stream).closes[0].code, 1002);
        assert.deepEqual(s.events.closes.map(function(c) { return c.code; }), [1002]);
        assert.equal(s.stream.writableEnded, true);
    });

    it('an oversized declared frame fails 1009', function() {
        var s = setupSession({ maxPayload: 100 });
        s.stream.emit('data', Buffer.from([0x82, 0xFE, 0x07, 0xD0])); // declares 2000 bytes
        assert.equal(s.events.errors[0].closeCode, 1009);
        assert.equal(decodeWritten(s.stream).closes[0].code, 1009);
    });

    it('a transport close without a Close frame is a 1006 abnormal closure', function() {
        var s = setupSession();
        s.stream.emit('close');
        assert.deepEqual(s.events.closes, [{ code: 1006, reason: '' }]);
    });

    it('a stream error is absorbed (never thrown) and terminates with 1006', function() {
        var s = setupSession();
        assert.doesNotThrow(function() {
            s.stream.emit('error', new Error('ECONNRESET-ish'));
        });
        assert.equal(s.events.closes[0].code, 1006);
    });

});


// 06 — consumer-handler containment
describe('06 - a throwing consumer handler never escalates', function() {

    it('a throwing onMessage is contained: diagnostic onError + 1011 close, no exception out of feed', function() {
        var stream = mockStream();
        var errors = [];
        var closes = [];
        var session = wsSess.accept(mockRequest(stream));
        session
            .onMessage(function() { throw new Error('handler bug'); })
            .onError(function(e) { errors.push(e); })
            .onClose(function(c, r) { closes.push(c); });
        assert.doesNotThrow(function() {
            stream.emit('data', clientText('boom'));
        });
        assert.equal(errors.length, 1);
        assert.equal(errors[0].message, 'handler bug');
        assert.equal(decodeWritten(stream).closes[0].code, 1011);
        // the 1011 close is INITIATED — terminal onClose arrives with the
        // peer's echo (same handshake semantics as §04)
        assert.deepEqual(closes, []);
        stream.emit('data', clientClose(1011));
        assert.deepEqual(closes, [1011]);
    });

});


// 07 — graceful-shutdown drain registration
describe('07 - SIGTERM drain registry (process.gina._sseConnections)', function() {

    it('registers a closer on creation, drains with 1001, deregisters on finish', function() {
        var hadGina = Object.prototype.hasOwnProperty.call(process, 'gina');
        var savedGina = process.gina;
        process.gina = {};
        try {
            var s = setupSession();
            assert.equal(process.gina._sseConnections.size, 1);

            // simulate the proc.js SIGTERM drain: invoke every registered closer
            Array.from(process.gina._sseConnections).forEach(function(closer) { closer(); });
            assert.equal(decodeWritten(s.stream).closes[0].code, 1001);

            // the peer's echo finishes the session and deregisters it
            s.stream.emit('data', clientClose(1001));
            assert.equal(s.events.closes.length, 1);
            assert.equal(process.gina._sseConnections.size, 0);
        } finally {
            if (hadGina) { process.gina = savedGina; } else { delete process.gina; }
        }
    });

    it('skips registration cleanly outside a framework process (no process.gina)', function() {
        assert.equal(typeof process.gina, 'undefined', 'precondition: test process has no gina bootstrap');
        var s = setupSession();
        assert.equal(typeof process.gina, 'undefined', 'the bridge must not invent process.gina');
        s.session.close(1000);
    });

});


// 08 — real HTTP/2 loopback: extended CONNECT end to end
describe('08 - real HTTP/2 loopback (extended CONNECT, live Http2Stream)', function() {

    it('accept + echo + client-initiated close over a genuine extended-CONNECT stream', async function() {
        var server = http2.createServer({ settings: { enableConnectProtocol: true } });
        var serverEvents = { messages: [], closes: [] };
        var liveSessions = [];
        server.on('session', function(h2session) { liveSessions.push(h2session); });

        // mirror the Isaac reality: a compat request listener coexists
        server.on('request', function(req, res) {
            if (req.method !== 'CONNECT') { res.end('ok'); }
        });
        server.on('connect', function(request, response) {
            var session = wsSess.accept(request);
            session.onMessage(function(data, isBinary) {
                serverEvents.messages.push(data);
                session.send('echo: ' + data);
            });
            session.onClose(function(code, reason) {
                serverEvents.closes.push({ code: code, reason: reason });
            });
        });

        await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
        var port = server.address().port;

        var clientOut = { messages: [], closes: [] };
        var clientParser = wsf.createParser({
            isServer  : false,
            onMessage : function(d) { clientOut.messages.push(d); },
            onClose   : function(c, r) { clientOut.closes.push({ code: c, reason: r }); },
            onError   : function(e) { clientOut.err = e; }
        });

        try {
            await new Promise(function(resolve, reject) {
                var client = http2.connect('http://127.0.0.1:' + port);
                var guard = setTimeout(function() { reject(new Error('loopback timed out')); }, 3000);
                client.on('error', reject);
                client.on('remoteSettings', function() {
                    var req = client.request({
                        ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'http',
                        ':path': '/live', ':authority': '127.0.0.1:' + port
                    });
                    req.on('error', function(e) { reject(e); });
                    req.on('response', function(headers) {
                        try { assert.equal(headers[':status'], 200); } catch (e) { return reject(e); }
                        req.on('data', function(chunk) { clientParser.feed(chunk); });
                        req.write(wsf.encodeFrame({ opcode: wsf.OPCODES.TEXT, payload: 'hi', mask: true }));
                        setTimeout(function() {
                            req.write(clientClose(1000, 'bye'));
                            req.end(); // END_STREAM after the Close frame so the stream fully closes
                        }, 120);
                    });
                    req.on('close', function() {
                        clearTimeout(guard);
                        try { client.close(); } catch (e) {}
                        resolve();
                    });
                });
            });
        } finally {
            // destroy any surviving HTTP/2 session so server.close() cannot hang
            liveSessions.forEach(function(h2session) {
                try { h2session.destroy(); } catch (e) { /* already gone */ }
            });
            await new Promise(function(resolve) { server.close(resolve); });
        }

        assert.deepEqual(serverEvents.messages, ['hi']);
        assert.deepEqual(serverEvents.closes, [{ code: 1000, reason: 'bye' }]);
        assert.deepEqual(clientOut.messages, ['echo: hi']);
        // §5.5.1 — the bridge echoes the STATUS CODE; the reason is not echoed
        assert.deepEqual(clientOut.closes, [{ code: 1000, reason: '' }]);
    });

});


// 09 — real HTTP/2 loopback: :param capture onto a live Http2ServerRequest (#H13 slice 2)
describe('09 - real HTTP/2 loopback (:param capture, live Http2Stream)', function() {

    // Inline mirror of the isaac dispatcher's exact-first → param-scan matcher
    // (server.isaac.js _wsMatchParam + _extendedConnectHandler). The §12d source
    // pins + §12e replica in server.isaac.test.js lock the real matcher; the point
    // HERE is that `request.params` set by that path is readable by the handler
    // over a genuine extended-CONNECT Http2ServerRequest, alongside accept + echo.
    function matchParam(pathname, patterns) {
        var reqSegs = String(pathname || '').split('/');
        for (var i = 0; i < patterns.length; i++) {
            var segs = patterns[i].pattern.split('/');
            if (segs.length !== reqSegs.length) { continue; }
            var params = {}, ok = true;
            for (var s = 0; s < segs.length; s++) {
                if (segs[s].charAt(0) === ':') {
                    if (reqSegs[s] === '') { ok = false; break; }
                    params[segs[s].substring(1)] = decodeURIComponent(reqSegs[s]);
                } else if (segs[s] !== reqSegs[s]) { ok = false; break; }
            }
            if (ok) { return { handler: patterns[i].handler, params: params }; }
        }
        return null;
    }

    it('extended CONNECT to /live/foo → handler reads request.params.room over a real stream', async function() {
        var server = http2.createServer({ settings: { enableConnectProtocol: true } });
        var seen = { params: null, messages: [] };
        var liveSessions = [];
        var paramRoutes = [{ pattern: '/live/:room', handler: function(session, request) {
            seen.params = request.params;
            session.send('room=' + request.params.room);
            session.onMessage(function(d) { seen.messages.push(d); session.send('echo:' + d); });
        } }];

        server.on('session', function(h2s) { liveSessions.push(h2s); });
        server.on('request', function(req, res) { if (req.method !== 'CONNECT') { res.end('ok'); } });
        server.on('connect', function(request, response) {
            var pathname = String(request.headers[':path'] || '').split('?')[0];
            var m = matchParam(pathname, paramRoutes);
            if (!m) { response.writeHead(404); response.end(); return; }
            request.params = m.params;            // the dispatcher's one-liner under test
            var session = wsSess.accept(request);
            m.handler(session, request);
        });

        await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
        var port = server.address().port;

        var clientOut = { messages: [] };
        var clientParser = wsf.createParser({
            isServer  : false,
            onMessage : function(d) { clientOut.messages.push(d); },
            onClose   : function() {},
            onError   : function(e) { clientOut.err = e; }
        });

        try {
            await new Promise(function(resolve, reject) {
                var client = http2.connect('http://127.0.0.1:' + port);
                var guard = setTimeout(function() { reject(new Error('loopback timed out')); }, 3000);
                client.on('error', reject);
                client.on('remoteSettings', function() {
                    var req = client.request({
                        ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'http',
                        ':path': '/live/foo', ':authority': '127.0.0.1:' + port
                    });
                    req.on('error', reject);
                    req.on('response', function(headers) {
                        try { assert.equal(headers[':status'], 200); } catch (e) { return reject(e); }
                        req.on('data', function(chunk) { clientParser.feed(chunk); });
                        req.write(clientText('hi'));
                        setTimeout(function() { req.write(clientClose(1000, 'bye')); req.end(); }, 120);
                    });
                    req.on('close', function() { clearTimeout(guard); try { client.close(); } catch (e) {} resolve(); });
                });
            });
        } finally {
            liveSessions.forEach(function(h2s) { try { h2s.destroy(); } catch (e) {} });
            await new Promise(function(resolve) { server.close(resolve); });
        }

        assert.deepEqual(seen.params, { room: 'foo' }, 'handler saw request.params.room === "foo"');
        assert.deepEqual(seen.messages, ['hi']);
        assert.ok(clientOut.messages.indexOf('room=foo') > -1, 'client received the captured param echoed back');
        assert.ok(clientOut.messages.indexOf('echo:hi') > -1, 'client received the message echo');
    });
});


// 10 — real HTTP/2 loopback: per-route wsOptions.protocol echoed over a live
// stream (#H13 slice 3a). The dispatcher resolves a route's param.wsOptions and
// threads it to accept(request, options); here accept is driven directly with
// { protocol: 'chat' } to prove the selected subprotocol actually lands on the
// wire (sec-websocket-protocol response header) against a genuine Http2Stream.
describe('10 - real HTTP/2 loopback (wsOptions.protocol echoed, live Http2Stream)', function() {

    it('accept(request, { protocol: "chat" }) echoes sec-websocket-protocol over a genuine extended-CONNECT stream', async function() {
        var server = http2.createServer({ settings: { enableConnectProtocol: true } });
        var liveSessions = [];
        server.on('session', function(h2s) { liveSessions.push(h2s); });
        server.on('request', function(req, res) { if (req.method !== 'CONNECT') { res.end('ok'); } });
        server.on('connect', function(request, response) {
            var session = wsSess.accept(request, { protocol: 'chat' });
            session.onMessage(function(d) { session.send('echo:' + d); });
        });

        await new Promise(function(resolve) { server.listen(0, '127.0.0.1', resolve); });
        var port = server.address().port;

        var clientOut = { messages: [] };
        var clientParser = wsf.createParser({
            isServer  : false,
            onMessage : function(d) { clientOut.messages.push(d); },
            onClose   : function() {},
            onError   : function(e) { clientOut.err = e; }
        });

        var responseHeaders = null;
        try {
            await new Promise(function(resolve, reject) {
                var client = http2.connect('http://127.0.0.1:' + port);
                var guard = setTimeout(function() { reject(new Error('loopback timed out')); }, 3000);
                client.on('error', reject);
                client.on('remoteSettings', function() {
                    var req = client.request({
                        ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'http',
                        ':path': '/live', ':authority': '127.0.0.1:' + port
                    });
                    req.on('error', reject);
                    req.on('response', function(headers) {
                        responseHeaders = headers;
                        try {
                            assert.equal(headers[':status'], 200);
                            assert.equal(headers['sec-websocket-protocol'], 'chat');
                        } catch (e) { return reject(e); }
                        req.on('data', function(chunk) { clientParser.feed(chunk); });
                        req.write(clientText('hi'));
                        setTimeout(function() { req.write(clientClose(1000, 'bye')); req.end(); }, 120);
                    });
                    req.on('close', function() { clearTimeout(guard); try { client.close(); } catch (e) {} resolve(); });
                });
            });
        } finally {
            liveSessions.forEach(function(h2s) { try { h2s.destroy(); } catch (e) {} });
            await new Promise(function(resolve) { server.close(resolve); });
        }

        assert.ok(responseHeaders, 'a response frame arrived');
        assert.equal(responseHeaders['sec-websocket-protocol'], 'chat', 'the selected subprotocol travelled on the wire');
        assert.deepEqual(clientOut.messages, ['echo:hi'], 'echo still works alongside the protocol option');
    });

});


// 11 — real HTTP/2 loopback: a channel handler calls session.query against a
// SECOND http2 target and streams the result back over a genuine extended-CONNECT
// stream (#H13 slice 3b). The isaac dispatcher attaches session.query via
// lib.wsQuery.build (controller reuse + serverInstance = app + promisify) — that
// real wiring is locked by ws-query.test.js (source pins + guard/callback) + the
// server.isaac.test.js §12h dispatcher-attach pins + the live-boot cross-bundle
// smoke. Like §09's inline matchParam mirror, the point HERE is the END-TO-END
// shape over a real Http2Stream: a handler `await session.query(...)`s a second
// http2 target and streams the cross-target result back over the WS channel.
describe('11 - real HTTP/2 loopback (session.query cross-target round-trip, live Http2Stream)', function() {

    it('a channel handler awaits session.query against a second http2 target and streams the result', async function() {
        // --- target server (the "other bundle" the cross-bundle query reaches) ---
        var targetServer   = http2.createServer();
        var targetSessions = [];
        targetServer.on('session', function(s) { targetSessions.push(s); });
        targetServer.on('request', function(req, res) {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ ok: true, via: 'target', path: req.headers[':path'] }));
        });
        await new Promise(function(resolve) { targetServer.listen(0, '127.0.0.1', resolve); });
        var targetPort = targetServer.address().port;

        // A real http2 GET round-trip to the target — the faithful stand-in for what
        // lib.wsQuery.build's returned query does via the framework controller.
        function queryTarget(reqPath) {
            return new Promise(function(resolve, reject) {
                var c = http2.connect('http://127.0.0.1:' + targetPort);
                c.on('error', reject);
                var rq = c.request({ ':method': 'GET', ':path': reqPath });
                var body = '';
                rq.setEncoding('utf8');
                rq.on('data', function(chunk) { body += chunk; });
                rq.on('end', function() {
                    var parsed;
                    try { parsed = JSON.parse(body); } catch (e) { reject(e); return; }
                    try { c.close(); } catch (e) {}
                    resolve(parsed);
                });
                rq.on('error', reject);
            });
        }

        // --- ws server (the channel handler lives here) ---
        var wsServer     = http2.createServer({ settings: { enableConnectProtocol: true } });
        var liveSessions = [];
        wsServer.on('session', function(s) { liveSessions.push(s); });
        wsServer.on('request', function(req, res) { if (req.method !== 'CONNECT') { res.end('ok'); } });
        wsServer.on('connect', function(request, response) {
            var session = wsSess.accept(request);
            session.query = function(opt) { return queryTarget(opt.path); };
            session.onMessage(function(d) {
                session.query({ path: '/data' })
                    .then(function(r) { session.send('q:' + JSON.stringify(r)); })
                    .catch(function(e) { session.send('err:' + e.message); });
            });
        });
        await new Promise(function(resolve) { wsServer.listen(0, '127.0.0.1', resolve); });
        var wsPort = wsServer.address().port;

        var clientOut = { messages: [] };
        var clientParser = wsf.createParser({
            isServer  : false,
            onMessage : function(d) { clientOut.messages.push(d); },
            onClose   : function() {},
            onError   : function(e) { clientOut.err = e; }
        });

        try {
            await new Promise(function(resolve, reject) {
                var client  = http2.connect('http://127.0.0.1:' + wsPort);
                var guard   = setTimeout(function() { reject(new Error('loopback timed out')); }, 5000);
                var closing = false;
                client.on('error', reject);
                client.on('remoteSettings', function() {
                    var req = client.request({
                        ':method': 'CONNECT', ':protocol': 'websocket', ':scheme': 'http',
                        ':path': '/live', ':authority': '127.0.0.1:' + wsPort
                    });
                    req.on('error', reject);
                    req.on('response', function(headers) {
                        try { assert.equal(headers[':status'], 200); } catch (e) { return reject(e); }
                        req.on('data', function(chunk) {
                            clientParser.feed(chunk);
                            // close deterministically once the query result has streamed back
                            if (!closing && clientOut.messages.some(function(m) { return /^q:/.test(m); })) {
                                closing = true;
                                req.write(clientClose(1000, 'bye'));
                                req.end();
                            }
                        });
                        req.write(clientText('go'));
                    });
                    req.on('close', function() { clearTimeout(guard); try { client.close(); } catch (e) {} resolve(); });
                });
            });
        } finally {
            liveSessions.forEach(function(s)   { try { s.destroy(); } catch (e) {} });
            targetSessions.forEach(function(s) { try { s.destroy(); } catch (e) {} });
            await new Promise(function(resolve) { wsServer.close(resolve); });
            await new Promise(function(resolve) { targetServer.close(resolve); });
        }

        var qMsg = clientOut.messages.find(function(m) { return /^q:/.test(m); });
        assert.ok(qMsg, 'the client received the cross-target query result streamed back over the WS stream');
        var payload = JSON.parse(qMsg.slice(2));
        assert.equal(payload.ok, true, 'the query reached the second http2 target and returned its JSON');
        assert.equal(payload.via, 'target');
        assert.equal(payload.path, '/data', 'the query path was honoured by the target');
    });

});
