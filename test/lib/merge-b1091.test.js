'use strict';
/**
 * #B1091 — `merge()` never returned, and grew the caller's SOURCE array until the heap
 * ran out, when an array inside an object the target lacks held object elements and
 * then `NaN`.
 *
 * `mergeArray` pushes a primitive the result lacks after the test
 * `newTarget.indexOf(value) == -1`, and `indexOf` never finds `NaN`. On #B436's
 * createMode pass (`mergeArray(A, A)`, for an array inside an object the target lacks)
 * the second object element finds a hole in the deduped rebuild, the index-merge branch
 * rebinds `newTarget` to the source array itself, and each `NaN` the loop reaches is
 * then pushed onto the array it walks: the loop over its length never ends. Merging an
 * array with itself (`merge(A, A)`) takes the same path. Elsewhere `NaN` broke the
 * documented union rule: `[1, NaN]` + `[NaN, 2]` gave `[1, NaN, NaN, 2]`, and merging the
 * same source a second time pushed another `NaN`.
 *
 * Fix: the primitive push also asks, for `NaN` only, whether the result already holds
 * a `NaN` (`options[a] === options[a] || !newTarget.some(isNaNElement)`, ES5 for the
 * browser bundle; the helper is a module-level function, so Closure keeps inlining
 * #B1078's `collectionAddsNothing` into `mergeArray`, which a function expression at
 * this site stopped). Every other value takes the test it took before.
 *
 * Covered (BEHAVIOURAL unless marked — the real lib is driven):
 *   01  the runaway shapes return, with `NaN` once, and leave the source untouched
 *       (RED pre-fix: a growth guard on the source arrays throws)
 *   02  the union rule holds for `NaN` (RED pre-fix; values read on the pre-fix bytes)
 *   03  controls: every other value merges as before (green on both revisions)
 *   04  the browser bundle's realm: the polyfill and this source in a fresh vm realm
 *   05  source pins
 *   06  dist pins: gina.js verbatim, gina.min.js by shape (RED before the rebuild)
 *
 * Red-first: §01, §02, §04's NaN arm, §05 and §06 fail on the pre-fix bytes; §03 and
 * §04's control pass on both revisions.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var vm     = require('vm');

var FRAMEWORK = path.resolve(require('../fw'));
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/merge/src/main.js');
var POLYFILL  = path.join(FRAMEWORK, 'core/asset/plugin/src/vendor/gina/utils/polyfill.js');
var DIST_JS   = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN  = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var merge     = require(path.join(FRAMEWORK, 'lib/merge'));

/** The source line of the primitive push, as fixed. */
var FIXED_LINE   = "else if (newTarget.indexOf(options[a]) == -1 && ( typeof(options[a]) != 'object' || options[a] === null ) && ( options[a] === options[a] || !newTarget.some(isNaNElement) )) {";
/** The line it replaced (#B226's), kept in the source as a `// was:` record. */
var RETIRED_LINE = "else if (newTarget.indexOf(options[a]) == -1 && ( typeof(options[a]) != 'object' || options[a] === null )) {";

/**
 * Gives every array reachable from `x` a non-enumerable own `push` that throws `GREW`
 * past 1,000 elements, so a merge that keeps pushing onto an argument fails at once
 * instead of exhausting the heap.
 */
function guard(x, seen) {
    seen = seen || [];
    if (x === null || typeof x !== 'object' || seen.indexOf(x) > -1) return x;
    seen.push(x);
    if (Array.isArray(x)) {
        Object.defineProperty(x, 'push', {
            value: function () {
                if (this.length >= 1000) throw new Error('GREW');
                return Array.prototype.push.apply(this, arguments);
            },
            enumerable: false, configurable: true, writable: true
        });
    }
    Object.keys(x).forEach(function (k) { guard(x[k], seen); });
    return x;
}

/** Number of times `needle` occurs in `hay`. */
function count(hay, needle) { return hay.split(needle).length - 1; }

/** Code lines only: JSDoc / block-comment lines dropped, whole-line `//` comments dropped. */
function codeOf(text) {
    return text.split('\n')
        .filter(function (l) { return !/^\s*(\/\*\*|\*|\/\/)/.test(l); })
        .join('\n');
}


