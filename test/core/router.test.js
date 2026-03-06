var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var SOURCE = path.resolve(__dirname, '../../framework/v0.1.6-alpha.177/core/router.js');


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
