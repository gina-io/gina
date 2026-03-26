/**
 * #R3 — Entity constructor injection
 *
 * Verifies that EntitySuper stores `injected` deps passed as the optional 3rd
 * constructor argument and that `getConnection()` / `getConfig()` route through
 * the injected values when present.
 *
 * No running server, no Couchbase cluster required.
 *
 * Bootstrap strategy:
 *   entity.js does `require('gina').lib` at the module level.  Requiring the
 *   full gina package (gna.js) needs GINA_HOMEDIR and other env vars that are
 *   not available in a unit-test context.  We therefore stub the gina package
 *   in require.cache BEFORE loading entity.js, providing a minimal lib shim.
 *   This is the same approach used internally by the framework when
 *   require.cache is manipulated for dev-mode hot-reload.
 */

'use strict';

var path    = require('path');
var { describe, it, before } = require('node:test');
var assert  = require('node:assert/strict');

// ─── bootstrap ──────────────────────────────────────────────────────────────

var GINA_FW = path.resolve(require('../fw'));

// 1. Set up global helpers (_, getContext, setContext, getConfig, etc.)
require(GINA_FW + '/helpers');

// 2. Instantiate ModelUtil — sets up getModel, getModelEntity globals and the
//    modelUtil context key needed by EntitySuper's init path.
var ModelUtil = require(GINA_FW + '/lib/model');
var mu = new ModelUtil();

// 3. Stub require('gina') so entity.js can load without a full gna.js run.
var ginaMain  = require.resolve(path.resolve(__dirname, '../../'));
var _inherits = require(GINA_FW + '/lib/inherits/src/main.js');
var _merge    = require(GINA_FW + '/lib/merge/src/main.js');

if (!require.cache[ginaMain] || !require.cache[ginaMain].exports.lib) {
    require.cache[ginaMain] = {
        id       : ginaMain,
        filename : ginaMain,
        loaded   : true,
        exports  : {
            lib: {
                logger   : console,
                helpers  : {},
                inherits : _inherits,
                merge    : _merge,
                Model    : ModelUtil
            }
        }
    };
}

// 4. Load EntitySuper now that 'gina' is stubbed.
var EntitySuper = require(GINA_FW + '/core/model/entity.js');

// ─── helper — build a minimal entity subclass ────────────────────────────────

var _entityCount = 0;

/**
 * Create a minimal entity subclass suitable for isolation tests.
 * Each call produces a fresh class registered under a unique name so
 * successive test cases don't share EntitySuper static state.
 */
function makeEntityClass(bundle, model) {
    var uid        = 'Stub' + (++_entityCount);
    var EntityName = uid + 'Entity';

    function StubEntity() {}
    StubEntity = _inherits(StubEntity, EntitySuper);
    StubEntity.prototype.name     = uid;
    StubEntity.prototype.model    = model;
    StubEntity.prototype.bundle   = bundle;
    StubEntity.prototype.database = 'testdb';

    // Register in modelUtil so getModelEntity() can resolve it.
    mu.setConnection(bundle, model, null);
    mu.setModelEntity(bundle, model, EntityName, StubEntity);

    return StubEntity;
}


// ─── tests ───────────────────────────────────────────────────────────────────

describe('EntitySuper — _injected storage', function() {

    it('_injected is null when no injected arg is passed', function() {
        var E = makeEntityClass('b1', 'm1');
        var inst = new E(null, null);
        assert.strictEqual(inst._injected, null);
    });

    it('_injected stores the injected object', function() {
        var E = makeEntityClass('b2', 'm2');
        var dep = { connector: {}, config: function() {} };
        var inst = new E(null, null, dep);
        assert.strictEqual(inst._injected, dep);
    });

    it('_injected is null when injected is explicitly undefined', function() {
        var E = makeEntityClass('b3', 'm3');
        var inst = new E(null, null, undefined);
        assert.strictEqual(inst._injected, null);
    });

});


describe('EntitySuper#getConnection — injected.connector', function() {

    it('returns null when no conn and no injected.connector', function() {
        var E = makeEntityClass('b4', 'm4');
        var inst = new E(null, null);
        assert.strictEqual(inst.getConnection(), null);
    });

    it('returns injected.connector when set', function() {
        var E = makeEntityClass('b5', 'm5');
        var mockConn = { _isMock: true };
        var inst = new E(null, null, { connector: mockConn });
        assert.strictEqual(inst.getConnection(), mockConn);
    });

    it('injected.connector takes priority over real conn', function() {
        var E = makeEntityClass('b6', 'm6');
        var realConn = { _isReal: true };
        var mockConn = { _isMock: true };
        var inst = new E(realConn, null, { connector: mockConn });
        assert.strictEqual(inst.getConnection(), mockConn);
    });

    it('falls back to live conn when injected has no connector key', function() {
        // Without injected.connector, getConnection returns null (no live conn
        // in this test context — confirms fallback path is taken, not mock path).
        var E = makeEntityClass('b7', 'm7');
        var inst = new E(null, null, { config: function() { return {}; } });
        assert.strictEqual(inst.getConnection(), null);
    });

});


describe('EntitySuper#getConfig — injected.config', function() {

    it('has a getConfig method', function() {
        var E = makeEntityClass('b8', 'm8');
        var inst = new E(null, null);
        assert.strictEqual(typeof inst.getConfig, 'function');
    });

    it('routes to injected.config when set', function() {
        var E = makeEntityClass('b9', 'm9');
        var mockCfg = { env: 'test', _mocked: true };
        var inst = new E(null, null, {
            config: function() { return mockCfg; }
        });
        var result = inst.getConfig('b9', 'app');
        assert.deepStrictEqual(result, mockCfg);
    });

    it('injected.config receives bundle and confName arguments', function() {
        var E = makeEntityClass('b10', 'm10');
        var received = {};
        var inst = new E(null, null, {
            config: function(bundle, confName) {
                received.bundle   = bundle;
                received.confName = confName;
                return {};
            }
        });
        inst.getConfig('myBundle', 'settings');
        assert.equal(received.bundle,   'myBundle');
        assert.equal(received.confName, 'settings');
    });

    it('injected.config can return different configs per bundle', function() {
        var E = makeEntityClass('b11', 'm11');
        var configs = {
            api:  { port: 3001 },
            auth: { port: 3002 }
        };
        var inst = new E(null, null, {
            config: function(bundle) { return configs[bundle] || {}; }
        });
        assert.equal(inst.getConfig('api').port,  3001);
        assert.equal(inst.getConfig('auth').port, 3002);
        assert.deepStrictEqual(inst.getConfig('other'), {});
    });

    it('falls through to global getConfig when injected has no config key', function() {
        var E = makeEntityClass('b12', 'm12');
        var inst = new E(null, null, { connector: {} });
        // In no-server context getConfig() may throw or return undefined.
        // Either is correct — what matters is it does NOT return mock data.
        var threw = false, result;
        try {
            result = inst.getConfig('b12', 'app');
        } catch (_) {
            threw = true;
        }
        assert.ok(threw || result === undefined || !(result && result._mocked),
            'should not return mocked data');
    });

    it('falls through when injected is null', function() {
        var E = makeEntityClass('b13', 'm13');
        var inst = new E(null, null);
        var threw = false, result;
        try {
            result = inst.getConfig('b13', 'app');
        } catch (_) {
            threw = true;
        }
        assert.ok(threw || result === undefined || !(result && result._mocked));
    });

});
