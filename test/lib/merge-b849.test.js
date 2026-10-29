/**
 * #B849 — keys named after an Object.prototype member inside NESTED request data.
 *
 * (a) mergeArray() filled an object element of the source into a hole of the target
 *     with `newTarget[a].hasOwnProperty(k)`: an element whose own `hasOwnProperty` is
 *     DATA (a PUT body `list[0][hasOwnProperty]=1&list[0][b]=2`) threw
 *     `TypeError: newTarget[a].hasOwnProperty is not a function` — on the next key, and
 *     on the first key when the element IS the source object (pushed by reference) —
 *     and the request answered 500. Fix: the own-key test goes through
 *     `Object.prototype.hasOwnProperty.call`, which no own key can shadow.
 *
 * (b) Both JSON.clone cloners — the server's `utils/prototypes.json_clone.js` (the one
 *     implementation both prototype installers require) and the browser's
 *     `core/asset/plugin/src/vendor/gina/utils/polyfill.js` — filled a key only when
 *     `typeof target[key] == 'undefined'`, read THROUGH the prototype chain: on a fresh
 *     `{}` target `toString`, `valueOf`, `hasOwnProperty` (and gina's `count`) are
 *     defined, so the clone wrote the inherited FUNCTION as an own key over the source's
 *     value (the #B845 shape, in the cloner). `GET` `inheritedData` runs the cloner
 *     BEFORE the merge, so it lost `toString` top-level and nested. Fix: fill when the
 *     target lacks an OWN defined value — a superset of the old test, so every fill that
 *     happened before still happens.
 *
 * RED-FIRST (measured on the unfixed bytes, 2026-10-30): 18 of 30 red — 01 (five of
 * the twelve shapes throw), 02, 05 (4), 06 (2), 07 and 09 (2), plus the source pins
 * 04 and 11 (2); the controls (03, 08, 10) pass on both revisions. The dist pins (12)
 * are red before the rebuild.
 */
'use strict';

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var vm     = require('vm');

var FRAMEWORK = path.resolve(require('../fw'));
var REPO_ROOT = path.resolve(__dirname, '..', '..');
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/merge/src/main.js');
var CLONE_SRC = path.join(REPO_ROOT, 'utils', 'prototypes.json_clone.js');
var POLYFILL  = path.join(FRAMEWORK, 'core/asset/plugin/src/vendor/gina/utils/polyfill.js');
var DIST_JS   = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN  = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var merge     = require(path.join(FRAMEWORK, 'lib/merge'));
var clone     = require(CLONE_SRC);
var hasOwn    = Object.prototype.hasOwnProperty;

var MEMBERS = ['toString', 'valueOf', 'isPrototypeOf', 'hasOwnProperty'];

/** The polyfill, evaluated in a fresh realm: returns that realm's context (its own JSON and Object). */
function browserRealm() {
    var ctx = vm.createContext({});
    vm.runInContext(fs.readFileSync(POLYFILL, 'utf8'), ctx, { filename: 'polyfill.js' });
    return ctx;
}


// ─── (a) mergeArray ──────────────────────────────────────────────────────────
describe('01 - mergeArray: an element whose own hasOwnProperty is data merges into a hole without throwing', function () {
    var SHAPES = {
        'one key':             function () { return { list: [ { hasOwnProperty: 1 } ] }; },
        'hop first + sibling': function () { return { list: [ { hasOwnProperty: 1, b: 2 } ] }; },
        'sibling + hop last':  function () { return { list: [ { b: 2, hasOwnProperty: 1 } ] }; },
        'control plain':       function () { return { list: [ { a: 1, b: 2 } ] }; }
    };
    var TARGETS = {
        'target {}':             function () { return {}; },
        'target {list:[{}]}':    function () { return { list: [ {} ] }; },
        'target {list:[{z:1}]}': function () { return { list: [ { z: 1 } ] }; }
    };
    Object.keys(SHAPES).forEach(function (s) {
        Object.keys(TARGETS).forEach(function (t) {
            it(s + ' | ' + t, function () {
                var source = SHAPES[s]();
                var expected = Object.assign({}, TARGETS[t]().list ? TARGETS[t]().list[0] : {}, source.list[0]);
                var out = merge(TARGETS[t](), source);
                assert.equal(out.list.length, 1);
                Object.keys(expected).forEach(function (k) {
                    assert.ok(hasOwn.call(out.list[0], k), k + ' is an own key of the element');
                    assert.equal(out.list[0][k], expected[k], 'element.' + k);
                });
                assert.deepEqual(Object.keys(out.list[0]).sort(), Object.keys(expected).sort());
            });
        });
    });
});

