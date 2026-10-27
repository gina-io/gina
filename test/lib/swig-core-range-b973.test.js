/**
 * #B973 — @rhinostone/swig-core up to 2.9.1 built a range of any size: its
 * range helper, which backs the a..b ranges of the Twig frontend, returned one
 * element per value up to the bound, so a large bound from template data could
 * exhaust the heap and abort the process (GHSA-f8f4-95q3-38qw). 2.9.2 returns
 * an empty range above 1 000 000 elements, and both manifests now require
 * 2.9.3 (^2.9.3), whose swig requires swig-core 2.9.3.
 *
 * Native swig, which a bundle renders with unless swig.package selects a
 * frontend, has no range syntax: {% for i in 1..3 %} does not parse, so gina's
 * own rendering never reaches the helper. 02 keeps that true, and keeps the
 * native for-loop binding as it was: 2.9.3 changed the for-loop code generator
 * that native swig shares with the Jinja2 and Django frontends.
 *
 * The arms run through each copy gina resolves: the framework directory's
 * @rhinostone/swig and the swig-core it requires, which a bundle in this tree
 * renders with, and the repository root's, which is what an application that
 * installs gina gets.
 *
 * Seam: GINA_B973_SWIG_FROM=<dir> resolves @rhinostone/swig from that
 * directory only. On a 2.9.1 copy the arm of 01 fails and the arms of 02 pass;
 * 03 reads this tree's two package.json files, so it fails on a tree that
 * still declares ^2.9.1.
 *
 * Run standalone:
 *   node --test test/lib/swig-core-range-b973.test.js
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');

var FW   = require('../fw');
var ROOT = nodePath.resolve(__dirname, '..', '..');

/** The release both manifests require. */
var FIXED = [2, 9, 3];

/**
 * The most elements a range built by swig-core 2.9.2 or later may hold; a
 * range one element longer comes back empty.
 *
 * @constant
 * @type {number}
 */
var MAX_ELEMENTS = 1000000;

/**
 * Walks up from a resolved module file to the directory of the package that
 * holds it.
 *
 * @inner
 * @param   {string} file - A file inside the package.
 * @param   {string} name - The package name to stop at.
 * @returns {string} The package directory.
 */
function packageDirOf(file, name) {
    var dir = nodePath.dirname(file);
    while ( dir !== nodePath.dirname(dir) ) {
        var pkgFile = nodePath.join(dir, 'package.json');
        if ( fs.existsSync(pkgFile) && JSON.parse(fs.readFileSync(pkgFile, 'utf8')).name === name ) {
            return dir;
        }
        dir = nodePath.dirname(dir);
    }
    throw new Error('no package.json named ' + name + ' above ' + file);
}

/**
 * Loads the @rhinostone/swig copy that resolves from `from`, the swig-core
 * utils that copy requires, and an engine of its own.
 *
 * @inner
 * @param   {string} from - The directory to resolve from.
 * @returns {{ path: string, version: string, core: string, utils: Object, engine: Object }}
 */
