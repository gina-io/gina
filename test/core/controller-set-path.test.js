'use strict';
/**
 * SuperController `set()` — dotted-path writes into the render data tree (#P39 slice 2, 2026-08-27)
 *
 *  §01 source pins — the retired mechanism is GONE from the live controller.js (no
 *      JSON-string path builder, no `parseDataObject`) and the new shape is present
 *      (direct first-write assignment, leaf-level merge on collision, the `__proto__`
 *      guard). Negative pins run on COMMENT-STRIPPED text, because the new JSDoc names
 *      the retired mechanism in prose; each negative pin first asserts the token IS in
 *      the raw text, so a broken strip can never pass vacuously.
 *  §02 differential — the LIVE set() (brace-extracted from controller.js, executed with
 *      a fresh `local` and the REAL lib/merge) against a FROZEN verbatim copy of the
 *      retired implementation, over every collision shape at depths 2..5, the
 *      framework's own call-site paths in file order, and a seeded fuzz. The trees must
 *      be deep-strict-equal after EVERY call. The one divergence it had to exclude — an
 *      array-valued leaf overwritten by another array, which the retired whole-tree
 *      merge doubled — closed with #B436 (0.6.20); §04 now asserts the agreement.
 *  §03 contract — first write wins; `override` is inert in BOTH implementations
 *      (#B427); object-onto-object deep-fills; the collision asymmetries; non-object
 *      intermediates are replaced; `undefined` creates the key; a first-write value is
 *      stored by reference and is NOT mutated — the retired implementation swapped its
 *      inner arrays, and that is the firing control; `__proto__` throws; the root is
 *      created on first write; the flat branch is byte-untouched.
 *
 * Why a FROZEN oracle instead of a replica kept in lock-step: it mirrors code that no
 * longer exists, so it cannot drift — a fixed point, labelled with the commit it was
 * lifted from (d22155666).
 */

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW     = require('../fw');
var SOURCE = path.join(FW, 'core/controller/controller.js');
var merge  = require(path.join(FW, 'lib/merge'));
var commentStrip = require('../strip-comments');

var src;
before(function () { src = fs.readFileSync(SOURCE, 'utf8'); });

// ─── the retired implementation, verbatim (parseDataObject + set) ───────────
var FROZEN_OLD_SET = [
    "    var parseDataObject = function(o, obj, override) {",
    "",
    "        var keys = Object.keys(o);",
    "        for (var ki = 0; ki < keys.length; ++ki) {",
    "            var i = keys[ki];",
    "            if ( o[i] !== null && typeof(o[i]) == 'object' || override && o[i] !== null && typeof(o[i]) == 'object' ) {",
    "                parseDataObject(o[i], obj);",
    "            } else if (o[i] == '_content_'){",
    "                o[i] = obj",
    "            }",
    "        }",
    "",
    "        return o",
    "    }",
    "",
    "    /**",
    "     * Set data",
    "     *",
    "     * @param {string} nave -  variable name to set",
    "     * @param {string|object} value - value to set",
    "     * @param {boolean} [override]",
    "     *",
    "     * @returns {void}",
    "     * */",
    "    var set = function(name, value, override) {",
    "",
    "        var override = ( typeof(override) != 'undefined' ) ? override : false;",
    "",
    "        if ( typeof(name) == 'string' && /\\./.test(name) ) {",
    "            var keys        = name.split(/\\./g)",
    "                , newObj    = {}",
    "                , str       = '{'",
    "                , _count    = 0;",
    "",
    "            for (let k = 0, len = keys.length; k<len; ++k) {",
    "                str +=  \"\\\"\"+ keys.splice(0,1)[0] + \"\\\":{\";",
    "",
    "                ++_count;",
    "                if (k == len-1) {",
    "                    str = str.substring(0, str.length-1);",
    "                    str += \"\\\"_content_\\\"\";",
    "                    for (let c = 0; c<_count; ++c) {",
    "                        str += \"}\"",
    "                    }",
    "                }",
    "            }",
    "",
    "            newObj = parseDataObject(JSON.parse(str), value, override);",
    "            local.userData = merge(local.userData, newObj);",
    "",
    "        } else if ( typeof(local.userData[name]) == 'undefined' ) {",
    "            local.userData[name] = value.replace(/\\\\/g, '');",
    "        }",
    "    }",
    ""
].join('\n');