describe('02 - mergeArray: fill-only keeps the target element\'s OWN keys and adds the rest', function () {
    it('{list:[{b:9}]} + {list:[{hasOwnProperty:1, b:2}]} → b stays 9, hasOwnProperty is added', function () {
        var out = merge({ list: [ { b: 9 } ] }, { list: [ { hasOwnProperty: 1, b: 2 } ] });
        assert.equal(out.list[0].b, 9);
        assert.equal(out.list[0].hasOwnProperty, 1);
    });
});

describe('03 - CONTROL: the #B446 key rejection inside mergeArray is unchanged', function () {
    it('an element carrying an own __proto__ key does not pollute; its sibling survives', function () {
        try {
            var out = merge({ list: [ {} ] }, { list: [ JSON.parse('{"__proto__":{"pollutedByB849":"OWNED"},"k":1}') ] });
            assert.equal(({}).pollutedByB849, undefined);
            assert.equal(out.list[0].k, 1);
        } finally {
            delete Object.prototype.pollutedByB849;
        }
    });
});

describe('04 - source pin: mergeArray tests ownership through the built-in', function () {
    var raw  = fs.readFileSync(MAIN_SRC, 'utf8');
    var code = raw.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
    it('the .call form is in the code once; the shadowable form is gone from the code and kept in the raw `was:` record', function () {
        assert.equal(code.split('if (!Object.prototype.hasOwnProperty.call(newTarget[a], k)) {').length - 1, 1, 'the .call form');
        assert.equal(code.indexOf('newTarget[a].hasOwnProperty(k)'), -1, 'the shadowable form still executes');
        assert.ok(raw.indexOf('newTarget[a].hasOwnProperty(k)') > -1, 'anti-vacuity: the raw source records the retired form');
    });
});


// ─── (b) the server cloner ───────────────────────────────────────────────────
describe('05 - JSON.clone (server): a key named after an Object.prototype member is cloned with its value', function () {
    MEMBERS.forEach(function (k) {
        it(k, function () {
            var s = {}; s[k] = 'x'; s.a = 1;
            var out = clone(s);
            assert.ok(hasOwn.call(out, k));
            assert.equal(out[k], 'x', 'own ' + k + ' holds the value, not Object.prototype.' + k);
            assert.equal(out.a, 1);
            assert.equal(JSON.parse(JSON.stringify(out))[k], 'x');
        });
    });
});

describe('06 - JSON.clone (server): nested, and inside an array element — the GET inheritedData shapes', function () {
    it('{o:{toString:"x", k:1}} → a real clone carrying toString', function () {
        var s = { o: { toString: 'x', k: 1 } };
        var out = clone(s);
        assert.notEqual(out.o, s.o, 'a clone, not an alias');
        assert.equal(out.o.toString, 'x');
        assert.equal(out.o.k, 1);
    });
    it('{list:[{hasOwnProperty:1, b:2}]} → the element keeps both keys', function () {
        var out = clone({ list: [ { hasOwnProperty: 1, b: 2 } ] });
        assert.equal(out.list[0].hasOwnProperty, 1);
        assert.equal(out.list[0].b, 2);
    });
});

describe('07 - JSON.clone (server): gina\'s installed count, through the installer (utils/prototypes.js)', function () {
    before(function () { require(path.join(REPO_ROOT, 'utils', 'prototypes.js')); });
    it('anti-vacuity: the installer publishes this very module as JSON.clone, and count is installed', function () {
        assert.equal(JSON.clone, clone);
        assert.equal(typeof Object.prototype.count, 'function');
    });
    it('{count:"x", a:1} clones with count', function () {
        var out = JSON.clone({ count: 'x', a: 1 });
        assert.ok(hasOwn.call(out, 'count'));
        assert.equal(out.count, 'x');
        assert.equal(JSON.stringify(out), '{"count":"x","a":1}');
    });
});