// ─── 01  the runaway shapes ──────────────────────────────────────────────────
describe('01 - an array holding objects and then NaN merges once, and the source is untouched', function () {
    it('an array inside an object the target lacks (createMode)', function () {
        var l = [{ a: 1 }, { b: 2 }, NaN], src = guard({ w: { l: l } });
        var r = merge({}, src);
        assert.deepEqual(r, { w: { l: [{ a: 1 }, { b: 2 }, NaN] } });
        assert.equal(l.length, 3, 'the source array is untouched');
    });

    it('an array merged with itself', function () {
        var A = guard([{ a: 1 }, { b: 2 }, NaN]);
        var r = merge(A, A);
        assert.deepEqual(r, [{ a: 1 }, { b: 2 }, NaN]);
        assert.equal(A.length, 3);
    });

    it('the same array at a top-level key the target lacks keeps one NaN (it gave two)', function () {
        var l = [{ a: 1 }, { b: 2 }, NaN], src = guard({ l: l });
        assert.deepEqual(merge({}, src), { l: [{ a: 1 }, { b: 2 }, NaN] });
        assert.equal(l.length, 3);
    });

    it('two NaN after the objects give one', function () {
        var src = guard({ w: { l: [{ a: 1 }, { b: 2 }, NaN, NaN] } });
        assert.deepEqual(merge({}, src), { w: { l: [{ a: 1 }, { b: 2 }, NaN] } });
    });
});


// ─── 02  the union rule ──────────────────────────────────────────────────────
describe('02 - NaN follows the union rule: a value already present is never pushed again', function () {
    it('[1, NaN] + [NaN, 2] gives [1, NaN, 2] (it gave [1, NaN, NaN, 2])', function () {
        assert.deepEqual(merge([1, NaN], [NaN, 2]), [1, NaN, 2]);
    });

    it('[NaN] + [NaN, NaN] gives [NaN] (it gave three NaN)', function () {
        assert.deepEqual(merge([NaN], [NaN, NaN]), [NaN]);
    });

    it('a nested array the target holds: [NaN] + [NaN, 3] gives [NaN, 3]', function () {
        assert.deepEqual(merge({ w: { l: [NaN] } }, { w: { l: [NaN, 3] } }), { w: { l: [NaN, 3] } });
    });

    it('merging the same source a second time is a no-op', function () {
        var t = { l: [1, NaN] };
        merge(t, { l: [NaN, 2] });
        assert.deepEqual(t, { l: [1, NaN, 2] });
        merge(t, { l: [NaN, 2] });
        assert.deepEqual(t, { l: [1, NaN, 2] });
    });
});


// ─── 03  controls ────────────────────────────────────────────────────────────
describe('03 - controls: every other value merges as before (values read on the pre-fix bytes)', function () {
    it('one object then NaN, no NaN, and NaN before the objects', function () {
        assert.deepEqual(merge({}, { w: { l: [{ a: 1 }, NaN] } }), { w: { l: [{ a: 1 }, NaN] } });
        assert.deepEqual(merge({}, { w: { l: [{ a: 1 }, { b: 2 }, 7] } }), { w: { l: [{ a: 1 }, { b: 2 }, 7] } });
        assert.deepEqual(merge({}, { w: { l: [NaN, { a: 1 }, { b: 2 }] } }), { w: { l: [NaN, { a: 1 }, { b: 2 }] } });
        assert.deepEqual(merge({ w: { l: [{ a: 1 }] } }, { w: { l: [{ a: 1 }, { b: 2 }, NaN] } }), { w: { l: [{ a: 1 }, { b: 2 }, NaN] } });
    });

    it('numbers are topped up by count; strings, Infinity and null keep their rules', function () {
        assert.deepEqual(merge([25], [25, 25]), [25, 25]);
        assert.deepEqual(merge(['NaN'], ['NaN', 'x']), ['NaN', 'x']);
        assert.deepEqual(merge([Infinity], [Infinity, 1]), [Infinity, 1]);
        assert.deepEqual(merge([1, 2], [3, 4]), [1, 2, 3, 4]);
        assert.deepEqual(merge({ ports: [8080, 8124] }, { ports: [8124] }), { ports: [8080, 8124] });
        assert.deepEqual(merge({ a: [null, 'x'] }, { a: [null, 'x'] }), { a: [null, 'x'] });
    });

    it('override: the source wins as before', function () {
        assert.deepEqual(merge([1, NaN], [NaN, 2], true), [NaN, 2]);
        assert.deepEqual(merge({ w: { l: [NaN] } }, { w: { l: [NaN, 3] } }, true), { w: { l: [NaN, 3] } });
        assert.deepEqual(merge({}, { w: { l: [{ a: 1 }, { b: 2 }, NaN] } }, true), { w: { l: [{ a: 1 }, { b: 2 }, NaN] } });
    });
});


