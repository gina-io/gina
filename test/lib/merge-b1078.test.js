'use strict';
/**
 * #B1078 — merging an id-keyed collection whose ids the target already holds cost
 * about N^3 steps in lib/merge.
 *
 * `mergeArray`'s collection branch (no `override`) compares each element of a deep
 * clone of the source with the ids of the target's copy, and pushes a clone only for
 * a key the target lacks. For EVERY target element it scanned the source again to its
 * end, an `indexOf` over the ids per step, even when nothing could be pushed: about
 * N^3 steps whenever every source id is already present. That covers a source array
 * the target lacks (the empty target is first filled with the source), a top-level
 * `merge([], items)`, an array inside an object the target lacks (#B436's createMode
 * pass merges it with itself), and a target holding the same ids. On the pre-fix
 * bytes a merge of 2,000 objects took 4.6–4.9 s on the host that measured it, and the
 * event loop was blocked throughout.
 *
 * Fix: before cloning the source, `collectionAddsNothing()` answers whether the loop
 * would push anything; when it would not, the target's copy is returned at once. Both
 * collection branches test membership in a `Set` of the ids (`NaN` is never found, as
 * with `indexOf`). Results are unchanged; the one difference is that a
 * self-referencing element no longer overflows the stack when every id is present
 * (§04).
 *
 * The browser bundle runs the same source with the polyfill's `JSON.clone`, which
 * copies only enumerable own keys, keeps an own `undefined`, and copies a key named
 * `'undefined'` that the server's clone skips. The check returns false for that key
 * name, so the loop decides there (§05), and for `'__proto__'`, which neither clone
 * can hold as an own key: its write runs the accessor (§02, §03).
 *
 * Covered (BEHAVIOURAL unless marked — the real lib is driven):
 *   01  cost: five slow shapes, each under 500 ms (RED pre-fix: 2.9–4.9 s each)
 *   02  results, values read on the pre-fix bytes (green on both revisions)
 *   03  the new check's answers, branch by branch (lifted from the source with its
 *       one closure name, `hasOwn`, passed in)
 *   04  boundary: a self-referencing element
 *   05  the browser's JSON.clone: the polyfill and this source in a fresh vm realm
 *   06  source pins
 *   07  dist pins (RED before the rebuild)
 *
 * Red-first: §01, §03, §04's first arm, §06 and §07 fail on the pre-fix bytes; §02,
 * §05 and §04's second arm pass on both revisions.
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

var LIMIT_MS = 500;

/** `n` objects with unique string ids: `{ id: p + i, v: i, m: { a: 'A' } }`. */
function items(n, p) {
    var a = [];
    for (var i = 0; i < n; i++) { a.push({ id: (p || 'i') + i, v: i, m: { a: 'A' } }); }
    return a;
}

/** Runs `fn` once and returns its duration in milliseconds. */
function timed(fn) {
    var t0 = process.hrtime.bigint();
    fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
}

/** Runs `fn` with console.warn silenced (the server's JSON.clone warns on an own `undefined`). */
function quiet(fn) {
    var w = console.warn;
    console.warn = function () {};
    try { return fn(); } finally { console.warn = w; }
}

/** Number of times `needle` occurs in `hay`. */
function count(hay, needle) { return hay.split(needle).length - 1; }

/** Code lines only: JSDoc / block-comment lines dropped, `//` comments cut. */
function codeOf(text) {
    return text.split('\n')
        .filter(function (l) { return !/^\s*(\/\*\*|\*)/.test(l); })
        .map(function (l) { return l.replace(/\/\/.*$/, ''); })
        .join('\n');
}

/** An instance whose `id` is inherited from its prototype. */
function Inherited() {}
Inherited.prototype.id = 'c';

/** An instance with an own `id`. */
function Inst(id) { this.id = id; }


