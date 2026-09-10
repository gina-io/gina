'use strict';
/**
 * #B537 — getRoute() hands back a BOOLEAN route.isProxyHost to a req-less caller
 * whose process never set the proxied-context latch.
 *
 * On the server, getRoute() resolves the proxied classification from the request
 * store first and falls back to getContext('isProxyHost') for a req-less caller
 * (boot, CLI, cron, a bundle's setup hook). The boot-time writer of that latch
 * runs only when the project's proxy configuration resolved a record for the
 * running scope and env, so a bundle whose proxy configuration exists but carries
 * no such record boots with the latch UNSET — and the fallback is a plain property
 * read that returns `undefined`. The route then carried `isProxyHost: undefined`:
 * every consumer reads the flag by truthiness, so no behaviour hinged on it, but
 * the server-side JSON.clone treats an undefined value as a suspected authoring
 * error and logged a warning with a stack, on a hot path, for a value that was
 * legitimately unset. The fix coerces the fallback with the `|| false` idiom the
 * sibling readers of the same latch already use, so the route always carries a
 * boolean and a clone of it is silent.
 *
 * Coverage — REAL-module drives in the harness the sibling routing tests use:
 *   §01 latch unset, no request store  → route.isProxyHost === false      (pre-fix: undefined)
 *   §02 cloning that route is silent, and the clone carries the boolean     (pre-fix: one warning, null)
 *       — with a can-fail instrument arm: a genuinely-undefined key MUST warn exactly once
 *   §03 latch true with a resolvable proxy hostname → proxied route, unchanged (positive control)
 *   §04 the request store wins over the latch, both ways (the #B502 contract, unchanged)
 *   §05 a frozen pre-fix copy of the module, driven through the same harness, still
 *       yields undefined + one warning — proves this harness can see the defect
 *   §06 source + dist pins: exactly one coerced fallback, the bare read is not live
 *       code, the downstream assignment is untouched, and the bundled copy carries the fix
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('node:fs');
var path   = require('node:path');
var Module = require('node:module');
var { AsyncLocalStorage } = require('node:async_hooks');

var FW          = require('../fw');
var REPO        = path.join(FW, '..', '..');
var ROUTING_SRC = path.join(FW, 'lib/routing/src/main.js');
var DIST_JS     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');

// -- real-module harness (node:test runs each file in its own process) --
process.env.NODE_ENV_IS_DEV = process.env.NODE_ENV_IS_DEV || 'false';
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
Module._initPaths();
require(path.join(FW, 'helpers'));                // installs setContext/getContext, _, requireJSON …
require(path.join(REPO, 'utils', 'prototypes')); // installs JSON.clone (the warning emitter), count() …
/* global setContext, getContext */
process.gina = process.gina || {};

var SRC   = fs.readFileSync(ROUTING_SRC, 'utf8');
var FIXED = "isProxyHost = ( _stProxy ) ? _stProxy.isProxyHost : ( getContext('isProxyHost') || false );";
var BARE  = "isProxyHost = ( _stProxy ) ? _stProxy.isProxyHost : getContext('isProxyHost');";

var TABLE = {
    'probe@testb': { method: 'GET', url: '/probe', bundle: 'testb', hostname: 'https://direct.internal:3999', webroot: '/', param: { control: 'render', file: 'probe' }, requirements: {}, middleware: [] }
};
setContext('gina', { config: { env: 'dev', bundle: 'testb', getRouting: function () { return TABLE; }, envConf: {} } });

var routing = require(ROUTING_SRC);               // the module exports a ready instance

/** The latch is a plain key on the contexts map — removing it is what "never set" looks like. */
function unsetLatch() { delete getContext()['isProxyHost']; }

function resetState() {
    unsetLatch();
    delete process.gina.PROXY_HOSTNAME;
    delete process.gina._reqALS;
    var g = getContext('gina');
    if (g && g.config && g.config.envConf) { delete g.config.envConf._proxyHostname; }
}

/** Clone with the real JSON.clone, capturing every warning it emits. */
function cloneCapturingWarns(obj) {
    var warns = [];
    var orig  = console.warn;
    console.warn = function (m) { warns.push(String(m)); };
    try { return { clone: JSON.clone(obj), warns: warns }; } finally { console.warn = orig; }
}
function isProxyHostWarns(warns) { return warns.filter(function (w) { return /source\[isProxyHost\] is undefined/.test(w); }); }