function loadCopy(from) {
    var main      = require.resolve('@rhinostone/swig', { paths: [from] });
    var dir       = packageDirOf(main, '@rhinostone/swig');
    var utilsFile = require.resolve('@rhinostone/swig-core/lib/utils', { paths: [dir] });
    var coreDir   = packageDirOf(utilsFile, '@rhinostone/swig-core');
    var swig      = require(main);
    return {
        path   : dir,
        version: JSON.parse(fs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8')).version,
        core   : JSON.parse(fs.readFileSync(nodePath.join(coreDir, 'package.json'), 'utf8')).version,
        utils  : require(utilsFile),
        engine : new swig.Swig({ cache: false })
    };
}

/**
 * The copies under test, one per distinct package directory.
 *
 * @inner
 * @returns {Array<{ label: string, path: string, version: string, core: string, utils: Object, engine: Object }>}
 */
function copies() {
    var roots = process.env.GINA_B973_SWIG_FROM
        ? [ ['GINA_B973_SWIG_FROM', nodePath.resolve(process.env.GINA_B973_SWIG_FROM)] ]
        : [ ['framework copy', FW], ['root copy', ROOT] ];
    var seen = {}, out = [];
    roots.forEach(function (r) {
        var c = loadCopy(r[1]);
        if ( seen[c.path] ) { seen[c.path].label += ' + ' + r[0]; return; }
        c.label = r[0];
        seen[c.path] = c;
        out.push(c);
    });
    return out;
}

// Each binding: [template, locals, output on 2.9.1 and on 2.9.3]. One loop name
// over a mapping binds the value, two over a list bind the index and the item.
var BINDINGS = [
    ['{% for x in o %}{{ x }};{% endfor %}',                         { o: { a: 'A', b: 'B' } },        'A;B;'],
    ['{% for k, v in arr %}{{ k }}:{{ v }};{% endfor %}',            { arr: ['p', 'q'] },              '0:p;1:q;'],
    ['{% for k, v in o %}{{ k }}={{ v }};{% endfor %}',              { o: { a: 'A', b: 'B' } },        'a=A;b=B;'],
    ['{% for k, v in pairs %}{{ k }}-{{ v }};{% endfor %}',          { pairs: [['a', 1], ['b', 2]] }, '0-a,1;1-b,2;'],
    ['{% for x in arr %}{{ loop.index }}{{ loop.key }}{% endfor %}', { arr: ['p', 'q'] },              '1021']
];

describe('#B973 — swig-core caps the ranges it builds', function () {

    copies().forEach(function (copy) {
        var label = copy.label + ' ' + copy.version + ' (swig-core ' + copy.core + ')';

        describe('01 a range of more than ' + MAX_ELEMENTS + ' elements is empty — ' + label, function () {
            it('range(0, ' + MAX_ELEMENTS + ') holds no element', function () {
                assert.equal(copy.utils.range(0, MAX_ELEMENTS).length, 0,
                    'through @rhinostone/swig-core ' + copy.core + ', required by the swig at ' + copy.path);
            });
        });

        describe('02 controls: unchanged on 2.9.1 and 2.9.3 — ' + label, function () {
            it('range(1, ' + MAX_ELEMENTS + ') still holds ' + MAX_ELEMENTS + ' elements', function () {
                assert.equal(copy.utils.range(1, MAX_ELEMENTS).length, MAX_ELEMENTS);
            });

            it('a small range keeps both bounds, in either direction', function () {
                assert.deepEqual(copy.utils.range(0, 3), [0, 1, 2, 3]);
                assert.deepEqual(copy.utils.range(5, 1), [5, 4, 3, 2, 1]);
            });

            it('native swig has no range syntax: {% for i in 1..3 %} does not parse', function () {
                assert.throws(function () {
                    copy.engine.render('{% for i in 1..3 %}{{ i }}{% endfor %}');
                }, /Unexpected number/);
            });

            BINDINGS.forEach(function (b) {
                it('native for-loop binding: ' + b[0], function () {
                    assert.equal(copy.engine.render(b[0], { locals: b[1] }), b[2]);
                });
            });
        });
    });

    describe('03 both manifests require the release', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.9.3 or later', function () {
            var ranges = [nodePath.join(ROOT, 'package.json'), nodePath.join(FW, 'package.json')].map(function (f) {
                var deps = JSON.parse(fs.readFileSync(f, 'utf8')).dependencies || {};
                return [f, deps['@rhinostone/swig']];
            });
            assert.equal(ranges[0][1], ranges[1][1], 'the two manifests differ: ' + JSON.stringify(ranges));
            var m = /^\^(\d+)\.(\d+)\.(\d+)$/.exec(ranges[0][1] || '');
            assert.ok(m, 'not a caret range: ' + ranges[0][1]);
            var floor = [+m[1], +m[2], +m[3]];
            assert.equal(floor[0], FIXED[0], 'major ' + floor[0]);
            assert.ok(floor[1] > FIXED[1] || (floor[1] === FIXED[1] && floor[2] >= FIXED[2]),
                'floor ' + floor.join('.') + ' is below ' + FIXED.join('.'));
        });
    });
});
