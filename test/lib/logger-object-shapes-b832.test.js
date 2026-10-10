'use strict';
/**
 * A logged value can no longer make a log call throw (#B832).
 *
 * Both stdout writers built a line from a logged value in ways a CLIENT-shaped
 * value could break, and the TypeError landed in the CALLER:
 *   1 — the levelled walk `parse()` counted keys with `obj.count()`, an ordinary
 *       property lookup that an OWN key named `count` shadows (a parsed body
 *       `{"count": 5}`): `obj.count is not a function`;
 *   2 — the argument-type switches of both writers tested `instanceof Object`,
 *       which is false for a null-prototype object (`querystring.parse()`,
 *       `Object.create(null)`): the object fell into a string path and coercing
 *       it threw `Cannot convert object to primitive value`;
 *   3 — the levelled walk coerced an array element or a scalar value with
 *       `'' + value`, which throws on an object with no usable toString/valueOf
 *       (an array element `{"toString": "x"}` from a JSON body, a null-prototype
 *       element) and on a Symbol; a top-level Symbol threw on both writers.
 * The same count also made an object with an own `hasOwnProperty` key render
 * with its commas missing (the helper's own `this.hasOwnProperty` call throws
 * there, and its catch returns 0).
 *
 * The fix, all BEHAVIORAL here (the real singleton is driven): the key count is
 * `Object.keys(obj).length`, the number `count()` returns on every receiver it
 * handles (§01.3) and the right one on a null-prototype object or an object
 * with an own `hasOwnProperty` key, where `Object.prototype.count.call` returns
 * 0 (§01.2); a null-prototype object takes the object path; a value whose
 * coercion throws is written as its `Object.prototype.toString` tag, so an
 * object inside an array reads `[object Object]` whatever its prototype; a
 * Symbol is written with `String()`.
 *
 * §02 asserts each repaired shape renders exactly like an ordinary shape of the
 * same content (a differential: no layout is hard-coded and the timezone cannot
 * move it). §03 pins the pre-fix text of shapes that already rendered: they must
 * not move. Red-first: on the pre-fix `lib/logger/src/main.js` every §02 arm
 * fails (eleven throw, 02.06 drops a comma) while §01 and §03 pass.
 * node --test runs each file in its own process, so the singleton cannot leak.
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var qs     = require('querystring');

var FRAMEWORK = path.resolve(require('../fw'));
var MAIN_SRC  = path.join(FRAMEWORK, 'lib/logger/src/main.js');
require(path.resolve(FRAMEWORK, '..', '..', 'utils', 'prototypes')); // Object.prototype.count()

var logger;
var frames = [];

before(function () {
    process.env.GINA_LOG_STDOUT = 'true';
    process.env.GINA_LOG_FORMAT = 'text';
    logger = require(MAIN_SRC);
    process.on('logger#default', function (p) { frames.push(JSON.parse(p)); });
});
after(function () {
    process.removeAllListeners('logger#default');
    delete process.env.GINA_LOG_STDOUT;
    delete process.env.GINA_LOG_FORMAT;
});

/** A null-prototype object holding the own keys of `src`. */
function nullProto(src) {
    var o = Object.create(null);
    Object.keys(src).forEach(function (k) { o[k] = src[k]; });
    return o;
}

var seq = 0;
/**
 * Log `value` at info behind a unique tag and return what the levelled frame
 * holds after the tag. Asserts exactly one frame starts with the tag, so two
 * missing frames can never compare equal.
 */
function render(value) {
    var tag = 'B832-' + ('00' + (++seq)).slice(-3) + '|';
    logger.info(tag, value);
    var f = frames.filter(function (x) { return x.content.indexOf(tag) === 0; });
    assert.equal(f.length, 1, 'one frame for ' + tag);
    return f[0].content.slice(tag.length);
}

/** What the raw writer (`logger.log`) writes to stdout for `value`. */
function rawRender(value) {
    var captured = [];
    var saved = process.stdout.write;
    process.stdout.write = function (s) { captured.push(String(s)); return true; };
    try { logger.log(value); } finally { process.stdout.write = saved; }
    var out = captured.join('');
    assert.ok(out.length > 0, 'the raw writer wrote');
    return out;
}

describe('#B832 §01 — the premise, with controls', function () {

    it('01.1 an own key named count shadows the helper, so calling it throws', function () {
        var o = { count: 5 };
        assert.equal(typeof ({}).count, 'function', 'control: the helper is installed');
        assert.equal(typeof o.count, 'number');
        assert.throws(function () { o.count(); }, TypeError);
    });

    it('01.2 Object.prototype.count.call reads 0 where Object.keys reads the real count', function () {
        assert.equal(Object.prototype.count.call(nullProto({ a: 1, b: 2 })), 0);
        assert.equal(Object.keys(nullProto({ a: 1, b: 2 })).length, 2);
        assert.equal(Object.prototype.count.call({ hasOwnProperty: 'x', a: 1 }), 0);
        assert.equal(Object.keys({ hasOwnProperty: 'x', a: 1 }).length, 2);
    });

    it('01.3 control: Object.keys(x).length equals the helper on every receiver it handles', function () {
        var R = [
            { a: 1, b: 2 }, {}, [1, 2, 3], [1, , 3], Object.assign([1], { k: 2 }), new Date(0),
            Buffer.from('ab'), /x/g, { a: { b: 1 } }, new Number(3), new Map([[1, 2]]),
            new (class A { constructor() { this.x = 1; } })(), Object.create({ inh: 1 }), { count: 5, a: 1 }
        ];
        R.forEach(function (x, i) {
            assert.equal(Object.keys(x).length, Object.prototype.count.call(x), 'receiver #' + i);
        });
    });
});

