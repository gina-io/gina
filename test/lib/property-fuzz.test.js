'use strict';
/**
 * #S14 — property-based ("fuzz") tests of the request-path guards that have each had a
 * crash or pollution class, using fast-check. Two purposes:
 *   1. Scorecard's Fuzzing check (checks/raw/fuzzing.go): a `*.js` file that
 *      `require('fast-check')` is what it detects for JavaScript.
 *   2. Real property coverage of the guards #B30 / #B446 / #B588–#B592 / #B792 closed —
 *      property 2 is the one that FOUND #B792 (a null slot planted by a JSON value made
 *      `formatDataFromString` throw); it now stands as that fix's fuzz regression.
 *
 * Determinism: a fixed default seed and run count so CI never reds at random, both
 * overridable for local exploration:
 *   GINA_FUZZ_SEED=<int>   (default 0x5EED)
 *   GINA_FUZZ_RUNS=<int>   (default 2000)
 * A failing property is a FINDING to surface and stake — never something to weaken.
 *
 * Run standalone: node --test test/lib/property-fuzz.test.js
 *                 bun test --isolate test/lib/property-fuzz.test.js
 */
var { describe, it, before, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fc     = require('fast-check');
var FW     = require('../fw');

require(path.join(FW, 'helpers', 'data', 'src', 'main.js'))();   // installs the implicit globals
var merge       = require(path.join(FW, 'lib', 'merge', 'src', 'main.js'));
var RenderCache = require(path.join(FW, 'lib', 'render-cache', 'src', 'main'));

var SEED = process.env.GINA_FUZZ_SEED ? parseInt(process.env.GINA_FUZZ_SEED, 10) : 0x5EED;
var RUNS = process.env.GINA_FUZZ_RUNS ? parseInt(process.env.GINA_FUZZ_RUNS, 10) : 2000;
var OPTS = { seed: SEED, numRuns: RUNS };

var PROTO_SEGMENTS = ['__proto__', 'constructor', 'prototype'];
/** Delete anything a pollution arm may have planted on Object.prototype. */
function scrub() {
    ['polluted', 'POLLUTED', 'x', 'y', 'z', 'evil'].forEach(function (k) { delete Object.prototype[k]; });
}
afterEach(scrub);

// formatDataFromString logs one metadata-only `[365]` line per malformed JSON-leading
// document (#B590 — the input is never logged); the fuzz drives thousands of those, so
// silence console.error for the run (the same quieting the #B591/#B446 tests do).
var origError = null;
before(function () { origError = console.error; console.error = function () {}; });
process.on('exit', function () { if (origError) console.error = origError; });

describe('#S14 property 1 — safeDecodeURIComponent / safeDecodeURI never throw and return a string', function () {
    it('safeDecodeURIComponent returns a string for any input (incl. malformed %)', function () {
        fc.assert(fc.property(fc.string(), function (s) {
            var out = safeDecodeURIComponent(s);
            return typeof out === 'string';
        }), OPTS);
    });
    it('safeDecodeURI returns a string for any input', function () {
        fc.assert(fc.property(fc.string(), function (s) {
            return typeof safeDecodeURI(s) === 'string';
        }), OPTS);
    });
    it('round-trips an encoded component back to itself', function () {
        fc.assert(fc.property(fc.string(), function (s) {
            return safeDecodeURIComponent(encodeURIComponent(s)) === s;
        }), OPTS);
    });
    it('explicit malformed-% cases do not throw (the #B30 class)', function () {
        ['100%', '%', '%zz', '%E0%A', 'a%', '%%%'].forEach(function (s) {
            assert.equal(typeof safeDecodeURIComponent(s), 'string');
            assert.equal(typeof safeDecodeURI(s), 'string');
        });
    });
});

describe('#S14 property 2 — formatDataFromString never throws and never pollutes (the #B588–#B592 / #B792 class)', function () {
    it('never throws on arbitrary urlencoded-shaped input', function () {
        fc.assert(fc.property(fc.string(), function (body) {
            formatDataFromString(body);          // must not throw
            return true;
        }), OPTS);
    });
    it('never throws on key=value pairs built from arbitrary tokens, values, and bracket paths', function () {
        var seg = fc.oneof(fc.string(), fc.constantFrom.apply(fc, PROTO_SEGMENTS), fc.constantFrom('0', '1', 'a', 'x'));
        var pair = fc.tuple(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.string());
        fc.assert(fc.property(fc.array(pair, { maxLength: 6 }), function (pairs) {
            var body = pairs.map(function (p) {
                var key = p[0][0] + p[0].slice(1).map(function (s) { return '[' + s + ']'; }).join('');
                return encodeURIComponent(key) + '=' + encodeURIComponent(p[1]);
            }).join('&');
            formatDataFromString(body);          // #B591/#B792: must not throw
            return true;
        }), OPTS);
    });
    it('#B792 regression — a JSON value planting null in a slot a later path descends into never throws', function () {
        var leaf = fc.constantFrom('1', 'x', '');
        fc.assert(fc.property(leaf, function (v) {
            var out = formatDataFromString('a=[null]&a[0][b]=' + v);   // the exact #B792 shape
            return out && typeof out === 'object';
        }), OPTS);
        assert.deepEqual(formatDataFromString('a=[null]&a[0][b]=1'), { a: [ { b: '1' } ] });
    });
    it('a key path through __proto__/constructor/prototype never reaches Object.prototype', function () {
        var seg = fc.oneof(fc.constantFrom.apply(fc, PROTO_SEGMENTS), fc.constantFrom('polluted', 'x', 'a'));
        fc.assert(fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), fc.string(), function (segs, val) {
            var key = segs[0] + segs.slice(1).map(function (s) { return '[' + s + ']'; }).join('');
            formatDataFromString(encodeURIComponent(key) + '=' + encodeURIComponent(val));
            var clean = ({}).polluted === undefined && ({}).x === undefined;
            scrub();
            return clean;
        }), OPTS);
    });
});

