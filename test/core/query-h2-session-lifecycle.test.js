'use strict';
/**
 * self.query() over HTTP/2 — client session lifecycle (#P43: #B625, #B627; bundle-to-bundle audit 2026-09-24)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http2`
 * servers (the harness of query-h2-session-resilience.test.js).
 *
 * #B625 — every eviction of a cached HTTP/2 client session deleted the cache entry BY
 *   KEY. A dead session's asynchronous 'close' (or 'error' / 'goaway', or an older
 *   attempt's retry branch) therefore evicted the LIVE replacement a retry had just
 *   cached under the same key — the replacement kept running, keepalive ticking, in no
 *   cache (audit F3: 148 + 160 ESTABLISHED sessions still open 186 s after a run). Every
 *   eviction is now identity-checked, and the cache owns the "lost its slot" teardown:
 *   a cleanup registered with the entry stops the keepalive and closes the session
 *   gracefully (replace, LRU, the session cap, delete).
 * #B627 — the pre-flight PING stormed: each stale caller pinged with its own deadline,
 *   node cancels every ping past its outstanding limit (10) with ERR_HTTP2_PING_CANCEL,
 *   and that cancel was read as a dead session (22 healthy-session evictions at c=50).
 *   Now ONE pre-flight ping per session serves every waiting caller, a response counts
 *   as proof of life, and a cancelled ping is inconclusive.
 * #P43 — `server.query.http2SessionPool` (default 1): N sessions per authority,
 *   round-robin, so a per-connection (L4) balancer sees N connections.
 *
 * Red-first (2026-09-24, detached worktree at the pre-fix HEAD): see the arm list in
 * todo/p43-s3-design.md § 9 — the live arms §02-§08 fail on the pre-fix controller.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var http2 = require('node:http2');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
var C = http2.constants;

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function countOf(text, needle) { return text.split(needle).length - 1; }
function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}
// Bounded poll — a red-first run must FAIL, never hang.
async function waitFor(cond, ms) {
    var until = Date.now() + (ms || 1000);
    while (Date.now() < until) { if (cond()) return true; await sleep(5); }
    return cond();
}

// A bare h2c server whose per-stream behaviour is the arm's `onStream(stream, session, S)`.
// S.pings counts PING frames received from the client (pre-flight + keepalive);
// session._streams counts the streams each server session carried.
function mkServer(onStream, opts) {
    var server = http2.createServer(opts || {});
    var S = { streams: 0, sessions: [], pings: 0 };
    server.on('session', function(session) {
        S.sessions.push(session);
        session._streams = 0;
        session.on('error', function() {});
        session.on('ping', function() { S.pings++; });
        session.on('stream', function(stream) {
            S.streams++;
            session._streams++;
            stream.on('error', function() {});
            onStream(stream, session, S);
        });
    });
    return new Promise(function(res) {
        server.listen(0, '127.0.0.1', function() { res({ server: server, S: S, port: server.address().port }); });
    });
}
function ok200(stream) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('{"ok":true}');
}
function closeServer(h) {
    if (!h) return;
    h.S.sessions.forEach(function(s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'rq', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function(){}, end: function(){}, writeHead: function(){}, getHeaders: function(){ return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tbq', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { rq: {} } }
            },
            rule: 'rq', control: 'act', bundle: 'tbq', controller: '/controllers/tq.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: '/tmp/gina-tq', _cacheIsEnabled: 'false', _http2Sessions: [] };
    inst.throwError = function() {};
    return inst;
}
function keyOf(port, slot) { return 'http2session:http://127.0.0.1:' + port + (slot ? '#' + slot : ''); }
// The cached client session for an authority — the cache stores {value, cleanup} wrappers.
function cachedSession(inst, port, slot) {
    var entry = inst.serverInstance._cached.get(keyOf(port, slot));
    return entry && entry.value ? entry.value : entry;
}
// Every client session this file opened, cached or not — the node-22 teardown hazard:
// a client session that outlives the file's teardown hangs the FILE on node 22
// (validator-proxy-conf-clone-b522), so the sweep also covers sessions a pre-fix run
// orphaned (alive, in no cache — exactly what #B625 fixes).
var opened = [];
var _connect = http2.connect;
http2.connect = function() {
    var s = _connect.apply(http2, arguments);
    opened.push(s);
    return s;
};
function destroyClientSessions(inst) {
    try { if (inst) inst.serverInstance._cached.forEach(function(entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
    opened.forEach(function(s) { try { s.destroy(); } catch (e) {} });
}
function q(inst, port, method, data) {
    return new Promise(function(res) {
        var opts = { protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + port, host: '127.0.0.1',
                     port: port, path: '/x', method: method || 'GET', requestTimeout: '2s' };
        inst.query(opts, data || {}, function(err, result) { res({ err: err, result: result }); });
    });
}
function live(s) { return !!s && !s.closed && !s.destroyed; }

before(function() {
    setContext('bundle', 'tbq');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {} }, 'http/2.0': { http: {} } },
        config: { envConf: { tbq: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65530 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65530'
        } } } }
    });
});
after(function() { http2.connect = _connect; destroyClientSessions(null); });

describe('01 - source pins (#B625 / #B627 / #P43)', function() {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
    var h2End   = src.indexOf('var getSession = function()');
    var block   = src.slice(h2Start, h2End);

    it('the HTTP/2 client region is found (control)', function() {
        assert.ok(h2Start > -1 && h2End > h2Start);
    });

    it('#B625 — an identity check guards every key eviction but the stale-entry drop', function() {
        assert.ok(block.indexOf('var _isCached = function _isCached(key, session) {') > -1, '_isCached is defined in the handler');
        assert.equal(countOf(block, 'cache.delete(sessKey)'), 13, 'the thirteen key-eviction sites');
        assert.equal(countOf(block, '_isCached(sessKey, client)'), 12,
            'twelve are identity-guarded; the thirteenth drops the stale entry it just read from the cache');
        var staleAt = block.indexOf('if (client && (client.closed || client.destroyed)) {');
        assert.ok(staleAt > -1, 'the stale-entry drop is still the first eviction');
        assert.ok(block.slice(staleAt, staleAt + 200).indexOf('cache.delete(sessKey);') > -1);
    });

    it('#B625 — the cache owns the lost-slot teardown: a cleanup is registered with the entry, and the cap evicts through it', function() {
        assert.ok(block.indexOf('cache.set(sessKey, client, _onSessionEvicted);') > -1, 'the session is cached with its cleanup');
        var cleanupAt = block.indexOf('var _onSessionEvicted = function _onSessionEvicted() {');
        assert.ok(cleanupAt > -1);
        var cleanup = block.slice(cleanupAt, block.indexOf('};', cleanupAt));
        assert.ok(cleanup.indexOf('clearInterval(client._ginaKeepalive)') > -1, 'stops the keepalive');
        assert.ok(cleanup.indexOf('client.close()') > -1, 'drains gracefully');
        assert.equal(cleanup.indexOf('.destroy('), -1, 'never destroys: that is the retry paths\' verdict');
        var capAt = block.indexOf('if (self.serverInstance._http2Sessions.length >= HTTP2_SESSION_MAX) {');
        assert.ok(capAt > -1);
        var cap = block.slice(capAt, block.indexOf('client = browser.connect(authority, options);', capAt));
        assert.ok(cap.indexOf('cache.delete(_evictKey);') > -1, 'the cap evicts through the cache');
        assert.equal(cap.indexOf('.destroy()'), -1, 'the cap no longer destroys the evicted session');
    });

    it('#B627 — one pre-flight ping per session, a response is proof of life, a cancelled ping is inconclusive', function() {
        assert.ok(block.indexOf('client._ginaPreflight.waiters.push(_pfWaiter);') > -1, 'later stale callers join the in-flight pre-flight');
        // Counted on the comment-stripped region: the keepalive's own doc comment names `client.ping()`.
        assert.equal(countOf(stripLineComments(block), 'client.ping('), 2, 'two live ping sites: the keepalive and the pre-flight');
        assert.ok(block.indexOf('var _pfSettle = function onSharedPreflightPong(pingErr) {') > -1 && block.indexOf('client.ping(_pfSettle);') > -1,
            'the pre-flight ping is the ONE shared per session');
        // A ping that throws synchronously (Bun <= 1.3 throws a cancelled ping; node calls back) never escapes:
        assert.ok(block.indexOf('_pfSettle(_pfThrow);') > -1, 'a thrown pre-flight ping settles the waiters instead of escaping query()');
        assert.ok(block.indexOf('client.ping(_onKeepalivePong);') > -1 && block.indexOf('_onKeepalivePong(_keepaliveThrow);') > -1,
            'a thrown keepalive ping is handled inside the interval');
        assert.equal(block.indexOf('client.ping(function onPreflightPong('), -1, 'the per-caller pre-flight ping is gone');
        assert.equal(countOf(block, "'ERR_HTTP2_PING_CANCEL'"), 2, 'the keepalive and the pre-flight each tell a cancelled ping apart');
        var respAt = block.indexOf("req.on('response', function onResponseHeaders(respHeaders) {");
        assert.ok(respAt > -1);
        assert.ok(block.slice(respAt, block.indexOf('});', respAt)).indexOf('client._lastPongAt = Date.now();') > -1, 'a response re-stamps the freshness clock');
        assert.ok(block.indexOf('var HTTP2_KEEPALIVE_MS') > -1 && block.indexOf('var HTTP2_KEEPALIVE_DEADLINE_MS') > -1, 'named keepalive constants');
    });

    it('#P43 — the session pool: slot keys and the per-authority round-robin cursor', function() {
        assert.ok(block.indexOf('self.serverInstance._h2SessionPool') > -1);
        assert.ok(block.indexOf('self.serverInstance._h2PoolCursor[authority]') > -1);
        assert.ok(block.indexOf('let sessKey = "http2session:"+ authority + (_poolSlot > 0 ? \'#\' + _poolSlot : \'\');') > -1, 'slot 0 keeps the historical key');
    });
});

describe('02 - #B625 live: the dead session\'s late \'close\' no longer evicts the replacement a retry cached', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream, session, S) {
            if (S.streams === 2) { session.goaway(C.NGHTTP2_ENHANCE_YOUR_CALM); session.close(); return; } // the in-flight call dies
            ok200(stream);
        });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('after the retry answered, the cache still holds ONE live session — the replacement', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'call 1 answered');
        var first = cachedSession(inst, h.port);
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err, 'call 2 answered through the retry');
        await sleep(150); // the dead session's asynchronous 'close' has run by now
        var cached = cachedSession(inst, h.port);
        assert.ok(live(cached), 'a live session is cached (pre-fix: the dead session\'s close evicted the replacement — the cache was empty)');
        assert.notEqual(cached, first, 'it is the replacement, not the GOAWAY\'d session');
        assert.equal(inst.serverInstance._http2Sessions.length, 1, 'the tracker holds one key');
        assert.equal(h.S.sessions.length, 2, 'the server saw exactly the original and the replacement');
    });

    it('the next call reuses the cached replacement — no third session', async function() {
        var c = await q(inst, h.port, 'GET');
        assert.ok(!c.err);
        assert.equal(h.S.sessions.length, 2, 'no new connection (pre-fix: a third session, the replacement orphaned)');
    });
});

describe('03 - #B627 live: twenty stale callers share ONE pre-flight ping and ONE session', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { setTimeout(function() { try { ok200(stream); } catch (e) {} }, 5); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('establish, backdate the freshness clock, 20 concurrent GETs: every call answers on the same session', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var sess = cachedSession(inst, h.port);
        var pingsBefore = h.S.pings;
        sess._lastPongAt = Date.now() - 10000; // stale: every caller must validate first
        var batch = [];
        for (var i = 0; i < 20; i++) { batch.push(q(inst, h.port, 'GET')); }
        var r = await Promise.all(batch);
        var failed = r.filter(function(x) { return x.err; });
        assert.equal(failed.length, 0, 'no call failed: ' + JSON.stringify(failed.map(function(x) { return x.err && (x.err.code + ' ' + x.err.message); })));
        assert.equal(h.S.pings - pingsBefore, 1, 'ONE pre-flight ping reached the server (pre-fix: one per caller; the 11th was cancelled and read as a dead session)');
        assert.equal(h.S.sessions.length, 1, 'the healthy session was never evicted (pre-fix: destroyed, calls retried on new sessions)');
        assert.ok(cachedSession(inst, h.port) === sess && live(sess), 'the same session is still cached and live');
    });
});

describe('04 - #B627 live: a response re-stamps the freshness clock, so a busy session never pre-flights', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('a call on a session 2.9 s past its last PONG stamps it; 200 ms later the next call does not ping', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var sess = cachedSession(inst, h.port);
        sess._lastPongAt = Date.now() - 2900; // still fresh (< 3 s): this call sends at once
        var pingsBefore = h.S.pings;
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err);
        assert.equal(h.S.pings - pingsBefore, 0, 'control: the first call was fresh and did not ping');
        await sleep(200); // now 3.1 s past the backdated stamp — stale unless the response re-stamped it
        var c = await q(inst, h.port, 'GET');
        assert.ok(!c.err);
        assert.equal(h.S.pings - pingsBefore, 0, 'no pre-flight ping (pre-fix: the second call pinged — only a PONG refreshed the clock)');
    });
});

describe('05 - #B627 live: a CANCELLED pre-flight ping is inconclusive — the call goes out on the same session', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('with the runtime\'s outstanding pings used up, the stale call still answers without evicting the session (node, Bun <= 1.3; Bun 1.4 has no limit)', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var sess = cachedSession(inst, h.port);
        var cancelled = 0;
        for (var i = 0; i < 10; i++) { sess.ping(function(err) { if (err && err.code === 'ERR_HTTP2_PING_CANCEL') cancelled++; }); }
        // Control: an 11th ping right now is cancelled synchronously by node (its limit is 10).
        var probe = null;
        try { sess.ping(function(err) { probe = err ? err.code : 'ack'; }); } catch (e) { probe = 'THROW ' + e.code; }
        if (probe === null && process.versions && process.versions.bun) {
            // Bun 1.4 has no outstanding-ping limit (measured 2026-09-24 on 1.4.2): the 11th ping is not
            // cancelled, so the cancelled pre-flight this arm needs cannot be produced there.
            return;
        }
        // node calls back with the cancel; Bun 1.2 / 1.3 THROW it synchronously (measured 2026-09-24).
        assert.ok(probe === 'ERR_HTTP2_PING_CANCEL' || probe === 'THROW ERR_HTTP2_PING_CANCEL',
            'control: the runtime cancels a ping past its outstanding limit at once — got ' + probe);
        sess._lastPongAt = Date.now() - 10000;
        var b = await q(inst, h.port, 'GET'); // gina's pre-flight ping is cancelled the same way
        assert.ok(!b.err, 'the call answered: ' + (b.err && (b.err.code + ' ' + b.err.message)));
        assert.equal(h.S.sessions.length, 1, 'on the SAME session (pre-fix: the cancel evicted + destroyed it, the call retried on a second)');
        assert.ok(cachedSession(inst, h.port) === sess && live(sess), 'the session is still cached and live');
        assert.equal(cancelled, 0, 'the ten outstanding pings were acknowledged, not cancelled');
    });
});

describe('06 - #B625 live: evicting a session from the cache closes it gracefully (the cleanup contract)', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('a delete through the engine cache closes the session and drops its tracker entry; the next call reconnects', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var sess = cachedSession(inst, h.port);
        assert.ok(live(sess));
        assert.equal(inst.serverInstance._http2Sessions.length, 1);
        process.gina._cache.from(inst.serverInstance._cached);
        process.gina._cache.delete(keyOf(h.port));
        await sleep(100);
        assert.equal(sess.closed, true, 'the evicted session was closed (pre-fix: it stayed open — an orphan with a live keepalive)');
        assert.equal(inst.serverInstance._http2Sessions.length, 0, 'its tracker entry went with it');
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err);
        assert.equal(h.S.sessions.length, 2, 'the next call opened a fresh session');
    });
});

describe('07 - #P43 live: http2SessionPool 2 spreads calls round-robin over two sessions per authority', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
        inst.serverInstance._h2SessionPool = 2; // what server.js stamps from server.query.http2SessionPool
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('4 sequential GETs land on 2 server sessions, 2 streams each, under the slot-0 and slot-1 keys', async function() {
        for (var i = 0; i < 4; i++) {
            var r = await q(inst, h.port, 'GET');
            assert.ok(!r.err, 'call ' + (i + 1) + ' answered');
        }
        assert.equal(h.S.sessions.length, 2, 'two connections (pre-fix: one — the pool is ignored)');
        assert.deepEqual(h.S.sessions.map(function(s) { return s._streams; }), [2, 2], 'round-robin');
        assert.ok(live(cachedSession(inst, h.port, 0)), 'slot 0 keeps the historical key');
        assert.ok(live(cachedSession(inst, h.port, 1)), 'slot 1 is keyed #1');
    });
});

describe('08 - #B625 live: the session cap drains the evicted session — an in-flight POST on it still answers', function() {
    var h1 = null, h2 = null, inst = null;
    before(async function() {
        h1 = await mkServer(function(stream, session, S) {
            if (S.streams === 1) { ok200(stream); return; }
            setTimeout(function() { try { ok200(stream); } catch (e) {} }, 300); // the in-flight POST
        });
        h2 = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h1); closeServer(h2); });

    it('with the tracker at the cap, a new authority evicts the oldest session gracefully', async function() {
        var a = await q(inst, h1.port, 'GET');
        assert.ok(!a.err, 'established');
        var oldest = cachedSession(inst, h1.port);
        // The live session's key is the oldest entry; fill the tracker to HTTP2_SESSION_MAX (50).
        for (var i = 0; i < 49; i++) { inst.serverInstance._http2Sessions.push('http2session:filler-' + i); }
        var post = q(inst, h1.port, 'POST', { a: 1 }); // on the oldest session (the server answers it after 300 ms)
        // Wait until the server HOLDS the POST: a request submitted but not yet flushed is refused
        // by nghttp2 (REFUSED_STREAM, never sent) when its session starts closing in the same tick —
        // that is a different case (measured 2026-09-24), and it failed the same way before the fix.
        assert.ok(await waitFor(function() { return h1.S.streams === 2; }, 1000), 'control: the POST reached the server');
        var other = await q(inst, h2.port, 'GET');     // a new session: the cap evicts the oldest key
        assert.ok(!other.err, 'the new authority answered');
        assert.equal(inst.serverInstance._cached.has(keyOf(h1.port)), false, 'the oldest session left the cache');
        var p = await post;
        assert.ok(!p.err, 'the in-flight POST still answered (pre-fix: destroy() killed it — ' + (p.err && (p.err.code + ' ' + p.err.message)) + ')');
        assert.equal(p.result && p.result.ok, true);
        assert.equal(oldest.closed, true, 'the evicted session was closed (gracefully), not left open');
    });
});

// ---------------------------------------------------------------- server.js ----
// The resolver is an inner function of the server module (not loadable standalone):
// its EXTRACTED source is executed, never a replica. It closes over nothing but
// `Error`, so running it at global scope reproduces its production behaviour.
describe('09 - #P43: server.query.http2SessionPool is resolved and validated once at engine start', function() {
    var SERVER_SRC = fs.readFileSync(path.join(FW, 'core', 'server.js'), 'utf8');
    var at  = SERVER_SRC.indexOf('var resolveQueryHttp2SessionPool = function(serverConf) {');
    var end = SERVER_SRC.indexOf('\n    };\n', at);
    var resolve = (at > -1 && end > at)
        ? new Function('return (' + SERVER_SRC.slice(at, end + 6).replace('var resolveQueryHttp2SessionPool = ', '').replace(/;\s*$/, '') + ');')()
        : null;

    it('the resolver is found and stamped beside the #MS5 breaker, typeof-guarded (resolved once)', function() {
        assert.ok(typeof resolve === 'function', 'resolveQueryHttp2SessionPool is defined in server.js');
        var breakerAt = SERVER_SRC.indexOf('instance._queryCircuitBreaker = resolveQueryCircuitBreakerConf(');
        var stampAt   = SERVER_SRC.indexOf('instance._h2SessionPool = resolveQueryHttp2SessionPool(self.conf[self.appName][self.env].server);');
        assert.ok(breakerAt > -1 && stampAt > breakerAt, 'stamped after the breaker, in the instance-scalars family');
        assert.ok(SERVER_SRC.slice(stampAt - 120, stampAt).indexOf("if ( typeof(instance._h2SessionPool) == 'undefined' ) {") > -1, 'typeof-guarded');
    });

    it('absent → 1 (byte-identical default); integers 1..50 pass through', function() {
        assert.equal(resolve(undefined), 1);
        assert.equal(resolve({}), 1);
        assert.equal(resolve({ query: {} }), 1);
        assert.equal(resolve({ query: { circuitBreaker: { enabled: true } } }), 1);
        [1, 2, 4, 50].forEach(function(n) { assert.equal(resolve({ query: { http2SessionPool: n } }), n); });
    });

    it('anything else refuses the boot, naming the key and the value', function() {
        [0, -1, 51, 1.5, '2', null, true, NaN, Infinity].forEach(function(v) {
            assert.throws(function() { resolve({ query: { http2SessionPool: v } }); },
                function(e) { return /server\.query\.http2SessionPool/.test(e.message) && e.message.indexOf(String(v)) > -1; },
                'rejects ' + String(v));
        });
    });
});

// ----------------------------------------------------------------- gna.js ----
// The H5 warmup pre-establishes HTTP/2 sessions at boot. It lives inside gna.js's
// bootstrap and cannot be loaded alone, so its EXTRACTED function runs against a bare
// server with every identifier it closes over injected (lib, instance, conf, the target
// list and the module's own `require` — a lifted function captures no closure).
describe('10 - #B625 / #B627: the boot warmup caches its session like query() does', function() {
    var GNA_SRC = fs.readFileSync(path.join(FW, 'core', 'gna.js'), 'utf8');
    var fAt  = GNA_SRC.indexOf('function warmupHTTP2Sessions() {');
    var fEnd = GNA_SRC.indexOf('}); // end setImmediate', fAt);
    var Cache = require(path.join(FW, 'lib', 'cache'));
    var h = null, instance = null, key = null;

    function runWarmup(inst, targets) {
        var fn = new Function('lib', 'instance', 'conf', '_warmupTargets', 'require', 'return (' + GNA_SRC.slice(fAt, fEnd + 1) + ');')(
            { Cache: Cache }, inst, { server: {} }, targets, require);
        fn();
    }
    function warmed() { var e = instance._cached.get(key); return e && e.value; }

    before(async function() {
        assert.ok(fAt > -1 && fEnd > fAt, 'the warmup function is found in gna.js');
        h = await mkServer(function(stream) { ok200(stream); });
        key = 'http2session:http://127.0.0.1:' + h.port;
    });
    after(function() { closeServer(h); });

    it('a warmed session is stamped fresh after its initial PONG, so query() does not pre-flight it', async function() {
        instance = { _cached: new Map(), _http2Sessions: [] };
        runWarmup(instance, ['http://127.0.0.1:' + h.port]);
        assert.ok(await waitFor(function() { return live(warmed()) && h.S.pings >= 1; }, 2000), 'control: the warmup connected and pinged');
        assert.ok(await waitFor(function() { return typeof warmed()._lastPongAt === 'number'; }, 1000),
            'the initial PONG stamps _lastPongAt (pre-fix: never stamped — every first query() pre-flighted)');
        assert.ok(Date.now() - warmed()._lastPongAt < 2000);
    });

    it('evicting the warmed session through the cache closes it and drops its tracker entry', async function() {
        var sess = warmed();
        assert.ok(live(sess) && instance._http2Sessions.indexOf(key) > -1);
        var c = new Cache();
        c.from(instance._cached);
        c.delete(key);
        await sleep(50);
        assert.equal(sess.closed, true, 'closed gracefully (pre-fix: no cleanup was registered — it stayed open, keepalive ticking)');
        assert.equal(instance._http2Sessions.indexOf(key), -1, 'tracker entry dropped');
    });

    it('a warmed session closing late never evicts a newer session cached under its key', async function() {
        instance = { _cached: new Map(), _http2Sessions: [] };
        runWarmup(instance, ['http://127.0.0.1:' + h.port]);
        assert.ok(await waitFor(function() { return live(warmed()); }, 2000), 'control: warmed');
        var old = warmed();
        var newer = { closed: false, destroyed: false, destroy: function() {}, close: function() {} }; // a query() retry's session
        instance._cached.set(key, { value: newer, cleanup: null });
        old.destroy(); // the old session's close/error listeners run _wCleanup
        await sleep(50);
        var e = instance._cached.get(key);
        assert.ok(e && e.value === newer, 'the newer session is still cached (pre-fix: the old session\'s cleanup deleted it by key)');
    });

    it('source pins: identity guard, the registered cleanup, the keepalive PING_CANCEL skip', function() {
        var region = GNA_SRC.slice(fAt, fEnd);
        var cleanupAt = region.indexOf('var _wCleanup = function() {');
        assert.ok(cleanupAt > -1);
        var cleanupBody = region.slice(cleanupAt, region.indexOf('};', cleanupAt));
        assert.ok(cleanupBody.indexOf('if (!_wIsCached()) return;') > -1 && cleanupBody.indexOf('if (!_wIsCached()) return;') < cleanupBody.indexOf('warmupCache.delete(_wSessKey);'),
            'the identity check precedes the key delete');
        var setAt = region.indexOf('warmupCache.set(_wSessKey, _wClient, function _onWarmupSessionEvicted() {');
        assert.ok(setAt > -1, 'the cleanup is registered with the cache entry');
        var evicted = region.slice(setAt, region.indexOf('});', setAt));
        assert.ok(evicted.indexOf('_wClient.close()') > -1 && evicted.indexOf('.destroy(') === -1, 'graceful close, never destroy');
        assert.ok(region.indexOf("if (keepAliveErr.code !== 'ERR_HTTP2_PING_CANCEL') { _wCleanup(); }") > -1, 'a cancelled keepalive ping is inconclusive');
        // #B629 — node cancels a PING sent while the session is still connecting; the first ping waits for `connect`.
        assert.ok(region.indexOf("if (_wClient.connecting) { _wClient.once('connect', _wInitialPing); } else { _wInitialPing(); }") > -1,
            'the initial PING is deferred to connect');
        assert.equal(stripLineComments(region).indexOf('_wClient.ping(function(wPingErr'), -1, 'no initial ping fired straight after connect()');
    });
});

// ------------------------------------------------------------ #B619 (server) ----
// Since 0.6.33 the isaac server closes an idle HTTP/2 session gracefully after
// `http2Options.sessionIdleTimeout` (node only, default 120 s) — before, its timer
// gated the close on a property that does not exist and never closed anything. A
// server-initiated close therefore becomes a regular event for a cached client
// session: the client must evict it through the identity guard (tracker clean) and
// reconnect on the next call. The bare server below closes on its own timer the way
// isaac does.
describe('11 - #B619 live: gina\'s client copes with a server that closes idle sessions (node only)', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        h.server.on('session', function(session) {
            session.setTimeout(300);
            session.on('timeout', function() { if (!session.closed && !session.destroyed) session.close(); });
        });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('the closed session is evicted through the identity guard — tracker clean — and the next call reconnects', async function() {
        // The idle close is node-only (#B619): a Bun 1.2 / 1.3 server sends no GOAWAY after
        // close() (the next call would hang), Bun 1.4's timer fires late — measured 2026-09-24.
        if (process.versions && process.versions.bun) return;
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var sess = cachedSession(inst, h.port);
        assert.ok(live(sess));
        assert.equal(inst.serverInstance._http2Sessions.length, 1);
        assert.ok(await waitFor(function() { return sess.closed === true; }, 1500), 'the server closed the idle session (GOAWAY received)');
        assert.ok(await waitFor(function() { return inst.serverInstance._http2Sessions.length === 0; }, 500),
            'the goaway/close listeners evicted it through the identity guard — the tracker is clean');
        assert.ok(!live(cachedSession(inst, h.port)), 'no live session is cached under the key');
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err, 'the next call answered: ' + (b.err && (b.err.code + ' ' + b.err.message)));
        assert.equal(h.S.sessions.length, 2, 'on a fresh session');
        assert.equal(inst.serverInstance._http2Sessions.length, 1, 'exactly one tracker entry again');
        assert.ok(live(cachedSession(inst, h.port)), 'and it is cached');
    });
});

// -------------------------------------------------------- #B630 / #B631 (client) ----
// A request refused BEFORE the upstream processed it is replay-safe for any method
// (RFC 9113 §8.7). Two shapes reach the stream 'error' listener: REFUSED_STREAM
// (rstCode 7 — nghttp2 refusing a stream a closing session will not take, or a server
// at its stream limit) and an asynchronous ERR_HTTP2_GOAWAY_SESSION (node 24 / 26 and
// Bun 1.4 refuse to create the stream after a GOAWAY without throwing). Both went
// through the #B53-gated whitelist, so a POST failed although nothing was processed.
// The scene: the server closes gracefully on a PING, so a call whose pre-flight PING
// lands there sends its request onto a closing session (the #B619 idle close makes
// this a regular event).
describe('12 - #B630 / #B631 live: a request refused before processing is retried for ANY method', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        h.server.on('session', function(session) {
            session.on('ping', function() { if (!session.closed && !session.destroyed) session.close(); });
        });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('source pin: the never-processed branch precedes the #B53-gated whitelist and adds no eviction site', function() {
        var s = fs.readFileSync(SOURCE, 'utf8');
        var np = s.indexOf("var _neverProcessed = (errorCode === 'ERR_HTTP2_GOAWAY_SESSION')");
        var wl = s.indexOf("(errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ERR_HTTP2_SESSION_ERROR' || errorCode === 'ECONNRESET') && isRetryableMethod(");
        assert.ok(np > -1 && wl > np, 'the branch sits before the whitelist');
        var block = s.slice(np, wl);
        assert.ok(block.indexOf('req.rstCode === 7') > -1, 'REFUSED_STREAM is recognised by rstCode');
        assert.ok(block.indexOf('if (retryCount < HTTP2_MAX_RETRIES && _neverProcessed) {') > -1, 'budget-gated, method-agnostic');
        assert.equal(block.indexOf('isRetryableMethod('), -1, 'no method gate — nothing was processed');
        assert.equal(block.indexOf('cache.delete('), -1, 'no eviction — the session is dropped by the cache read on re-entry, or reused');
        assert.equal(block.indexOf('client.destroy('), -1, 'the session is not destroyed');
    });

    it('a GET and a POST whose pre-flight PING crosses the close both answer on a fresh session', async function() {
        // Capability control rather than a version check: the arm needs the server's GOAWAY to
        // reach the client after close() — a Bun 1.2 / 1.3 server never delivers it (measured).
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'established');
        var s1 = cachedSession(inst, h.port);
        var seen = false; s1.on('goaway', function() { seen = true; });
        s1.ping(function() {});
        if (!(await waitFor(function() { return seen; }, 500))) return; // no GOAWAY after close() on this runtime
        await waitFor(function() { return s1.closed || s1.destroyed; }, 500);
        var b0 = await q(inst, h.port, 'GET');
        assert.ok(!b0.err, 're-established on a fresh session');
        cachedSession(inst, h.port)._lastPongAt = Date.now() - 10000;
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err, 'GET across the close answered: ' + (b.err && (b.err.code + ' ' + b.err.message)));
        if (h.S.sessions.length === 2) {
            // A Bun <= 1.3 client LOSES the stream it sent across the close — delivered through the
            // close path as an empty 200, the runtime's documented graceful-close limitation — so
            // nothing was refused and nothing retried; the POST half does not apply there (a
            // lost-after-send POST must NOT be replayed). Measured 2026-09-24 on Bun 1.2.21 / 1.3.14.
            return;
        }
        assert.equal(h.S.sessions.length, 3, 'the refused GET was retried on a fresh session');
        assert.ok(live(cachedSession(inst, h.port)), 'and that session is cached');
        cachedSession(inst, h.port)._lastPongAt = Date.now() - 10000;
        var c = await q(inst, h.port, 'POST', { x: 1 });
        assert.ok(!c.err, 'POST across the close answered (pre-fix: STREAM_ERROR, retryCount 0 — refused with REFUSED_STREAM and not replayed under the #B53 gate): ' + (c.err && (c.err.code + ' ' + c.err.message)));
        assert.equal(h.S.sessions.length, 4, 'the control session, the re-established one, and one fresh session per retried call');
        assert.ok(live(cachedSession(inst, h.port)), 'the last fresh session is cached');
    });
});