// ─── 01  cost ────────────────────────────────────────────────────────────────
describe('01 - cost: a collection whose ids the target already holds merges in linear time', function () {
    it('R1 - a source array of 2,000 objects the target lacks', function () {
        var source = { list: items(2000) }, out;
        var ms = timed(function () { out = merge({ k: 'x' }, source); });
        assert.ok(ms < LIMIT_MS, 'took ' + ms.toFixed(1) + ' ms (limit ' + LIMIT_MS + ')');
        assert.equal(out.list.length, 2000);
        assert.notEqual(out.list, source.list, 'a fresh array');
        assert.ok(out.list.every(function (e, i) { return e === source.list[i]; }), 'the source\'s own objects, in order');
    });

    it('SN - the same array inside an object the target lacks (createMode)', function () {
        var source = { wrap: { list: items(2000) } }, out;
        var ms = timed(function () { out = merge({ k: 'x' }, source); });
        assert.ok(ms < LIMIT_MS, 'took ' + ms.toFixed(1) + ' ms (limit ' + LIMIT_MS + ')');
        assert.equal(out.wrap.list.length, 2000);
        assert.ok(out.wrap.list.every(function (e, i) { return e === source.wrap.list[i]; }), 'the source\'s own objects, in order');
    });

    it('ST - merge([], items) at the top level', function () {
        var target = [], source = items(2000), out;
        var ms = timed(function () { out = merge(target, source); });
        assert.ok(ms < LIMIT_MS, 'took ' + ms.toFixed(1) + ' ms (limit ' + LIMIT_MS + ')');
        assert.equal(out.length, 2000);
        assert.ok(out.every(function (e, i) { return e === source[i]; }), 'the source\'s own objects, in order');
    });

    it('SP - a target holding the same 2,000 ids keeps its own objects', function () {
        var target = { list: items(2000) }, held = target.list, source = { list: items(2000) }, out;
        var ms = timed(function () { out = merge(target, source); });
        assert.ok(ms < LIMIT_MS, 'took ' + ms.toFixed(1) + ' ms (limit ' + LIMIT_MS + ')');
        assert.equal(out.list.length, 2000);
        assert.ok(out.list.every(function (e, i) { return e === held[i]; }), 'the target\'s own objects, in order');
    });

    it('SPO - override, a target holding the same 40,000 ids', function () {
        // flat elements: the override branch clones the source, so element size is cost the fix does not change
        var flat = function () { return items(40000).map(function (e) { return { id: e.id, v: e.v }; }); };
        var target = { list: flat() }, source = { list: flat() }, out;
        var ms = timed(function () { out = merge(target, source, true); });
        assert.ok(ms < LIMIT_MS, 'took ' + ms.toFixed(1) + ' ms (limit ' + LIMIT_MS + ')');
        assert.equal(out.list.length, 40000);
        assert.deepEqual(out.list[0], source.list[0]);
        assert.notEqual(out.list[0], source.list[0], 'a clone of the source element');
        assert.deepEqual(out.list[39999], source.list[39999]);
    });
});


