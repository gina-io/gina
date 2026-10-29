/**
 * #B846 — `| length` on a string renders the string's length, on both template engines.
 *
 * gina installs a `count()` helper on `Object.prototype` (`utils/prototypes.js`), and both
 * `length` filters (`lib/swig-filters`, `lib/nunjucks-filters`) called `input.count()`
 * whenever it was a function, which it is for every string. On a String receiver `count()`
 * first runs `JSON.parse(this)`: on text that is not JSON the line throws and the helper
 * returns `undefined`, so `{{ "abc" | length }}` rendered empty, `{% if s | length %}` was
 * false for any such string, and the documented `{{ "hello"|length }}` (5) rendered empty.
 * JSON-looking strings ('{"a":1}', "5") came out right only because `count()` then loops the
 * string's indices. The filters now read a string's own `.length` before `count()`: a
 * primitive, a String object, and a nunjucks SafeString (`| safe` wraps its value in one).
 *
 * Swig hands a filter "" for a missing or null variable, so on swig `{{ missing | length }}`
 * now renders 0 (it rendered empty) and `| length | default(x)` gives 0 rather than x. Both
 * match swig's own `length` filter and the nunjucks path, which already gave 0.
 *
 * The harness installs `utils/prototypes`, as a bundle process does, and asserts it did:
 * without it `'abc'.count` is undefined, the filter falls through to `.length`, and every
 * string arm passes on the unfixed code too (the condition the replica tests in
 * swig-filters.test.js §02 and nunjucks-filters.test.js §08 run in). The filters are the
 * REAL factories' (`lib/swig-filters`, `lib/nunjucks-filters`), run through the real engines
 * (@rhinostone/swig from the framework dir, nunjucks), and each string arm is checked
 * against the engine's own `length` filter as an independent oracle.
 *
 * Run:
 *   node --test test/lib/length-filter-strings-b846.test.js
 */
'use strict';

var path   = require('path');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var FW = require('../fw');

require(path.join(FW, '..', '..', 'utils', 'prototypes')); // Object.prototype.count(), as in a bundle process

var swigLib  = require(path.join(FW, 'node_modules/@rhinostone/swig'));
var nunjucks = require('nunjucks');

var priorGlobals = {};
var engines      = {};

/** Strings, with the length each engine's own `length` filter gives them. */
var STRINGS = [
    ['"abc"', 'abc', '3'],
    ['"" (empty)', '', '0'],
    ['"héllo" (non-ASCII)', 'héllo', '5'],
    ['"😀x" (a surrogate pair counts two, as .length does)', '😀x', '3'],
    ['a JSON-looking string, unchanged', '{"a":1}', '7'],
    ['"5", unchanged', '5', '1']
];

/** Receivers that are not strings: the fix must not touch them. */
var NON_STRINGS = [
    ['an array', [1, 2, 3], '3'],
    ['an empty array', [], '0'],
    ['a plain object (key count)', { a: 1, b: 2 }, '2'],
    ['an object with an own `count` field (#B546)', { count: 'x', a: 2 }, '2'],
    ['a collection with its own count() method', { count: function () { return 42; } }, '42'],
    ['a number', 5, '0'],
    ['a boolean', true, '0']
];

function setup(engine, ginaFilters) {
    if (engine === 'swig') {
        var gina = new swigLib.Swig({ autoescape: false, cache: false });
        gina.setFilter('length', ginaFilters.length);
        var native = new swigLib.Swig({ autoescape: false, cache: false });
        return {
            gina   : function (tpl, data) { return gina.render(tpl, { locals: data || {} }); },
            native : function (tpl, data) { return native.render(tpl, { locals: data || {} }); }
        };
    }
    var env = new nunjucks.Environment(null, { autoescape: false });
    env.addFilter('length', ginaFilters.length);
    var nativeEnv = new nunjucks.Environment(null, { autoescape: false });
    return {
        gina   : function (tpl, data) { return env.renderString(tpl, data || {}); },
        native : function (tpl, data) { return nativeEnv.renderString(tpl, data || {}); }
    };
}

before(function () {
    priorGlobals.FWDIR = global.GINA_FRAMEWORK_DIR;
    priorGlobals.under = global._;
    global.GINA_FRAMEWORK_DIR = FW;
    if (typeof global._ !== 'function') { global._ = function (p) { return String(p); }; }
    engines.swig     = setup('swig', require(path.join(FW, 'lib/swig-filters'))({ options: {}, isProxyHost: false }));
    engines.nunjucks = setup('nunjucks', require(path.join(FW, 'lib/nunjucks-filters'))({ options: {}, isProxyHost: false }));
});