describe('08 - CONTROL: the cloner\'s other contracts are unchanged', function () {
    it('nested arrays are cloned, not aliased; a Date (any non-plain object) is returned by reference; a class instance is returned as itself', function () {
        var s = { l: [ 1, 2 ], d: new Date(0) };
        var out = clone(s);
        assert.notEqual(out.l, s.l);
        assert.deepEqual(out.l, [ 1, 2 ]);
        assert.ok(out.d instanceof Date);
        assert.equal(out.d.getTime(), 0);
        // measured: the non-plain guard returns the source itself before the rebuild branch is reached
        assert.equal(out.d, s.d);
        function Svc() { this.tag = 'live'; }
        var inst = new Svc();
        assert.equal(clone(inst), inst);
        assert.equal(clone({ svc: inst }).svc, inst);
    });
    it('a plain key is cloned, as it always was; null and primitives pass through', function () {
        assert.deepEqual(clone({ plainKey: 'x', n: null }), { plainKey: 'x', n: null });
        assert.equal(clone(null), null);
        assert.equal(clone('s'), 's');
        assert.equal(clone(7), 7);
    });
});


// ─── (b) the browser cloner ──────────────────────────────────────────────────
describe('09 - JSON.clone (browser polyfill, in its own realm): the same keys are cloned with their value', function () {
    it('flat: toString, hasOwnProperty, valueOf', function () {
        var ctx = browserRealm();
        assert.equal(vm.runInContext('typeof JSON.clone', ctx), 'function', 'the polyfill installed JSON.clone in the realm');
        var out = vm.runInContext('JSON.clone({ toString: "x", hasOwnProperty: "y", valueOf: "v", a: 1 })', ctx);
        assert.ok(hasOwn.call(out, 'toString'));
        assert.equal(out.toString, 'x');
        assert.equal(out.hasOwnProperty, 'y');
        assert.equal(out.valueOf, 'v');
        assert.equal(out.a, 1);
        assert.equal(vm.runInContext('typeof Object.prototype.toString', ctx), 'function', 'the realm\'s Object.prototype is untouched');
    });
    it('nested and inside an array element', function () {
        var ctx = browserRealm();
        var out = vm.runInContext('JSON.clone({ o: { valueOf: "v", k: 1 }, list: [ { hasOwnProperty: 1, b: 2 } ] })', ctx);
        assert.equal(out.o.valueOf, 'v');
        assert.equal(out.o.k, 1);
        assert.equal(out.list[0].hasOwnProperty, 1);
        assert.equal(out.list[0].b, 2);
    });
});

describe('10 - JSON.clone (browser polyfill): the other contracts are unchanged', function () {
    it('CONTROL: a real clone (objects and arrays not aliased), a plain key, a class instance returned as itself', function () {
        var ctx = browserRealm();
        var r = vm.runInContext('(function () { var s = { o: { k: 1 }, l: [ 1, 2 ], plainKey: "x" }; var c = JSON.clone(s); function Svc() { this.tag = "live"; } var i = new Svc(); return { s: s, c: c, i: i, ci: JSON.clone(i) }; })()', ctx);
        assert.notEqual(r.c.o, r.s.o);
        assert.notEqual(r.c.l, r.s.l);
        assert.equal(r.c.l.length, 2);
        assert.equal(r.c.l[0], 1);
        assert.equal(r.c.plainKey, 'x');
        assert.equal(r.ci, r.i);
    });
});