// ─── 02  results ─────────────────────────────────────────────────────────────
describe('02 - results are unchanged (values read on the pre-fix bytes)', function () {
    it('a source array the target lacks: a fresh array of the source\'s own objects; the source is untouched', function () {
        var s = [{ id: 'a' }, { id: 'b' }], S = { list: s }, out = merge({ k: 'x' }, S);
        assert.notEqual(out.list, s);
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], s[0]);
        assert.equal(out.list[1], s[1]);
        assert.equal(S.list, s, 'the source keeps its array');
        assert.equal(s.length, 2, 'and its length');
    });

    it('merge([], items) returns a new array, and fills the target array in place', function () {
        var target = [], s = [{ id: 'a' }], out = merge(target, s);
        assert.notEqual(out, target);
        assert.notEqual(out, s);
        assert.equal(out[0], s[0]);
        assert.equal(target.length, 1);
        assert.equal(target[0], s[0]);
    });

    it('duplicated ids are kept, each the source\'s own object', function () {
        var s = [{ id: 'a', v: 1 }, { id: 'a', v: 2 }, { id: 'b' }], out = merge({ k: 'x' }, { list: s });
        assert.equal(out.list.length, 3);
        s.forEach(function (e, i) { assert.equal(out.list[i], e); });
    });

    it('a target holding the same ids keeps its own objects, in a new array', function () {
        var t = [{ id: 'a', w: 'T' }, { id: 'b', w: 'T' }], s = [{ id: 'a', w: 'S' }, { id: 'b', w: 'S' }];
        var out = merge({ list: t }, { list: s });
        assert.notEqual(out.list, t);
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], t[1]);
    });

    it('a new id is appended as a clone', function () {
        var t = [{ id: 'a' }], s = [{ id: 'a' }, { id: 'c', v: 1 }], out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.deepEqual(out.list[1], { id: 'c', v: 1 });
        assert.notEqual(out.list[1], s[1]);
    });

    it('a new id repeated in the source is appended once', function () {
        var t = [{ id: 'a' }, { id: 'b' }], s = [{ id: 'a' }, { id: 'c', n: 1 }, { id: 'b' }, { id: 'c', n: 2 }];
        var out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 3);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], t[1]);
        assert.deepEqual(out.list[2], { id: 'c', n: 1 });
    });

    it('override: a new id repeated in the source is pushed once', function () {
        var t = [{ id: 'a' }, { id: 'b' }], s = [{ id: 'c', n: 1 }, { id: 'a' }, { id: 'c', n: 2 }, { id: 'b' }];
        var out = merge({ list: t }, { list: s }, true);
        assert.deepEqual(out.list, [{ id: 'a' }, { id: 'b' }, { id: 'c', n: 1 }]);
        out.list.forEach(function (e) { assert.ok(s.indexOf(e) < 0 && t.indexOf(e) < 0, 'clones of the source elements'); });
    });

    it('NaN ids: a target-lacking element is kept and a clone of it appended', function () {
        var s = [{ id: NaN }], out = merge({ k: 'x' }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], s[0]);
        assert.notEqual(out.list[1], s[0]);
        assert.ok(Number.isNaN(out.list[1].id));
    });

    it('NaN ids: a NaN id the target does not hold is appended as a clone', function () {
        var t = [{ id: 'a' }], s = [{ id: 'a' }, { id: NaN }], out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.ok(Number.isNaN(out.list[1].id));
        assert.notEqual(out.list[1], s[1]);
    });

    it('object ids: the elements are kept and the object-keyed one appended again as a clone', function () {
        var s = [{ id: { o: 1 } }, { id: 'b' }], out = merge({ k: 'x' }, { list: s });
        assert.equal(out.list.length, 3);
        assert.equal(out.list[0], s[0]);
        assert.equal(out.list[1], s[1]);
        assert.deepEqual(out.list[2], { id: { o: 1 } });
        assert.notEqual(out.list[2], s[0]);
    });

    it('true and null ids the target lacks are appended as clones', function () {
        var t = [{ id: 'a' }], s = [{ id: 'a' }, { id: true }, { id: null }], out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 3);
        assert.equal(out.list[0], t[0]);
        assert.deepEqual(out.list[1], { id: true });
        assert.deepEqual(out.list[2], { id: null });
    });

    it('a null element stops the scan: a new id after it is not appended', function () {
        var t = [{ id: 'a' }], out = merge({ list: t }, { list: [{ id: 'a' }, null, { id: 'c' }] });
        assert.equal(out.list.length, 1);
        assert.equal(out.list[0], t[0]);
    });

    it('a keyless element stops the scan the same way', function () {
        var t = [{ id: 'a' }], out = merge({ list: t }, { list: [{ id: 'a' }, { v: 1 }, { id: 'c' }] });
        assert.equal(out.list.length, 1);
        assert.equal(out.list[0], t[0]);
    });

    it('an own id: undefined is appended as a clone with id: null', function () {
        var t = [{ id: 'a' }], s = [{ id: 'a' }, { id: undefined, v: 1 }];
        var out = quiet(function () { return merge({ list: t }, { list: s }); });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.deepEqual(out.list[1], { id: null, v: 1 });
    });

    it('a class instance with a new id is appended as itself', function () {
        var t = [{ id: 'a' }], s = [new Inst('a'), new Inst('c')], out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], s[1]);
    });

    it('an instance whose id is inherited is read through its prototype, and appended as itself', function () {
        var t = [{ id: 'a' }], s = [{ id: 'a' }, new Inherited()], out = merge({ list: t }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], s[1]);
    });

    it('a null-prototype element with a new id is appended as itself', function () {
        var np = Object.assign(Object.create(null), { id: 'c' }), t = [{ id: 'a' }];
        var out = merge({ list: t }, { list: [{ id: 'a' }, np] });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], np);
    });

    it('0 and -0 are one id, \'0\' another', function () {
        var s = [{ id: 0 }, { id: -0 }, { id: '0' }], out = merge({ k: 'x' }, { list: s });
        assert.equal(out.list.length, 3);
        s.forEach(function (e, i) { assert.equal(out.list[i], e); });
        var t = [{ id: 0 }], out2 = merge({ list: t }, { list: [{ id: -0 }, { id: '0' }] });
        assert.equal(out2.list.length, 2);
        assert.equal(out2.list[0], t[0]);
        assert.deepEqual(out2.list[1], { id: '0' });
    });

    it('a null slot in the target is kept', function () {
        var t = [{ id: 'a' }, null], out = merge({ list: t }, { list: [{ id: 'a' }] });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.equal(out.list[1], null);
    });

    it('override on a source array the target lacks returns the source array itself', function () {
        var s = [{ id: 'a' }, { id: 'b' }], out = merge({ k: 'x' }, { list: s }, true);
        assert.equal(out.list, s);
    });

    it('setKeyComparison applies to one merge, then the key is id again', function () {
        var t = [{ name: 'p' }], s = [{ name: 'p' }, { name: 'q' }];
        var out = merge.setKeyComparison('name')({ list: t }, { list: s });
        assert.equal(out.list.length, 2);
        assert.equal(out.list[0], t[0]);
        assert.deepEqual(out.list[1], { name: 'q' });

        var t2 = [{ id: 'a', name: 'p' }], out2 = merge({ list: t2 }, { list: [{ id: 'b', name: 'p' }] });
        assert.equal(out2.list.length, 2, 'compared on id: b is new');
        assert.deepEqual(out2.list[1], { id: 'b', name: 'p' });

        var t3 = [{ name: 'p' }, { name: 'q' }], out3 = merge.setKeyComparison('name')({ list: t3 }, { list: [{ name: 'p' }, { name: 'q' }] });
        assert.equal(out3.list.length, 2);
        assert.equal(out3.list[0], t3[0]);
        assert.equal(out3.list[1], t3[1]);
    });

    it('a collection compared on a key named undefined: the server clone drops that key, so the scan stops', function () {
        var t = [{ undefined: 'a' }], out = merge.setKeyComparison('undefined')(t, [{ undefined: 'a' }, { undefined: 'b' }]);
        assert.equal(out.length, 1);
        assert.equal(out[0], t[0]);
    });

    it('a collection compared on a key named __proto__: a clone cannot hold that own key, so the loop decides, as before', function () {
        // JSON.parse yields an OWN __proto__ data key; a clone's write of it runs the accessor
        var t = JSON.parse('[{"__proto__":"x","v":1}]'), s = JSON.parse('[{"__proto__":"x","v":2}]');
        var out = merge.setKeyComparison('__proto__')(t, s);
        assert.equal(out.length, 2);
        assert.equal(out[0], t[0]);
        assert.equal(out[1].v, 2);
        assert.notEqual(out[1], s[1], 'a clone');
    });

    it('arrays of primitives: strings deduplicated, numbers topped up by count', function () {
        assert.deepEqual(merge({ k: 'x' }, { tags: ['a', 'a', 'b'] }).tags, ['a', 'b']);
        assert.deepEqual(merge({ k: 'x' }, { tags: [25, 25, 1] }).tags, [25, 1, 25]);
        assert.deepEqual(merge({ tags: [25] }, { tags: [25, 25] }).tags, [25, 25]);
    });
});


