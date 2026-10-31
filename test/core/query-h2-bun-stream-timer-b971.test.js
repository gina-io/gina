'use strict';
/**
 * self.query() over HTTP/2 — a stream's timeout is its own, and a finished call gives its slot back, on Bun (#B971, #B1052)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http2` upstreams in this process, directly
 * or through a TCP proxy (the standalone bootstrap of query-h2-stream-timeout-b967.test.js).
 *
 * On every Bun read (1.2.21, 1.3.14, 1.4.0 to 1.4.2) `ClientHttp2Stream.setTimeout()` is the session's: each call
 * replaced the session's one timer and left a `timeout` listener behind, and when it fired every call's callback ran.
 * On 1.4.x a call that ended cleared it for all the others (a hung call never called back) and inbound frames refreshed
 * it (above the 5 s keepalive PING a timeout never fired). And on 1.4.x the client counts a request against the peer's
 * SETTINGS_MAX_CONCURRENT_STREAMS until a `close` listener of its own runs, which `_finalizeStream()`'s
 * `req.removeAllListeners()` stripped: a session stopped sending at the limit (#B1052).
 *
 * On Node these arms pass on the code before the change too: they are the reference the Bun arms must match.
 * § 02 drives the stand-in timer alone on a manual clock, so its rules are read with no timing at all, the upload rule
 * included: a same-process Bun server applies no backpressure, so no driven arm here can reach it.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http2 = require('node:http2');
var EventEmitter = require('events').EventEmitter;

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
var IS_BUN = !!(process.versions && process.versions.bun);

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

var LATE_MS   = 2500;  // /late* answers after this
var GAP_MS    = 1000;  // /chunk* writes its one chunk after this, then stays silent
var TRICKLE_N = 8;     // /trickle* writes this many chunks,
var TRICKLE_MS = 500;  // this far apart, then ends

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n'); }

// A bare h2c upstream: /hang* never answers, /late* answers after LATE_MS, /chunk* answers its headers and one chunk after
// GAP_MS and then nothing, /trickle* a complete JSON body in TRICKLE_N chunks, anything else answers at once.
function mkUpstream(settings) {
    var server = http2.createServer(settings ? { settings: settings } : {});
    var S = { paths: [], sessions: [], timers: [] };
    server.on('session', function (session) { S.sessions.push(session); session.on('error', function () {}); });
    server.on('stream', function (stream, headers) {
        var p = headers[':path'];
        S.paths.push(p);
        stream.on('error', function () {});
        var live = function () { return !stream.closed && !stream.destroyed; };
        var respond = function () { stream.respond({ ':status': 200, 'content-type': 'application/json' }); };
        try {
            if (/^\/hang/.test(p)) { return; }
            if (/^\/late/.test(p)) {
                S.timers.push(setTimeout(function () { if (live()) { respond(); stream.end('{"ok":true}'); } }, LATE_MS));
                return;
            }
            if (/^\/chunk/.test(p)) {
                respond();
                S.timers.push(setTimeout(function () { if (live()) { stream.write('{"ok":'); } }, GAP_MS));
                return;
            }
            if (/^\/trickle/.test(p)) {
                respond();
                stream.write('{"ok":true,"pad":"');
                var left = TRICKLE_N;
                var tick = setInterval(function () {
                    if (!live()) { clearInterval(tick); return; }
                    if (--left > 0) { stream.write('x'); return; }
                    clearInterval(tick);
                    stream.end('"}');
                }, TRICKLE_MS);
                S.timers.push(tick);
                return;
            }
            respond();
            stream.end('{"ok":true}');
        } catch (e) {}
    });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); });
    });
}
function closeUpstream(h) {
    if (!h) { return; }
    h.S.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); });
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
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r971', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb971', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r971: {} } }
            },
            rule: 'r971', control: 'act', bundle: 'tb971', controller: '/controllers/t971.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t971'), _cacheIsEnabled: 'false', _http2Sessions: [] };
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
function assertTimedOut(r, name) {
    assert.ok(!r.hung, name + ' never called back: ' + show(r));
    assert.equal(r.err && r.err.code, 'TIMEOUT', name + ': ' + show(r));
}
function assertAnswered(r, name) {
    assert.ok(!r.hung, name + ' never called back: ' + show(r));
    assert.ok(!r.err, name + ' answered: ' + show(r));
    assert.equal(r.result && r.result.ok, true, name + ': ' + show(r));
}
// `timeout` listeners on a session and on the socket objects it holds (Bun 1.4.x left them on the session, Bun <= 1.3 on the socket).
function timeoutListeners(s) {
    var o = { session: s.listenerCount('timeout') };
    var syms = Object.getOwnPropertySymbols(s);
    for (var i = 0; i < syms.length; i++) {
        var v = s[syms[i]];
        if (v && typeof v.listenerCount === 'function' && /ocket/.test(String(syms[i]))) { o[String(syms[i])] = v.listenerCount('timeout'); }
    }
    return o;
}

// Every stream the controller opens, in order (it calls the module's connect at request time).
var _connect = http2.connect;
var opened = [];
var streams = [];

before(function () {
    http2.connect = function () {
        var s = _connect.apply(http2, arguments);
        opened.push(s);
        var _request = s.request;
        s.request = function () { var r = _request.apply(s, arguments); streams.push(r); return r; };
        return s;
    };
    setContext('bundle', 'tb971');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb971: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65528 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65528'
        } } } }
    });
});
after(function () {
    http2.connect = _connect;
    opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
});

var src = fs.readFileSync(SOURCE, 'utf8');
var HELPER_DECL = 'var _ownBunStreamTimeout = function _ownBunStreamTimeout(req, client) {';

describe('01 - source: the two lines every runtime reads stay as they were; only Bun takes the stand-in and keeps the listeners', function () {
    it('the calls the timeout pins read are byte-identical (controls)', function () {
        assert.equal(src.split('req.setTimeout(_streamTimeout, function onStreamTimeout() {').length - 1, 1, 'the stream timeout call');
        assert.equal(src.split('try { req.setTimeout(0); } catch (e) {}').length - 1, 1, 'the release of the timer');
    });

    it('the flag comes from utils/runtime', function () {
        assert.ok(strip(src).indexOf("var _RUNTIME_IS_BUN = require(__dirname + '/../../../../utils/runtime').isBun();") > -1);
        assert.ok(fs.existsSync(path.join(path.dirname(SOURCE), '..', '..', '..', '..', 'utils', 'runtime.js')), 'that path resolves from core/controller');
    });

    it('the stand-in is installed once, on Bun only, right after the stream is created and before its first listener', function () {
        var live = strip(src);
        var CALL = 'if (_RUNTIME_IS_BUN) { _ownBunStreamTimeout(req, client); }';
        assert.equal(live.split(CALL).length - 1, 1);
        var at = live.indexOf(CALL);
        assert.ok(at > live.indexOf('req = client.request(headers);'), 'after client.request()');
        assert.ok(at < live.indexOf('let isFinished  = false;', live.indexOf('req = client.request(headers);')), 'before the first state of the stream');
        assert.ok(at < live.indexOf("req.on('response', function onResponseHeaders(respHeaders) {"), 'before its first listener');
    });

    it('_finalizeStream() keeps the listeners on Bun and drops them everywhere else', function () {
        var at = src.indexOf('var _finalizeStream = function _finalizeStream()');
        var body = src.slice(at, src.indexOf('};', at));
        assert.ok(body.indexOf('if (!_RUNTIME_IS_BUN) { try { req.removeAllListeners(); } catch (e) {} }') > -1, 'gated on the runtime');
    });
});

describe('02 - the stand-in timer alone, on a manual clock', function () {
    var make = null;
    var start = src.indexOf(HELPER_DECL);
    // Every timer the helper arms; fire() runs the last one's callback, as an expiry would.
    function mkClock() {
        var C = { timers: [], refreshes: 0, cleared: 0, unrefs: 0 };
        C.setTimeout = function (fn, ms) {
            var t = { fn: fn, ms: ms, live: true,
                      refresh: function () { t.live = true; C.refreshes++; return t; },
                      unref: function () { C.unrefs++; return t; } };
            C.timers.push(t);
            return t;
        };
        C.clearTimeout = function (t) { if (t) { t.live = false; C.cleared++; } };
        C.fire = function () {
            var t = C.timers[C.timers.length - 1];
            assert.ok(t && t.live, 'a live timer to fire');
            t.live = false;
            t.fn();
        };
        C.liveCount = function () { return C.timers.filter(function (t) { return t.live; }).length; };
        return C;
    }
    function mk(writableFinished) {
        var C = mkClock();
        var req = new EventEmitter();
        req.writableFinished = writableFinished;
        var client = { state: { outboundQueueSize: 0 } };
        var fired = [];
        make(C.setTimeout, C.clearTimeout)(req, client);
        return { C: C, req: req, client: client, fired: fired, arm: function (ms) { return req.setTimeout(ms === undefined ? 1000 : ms, function () { fired.push(1); }); } };
    }

    before(function () {
        assert.ok(start > -1, 'the helper is found');
        var end = src.indexOf('\n};\n', start);
        var code = src.slice(start, end + 3);
        // no closure read: the helper sees only its two parameters and the clock passed here, so a ReferenceError would show one
        make = function (st, ct) { return new Function('setTimeout', 'clearTimeout', code + '\nreturn _ownBunStreamTimeout;')(st, ct); };
    });

    it('setTimeout(ms, cb) arms one timer of that length, unref\'d, on this stream, and returns the stream', function () {
        var m = mk(true);
        assert.equal(Object.prototype.hasOwnProperty.call(m.req, 'setTimeout'), true);
        assert.equal(m.arm(1234), m.req);
        assert.equal(m.C.timers.length, 1);
        assert.equal(m.C.timers[0].ms, 1234);
        assert.equal(m.C.unrefs, 1);
    });

    it('an expiry with nothing moving runs the callback, once', function () {
        var m = mk(true);
        m.arm();
        m.C.fire();
        assert.equal(m.fired.length, 1);
        assert.equal(m.C.liveCount(), 0);
        m.req.emit('data', Buffer.from('x'));
        assert.equal(m.C.refreshes, 0, 'data after the expiry refreshes nothing');
    });

    it('data and the completed upload refresh it; response headers do not (Node\'s rule)', function () {
        var m = mk(false);
        m.arm();
        m.req.emit('data', Buffer.from('x'));
        assert.equal(m.C.refreshes, 1, 'data');
        m.req.emit('finish');
        assert.equal(m.C.refreshes, 2, 'finish');
        assert.equal(m.req.listenerCount('response'), 0, 'no listener on response');
        assert.equal(m.fired.length, 0);
    });

    it('close and setTimeout(0) clear it and forget the callback', function () {
        var a = mk(true);
        a.arm();
        a.req.emit('close');
        assert.equal(a.C.liveCount(), 0, 'close clears');
        a.req.emit('data', Buffer.from('x'));
        assert.equal(a.C.refreshes, 0, 'nothing left to refresh');
        var b = mk(true);
        b.arm();
        assert.equal(b.req.setTimeout(0), b.req);
        assert.equal(b.C.liveCount(), 0, 'setTimeout(0) clears');
        assert.equal(b.C.timers.length, 1, 'and arms nothing');
        assert.equal(b.fired.length, 0);
    });

    it('a second setTimeout(ms, cb) replaces the first', function () {
        var m = mk(true);
        var first = 0, second = 0;
        m.req.setTimeout(1000, function () { first++; });
        m.req.setTimeout(2000, function () { second++; });
        assert.equal(m.C.liveCount(), 1);
        m.C.fire();
        assert.deepEqual([first, second], [0, 1]);
    });

    it('an upload that still moves does not time out: the body has not finished and the session\'s queue changed', function () {
        var m = mk(false);
        m.client.state.outboundQueueSize = 5;
        m.arm();
        m.client.state.outboundQueueSize = 4;
        m.C.fire();
        assert.equal(m.fired.length, 0, 'the queue moved');
        assert.equal(m.C.refreshes, 1, 'the timer runs again');
        assert.equal(m.C.liveCount(), 1);
        m.client.state.outboundQueueSize = 3;
        m.C.fire();
        assert.equal(m.fired.length, 0, 'it moved again');
        m.C.fire();
        assert.equal(m.fired.length, 1, 'it stopped moving: the timeout fires');
        assert.equal(m.C.liveCount(), 0);
    });

    it('a body that has finished times out whatever the session\'s queue does (a sibling\'s upload)', function () {
        var m = mk(true);
        m.arm();
        m.client.state.outboundQueueSize = 9;
        m.C.fire();
        assert.equal(m.fired.length, 1);
    });

    it('a session whose state cannot be read (a destroyed one): the expiry still runs the callback', function () {
        var C = mkClock();
        var req = new EventEmitter();
        req.writableFinished = false;
        var client = {};
        Object.defineProperty(client, 'state', { get: function () { throw new Error('session gone'); } });
        var fired = 0;
        make(C.setTimeout, C.clearTimeout)(req, client);
        req.setTimeout(1000, function () { fired++; });
        C.fire();
        assert.equal(fired, 1);
    });
});

describe('03 - this stream\'s timer belongs to this stream', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a hung call fails at its requestTimeout although a sibling on the session finished first (Bun 1.4.x: never called back)', async function () {
        assertAnswered(await q(inst, { port: h.port, path: '/fast/0', requestTimeout: '5s' }), 'the warm-up');
        var x = q(inst, { port: h.port, path: '/hang/1' });
        await sleep(300);
        var y = await q(inst, { port: h.port, path: '/fast/1' });
        assertAnswered(y, 'the fast sibling');
        var rx = await x;
        assertTimedOut(rx, 'the hung call');
        assert.ok(rx.ms >= 900 && rx.ms < 3000, 'at its own timeout, not later: ' + show(rx));
        assert.equal(h.S.sessions.length, 1, 'both rode one connection');
    });

    it('a call with a long timeout is not failed by a sibling\'s short one (Bun: TIMEOUT « after 30s » at about 1.3 s)', async function () {
        assertAnswered(await q(inst, { port: h.port, path: '/fast/2', requestTimeout: '5s' }), 'the warm-up');
        var x = q(inst, { port: h.port, path: '/late/2', requestTimeout: '30s' });
        await sleep(300);
        var y = q(inst, { port: h.port, path: '/hang/2' });
        var ry = await y;
        var rx = await x;
        assertAnswered(rx, 'the long call');
        assert.ok(rx.ms >= LATE_MS - 100, 'it waited for the upstream: ' + show(rx));
        assertTimedOut(ry, 'the short call');
        assert.match(ry.err.message, /after 1000ms/);
        assert.ok(ry.ms >= 900 && ry.ms < 3000, show(ry));
    });
});

describe('04 - data refreshes the timer, as Node\'s stream timer does', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a chunk, then silence: the timeout counts from the chunk (Bun: from the request)', async function () {
        assertAnswered(await q(inst, { port: h.port, path: '/fast/0', requestTimeout: '5s' }), 'the warm-up');
        var r = await q(inst, { port: h.port, path: '/chunk/1', requestTimeout: '2s' });
        assertTimedOut(r, 'the call');
        assert.ok(r.ms >= GAP_MS + 1700 && r.ms < GAP_MS + 5000, 'about 2 s after the chunk: ' + show(r));
    });

    it('a response that keeps streaming for longer than the timeout completes (Bun: TIMEOUT mid-body)', async function () {
        var r = await q(inst, { port: h.port, path: '/trickle/1', requestTimeout: '2s', watchdog: 15000 });
        assertAnswered(r, 'the streaming call');
        assert.equal(r.result.pad.length, TRICKLE_N - 1, 'the whole body arrived: ' + show(r));
        assert.ok(r.ms >= TRICKLE_N * TRICKLE_MS - 200, 'it ran past the timeout: ' + show(r));
    });
});

describe('05 - a timeout above the keepalive PING fires (Bun 1.4.x: never, the default 10 s included)', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('a hung call with requestTimeout 6 s fails at 6 s', async function () {
        assertAnswered(await q(inst, { port: h.port, path: '/fast/0', requestTimeout: '5s' }), 'the warm-up');
        var r = await q(inst, { port: h.port, path: '/hang/1', requestTimeout: '6s', watchdog: 12000 });
        assertTimedOut(r, 'the hung call');
        assert.ok(r.ms >= 5800 && r.ms < 9000, show(r));
    });
});

describe('06 - a finished call gives its slot back at the peer\'s stream limit (#B1052)', function () {
    var LIMIT = 8;
    var h = null, inst = null;
    before(async function () { h = await mkUpstream({ maxConcurrentStreams: LIMIT }); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('30 sequential calls complete at a peer limit of 8 (Bun 1.4.x: 8, then nothing is sent)', async function () {
        var done = 0, last = null;
        for (var i = 0; i < 30; i++) {
            last = await q(inst, { port: h.port, path: '/fast/seq-' + i, requestTimeout: '2s', watchdog: 5000 });
            if (last.hung || last.err) { break; }
            done++;
        }
        assert.equal(done, 30, 'stopped after ' + done + ': ' + show(last));
        assert.equal(h.S.sessions.length, 1, 'one connection carried them');
    });

    it('30 calls, 12 at a time, at the same limit all complete', async function () {
        var left = 30, results = [];
        var worker = async function (w) {
            while (left > 0) {
                left--;
                results.push(await q(inst, { port: h.port, path: '/fast/par-' + w + '-' + left, requestTimeout: '5s', watchdog: 10000 }));
            }
        };
        var workers = [];
        for (var w = 0; w < 12; w++) { workers.push(worker(w)); }
        await Promise.all(workers);
        var bad = results.filter(function (r) { return r.hung || r.err; });
        assert.equal(results.length, 30);
        assert.equal(bad.length, 0, bad.length + ' of 30 failed, the first: ' + (bad[0] ? show(bad[0]) : ''));
    });
});

describe('07 - a call leaves nothing behind on the session', function () {
    var h = null, inst = null;
    before(async function () { h = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeUpstream(h); });

    it('30 sequential calls add no `timeout` listener to the session or its socket (Bun: one per call)', async function () {
        assertAnswered(await q(inst, { port: h.port, path: '/fast/first', requestTimeout: '2s' }), 'the first call');
        var s = cachedSession(inst, h.port);
        assert.ok(s, 'the session is cached');
        var base = timeoutListeners(s); // Bun's socket carries one of its own
        for (var i = 0; i < 30; i++) {
            assertAnswered(await q(inst, { port: h.port, path: '/fast/' + i, requestTimeout: '2s' }), 'call ' + i);
        }
        assert.equal(cachedSession(inst, h.port), s, 'one session carried them');
        assert.deepEqual(timeoutListeners(s), base);
    });

    it('a stream carries the stand-in on Bun and the runtime\'s own timer on Node', async function () {
        var base = streams.length;
        assertAnswered(await q(inst, { port: h.port, path: '/fast/own' }), 'the call');
        assert.equal(streams.length - base, 1, 'one stream');
        assert.equal(Object.prototype.hasOwnProperty.call(streams[base], 'setTimeout'), IS_BUN);
    });
});

describe('08 - a connection that stopped forwarding: the call fails at its timeout and the next one is served', function () {
    var h = null, P = null, inst = null;
    before(async function () { h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst(); });
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('a POST on it fails TIMEOUT at requestTimeout (Bun 1.4.x: twice that)', async function () {
        assertAnswered(await q(inst, { port: P.port, path: '/fast/0', requestTimeout: '5s' }), 'the warm-up');
        P.drop();
        var r = await q(inst, { port: P.port, path: '/fast/1', method: 'POST', data: { a: 1 }, requestTimeout: '2s', watchdog: 8000 });
        assertTimedOut(r, 'the POST');
        assert.ok(r.ms >= 1800 && r.ms < 3500, show(r));
        assert.equal(h.S.paths.indexOf('/fast/1'), -1, 'nothing reached the upstream: ' + JSON.stringify(h.S.paths));
    });

    it('the next call is served on a fresh session', async function () {
        var r = await q(inst, { port: P.port, path: '/fast/2', requestTimeout: '5s', watchdog: 10000 });
        assertAnswered(r, 'the next call');
        assert.ok(h.S.paths.indexOf('/fast/2') > -1, JSON.stringify(h.S.paths));
    });
});
