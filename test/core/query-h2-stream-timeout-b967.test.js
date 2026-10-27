'use strict';
/**
 * self.query() over HTTP/2 — a stream timeout fails the call and re-sends nothing (#B967, with #B628 and #B970)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http2` upstreams, directly or
 * through a TCP proxy that accepts a connection and drops every byte (the standalone bootstrap of
 * query-h2-session-resilience.test.js).
 *
 * Up to 0.7.5 a stream that reached `requestTimeout` evicted and destroyed its HTTP/2 session, then re-sent
 * a safe method (or a `retryUnsafe` call) up to twice. Measured on the code before this change, whose timeout
 * handler is 0.7.5's byte for byte: a GET to a live but slow
 * upstream ran the upstream handler 3 times and failed TIMEOUT after 3 × requestTimeout + 0.5 s (#B967);
 * the destroy failed every other stream of the session with an uncoded 500 (#B628); and an attempt still
 * pending on a session that never connected raised an uncaught ERR_HTTP2_STREAM_CANCEL (#B970).
 * Since 0.7.6 the call fails TIMEOUT at requestTimeout and only its stream is cancelled (RST_STREAM CANCEL).
 * A connected session is kept and marked stale, so the next call's pre-flight PING proves it or evicts it;
 * a session that never finished connecting is evicted and destroyed, so the next call opens a fresh one.
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
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
var C = http2.constants;
// #B971 — under Bun (measured on 1.4.2 and 1.3.14) a client stream's timer does not fire while another
// stream of its session is active; the sibling arm (§03) depends on it, so it is registered on Node only.
var IS_BUN = !!(process.versions && process.versions.bun);

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

var SLOW_MS = 2500;   // a live upstream answering after the caller's requestTimeout
var MED_MS  = 1500;   // the sibling's answer, after the slow call's timeout
var TIMEOUT = '1s';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }

// A bare HTTP/2 upstream (h2c, or TLS when `tls` is given): /slow* answers after SLOW_MS, /med* after
// MED_MS, anything else at once — each only while its stream is still open.
function mkUpstream(tls) {
    var server = tls ? http2.createSecureServer({ key: tls.key, cert: tls.cert }) : http2.createServer();
    var S = { paths: [], sessions: [], closeCodes: {}, timers: [] };
    server.on('session', function (session) { S.sessions.push(session); session.on('error', function () {}); });
    server.on('stream', function (stream, headers) {
        var p = headers[':path'];
        S.paths.push(p);
        stream.on('error', function () {});
        stream.on('close', function () { S.closeCodes[stream.rstCode] = (S.closeCodes[stream.rstCode] || 0) + 1; });
        var answer = function () {
            if (stream.closed || stream.destroyed) { return; }
            try { stream.respond({ ':status': 200, 'content-type': 'application/json' }); stream.end('{"ok":true}'); } catch (e) {}
        };
        var delay = /^\/slow/.test(p) ? SLOW_MS : (/^\/med/.test(p) ? MED_MS : 0);
        if (!delay) { return answer(); }
        S.timers.push(setTimeout(answer, delay));
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

// A TCP proxy in front of `targetPort`. While `swallow` is true a new connection is accepted and every byte
// it carries is dropped (no FIN, no RST: a connection a network layer stopped forwarding); a connection
// accepted after `swallow` turns false is forwarded.
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
function closeProxy(P) {
    if (!P) { return; }
    P.conns.forEach(function (c) { try { c.down.destroy(); } catch (e) {} try { if (c.up) { c.up.destroy(); } } catch (e) {} });
    try { P.server.close(); } catch (e) {}
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r967', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb967', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r967: {} } }
            },
            rule: 'r967', control: 'act', bundle: 'tb967', controller: '/controllers/t967.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t967'), _cacheIsEnabled: 'false', _http2Sessions: [] };
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
                 path: o.path, method: o.method || 'GET', requestTimeout: o.requestTimeout || TIMEOUT };
    if (o.retryUnsafe) { opts.retryUnsafe = true; }
    if (o.ca) { opts.ca = o.ca; }
    return new Promise(function (res) {
        inst.query(opts, o.data || {}, function (err, result) { res({ err: err, result: result, ms: Date.now() - t0 }); });
    });
}
function errText(e) { return e ? JSON.stringify({ code: e.code, status: e.status, retryCount: e.retryCount, message: e.message }) : 'none'; }
function count(list, item) { return list.filter(function (x) { return x === item; }).length; }

// Every client session the controller opens, in order (it calls the module's connect at request time).
var _connect = http2.connect;
var opened = [];

before(function () {
    http2.connect = function () { var s = _connect.apply(http2, arguments); opened.push(s); return s; };
    setContext('bundle', 'tb967');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb967: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65529 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65529'
        } } } }
    });
});
after(function () {
    http2.connect = _connect;
    opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
});

describe('01 - source: the timeout handler re-sends nothing and destroys only a session that never connected', function () {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var DECL = 'req.setTimeout(_streamTimeout, function onStreamTimeout() {';
    var start = src.indexOf(DECL);
    var end = src.indexOf("req.on('data', function onQueryDataChunk(chunk) {", start);
    var body = strip(src.slice(start, end));

    it('the handler is found once, and the needles fire on the code they leave alone (controls)', function () {
        assert.ok(start > -1 && end > start, 'the onStreamTimeout handler and the data listener after it are found');
        assert.equal(src.indexOf(DECL, start + 1), -1, 'one onStreamTimeout handler');
        assert.ok(strip(src).indexOf('handleHTTP2ClientRequest(browser, options, callback, _cNext') > -1, 'control: the premature-close branch still re-enters');
        assert.ok(strip(src).indexOf("isRetryableMethod(options[':method'], options.retryUnsafe)") > -1, 'control: the method gate still guards the other branches');
    });

    it('the handler neither re-enters the request nor consults the method gate; its destroy is gated on the session never having connected', function () {
        assert.equal(body.indexOf('handleHTTP2ClientRequest('), -1, 'no re-send from the timeout');
        assert.equal(body.indexOf('isRetryableMethod('), -1, 'no method gate: nothing is re-sent, whatever the method');
        var gate = body.indexOf('if (client._ginaConnected === false || (client._ginaConnected === undefined && client.connecting)) {');
        var destroy = body.indexOf('client.destroy()');
        var other = body.indexOf('} else {', gate);
        assert.ok(gate > -1 && destroy > gate && other > destroy, 'client.destroy() only inside the never-connected branch');
        assert.equal(body.indexOf('client.destroy()', destroy + 1), -1, 'and nowhere else in the handler');
        assert.ok(body.slice(gate, other).indexOf('if (_isCached(sessKey, client)) { cache.delete(sessKey); }') > -1, 'the never-connected branch evicts only its own cache entry (#B625)');
        assert.ok(body.indexOf('client._lastPongAt = Date.now() - HTTP2_PREFLIGHT_STALE_MS - 1;', other) > other, 'a connected session is marked stale');
        assert.ok(/_finalizeStream\(\);\s*_cancelStream\(\);/.test(body), 'the stream is released, then cancelled');
        assert.ok(strip(src).indexOf("client = browser.connect(authority, options);\n            client._ginaConnected = false;\n            client.once('connect', function onSessionConnected() { client._ginaConnected = true; });") > -1,
            'the session is flagged at creation and marked connected on its connect event (#B967: Bun misreports client.connecting)');
        assert.ok(body.indexOf('req.close(browser.constants.NGHTTP2_CANCEL)') > -1, 'with RST_STREAM CANCEL');
    });
});

describe('02 - a live but slow upstream: one run, TIMEOUT at requestTimeout, the session kept (#B967)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a slow GET fails TIMEOUT once: one upstream stream, cancelled; the session stays cached, live and stale', async function () {
        var w = await q(inst, { port: h.port, path: '/fast/0' });
        assert.ok(!w.err, 'warm-up answered: ' + errText(w.err));
        var s0 = cachedSession(inst, 'http', h.port);
        assert.ok(s0 && !s0.destroyed, 'a live session is cached');
        var r = await q(inst, { port: h.port, path: '/slow/1' });
        assert.ok(r.err, 'the slow GET failed');
        assert.equal(r.err.code, 'TIMEOUT', errText(r.err));
        assert.equal(r.err.status, 503);
        assert.equal(r.err.retryCount, 0, 'no re-send (0.7.5: 2): ' + errText(r.err));
        assert.ok(r.ms >= 900 && r.ms < 3000, 'failed at requestTimeout, after ' + r.ms + ' ms (0.7.5: 3 × 1 s + 0.5 s)');
        assert.doesNotMatch(r.err.message, /exhausted/);
        await sleep(150);
        assert.equal(count(h.S.paths, '/slow/1'), 1, 'the upstream received the slow GET once: ' + JSON.stringify(h.S.paths));
        assert.equal(h.S.closeCodes[C.NGHTTP2_CANCEL], 1, 'its stream was cancelled (RST_STREAM CANCEL): ' + JSON.stringify(h.S.closeCodes));
        assert.equal(cachedSession(inst, 'http', h.port), s0, 'the same session stays cached');
        assert.equal(s0.destroyed, false, 'not destroyed');
        assert.ok(Date.now() - s0._lastPongAt > 3000, 'marked stale, so the next call PINGs it first');
        assert.equal(h.S.sessions.length, 1, 'one connection carried the calls');
    });

    it('the next call is served on that same session, after its pre-flight PING', async function () {
        var s0 = cachedSession(inst, 'http', h.port);
        assert.ok(s0, 'the session is still cached');
        var pings = 0;
        var ping = s0.ping;
        s0.ping = function () { pings++; return ping.apply(s0, arguments); };
        var r = await q(inst, { port: h.port, path: '/fast/1' });
        s0.ping = ping;
        assert.ok(!r.err, 'answered: ' + errText(r.err));
        assert.equal(r.result && r.result.ok, true);
        assert.equal(pings, 1, 'the stale mark made the call PING the session first');
        assert.equal(cachedSession(inst, 'http', h.port), s0, 'on the same session');
        assert.equal(h.S.sessions.length, 1, 'no new connection');
    });
});

if (!IS_BUN) describe('03 - a sibling stream survives another stream\'s timeout (#B628)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a POST sent 300 ms after a slow GET, on the same session, answers 200 while the GET fails TIMEOUT', async function () {
        var w = await q(inst, { port: h.port, path: '/fast/0' });
        assert.ok(!w.err, 'warm-up answered: ' + errText(w.err));
        var g = q(inst, { port: h.port, path: '/slow/2' });
        await sleep(300);
        var p = q(inst, { port: h.port, path: '/med/2', method: 'POST', data: { a: 1 }, requestTimeout: '5s' });
        var rg = await g;
        var rp = await p;
        assert.equal(rg.err && rg.err.code, 'TIMEOUT', 'the slow GET timed out: ' + errText(rg.err));
        assert.ok(!rp.err, 'the sibling POST answered (0.7.5: 500 « Request aborted by client or server »): ' + errText(rp.err));
        assert.equal(rp.result && rp.result.ok, true);
        assert.equal(count(h.S.paths, '/med/2'), 1);
        assert.equal(h.S.sessions.length, 1, 'both rode one connection, which survived');
    });
});

describe('04 - a call opted in with retryUnsafe is not re-sent on a timeout either (#B967)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a slow POST with retryUnsafe: true fails TIMEOUT once and reaches the upstream once', async function () {
        var r = await q(inst, { port: h.port, path: '/slow/3', method: 'POST', data: { a: 3 }, retryUnsafe: true });
        assert.equal(r.err && r.err.code, 'TIMEOUT', errText(r.err));
        assert.equal(r.err.retryCount, 0, 'not re-sent (0.7.5: 2)');
        assert.ok(r.ms < 3000, 'after ' + r.ms + ' ms');
        await sleep(150);
        assert.equal(count(h.S.paths, '/slow/3'), 1, 'the upstream received it once (0.7.5: 3): ' + JSON.stringify(h.S.paths));
    });
});

describe('05 - a connection that stopped forwarding: TIMEOUT, then the next call evicts it after one pre-flight PING', function () {
    var h = null, P = null, inst = null, s0 = null;
    before(async function () { h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('the GET fails TIMEOUT at requestTimeout; the connected session stays cached, live and stale', async function () {
        var r = await q(inst, { port: P.port, path: '/fast/5' });
        assert.equal(r.err && r.err.code, 'TIMEOUT', errText(r.err));
        assert.equal(r.err.retryCount, 0, 'no re-send (0.7.5: 2)');
        assert.ok(r.ms < 3000, 'after ' + r.ms + ' ms (0.7.5: 3 × 1 s + 0.5 s)');
        s0 = cachedSession(inst, 'http', P.port);
        assert.ok(s0, 'the session stays cached');
        assert.equal(s0.connecting, false, 'it had connected (the proxy accepted the TCP connection)');
        assert.equal(s0.destroyed, false);
        assert.ok(Date.now() - s0._lastPongAt > 3000, 'marked stale');
        assert.equal(h.S.paths.length, 0, 'nothing reached the upstream');
    });

    it('once the proxy forwards again, the next call is served: its pre-flight PING gets no PONG, the session is evicted, a fresh one answers', async function () {
        P.swallow = false;
        var r = await q(inst, { port: P.port, path: '/fast/6' });
        assert.ok(!r.err, 'answered: ' + errText(r.err));
        assert.equal(r.result && r.result.ok, true);
        assert.ok(r.ms >= 1400, 'after the 1.5 s pre-flight deadline: ' + r.ms + ' ms');
        assert.equal(s0.destroyed, true, 'the dead session was destroyed by the pre-flight');
        var s1 = cachedSession(inst, 'http', P.port);
        assert.ok(s1 && s1 !== s0 && !s1.destroyed, 'a fresh session is cached');
        assert.deepEqual(h.S.paths, ['/fast/6'], 'the upstream received the call once');
    });
});

describe('06 - a session that never finished connecting is evicted and destroyed; the next call opens a fresh one', function () {
    var h = null, P = null, inst = null, tls = null, dir = null, base = 0;
    before(async function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-t967-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
                                 '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        tls = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
        h = await mkUpstream(tls);
        P = await mkProxy(h.port);
        inst = makeInst();
    });
    after(function () {
        destroyClientSessions(inst); closeProxy(P); closeUpstream(h);
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    });

    it('the GET fails TIMEOUT at requestTimeout; its session, still connecting, is evicted from the cache and destroyed', async function () {
        base = opened.length;
        var r = await q(inst, { scheme: 'https', port: P.port, path: '/fast/7', ca: tls.cert.toString() });
        assert.equal(r.err && r.err.code, 'TIMEOUT', errText(r.err));
        assert.equal(r.err.retryCount, 0, 'no re-send (0.7.5: 2)');
        assert.ok(r.ms < 3000, 'after ' + r.ms + ' ms (0.7.5: 3 × 1 s + 0.5 s)');
        assert.equal(opened.length - base, 1, 'one session was opened (0.7.5: one per attempt)');
        var s0 = opened[base];
        assert.equal(s0.destroyed, true, 'the never-connected session was destroyed');
        assert.equal(cachedSession(inst, 'https', P.port), undefined, 'and is no longer cached');
        assert.equal(inst.serverInstance._http2Sessions.length, 0, 'nor tracked');
        assert.equal(h.S.paths.length, 0, 'nothing reached the upstream');
    });

    it('once the proxy forwards again, the next call opens a fresh session and is served at once', async function () {
        P.swallow = false;
        var r = await q(inst, { scheme: 'https', port: P.port, path: '/fast/8', ca: tls.cert.toString() });
        assert.ok(!r.err, 'answered: ' + errText(r.err));
        assert.equal(r.result && r.result.ok, true);
        assert.ok(r.ms < 1400, 'no pre-flight wait on a fresh session: ' + r.ms + ' ms');
        assert.equal(opened.length - base, 2, 'a second session was opened');
        assert.equal(cachedSession(inst, 'https', P.port), opened[base + 1], 'and cached');
        assert.deepEqual(h.S.paths, ['/fast/8']);
    });
});
