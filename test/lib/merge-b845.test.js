/**
 * #B845 — fill-only merge() loses a source key named after an Object.prototype member.
 *
 * Mechanism: browse() reads `src = target[name]` THROUGH the prototype chain, so on a
 * plain target a key such as `toString`, `valueOf`, `isPrototypeOf`, `hasOwnProperty`
 * (or gina's installed `count`) reads as an EXISTING value; the primitive branch then
 * applies the target-wins rule and writes that inherited FUNCTION back as an OWN key
 * over the source's value. JSON.stringify omits a function, so a PUT form field so
 * named reached the action as nothing (`hasOwnProperty=x&a=1` → `put={"a":"1"}`,
 * measured on a booted bundle). The object and array branches already route an
 * inherited function to a fresh clone, so only the primitive branch was affected; a
 * nested EXISTING target object reaches that branch through the recursion (03).
 *
 * Fix: a value the target holds only THROUGH Object.prototype — not an own property,
 * and identical to `Object.prototype[name]` — is a MISSING key for the fill-only rule.
 * Any other inherited value (an entity's .sql-derived query methods, a class's own
 * `toString`) keeps the documented target-wins rule; that boundary is pinned in 08.
 *
 * RED-FIRST (measured on the unfixed bytes, 2026-10-30): 15 of 27 red — the arms of
 * 01 (6), 03 (2), 05, 08b, 08c, 11 and 13, plus the two source pins of 14; the
 * controls (02, 04, 06, 07, 08a, 09, 10, 12) pass on both revisions. The dist pins
 * (15) are red before the rebuild.
 */
'use strict';

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var util   = require('util');
var { EventEmitter } = require('events');