function makeFrozen(root) {
    var local = { userData: root };
    var set = new Function('local', 'merge', FROZEN_OLD_SET + '\n return set;')(local, merge);
    return { local: local, set: set };
}

// ─── the live implementation, extracted from the source under test ───────────
var START = "    var set = function(name, value, override) {";
var END   = "    /**\n     * Get data";
function liveSetText(source) {
    var s0 = source.indexOf(START);
    var s1 = source.indexOf(END, s0);
    assert.ok(s0 > -1 && s1 > s0, 'live set() block located in controller.js');
    var text = source.slice(s0, s1);
    assert.equal((text.match(/\{/g) || []).length, (text.match(/\}/g) || []).length, 'extracted block has balanced braces');
    return text;
}
function makeLive(root) {
    var local = { userData: root };
    var set = new Function('local', 'merge', liveSetText(src) + '\n return set;')(local, merge);
    return { local: local, set: set };
}
function stripComments(s) { return commentStrip.all(s); }
function getPath(root, p) { var n = root; p.split('.').forEach(function (k) { n = (n == null) ? undefined : n[k]; }); return n; }
// structuredClone keeps Date leaves and undefined-valued keys — a JSON round-trip would turn a Date into a string and poison later comparisons
function clone(v) { return v === undefined ? undefined : structuredClone(v); }
function hasArray(v, d) { if (d > 6 || v === null || typeof v != 'object') return false; if (Array.isArray(v)) return true; return Object.keys(v).some(function (k) { return hasArray(v[k], d + 1); }); }

var OBJ = { z: 1, inner: { q: 2, list: [1, 2] } }, ARR = [1, 2], ARR_OBJ = [{ q: 1 }], DT = new Date(0);
var POOL = ['s', 7, true, false, null, undefined, '', OBJ, ARR, ARR_OBJ, DT, { forms: { rules: { f: { isInList: ['a'] } } } }, 'a\\b'];


// ─── 01 — source inspection ─────────────────────────────────────────────────

describe('01 - source inspection: the retired mechanism is gone, the new shape is present', function () {

    function region() {
        var mark = src.indexOf('     * Set a value in the render data tree');
        var r0 = mark > -1 ? src.lastIndexOf('/**', mark) : -1;   // start AT the JSDoc opener, so the stripper can remove it
        var r1 = src.indexOf('     * Get data', mark);
        assert.ok(r0 > -1 && r1 > r0, 'set() JSDoc + body region located');
        return src.slice(r0, r1);
    }

    it('parseDataObject is no longer defined anywhere (comment-stripped; raw prose still names it — the vacuity control)', function () {
        assert.ok(src.indexOf('parseDataObject') > -1, 'control: the raw file still mentions parseDataObject in prose');
        assert.equal(stripComments(src).indexOf('parseDataObject'), -1, 'no code references parseDataObject');
        assert.equal(src.indexOf('var parseDataObject = function'), -1, 'no definition, even in raw text');
    });

    it('set() no longer builds a JSON string path (comment-stripped; raw prose still says JSON.parse — the vacuity control)', function () {
        var raw = region(), code = stripComments(raw);
        assert.ok(raw.indexOf('JSON.parse') > -1, 'control: the raw region names JSON.parse in the JSDoc');
        assert.equal(code.indexOf('JSON.parse'), -1, 'the code no longer parses a built string');
        assert.equal(code.indexOf('merge(local.userData'), -1, 'the code no longer merges a subtree into the whole tree');
    });

    it('set() assigns a first write directly, merges at the leaf on collision, and guards __proto__', function () {
        var code = stripComments(region());
        assert.ok(code.indexOf('node[leaf] = value;') > -1, 'direct first-write assignment');
        assert.ok(/merge\(node, one\);/.test(code), 'collision delegated to a leaf-level merge');
        assert.equal((code.match(/=== '__proto__'/g) || []).length, 2, 'both path positions (intermediate + leaf) guard __proto__');
        assert.ok(code.indexOf("local.userData[name] = value.replace(/\\\\/g, '');") > -1, 'the flat branch is byte-untouched');
    });
});