// ─── 03  the new check, branch by branch ─────────────────────────────────────
describe('03 - collectionAddsNothing answers per branch (lifted from the source)', function () {
    var lifted = null;
    function adds() {
        if (lifted) { return lifted; }
        var src   = fs.readFileSync(MAIN_SRC, 'utf8');
        var start = src.indexOf('    var collectionAddsNothing = function(options, newTarget, keyComparison) {');
        assert.ok(start > -1, 'collectionAddsNothing is defined in lib/merge');
        var end = src.indexOf('\n    };\n', start);
        assert.ok(end > start, 'its end is found');
        lifted = new Function('hasOwn', src.slice(start, end + 7) + '\nreturn collectionAddsNothing;')(Object.prototype.hasOwnProperty);
        return lifted;
    }

    it('control: the two answers its JSDoc example states', function () {
        assert.equal(adds()([{ id: 'a' }], [{ id: 'a' }, { id: 'b' }], 'id'), true);
        assert.equal(adds()([{ id: 'c' }], [{ id: 'a' }], 'id'), false);
    });

    it('every id held: true for string, number, boolean and null keys, and 0 / -0', function () {
        assert.equal(adds()([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'a' }], 'id'), true);
        assert.equal(adds()([{ id: 1 }, { id: 2 }], [{ id: 2 }, { id: 1 }], 'id'), true);
        assert.equal(adds()([{ id: true }], [{ id: true }], 'id'), true);
        assert.equal(adds()([{ id: null }], [{ id: null }], 'id'), true);
        assert.equal(adds()([{ id: -0 }], [{ id: 0 }], 'id'), true);
    });

    it('a key the target lacks: false', function () {
        assert.equal(adds()([{ id: 'a' }, { id: 'c' }], [{ id: 'a' }], 'id'), false);
    });

    it('NaN, an object, a function, a symbol or a bigint: false, even when the target holds the same value', function () {
        var o = {}, fn = function () {}, sym = Symbol('s');
        assert.equal(adds()([{ id: NaN }], [{ id: NaN }], 'id'), false);
        assert.equal(adds()([{ id: o }], [{ id: o }], 'id'), false);
        assert.equal(adds()([{ id: fn }], [{ id: fn }], 'id'), false);
        assert.equal(adds()([{ id: sym }], [{ id: sym }], 'id'), false);
        assert.equal(adds()([{ id: BigInt(1) }], [{ id: BigInt(1) }], 'id'), false);
    });

    it('a null element or a hole stops: true when every id before it is held, false otherwise', function () {
        var hole = [{ id: 'a' }];
        hole[2] = { id: 'z' };
        assert.equal(adds()([{ id: 'a' }, null, { id: 'z' }], [{ id: 'a' }], 'id'), true);
        assert.equal(adds()(hole, [{ id: 'a' }], 'id'), true);
        assert.equal(adds()([{ id: 'z' }, null], [{ id: 'a' }], 'id'), false);
    });

    it('a plain element without the key stops the scan', function () {
        assert.equal(adds()([{ id: 'a' }, { v: 1 }, { id: 'z' }], [{ id: 'a' }], 'id'), true);
    });

    it('a plain element without the key reads Object.prototype: a function there gives false', function () {
        assert.equal(adds()([{ v: 1 }], [{ v: 2 }], 'toString'), false);
    });

    it('an own key holding undefined reads as null', function () {
        assert.equal(adds()([{ id: undefined }], [{ id: null }], 'id'), true);
        assert.equal(adds()([{ id: undefined }], [{ id: 'a' }], 'id'), false);
    });

    it('a class instance is read as itself, its key through the prototype', function () {
        assert.equal(adds()([new Inherited()], [{ id: 'c' }], 'id'), true);
        assert.equal(adds()([new Inherited()], [{ id: 'a' }], 'id'), false);
    });

    it('a null slot in the target contributes no id', function () {
        assert.equal(adds()([{ id: 'a' }], [{ id: 'a' }, null], 'id'), true);
    });

    it('the key name undefined, or a key that is not a string: false', function () {
        assert.equal(adds()([{ undefined: 'a' }], [{ undefined: 'a' }], 'undefined'), false);
        assert.equal(adds()([{ 1: 'a' }], [{ 1: 'a' }], 1), false);
    });

    it('the key name __proto__: false, even when both sides hold the same own value', function () {
        assert.equal(adds()(JSON.parse('[{"__proto__":"x"}]'), JSON.parse('[{"__proto__":"x"}]'), '__proto__'), false);
    });
});


