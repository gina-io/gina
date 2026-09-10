var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.join(require('../fw'), 'core/router.js');


// Replica of resolveRouteConfig from router.js for isolated logic testing (#P25).
// In production, router.js uses module-level Config and merge.
// Here _Config and _merge are injected to avoid framework dependencies.
function resolveRouteConfig(serverInstance, params, response, controllerFile, local, _Config, _merge) {
    try {
        var config = new _Config().getInstance();
        if (!params.bundle) {
            try {
                //params.bundle = config.bundle;
                //params.param = config.routing[config.reverseRouting[params.param.url]];
                var _rule = config.reverseRouting[params.param.url];
                params = _merge(params, config.routing[_rule]);
                params.rule = _rule;
            } catch(reverseRoutingError) {
                serverInstance.throwError(response, 500, reverseRoutingError);
                return null;
            }
        }
        var bundle = params.bundle;
        local.bundle = bundle;
        return {
            config  : config,
            bundle  : bundle,
            env     : config.env,
            scope   : config.scope,
            conf    : config[bundle][config.env],
            params  : params
        };
    } catch (configErr) {
        serverInstance.throwError(response, 500, new Error('syntax error(s) found in `'+ controllerFile +'` \nTrace: ') + (configErr.stack || configErr.message));
        return null;
    }
}

function stubMerge(a, b) {
    if (!b) return a;
    var r = {}, k;
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) r[k] = a[k];
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) r[k] = b[k];
    return r;
}


// 01 — resolveRouteConfig: happy path with params.bundle pre-set
describe('01 - resolveRouteConfig: happy path with params.bundle pre-set', function() {

    function makeSetup() {
        var config = {
            env: 'dev',
            scope: 'local',
            myapp: { dev: { template: true, bundlesPath: '/app/bundles' } }
        };
        return {
            config      : config,
            Config      : function() { this.getInstance = function() { return config; }; },
            serverInstance  : { throwError: function() { assert.fail('throwError must not be called on happy path'); } },
            response    : {},
            local       : {},
            params      : { bundle: 'myapp', param: { control: 'home' }, middleware: [] }
        };
    }

    it('returns a non-null object', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.notEqual(result, null);
        assert.equal(typeof result, 'object');
    });

    it('result.bundle equals params.bundle', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(result.bundle, 'myapp');
    });

    it('result.env and result.scope come from config', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(result.env, 'dev');
        assert.equal(result.scope, 'local');
    });

    it('result.conf is config[bundle][env]', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.strictEqual(result.conf, s.config['myapp']['dev']);
    });

    it('sets local.bundle to params.bundle', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(s.local.bundle, 'myapp');
    });

    it('result.config is the instance returned by Config().getInstance()', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.strictEqual(result.config, s.config);
    });

});


// 02 — resolveRouteConfig: reverseRouting resolution when params.bundle not set
describe('02 - resolveRouteConfig: reverseRouting resolution when params.bundle not set', function() {

    function makeSetup() {
        var config = {
            env: 'dev',
            scope: 'local',
            reverseRouting: { '/home': 'home@myapp' },
            routing: { 'home@myapp': { bundle: 'myapp', param: { control: 'home' } } },
            myapp: { dev: { template: true, bundlesPath: '/app/bundles' } }
        };
        return {
            config      : config,
            Config      : function() { this.getInstance = function() { return config; }; },
            serverInstance  : { throwError: function() { assert.fail('throwError must not be called on happy path'); } },
            response    : {},
            local       : {},
            params      : { param: { url: '/home', control: null }, middleware: [] }  // no bundle
        };
    }

    it('returns a non-null object', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.notEqual(result, null);
    });

    it('resolves bundle from reverseRouting', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(result.bundle, 'myapp');
    });

    it('sets result.params.rule to the resolved rule', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(result.params.rule, 'home@myapp');
    });

    it('sets local.bundle to the resolved bundle', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(s.local.bundle, 'myapp');
    });

});


// 03 — resolveRouteConfig: inner catch — reverseRoutingError
describe('03 - resolveRouteConfig: inner catch — reverseRoutingError', function() {

    function makeSetup() {
        var config = {
            env: 'dev',
            scope: 'local',
            reverseRouting: null    // null[url] throws TypeError → triggers inner catch
        };
        var calls = [];
        return {
            Config      : function() { this.getInstance = function() { return config; }; },
            serverInstance  : { throwError: function(res, status, err) { calls.push({ status: status, err: err }); } },
            response    : {},
            local       : {},
            params      : { param: { url: '/home' }, middleware: [] },  // no bundle
            calls       : calls
        };
    }

    it('returns null', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(result, null);
    });

    it('calls serverInstance.throwError once', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(s.calls.length, 1);
    });

    it('calls throwError with status 500', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.equal(s.calls[0].status, 500);
    });

    it('passes the caught error to throwError', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, undefined, s.local, s.Config, stubMerge);
        assert.ok(s.calls[0].err instanceof TypeError, 'expected TypeError from null[url]');
    });

});


// 04 — resolveRouteConfig: outer catch — configErr
describe('04 - resolveRouteConfig: outer catch — configErr', function() {

    function makeSetup() {
        var calls = [];
        return {
            Config      : function() { this.getInstance = function() { throw new Error('Config init failed'); }; },
            serverInstance  : { throwError: function(res, status) { calls.push({ status: status }); } },
            response    : {},
            local       : {},
            params      : { bundle: 'myapp', param: {}, middleware: [] },
            calls       : calls
        };
    }

    it('returns null on configErr', function() {
        var s = makeSetup();
        var result = resolveRouteConfig(s.serverInstance, s.params, s.response, 'controller.js', s.local, s.Config, stubMerge);
        assert.equal(result, null);
    });

    it('calls serverInstance.throwError once', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, 'controller.js', s.local, s.Config, stubMerge);
        assert.equal(s.calls.length, 1);
    });

    it('calls throwError with status 500', function() {
        var s = makeSetup();
        resolveRouteConfig(s.serverInstance, s.params, s.response, 'controller.js', s.local, s.Config, stubMerge);
        assert.equal(s.calls[0].status, 500);
    });

});