// ─── 02 — differential: live vs frozen, structure identical after every call ─

describe('02 - differential: live set() equals the frozen retired implementation (structure)', function () {

    var states = 0;
    function run(label, seq, seedRoot) {
        var o = makeFrozen(clone(seedRoot)), n = makeLive(clone(seedRoot));
        seq.forEach(function (step, idx) {
            var v = step[1], existing = getPath(n.local.userData, step[0]);
            var documentedDelta = (typeof existing != 'undefined') && Array.isArray(existing) && Array.isArray(v);   // §04
            o.set(step[0], v, step[2]); n.set(step[0], v, step[2]);
            if (documentedDelta) { n.local.userData = clone(o.local.userData); return; }
            assert.deepStrictEqual(n.local.userData, o.local.userData, label + ' step ' + idx + ' (' + step[0] + ')');
            states++;
        });
    }

    it('every leaf type and collision shape, at depths 2..5', function () {
        ['a.b', 'a.b.c', 'a.b.c.d', 'a.b.c.d.e'].forEach(function (p) {
            [['obj', OBJ], ['arr', ARR], ['arrObj', ARR_OBJ], ['date', DT], ['undefined', undefined], ['null', null], ['empty', ''], ['zero', 0], ['false', false]]
                .forEach(function (t) { run(t[0] + ' leaf ' + p, [[p, t[1]]]); });
            run('first-wins ' + p, [[p, 'first'], [p, 'second']]);
            run('override inert ' + p, [[p, 'first'], [p, 'second', true]]);
            run('undefined onto existing ' + p, [[p, 'keep'], [p, undefined]]);
            run('null onto existing ' + p, [[p, 'keep'], [p, null]]);
            run('deep-fill obj onto obj ' + p, [[p, { a: 1, n: { x: 1 } }], [p, { b: 2, a: 99, n: { y: 2, x: 9 } }]]);
            run('deep-fill obj onto obj with arrays ' + p, [[p, { a: 1, l: [1] }], [p, { b: 2, l: [2] }]]);
            run('obj leaf <- primitive ' + p, [[p, { a: 1 }], [p, 'prim']]);
            run('prim leaf <- obj ' + p, [[p, 'prim'], [p, { a: 1 }]]);
            run('arr leaf <- obj ' + p, [[p, [1, 2]], [p, { a: 1 }]]);
            run('obj leaf <- arr ' + p, [[p, { a: 1 }], [p, [1, 2]]]);
            run('sibling then nested ' + p, [[p, 'x'], [p + '.deeper', 'y']]);
            run('nested then sibling ' + p, [[p + '.deeper', 'y'], [p, 'x']]);
            run('obj then nested into it ' + p, [[p, { keep: 1 }], [p + '.added', 'y']]);
        });
        // exact census: 4 depths x (9 single-write leaf types + 13 two-write shapes) = 140 compared states
        assert.equal(states, 140, 'matrix census (' + states + ' states)');
    });

    it('intermediates of every wrong type are replaced identically', function () {
        run('string intermediate', [['a.b', 'str'], ['a.b.c', 'x']]);
        run('null intermediate',   [['a.b', null],  ['a.b.c', 'x']]);
        run('array intermediate',  [['a.b', ARR],   ['a.b.c', 'x']]);
        run('array intermediate deep', [['a.b', ARR], ['a.b.c.d.e', 'x']]);
        run('number intermediate', [['a.b', 5],     ['a.b.c.d', 'x']]);
        run('false intermediate',  [['a.b', false], ['a.b.c', 'x']]);
    });

    it('odd keys: spaces, empty segments, trailing dot, a pre-seeded root', function () {
        run('space key', [['page.environment.memory allocated', '1 MB'], ['page.environment.gina pid', '42']]);
        run('empty segment', [['a..b', 1], ['a..c', 2]]);
        run('trailing dot', [['a.b.', 1]]);
        run('pre-seeded root', [['page.view.title', 'T'], ['page.new.k', 1]], { page: { view: { file: 'f' } }, other: [1] });
    });

    it("the framework's own call-site paths, in file order, once and twice", function () {
        var sitePaths = [];
        src.replace(/^\s*set\('([^']+)'/mg, function (m, p) { sitePaths.push(p); return m; });
        assert.ok(sitePaths.length >= 55, 'control: call-site paths found in controller.js (' + sitePaths.length + ')');
        run('framework sequence', sitePaths.map(function (p, i) { return [p, POOL[i % POOL.length]]; }));
        run('framework sequence x2', sitePaths.concat(sitePaths).map(function (p, i) { return [p, POOL[(i * 7) % POOL.length]]; }));
    });

    it('seeded fuzz: 400 sequences x 14 writes over a small key alphabet', function () {
        var seed = 12345; function rnd(k) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; }
        var alpha = ['a', 'b', 'c', 'd e', '', 'x'];
        for (var f = 0; f < 400; f++) {
            var seq = [];
            for (var s = 0; s < 14; s++) {
                var depth = 2 + rnd(4), parts = [];
                for (var d = 0; d < depth; d++) parts.push(alpha[rnd(alpha.length)]);
                var v = POOL[rnd(POOL.length)];
                if (v !== null && typeof v == 'object' && rnd(2)) v = clone(v === DT ? { d: 1 } : v);
                seq.push([parts.join('.'), v, rnd(3) === 0]);
            }
            run('fuzz#' + f, seq);
        }
    });
});