// ─── 04  boundary ────────────────────────────────────────────────────────────
describe('04 - a self-referencing element', function () {
    it('merges when every id is present (the pre-fix bytes overflowed the stack in JSON.clone)', function () {
        var cyc = { id: 'a' };
        cyc.self = cyc;
        var out = merge({ k: 'x' }, { list: [cyc] });
        assert.equal(out.list.length, 1);
        assert.equal(out.list[0], cyc);
    });

    it('with an id the target lacks, the loop still clones the source and still overflows', function () {
        var cyc = { id: 'new' };
        cyc.self = cyc;
        assert.throws(function () { merge({ list: [{ id: 'a' }] }, { list: [cyc] }); }, RangeError);
    });
});


// ─── 05  the browser's JSON.clone ────────────────────────────────────────────
describe('05 - the browser bundle\'s JSON.clone: the polyfill and this source in a fresh vm realm', function () {
    function realm() {
        var ctx = vm.createContext({});
        vm.runInContext(fs.readFileSync(POLYFILL, 'utf8'), ctx, { filename: 'polyfill.js' });
        var define = function (factory) { ctx.merge = factory(); };
        define.amd = {};
        ctx.define = define;
        vm.runInContext(fs.readFileSync(MAIN_SRC, 'utf8'), ctx, { filename: 'lib/merge/src/main.js' });
        return ctx;
    }

    it('control: the realm runs the polyfill\'s clone, which keeps an own undefined (the server clone gives null)', function () {
        var ctx = realm();
        assert.equal(vm.runInContext('typeof merge', ctx), 'function');
        assert.equal(vm.runInContext('var c = JSON.clone({ id: undefined }); ("id" in c) && c.id === undefined', ctx), true);
    });

    it('a collection compared on a key named undefined keeps the new element', function () {
        var ctx = realm();
        assert.equal(vm.runInContext("merge.setKeyComparison('undefined')([{ undefined: 'a' }], [{ undefined: 'a' }, { undefined: 'b' }]).length", ctx), 2);
    });

    it('an own undefined id stops the browser loop: nothing after it is appended', function () {
        var ctx = realm();
        assert.equal(vm.runInContext("merge({ list: [{ id: null }] }, { list: [{ id: null }, { id: undefined }, { id: 'new' }] }).list.length", ctx), 1);
    });

    it('a source array the target lacks gives a fresh array of the source\'s own objects', function () {
        var ctx = realm();
        assert.equal(vm.runInContext("var s = [{ id: 'a' }, { id: 'b' }]; var r = merge({ k: 'x' }, { list: s }); r.list !== s && r.list.length === 2 && r.list[0] === s[0] && r.list[1] === s[1]", ctx), true);
    });
});