// Replica of the async dispatch guard introduced in Stream A (0.3.0).
// controller[action]() return value is inspected; if thenable, .catch() is attached.
function dispatchAction(serverInstance, controller, action, request, response, next) {
    var _result = controller[action](request, response, next);
    if (_result && typeof _result.then === 'function') {
        return _result.catch(function(err) {
            serverInstance.throwError(response, 500, err.stack || err.message || String(err));
        });
    }
}


// 05 — source structure: resolveRouteConfig extracted to module level (#P25)
describe('05 - source structure: resolveRouteConfig extracted to module level (#P25)', function() {

    it('function resolveRouteConfig is declared in source', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('function resolveRouteConfig(') > -1,
            'expected `function resolveRouteConfig(` — #P25 extraction not applied'
        );
    });

    it('resolveRouteConfig is declared before function Router (module-level, not inside route)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var fnPos     = src.indexOf('function resolveRouteConfig(');
        var routerPos = src.indexOf('function Router(');
        assert.ok(fnPos > -1,     'function resolveRouteConfig not found');
        assert.ok(routerPos > -1, 'function Router not found');
        assert.ok(
            fnPos < routerPos,
            'resolveRouteConfig must appear before function Router — must be module-level, not nested inside route()'
        );
    });

    it('route() delegates to resolveRouteConfig()', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('resolveRouteConfig(serverInstance,') > -1,
            'route() must call resolveRouteConfig(serverInstance, ...) — #P25 delegation missing'
        );
    });

    it('source contains #P25 replaced comment', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('#P25') > -1,
            'expected #P25 marker in replaced comment — comment convention not applied'
        );
    });

});


// 06 — source structure: async dispatch guard (Stream A, 0.3.0)
describe('06 - source structure: async dispatch guard', function() {

    it('source captures return value of controller[action]()', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('var _result = controller[action](') > -1,
            'expected `var _result = controller[action](` — async capture not applied'
        );
    });

    it('source checks _result is thenable before attaching catch', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("typeof _result.then === 'function'") > -1,
            "expected `typeof _result.then === 'function'` — thenable guard missing"
        );
    });

    it('source attaches _result.catch to route rejected promises to throwError', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('_result.catch(function(err)') > -1,
            'expected `_result.catch(function(err)` — rejection handler missing'
        );
    });

    it('source passes err.stack || err.message || String(err) to throwError', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('err.stack || err.message || String(err)') > -1,
            'expected `err.stack || err.message || String(err)` — error serialization missing'
        );
    });

    it('async guard is applied at both dispatch sites (with and without middleware)', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var first  = src.indexOf('var _result = controller[action](');
        var second = src.indexOf('var _result = controller[action](', first + 1);
        assert.ok(first > -1 && second > -1, 'expected two dispatch sites to capture _result — only one found');
    });

});


// 07 — dispatchAction pure logic
describe('07 - dispatchAction: pure dispatch logic', function() {

    function makeServerInstance() {
        var calls = [];
        return {
            throwError: function(res, status, msg) { calls.push({ status: status, msg: msg }); },
            calls: calls
        };
    }

    it('sync action: no .then check, throwError never called', function() {
        var si = makeServerInstance();
        var ctrl = { home: function() { return undefined; } };
        dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        assert.equal(si.calls.length, 0);
    });

    it('sync action returning null: throwError never called', function() {
        var si = makeServerInstance();
        var ctrl = { home: function() { return null; } };
        dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        assert.equal(si.calls.length, 0);
    });

    it('sync action returning plain object (no .then): throwError never called', function() {
        var si = makeServerInstance();
        var ctrl = { home: function() { return { data: 1 }; } };
        dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        assert.equal(si.calls.length, 0);
    });

    it('async action that resolves: throwError never called', function() {
        var si = makeServerInstance();
        var ctrl = { home: async function() { return 'ok'; } };
        var p = dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        return p.then(function() {
            assert.equal(si.calls.length, 0);
        });
    });

    it('async action that rejects with stack: throwError called with err.stack', function() {
        var si = makeServerInstance();
        var err = new Error('boom');
        var ctrl = { home: async function() { throw err; } };
        var p = dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        return p.then(function() {
            assert.equal(si.calls.length, 1);
            assert.equal(si.calls[0].status, 500);
            assert.equal(si.calls[0].msg, err.stack);
        });
    });

    it('async action rejecting with no stack: throwError called with err.message', function() {
        var si = makeServerInstance();
        var err = { message: 'no stack here' };
        var ctrl = { home: function() { return Promise.reject(err); } };
        var p = dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        return p.then(function() {
            assert.equal(si.calls.length, 1);
            assert.equal(si.calls[0].msg, 'no stack here');
        });
    });

    it('async action rejecting with string (no stack, no message): throwError called with String(err)', function() {
        var si = makeServerInstance();
        var ctrl = { home: function() { return Promise.reject('plain string error'); } };
        var p = dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        return p.then(function() {
            assert.equal(si.calls.length, 1);
            assert.equal(si.calls[0].msg, 'plain string error');
        });
    });

    it('action with .then that is not a function: treated as sync, no attach', function() {
        var si = makeServerInstance();
        var ctrl = { home: function() { return { then: 'not-a-function' }; } };
        dispatchAction(si, ctrl, 'home', {}, {}, function(){});
        assert.equal(si.calls.length, 0);
    });

    it('async action receives req, res, next forwarded from router', function() {
        var si = makeServerInstance();
        var received = {};
        var req = { id: 'req' }, res = { id: 'res' }, next = function(){};
        var ctrl = {
            home: async function(r, s, n) {
                received.req = r; received.res = s; received.next = n;
            }
        };
        var p = dispatchAction(si, ctrl, 'home', req, res, next);
        return p.then(function() {
            assert.strictEqual(received.req, req);
            assert.strictEqual(received.res, res);
            assert.strictEqual(received.next, next);
        });
    });

});