describe('#B832 §02 — a client-shaped value no longer breaks the call', function () {

    it('02.01 an own count key renders like any other key', function () {
        assert.equal(render({ count: 5, items: ['a'] }), render({ kount: 5, items: ['a'] }).replace('kount', 'count'));
    });

    it('02.02 an own count key in a nested object', function () {
        assert.equal(render({ meta: { count: 3 } }), render({ meta: { kount: 3 } }).replace('kount', 'count'));
    });

    it('02.03 a null-prototype object as the argument renders like a plain one', function () {
        assert.equal(render(nullProto({ a: 'x', b: 'y' })), render({ a: 'x', b: 'y' }));
    });

    it('02.04 a null-prototype object as a value', function () {
        assert.equal(render({ q: nullProto({ a: 'x' }) }), render({ q: { a: 'x' } }));
    });

    it('02.05 the querystring.parse result of a query string', function () {
        assert.equal(render(qs.parse('a=b&c=d')), render({ a: 'b', c: 'd' }));
    });

    it('02.06 an own hasOwnProperty key keeps its commas', function () {
        assert.equal(
            render({ hasOwnProperty: 'x', a: 1 }),
            render({ hasOwnPropertY: 'x', a: 1 }).replace('hasOwnPropertY', 'hasOwnProperty')
        );
    });

    it('02.07 a null-prototype object inside an array reads [object Object], like a plain one', function () {
        assert.equal(render([nullProto({ a: 'x' }), 2]), render([{ a: 'x' }, 2]));
    });

    it('02.08 an array element {"toString": "x"} from a JSON body', function () {
        assert.equal(render(JSON.parse('[{"toString":"x"}, 2]')), render([{ a: 1 }, 2]));
    });

    it('02.09 a Symbol value is written with String()', function () {
        assert.equal(render({ s: Symbol('a') }), render({ s: 5 }).replace('5', 'Symbol(a)'));
    });

    it('02.10 a top-level Symbol argument', function () {
        assert.equal(render(Symbol('a')), render('Symbol(a)'));
    });

    it('02.11 raw writer: a null-prototype object and a querystring.parse result', function () {
        assert.equal(rawRender(nullProto({ a: 'x' })), rawRender({ a: 'x' }));
        assert.equal(rawRender(qs.parse('a=b')), rawRender({ a: 'b' }));
    });

    it('02.12 raw writer: a top-level Symbol', function () {
        assert.equal(rawRender(Symbol('a')), rawRender('Symbol(a)'));
    });
});

describe('#B832 §03 — controls: shapes that already rendered do not move', function () {

    // The text each shape rendered on the pre-fix logger (develop 2d0baa2d8), after the tag.
    [
        ['a plain object',                  { a: 1, b: 'x' },                         ' {"a": 1, "b": "x"} '],
        ['a nested object and array',       { a: { b: 1, c: [1, 2] } },               ' {"a": {"b": 1, "c": [ 1, 2 ] } } '],
        ['objects in an array',             [{ k: 'v' }, 2, 'z'],                      ' [ [object Object], 2, "z" ] '],
        ['{"toString":"x"} as the argument', JSON.parse('{"toString":"x"}'),           ' {"toString": "x"} '],
        ['{"toString":"x"} nested',         JSON.parse('{"a":{"toString":"x"}}'),      ' {"a": {"toString": "x"} } '],
        ['{"valueOf":"x"} in an array',     JSON.parse('[{"valueOf":"x"}]'),           ' [ [object Object] ] '],
        ['scalars',                         { n: 1, b: false, z: null, u: undefined }, ' {"n": 1, "b": false, "z": null, "u": undefined} '],
        ['an empty object',                 {},                                        ' {} ']
    ].forEach(function (c, i) {
        it('03.' + (i + 1) + ' ' + c[0] + ' renders as before', function () {
            assert.equal(render(c[1]), c[2]);
        });
    });

    it('03.9 a Date inside an array renders as before (computed in this timezone)', function () {
        assert.equal(render([new Date(0)]), ' [ ' + String(new Date(0)) + ' ] ');
    });

    it('03.10 instrument control: a different value must NOT compare equal', function () {
        assert.notEqual(render({ a: 1 }), render({ a: 2 }));
    });
});