after(function () {
    if (typeof priorGlobals.FWDIR === 'undefined') { delete global.GINA_FRAMEWORK_DIR; }
    else { global.GINA_FRAMEWORK_DIR = priorGlobals.FWDIR; }
    if (typeof priorGlobals.under === 'undefined') { delete global._; }
    else { global._ = priorGlobals.under; }
});

describe('#B846 §00 — the harness reproduces a bundle process', function () {

    it('00.1 - gina\'s count() helper is installed, so a string has a callable `count`', function () {
        assert.equal(typeof 'abc'.count, 'function',
            'without utils/prototypes every string arm below passes on the unfixed filters too');
    });

    it('00.2 - instrument control: a filter that renders nothing for a string FAILS the check', function () {
        var broken = new swigLib.Swig({ autoescape: false, cache: false });
        broken.setFilter('length', function () { return undefined; });
        assert.throws(function () {
            assert.equal(broken.render('{{ v|length }}', { locals: { v: 'abc' } }), '3');
        }, 'the render-and-compare check must be able to report a failure, or every arm below is void');
    });
});

['swig', 'nunjucks'].forEach(function (engine) {

    describe('#B846 §01 — ' + engine + ': `| length` on a string is its length', function () {

        STRINGS.forEach(function (row, i) {
            it('01.' + (i + 1) + ' - ' + row[0] + ' → ' + row[2] + ', as the engine\'s own filter gives it', function () {
                var e = engines[engine];
                assert.equal(e.native('{{ v|length }}', { v: row[1] }), row[2], 'oracle: the engine\'s own length filter');
                assert.equal(e.gina('{{ v|length }}', { v: row[1] }), row[2]);
            });
        });

        it('01.7 - a String object → 3', function () {
            /* eslint-disable no-new-wrappers */
            assert.equal(engines[engine].gina('{{ v|length }}', { v: new String('abc') }), '3');
        });

        it('01.8 - the documented literal `{{ "hello"|length }}` → 5', function () {
            assert.equal(engines[engine].gina('{{ "hello"|length }}'), '5');
        });

        it('01.9 - `{% if s|length %}` is true for a non-empty string, false for an empty one', function () {
            var tpl = '{% if s|length %}T{% else %}F{% endif %}';
            assert.equal(engines[engine].gina(tpl, { s: 'abc' }), 'T');
            assert.equal(engines[engine].gina(tpl, { s: '' }), 'F');
        });

        it('01.10 - a missing or null variable → 0, and `| length | default("No")` keeps the 0', function () {
            var e = engines[engine];
            assert.equal(e.gina('{{ v|length }}', {}), '0', 'missing');
            assert.equal(e.gina('{{ v|length }}', { v: null }), '0', 'null');
            assert.equal(e.gina('{{ v|length|default("No") }}', {}), '0', 'missing, then default');
            assert.equal(e.gina('{% if v|length %}T{% else %}F{% endif %}', {}), 'F', 'missing stays falsy');
        });
    });

    describe('#B846 §02 — ' + engine + ': every receiver that is not a string is unchanged', function () {

        NON_STRINGS.forEach(function (row, i) {
            it('02.' + (i + 1) + ' - ' + row[0] + ' → ' + row[2], function () {
                assert.equal(engines[engine].gina('{{ v|length }}', { v: row[1] }), row[2]);
            });
        });
    });
});

describe('#B846 §03 — nunjucks: `| safe` wraps a string in a SafeString, which counts as the string', function () {

    it('03.1 - `"abc"|safe|length` → 3, as nunjucks\'s own filter gives it', function () {
        var e = engines.nunjucks;
        assert.equal(e.native('{{ v|safe|length }}', { v: 'abc' }), '3', 'oracle');
        assert.equal(e.gina('{{ v|safe|length }}', { v: 'abc' }), '3');
    });

    it('03.2 - a JSON-looking string through `| safe` → its length (7), not the SafeString\'s two fields', function () {
        var e = engines.nunjucks;
        assert.equal(e.native('{{ v|safe|length }}', { v: '{"a":1}' }), '7', 'oracle');
        assert.equal(e.gina('{{ v|safe|length }}', { v: '{"a":1}' }), '7');
    });
});