// 08 — source structure: hot-reload dirty-flag guards (#M6)
describe('08 - source structure: hot-reload dirty-flag guards (#M6)', function() {

    it('source contains #M6 marker', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(src.indexOf('#M6') > -1, 'expected #M6 marker — hot-reload not applied');
    });

    it('refreshCoreDependencies reads __hotReload from context', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf("getContext('__hotReload')") > -1,
            "expected getContext('__hotReload') in source"
        );
    });

    it('refreshCoreDependencies early-returns when core flag is false', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('if (_hotReload && !_hotReload.core) return;') > -1,
            'expected `if (_hotReload && !_hotReload.core) return;` guard in refreshCoreDependencies'
        );
    });

    it('refreshCoreDependencies clears core flag after eviction', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('_hotReload.core = false;') > -1,
            'expected `_hotReload.core = false;` reset after core eviction'
        );
    });

    it('per-action block guards eviction behind !_hotReload || _hotReload.action', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('if (!_hotReload || _hotReload.action) {') > -1,
            'expected `if (!_hotReload || _hotReload.action) {` guard in per-action block'
        );
    });

    it('per-action block clears action flag after eviction', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        assert.ok(
            src.indexOf('_hotReload.action = false;') > -1,
            'expected `_hotReload.action = false;` reset after action eviction'
        );
    });

    it('getContext(__hotReload) appears at both eviction sites', function() {
        var src = fs.readFileSync(SOURCE, 'utf8');
        var first  = src.indexOf("getContext('__hotReload')");
        var second = src.indexOf("getContext('__hotReload')", first + 1);
        assert.ok(
            first > -1 && second > -1,
            'expected getContext(__hotReload) at two eviction sites — only one found'
        );
    });

});


// Replica of refreshCoreDependencies dirty-flag logic for isolated testing (#M6).
// cache, evicted, and hotReload are injected to avoid framework dependencies.
function refreshCoreLogic(hotReload, cache, evictFn) {
    if (hotReload && !hotReload.core) return false; // skipped
    evictFn(cache);
    if (hotReload) hotReload.core = false;
    return true; // evicted
}

// Replica of per-action cache-bust dirty-flag logic (#M6).
function actionCacheLogic(isCacheless, hotReload, evictFn) {
    if (!isCacheless) return false; // not in dev mode
    if (!hotReload || hotReload.action) {
        evictFn();
        if (hotReload) hotReload.action = false;
        return true; // evicted
    }
    return false; // skipped
}


