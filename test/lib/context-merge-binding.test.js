'use strict';
/**
 * helpers/context.js binds lib/merge ONCE at module scope (phase-2 per-request trims, slice F).
 *
 * Before this slice `setContext()` and the global `getConfig()` each resolved lib/merge with a
 * relative require on EVERY call, and the ContextHelper constructor once more. Node runs
 * Module._resolveFilename for that shape on every call (the relative-resolve cache never
 * short-circuits it — measured on Node 25: 3.0 µs and one resolution per call, a parent that
 * loaded the module first paying the same), and the router binds two contexts per routed
 * request (`isProxyHost`, `router`). lib/merge is plain-required by lib/index.js (never evicted
 * by the dev-mode refresh, #B32-residual) and requires nothing from the helpers, so a
 * module-level binding in the load-once helpers/context.js is the same exports object.
 *
 *  §01 source pins — on comment-stripped text: exactly ONE relative require of lib/merge in
 *      code, sitting at module scope (before the `function ContextHelper(` declaration). The raw
 *      text still carries the token, so a broken strip cannot satisfy the count vacuously.
 *  §02 behavioural — the source under test is compiled AS helpers/context.js
 *      (Module.prototype._compile with the real filename, so its relative requires resolve from
 *      helpers/), ContextHelper() re-installs the context globals from that text, and
 *      Module._resolveFilename is counted across 200 flat + 50 dotted setContext() calls: ZERO
 *      resolutions. Controls: the counter fires on a bare require(), and the contexts change
 *      through the compiled copy (flat write, dotted merge). getConfig()'s former per-call site
 *      is covered by §01's count only — its mock route returns before that line, so the site
 *      cannot be driven without a bundle context.
 *
 * Seam: GINA_CONTEXT_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/helpers/context.js` (the pre-slice bytes): §01's count (3 in code) and
 * position arms and §02's zero-resolution arm read RED; every control stays GREEN.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var Module = require('module');

var FW     = require('../fw');
var REAL   = path.join(FW, 'helpers/context.js');
var SOURCE = process.env.GINA_CONTEXT_SRC || REAL;
var NEEDLE = "require('./../lib/merge')";

var src, active;
before(function () {
    src = fs.readFileSync(SOURCE, 'utf8');
    // block comments out, then every full-line `//` comment (the file keeps a commented-out
    // logger require next to the binding)
    active = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
});

function count(hay, needle) { return hay.split(needle).length - 1; }

describe('§01 source pins — one module-level binding of lib/merge', function () {

    it('anti-vacuity: the raw text names the require and the strip kept the code', function () {
        assert.ok(count(src, NEEDLE) >= 1, 'the raw text carries the merge require');
        assert.ok(active.length < src.length, 'the strip removed comment text');
        assert.ok(active.indexOf('function ContextHelper(') > -1, 'the strip kept the declaration');
    });

    it('exactly one relative require of lib/merge remains in code', function () {
        assert.equal(count(active, NEEDLE), 1, 'setContext() and getConfig() must not resolve lib/merge per call');
    });

    it('that require binds `merge` at module scope, above the ContextHelper declaration', function () {
        var m = /^var merge\s*=\s*require\('\.\/\.\.\/lib\/merge'\);/m.exec(active);
        assert.ok(m, 'a module-level `var merge = require(...)` binding');
        assert.ok(m.index < active.indexOf('function ContextHelper('), 'the binding precedes the constructor');
    });
});

describe('§02 behavioural — setContext() resolves no module per call', function () {

    var resolutions = 0, orig = null;

    before(function () {
        // Load order is the instrument. Node's relative-resolve cache is keyed by the requiring
        // module's DIRECTORY plus the request string and is filled only when a module is first
        // LOADED through that pair — a cache hit on an already-loaded module skips the insert. A
        // production boot loads lib/merge through lib/logger first, so helpers/path.js's own
        // `./../lib/merge` request is a cache hit that never primes the pair, and every later
        // relative require from helpers/ pays a full resolution. Loading lib/merge by absolute
        // path first reproduces that shape; loading the helpers first would prime the pair and
        // let the pre-slice per-call require read as free.
        require(path.join(FW, 'lib/merge'));
        // the real helpers next (every other global the helper family expects), then the text
        // under test compiled as the same file so ITS ContextHelper installs the context globals
        require(path.join(FW, 'helpers'));
        var m = new Module(REAL, null);
        m.filename = REAL;
        m.paths = Module._nodeModulePaths(path.dirname(REAL));
        m._compile(src, REAL);
        m.exports();
        orig = Module._resolveFilename;
        Module._resolveFilename = function () { resolutions++; return orig.apply(this, arguments); };
    });

    after(function () {
        if (orig) { Module._resolveFilename = orig; }
    });

    it('control: the counter fires on a bare require()', function () {
        // a builtin request: it never primes the relative-resolve cache, so it is resolved on
        // every call — repeating the absolute lib/merge request of before() would be swallowed
        // by that cache, the very mechanism the next arm measures
        var seen = resolutions;
        require('os');
        assert.ok(resolutions > seen, 'a require() must be counted');
    });

    it('200 flat + 50 dotted setContext() calls resolve no module', function () {
        var seen = resolutions;
        for (var i = 0; i < 200; i++) { setContext('isProxyHost', (i & 1) === 0); }
        for (var j = 0; j < 50; j++) { setContext('p2f.probe.k' + (j % 5), j); }
        assert.equal(resolutions - seen, 0, 'no Module._resolveFilename across 250 setContext() calls');
    });

    it('control: the compiled copy runs the contexts (flat write, dotted merge, target-wins)', function () {
        setContext('p2fFlat', 'v1');
        assert.equal(getContext('p2fFlat'), 'v1');
        setContext('p2f.dot.a', 1);
        setContext('p2f.dot.b', 2);
        assert.deepEqual(getContext('p2f').dot, { a: 1, b: 2 });
        // the dotted branch merges without force, and lib/merge is target-wins at the leaf: the
        // previous arm wrote k0..k4 ten times each and the FIRST value of each key stays
        assert.deepEqual(getContext('p2f').probe, { k0: 0, k1: 1, k2: 2, k3: 3, k4: 4 }, 'the dotted writes of the previous arm landed, first value kept');
    });
});