// ─── (b) source pins ─────────────────────────────────────────────────────────
describe('11 - source pins: both cloners fill when the target lacks an OWN defined value', function () {
    function views(file) {
        var raw = fs.readFileSync(file, 'utf8');
        return { raw: raw, code: raw.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n') };
    }
    it('server: utils/prototypes.json_clone.js', function () {
        var v = views(CLONE_SRC);
        assert.equal(v.code.split("( typeof(target[key]) == 'undefined' || !Object.prototype.hasOwnProperty.call(target, key) ) ? JSONClone(source[key], null) : target[key];").length - 1, 1, 'the widened fill test');
        assert.equal(v.code.indexOf("(typeof(target[key]) == 'undefined' ) ? JSONClone(source[key], null) : target[key];"), -1, 'the old test still executes');
        assert.ok(v.raw.indexOf("(typeof(target[key]) == 'undefined' ) ? JSONClone(source[key], null) : target[key];") > -1, 'anti-vacuity: the raw source records the old test');
    });
    it('browser: core/asset/plugin/src/vendor/gina/utils/polyfill.js', function () {
        var v = views(POLYFILL);
        assert.equal(v.code.split("(typeof target[keys[i]] == 'undefined' || !Object.prototype.hasOwnProperty.call(target, keys[i])) ? clone(source[keys[i]], null) : target[keys[i]];").length - 1, 1, 'the widened fill test');
        assert.equal(v.code.indexOf("(typeof target[keys[i]] == 'undefined') ? clone(source[keys[i]], null) : target[keys[i]];"), -1, 'the old test still executes');
        assert.ok(v.raw.indexOf("(typeof target[keys[i]] == 'undefined') ? clone(source[keys[i]], null) : target[keys[i]];") > -1, 'anti-vacuity: the raw source records the old test');
    });
});


// ─── 12  dist pins ───────────────────────────────────────────────────────────
// Derived from the EMITTED artifact, never guessed. Closure keeps the built-in call
// verbatim and renames the locals: the element fill reads
//   `for(ba in m[ha])h(ba)||Object.prototype.hasOwnProperty.call(r[ha],ba)||(r[ha][ba]=m[ha][ba])`
// and the polyfill's fill, its ternary FLIPPED by the compiler, reads
//   `E[O[r]]=typeof E[O[r]]!='undefined'&&Object.prototype.hasOwnProperty.call(E,O[r])?E[O[r]]:clone(h[O[r]],null)`
// (a line wrap allowed after the `:`). Identifier-agnostic (backreferences) and
// wrap-agnostic. Validated against the pre-fix artifact: 0 and 0 (the bundle-wide
// count of the built-in call rose from 9 to 11), the shadowable element test 1 → 0.
describe('12 - dist pins: the browser bundle carries both fills', function () {
    it('the unminified bundle carries the mergeArray .call form and the widened polyfill test verbatim, once each', function () {
        var js = fs.readFileSync(DIST_JS, 'utf8');
        assert.equal(js.split('if (!Object.prototype.hasOwnProperty.call(newTarget[a], k)) {').length - 1, 1, 'mergeArray');
        assert.equal(js.split("(typeof target[keys[i]] == 'undefined' || !Object.prototype.hasOwnProperty.call(target, keys[i])) ? clone(source[keys[i]], null) : target[keys[i]];").length - 1, 1, 'polyfill');
    });
    it('the minified bundle carries the element fill through the built-in and the flipped polyfill fill, once each; the shadowable element test is gone', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        var a = min.match(/\|\|Object\.prototype\.hasOwnProperty\.call\((\w+)\[(\w+)\],\s*(\w+)\)\|\|\(\1\[\2\]\[\3\]=(\w+)\[\2\]\[\3\]\)/g) || [];
        var b = min.match(/typeof (\w+)\[(\w+)\[(\w+)\]\]!='undefined'&&Object\.prototype\.hasOwnProperty\.call\(\1,\s*\2\[\3\]\)\?\1\[\2\[\3\]\]:\s*(\w+)\(/g) || [];
        // the retired shape is the element's OWN hasOwnProperty guarding the fill into that element —
        // `r[ha].hasOwnProperty(ba)||(r[ha][ba]=…` — two unrelated `x[y].hasOwnProperty(` sites exist
        // elsewhere in the bundle, so the pin carries the fill tail (pre-fix artifact: 1, now 0)
        var neg = min.match(/(\w+)\[(\w+)\]\.hasOwnProperty\((\w+)\)\|\|\(\1\[\2\]\[\3\]=/g) || [];
        assert.equal(a.length, 1, 'element fills through the built-in in gina.min.js: ' + a.length);
        assert.equal(b.length, 1, 'widened polyfill fills in gina.min.js: ' + b.length);
        assert.equal(neg.length, 0, 'shadowable element fills still in gina.min.js: ' + neg.length);
    });
});
