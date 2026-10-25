'use strict';
/**
 * self.query() over HTTP/2 — a stream that ends without its response, a session that fails on its own, and the
 * session a retry leaves behind (#B981, #B968, the 502 half of #B628, #B982)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http2` upstreams, directly or through a
 * TCP proxy (the bootstrap of query-h2-stream-timeout-b967.test.js). GINA_B981_CONTROLLER points the whole file —
 * its source pins and its arms — at another copy of controller.js placed in the same directory (so its relative
 * requires resolve), which is how it was checked red-first against the code before this change.
 *
 * Measured before this change (0.7.5's handler on every path below), on Node 22–26 and Bun 1.2 / 1.3 / 1.4:
 * - a call still pending on a session that never connected, cancelled when gina destroyed that session (the stream
 *   timeout's destroy, the keepalive deadline's), failed STREAM_ERROR 500 on Node and Bun 1.4, an uncoded 500 on
 *   Bun 1.2 / 1.3, although nothing had been sent (#B981);
 * - a stream that ended without its response (its session destroyed under it, a reset with NO_ERROR) reached the
 *   caller as an uncoded 500, a STREAM_ERROR 500 (Bun 1.4) or a false `{ status: 200, empty: true }` success, and
 *   on Bun 1.2 / 1.3 so did every empty body (#B968);
 * - a 502's retry (every runtime) and, on Node, a stream reset's retry destroyed the shared session, and the other
 *   streams in flight on it failed with a 500, uncoded or, on Bun 1.4, STREAM_ERROR (the 502 half of #B628, #B982);
 * - on Bun 1.2 / 1.3 a refused connection was an uncoded 500, and a failed TLS handshake an uncoded 500 or, on
 *   1.2.21, a false empty 200.
 * Since 0.7.6 a retry evicts the session (its cleanup closes it gracefully, so its other streams finish); a stream
 * that ends without its response follows the premature-close rule; a call never sent is re-sent for any method; and
 * a session that failed to connect on its own answers with its own typed error, never re-sent.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http2 = require('node:http2');
var { execFileSync } = require('child_process');

var FW = require('../fw');
// GINA_B981_CONTROLLER: another copy of controller.js, in the same directory (see the header)
var SOURCE = process.env.GINA_B981_CONTROLLER || path.join(FW, 'core', 'controller', 'controller.js');
var IS_BUN = !!(process.versions && process.versions.bun);

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

var MED_MS  = 1200;   // a sibling's answer, still in flight when the session is evicted or destroyed
var SLOW_MS = 3000;   // a sibling that outlives the first 502 retry (2 s)

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// Whole-line comments and JSDoc lines out, so a pin reads the code and never the comments that describe it.
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\/\*\*|\*(\s|\/|$))/.test(l); }).join('\n'); }

// A bare HTTP/2 upstream (h2c, or TLS when `tls` is given). /fast* answers at once, /med* after MED_MS and /slow*
// after SLOW_MS (each only while its stream is still open), /b502 answers 502, /rst2 resets the stream with
// INTERNAL_ERROR, /rst0 resets it with NO_ERROR before any response, /empty answers 200 with an empty body, and
// /lb and /lbr answer 200, or, on a `bad` upstream, 502 and an INTERNAL_ERROR reset. Each server-side session's
// close is recorded, so an arm can tell a connection that was closed from one left open.
function mkUpstream(tls, bad) {
    var server = tls ? http2.createSecureServer({ key: tls.key, cert: tls.cert }) : http2.createServer();
    var S = { paths: [], sessions: [], closed: [], timers: [] };
    server.on('session', function (session) {
        var i = S.sessions.push(session) - 1;
        S.closed[i] = false;
        session.on('error', function () {});
        session.on('close', function () { S.closed[i] = true; });
    });
    server.on('stream', function (stream, headers) {
        var p = String(headers[':path']);
        S.paths.push(p);
        stream.on('error', function () {});
        stream.on('data', function () {});
        var send = function (status, type, body) {
            if (stream.closed || stream.destroyed) { return; }
            try {
                var h = { ':status': status };
                if (type) { h['content-type'] = type; }
                stream.respond(h);
                stream.end(body);
            } catch (e) {}
        };
        var reset = function (code) { try { stream.close(code); } catch (e) {} };
        var ok = function () { send(200, 'application/json', '{"ok":true}'); };
        if (/^\/med/.test(p)) { S.timers.push(setTimeout(ok, MED_MS)); }
        else if (/^\/slow/.test(p)) { S.timers.push(setTimeout(ok, SLOW_MS)); }
        else if (p === '/b502') { send(502, 'text/plain', 'Bad Gateway'); }
        else if (p === '/rst2') { reset(http2.constants.NGHTTP2_INTERNAL_ERROR); }
        else if (p === '/rst0') { reset(http2.constants.NGHTTP2_NO_ERROR); }
        else if (p === '/empty') { send(200, null, undefined); }
        else if (p === '/lb') { if (bad) { send(502, 'text/plain', 'Bad Gateway'); } else { ok(); } }
        else if (p === '/lbr') { if (bad) { reset(http2.constants.NGHTTP2_INTERNAL_ERROR); } else { ok(); } }
        else { ok(); }
    });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); });
    });
}
function closeUpstream(h) {
    if (!h) { return; }
    h.S.timers.forEach(clearTimeout);
    h.S.sessions.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}

// A TCP proxy in front of `targetPort`. While `swallow` is true a new connection is accepted and every byte it
// carries is dropped (a TLS session behind it never finishes connecting); a connection accepted after `swallow`
// turns false is forwarded.
function mkProxy(targetPort) {
    var P = { swallow: true, conns: [] };
    var server = net.createServer(function (down) {
        var c = { down: down, up: null };
        P.conns.push(c);
        down.on('error', function () {});
        if (P.swallow) { down.on('data', function () {}); return; }
        c.up = net.connect(targetPort, '127.0.0.1');
        c.up.on('error', function () {});
        down.pipe(c.up);
        c.up.pipe(down);
        down.on('close', function () { c.up.destroy(); });
        c.up.on('close', function () { down.destroy(); });
    });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { P.server = server; P.port = server.address().port; res(P); });
    });
}
// A per-connection round-robin TCP proxy, as an L4 balancer: connection 1 goes to A, 2 to B, 3 to A, ...
function mkRoundRobin(portA, portB) {
    var P = { conns: [], toA: 0, toB: 0 };
    var server = net.createServer(function (down) {
        var c = { down: down, up: null };
        P.conns.push(c);
        down.on('error', function () {});
        var toA = (P.conns.length % 2) === 1;
        if (toA) { P.toA++; } else { P.toB++; }
        c.up = net.connect(toA ? portA : portB, '127.0.0.1');
        c.up.on('error', function () {});
        down.pipe(c.up);
        c.up.pipe(down);
        down.on('close', function () { c.up.destroy(); });
        c.up.on('close', function () { down.destroy(); });
    });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { P.server = server; P.port = server.address().port; res(P); });
    });
}
function closeProxy(P) {
    if (!P) { return; }
    P.conns.forEach(function (c) { try { c.down.destroy(); } catch (e) {} try { if (c.up) { c.up.destroy(); } } catch (e) {} });
    try { P.server.close(); } catch (e) {}
}
function freePort() {
    return new Promise(function (res) {
        var s = net.createServer();
        s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { res(p); }); });
    });
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r981', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb981', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r981: {} } }
            },
            rule: 'r981', control: 'act', bundle: 'tb981', controller: '/controllers/t981.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t981'), _cacheIsEnabled: 'false', _http2Sessions: [] };
    inst.throwError = function () {};
    return inst;
}
// The cached client session for an authority — the cache stores {value, cleanup} wrappers.
function cachedSession(inst, scheme, port) {
    var entry = inst.serverInstance._cached.get('http2session:' + scheme + '://127.0.0.1:' + port);
    return entry && entry.value ? entry.value : entry;
}
function destroyClientSessions(inst) {
    if (!inst) { return; }
    try { inst.serverInstance._cached.forEach(function (entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
}
// One self.query() call; resolves with { err, result, ms }.
function q(inst, o) {
    var t0 = Date.now();
    var scheme = o.scheme || 'http';
    var opts = { protocol: 'http/2.0', scheme: scheme, hostname: scheme + '://127.0.0.1:' + o.port, host: '127.0.0.1', port: o.port,
                 path: o.path, method: o.method || 'GET', requestTimeout: o.requestTimeout || '5s' };
    if (o.retryUnsafe) { opts.retryUnsafe = true; }
    if (o.ca) { opts.ca = o.ca; }
    return new Promise(function (res) {
        inst.query(opts, o.data || {}, function (err, result) { res({ err: err, result: result, ms: Date.now() - t0 }); });
    });
}
function errText(e) { return e ? JSON.stringify({ code: e.code, status: e.status, retryCount: e.retryCount, message: String(e.message || (e.error && e.error.message) || '').slice(0, 90) }) : 'none'; }
function count(list, item) { return list.filter(function (x) { return x === item; }).length; }
function typed(e) { return !!(e && e.name === 'GinaHttp2Error'); }

// Every client session the controller opens, in order (it calls the module's connect at request time).
var _connect = http2.connect;
var opened = [];
var certDir = null, TLS = null;

before(function () {
    http2.connect = function () { var s = _connect.apply(http2, arguments); opened.push(s); return s; };
    setContext('bundle', 'tb981');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb981: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65529 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65529'
        } } } }
    });
    certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-t981-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'k.pem'), '-out', path.join(certDir, 'c.pem'),
                             '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
    TLS = { key: fs.readFileSync(path.join(certDir, 'k.pem')), cert: fs.readFileSync(path.join(certDir, 'c.pem')) };
});
after(function () {
    http2.connect = _connect;
    opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { fs.rmSync(certDir, { recursive: true, force: true }); } catch (e) {}
});

describe('01 - source: one handler for a stream that ended without its response; retries evict and never destroy', function () {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var code = strip(src);
    var np = code.indexOf("var _neverProcessed = (errorCode === 'ERR_HTTP2_GOAWAY_SESSION')");
    var wl = code.indexOf("(errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ERR_HTTP2_SESSION_ERROR' || errorCode === 'ECONNRESET') && isRetryableMethod(");
    var hs = code.indexOf('var _onStreamIncomplete = function _onStreamIncomplete() {');
    var he = code.indexOf("req.on('close', function onQueryClosed() {", hs);
    var es = code.indexOf("req.on('end', function onEnd() {");
    var ee = code.indexOf('if (httpStatus === 502 && retryCount < HTTP2_MAX_RETRIES', es);

    it('controls: the anchors around the change are found', function () {
        assert.ok(code.indexOf('var handleHTTP2ClientRequest = function(') > -1, 'control: the handler');
        assert.ok(np > -1 && wl > np, 'control: the never-processed branch precedes the stream-error whitelist');
        assert.ok(es > -1 && ee > es, 'control: onEnd and its 502 branch');
        assert.ok(src.indexOf("client.once('connect', function onSessionConnected() { client._ginaConnected = true; });") > -1, 'control: the #B967 connect flag');
    });

    it('a pending stream cancelled with no cause (our own destroy) is never-processed, so retried for any method (#B981)', function () {
        var block = code.slice(np, wl);
        assert.ok(block.indexOf("|| (errorCode === 'ERR_HTTP2_STREAM_CANCEL' && req.pending === true && !error.cause);") > -1,
            'the third never-processed case, a cause-less cancel on a stream still pending');
    });

    it('an open stream cancelled with no cause goes to the shared handler, ahead of the whitelist (#B968)', function () {
        var block = code.slice(np, wl);
        assert.ok(/if \(errorCode === 'ERR_HTTP2_STREAM_CANCEL' && !error\.cause\) \{\s*isFinished = true;\s*return _onStreamIncomplete\(\);/.test(block),
            'Bun 1.4 reports an open stream of a destroyed session this way');
    });

    it('the session records an error that ends it before it connected (#B981)', function () {
        var e = code.indexOf("client.on('error', (error) => {");
        var f = code.indexOf('if (client._ginaConnected === false) { client._ginaConnectError = error; }', e);
        assert.ok(e > -1 && f > e && f - e < 200, 'first thing in the session error listener');
    });

    it('the shared handler: the connect error first, then never-sent for any method, then the method gate, then PREMATURE_CLOSE', function () {
        assert.ok(hs > -1 && he > hs, 'declared once, before the close listener');
        var body = code.slice(hs, he);
        var a = body.indexOf('var _connectErr = client._ginaConnectError || null;');
        var b = body.indexOf('if (retryCount < HTTP2_MAX_RETRIES && (req.pending === true || client._ginaConnected === false)) {');
        var c = body.indexOf("if (retryCount < HTTP2_MAX_RETRIES && isRetryableMethod(options[':method'], options.retryUnsafe)) {");
        var d = body.indexOf("code       : 'PREMATURE_CLOSE',");
        assert.ok(a > -1 && b > a && c > b && d > c, 'in that order: ' + [a, b, c, d].join(', '));
        assert.ok(body.indexOf('cache.delete(sessKey);') > c, 'its retry evicts the session');
        assert.equal(body.indexOf('client.destroy('), -1, 'and never destroys it (#B628: a destroy failed every other stream on it)');
        assert.ok(/_finalizeStream\(\);\s*if \(_swallowIfNonCritical\(_incompleteErr\)\) return;/.test(body), 'its terminals release the stream, then deliver');
    });

    it('close before end, end without its response, and an empty body on a destroyed session all reach it', function () {
        assert.ok(/req\.on\('close', function onQueryClosed\(\) \{\s*if \(isFinished\) return;\s*isFinished = true;\s*_onStreamIncomplete\(\);/.test(code), 'the close listener');
        var onEnd = code.slice(es, ee);
        assert.ok(/if \(httpStatus === null \|\| \(\(!data \|\| data\.trim\(\) === ""\) && client\.destroyed\)\) \{\s*return _onStreamIncomplete\(\);/.test(onEnd), 'the onEnd guard');
        assert.equal(onEnd.indexOf('req.aborted || req.destroyed'), -1, "the stream's own destroyed flag is no longer read (Bun 1.2 / 1.3 set it at every normal end)");
        assert.equal(onEnd.indexOf('Request aborted by client or server'), -1, 'and no uncoded 500 is built there');
    });

    it('the 502 retry evicts the session and does not destroy it (#B628)', function () {
        var t = code.indexOf('setTimeout(function onHttp2RetryAfter502() {');
        var u = code.indexOf('}, 2000);', t);
        assert.ok(t > -1 && u > t, 'the 502 timer');
        var timer = code.slice(t, u);
        assert.ok(timer.indexOf('cache.delete(sessKey);') > -1, 'evicts');
        assert.equal(timer.indexOf('client.destroy('), -1, 'never destroys');
    });

    it('a stream error keeps its session; a session error or a connection reset still tears it down (#B982)', function () {
        assert.ok(code.indexOf("if (errorCode !== 'ERR_HTTP2_STREAM_ERROR' && !client.destroyed) client.destroy();", wl) > wl);
    });
});

describe('02 - calls never sent: a session that never connected, destroyed by gina, re-sends them for any method (#B981)', function () {
    var h = null, P = null, inst = null;
    before(async function () { h = await mkUpstream(TLS); P = await mkProxy(h.port); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('a GET and a POST still pending on it are sent again on a fresh session and served', async function () {
        var ca = TLS.cert.toString(), base = opened.length;
        var g = q(inst, { scheme: 'https', port: P.port, path: '/fast/g2', ca: ca });
        var p = q(inst, { scheme: 'https', port: P.port, path: '/fast/p2', method: 'POST', data: { a: 2 }, ca: ca });
        await sleep(300);
        assert.equal(opened.length - base, 1, 'one session, opened for both');
        var s0 = opened[base];
        assert.equal(s0._ginaConnected, false, 'it never connected (the proxy drops every byte)');
        P.swallow = false;
        s0.destroy();   // what the stream timeout or the keepalive deadline does to such a session: no error is given
        var rg = await g, rp = await p;
        assert.ok(!rg.err, 'the GET was sent again and served: ' + errText(rg.err));
        assert.ok(!rp.err, 'the POST too, since nothing had been sent (0.7.5: STREAM_ERROR 500, an uncoded 500 on Bun 1.2 / 1.3): ' + errText(rp.err));
        assert.equal(rg.result && rg.result.ok, true);
        assert.equal(rp.result && rp.result.ok, true);
        assert.equal(count(h.S.paths, '/fast/g2'), 1, 'the upstream received each call once: ' + JSON.stringify(h.S.paths));
        assert.equal(count(h.S.paths, '/fast/p2'), 1);
        assert.equal(opened.length - base, 2, 'on one fresh session');
    });
});

describe('03 - a connected session destroyed under open streams: a GET is sent again, a POST fails PREMATURE_CLOSE unless retryUnsafe (#B968)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('each call gets a typed answer by the method rule, none an uncoded 500', async function () {
        var w = await q(inst, { port: h.port, path: '/fast/w3' });
        assert.ok(!w.err, 'warm-up answered: ' + errText(w.err));
        var s0 = cachedSession(inst, 'http', h.port);
        assert.ok(s0 && s0._ginaConnected === true, 'a connected session is cached');
        var g = q(inst, { port: h.port, path: '/med/g3' });
        var p = q(inst, { port: h.port, path: '/med/p3', method: 'POST', data: { a: 3 } });
        var u = q(inst, { port: h.port, path: '/med/u3', method: 'POST', data: { a: 4 }, retryUnsafe: true });
        await sleep(200);
        s0.destroy();
        var rg = await g, rp = await p, ru = await u;
        assert.ok(!rg.err, 'the GET was sent again and served (0.7.5: an uncoded 500, STREAM_ERROR 500 on Bun 1.4): ' + errText(rg.err));
        assert.ok(typed(rp.err), 'the POST failed with a typed error: ' + errText(rp.err));
        assert.equal(rp.err.code, 'PREMATURE_CLOSE', errText(rp.err));
        assert.equal(rp.err.status, 503);
        assert.equal(rp.err.retryCount, 0, 'not sent again');
        assert.ok(!ru.err, 'the retryUnsafe POST was sent again and served: ' + errText(ru.err));
        await sleep(100);
        assert.equal(count(h.S.paths, '/med/g3'), 2, 'the GET reached the upstream twice: ' + JSON.stringify(h.S.paths));
        assert.equal(count(h.S.paths, '/med/p3'), 1, 'the POST once');
        assert.equal(count(h.S.paths, '/med/u3'), 2, 'the retryUnsafe POST twice');
    });
});

describe('04 - a 502 and a sibling on its session: the sibling still answers, and the session the retry left is closed (#B628)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('the GET fails BAD_GATEWAY after its retries; the POST sent 300 ms later answers 200', async function () {
        var base = opened.length;
        var g = q(inst, { port: h.port, path: '/b502' });
        await sleep(300);
        var p = q(inst, { port: h.port, path: '/slow/p4', method: 'POST', data: { a: 4 } });
        var rg = await g, rp = await p;
        assert.ok(!rp.err, 'the sibling POST answered (0.7.5: a 500, uncoded or STREAM_ERROR on Bun 1.4, when the retry destroyed the session): ' + errText(rp.err));
        assert.equal(rp.result && rp.result.ok, true);
        assert.equal(rg.err && rg.err.code, 'BAD_GATEWAY', errText(rg.err));
        assert.equal(rg.err.status, 502);
        assert.equal(rg.err.retryCount, 2);
        assert.equal(opened.length - base, 3, 'each retry on a fresh session');
        await sleep(300);
        assert.equal(h.S.closed[0], true, 'the first connection was closed once its POST had answered (no orphan): ' + JSON.stringify(h.S.closed));
    });
});

describe('05 - a stream reset and a sibling on its session: the sibling still answers (#B982)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('the reset GET fails after its retries; the POST sent 100 ms earlier answers 200', async function () {
        var p = q(inst, { port: h.port, path: '/med/p5', method: 'POST', data: { a: 5 } });
        await sleep(100);
        var g = q(inst, { port: h.port, path: '/rst2' });
        var rg = await g, rp = await p;
        assert.ok(!rp.err, 'the sibling POST answered (0.7.5 on Node: an uncoded 500): ' + errText(rp.err));
        assert.equal(rp.result && rp.result.ok, true);
        assert.ok(typed(rg.err), errText(rg.err));
        // Node reports the reset as a stream error; Bun (1.2.21, 1.3.14, 1.4.2) ends the stream without a response
        assert.equal(rg.err.code, IS_BUN ? 'PREMATURE_CLOSE' : 'STREAM_ERROR', errText(rg.err));
        assert.equal(rg.err.retryCount, 2);
        assert.equal(count(h.S.paths, '/rst2'), 3, 'sent three times: ' + JSON.stringify(h.S.paths));
        await sleep(300);
        assert.equal(h.S.closed[0], true, 'the first connection was closed once its POST had answered (no orphan): ' + JSON.stringify(h.S.closed));
    });
});

describe('06 - a stream reset with NO_ERROR before any response fails PREMATURE_CLOSE, not a false empty success (#B968)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a GET is sent three times, then fails PREMATURE_CLOSE 503', async function () {
        var r = await q(inst, { port: h.port, path: '/rst0' });
        assert.ok(typed(r.err), 'an error, not { status: 200, empty: true } (0.7.5 on Node and Bun 1.4): ' + errText(r.err) + ' ' + JSON.stringify(r.result));
        assert.equal(r.err.code, 'PREMATURE_CLOSE', errText(r.err));
        assert.equal(r.err.status, 503);
        assert.equal(r.err.retryCount, 2);
        assert.equal(count(h.S.paths, '/rst0'), 3);
    });
});

describe('07 - an empty body is a response: { status: 200, empty: true } on every runtime (#B968)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a GET answered 200 with no body', async function () {
        var r = await q(inst, { port: h.port, path: '/empty' });
        assert.ok(!r.err, '0.7.5 on Bun 1.2 / 1.3: an uncoded 500: ' + errText(r.err));
        assert.deepEqual(r.result, { status: 200, empty: true });
        assert.equal(count(h.S.paths, '/empty'), 1);
    });
});

describe('08 - a dead port: ECONNREFUSED 503 at once, never sent again (#B981)', function () {
    var inst = null, port = 0;
    before(async function () { port = await freePort(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); });

    it('a GET and a POST sent at once', async function () {
        var base = opened.length;
        var rs = await Promise.all([q(inst, { port: port, path: '/fast/g8' }), q(inst, { port: port, path: '/fast/p8', method: 'POST', data: { a: 8 } })]);
        rs.forEach(function (r) {
            assert.ok(typed(r.err), '0.7.5 on Bun 1.2 / 1.3: an uncoded 500: ' + errText(r.err));
            assert.equal(r.err.code, 'ECONNREFUSED', errText(r.err));
            assert.equal(r.err.status, 503);
            assert.equal(r.err.retryCount, 0, 'never sent again');
        });
        assert.equal(opened.length - base, 1, 'one session, not one per attempt');
    });
});

describe('09 - TLS to a plaintext port: STREAM_ERROR 500, never sent again (#B981)', function () {
    var inst = null, plain = null, port = 0;
    before(async function () {
        plain = net.createServer(function (c) { c.on('error', function () {}); c.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); });
        port = await new Promise(function (res) { plain.listen(0, '127.0.0.1', function () { res(plain.address().port); }); });
        inst = makeInst();
    });
    after(function () { destroyClientSessions(inst); try { plain.close(); } catch (e) {} });

    it('a GET and a POST sent at once', async function () {
        var rs = await Promise.all([q(inst, { scheme: 'https', port: port, path: '/fast/g9' }), q(inst, { scheme: 'https', port: port, path: '/fast/p9', method: 'POST', data: { a: 9 } })]);
        rs.forEach(function (r) {
            assert.ok(typed(r.err), '0.7.5 on Bun 1.2.21: a false empty 200, on 1.3.14 an uncoded 500: ' + errText(r.err) + ' ' + JSON.stringify(r.result));
            assert.equal(r.err.code, 'STREAM_ERROR', errText(r.err));
            assert.equal(r.err.status, 500);
            assert.equal(r.err.retryCount, 0, 'never sent again');
        });
    });
});

describe('10 - behind a per-connection balancer, a retry moves the caller off a backend that answered 502 or reset the stream', function () {
    function arm(label, p) {
        describe(label, function () {
            var A = null, B = null, P = null, inst = null;
            before(async function () { A = await mkUpstream(null, true); B = await mkUpstream(null, false); P = await mkRoundRobin(A.port, B.port); inst = makeInst(); });
            after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(A); closeUpstream(B); });

            it('one GET: the first connection lands on the bad backend, the retry\'s on the good one, and it answers 200', async function () {
                var r = await q(inst, { port: P.port, path: p });
                assert.ok(!r.err, 'served: ' + errText(r.err));
                assert.equal(r.result && r.result.ok, true);
                assert.equal(count(A.S.paths, p), 1, 'the bad backend once');
                assert.equal(count(B.S.paths, p), 1, 'the good backend once');
                assert.equal(P.toA, 1);
                assert.equal(P.toB, 1);
            });
        });
    }
    arm('a backend answering 502', '/lb');
    arm('a backend resetting the stream', '/lbr');
});
