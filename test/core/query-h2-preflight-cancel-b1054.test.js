'use strict';
/**
 * self.query() over HTTP/2 — a call sent on a session that was just destroyed is re-sent on a fresh one (#B1054)
 *
 * Real bytes: the real controller's `query()` against a bare `node:http2` upstream behind a TCP proxy that can stop
 * forwarding (the standalone bootstrap of query-h2-bun-stream-timer-b971.test.js).
 *
 * A cancelled pre-flight PING is inconclusive, so the call is sent anyway (#B627): on a session that is gone, the send
 * fails before anything leaves. `client.request()` throws that on Node 22 and 25 (the #B612 catch re-sends it), but on
 * Node 24, Node 26 and Bun 1.4 it returns a stream that errors `ERR_HTTP2_INVALID_SESSION`, which up to 0.7.7 went to
 * the caller as a 500 `STREAM_ERROR`. The shape: a connection that silently dropped, and a call whose pre-flight PING is
 * pending when the keepalive deadline destroys the session.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http2 = require('node:http2');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);


function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n'); }

// A bare h2c upstream that answers every stream at once.
function mkUpstream() {
    var server = http2.createServer();
    var S = { paths: [], sessions: [] };
    server.on('session', function (session) { S.sessions.push(session); session.on('error', function () {}); });
    server.on('stream', function (stream, headers) {
        S.paths.push(headers[':method'] + ' ' + headers[':path']);
        stream.on('error', function () {});
        try { stream.respond({ ':status': 200, 'content-type': 'application/json' }); stream.end('{"ok":true}'); } catch (e) {}
    });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); });
    });
}
function closeUpstream(h) {
    if (!h) { return; }
    h.S.sessions.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}

// A TCP proxy in front of `targetPort`. drop() stops forwarding on every connection it holds, with no FIN and no RST (a
// connection a network layer stopped forwarding); a connection accepted afterwards is forwarded.
function mkProxy(targetPort) {
    var P = { conns: [] };
    var server = net.createServer(function (down) {
        var c = { down: down, up: net.connect(targetPort, '127.0.0.1'), dropped: false };
        P.conns.push(c);
        down.on('error', function () {});
        c.up.on('error', function () {});
        down.on('data', function (d) { if (!c.dropped) { c.up.write(d); } });
        c.up.on('data', function (d) { if (!c.dropped) { down.write(d); } });
        down.on('close', function () { c.up.destroy(); });
        c.up.on('close', function () { down.destroy(); });
    });
    P.drop = function () { P.conns.forEach(function (c) { c.dropped = true; }); };
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { P.server = server; P.port = server.address().port; res(P); });
    });
}
function closeProxy(P) {
    if (!P) { return; }
    P.conns.forEach(function (c) { try { c.down.destroy(); } catch (e) {} try { c.up.destroy(); } catch (e) {} });
    try { P.server.close(); } catch (e) {}
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r1054', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb1054', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r1054: {} } }
            },
            rule: 'r1054', control: 'act', bundle: 'tb1054', controller: '/controllers/t1054.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t1054'), _cacheIsEnabled: 'false', _http2Sessions: [] };
    inst.throwError = function () {};
    return inst;
}
function cachedSession(inst, port) {
    var entry = inst.serverInstance._cached.get('http2session:http://127.0.0.1:' + port);
    return entry && entry.value ? entry.value : entry;
}
function destroyClientSessions(inst) {
    if (!inst) { return; }
    try { inst.serverInstance._cached.forEach(function (entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
}
// One self.query() call; resolves with { err, result, ms }, or { hung: true, ms } when no callback came by `watchdog` ms.
function q(inst, o) {
    var t0 = Date.now();
    var opts = { protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + o.port, host: '127.0.0.1', port: o.port,
                 path: o.path, method: o.method || 'GET', requestTimeout: o.requestTimeout || '1s' };
    return new Promise(function (res) {
        var over = false;
        var dog = setTimeout(function () { over = true; res({ hung: true, ms: Date.now() - t0 }); }, o.watchdog || 6000);
        inst.query(opts, o.data || {}, function (err, result) {
            if (over) { return; }
            over = true;
            clearTimeout(dog);
            res({ err: err, result: result, ms: Date.now() - t0 });
        });
    });
}
function show(r) { return JSON.stringify({ hung: r.hung, ms: r.ms, err: r.err ? { code: r.err.code, status: r.err.status, retryCount: r.err.retryCount, message: r.err.message } : null, result: r.result }); }
function assertAnswered(r, name) {
    assert.ok(!r.hung, name + ' never called back: ' + show(r));
    assert.ok(!r.err, name + ' answered: ' + show(r));
    assert.equal(r.result && r.result.ok, true, name + ': ' + show(r));
}
function count(list, item) { return list.filter(function (x) { return x === item; }).length; }

before(function () {
    setContext('bundle', 'tb1054');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb1054: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65527 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65527'
        } } } }
    });
});

describe('01 - source: a stream created on a destroyed session counts as never processed', function () {
    var live = strip(fs.readFileSync(SOURCE, 'utf8'));
    var np = live.indexOf("var _neverProcessed = (errorCode === 'ERR_HTTP2_GOAWAY_SESSION')");

    it('the code is in the expression, next to the two it joins (controls)', function () {
        assert.ok(np > -1, 'the expression is found');
        var block = live.slice(np, live.indexOf('if (retryCount < HTTP2_MAX_RETRIES && _neverProcessed) {', np));
        assert.ok(block.indexOf("|| (errorCode === 'ERR_HTTP2_INVALID_SESSION')") > -1);
        assert.ok(block.indexOf('req.rstCode === 7') > -1, 'control: REFUSED_STREAM still reads');
    });
});

describe('02 - the session destroyed while the pre-flight PING is pending: the call is re-sent on a fresh session, for any method', function () {
    [{ method: 'GET', path: '/fast/get' }, { method: 'POST', path: '/fast/post', data: { a: 1 } }].forEach(function (A) {
        it(A.method + ' reaches the upstream once, on a second session', async function () {
            var h = await mkUpstream(), P = await mkProxy(h.port), inst = makeInst();
            try {
                assertAnswered(await q(inst, { port: P.port, path: '/fast/warm', requestTimeout: '5s' }), 'the warm-up');
                var s0 = cachedSession(inst, P.port);
                assert.ok(s0, 'the session is cached');
                P.drop();
                s0._lastPongAt = 0; // stale, so the call PINGs first, and no PONG comes through the proxy
                var p = q(inst, { port: P.port, path: A.path, method: A.method, data: A.data, requestTimeout: '5s', watchdog: 10000 });
                await sleep(100);
                assert.ok(s0._ginaPreflight, 'control: the pre-flight PING is pending');
                s0._ginaTornDown = true; // what the keepalive deadline does
                s0.destroy();
                var r = await p;
                assertAnswered(r, 'the ' + A.method);
                assert.equal(count(h.S.paths, A.method + ' ' + A.path), 1, 'it reached the upstream once: ' + JSON.stringify(h.S.paths));
                assert.equal(h.S.sessions.length, 2, 'on a second session');
            } finally {
                destroyClientSessions(inst); closeProxy(P); closeUpstream(h);
            }
        });
    });
});

describe('03 - the real keepalive deadline: a connection dropped before the PING at 5 s, a call whose pre-flight overlaps the deadline at 8 s', function () {
    it('the call is served', async function () {
        var h = await mkUpstream(), P = await mkProxy(h.port), inst = makeInst();
        try {
            assertAnswered(await q(inst, { port: P.port, path: '/fast/warm', requestTimeout: '5s' }), 'the warm-up');
            await sleep(4500);
            P.drop();
            await sleep(3000);
            var r = await q(inst, { port: P.port, path: '/fast/next', requestTimeout: '5s', watchdog: 15000 });
            assertAnswered(r, 'the call');
            assert.equal(count(h.S.paths, 'GET /fast/next'), 1, JSON.stringify(h.S.paths));
        } finally {
            destroyClientSessions(inst); closeProxy(P); closeUpstream(h);
        }
    });
});