describe('#S14 property 3 — merge never pollutes Object.prototype from a JSON source (the #B446 class)', function () {
    // A TEST of lib/merge only — lib/merge is never edited here (the merge-edit HARD RULE
    // governs EDITS; reading it in a test is not one).
    it('merging JSON.parse output carrying __proto__ keys leaves Object.prototype untouched', function () {
        var keyArb = fc.oneof(fc.constantFrom.apply(fc, PROTO_SEGMENTS), fc.constantFrom('a', 'b', 'polluted'));
        var jsonArb = fc.dictionary(keyArb, fc.oneof(fc.string(), fc.integer(), fc.constant({ polluted: 'OWNED' })), { maxKeys: 5 });
        fc.assert(fc.property(jsonArb, fc.boolean(), function (obj, override) {
            var text = JSON.stringify(obj);
            // JSON.parse produces an OWN __proto__ key, the #B446 vector
            merge({}, JSON.parse(text), override);
            var clean = ({}).polluted === undefined;
            scrub();
            return clean;
        }), OPTS);
    });
});

describe('#S14 property 4 — RenderCache.resolveCacheRoot never throws and returns a string', function () {
    it('returns a string for arbitrary sources and tokens', function () {
        var blockArb = fc.option(fc.record({
            path: fc.option(fc.string(), { nil: undefined }),
            cachePath: fc.option(fc.string(), { nil: undefined })
        }, { requiredKeys: [] }), { nil: null });
        var sourcesArb = fc.record({
            subFile:  fc.option(blockArb, { nil: null }),
            settings: fc.option(fc.record({ server: fc.record({ cache: blockArb }, { requiredKeys: [] }) }, { requiredKeys: [] }), { nil: null }),
            envBlock: fc.option(blockArb, { nil: null })
        }, { requiredKeys: [] });
        var tokensArb = fc.record({
            projectPath:   fc.option(fc.string(), { nil: undefined }),
            executionPath: fc.option(fc.string(), { nil: undefined }),
            bundle:        fc.option(fc.string(), { nil: undefined })
        }, { requiredKeys: [] });
        fc.assert(fc.property(sourcesArb, tokensArb, function (sources, tokens) {
            return typeof RenderCache.resolveCacheRoot(sources, tokens) === 'string';
        }), OPTS);
    });
});