// ─── 03 — the contract, on the live implementation ──────────────────────────

describe('03 - contract', function () {

    it('first write wins, and `override` is inert in BOTH implementations (#B427)', function () {
        var n = makeLive(), o = makeFrozen();
        n.set('page.view.title', 'first'); n.set('page.view.title', 'second', true);
        o.set('page.view.title', 'first'); o.set('page.view.title', 'second', true);
        assert.equal(n.local.userData.page.view.title, 'first');
        assert.equal(o.local.userData.page.view.title, 'first', 'the retired implementation never honoured override either');
    });

    it('object onto an existing object leaf deep-fills; the asymmetries hold', function () {
        var n = makeLive();
        n.set('p.o', { a: 1 }); n.set('p.o', { b: 2, a: 99 });
        assert.deepStrictEqual(n.local.userData.p.o, { a: 1, b: 2 });
        n.set('p.keep', { a: 1 }); n.set('p.keep', 'prim');
        assert.deepStrictEqual(n.local.userData.p.keep, { a: 1 }, 'object leaf keeps against a primitive');
        n.set('p.prim', 'prim'); n.set('p.prim', { a: 1 });
        assert.deepStrictEqual(n.local.userData.p.prim, { a: 1 }, 'primitive leaf is replaced by an object');
    });

    it('non-object intermediates are replaced; undefined creates the key; null is stored', function () {
        var n = makeLive();
        n.set('a.b', 'str'); n.set('a.b.c', 'x');
        assert.deepStrictEqual(n.local.userData.a, { b: { c: 'x' } });
        n.set('u.k', undefined);
        assert.ok(Object.prototype.hasOwnProperty.call(n.local.userData.u, 'k'));
        n.set('n.k', null);
        assert.equal(n.local.userData.n.k, null);
    });

    it('a first-write value is stored by reference and is NOT mutated', function () {
        // This arm used to carry a firing control: the retired implementation
        // swapped `old.rules.form.field.isInList` for a copy. That swap was
        // lib/merge re-walking a grafted source — #B428, fixed in 0.6.19 — so
        // it can no longer fire through the frozen oracle either. The lib-level
        // lock, with its own red-first control against the pre-fix bytes, is
        // test/lib/merge-b428.test.js; this arm now pins set()'s contract only.
        function catalog() { return { rules: { form: { field: { isInList: ['a', 'b'], isString: [2, 40] } } } }; }
        var live = catalog(), liveInner = live.rules.form.field.isInList;
        var n = makeLive(); n.set('page.view.x', 'y'); n.set('page.forms', live);
        assert.strictEqual(n.local.userData.page.forms, live, 'stored by reference');
        assert.strictEqual(live.rules.form.field.isInList, liveInner, 'the caller\'s inner array keeps its identity');
        var old = catalog();
        var o = makeFrozen(); o.set('page.view.x', 'y'); o.set('page.forms', old);
        assert.strictEqual(o.local.userData.page.forms, old, 'the retired implementation also referenced the object');
    });

    it('a `__proto__` segment throws a named error, at either position, and leaves Object.prototype clean', function () {
        var n = makeLive();
        assert.throws(function () { n.set('__proto__.polluted', 1); }, /\[SuperController::set\] `__proto__`/);
        assert.throws(function () { n.set('a.__proto__', 1); }, /\[SuperController::set\] `__proto__`/);
        assert.equal(({}).polluted, undefined);
    });

    it('the root is created on the first dotted write; the flat branch is untouched', function () {
        var n = makeLive();
        assert.equal(n.local.userData, undefined);
        n.set('a.b', 1);
        assert.deepStrictEqual(n.local.userData, { a: { b: 1 } });
        n.set('flat', 'x\\y'); n.set('flat', 'again');
        assert.equal(n.local.userData.flat, 'xy', 'flat branch strips backslashes and keeps the first write');
    });
});


