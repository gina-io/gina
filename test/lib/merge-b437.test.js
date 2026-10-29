'use strict';
/**
 * lib/merge must not THROW on a mixed primitive/object array (#B437).
 *
 * `mergeArray`'s index-merge branch fills a source OBJECT into a HOLE of the
 * target: it tests `typeof(newTarget[a]) == 'undefined'` against the DEDUPED
 * rebuild of the target, then rebinds `newTarget = target` and writes the
 * object's keys into `target[a]`. A target carrying duplicate primitives is
 * SHORTER once deduped, so the hole test passed for an index that, on the real
 * target, holds a string (or null) — and the key write threw
 * `TypeError: Cannot create property 'id' on string` (`Cannot read properties
 * of null` for a null slot), killing the whole merge. Every configuration
 * overlay travels through this lib, so a throwing merge is a boot-killer for
 * any config that hits the shape.
 *
 * The fix guards the key write on the slot being a non-null object: an occupied
 * slot is not a hole and is skipped — the disposition the chain below the branch
 * already gives an object arriving at an occupied index.
 *
 * Covered (BEHAVIOURAL unless marked — the real lib is driven):
 *   01  the two throwing shapes no longer throw; their results are pinned (RED pre-fix)
 *   02  every neighbouring shape is byte-identical (controls, green either way)
 *   03  source pin: the guard sits inside the index-merge branch, between the
 *       hole fill and the key loop (RED pre-fix)
 *   04  dist pins: the browser bundle carries the guard (RED before the rebuild)
 *
 * Red-first: §01 and §03 fail on the pre-fix bytes and §04 before the prod
 * rebuild; every control is green on both — validated against `git show HEAD:`
 * copies, never a tree revert.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FRAMEWORK = path.resolve(require('../fw'));
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/merge/src/main.js');
var DIST_JS   = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN  = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var merge     = require(path.join(FRAMEWORK, 'lib/merge'));

/** An id-keyed source whose first and last entries share an id. */
function coll() { return [{ id: 3, v: 'c1' }, { id: 0, v: 'c2' }, { id: 3, v: 'c1' }]; }

var GUARD = "newTarget[a] !== null && typeof(newTarget[a]) == 'object'";


// ─── 01  the throwing shapes ─────────────────────────────────────────────────
describe('01 - a mixed primitive/object merge no longer throws', function () {
    it('a target with a repeated string + an id-keyed source: no throw, occupied slots are skipped', function () {
        var t = ['v2', 'v2'], out;
        assert.doesNotThrow(function () { out = merge(t, coll()); });
        assert.deepEqual(out, ['v2', 'v2', { id: 3, v: 'c1' }]);
        assert.equal(out, t, 'the branch merges into the target array itself');
    });

    it('a null slot on the real target: no throw, nothing is written into null', function () {
        var out;
        assert.doesNotThrow(function () { out = merge(['x', 'x', null], [{ a: 1 }, { b: 2 }, { c: 3 }]); });
        assert.deepEqual(out, ['x', 'x', null]);
    });

    it('the same shapes one level down (a configuration-overlay position)', function () {
        var out = merge({ list: ['v2', 'v2'] }, { list: coll() });
        assert.deepEqual(out.list, ['v2', 'v2', { id: 3, v: 'c1' }]);
        out = merge({ list: ['x', 'x', null] }, { list: [{ a: 1 }, { b: 2 }, { c: 3 }] });
        assert.deepEqual(out.list, ['x', 'x', null]);
    });
});


// ─── 02  controls ────────────────────────────────────────────────────────────
describe('02 - controls: every neighbouring shape is unchanged', function () {
    it('a single-string target fills its holes with the source objects (no dedupe shrink, no throw before either)', function () {
        var t = ['v2'], out = merge(t, coll());
        assert.deepEqual(out, ['v2', { id: 0, v: 'c2' }, { id: 3, v: 'c1' }]);
        assert.equal(out, t);
    });

    it('two distinct strings + one object: the object arrives at an occupied index and is dropped', function () {
        assert.deepEqual(merge(['v2', 'x'], [{ id: 3, v: 'c1' }]), ['v2', 'x']);
    });

    it('positional key-fill between plain objects', function () {
        assert.deepEqual(merge([{ x: 1 }], [{ y: 2 }]), [{ x: 1, y: 2 }]);
    });

    it('filling from an empty target, and an empty source', function () {
        assert.deepEqual(merge([], [{ '20': 155 }]), [{ '20': 155 }]);
        assert.deepEqual(merge([{ '20': 155 }], []), [{ '20': 155 }]);
    });

    it('id-keyed collections, both modes', function () {
        assert.deepEqual(merge({ c: [{ id: 1, v: 0 }] }, { c: [{ id: 1, v: 9 }] }).c, [{ id: 1, v: 0 }]);
        assert.deepEqual(merge({ c: [{ id: 1, v: 0 }] }, { c: [{ id: 1, v: 9 }] }, true).c, [{ id: 1, v: 9 }]);
    });

    it('primitive arrays never enter the branch', function () {
        assert.deepEqual(merge(['a'], ['b']), ['a', 'b']);
        assert.deepEqual(merge({ a: [25] }, { a: [25, 25] }).a, [25, 25]);
        assert.deepEqual(merge({ list: ['x'] }, { list: ['x', null] }).list, ['x', null]);
    });
});


