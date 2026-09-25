/**
 * #B402 — a SYNCHRONOUS app-callback throw on a transport-error query delivery
 * is owned at the delivery site instead of escaping the event/timer frame.
 *
 * Pre-fix (runtime-measured on both transports): the 14 bare error-path
 * deliveries had no try/catch — on the event/timer-frame sites (HTTP/1.1
 * request 'error' / ALPN, the HTTP/2 typed terminals, both pre-flight PING
 * failures) a sync throw escaped to the process handler (lib/proc.js: emerg +
 * SIGTERM — a whole-bundle kill on BOTH engines for consumer bundles, since an
 * app bug's error code matches none of the transport-lifecycle survive
 * branches), and on the caller-frame sites (host-missing, circuit refusal,
 * both ca-read catches, the query-scope outer catch) the outer catch
 * re-invoked the app callback a SECOND time with its own exception before the
 * throw surfaced at the caller.
 *
 * Post-fix: every bare delivery is wrapped try/catch → the shared
 * _ownSyncCbThrow helper — same exception shape as the sync-delivery catches,
 * a distinct marker, flat 500 via self.throwError (the #ERRREF ref + pairing
 * line are minted inside throwError itself, so callers carry no obligation).
 *
 * §01 pins the source structure; §02 drives the REAL module
 * (createTestInstance + real query() + dead local ports — no replica of live
 * code; the single pre-fix SUBTRACT is a frozen replica of the RETIRED shape,
 * kept as executable documentation of the double-invoke cascade).
 *
 * §40a/§40b (controller.test.js) own the async-guard pins (the direct-site
 * wrap count and the sync-catch census) — deliberately NOT duplicated here.
 * The census here is 17 since #B489: the 14 formerly-bare #B402 deliveries,
 * the #B479 nested-render refusal at the top of query(), and the two #B489
 * raw-body refusals (BODY_TYPE, BODY_AND_DATA) — all born wrapped.
 */

'use strict';

var assert = require('node:assert');
var { describe, it, before } = require('node:test');
var fs   = require('fs');
var path = require('path');
var net  = require('net');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

var SYNC_MARK  = 'Controller Query Exception on transport-error callback throw.';
var ASYNC_MARK = 'Controller Query Exception on async callback rejection.';

function countOf(hay, needle) { return hay.split(needle).length - 1; }

describe('01 - #B402 source pins: one sync-throw helper, 18 wrapped error-path deliveries (14 #B402 + the #B479 refusal + the 2 #B489 body refusals + the #B612 pre-send session-gone terminal)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    it('exactly ONE helper, defined between the async guard and this.query', function() {
        var DEF = 'var _ownSyncCbThrow = function(syncErr)';
        assert.equal(countOf(src, DEF), 1, 'a single shared definition');
        var asyncDef = src.indexOf('var _ownAsyncCbRejection = function(result)');
        var queryDef = src.indexOf('this.query = function(options, data, callback)');
        var d = src.indexOf(DEF);
        assert.ok(asyncDef > -1 && queryDef > -1, 'both neighbour anchors must exist');
        assert.ok(d > asyncDef && d < queryDef,
            'constructor scope, below the async guard and above this.query so every delivery site reaches it');
        var body = src.slice(d, src.indexOf('};', d));
        assert.ok(body.indexOf(SYNC_MARK) > -1, 'the distinct marker lives in the helper');
        assert.ok(body.indexOf('exception.status = 500;') > -1, 'flat 500');
        assert.ok(body.indexOf('return self.throwError(exception);') > -1, 'routes to throwError (ref + pairing line minted there)');
    });

    it('the sync-throw marker appears exactly once file-wide (helper only)', function() {
        assert.equal(countOf(src, SYNC_MARK), 1);
    });

    it('exact census: 18 sync-throw catches, each routing to the helper', function() {
        assert.equal(countOf(src, 'catch (_syncCbErr)'), 18,
            'the 14 formerly-bare error-path deliveries + the #B479 nested-render refusal + the 2 #B489 body refusals + the #B612 session-gone terminal (a synchronous client.request() throw in _sendRequest) — a count landing HIGH means an un-enumerated new delivery site: classify it before touching this pin');
        assert.equal(countOf(src, '_ownSyncCbThrow(_syncCbErr);'), 18,
            'every catch routes to the shared helper');
    });

    it('each catch pairs with a try wrapping an app-callback delivery (structural, 18/18)', function() {
        var from = 0, verified = 0;
        for (;;) {
            var c = src.indexOf('catch (_syncCbErr)', from);
            if (c === -1) { break; }
            var t = src.lastIndexOf('try {', c);
            assert.ok(t > -1, 'a try must open before catch #' + (verified + 1));
            assert.ok(src.slice(t, c).indexOf('_ownAsyncCbRejection(callback(') > -1,
                'the try body must contain the wrapped direct delivery (catch #' + (verified + 1) + ')');
            verified++;
            from = c + 1;
        }
        assert.equal(verified, 18, 'all 18 catches verified structurally');
    });
});

