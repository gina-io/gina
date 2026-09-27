'use strict';
/**
 * #P46 S6 B — the warm route cache as one Map.
 *
 * `lib/routing` keeps a per-process cache of matched routes keyed `METHOD:pathname`
 * (`cache()` / `getCached()` / `invalidateCached()`). Before S6 B it was an array of
 * keys searched with `indexOf` beside a keyed object, evicted with `splice(0, 1)` —
 * O(n) per lookup and per eviction at the 5,000-entry cap — and every entry also
 * kept the `params` and `methodParams` of the request that first matched: fields
 * nothing reads, the second being that request's data bag (a POST body included).
 *
 * Suites:
 *  01 — the cache contract, on fresh instances of the REAL module (it holds before
 *       and after the rewrite): a miss is exactly `null`; the first write to a key
 *       wins; FIFO eviction at 5,000; a hit does not protect an entry (FIFO, not
 *       LRU); `invalidateCached` removes a key and frees its slot, and is a no-op on
 *       a missing one
 *  02 — retention (node only): a cached entry no longer keeps the request's
 *       `params` / `methodParams` alive — a child `node --expose-gc` reads WeakRefs,
 *       with a must-collect control and a must-retain control
 *  03 — source pins: the dead trie and the array bookkeeping are gone from the live
 *       code, the cache is a Map, and `radix.js` no longer ships
 */
var { describe, it } = require('node:test');
var assert       = require('node:assert/strict');
var path         = require('path');
var fs           = require('fs');
var Module       = require('module');
var childProcess = require('child_process');

var FW = require('../fw');

var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var SERVER_SRC  = path.join(FW, 'core/server.js');
var RADIX_SRC   = path.join(FW, 'lib/routing/src/radix.js');
var MAX         = 5000;   // MAX_CACHED_ROUTES in lib/routing/src/main.js
var IS_BUN      = typeof Bun !== 'undefined';

// -- the #B215 matcher-standalone harness (as in server-route-cache-verdict §02) ---
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module._initPaths();
require(path.join(FW, 'helpers'));                              // _, setPath, setContext, ...
require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));   // JSON.clone, Object.count()
process.gina = process.gina || {};
setPath('gina', { core: path.join(FW, 'core') });
setContext('isProxyHost', false);
setContext('gina', { config: {
    env: 'dev', bundle: 'test', envConf: {},
    getRouting: function () { return {}; }
} });

/**
 * A fresh, independent instance of the real module: the `Routing` constructor is
 * re-created by the compile, so its cache statics start empty. Never registered in
 * the require cache (the #B537 subtract pattern).
 */
function freshRouting() {
    var m = new Module(ROUTING_SRC, module);
    m.filename = ROUTING_SRC;
    m.paths    = Module._nodeModulePaths(path.dirname(ROUTING_SRC));
    m._compile(fs.readFileSync(ROUTING_SRC, 'utf8'), ROUTING_SRC);
    return m.exports;
}

function route(n, control) {
    return { url: '/k/' + n, method: 'GET', bundle: 'test', namespace: 'test',
             param: { control: control || ('c' + n) } };
}

/** isaac-shaped request: url already query-stripped. */
function mkReq(pathname) {
    return { url: pathname, method: 'GET', headers: {}, routing: {}, params: { 0: pathname }, get: {} };
}

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// ─── 01 — the contract ───────────────────────────────────────────────────────

describe('01 - the warm route cache contract (real module, fresh instance per test)', function () {

    it('01.1  a miss returns exactly null, synchronously, without running compareUrls', function () {
        var r   = freshRouting();
        var req = mkReq('/nope');
        assert.equal(r.getCached('GET:/nope', req), null);
        assert.equal(typeof req.routing.param, 'undefined');
    });

    it('01.2  a hit resolves through compareUrls against the cached rule', async function () {
        var r = freshRouting();
        r.cache('GET:/k/1', 'one@test', route(1), {}, {});
        var req   = mkReq('/k/1');
        var found = await r.getCached('GET:/k/1', req);
        assert.ok(found && found.past === true, 'an accepting hit');
        assert.equal(req.routing.param.control, 'c1');
    });

    it('01.3  the first write to a key wins — a second cache() for the same key is a no-op', async function () {
        var r = freshRouting();
        r.cache('GET:/k/1', 'first@test',  route(1),          {}, {});
        r.cache('GET:/k/1', 'second@test', route(1, 'other'), {}, {});
        var req   = mkReq('/k/1');
        var found = await r.getCached('GET:/k/1', req);
        assert.ok(found && found.past === true);
        assert.equal(req.routing.param.control, 'c1', 'the entry is still the first rule cached');
    });

    it('01.4  at 5,000 entries the OLDEST key is evicted first', async function () {
        var r = freshRouting();
        var i;
        for (i = 0; i < MAX; i++) { r.cache('GET:/k/' + i, 'r' + i + '@test', route(i), {}, {}); }
        var first = r.getCached('GET:/k/0', mkReq('/k/0'));
        assert.notEqual(first, null, 'every key is present at exactly the cap');
        await first;
        r.cache('GET:/k/' + MAX, 'r' + MAX + '@test', route(MAX), {}, {});
        assert.equal(r.getCached('GET:/k/0', mkReq('/k/0')), null, 'the oldest key is evicted');
        var second = r.getCached('GET:/k/1', mkReq('/k/1'));
        assert.notEqual(second, null, 'the second-oldest key stays');
        await second;
        var newest = r.getCached('GET:/k/' + MAX, mkReq('/k/' + MAX));
        assert.notEqual(newest, null, 'the new key is in');
        await newest;
    });

    it('01.5  a hit does not protect an entry: eviction is FIFO, not LRU', async function () {
        var r = freshRouting();
        var i;
        for (i = 0; i < MAX; i++) { r.cache('GET:/k/' + i, 'r' + i + '@test', route(i), {}, {}); }
        await r.getCached('GET:/k/0', mkReq('/k/0'));           // a hit on the oldest
        r.cache('GET:/k/' + MAX, 'r' + MAX + '@test', route(MAX), {}, {});
        assert.equal(r.getCached('GET:/k/0', mkReq('/k/0')), null, 'still the first out');
        var kept = r.getCached('GET:/k/1', mkReq('/k/1'));
        assert.notEqual(kept, null, 'an LRU would have evicted this one instead');
        await kept;
    });

    it('01.6  invalidateCached removes a key, frees its slot, and is a no-op on a missing key', async function () {
        var r = freshRouting();
        var i;
        for (i = 0; i < MAX; i++) { r.cache('GET:/k/' + i, 'r' + i + '@test', route(i), {}, {}); }
        r.invalidateCached('GET:/k/7');
        assert.equal(r.getCached('GET:/k/7', mkReq('/k/7')), null, 'removed');
        r.cache('GET:/k/' + MAX, 'r' + MAX + '@test', route(MAX), {}, {});
        var oldest = r.getCached('GET:/k/0', mkReq('/k/0'));
        assert.notEqual(oldest, null, 'the freed slot absorbed the insert: nothing was evicted');
        await oldest;
        assert.doesNotThrow(function () { r.invalidateCached('GET:/never-cached'); });
    });
});

