'use strict';
/**
 * lib/inherits' composed constructor copies nothing onto the instance (phase-2 per-request trims,
 * slice A).
 *
 * The router composes a controller class with `inherits(Controller, SuperController)` on every
 * routed request, and every `new` of a composed class ran three statements that did no work anyone
 * read:
 *   - `this.prototype = cache.prototype` — an own `prototype` property on every instance;
 *   - `this.prototype.name = this.name` — the instance's name stamped onto a SHARED prototype on
 *     every `new` (in a nested chain, onto the PARENT's), always shadowed by the composed class's
 *     own `name`;
 *   - a `for…in` over `b.prototype` copying each member not yet truthy on the instance — only falsy
 *     data props qualify, and EventEmitter's three (`_events`, `_eventsCount`, `_maxListeners`)
 *     are re-set as own by `EventEmitter.init` right after.
 * The prototype chain (z.prototype → a.prototype → b.prototype) resolves every inherited member,
 * as it always did. −13 µs per request at the design scale (the phase-2 design record, § 3).
 *
 *  §01 source pins — comment-stripped: the three statements gone; `if (this)`, the `name`
 *      default, `b.apply` then `cache.apply` kept in that order; zero `require(`.
 *  §02 behavioural — the module loaded from the source under test: an instance owns no
 *      `prototype`; after `new` in a nested chain, no prototype carries a stamped `name`; a falsy
 *      parent prop is not copied onto the instance before the constructors run; a call WITHOUT
 *      `new` (the validator's is-alias) leaves its target without an own `prototype`. Controls:
 *      `instanceof` child/parent/EventEmitter, inherited methods and events work, the connectors'
 *      shape (`Composed.prototype.name` set after `inherits()`) names the instance, and the
 *      no-`new` call runs the parent then the child on the target.
 *  §03 dist — the browser bundle carries the same constructor: no own-copy loop in `gina.js`, no
 *      `prototype.name=` stamp in `gina.min.js`; anti-vacuity: the module's error string is in both.
 *
 * Seams: GINA_INHERITS_SRC=<file> (the module), GINA_DIST_JS / GINA_DIST_MIN_JS=<file> (the two
 * bundles). Red-first against the `git show HEAD:` blobs: the §01 removal pins, the four §02 arms
 * named above and the two §03 absence arms read RED; every control stays GREEN.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var EventEmitter = require('events');

var FW       = require('../fw');
var SOURCE   = process.env.GINA_INHERITS_SRC || path.join(FW, 'lib/inherits/src/main.js');
var DIST     = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js');
var DIST_JS  = process.env.GINA_DIST_JS || path.join(DIST, 'gina.js');
var DIST_MIN = process.env.GINA_DIST_MIN_JS || path.join(DIST, 'gina.min.js');

var src = fs.readFileSync(SOURCE, 'utf8');
var active = src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
    return !/^\s*\/\//.test(l);
}).join('\n');
function count(hay, needle) { return hay.split(needle).length - 1; }
function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

describe('§01 source pins — nothing is copied onto the instance', function () {

    it('anti-vacuity: the strip kept the composed constructor', function () {
        assert.ok(active.length < src.length);
        assert.ok(active.indexOf('return function() {') > -1);
    });

    it('no own `prototype` write, no shared-prototype `name` stamp', function () {
        assert.equal(count(active, 'this.prototype = cache.prototype'), 0);
        assert.equal(count(active, 'this.prototype.name = this.name'), 0);
    });

    it('no own-copy loop over the parent prototype', function () {
        assert.equal(count(active, 'for (var prop in b.prototype)'), 0);
    });

    it('control: the kept statements, in order', function () {
        var g = active.indexOf('if (this) {');
        var n = active.indexOf('if (!this.name) this.name = cache.name;');
        var b = active.indexOf('b.apply(this, arguments);');
        var c = active.indexOf('cache.apply(this, arguments);');
        assert.ok(g > -1 && n > g && b > n && c > b, 'guard, name default, parent, child');
    });

    it('control: zero require(', function () {
        assert.equal(count(active, 'require('), 0);
    });
});

describe('§02 behavioural — the module under test', function () {

    var inherits = null;
    before(function () { inherits = require(SOURCE); });

    it('an instance owns no `prototype`', function () {
        function A() {}
        var Z = inherits(A, EventEmitter);
        assert.equal(own(new Z(), 'prototype'), false);
    });

    it('after `new` in a nested chain, no prototype carries a stamped `name`', function () {
        function Parent() {}
        var P = inherits(Parent, EventEmitter);
        function Child() {}
        var C = inherits(Child, P);
        new C();
        assert.equal(own(Parent.prototype, 'name'), false, "the parent's prototype");
        assert.equal(own(Child.prototype, 'name'), false, "the child's prototype");
    });

    it('a falsy parent prop is not copied onto the instance before the constructors run', function () {
        function B() {}
        B.prototype.flag = 0;
        var seen = null;
        function A() { seen = own(this, 'flag'); }
        var Z = inherits(A, B);
        new Z();
        assert.equal(seen, false);
    });

    it('a call without `new` leaves its target without an own `prototype`', function () {
        function B() {}
        function A() {}
        var Z = inherits(A, B);
        var target = { name: 'field' };
        Z.apply(target, []);
        assert.equal(own(target, 'prototype'), false);
    });

    it('control: instanceof, inherited methods and events', function () {
        function Parent() {}
        var P = inherits(Parent, EventEmitter);
        function Child() { this.kind = 'child'; }
        var C = inherits(Child, P);
        var c = new C(), got = null;
        assert.ok(c instanceof C && c instanceof P && c instanceof EventEmitter);
        assert.equal(c.on, EventEmitter.prototype.on, 'inherited, not copied');
        c.on('x', function (v) { got = v; });
        c.emit('x', 42);
        assert.equal(got, 42);
        assert.equal(c.kind, 'child');
    });

    it("control: the connectors' shape names the instance", function () {
        var Z = inherits(function Entity() {}, EventEmitter);
        Z.prototype.name = 'Invoice';
        assert.equal(new Z().name, 'Invoice');
        var Y = inherits(function Unnamed() {}, EventEmitter);
        assert.equal(new Y().name, 'Unnamed', 'the constructor name is the default');
    });

    it('control: a call without `new` runs the parent then the child on the target', function () {
        var calls = [];
        function B() { calls.push('b:' + this.name); }
        function A() { calls.push('a:' + this.name); }
        var Z = inherits(A, B);
        Z.apply({ name: 'field' }, []);
        assert.deepEqual(calls, ['b:field', 'a:field']);
    });
});

describe('§03 dist — the browser bundle carries the same constructor', function () {

    var js = null, min = null;
    before(function () {
        js  = fs.readFileSync(DIST_JS, 'utf8');
        min = fs.readFileSync(DIST_MIN, 'utf8');
    });

    it("anti-vacuity: the module's error string is in both bundles", function () {
        assert.ok(js.indexOf('neither [ a ] nor [ b ]') > -1, 'gina.js');
        assert.ok(min.indexOf('neither [ a ] nor [ b ]') > -1, 'gina.min.js');
    });

    it('gina.js has no own-copy loop', function () {
        assert.equal(count(js, 'for (var prop in b.prototype)'), 0);
    });

    it('gina.min.js has no prototype-name stamp', function () {
        assert.equal(count(min, 'prototype.name='), 0);
    });
});