describe('02 - #B402 behavioral: real bytes, dead-port transport-error deliveries', function() {

    before(function() {
        setContext('bundle', 'tb42');
        setContext('env', 'dev');
        setContext('gina', {
            ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
            config: { envConf: { tb42: { dev: {
                server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65530 },
                host: '127.0.0.1', hostname: 'http://127.0.0.1:65530'
            } } } }
        });
    });

    function makeInst() {
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r42', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
            res: { setHeader: function(){}, end: function(){}, writeHead: function(){}, getHeaders: function(){ return {}; }, statusCode: 200 },
            options: {
                conf: {
                    bundle: 'tb42', encoding: 'utf-8',
                    server: { protocol: 'http/1.1', scheme: 'http',
                              coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                              supportedRequestMethods: { get: 1 } },
                    content: { routing: { r42: {} } }
                },
                rule: 'r42', control: 'act', bundle: 'tb42', controller: '/controllers/t42.js'
            }
        });
        inst.serverInstance = { _cached: new Map(), _cachePath: '/tmp/gina-t42', _cacheIsEnabled: 'false', _http2Sessions: [] };
        var thrown = [];
        inst.throwError = function() {
            var a = arguments[0];
            thrown.push({ msg: String((a && (a.message || a.msg)) || a), status: a && a.status });
        };
        return { inst: inst, thrown: thrown };
    }

    // Same deterministic teardown as §40b — the framework caches the HTTP/2
    // client session and node 22 does not reap lingering handles.
    function destroy(h) {
        try { h.inst.serverInstance._cached.forEach(function(v) { if (v && typeof v.destroy === 'function') { v.destroy(); } }); } catch (e) {}
        try { (h.inst.serverInstance._http2Sessions || []).forEach(function(s) { if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
    }

    function marked(thrown, mark) {
        return thrown.filter(function(t) { return t.msg.indexOf(mark) > -1; });
    }
    function hold(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
    function waitFor(fn, cap) {
        return new Promise(function(resolve, reject) {
            var t0 = Date.now();
            (function poll() {
                if (fn()) { return resolve(); }
                if (Date.now() - t0 > cap) { return reject(new Error('waitFor timeout')); }
                setTimeout(poll, 15);
            })();
        });
    }
    function freePort() {
        return new Promise(function(resolve) {
            var srv = net.createServer();
            srv.listen(0, '127.0.0.1', function() {
                var p = srv.address().port;
                srv.close(function() { resolve(p); });
            });
        });
    }
    function h1Opts(P, extra) {
        var o = { protocol: 'http/1.1', scheme: 'http', host: '127.0.0.1', port: P, path: '/x', method: 'GET', requestTimeout: '2s', maxRetry: 0, headers: { 'content-type': 'application/json' } };
        for (var k in extra) { o[k] = extra[k]; }
        return o;
    }

    it('HTTP/1.1: a sync callback throw on the request-error delivery is owned — throwError(500) with the sync marker, callback exactly once, nothing escapes', async function() {
        var P = await freePort();
        var h = makeInst(), calls = 0;
        h.inst.query(h1Opts(P), {}, function() { calls++; throw new Error('b402-h1-sync-boom'); });
        await waitFor(function() { return marked(h.thrown, SYNC_MARK).length; }, 3000);
        await hold(150); // double-settle grace window
        var m = marked(h.thrown, SYNC_MARK);
        assert.equal(m.length, 1, 'exactly one owned 500 (pre-fix measured: 0 + a process-level uncaughtException)');
        assert.equal(m[0].status, 500);
        assert.match(m[0].msg, /b402-h1-sync-boom/);
        assert.equal(calls, 1, 'the app callback ran exactly once');
        destroy(h);
    });

    it('HTTP/2.0: a sync callback throw on the typed transport-error delivery is owned (assertions FILTER by marker — the h2 session error path may issue its own throwError)', async function() {
        var P = await freePort();
        var h = makeInst(), calls = 0;
        h.inst.query({ protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + P, host: '127.0.0.1', port: P, path: '/x', method: 'GET', requestTimeout: '2s', headers: { 'content-type': 'application/json' } }, {}, function() { calls++; throw new Error('b402-h2-sync-boom'); });
        await waitFor(function() { return marked(h.thrown, SYNC_MARK).length; }, 3000);
        await hold(150);
        var m = marked(h.thrown, SYNC_MARK);
        assert.equal(m.length, 1, 'exactly one owned 500 through the sync guard');
        assert.equal(m[0].status, 500);
        assert.match(m[0].msg, /b402-h2-sync-boom/);
        assert.equal(calls, 1);
        destroy(h);
    });

    it('host-missing (caller-frame delivery): owned at the site — no throw reaches the query() caller', function() {
        var h = makeInst(), calls = 0, escaped = null;
        try {
            h.inst.query({ protocol: 'http/1.1', scheme: 'http', path: '/x', method: 'GET', headers: { 'content-type': 'application/json' } }, {}, function() { calls++; throw new Error('b402-hm-boom'); });
        } catch (e) { escaped = e; }
        assert.equal(escaped, null, 'pre-fix the throw propagated into the calling frame');
        assert.equal(calls, 1);
        var m = marked(h.thrown, SYNC_MARK);
        assert.equal(m.length, 1);
        assert.equal(m[0].status, 500);
    });

    it('ca-read failure (caller-frame delivery inside the query try): callback invoked ONCE — the outer-catch double-invoke is retired', function() {
        var h = makeInst(), got = [], escaped = null;
        try {
            h.inst.query(h1Opts(65530, { scheme: 'https', ca: '/nonexistent-b402-pin.pem' }), {}, function(err) { got.push(err && err.code); throw new Error('b402-ca-boom'); });
        } catch (e) { escaped = e; }
        assert.equal(escaped, null, 'nothing escapes to the caller');
        assert.deepStrictEqual(got, ['ENOENT'], 'one invocation, with the real transport error — pre-fix the callback ran a second time carrying its own exception');
        var m = marked(h.thrown, SYNC_MARK);
        assert.equal(m.length, 1);
        assert.equal(m[0].status, 500);
    });

    it('guard silence: a clean callback on the same delivery produces no sync-marker throwError', async function() {
        var P = await freePort();
        var h = makeInst(), got = [];
        h.inst.query(h1Opts(P), {}, function(err) { got.push(err && err.code); });
        await waitFor(function() { return got.length; }, 3000);
        await hold(150);
        assert.deepStrictEqual(got, ['ECONNREFUSED']);
        assert.equal(marked(h.thrown, SYNC_MARK).length, 0, 'the guard must stay silent when the callback does not throw');
        destroy(h);
    });

    it('composition: an async-throwing callback on the error path stays owned by the ASYNC guard — distinct markers, no overlap', async function() {
        var P = await freePort();
        var h = makeInst();
        h.inst.query(h1Opts(P), {}, async function() { throw new Error('b402-async-comp'); });
        await waitFor(function() { return marked(h.thrown, ASYNC_MARK).length; }, 3000);
        await hold(150);
        assert.equal(marked(h.thrown, ASYNC_MARK).length, 1, 'the async rejection routes through the async guard');
        assert.equal(marked(h.thrown, SYNC_MARK).length, 0, 'the sync guard must not double-own a rejection');
        destroy(h);
    });

    it('frozen pre-fix SUBTRACT: the retired bare-delivery shape double-invokes the callback and escapes to the caller', function() {
        // Replica of the RETIRED control flow (not of live code): an inner
        // error-path catch delivered bare inside the query-scope try, whose
        // outer catch re-delivered bare. Kept as executable documentation of
        // the measured cascade: cb(#1 transport error) → throw → outer catch →
        // cb(#2 the callback's own exception) → throw → caller.
        var calls = 0, seen = [];
        function appCallback(err) { calls++; seen.push(err && (err.code || err.message)); throw new Error('subtract-boom-' + calls); }
        function preFixShape() {
            try {
                try {
                    var enoent = new Error('ENOENT: simulated read failure');
                    enoent.code = 'ENOENT';
                    throw enoent;
                } catch (err) {
                    return appCallback(err); // pre-fix: bare delivery
                }
            } catch (err) {
                return appCallback(err); // pre-fix: outer catch re-delivery
            }
        }
        assert.throws(preFixShape, /subtract-boom-2/, 'the second throw escaped to the caller');
        assert.equal(calls, 2, 'the app callback ran twice for one failure');
        assert.deepStrictEqual(seen, ['ENOENT', 'subtract-boom-1'],
            'invocation #2 carried the callback\'s own exception as the "query error"');
    });
});