// ─── 02 — retention (node only) ──────────────────────────────────────────────

describe('02 - a cached entry does not keep the request data alive', { skip: IS_BUN ? 'node-only: reads WeakRefs after a forced GC through --expose-gc' : false }, function () {

    it('02.1  params and methodParams are collectable once the request is gone (controls fire)', function () {
        var child = [
            "var path = require('path'), Module = require('module');",
            "var FW = " + JSON.stringify(FW) + ";",
            "process.env.NODE_PATH = FW; Module._initPaths();",
            "require(path.join(FW, 'helpers'));",
            "require(path.resolve(FW, '..', '..', 'utils', 'prototypes'));",
            "process.gina = {}; setPath('gina', { core: path.join(FW, 'core') });",
            "setContext('isProxyHost', false);",
            "setContext('gina', { config: { env: 'dev', bundle: 'test', envConf: {}, getRouting: function () { return {}; } } });",
            "var r = require(path.join(FW, 'lib/routing/src/main.js'));",
            "var refs = {};",
            "(function () {",
            "  var params = { big: new Array(100000).fill('p') };",
            "  var body   = { big: new Array(100000).fill('b') };",
            "  var free   = { big: new Array(100000).fill('f') };",
            "  globalThis.__keep = { big: new Array(100000).fill('k') };",
            "  refs.params = new WeakRef(params); refs.body = new WeakRef(body);",
            "  refs.free = new WeakRef(free); refs.keep = new WeakRef(globalThis.__keep);",
            "  r.cache('GET:/k/1', 'one@test', { url: '/k/1', method: 'GET', bundle: 'test', namespace: 'test', param: { control: 'c1' } }, params, body);",
            "})();",
            "setTimeout(function () { global.gc(); setTimeout(function () { global.gc();",
            "  process.stdout.write(JSON.stringify({ params: !refs.params.deref(), body: !refs.body.deref(), free: !refs.free.deref(), keep: !refs.keep.deref() }));",
            "}, 20); }, 20);"
        ].join('\n');
        var res = childProcess.spawnSync(process.execPath, ['--expose-gc', '-e', child], { encoding: 'utf8', timeout: 60000 });
        assert.equal(res.status, 0, 'child failed: ' + (res.stderr || '').slice(0, 600));
        var out = JSON.parse(res.stdout.trim().split('\n').pop());
        assert.equal(out.free, true,  'control: an unreferenced object IS collected — the instrument can see a collection');
        assert.equal(out.keep, false, 'control: a still-referenced object is NOT collected — the instrument can see a retention');
        assert.equal(out.params, true, 'the entry must not keep the request params alive');
        assert.equal(out.body,   true, 'the entry must not keep the request data bag (methodParams) alive');
    });
});

// ─── 03 — source pins ────────────────────────────────────────────────────────

describe('03 - source: one Map, no dead trie, no array bookkeeping', function () {
    var live = stripComments(fs.readFileSync(ROUTING_SRC, 'utf8'));
    var srv  = stripComments(fs.readFileSync(SERVER_SRC, 'utf8'));

    it('03.0  control: the stripped routing source still carries the cache API', function () {
        assert.ok(live.indexOf('self.cache = function') > -1);
        assert.ok(live.indexOf('self.getCached = function') > -1);
        assert.ok(live.indexOf('self.invalidateCached = function') > -1);
    });

    it('03.1  the cache is one Map', function () {
        assert.match(live, /Routing\._cached\s*=\s*new Map\(\)/);
        assert.equal(live.indexOf('_cachedRoutes'), -1, 'no second, keyed store');
        assert.equal(live.indexOf('Routing._cached.indexOf('), -1, 'no linear key scan');
    });

    it('03.2  the dead trie is gone from lib/routing and from server.js', function () {
        assert.equal(live.indexOf('buildTrie'), -1);
        assert.equal(live.indexOf('lookupTrie'), -1);
        assert.equal(live.indexOf('_tries'), -1);
        assert.equal(srv.indexOf('routingLib.buildTrie('), -1);
    });

    it('03.3  radix.js no longer ships', function () {
        assert.equal(fs.existsSync(RADIX_SRC), false);
    });
});