// ─── 04 — the divergence that closed with #B436 ─────────────────────────────

describe('04 - an array leaf overwritten by another array: the retired and live implementations now agree (the divergence closed with #B436)', function () {

    it('both implementations merge the arrays once; no framework site writes an array path twice', function () {
        // This arm used to carry a firing control: the retired implementation,
        // merging through the whole tree, merged the array leaf TWICE and produced
        // extra elements. That double pass was lib/merge's #B436, fixed in 0.6.20,
        // so it can no longer fire through the frozen oracle. The lib-level lock,
        // with its own red-first control against the pre-fix bytes, is
        // test/lib/merge-b436.test.js; this arm now pins set()'s contract and the
        // agreement of the two implementations.
        var o = makeFrozen(), n = makeLive();
        o.set('a.b', [1, 2]); o.set('a.b', [2, 3]);
        n.set('a.b', [1, 2]); n.set('a.b', [2, 3]);
        assert.deepStrictEqual(n.local.userData.a.b, merge({ b: [1, 2] }, { b: [2, 3] }).b, 'live = a single leaf-level merge');
        assert.deepStrictEqual(o.local.userData.a.b, n.local.userData.a.b, 'the retired implementation now produces the same leaf (its double merge was #B436)');
        var arrayPathsWrittenTwice = 0;
        var seen = {};
        src.replace(/^\s*set\('([^']+)',\s*(\[|parameters|options\.conf\.content\.forms)/mg, function (m, p) { seen[p] = (seen[p] || 0) + 1; return m; });
        Object.keys(seen).forEach(function (p) { if (seen[p] > 1) arrayPathsWrittenTwice++; });
        assert.equal(arrayPathsWrittenTwice, 0, 'no framework call site writes an array-bearing path twice');
    });
});