// ─── 06  source pins ─────────────────────────────────────────────────────────
describe('06 - source pins', function () {
    var src  = fs.readFileSync(MAIN_SRC, 'utf8');
    var code = codeOf(src);

    it('the check is defined once, and returns false for the key name undefined or a non-string key', function () {
        assert.equal(count(code, 'var collectionAddsNothing = function(options, newTarget, keyComparison) {'), 1);
        assert.equal(count(code, "if ( typeof(keyComparison) != 'string' || keyComparison === 'undefined' ) { return false }"), 1);
        assert.equal(count(code, "if ( keyComparison === '__proto__' ) { return false }"), 1);
    });

    it('the non-override collection branch asks it once, before cloning the source', function () {
        var entry = code.indexOf('newTarget       = (Array.isArray(target)) ? Array.from(target) : JSON.clone(target);');
        var call  = code.indexOf('if ( collectionAddsNothing(options, newTarget, keyComparison) ) {');
        var clone = code.indexOf('var _options    = JSON.clone(options);', entry);
        assert.ok(entry > -1 && call > -1 && clone > -1, 'anchors: entry=' + entry + ' call=' + call + ' clone=' + clone);
        assert.ok(entry < call && call < clone, 'entry < call < clone');
        assert.equal(count(code, 'collectionAddsNothing('), 1, 'one call');
    });

    it('both collection branches test membership in a Set kept with the id list', function () {
        assert.equal(count(code, 'new Set(newTargetIds)'), 2);
        assert.equal(count(code, '_options[a][keyComparison] === _options[a][keyComparison] && newTargetIdSet.has(_options[a][keyComparison])'), 1);
        assert.equal(count(code, '_options[a][keyComparison] !== _options[a][keyComparison] || !newTargetIdSet.has(_options[a][keyComparison])'), 2);
        assert.equal(count(code, '_options[n][keyComparison] !== _options[n][keyComparison] || !newTargetIdSet.has(_options[n][keyComparison])'), 1);
        assert.equal(count(code, 'newTargetIdSet.add('), 3);
    });

    it('no indexOf over the id list is left in the code; the raw source records the four retired tests', function () {
        assert.equal(count(code, 'newTargetIds.indexOf('), 0);
        // the four `// was:` lines (an older commented-out line reads `newTargetIds.indexOf(target[n]…`)
        assert.equal(count(src, 'newTargetIds.indexOf(_options['), 4, 'anti-vacuity: the `// was:` lines');
    });
});