describe('#B537 — route.isProxyHost is always a boolean (real lib/routing)', function () {

    it('01 — latch unset + no request store: route.isProxyHost is the boolean false', function () {
        resetState();
        assert.equal(typeof getContext('isProxyHost'), 'undefined', 'precondition: the latch is unset');
        assert.equal(process.gina._reqALS, undefined, 'precondition: no request store');
        var route = routing.getRoute('probe@testb', {});
        assert.equal(typeof route.isProxyHost, 'boolean', 'the flag must be a boolean');
        assert.equal(route.isProxyHost, false);
        assert.equal(route.toUrl(), 'https://direct.internal:3999/probe', 'a direct route builds its direct hostname');
    });

    it('02 — cloning that route is silent, and the clone carries the boolean', function () {
        resetState();
        var r = cloneCapturingWarns(routing.getRoute('probe@testb', {}));
        assert.deepEqual(isProxyHostWarns(r.warns), [], 'no clone warning for isProxyHost');
        assert.equal(r.clone.isProxyHost, false, 'the clone must carry false, not the null the warning path assigns');
        // instrument arm — the capture must be able to fire, or the assertion above is vacuous
        var ctl = cloneCapturingWarns({ x: undefined, y: 1 });
        assert.equal(ctl.warns.filter(function (w) { return /source\[x\] is undefined/.test(w); }).length, 1,
            'control: a genuinely-undefined key warns exactly once');
        assert.equal(ctl.clone.x, null, 'control: the warning path assigns null');
    });

    it('03 — control: latch true with a resolvable proxy hostname keeps the proxied route', function () {
        resetState();
        setContext('isProxyHost', true);
        process.gina.PROXY_HOSTNAME = 'https://public.example';
        try {
            var route = routing.getRoute('probe@testb', {});
            assert.equal(route.isProxyHost, true);
            assert.equal(route.proxy_hostname, 'https://public.example');
            assert.match(route.toUrl(), /^https:\/\/public\.example\/probe/);
        } finally { resetState(); }
    });

    it('04 — the request store wins over the latch, both ways (#B502 contract unchanged)', async function () {
        resetState();
        var als = process.gina._reqALS = new AsyncLocalStorage();
        setContext('isProxyHost', true);
        process.gina.PROXY_HOSTNAME = 'https://poisoned.example';
        try {
            var direct = await als.run({ proxy: { isProxyHost: false, proxyHostname: null, proxyHost: null } }, async function () {
                return routing.getRoute('probe@testb', {});
            });
            assert.equal(direct.isProxyHost, false, 'a request classified direct ignores the poisoned latch');
            assert.equal(direct.toUrl(), 'https://direct.internal:3999/probe');

            unsetLatch();
            delete process.gina.PROXY_HOSTNAME;
            var proxied = await als.run({ proxy: { isProxyHost: true, proxyHostname: 'https://real.public', proxyHost: 'real.public' } }, async function () {
                return routing.getRoute('probe@testb', {});
            });
            assert.equal(proxied.isProxyHost, true, 'a request classified proxied is proxied even with the latch unset');
            assert.equal(proxied.proxy_hostname, 'https://real.public');
        } finally { resetState(); }
    });

    describe('05 — subtract: a frozen pre-fix copy of the module still shows the defect', function () {
        var frozen = null;
        before(function () {
            assert.equal(SRC.split(FIXED).length, 2, 'exactly one coerced fallback in the live source');
            var pre = SRC.replace(FIXED, BARE);
            assert.notEqual(pre, SRC, 'the subtract must change the bytes it executes');
            // A second, independent instance compiled from the pre-fix bytes: the real
            // filename keeps its relative requires resolving; it is never registered in
            // the require cache, so the live instance above is untouched.
            var m = new Module(ROUTING_SRC, module);
            m.filename = ROUTING_SRC;
            m.paths    = Module._nodeModulePaths(path.dirname(ROUTING_SRC));
            m._compile(pre, ROUTING_SRC);
            frozen = m.exports;
            assert.equal(typeof frozen.getRoute, 'function', 'the frozen copy exposes getRoute');
        });

        it('the pre-fix bytes hand back undefined', function () {
            resetState();
            assert.equal(frozen.getRoute('probe@testb', {}).isProxyHost, undefined);
        });

        it('and cloning that route warns exactly once for isProxyHost, assigning null', function () {
            resetState();
            var r = cloneCapturingWarns(frozen.getRoute('probe@testb', {}));
            assert.equal(isProxyHostWarns(r.warns).length, 1, 'the harness must see the defect on the pre-fix bytes');
            assert.equal(r.clone.isProxyHost, null);
        });
    });

    describe('06 — source and dist pins', function () {
        var ACTIVE = SRC.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');

        it('exactly one coerced fallback, and the bare read is not live code', function () {
            assert.equal(ACTIVE.split(FIXED).length, 2, 'one coerced fallback site');
            assert.equal(ACTIVE.indexOf(BARE), -1, 'the bare read must not be live code');
        });

        it('the downstream assignment is untouched (the sibling region anchors stay valid)', function () {
            assert.ok(ACTIVE.indexOf('route.isProxyHost = isProxyHost;') > -1);
        });

        it('the bundled copy carries the coerced fallback (lib/routing is browser-bundled)', function () {
            assert.ok(fs.readFileSync(DIST_JS, 'utf8').indexOf(FIXED) > -1, 'dist/vendor/gina/js/gina.js must be rebuilt from this source');
        });
    });
});
