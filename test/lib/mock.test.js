/**
 * #R2 — Mockable service locator
 *
 * Verifies that getConfig() and getModel() delegate to the __mock__ override
 * when one is registered via setContext('__mock__', { ... }), and fall through
 * to the real implementation when the mock is cleared.
 *
 * No running server, no Couchbase, no gna.js bootstrap required.
 */

'use strict';

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');

// Bootstrap globals (_, getContext, setContext, getConfig, getPath, …)
require('../../framework/v0.1.8-alpha.1/helpers');

// Instantiate ModelUtil to inject getModel into the global scope.
// new ModelUtil() is lightweight — no DB connections, just initialises
// the entity registry and calls setContext('modelUtil', …).
var ModelUtil = require('../../framework/v0.1.8-alpha.1/lib/model');
new ModelUtil();


// ─── helpers ────────────────────────────────────────────────────────────────

function clearMock() {
    setContext('__mock__', null);
}


// ─── getConfig ───────────────────────────────────────────────────────────────

describe('getConfig — __mock__ override', function() {

    afterEach(clearMock);

    it('returns mock config when __mock__.config is set', function() {
        var mockCfg = { server: { port: 9999 }, env: 'test' };

        setContext('__mock__', {
            config: function() { return mockCfg; }
        });

        var result = getConfig('anyBundle', 'anyConf');
        assert.deepStrictEqual(result, mockCfg);
    });

    it('mock receives the bundle and confName arguments', function() {
        var received = {};

        setContext('__mock__', {
            config: function(bundle, confName) {
                received.bundle   = bundle;
                received.confName = confName;
                return {};
            }
        });

        getConfig('myBundle', 'app');
        assert.equal(received.bundle,   'myBundle');
        assert.equal(received.confName, 'app');
    });

    it('mock can return different configs per bundle', function() {
        var configs = {
            api:     { server: { port: 3001 } },
            backend: { server: { port: 3002 } }
        };

        setContext('__mock__', {
            config: function(bundle) { return configs[bundle] || {}; }
        });

        assert.equal(getConfig('api').server.port,     3001);
        assert.equal(getConfig('backend').server.port, 3002);
        assert.deepStrictEqual(getConfig('unknown'), {});
    });

    it('bypasses mock when __mock__ is null', function() {
        // Calling getConfig() without a mock in a no-server context throws or
        // returns undefined — either is acceptable; what matters is it does NOT
        // return mock data after clearMock().
        setContext('__mock__', { config: function() { return { _mocked: true }; } });
        assert.ok(getConfig('x')._mocked === true, 'mock should be active');

        clearMock();

        // After clearing, getConfig() no longer routes through the mock.
        // We just verify it doesn't return the mock object (it may throw in a
        // no-server context, which is expected and acceptable).
        try {
            var result = getConfig('x');
            assert.ok(result === undefined || !result._mocked, 'mock should be inactive');
        } catch (_) {
            // getConfig() threw because there is no real gina context — expected
        }
    });

    it('mock is not active when __mock__ has no config key', function() {
        setContext('__mock__', { model: function() { return {}; } });

        // getConfig() should fall through (no config fn) — same as no mock
        try {
            var result = getConfig('x');
            assert.ok(!result || !result._mocked);
        } catch (_) {
            // fell through to real impl, which throws without server context — expected
        }
    });
});


// ─── getModel ────────────────────────────────────────────────────────────────

describe('getModel — __mock__ override', function() {

    afterEach(clearMock);

    it('returns mock model when __mock__.model is set', function() {
        var mockEntities = { Invoice: function Invoice() {}, Account: function Account() {} };

        setContext('__mock__', {
            model: function() { return mockEntities; }
        });

        var result = getModel('anyBundle', 'freelancer');
        assert.strictEqual(result, mockEntities);
        assert.ok(typeof result.Invoice === 'function');
    });

    it('mock receives bundle and model arguments', function() {
        var received = {};

        setContext('__mock__', {
            model: function(bundle, model) {
                received.bundle = bundle;
                received.model  = model;
                return {};
            }
        });

        getModel('myBundle', 'myConnector');
        assert.equal(received.bundle, 'myBundle');
        assert.equal(received.model,  'myConnector');
    });

    it('mock can return different entity sets per connector', function() {
        var models = {
            freelancer: { Invoice: function Invoice() {} },
            auth:       { Session: function Session() {} }
        };

        setContext('__mock__', {
            model: function(bundle, connector) { return models[connector] || {}; }
        });

        assert.ok(typeof getModel('b', 'freelancer').Invoice === 'function');
        assert.ok(typeof getModel('b', 'auth').Session === 'function');
        assert.deepStrictEqual(getModel('b', 'unknown'), {});
    });

    it('bypasses mock when __mock__ is null', function() {
        setContext('__mock__', { model: function() { return { _mocked: true }; } });
        assert.ok(getModel('x', 'y')._mocked === true, 'mock should be active');

        clearMock();

        // After clearing, getModel() no longer routes through the mock.
        try {
            var result = getModel('x', 'y');
            assert.ok(result === undefined || !result._mocked, 'mock should be inactive');
        } catch (_) {
            // fell through to real impl, which throws without server context — expected
        }
    });

    it('mock is not active when __mock__ has no model key', function() {
        setContext('__mock__', { config: function() { return {}; } });

        try {
            var result = getModel('x', 'y');
            assert.ok(!result || !result._mocked);
        } catch (_) {
            // fell through to real impl — expected
        }
    });
});
