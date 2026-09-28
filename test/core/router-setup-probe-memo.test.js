'use strict';
/**
 * core/router.js probes a bundle's `controllers/setup.js` once per bundle in production
 * (phase-2 per-request trims, slice G).
 *
 * Before this slice route() constructed the path object and probed the file on EVERY routed
 * request — an accessSync throw plus an lstatSync throw whenever the file was absent — although
 * nothing evicts a controller's require cache in production, so the answer cannot change there
 * without a restart. The probe now lives in the private `resolveSetupFile()`: memoized by bundle
 * name when `isCacheless` is false, probed per call when it is true (the dev eviction block in
 * route() depends on the fresh answer).
 *
 *  §01 source pins — the memo and the helper are declared once at module scope, route() calls
 *      the helper once, and the retired per-request shape is gone from code.
 *  §02 behavioural — the helper is brace-walk-extracted from the source under test and compiled
 *      with a fake path class and a fresh memo: in production one construction and one probe per
 *      bundle across five calls, two bundles memoized independently; in dev five constructions and
 *      five probes; the resolved path string is exact in both modes.
 *
 * Seam: GINA_ROUTER_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/core/router.js`: the pre-slice bytes hold no helper, so §01's declaration
 * pins read RED and §02's extraction control reads RED (its arms then cannot run) — the negative
 * pin on the retired shape reads RED too; nothing passes vacuously.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_ROUTER_SRC || path.join(FW, 'core/router.js');
var DECL   = 'var resolveSetupFile = function(bundle, bundlesPath, isCacheless) {';

var src, active;
before(function () {
    src = fs.readFileSync(SOURCE, 'utf8');
    active = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
});

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

describe('§01 source pins — a memoized, module-scoped probe', function () {

    it('the helper and its memo are declared exactly once', function () {
        assert.equal(count(active, DECL), 1, 'one resolveSetupFile declaration');
        assert.equal(count(active, 'var _setupFileMemo = Object.create(null);'), 1, 'one memo declaration');
    });

    it('route() resolves the probe through the helper, once', function () {
        assert.equal(count(active, 'resolveSetupFile(bundle, conf.bundlesPath, isCacheless)'), 1);
        assert.equal(count(active, 'hasSetup = setupProbe.exists;'), 1);
    });

    it('the retired per-request shape is gone from code', function () {
        assert.equal(count(active, ', setupFile     = setupFileObj.toString()'), 0, 'the old inline construction');
    });
});

describe('§02 behavioural — the extracted helper, driven with a fake path class', function () {

    var fnSrc = null, factory = null;

    before(function () {
        fnSrc = extractFn(active, DECL);
        if (fnSrc) {
            factory = new Function('_', '_setupFileMemo', 'return (' + fnSrc + ');');
        }
    });

    it('control: the helper extracts once, brace-balanced', function () {
        assert.ok(fnSrc, 'resolveSetupFile must be extractable from the source under test');
        assert.equal(count(active, DECL), 1);
        assert.equal(count(fnSrc, '{'), count(fnSrc, '}'));
    });

    function scene(exists) {
        var calls = { constructed: 0, probed: 0 };
        function FakePath(p) { this.p = p; calls.constructed++; }
        FakePath.prototype.toString = function () { return this.p; };
        FakePath.prototype.existsSync = function () { calls.probed++; return exists[this.p] === true; };
        var memo = Object.create(null);
        return { calls: calls, resolve: factory(FakePath, memo), memo: memo };
    }

    it('production: one construction and one probe per bundle across five calls, memoized per bundle', function () {
        var s = scene({ '/srv/app/src/demo/controllers/setup.js': true });
        var p = null;
        for (var i = 0; i < 5; i++) { p = s.resolve('demo', '/srv/app/src', false); }
        assert.deepEqual(p, { file: '/srv/app/src/demo/controllers/setup.js', exists: true });
        assert.equal(s.calls.constructed, 1, 'the path object is constructed once');
        assert.equal(s.calls.probed, 1, 'existsSync runs once');
        var q = s.resolve('api', '/srv/app/src', false);
        assert.deepEqual(q, { file: '/srv/app/src/api/controllers/setup.js', exists: false });
        assert.equal(s.calls.probed, 2, 'a second bundle is probed once more');
        assert.equal(Object.keys(s.memo).length, 2, 'both bundles memoized');
    });

    it('dev: five calls probe five times and memoize nothing', function () {
        var s = scene({ '/srv/app/src/demo/controllers/setup.js': true });
        var p = null;
        for (var i = 0; i < 5; i++) { p = s.resolve('demo', '/srv/app/src', true); }
        assert.deepEqual(p, { file: '/srv/app/src/demo/controllers/setup.js', exists: true });
        assert.equal(s.calls.constructed, 5);
        assert.equal(s.calls.probed, 5);
        assert.equal(Object.keys(s.memo).length, 0);
    });
});
