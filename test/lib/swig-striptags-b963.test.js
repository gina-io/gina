/**
 * #B963 — @rhinostone/swig up to 2.9.0 ran the striptags filter in time
 * quadratic in the length of its input: on text with many < and no > after
 * them, 100 000 characters took about four seconds, so a template that applied
 * striptags to request data could be made to block the event loop. 2.9.1 runs
 * it in linear time with the same output, and both manifests now require it
 * (^2.9.1).
 *
 * The arms render through each copy gina resolves: the framework directory's
 * @rhinostone/swig, which a bundle in this tree renders with, and the
 * repository root's, which is what an application that installs gina gets.
 * 02 holds shapes whose output 2.9.1 must keep (each rendered the same way on
 * 2.8.4, measured), so a change in what the filter strips shows there.
 *
 * Seam: GINA_B963_SWIG_FROM=<dir> resolves @rhinostone/swig from that
 * directory only. On a 2.8.4 copy the 2 arms of 01 fail their time bound and
 * the arms of 02 pass; 03 reads this tree's two package.json files, so it
 * fails on a tree that still declares ^2.8.3.
 *
 * Run standalone:
 *   node --test test/lib/swig-striptags-b963.test.js
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');

var FW   = require('../fw');
var ROOT = nodePath.resolve(__dirname, '..', '..');

/** The release that renders every arm of 01 within its bound. */
var FIXED = [2, 9, 1];

/**
 * The time one render of an arm of 01 may take. 2.9.1 renders each in about
 * 2 ms and 2.8.4 in 2.5 to 4 s (measured 2026-10-23 at a load of 5), so the
 * bound leaves the fixed release a wide margin and the quadratic one none.
 *
 * @constant
 * @type {number}
 */
var BOUND_MS = 1000;

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
 * Loads the @rhinostone/swig copy that resolves from `from` and builds an
 * engine of its own.
 *
 * @inner
 * @param   {string} from - The directory to resolve from.
 * @returns {{ path: string, version: string, engine: Object }}
 */
function loadCopy(from) {
    var main = require.resolve('@rhinostone/swig', { paths: [from] });
    var dir  = packageDirOf(main, '@rhinostone/swig');
    var swig = require(main);
    return {
        path   : dir,
        version: JSON.parse(fs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8')).version,
        engine : new swig.Swig({ cache: false })
    };
}

/**
 * The copies under test, one per distinct package directory.
 *
 * @inner
 * @returns {Array<{ label: string, path: string, version: string, engine: Object }>}
 */
function copies() {
    var roots = process.env.GINA_B963_SWIG_FROM
        ? [ ['GINA_B963_SWIG_FROM', nodePath.resolve(process.env.GINA_B963_SWIG_FROM)] ]
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

/**
 * Renders `{{ x|striptags }}` with `x` bound to `input`.
 *
 * @inner
 * @param   {Object} engine
 * @param   {string} input
 * @returns {string}
 */
function striptags(engine, input) {
    return engine.render('{{ x|striptags }}', { locals: { x: input } });
}

// Each arm: [name, input, expected output]. Nothing in either input closes a
// tag, so striptags keeps every character and autoescape turns each < into &lt;.
var HOSTILE = [
    ['100 000 < with no > after them', '<'.repeat(100000),  '&lt;'.repeat(100000)],
    ['50 000 <x with no > after them', '<x'.repeat(50000),  '&lt;x'.repeat(50000)]
];

// Each control: [input, output on 2.8.4 and on 2.9.1].
var CONTROLS = [
    ['<b>bold</b> and <i>it</i>',  'bold and it'],
    ['<a href="/x?y=1">link</a>',  'link'],
    ['no tags here',               'no tags here'],
    ['a < b and c > d',            'a  d'],
    ['<<b>>',                      '&gt;'],
    ['<p>one</p>\n<p>two</p>',     'one\ntwo'],
    ['<br/>x<br />y',              'xy'],
    ['x <!-- c --> y',             'x  y'],
    ['<x<x<x',                     '&lt;x&lt;x&lt;x']
];

describe('#B963 — swig striptags runs in linear time', function () {

    copies().forEach(function (copy) {

        describe('01 a long input with no closing > renders within ' + BOUND_MS + ' ms — ' + copy.label + ' ' + copy.version, function () {
            HOSTILE.forEach(function (arm) {
                it(arm[0], function () {
                    var t0  = Date.now();
                    var out = striptags(copy.engine, arm[1]);
                    var ms  = Date.now() - t0;
                    assert.ok(ms < BOUND_MS, 'took ' + ms + ' ms through @rhinostone/swig ' + copy.version + ' at ' + copy.path);
                    assert.equal(out, arm[2]);
                });
            });
        });

        describe('02 controls: what striptags strips is unchanged — ' + copy.label + ' ' + copy.version, function () {
            CONTROLS.forEach(function (c) {
                it(JSON.stringify(c[0]), function () {
                    assert.equal(striptags(copy.engine, c[0]), c[1]);
                });
            });

            it('|safe after striptags keeps the stripped text unescaped', function () {
                assert.equal(copy.engine.render('{{ x|striptags|safe }}', { locals: { x: '<b>x</b> & y' } }), 'x & y');
            });
        });
    });

    describe('03 both manifests require the fixed release', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.9.1 or later', function () {
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