var FRAMEWORK = path.resolve(require('../fw'));
var REPO_ROOT = path.resolve(__dirname, '..', '..');
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/merge/src/main.js');
var DIST_JS   = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN  = path.join(FRAMEWORK, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');
var merge     = require(path.join(FRAMEWORK, 'lib/merge'));
var hasOwn    = Object.prototype.hasOwnProperty;

/** The built-in Object.prototype members a form field or JSON key can be named after. */
var MEMBERS = ['toString', 'valueOf', 'isPrototypeOf', 'hasOwnProperty', 'propertyIsEnumerable', 'toLocaleString'];

/** A source bag: `{ <k>: v, a: '1' }`. */
function bag(k, v) { var o = {}; o[k] = v; o.a = '1'; return o; }


// ─── 01  the flat shape ──────────────────────────────────────────────────────
describe('01 - fill-only: a source key named after an Object.prototype member is FILLED on a plain target', function () {
    MEMBERS.forEach(function (k) {
        it(k + ': the source value lands as an own key, not the inherited function', function () {
            var out = merge({}, bag(k, 'x'));
            assert.ok(hasOwn.call(out, k), k + ' is an own key of the result');
            assert.equal(out[k], 'x', 'own ' + k + ' holds the source value, not Object.prototype.' + k);
            assert.equal(out.a, '1');
            assert.equal(JSON.parse(JSON.stringify(out))[k], 'x', 'the value survives JSON (what an action sees)');
        });
    });
    it('CONTROL: a plain key is filled, as it always was', function () {
        assert.deepEqual(merge({}, bag('plainKey', 'x')), { plainKey: 'x', a: '1' });
    });
});


// ─── 02  the request shape ───────────────────────────────────────────────────
describe('02 - CONTROL: a parsed body merged into an empty bag keeps a plain field, and `count` without the prototypes installed is a plain key', function () {
    it('a parsed body with plain fields', function () {
        var out = merge({}, JSON.parse('{"plain":"x","a":"1"}'));
        assert.deepEqual(JSON.parse(JSON.stringify(out)), { plain: 'x', a: '1' });
    });
    it('count, when nothing is installed on Object.prototype (11 installs it)', function () {
        assert.equal(merge({}, bag('count', 'x')).count, 'x');
    });
});


// ─── 03  nested, existing target ─────────────────────────────────────────────
describe('03 - a nested EXISTING target object: the recursion reaches the same primitive branch', function () {
    it('{o:{k:1}} + {o:{toString:"x", k:2}}: toString is filled, k is kept (target wins on an OWN key)', function () {
        var out = merge({ o: { k: 1 } }, { o: { toString: 'x', k: 2 } });
        assert.equal(out.o.toString, 'x');
        assert.equal(out.o.k, 1);
    });
    it('two levels down, the same', function () {
        var out = merge({ o: { p: { k: 1 } } }, { o: { p: { valueOf: 'v' } } });
        assert.equal(out.o.p.valueOf, 'v');
        assert.equal(out.o.p.k, 1);
    });
});


// ─── 04  nested, fresh target (createMode) ───────────────────────────────────
describe('04 - CONTROL: a nested object the target LACKS is copied with the key (createMode copies every source key)', function () {
    it('{} + {o:{toString:"x", k:1}}', function () {
        var out = merge({}, { o: { toString: 'x', k: 1 } });
        assert.equal(out.o.toString, 'x');
        assert.equal(out.o.k, 1);
    });
});


// ─── 05  variadic ────────────────────────────────────────────────────────────
describe('05 - variadic: the first source fills the key; the second meets an OWN value and loses', function () {
    it('merge({}, {toString:"a"}, {toString:"b"}) → "a"', function () {
        assert.equal(merge({}, { toString: 'a' }, { toString: 'b' }).toString, 'a');
    });
});


// ─── 06  override ────────────────────────────────────────────────────────────
describe('06 - CONTROL: override mode is unchanged (source wins)', function () {
    it('on an empty target and over an own target value', function () {
        assert.equal(merge({}, { toString: 'x' }, true).toString, 'x');
        assert.equal(merge({ toString: 't' }, { toString: 'x' }, true).toString, 'x');
    });
});


// ─── 07  own value wins ──────────────────────────────────────────────────────
describe('07 - CONTROL: an OWN target value still wins in fill-only mode', function () {
    it('flat and nested', function () {
        assert.equal(merge({ toString: 't' }, { toString: 'x' }).toString, 't');
        assert.equal(merge({ o: { toString: 't' } }, { o: { toString: 'x' } }).o.toString, 't');
    });
});


// ─── 08  the boundary of the fix ─────────────────────────────────────────────
describe('08 - the boundary: only a value held THROUGH Object.prototype counts as missing', function () {
    it('a: CONTROL — a class whose prototype defines its OWN toString keeps it (target wins, as before)', function () {
        function Foo() { this.tag = 'foo'; }
        Foo.prototype.toString = function () { return 'Foo!'; };
        var f = new Foo();
        var out = merge(f, { toString: 'x', a: 1 });
        assert.equal(out, f, 'return identity');
        assert.equal(out.toString, Foo.prototype.toString, 'the class method is kept');
        assert.equal(String(out), 'Foo!');
        assert.equal(out.a, 1);
    });
    it('b: a class whose prototype INHERITS Object.prototype.toString takes the source value', function () {
        function Bar() { this.tag = 'bar'; }
        var b = new Bar();
        assert.equal(Bar.prototype.toString, Object.prototype.toString, 'anti-vacuity: Bar inherits the built-in');
        assert.equal(hasOwn.call(Bar.prototype, 'toString'), false);
        var out = merge(b, { toString: 'x' });
        assert.equal(out, b, 'return identity');
        assert.equal(out.toString, 'x');
    });
    it('c: the fill shadows on the target only — Object.prototype itself keeps its methods', function () {
        var out = merge({}, { toString: 'x', hasOwnProperty: 'y' });
        assert.equal(out.toString, 'x');
        assert.equal(out.hasOwnProperty, 'y');
        assert.equal(typeof Object.prototype.toString, 'function');
        assert.equal(typeof Object.prototype.hasOwnProperty, 'function');
        assert.equal(({}).toString(), '[object Object]');
        assert.equal(({ q: 1 }).hasOwnProperty('q'), true);
    });
});


// ─── 09  the entity contract ─────────────────────────────────────────────────
describe('09 - CONTROL: inherited enumerable SOURCE members are still copied (the #B446 follow-up contract)', function () {
    it('merge({}, new Entity()) carries the prototype query method and the own field', function () {
        function Entity() { this.name = 'demo'; }
        util.inherits(Entity, EventEmitter);
        Entity.prototype.getOneById = function () { return 'proto'; };
        var m = merge({}, new Entity());
        assert.equal(typeof m.getOneById, 'function');
        assert.equal(m.getOneById(), 'proto');
        assert.equal(m.name, 'demo');
    });
});


// ─── 10  null-prototype target ───────────────────────────────────────────────
describe('10 - CONTROL: a null-prototype target inherits nothing and was never affected', function () {
    it('merge(Object.create(null), {toString:"x"})', function () {
        var out = merge(Object.create(null), { toString: 'x' });
        assert.equal(out.toString, 'x');
        assert.equal(Object.getPrototypeOf(out), null);
    });
});


// ─── 11  gina's own installed member ─────────────────────────────────────────
describe('11 - gina\'s installed Object.prototype.count (the server prototypes, utils/prototypes.js)', function () {
    before(function () { require(path.join(REPO_ROOT, 'utils', 'prototypes.js')); });

    it('anti-vacuity: count is installed, non-enumerable, writable', function () {
        var d = Object.getOwnPropertyDescriptor(Object.prototype, 'count');
        assert.equal(typeof d.value, 'function');
        assert.equal(d.enumerable, false);
        assert.equal(d.writable, true);
    });
    it('a source key named count is filled on a plain target', function () {
        var out = merge({}, bag('count', 'x'));
        assert.ok(hasOwn.call(out, 'count'));
        assert.equal(out.count, 'x');
        assert.equal(JSON.stringify(out), '{"count":"x","a":"1"}');
    });
    it('CONTROL: an own count still wins, and the prototype method still counts', function () {
        assert.equal(merge({ count: 'own' }, bag('count', 'x')).count, 'own');
        assert.equal(Object.prototype.count.call({ a: 1, b: 2 }), 2);
        assert.equal(({ a: 1 }).count(), 1);
    });
});


// ─── 12  the #B446 guard ─────────────────────────────────────────────────────
describe('12 - CONTROL: the #B446 key rejection is unchanged', function () {
    it('__proto__ / constructor keys are still refused; a sibling survives', function () {
        try {
            var out = merge({}, JSON.parse('{"__proto__":{"pollutedByB845":"OWNED"},"constructor":"c","k":1}'));
            assert.equal(({}).pollutedByB845, undefined);
            assert.equal(hasOwn.call(out, 'constructor'), false);
            assert.equal(out.k, 1);
        } finally {
            delete Object.prototype.pollutedByB845;
        }
    });
});


// ─── 13  return identity ─────────────────────────────────────────────────────
describe('13 - merge returns the target reference, and the fill landed on that reference', function () {
    it('on a fill of an Object.prototype-named key', function () {
        var t = {};
        assert.equal(merge(t, { toString: 'x' }), t);
        assert.equal(t.toString, 'x');
    });
});


// ─── 14  source pins ─────────────────────────────────────────────────────────
describe('14 - source pins', function () {
    var raw  = fs.readFileSync(MAIN_SRC, 'utf8');
    // comment-stripped view for the negative pin: the retired condition legitimately survives in a `// was:` record
    var code = raw.split('\n').map(function (l) { return l.replace(/\/\/.*$/, ''); }).join('\n');

    it('the helper is defined once, its body is the own-and-built-in test, and the primitive branch consults it once', function () {
        assert.equal(code.split('var isHeldThroughObjectPrototype = function(target, name, value) {').length - 1, 1, 'helper definition');
        assert.equal(code.split('return !hasOwn.call(target, name) && value === Object.prototype[name];').length - 1, 1, 'helper body');
        assert.equal(code.split('&& !isHeldThroughObjectPrototype(target, name, src)').length - 1, 1, 'the call in the primitive branch');
    });
    it('the retired condition (`&& !override` closing the test) is gone from the CODE and survives in the raw `was:` record', function () {
        var retired = /&& !override\s*\)\s*\{/;
        assert.equal(retired.test(code), false, 'the retired condition still executes');
        assert.equal(retired.test(raw), true, 'anti-vacuity: the raw source still records the retired condition');
        assert.ok(code.indexOf("typeof(src) != 'undefined'") > -1, 'anti-vacuity: the primitive branch is still in the stripped view');
    });
});


// ─── 15  dist pins ───────────────────────────────────────────────────────────
// Derived from the EMITTED artifact, never guessed. The unminified bundle carries the
// source verbatim. Closure INLINES the one-call helper into the primitive branch, as
// `q=!(!E.call(u,q)&&la===Object.prototype[q])` (identifiers renamed, so the pin is
// identifier-agnostic with a backreference on the key variable and wrap-agnostic).
// Validated against the pre-fix artifact: 0 matches, and `Object.prototype[` absent.
describe('15 - dist pins: the browser bundle carries the fill rule', function () {
    it('the unminified bundle carries the helper, its body and the call verbatim, once each', function () {
        var js = fs.readFileSync(DIST_JS, 'utf8');
        assert.equal(js.split('var isHeldThroughObjectPrototype = function(target, name, value) {').length - 1, 1, 'helper definition');
        assert.equal(js.split('return !hasOwn.call(target, name) && value === Object.prototype[name];').length - 1, 1, 'helper body');
        assert.equal(js.split('&& !isHeldThroughObjectPrototype(target, name, src)').length - 1, 1, 'the call');
    });
    it('the minified bundle carries the inlined own-and-built-in test exactly once', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        var hits = min.match(/!\(\s*!(\w+)\.call\((\w+),\s*(\w+)\)\s*&&\s*(\w+)\s*===\s*Object\.prototype\[\3\]\s*\)/g) || [];
        assert.equal(hits.length, 1, 'inlined fill tests in gina.min.js: ' + hits.length);
        assert.equal((min.match(/Object\.prototype\[/g) || []).length, 1, 'anti-vacuity: the Object.prototype[...] read is in the bundle once');
    });
});
