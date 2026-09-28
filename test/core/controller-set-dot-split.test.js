'use strict';
/**
 * set() splits a dotted name with string operations (phase-2 per-request trims, slice D1).
 *
 * `set()` (core/controller/controller.js) builds `local.userData` from dotted names — about 60
 * calls per routed request of a bundle with views. It tested for a dot with `/\./.test(name)`
 * and split with `name.split(/\./g)`; it now uses `name.indexOf('.') !== -1` and
 * `name.split('.')`, which answer the same for every string (`split` ignores the `g` flag)
 * without the regex machinery — −4.8 µs per request in the profile scene (the phase-2 design
 * record, § 8).
 *
 *  §01 source pins — on the extracted set() block, comments stripped: no regex left in the dot
 *      test or the split, and the string forms present.
 *  §02 behavioural — the extracted block compiled the way test/core/controller-set-path.test.js
 *      compiles it (`new Function('local', 'merge', …)`): names with empty, leading and trailing
 *      segments land exactly on the path `split(/\./g)` names, a dot-free name takes the flat
 *      branch, and a `__proto__` segment still throws. The broad equivalence stays with
 *      controller-set-path.test.js's differential against the frozen pre-#P39 set().
 *
 * Seam: GINA_CONTROLLER_SRC=<file> runs every arm against that text. Red-first against
 * `git show HEAD:<fw>/core/controller/controller.js`: the §01 pins read RED, §02 stays GREEN on
 * both revisions — the same answers are the point of the slice.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SOURCE = process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js');
var merge  = require(path.join(FW, 'lib/merge'));
var src    = fs.readFileSync(SOURCE, 'utf8');

var START = "    var set = function(name, value, override) {";
var END   = "    /**\n     * Get data";
function setBlock(source) {
    var s0 = source.indexOf(START), s1 = source.indexOf(END, s0);
    assert.ok(s0 > -1 && s1 > s0, 'the set() block is located');
    return source.slice(s0, s1);
}
function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''); }
function count(hay, needle) { return hay.split(needle).length - 1; }
function makeSet() {
    var local = { userData: {} };
    var set = new Function('local', 'merge', setBlock(src) + '\n return set;')(local, merge);
    return { local: local, set: set };
}

describe('§01 source pins — string forms in set()', function () {

    var raw = null, code = null;

    it('anti-vacuity: the block extracts and the strip keeps its code', function () {
        raw = setBlock(src);
        code = stripComments(raw);
        assert.ok(code.indexOf('var keys = ') > -1, 'the split assignment survived the strip');
        assert.equal(count(code, '{'), count(code, '}'), 'balanced braces');
    });

    it('no regex in the dot test or the split', function () {
        code = code || stripComments(setBlock(src));
        assert.equal(count(code, '/\\./.test(name)'), 0, 'the dot test');
        assert.equal(count(code, 'name.split(/\\./g)'), 0, 'the split');
    });

    it('the string forms are present', function () {
        code = code || stripComments(setBlock(src));
        assert.equal(count(code, "name.indexOf('.') !== -1"), 1, 'the dot test');
        assert.equal(count(code, "name.split('.')"), 1, 'the split');
    });
});

describe('§02 behavioural — the same paths as the regex split', function () {

    function walk(root, keys) { var n = root; keys.forEach(function (k) { n = (n == null) ? undefined : n[k]; }); return n; }

    ['a..b', '.a', 'a.', 'x.y.z', 'page.environment.memory allocated', 'a...b.'].forEach(function (name) {
        it('control: ' + JSON.stringify(name) + ' lands on split(/\\./g)', function () {
            var s = makeSet();
            s.set(name, 'V');
            assert.equal(walk(s.local.userData, name.split(/\./g)), 'V');
        });
    });

    it('control: a dot-free name takes the flat branch (backslashes stripped)', function () {
        var s = makeSet();
        s.set('flat', 'a\\b');
        assert.equal(s.local.userData.flat, 'ab');
    });

    it('control: a __proto__ segment still throws', function () {
        var s = makeSet();
        assert.throws(function () { s.set('a.__proto__.b', 1); }, /__proto__/);
    });
});