// ─── 03  source pin ──────────────────────────────────────────────────────────
describe('03 - source pin: the guard sits inside the index-merge branch', function () {
    it('ordering: the hole fill < the occupied-slot guard < the key loop, and the guard appears exactly once', function () {
        var src   = fs.readFileSync(MAIN_SRC, 'utf8');
        var fill  = src.indexOf('newTarget[a] = {};');
        var loop  = src.indexOf('for (let k in options[a])');
        var guard = src.indexOf(GUARD);
        assert.ok(fill > -1 && loop > -1, 'anchors present');
        assert.ok(guard > -1, 'the #B437 occupied-slot guard is present');
        assert.ok(fill < guard && guard < loop, 'fill=' + fill + ' guard=' + guard + ' loop=' + loop);
        assert.equal(src.split(GUARD).length - 1, 1, 'exactly one guard');
    });
});


// ─── 04  dist pins ───────────────────────────────────────────────────────────
// Derived from the EMITTED artifact, never guessed: Closure folds the rebind,
// the hole fill and the guard into one comma-expression condition gating the
// key loop. Identifier-agnostic (backreferences bind the same target/index
// locals) and wrap-agnostic (`\s*` at every token boundary).
//
// #B446 moved this shape: its unsafe-key guard was inserted INSIDE the key loop,
// between the for-in and the element's own-key test (`newTarget[a].hasOwnProperty(k)`
// then; `Object.prototype.hasOwnProperty.call(newTarget[a], k)` since #B849, which
// an own `hasOwnProperty` key cannot shadow), which the pre-#B446 pin required to
// be adjacent. The #B437 guard itself is untouched. The positive requires BOTH
// guards in one match, so it pins the #B446 request-path guard as well as the
// #B437 occupied-slot guard:
//   w[r]!==null&&typeof w[r]=='object')for(y in C[r])
//     l(y)||Object.prototype.hasOwnProperty.call(w[r],y)||(w[r][y]=C[r][y])
// (re-derived from the #B849 artifact: 1 on it, 0 on the pre-#B849 artifact, whose
// tail read `w[r].hasOwnProperty(y)` -- a control that can fail.)
// The own-property half of #B446's first cut is deliberately ABSENT: it broke the
// model registry (see merge-entity-prototype.test.js) and was reverted. Only the
// key-name rejection, minified to `l(y)`, remains -- and it is the half that
// actually stops pollution, since an own __proto__ passes an own check anyway.
// Validated in both directions: 1 on the current artifact, 0 on the pre-#B446
// artifact -- a control that can fail.
describe('04 - dist pins: the browser bundle carries the guard', function () {
    it('the unminified bundle carries the guard verbatim, exactly once', function () {
        var js = fs.readFileSync(DIST_JS, 'utf8');
        assert.equal(js.split(GUARD).length - 1, 1);
    });

    it('the minified bundle gates the key loop on the occupied-slot guard (positive), and the un-guarded fill is gone (negative)', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        var pos = min.match(/(\w+)\[(\w+)\]\s*!==\s*null\s*&&\s*typeof\s+\1\[\2\]\s*==\s*'object'\s*\)\s*for\s*\(\s*(\w+)\s+in\s+(\w+)\[\2\]\s*\)\s*(\w+)\(\3\)\s*\|\|\s*Object\.prototype\.hasOwnProperty\.call\(\1\[\2\],\s*\3\)/g) || [];
        var neg = min.match(/for\s*\(\s*(\w+)\s+in\s+(\w+)\s*=\s*(\w+)\s*,\s*typeof\s+\2\[(\w+)\]\s*==\s*'undefined'\s*&&\s*\(\s*\2\[\4\]\s*=\s*\{\s*\}\s*\)\s*,\s*(\w+)\[\4\]\s*\)\s*\2\[\4\]\.hasOwnProperty\(\1\)/g) || [];
        assert.equal(pos.length, 1, 'doubly-guarded index-merge sites in gina.min.js: ' + pos.length);
        assert.equal(neg.length, 0, 'un-guarded index-merge sites still in gina.min.js: ' + neg.length);
        // anti-vacuity: the branch itself is still in the bundle
        assert.ok((min.match(/Object\.prototype\.hasOwnProperty\.call\(/g) || []).length > 0, 'the index-merge region vanished from the bundle');
    });
});