// 09 — hot-reload dirty-flag pure logic (#M6)
describe('09 - hot-reload dirty-flag logic (#M6)', function() {

    // refreshCoreLogic tests
    it('core: skips eviction when watcher running and core flag is false', function() {
        var hotReload = { core: false, action: false };
        var evicted = false;
        var result = refreshCoreLogic(hotReload, {}, function() { evicted = true; });
        assert.equal(result, false);
        assert.equal(evicted, false);
    });

    it('core: evicts when watcher running and core flag is true', function() {
        var hotReload = { core: true, action: false };
        var evicted = false;
        var result = refreshCoreLogic(hotReload, {}, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('core: clears core flag to false after eviction', function() {
        var hotReload = { core: true, action: false };
        refreshCoreLogic(hotReload, {}, function() {});
        assert.equal(hotReload.core, false);
    });

    it('core: falls back to always-evict when __hotReload is null (no watcher)', function() {
        var evicted = false;
        var result = refreshCoreLogic(null, {}, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('core: falls back to always-evict when __hotReload is undefined', function() {
        var evicted = false;
        var result = refreshCoreLogic(undefined, {}, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('core: does not attempt to clear flag when hotReload is null', function() {
        // must not throw
        assert.doesNotThrow(function() {
            refreshCoreLogic(null, {}, function() {});
        });
    });

    // actionCacheLogic tests
    it('action: skips eviction when isCacheless is false', function() {
        var hotReload = { core: false, action: true };
        var evicted = false;
        var result = actionCacheLogic(false, hotReload, function() { evicted = true; });
        assert.equal(result, false);
        assert.equal(evicted, false);
    });

    it('action: skips eviction when watcher running and action flag is false', function() {
        var hotReload = { core: false, action: false };
        var evicted = false;
        var result = actionCacheLogic(true, hotReload, function() { evicted = true; });
        assert.equal(result, false);
        assert.equal(evicted, false);
    });

    it('action: evicts when watcher running and action flag is true', function() {
        var hotReload = { core: false, action: true };
        var evicted = false;
        var result = actionCacheLogic(true, hotReload, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('action: clears action flag to false after eviction', function() {
        var hotReload = { core: false, action: true };
        actionCacheLogic(true, hotReload, function() {});
        assert.equal(hotReload.action, false);
    });

    it('action: falls back to always-evict when __hotReload is null (no watcher)', function() {
        var evicted = false;
        var result = actionCacheLogic(true, null, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('action: falls back to always-evict when __hotReload is undefined', function() {
        var evicted = false;
        var result = actionCacheLogic(true, undefined, function() { evicted = true; });
        assert.equal(result, true);
        assert.equal(evicted, true);
    });

    it('action: does not attempt to clear flag when hotReload is null', function() {
        assert.doesNotThrow(function() {
            actionCacheLogic(true, null, function() {});
        });
    });

    it('action: consecutive calls without file change — only first evicts', function() {
        var hotReload = { core: false, action: true };
        var count = 0;
        actionCacheLogic(true, hotReload, function() { count++; });
        actionCacheLogic(true, hotReload, function() { count++; }); // action=false now
        assert.equal(count, 1);
    });

    it('action: watcher marks dirty → evicts → watcher marks dirty again → evicts again', function() {
        var hotReload = { core: false, action: true };
        var count = 0;
        actionCacheLogic(true, hotReload, function() { count++; }); // evicts, action→false
        hotReload.action = true; // simulate file change
        actionCacheLogic(true, hotReload, function() { count++; }); // evicts again
        assert.equal(count, 2);
    });

});


// ─────────────────────────────────────────────────────────────────────────
// 10 — #B18 router.js require.cache antipattern eviction
// ─────────────────────────────────────────────────────────────────────────
//
// Per llms.txt #175 (formerly #104): `require.cache[path] = require(path)` is an antipattern
// because Node reads `.exports` off each `require.cache` entry on every
// subsequent `require()`; assigning the bare exports object into the slot
// (no `.exports` key) makes the next plain `require()` return `undefined`.
//
// router.js had two latent occurrences after the `refreshCore()` fix
// (server.isaac.js commit `add6655e`):
//   - refreshCoreDependencies() at ~L116-127 (Super controller hot-reload)
//   - controller-require path at ~L617-627 (per-route Super controller lookup)
//
// The fix at both sites: drop the cache-slot poisoning line and use the
// return value of `require()` directly. The preceding `delete require.cache[
// require.resolve(path)]` already evicts the slot, so the next `require()`
// builds a fresh Module instance correctly.

describe('10 - #B18 router.js require.cache antipattern eviction', function() {

    var SOURCE = path.join(require('../fw'), 'core/router.js');
    var src    = fs.readFileSync(SOURCE, 'utf8');

    // ── (a) source structure — the antipattern is GONE ───────────────────────

    it('no `require.cache[<path>] = require(<path>)` poisoning anywhere in router.js', function() {
        // Specifically the controller/index.js slot — the only path the old
        // antipattern reused. Tolerate other unrelated `require.cache[…] = …`
        // sites if they ever appear (none today), but enforce no occurrence
        // of the exact poisoning shape on controller/index.js.
        var poisonRe = /require\.cache\[\s*_\([^)]*controller\/index\.js[^)]*\)\s*\]\s*=\s*require\s*\(/;
        assert.ok(
            !poisonRe.test(src),
            'router.js must not reassign require.cache[controller/index.js] with require() (#B18 antipattern)'
        );
    });

    it('no `require.cache[<path>] = require(<path>)` poisoning on controller/controller.js either', function() {
        var poisonRe = /require\.cache\[\s*_\([^)]*controller\/controller\.js[^)]*\)\s*\]\s*=\s*require\s*\(/;
        assert.ok(
            !poisonRe.test(src),
            'router.js must not reassign require.cache[controller/controller.js] with require()'
        );
    });

    it('SuperController is read from the return value of require(), not from require.cache[]', function() {
        // Two assignment sites — both should use `require(<path>)` directly,
        // not `require.cache[<path>]`.
        var assignRe = /SuperController\s*=\s*require\.cache\[/g;
        var matches  = src.match(assignRe) || [];
        assert.equal(
            matches.length, 0,
            'no `SuperController = require.cache[...]` reads — read from `require(...)` directly'
        );
    });

    it('refreshCoreDependencies() preserves the delete-before-require shape', function() {
        // The function still evicts both slots; only the re-binding shape changed.
        // Anchor: the function body starts with the two-line eviction block.
        var refreshFnIdx = src.indexOf('refreshCoreDependencies');
        assert.ok(refreshFnIdx > -1, 'refreshCoreDependencies function not found');
        var afterFn = src.slice(refreshFnIdx, refreshFnIdx + 1500);
        assert.ok(
            afterFn.indexOf("delete require.cache[require.resolve(_(corePath +'/controller/controller.js'") > -1,
            'must still delete the controller.js cache entry'
        );
        assert.ok(
            afterFn.indexOf("delete require.cache[require.resolve(_(corePath +'/controller/index.js'") > -1,
            'must still delete the controller/index.js cache entry'
        );
        assert.ok(
            afterFn.indexOf('SuperController = require(_(corePath') > -1,
            'must read SuperController from require(...), not from require.cache[...]'
        );
    });

    it('controller-require path (~L617) preserves the delete-before-require shape', function() {
        // The per-route Super controller lookup. Anchor: the comment marker
        // `//if (isCacheless) {` is unique to this block.
        var blockIdx = src.indexOf('//if (isCacheless) {');
        assert.ok(blockIdx > -1, 'controller-require path anchor not found');
        var afterBlock = src.slice(blockIdx, blockIdx + 800);
        assert.ok(
            afterBlock.indexOf("delete require.cache[require.resolve(_(corePath +'/controller/index.js'") > -1,
            'must still delete the controller/index.js cache entry'
        );
        assert.ok(
            afterBlock.indexOf('delete require.cache[require.resolve(filename)]') > -1,
            'must still delete the user controller filename cache entry'
        );
        assert.ok(
            afterBlock.indexOf('var SuperController     = require(_(corePath') > -1,
            'must read SuperController from require(...), not from require.cache[...]'
        );
    });

    it('source mentions #B18 at the fix sites for traceability', function() {
        assert.ok(src.indexOf('#B18') > -1, 'expected #B18 trace marker at the fix sites');
    });

    // ── (b) pure logic — why the antipattern is wrong ────────────────────────

    it('replica: require.cache[path] = require(path) poisons subsequent require()', function() {
        // Simulate Node's require.cache lookup semantics.
        //   - A real Module instance has `.exports`
        //   - `require.cache[path] = require(path)` stores the exports object directly
        //   - Next require() reads `.exports` off the cache entry → undefined
        var fakeCache = {};
        var modulePath = '/fake/path/to/index.js';

        // The poisoning pattern:
        function poisonedRequire(path) {
            var fresh = { greet: function() { return 'hello'; } }; // simulates module exports
            fakeCache[path] = fresh; // POISON: assigns exports, not Module
            return fakeCache[path];
        }
        function nextPlainRequire(path) {
            // Node's plain require reads `.exports` off the cache entry.
            return fakeCache[path] ? fakeCache[path].exports : undefined;
        }
        var first = poisonedRequire(modulePath);
        assert.ok(first.greet, 'first poisoned require returns the exports object directly');
        assert.equal(nextPlainRequire(modulePath), undefined,
            'plain require on the poisoned slot returns undefined (the bug)');
    });

    it('replica: delete + plain require() yields a usable Module reference', function() {
        // The correct shape:
        //   - delete require.cache[path]
        //   - var fresh = require(path)
        //   - use `fresh` directly
        var fakeCache = {};
        var modulePath = '/fake/path/to/index.js';

        function plainRequire(path) {
            if (!fakeCache[path]) {
                // simulates Node: creates a Module wrapper holding exports
                fakeCache[path] = {
                    exports: { greet: function() { return 'hello'; } }
                };
            }
            return fakeCache[path].exports;
        }
        function deleteAndRequire(path) {
            delete fakeCache[path];
            return plainRequire(path); // returns exports off a properly-built Module
        }
        var fresh = deleteAndRequire(modulePath);
        assert.ok(fresh.greet, 'fresh exports object is usable');
        assert.equal(fresh.greet(), 'hello', 'fresh exports object behaves correctly');
        // And subsequent plainRequire() still works because the slot now holds a Module wrapper.
        var second = plainRequire(modulePath);
        assert.equal(second.greet(), 'hello', 'subsequent plain require still works');
    });

});


// 11 — #B52-residual: narrowed per-request conf clone (router.js this.route)
describe('11 - #B52-residual: narrowed per-request conf clone', function() {

    var SOURCE = path.join(require('../fw'), 'core/router.js');
    var src    = fs.readFileSync(SOURCE, 'utf8');
    // Full-line comments stripped so the negative pin below does not trip on the
    // commented-out old statement (a negative source pin must not match the file's own comments).
    var code   = src.replace(/^\s*\/\/.*$/gm, '');

    // ── (a) source structure — whole-conf clone replaced by the narrowed form ────

    it('no longer deep-clones the WHOLE conf per request (active statement gone)', function() {
        assert.ok(
            code.indexOf('options.conf = JSON.clone(conf);') < 0,
            'router.js must not deep-clone the entire bundle conf per request (#B52-residual high-water-mark)'
        );
    });

    it('shallow-copies the top level + conf.content, then the routing map + the matched rule (#P40 S3b)', function() {
        assert.ok(
            src.indexOf('options.conf = Object.assign({}, conf);') > -1,
            'expected a shallow top-level copy: options.conf = Object.assign({}, conf)'
        );
        assert.ok(
            src.indexOf('options.conf.content = Object.assign({}, conf.content);') > -1,
            'expected a shallow content copy: options.conf.content = Object.assign({}, conf.content)'
        );
        assert.ok(
            src.indexOf('options.conf.content.routing = Object.assign({}, conf.content.routing);') > -1,
            'expected a shallow copy of the routing map: options.conf.content.routing = Object.assign({}, conf.content.routing)'
        );
        assert.ok(
            src.indexOf('options.conf.content.routing[options.rule] = Object.assign({}, conf.content.routing[options.rule]);') > -1,
            'expected a shallow copy of the matched rule: options.conf.content.routing[options.rule] = Object.assign({}, conf.content.routing[options.rule])'
        );
        // Negative on the comment-stripped copy: the retired deep clone must be gone from the live code
        // (the S3b comment in router.js deliberately does not quote it, so this is a real absence — the
        // strip's own load-bearing control lives in router-per-rule-copy.test.js).
        assert.ok(
            code.indexOf('options.conf.content.routing = JSON.clone(conf.content.routing);') < 0,
            'the deep clone of the whole routing map must be gone from the live code (#P40 S3b)'
        );
    });

    it('the per-rule copy precedes the per-request [rule].param write (still the single writer)', function() {
        var copyIdx  = src.indexOf('options.conf.content.routing[options.rule] = Object.assign({}, conf.content.routing[options.rule]);');
        var writeIdx = src.indexOf('options.conf.content.routing[options.rule].param = params.param;');
        assert.ok(copyIdx > -1 && writeIdx > -1, 'both the per-rule copy and the [rule].param write must be present');
        assert.ok(writeIdx > copyIdx, 'the [rule].param write must come after the matched rule is made request-private');
    });

    it('source carries the #B52-residual trace marker', function() {
        assert.ok(src.indexOf('#B52-residual') > -1, 'expected #B52-residual trace marker at the fix site');
    });

    // ── (b) pure logic — share the immutable remainder, isolate content.routing ──

    // mirrors router.js this.route: shallow top + shallow content + shallow routing map + shallow MATCHED rule (#P40 S3b)
    function narrowedConfClone(conf, rule) {
        var c = Object.assign({}, conf);
        c.content = Object.assign({}, conf.content);
        c.content.routing = Object.assign({}, conf.content.routing);
        c.content.routing[rule] = Object.assign({}, conf.content.routing[rule]);
        return c;
    }
    function makeConf() {
        return {
            server         : { coreConfiguration: { mime: { html: 'text/html' }, statusCodes: { '404': 'Not Found' } } },
            routing        : { homepage: { host: 'h0' } },   // top-level — reassigned wholesale at controller:590
            reverseRouting : { '/': 'homepage' },            // reassigned at controller:623
            forms          : { login: {} },                  // reassigned at controller:627
            locale         : { date: { now: 'orig' } },      // reassigned at controller:762/766
            locales        : [{ lang: 'en', content: {} }],  // reassigned at controller:759
            content        : {
                templates : { _common: { html: '/tpl' } },
                settings  : { region: { shortCode: 'en' } },
                forms     : { login: { fields: {} } },
                routing   : {                                 // the matched rule's param is REPLACED per request — the map + that rule are copied, the rest shared
                    homepage : { url: '/',     param: { control: 'home' } },
                    page     : { url: '/p/:n', param: { control: 'page', n: ':n' } }
                }
            }
        };
    }

    it('shares the large immutable subtrees by reference (no per-request copy)', function() {
        var source = makeConf();
        var clone  = narrowedConfClone(source, 'homepage');
        assert.equal(clone.server, source.server, 'conf.server shared by reference (read-only, big)');
        assert.equal(clone.content.templates, source.content.templates, 'content.templates shared by reference');
        assert.equal(clone.content.settings, source.content.settings, 'content.settings shared by reference');
        assert.equal(clone.content.forms, source.content.forms, 'content.forms shared by reference (only reassign-read per request)');
        assert.equal(clone.locales, source.locales, 'locales shared by reference');
    });

    it('makes conf.content.routing request-private where it is written: a fresh map + a fresh MATCHED rule, the other rules shared', function() {
        var source = makeConf();
        var clone  = narrowedConfClone(source, 'homepage');
        assert.notEqual(clone.content, source.content, 'content is a fresh shallow copy');
        assert.notEqual(clone.content.routing, source.content.routing, 'content.routing is a fresh map');
        assert.notEqual(clone.content.routing.homepage, source.content.routing.homepage, 'the matched rule is a separate copy');
        assert.equal(clone.content.routing.page, source.content.routing.page, 'the other rules stay shared by reference (#P40 S3b)');
        assert.deepEqual(clone.content.routing.homepage, source.content.routing.homepage, 'but data-identical to the source');
    });

    it('the router.js:545 [rule].param write stays private (does not mutate the source conf)', function() {
        var source = makeConf();
        var clone  = narrowedConfClone(source, 'homepage');
        clone.content.routing.homepage.param = { control: 'home', injected: 'X' }; // mirrors router.js:545
        assert.equal(source.content.routing.homepage.param.injected, undefined,
            'writing the clone content.routing[rule].param must not reach the shared source');
    });

    it('the whole-subtree reassigns (routing/reverseRouting/forms/locales/locale) stay private', function() {
        var source     = makeConf();
        var origRouting = source.routing, origLocale = source.locale;
        var clone      = narrowedConfClone(source, 'homepage');
        assert.equal(clone.routing, source.routing, 'top-level routing initially shared by reference (shallow top copy)');
        // controller setOptions reassigns these wholesale on the per-request conf:
        clone.routing        = { reassigned: 'A' }; // == controller:590
        clone.reverseRouting = { reassigned: 'A' }; // == controller:623
        clone.forms          = clone.content.forms; // == controller:627
        clone.locale         = { date: { now: 'new' } }; // == controller:762/766
        clone.locales        = [{ lang: 'fr' }];    // == controller:759
        assert.equal(source.routing, origRouting, 'source.routing still the original object');
        assert.deepEqual(source.routing, { homepage: { host: 'h0' } }, 'source.routing content unchanged');
        assert.equal(source.locale, origLocale, 'source.locale still the original object');
        assert.deepEqual(source.locale, { date: { now: 'orig' } }, 'source.locale content unchanged');
    });

    it('two concurrent requests do not bleed via content.routing', function() {
        var source = makeConf();
        var reqA = narrowedConfClone(source, 'homepage');
        var reqB = narrowedConfClone(source, 'homepage');
        reqA.content.routing.homepage.param = { control: 'home', reqId: 'A' };
        reqB.content.routing.homepage.param = { control: 'home', reqId: 'B' };
        assert.equal(reqA.content.routing.homepage.param.reqId, 'A', 'request A keeps its own param');
        assert.equal(reqB.content.routing.homepage.param.reqId, 'B', 'request B keeps its own param');
        assert.equal(source.content.routing.homepage.param.reqId, undefined, 'source conf is untouched');
    });

    it('subtract: WITHOUT the content.routing copies, concurrent requests WOULD bleed', function() {
        // proves the routing-map + matched-rule copy is load-bearing, not incidental
        var source = makeConf();
        function buggyClone(conf) { // shallow content only — content.routing shared (the bug)
            var c = Object.assign({}, conf);
            c.content = Object.assign({}, conf.content);
            return c;
        }
        var reqA = buggyClone(source);
        var reqB = buggyClone(source);
        reqA.content.routing.homepage.param = { control: 'home', reqId: 'A' };
        reqB.content.routing.homepage.param = { control: 'home', reqId: 'B' };
        assert.equal(reqA.content.routing.homepage.param.reqId, 'B',
            'without the copies, request A sees request B param (cross-request bleed)');
    });

});

describe('12 - #B67 engine-agnostic proxy-host refresh + cross-bundle toUrl resolution', function() {

    var src  = fs.readFileSync(SOURCE, 'utf8');
    // Full-line comments stripped so negative pins never trip on the file's own comments.
    var code = src.replace(/^\s*\/\/.*$/gm, '');

    // ── (a) source structure: the engine-agnostic PROXY_HOSTNAME refresh ──────────

    it('carries the #B67 trace marker at the refresh site', function() {
        assert.ok(src.indexOf('#B67') > -1, 'expected the #B67 trace marker');
    });

    it('classifies THIS request proxied via a port-less Host OR X-Forwarded-Host (the #B65 gate, not the sticky isProxyHost latch)', function() {
        assert.ok(code.indexOf('var proxyReqIsProxied = (') > -1, 'expected a per-request proxied classification (proxyReqIsProxied)');
        assert.ok(src.indexOf('!/\\:[0-9]+$/.test(proxyReqHost)') > -1, 'classification must test the inbound Host for a trailing port');
        assert.ok(src.indexOf("request.headers['x-forwarded-host']") > -1, 'classification must also accept X-Forwarded-Host');
    });

    it('sets PROXY_HOSTNAME (host-only, public) ONLY inside the per-request proxied gate (never unconditionally)', function() {
        var gateIdx  = code.indexOf('if ( proxyReqIsProxied ) {');
        var writeIdx = code.indexOf('process.gina.PROXY_HOSTNAME = proxyReqScheme');
        assert.ok(gateIdx > -1, 'expected the `if ( proxyReqIsProxied )` gate');
        assert.ok(writeIdx > gateIdx, 'PROXY_HOSTNAME must be written inside the proxied gate — the #B65 freeze-guard');
    });

    it('scheme precedence: X-Forwarded-Proto then PROXY_SCHEME then the bundle scheme', function() {
        assert.ok(
            src.indexOf("request.headers['x-forwarded-proto']") > -1
            && src.indexOf('process.gina.PROXY_SCHEME') > -1
            && src.indexOf('conf.server.scheme') > -1,
            'proxyReqScheme must prefer x-forwarded-proto, then PROXY_SCHEME, then conf.server.scheme'
        );
    });

    it('lives at the engine-agnostic point — AFTER setContext(isProxyHost) in core/router.js — so BOTH engines traverse it', function() {
        // The refresh lives in core/router.js (this SOURCE), which runs for isaac AND express
        // (server.express.js sets zero proxy state). Placement right after setContext proves it.
        var ctxIdx = src.indexOf("setContext('isProxyHost', isProxyHost);");
        // #B367 re-anchor: the raw Host/:authority read was split into a raw capture
        // plus a sanitised binding, so the old `var proxyReqHost = request.headers.host`
        // literal is gone. Placement is unchanged (measured: setContext @9154, this
        // anchor @11280), which is what this test actually asserts.
        var b67Idx = src.indexOf('var _rawProxyReqHost = request.headers.host');
        assert.ok(ctxIdx > -1 && b67Idx > -1, 'both anchors present');
        assert.ok(b67Idx > ctxIdx, 'the #B67 refresh must follow setContext(isProxyHost) at the engine-agnostic router point');
    });

    // ── (b) pure logic: derivation → PROXY_HOSTNAME → getRoute/toUrl composition ──

    // mirrors router.js: the #B67 refresh (proxied classification + host-only public derivation)
    function deriveProxyHostname(headers, bundleScheme, proxyScheme) {
        var reqHost = headers.host || headers[':authority'];
        var proxied = ( (reqHost && !/\:[0-9]+$/.test(reqHost)) || headers['x-forwarded-host'] ) ? true : false;
        if (!proxied) { return { proxied: false, PROXY_HOSTNAME: undefined }; }
        var scheme = headers['x-forwarded-proto'] || proxyScheme || bundleScheme;
        if (headers['x-forwarded-host']) { return { proxied: true, PROXY_HOSTNAME: scheme + '://' + headers['x-forwarded-host'] }; }
        return { proxied: true, PROXY_HOSTNAME: scheme + '://' + reqHost };
    }

    // mirrors lib/routing getRoute:1101-1105 (proxy_hostname pick) + :1130 trailing-slash strip
    // + toUrl:1187-1206 (host + webroot-adjusted url)
    function resolveToUrl(route, isProxyHost, PROXY_HOSTNAME, proxyHostnameFallback) {
        var r = Object.assign({}, route);
        r.isProxyHost = isProxyHost;
        if (isProxyHost) { r.proxy_hostname = PROXY_HOSTNAME || proxyHostnameFallback; } // getRoute:1105
        var url = ( /\/$/.test(r.url) && r.url != '/' ) ? r.url.substring(0, r.url.length - 1) : r.url; // :1130
        var wroot    = r.webroot;
        var hostname = '' + r.hostname;
        if (r.isProxyHost) { hostname = '' + r.proxy_hostname; } // toUrl:1191-1192
        var finalUrl = ('' + url).replace(new RegExp('^(' + wroot + '|\\/$)'), wroot);
        return hostname + finalUrl;
    }

    // framework-generic fixture: a PARENT bundle (webroot /p/, host parent-internal:5127) renders a
    // cross-bundle link to a CHILD route (webroot /c/, host child-internal:5131, distinct port).
    var childRoute          = { bundle: 'child', hostname: 'https://child-internal:5131', host: 'child-internal:5131', webroot: '/c/', url: '/c/path', param: { control: 'home' } };
    var CHILD_INTERNAL      = 'https://child-internal:5131';
    var PARENT_HOST_WEBROOT = 'https://parent-internal:5127/p/'; // the pre-fix envConf._proxyHostname (host+webroot)

    it('multi-hop (Ingress→RP→POD, X-Forwarded-Host): PUBLIC host + child webroot', function() {
        var d = deriveProxyHostname({ host: 'ingress.internal', 'x-forwarded-host': 'public.example', 'x-forwarded-proto': 'https' }, 'https', undefined);
        assert.equal(d.PROXY_HOSTNAME, 'https://public.example');
        assert.equal(resolveToUrl(childRoute, true, d.PROXY_HOSTNAME, CHILD_INTERNAL), 'https://public.example/c/path');
    });

    it('single-hop (RP→POD, port-less Host, no XFH — the reported pod shape): PUBLIC host + child webroot', function() {
        var d = deriveProxyHostname({ host: 'public.example', 'x-forwarded-proto': 'https', 'x-nginx-proxy': 'true' }, 'https', undefined);
        assert.equal(d.PROXY_HOSTNAME, 'https://public.example');
        assert.equal(resolveToUrl(childRoute, true, d.PROXY_HOSTNAME, CHILD_INTERNAL), 'https://public.example/c/path');
    });

    it('RAW direct (port-ful Host, no proxy): NOT proxied → child-internal host + child webroot', function() {
        var d = deriveProxyHostname({ host: 'child-internal:5131' }, 'https', undefined);
        assert.equal(d.proxied, false, 'a port-ful Host with no XFH is not proxied');
        assert.equal(resolveToUrl(childRoute, false, undefined, undefined), 'https://child-internal:5131/c/path');
    });

    it('SUBTRACT — pre-fix inputs (PROXY_HOSTNAME falsy + host+webroot fallback) reproduce the #B67 blend', function() {
        // Before #B67: router.js did not refresh PROXY_HOSTNAME engine-agnostically (falsy for a
        // slot-less request) AND controller.js wrote envConf._proxyHostname = host+webroot; getRoute
        // then fell back to that host+webroot value → the double-webroot blend.
        assert.equal(
            resolveToUrl(childRoute, true, undefined, PARENT_HOST_WEBROOT),
            'https://parent-internal:5127/p//c/path',
            'the pre-fix inputs must reproduce the blend — proving the reliably-set PROXY_HOSTNAME + host-only fallback are load-bearing'
        );
    });

});


// 13 — source structure: reserved-actions guard (#B399)
// An async onReady/setup rejection was unowned (no response, invisible trace) and a
// sync hook throw escaped the local catch to process level (isaac: bundle death).
// The fix moves both reservedActions loops INSIDE their try and gives each hook the
// same thenable-capture → .catch → throwError(500) shape the action dispatch carries.
describe('13 - source structure: reserved-actions guard (#B399)', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');

    function countOf(hay, needle) {
        return hay.split(needle).length - 1;
    }

    it('each hook result is captured at both sites', function() {
        assert.equal(
            countOf(src, 'let _hookResult = controller[reservedActions[e]](request, response, next);'),
            2, 'expected the hook-result capture at BOTH dispatch sites'
        );
    });

    it('each captured result is thenable-checked at both sites', function() {
        assert.equal(
            countOf(src, "if ( _hookResult && typeof _hookResult.then === 'function' )"),
            2, 'expected the thenable check at BOTH dispatch sites'
        );
    });

    it('each thenable hook result gets a .catch routing to throwError at both sites', function() {
        assert.equal(
            countOf(src, '_hookResult.catch(function(err)'),
            2, 'expected the rejection handler at BOTH dispatch sites'
        );
    });

    it('the rejection message names the failing hook (diagnosis is the point of #B399)', function() {
        assert.equal(
            countOf(src, "'reserved action `'+ reservedActions[e] +'` rejected: '"),
            2, 'expected the hook-naming message prefix at BOTH sites'
        );
    });

    it('both reservedActions loops sit INSIDE their try (sync hook throw -> local 500, not process death)', function() {
        // Structural, not char-distance: in each _dispatchControllerAction slice the
        // try must open BEFORE the loop, which must precede the action dispatch.
        var re = /var _dispatchControllerAction = function/g, m, seen = 0;
        while ((m = re.exec(src)) !== null) {
            var after   = src.slice(m.index);
            var tryIdx  = after.indexOf('try {');
            var loopIdx = after.indexOf('reservedActions.length');
            var actIdx  = after.indexOf('controller[action](');
            assert.ok(tryIdx > -1 && loopIdx > -1 && actIdx > -1, 'landmarks missing');
            assert.ok(tryIdx < loopIdx,  'the try must open BEFORE the reservedActions loop');
            assert.ok(loopIdx < actIdx,  'the loop must still precede the action dispatch');
            seen++;
        }
        assert.equal(seen, 2);
    });

    it('the synthesized setup wrapper returns the app call result so the loop guard can own it', function() {
        // The wrapper used to `return Setup` (the function object — zero consumers),
        // discarding an async setup.js's promise before the guard could see it.
        assert.ok(
            src.indexOf('return Setup.apply(Setup, arguments);') > -1,
            'expected `return Setup.apply(Setup, arguments);` — the wrapper must propagate the app result'
        );
    });

});


// Replica of the #B399 reserved-actions guard + action dispatch band (both sites).
// Pinned to source by describe 13's literal assertions: the guard lines here must
// keep matching router.js, or the replica drifts from what ships.
function dispatchReservedActionsThenAction(serverInstance, controller, reservedActions, action, request, response, next) {
    for (let e=0; e<reservedActions.length; ++e) {
        if ( typeof(controller[reservedActions[e]]) == 'function' ) {
            let _hookResult = controller[reservedActions[e]](request, response, next);
            if ( _hookResult && typeof _hookResult.then === 'function' ) {
                _hookResult.catch(function(err) {
                    serverInstance.throwError(response, 500, 'reserved action `'+ reservedActions[e] +'` rejected: '+ ( err && (err.stack || err.message) || String(err) ));
                });
            }
        }
    }
    var _result = controller[action](request, response, next);
    if (_result && typeof _result.then === 'function') {
        return _result.catch(function(err) {
            serverInstance.throwError(response, 500, err.stack || err.message || String(err));
        });
    }
}


// 14 — reserved-actions hook guard: pure dispatch logic (#B399)
describe('14 - reserved-actions hook guard: pure dispatch logic (#B399)', function() {

    var RESERVED = ['onReady', 'setup'];

    function makeSetup() {
        var calls = { thrown: [], actionCalled: 0 };
        var serverInstance = {
            throwError: function(response, status, msg) {
                calls.thrown.push({ status: status, msg: msg });
            }
        };
        return { calls: calls, serverInstance: serverInstance };
    }

    function settle() {
        return new Promise(function(resolve) { setImmediate(resolve); });
    }

    it('an async rejecting onReady answers 500 through throwError, naming the hook', async function() {
        var s = makeSetup();
        var controller = {
            onReady: function() { return Promise.reject(new Error('hook boom')); },
            list: function() { s.calls.actionCalled++; }
        };
        dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        await settle();
        assert.equal(s.calls.thrown.length, 1, 'the rejection must reach throwError');
        assert.equal(s.calls.thrown[0].status, 500);
        assert.ok(/reserved action `onReady` rejected: /.test(s.calls.thrown[0].msg), 'message must name the hook');
        assert.ok(/hook boom/.test(s.calls.thrown[0].msg), 'message must carry the error detail');
    });

    it('a rejecting hook does NOT prevent the action dispatch (microtask ordering)', async function() {
        var s = makeSetup();
        var controller = {
            setup: function() { return Promise.reject(new Error('late')); },
            list: function() { s.calls.actionCalled++; }
        };
        dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        assert.equal(s.calls.actionCalled, 1, 'the action is dispatched in the same sync frame');
        await settle();
        assert.equal(s.calls.thrown.length, 1);
    });

    it('sync hooks + sync action mint zero promises and never touch throwError (dormancy)', function() {
        var s = makeSetup();
        var ranHooks = [];
        var controller = {
            onReady: function() { ranHooks.push('onReady'); },
            setup:   function() { ranHooks.push('setup'); },
            list:    function() { s.calls.actionCalled++; }
        };
        var out = dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        assert.deepEqual(ranHooks, ['onReady', 'setup']);
        assert.equal(s.calls.actionCalled, 1);
        assert.equal(s.calls.thrown.length, 0);
        assert.equal(typeof out, 'undefined', 'no promise minted on the all-sync path');
    });

    it('a non-function reserved slot is skipped, not invoked', function() {
        var s = makeSetup();
        var controller = {
            onReady: 'not-a-function',
            list: function() { s.calls.actionCalled++; }
        };
        assert.doesNotThrow(function() {
            dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        });
        assert.equal(s.calls.actionCalled, 1);
    });

    it('a null-reason rejection is coerced, never a TypeError inside the catch', async function() {
        var s = makeSetup();
        var controller = {
            onReady: function() { return Promise.reject(null); },
            list: function() {}
        };
        dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        await settle();
        assert.equal(s.calls.thrown.length, 1);
        assert.ok(/rejected: null$/.test(s.calls.thrown[0].msg), 'String(null) must land in the message');
    });

    it('a resolving async hook stays silent (catch is a no-op on resolve)', async function() {
        var s = makeSetup();
        var controller = {
            onReady: function() { return Promise.resolve('fine'); },
            list: function() { s.calls.actionCalled++; }
        };
        dispatchReservedActionsThenAction(s.serverInstance, controller, RESERVED, 'list', {}, {}, function(){});
        await settle();
        assert.equal(s.calls.thrown.length, 0);
        assert.equal(s.calls.actionCalled, 1);
    });

    it('SUBTRACT — the pre-#B399 bare dispatch discards the rejection (throwError never called)', async function() {
        // The pre-fix loop shape: bare invocation, result discarded. Same inputs as
        // the guarded tests above, guard absent -> the throwError count must flip to
        // 0, proving the capture+catch is load-bearing. (The promise is pre-absorbed
        // for the harness: node:test fails the active test on any REAL unhandled
        // rejection, so the floats-to-process-handler half of the pre-fix behaviour
        // is pinned at source level — gna.js's process handler — not re-proven here.)
        var s = makeSetup();
        var p = Promise.reject(new Error('unowned'));
        p.catch(function(){});
        var controller = {
            onReady: function() { return p; },
            list: function() { s.calls.actionCalled++; }
        };
        for (let e=0; e<RESERVED.length; ++e) {
            if ( typeof(controller[RESERVED[e]]) == 'function' ) {
                controller[RESERVED[e]]({}, {}, function(){});
            }
        }
        controller.list({}, {}, function(){});
        await settle();
        assert.equal(s.calls.thrown.length, 0, 'bare dispatch: the rejection never reaches throwError — the pre-fix failure mode');
        assert.equal(s.calls.actionCalled, 1);
    });

});
