'use strict';
/**
 * The three per-request Config resolutions read the initialised singleton (phase-2 per-request
 * trims, slice E).
 *
 * `resolveRouteConfig` (core/router.js), `hasViews` and `loadBundleConfiguration`
 * (core/server.js) each built a throwaway `new Config()` on every request — its closures, an
 * EventEmitter init, three path objects — only for `getInstance()` to hand back the singleton's
 * envConf (or the singleton itself) and re-set Env/Scope/Host on the singleton to the values
 * they already hold (`getInstance()` runs once at boot). Now the two routing sites read
 * `Config.instance` whenever `Config.initialized` is set, and keep the old calls otherwise —
 * a worker's context-merged instance (where `Config.initialized` stays unset) and #B542's
 * refusal after an aborted init; `hasViews` checks its per-bundle memo before resolving.
 *
 *  §01 source pins — comment-stripped: the fast-path condition at both routing sites with the
 *      old calls kept as the fallback, and `hasViews`' memo check ahead of its construction.
 *  §02 behavioural — each function is brace-walk-extracted from the source under test and
 *      compiled with a counting fake Config (no replica):
 *      - initialised: no construction across five calls; `resolveRouteConfig` returns the
 *        singleton's envConf; `loadBundleConfiguration` hands the singleton on as `config`,
 *        sets `self.conf` to its envConf and never calls `setBundles()` on it;
 *      - controls (GREEN on both revisions): a Config that is not initialised — or a worker's
 *        instance without `Config.initialized` — goes through the old calls, one construction
 *        per call, and #B542's refusal still reaches `resolveRouteConfig`'s 500;
 *      - `hasViews`: one construction for five calls on one bundle, none on a memo hit.
 *
 * Seams: GINA_ROUTER_SRC / GINA_SERVER_SRC=<file> run every arm against that text. Red-first
 * against the `git show HEAD:` blobs: the three §01 pins and the four fast-path arms read RED
 * (the pre-slice code constructs on every call); every control stays GREEN.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var ROUTER_SRC = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var SERVER_SRC = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');

var RRC_DECL = 'function resolveRouteConfig(serverInstance, params, response, controllerFile, local) {';
var HV_DECL  = 'var hasViews = function(bundle) {';
var LBC_DECL = 'var loadBundleConfiguration = function(req, res, next, callback) {';

function strip(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}
function count(hay, needle) { return hay.split(needle).length - 1; }

/**
 * Slices `function … { … }` starting at `decl`, walking braces from the first `{` after the
 * declaration until it closes (the jsdoc.md started-flag walker).
 */
