'use strict';
/**
 * core/server.isaac.js looks the output cache up only while `server.cache.enable` is on
 * (phase-2 per-request trims, slice H).
 *
 * The built-in engine's pre-routing cache read used to run whenever the process was NOT in dev
 * mode, whatever the cache flag said: `renderCache.from()` plus two `has()` lookups per GET,
 * each falling through to an `fs.existsSync()` on a bundle with no cache configured. Every
 * writer refuses to store while the flag is off (render-swig and render-json `writeCache`), and
 * the engine-agnostic read in server.js gates on the same flag — so the ungated read could only
 * ever find an entry left on disk by an earlier run that had caching enabled, and serve it while
 * the cache was disabled.
 *
 *  §01 source pins — inside the block that precedes the "Importing cache handler" banner (a
 *      stable, unique comment): the gate is the enable-flag test immediately followed by the GET
 *      check, and the stripped block no longer tests `isCacheless` ahead of it.
 *  §02 behavioural — the gate's condition is extracted from that block and evaluated over the
 *      four (dev, flag) states: it opens only when the flag reads 'true'.
 *
 * Seam: GINA_ISAAC_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/core/server.isaac.js`: the pre-slice gate (`!isCacheless || …`) reads RED
 * on §01's adjacency and negative pins and on §02's production-with-cache-disabled arm; the
 * three other truth-table arms are controls and stay GREEN.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var BANNER = '// Importing cache handler (render/output cache goes through the strategy dispatcher)';
var GATE   = "if ( String(server._cacheIsEnabled).toLowerCase() === 'true' ) {";
var GET    = "if ( request.method.toUpperCase() === 'GET' ) {";

var src, block, active;
before(function () {
    src = fs.readFileSync(SOURCE, 'utf8');
    var at = src.indexOf(BANNER);
    block = at > -1 ? src.slice(Math.max(0, at - 1400), at) : '';
    active = block.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
});

describe('§01 source pins — the gate is the enable flag alone', function () {

    it('control: the banner anchor is unique and the block holds the GET check', function () {
        assert.equal(src.split(BANNER).length - 1, 1, 'one banner');
        assert.ok(active.indexOf(GET) > -1, 'the GET check sits in the sliced block');
    });

    it('the enable-flag gate immediately precedes the GET check', function () {
        var g = active.lastIndexOf(GATE, active.indexOf(GET));
        assert.ok(g > -1, 'the enable-flag gate must open the block');
        assert.match(active.slice(g + GATE.length, active.indexOf(GET)), /^\s*$/, 'nothing between the gate and the GET check');
    });

    it('the block no longer tests isCacheless ahead of the GET check', function () {
        assert.equal(active.slice(0, active.indexOf(GET)).indexOf('isCacheless'), -1, 'the retired `!isCacheless ||` disjunct');
    });
});

describe('§02 behavioural — the extracted condition over the four (dev, flag) states', function () {

    var gate = null;

    before(function () {
        var m = /if \(([^{]*?)\) \{\s*if \( request\.method\.toUpperCase\(\) === 'GET' \)/.exec(active);
        if (m) { gate = new Function('isCacheless', 'server', 'return !!(' + m[1] + ');'); }
    });

    it('control: a gate condition precedes the GET check', function () {
        assert.ok(gate, 'the condition must be extractable');
    });

    it('control: production with the cache enabled opens the block', function () {
        assert.equal(gate(false, { _cacheIsEnabled: 'true' }), true);
    });

    it('production with the cache disabled skips the block', function () {
        assert.equal(gate(false, { _cacheIsEnabled: 'false' }), false);
        assert.equal(gate(false, { _cacheIsEnabled: undefined }), false);
    });

    it('control: dev opens the block only with the cache enabled', function () {
        assert.equal(gate(true, { _cacheIsEnabled: 'true' }), true);
        assert.equal(gate(true, { _cacheIsEnabled: 'false' }), false);
    });
});