// ─── 04  the browser realm ───────────────────────────────────────────────────
describe('04 - the browser bundle\'s realm: the polyfill and this source in a fresh vm realm', function () {
    function realm() {
        var ctx = vm.createContext({});
        vm.runInContext(fs.readFileSync(POLYFILL, 'utf8'), ctx, { filename: 'polyfill.js' });
        var define = function (factory) { ctx.merge = factory(); };
        define.amd = {};
        ctx.define = define;
        vm.runInContext(fs.readFileSync(MAIN_SRC, 'utf8'), ctx, { filename: 'lib/merge/src/main.js' });
        // the growth guard, built inside the realm (its arrays are the realm's own)
        vm.runInContext("var guardArr = function (a) { Object.defineProperty(a, 'push', { value: function () { if (this.length >= 1000) throw new Error('GREW'); return Array.prototype.push.apply(this, arguments); }, enumerable: false, configurable: true, writable: true }); return a; };", ctx);
        return ctx;
    }

    it('control: the realm loads this source', function () {
        var ctx = realm();
        assert.equal(vm.runInContext('typeof merge', ctx), 'function');
        assert.equal(vm.runInContext("JSON.stringify(merge({}, { w: { l: [{ a: 1 }, { b: 2 }, 7] } }))", ctx), '{"w":{"l":[{"a":1},{"b":2},7]}}');
    });

    it('an array inside an object the target lacks, holding objects and then NaN, merges once', function () {
        var ctx = realm();
        assert.equal(vm.runInContext("var l = guardArr([{ a: 1 }, { b: 2 }, NaN]); var r = merge({}, { w: { l: l } }); l.length === 3 && r.w.l.length === 3 && r.w.l[2] !== r.w.l[2]", ctx), true);
    });
});


// ─── 05  source pins ─────────────────────────────────────────────────────────
describe('05 - source pins', function () {
    var src  = fs.readFileSync(MAIN_SRC, 'utf8');
    var code = codeOf(src);

    it('the primitive push carries the NaN test once, in code, and its helper is defined once', function () {
        assert.equal(count(code, FIXED_LINE), 1);
        assert.equal(count(code, 'var isNaNElement = function(x) {\n        return x !== x;\n    };'), 1);
        assert.equal(count(code, 'isNaNElement'), 2, 'its definition and its one use');
    });

    it('the replaced line is gone from the code, and the raw source records it as a `// was:` line', function () {
        assert.equal(count(code, RETIRED_LINE), 0);
        assert.equal(count(src, '// was: ' + RETIRED_LINE.replace(/ \{$/, '')), 1, 'the `// was:` record');
    });
});


// ─── 06  dist pins ───────────────────────────────────────────────────────────
describe('06 - dist pins: the browser bundle carries the change', function () {
    it('gina.js carries the fixed line verbatim, once, and not the replaced one', function () {
        var js = fs.readFileSync(DIST_JS, 'utf8');
        assert.equal(count(js, FIXED_LINE), 1);
        assert.equal(count(codeOf(js), RETIRED_LINE), 0);
    });

    // Closure inverts the push condition (De Morgan) and renames the identifiers: the shapes
    // below were read on the rebuilt bytes, line breaks removed, and checked on the bundle of
    // the parent commit (fixed shape 0, retired shape 1) and on the rebuilt one (1 and 0).
    it('gina.min.js carries the inverted NaN test once, its helper, and the retired condition is gone', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8').replace(/\n/g, '');
        function n(re) { return (min.match(re) || []).length; }
        var m = min.match(/([\w$]+)\.indexOf\(([\w$]+)\[([\w$]+)\]\)!=-1\|\|typeof \2\[\3\]==['"]object['"]&&\2\[\3\]!==null\|\|\2\[\3\]!==\2\[\3\]&&\1\.some\(([\w$]+)\)/g) || [];
        assert.equal(m.length, 1, 'the NaN test');
        var helper = /\.some\(([\w$]+)\)$/.exec(m[0])[1];
        assert.equal(n(new RegExp('(?:var |,)' + helper.replace(/\$/g, '\\$') + '=function\\(([\\w$]+)\\)\\{return \\1!==\\1\\}', 'g')), 1, 'the helper it passes to some()');
        assert.equal(n(/([\w$]+)\.indexOf\(([\w$]+)\[([\w$]+)\]\)!=-1\|\|typeof \2\[\3\]==['"]object['"]&&\2\[\3\]!==null\?/g), 0, 'the retired condition');
    });
});