function extractFn(text, decl) {
    var at = text.indexOf(decl);
    if (at < 0) { return null; }
    var fnStart = text.indexOf('function', at);
    var depth = 0, started = false, i = fnStart;
    for (; i < text.length; i++) {
        var c = text[i];
        if (c === '{') { depth++; started = true; }
        else if (c === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    return (started && depth === 0) ? text.slice(fnStart, i) : null;
}

var router, server, rrcSrc, hvSrc, lbcSrc;
before(function () {
    router = strip(fs.readFileSync(ROUTER_SRC, 'utf8'));
    server = strip(fs.readFileSync(SERVER_SRC, 'utf8'));
    rrcSrc = extractFn(router, RRC_DECL);
    hvSrc  = extractFn(server, HV_DECL);
    lbcSrc = extractFn(server, LBC_DECL);
});

/**
 * A counting stand-in for the Config constructor. `state.initialized` / `state.instance` become
 * its statics; every construction is counted, and `getInstance()` answers `state.getInstance`.
 */
function fakeConfig(state) {
    var calls = { constructed: 0, getInstance: 0, setBundles: [] };
    function FakeConfig() {
        calls.constructed++;
        var me = this;
        this.getInstance = function (bundle) { calls.getInstance++; return state.getInstance(bundle, me); };
        this.setBundles = function (b) { calls.setBundles.push({ on: me, bundles: b }); };
    }
    if (state.initialized) { FakeConfig.initialized = true; }
    if (state.instance) { FakeConfig.instance = state.instance; }
    return { Config: FakeConfig, calls: calls };
}

function envConf() {
    return {
        env: 'prod', scope: 'local',
        demo: { prod: { content: { templates: {} } } },
        api:  { prod: { content: {} } },
        routing: {}, reverseRouting: {}
    };
}

describe('§01 source pins — the singleton is read once initialised', function () {

    it('control: the three functions extract brace-balanced', function () {
        [['resolveRouteConfig', rrcSrc], ['hasViews', hvSrc], ['loadBundleConfiguration', lbcSrc]].forEach(function (p) {
            assert.ok(p[1], p[0] + ' extracts from the source under test');
            assert.equal(count(p[1], '{'), count(p[1], '}'), p[0] + ' is brace-balanced');
        });
    });

    it('resolveRouteConfig reads Config.instance.envConf when initialised, the old call otherwise', function () {
        assert.equal(count(rrcSrc, '( Config.initialized && Config.instance )'), 1, 'one fast-path condition');
        assert.ok(rrcSrc.indexOf('? Config.instance.envConf') > -1, 'the fast path reads the singleton envConf');
        assert.ok(rrcSrc.indexOf(': new Config().getInstance();') > -1, 'the fallback keeps the old call');
    });

    it('loadBundleConfiguration takes the singleton when initialised, the old calls otherwise', function () {
        var fast = lbcSrc.indexOf('if ( Config.initialized && Config.instance ) {');
        assert.ok(fast > -1, 'one fast-path branch');
        assert.ok(lbcSrc.indexOf('config  = Config.instance;', fast) > -1, 'config is the singleton');
        assert.ok(lbcSrc.indexOf('conf    = Config.instance.envConf;', fast) > -1, 'conf is its envConf');
        assert.ok(lbcSrc.indexOf('config.setBundles(self.bundles);', fast) > fast, 'setBundles stays on the fallback only');
    });

    it('hasViews checks its memo before it resolves a Config', function () {
        var memo = hvSrc.indexOf('local.hasViews[bundle]');
        var ctor = hvSrc.indexOf('new Config()');
        assert.ok(memo > -1 && ctor > -1, 'both present');
        assert.ok(memo < ctor, 'the memo check comes first');
    });
});

describe('§02 behavioural — resolveRouteConfig, extracted', function () {

    function build(Config) {
        return new Function('Config', 'merge', 'return (' + rrcSrc + ');')(Config, function (a) { return a; });
    }
    function server500() {
        var sent = [];
        return { sent: sent, throwError: function (res, code, err) { sent.push({ code: code, err: err }); } };
    }

    it('initialised: five calls construct nothing and return the singleton envConf', function () {
        var E = envConf();
        var f = fakeConfig({ initialized: true, instance: { envConf: E }, getInstance: function () { throw new Error('getInstance must not run'); } });
        var rrc = build(f.Config), s = server500(), r = null;
        for (var i = 0; i < 5; i++) { r = rrc(s, { bundle: 'demo' }, {}, 'controller.js', {}); }
        assert.equal(f.calls.constructed, 0, 'no throwaway Config');
        assert.equal(s.sent.length, 0, 'no error response');
        assert.equal(r.config, E, 'the singleton envConf');
        assert.equal(r.conf, E.demo.prod);
        assert.equal(r.env, 'prod');
    });

    it('control: not initialised, every call goes through new Config().getInstance()', function () {
        var E = envConf();
        var f = fakeConfig({ getInstance: function () { return E; } });
        var rrc = build(f.Config), s = server500(), r = null;
        for (var i = 0; i < 5; i++) { r = rrc(s, { bundle: 'demo' }, {}, 'controller.js', {}); }
        assert.equal(f.calls.constructed, 5);
        assert.equal(f.calls.getInstance, 5);
        assert.equal(r.config, E);
    });

    it('control: a worker instance without Config.initialized goes through the old call', function () {
        var E = envConf();
        var f = fakeConfig({ instance: { envConf: {} }, getInstance: function () { return E; } });
        var r = build(f.Config)(server500(), { bundle: 'demo' }, {}, 'controller.js', {});
        assert.equal(f.calls.constructed, 1);
        assert.equal(r.config, E, 'what getInstance() returned, not the instance');
    });

    it('control: #B542 — an aborted init still reaches the 500 through getInstance()', function () {
        var f = fakeConfig({ getInstance: function () { throw new Error('[ CONFIG ] initialisation failed — boom'); } });
        var s = server500();
        var r = build(f.Config)(s, { bundle: 'demo' }, {}, 'controller.js', {});
        assert.equal(r, null);
        assert.equal(s.sent.length, 1);
        assert.equal(s.sent[0].code, 500);
        assert.ok(String(s.sent[0].err).indexOf('initialisation failed') > -1, 'the retained reason is named');
    });
});

describe('§02 behavioural — hasViews, extracted', function () {

    function build(Config, local) {
        return new Function('Config', 'local', 'self', 'return (' + hvSrc + ');')(Config, local, { env: 'prod' });
    }

    it('five calls for one bundle resolve the Config once', function () {
        var E = envConf();
        var f = fakeConfig({ getInstance: function () { return { envConf: E }; } });
        var local = { hasViews: {} }, hv = build(f.Config, local), v = null;
        for (var i = 0; i < 5; i++) { v = hv('demo'); }
        assert.equal(v, true);
        assert.equal(f.calls.constructed, 1, 'the memo answers the four later calls');
        assert.equal(local.hasViews.demo, true);
    });

    it('a memo hit resolves nothing', function () {
        var f = fakeConfig({ getInstance: function () { throw new Error('getInstance must not run'); } });
        var local = { hasViews: { demo: false } };
        assert.equal(build(f.Config, local)('demo'), false);
        assert.equal(f.calls.constructed, 0);
    });

    it('control: a bundle without templates answers false and is memoized', function () {
        var E = envConf();
        var f = fakeConfig({ getInstance: function () { return { envConf: E }; } });
        var local = { hasViews: {} };
        assert.equal(build(f.Config, local)('api'), false);
        assert.equal(local.hasViews.api, false);
        assert.equal(f.calls.constructed, 1);
    });
});

describe('§02 behavioural — loadBundleConfiguration, extracted', function () {

    function run(Config) {
        var self = { bundles: ['demo'], appName: 'demo', isStandalone: false, env: 'prod' };
        var captured = null;
        var lbc = new Function('Config', 'self', 'hasViews', 'onBundleConfigLoaded', 'return (' + lbcSrc + ');')(
            Config, self,
            function () { throw new Error('hasViews is reached only for a favicon path'); },
            function (bundle, options) { captured = { bundle: bundle, options: options }; }
        );
        lbc({ url: '/demo/page' }, {}, function () {}, function () {});
        return { self: self, captured: captured };
    }

    it('initialised: the singleton is handed on, its envConf becomes self.conf, setBundles never runs on it', function () {
        var E = envConf(), instanceSetBundles = 0;
        var instance = { envConf: E, setBundles: function () { instanceSetBundles++; } };
        var f = fakeConfig({ initialized: true, instance: instance, getInstance: function () { throw new Error('getInstance must not run'); } });
        var out = run(f.Config);
        assert.equal(f.calls.constructed, 0, 'no throwaway Config');
        assert.equal(out.captured.options.config, instance, 'the singleton is handed on');
        assert.equal(out.self.conf, E);
        assert.equal(instanceSetBundles, 0, 'setBundles never writes onto the singleton');
        assert.equal(out.captured.bundle, 'demo');
    });

    it('control: not initialised, the throwaway takes setBundles() and getInstance() as before', function () {
        var E = envConf();
        var f = fakeConfig({ getInstance: function () { return E; } });
        var out = run(f.Config);
        assert.equal(f.calls.constructed, 1);
        assert.equal(f.calls.getInstance, 1);
        assert.equal(f.calls.setBundles.length, 1);
        assert.deepEqual(f.calls.setBundles[0].bundles, ['demo']);
        assert.equal(out.captured.options.config, f.calls.setBundles[0].on, 'the throwaway is handed on');
        assert.equal(out.self.conf, E);
    });
});