// ─── 07  dist pins ───────────────────────────────────────────────────────────
// Shaped from the EMITTED artifact. Closure inlines the single-use check into its
// call site, so gina.min.js has no `collectionAddsNothing`: the pins match its
// inlined guard, the early return before the clone, and the Set tests, with
// identifiers as backreferences. Closure wraps lines through tokens, so the
// minified text is read with its newlines removed. Validated on the pre-fix and the
// rebuilt bundles: each positive 0 -> its count, each negative 1 -> 0.
describe('07 - dist pins: the browser bundle carries the change', function () {
    it('gina.js carries the source\'s code lines verbatim, once each', function () {
        var js   = fs.readFileSync(DIST_JS, 'utf8');
        var code = codeOf(js);
        assert.equal(count(code, 'var collectionAddsNothing = function(options, newTarget, keyComparison) {'), 1);
        assert.equal(count(code, "if ( typeof(keyComparison) != 'string' || keyComparison === 'undefined' ) { return false }"), 1);
        assert.equal(count(code, "if ( keyComparison === '__proto__' ) { return false }"), 1);
        assert.equal(count(code, 'if ( collectionAddsNothing(options, newTarget, keyComparison) ) {'), 1);
        assert.equal(count(code, 'newTargetIds.indexOf('), 0);
        assert.ok(count(code, 'newTargetIds.push(') > 0, 'anti-vacuity: the merge module is in the bundle');
    });

    it('gina.min.js: the inlined guard, the early return and the Set tests are present; the indexOf tests are gone', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8').replace(/\n/g, '');
        function n(re) { return (min.match(re) || []).length; }
        assert.equal(n(/typeof (\w+)!='string'\|\|\1==='undefined'/g), 1, 'the guard');
        assert.equal(n(/typeof (\w+)!='string'\|\|\1==='undefined'\|\|\1==='__proto__'/g), 1, 'the guard folds the __proto__ test in');
        assert.equal(n(/if\((\w+)\)return (\w+);(\w+)=JSON\.clone\((\w+)\)/g), 1, 'the early return before the clone');
        assert.equal(n(/\{if\((\w+)\[(\w+)\]\[(\w+)\]!==\1\[\2\]\[\3\]\|\|!(\w+)\.has\(\1\[\2\]\[\3\]\)\)\{(\w+)\.push\(\1\[\2\]\)/g), 1, 'the non-override Set test');
        assert.equal(n(/(\w+)\[(\w+)\]\[(\w+)\]===\1\[\2\]\[\3\]&&(\w+)\.has\(\1\[\2\]\[\3\]\)/g), 3, 'the override Set tests');
        assert.equal(n(/\{if\((\w+)\.indexOf\((\w+)\[(\w+)\]\[(\w+)\]\)==-1\)\{(\w+)\.push\(\2\[\3\]\)/g), 0, 'the non-override indexOf test is gone');
        assert.equal(n(/(\w+)\.indexOf\((\w+)\[(\w+)\]\[(\w+)\]\)>-1\?\((\w+)\[(\w+)\]=\2\[\3\]/g), 0, 'the override indexOf test is gone');
        assert.ok(n(/\/\^true\$\/i\.test\(/g) > 0, 'anti-vacuity: the merge module is in the bundle');
    });
});
