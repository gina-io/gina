/**
 * #B978 — @rhinostone/swig 2.9.4 fixes two paths gina renders templates through.
 *
 * Sync path (the default, controller.render-swig.js): up to 2.9.3 the compiled
 * {% import %} declared its own output variable, so a template lost what it had
 * rendered before the tag: the output before it at the top level, the layout's
 * output before a block of an extends child that holds one, every item of a for
 * loop that holds one, and a macro's output before it. An import at the very
 * top of a template was not affected.
 *
 * Async path (a bundle with settings.template.swig.loader,
 * controller.render-swig-async.js): up to 2.9.3 an {% include %} or
 * {% import %} inside a for loop or a filter tag, or anywhere in a macro body,
 * failed to compile ("missing ) after argument list"), even when the macro was
 * never called. 2.9.4 renders the loop and filter cases and a template that only
 * defines such a macro, and calling the macro throws an error that names it.
 *
 * Both manifests now require 2.9.4 (^2.9.4), whose swig requires swig-core 2.9.4.
 *
 * The arms run through each copy gina resolves: the framework directory's
 * @rhinostone/swig, which a bundle in this tree renders with, and the
 * repository root's, which is what an application that installs gina gets. The
 * sync arms call engine.compile() as render-swig.js does; the async arms build
 * gina's own memory loader (lib/template-loaders) and call engine.getTemplate()
 * and the compiled function as render-swig-async.js does.
 *
 * Seam: GINA_B978_SWIG_FROM=<dir> resolves @rhinostone/swig from that
 * directory only. On a 2.9.3 copy the arms of 01 and 02 fail and those of 03
 * pass; 04 reads this tree's two package.json files, so it fails on a tree that
 * still declares ^2.9.3.
 *
 * Run standalone:
 *   node --test test/lib/swig-import-output-b978.test.js
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');

var FW   = require('../fw');
var ROOT = nodePath.resolve(__dirname, '..', '..');
var TL   = require(nodePath.join(FW, 'lib/template-loaders/src/main'));

/** The release both manifests require. */
var FIXED = [2, 9, 4];

/**
 * The templates the arms import or include: a file with one macro, a layout
 * with one block, and a partial that prints `i`.
 *
 * @constant
 * @type {Object<string, string>}
 */
var LIBRARY = {
    'm.html'     : '{% macro hi() %}H{% endmacro %}',
    'layout.html': '<{% block a %}L{% endblock %}>',
    'p.html'     : 'P{{ i }}'
};

/**
 * The error swig 2.9.4 throws on the async path when a macro that holds an
 * include, import, from or block is called.
 *
 * @constant
 * @type {RegExp}
 */
var MACRO_ERROR = /The macro "g" in page\.html holds an \{% include %\}, \{% import %\}, \{% from %\} or \{% block %\}, which the async render path does not support inside a macro\./;

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
 * Loads the @rhinostone/swig copy that resolves from `from`, with the version
 * of the swig-core that copy requires.
 *
 * @inner
 * @param   {string} from - The directory to resolve from.
 * @returns {{ path: string, version: string, core: string, swig: Object }}
 */
function loadCopy(from) {
    var main    = require.resolve('@rhinostone/swig', { paths: [from] });
    var dir     = packageDirOf(main, '@rhinostone/swig');
    var coreDir = packageDirOf(require.resolve('@rhinostone/swig-core/package.json', { paths: [dir] }), '@rhinostone/swig-core');
    return {
        path   : dir,
        version: JSON.parse(fs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8')).version,
        core   : JSON.parse(fs.readFileSync(nodePath.join(coreDir, 'package.json'), 'utf8')).version,
        swig   : require(main)
    };
}

/**
 * The copies under test, one per distinct package directory.
 *
 * @inner
 * @returns {Array<{ label: string, path: string, version: string, core: string, swig: Object }>}
 */
function copies() {
    var roots = process.env.GINA_B978_SWIG_FROM
        ? [ ['GINA_B978_SWIG_FROM', nodePath.resolve(process.env.GINA_B978_SWIG_FROM)] ]
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
 * Renders a template on the sync path: an engine of the copy with a memory
 * loader holding LIBRARY, then engine.compile() and the compiled function, the
 * calls render-swig.js makes.
 *
 * @inner
 * @param   {Object} copy     - A copy from copies().
 * @param   {string} src      - The template source.
 * @param   {Object} [locals] - The template locals.
 * @returns {string} The output.
 */
function syncRender(copy, src, locals) {
    var map = {};
    Object.keys(LIBRARY).forEach(function (k) { map['/views/' + k] = LIBRARY[k]; });
    var engine = new copy.swig.Swig({ cache: false, loader: copy.swig.loaders.memory(map, '/views') });
    return engine.compile(src, { filename: '/views/page.html' })(locals || {});
}

/**
 * Renders a template on the async path: gina's memory loader (with its
 * path guard) built from LIBRARY plus the page, an engine of the copy on it,
 * then engine.getTemplate() and the compiled function, the calls
 * render-swig-async.js makes.
 *
 * @inner
 * @param   {Object} copy     - A copy from copies().
 * @param   {string} src      - The page template source.
 * @param   {Object} [locals] - The template locals.
 * @returns {Promise<string>} The output.
 */
async function asyncRender(copy, src, locals) {
    var templates = Object.assign({}, LIBRARY, { 'page.html': src });
    var engine    = new copy.swig.Swig({ cache: false, loader: TL.build({ type: 'memory', templates: templates }) });
    var fn        = await engine.getTemplate('page.html', { filename: 'page.html' });
    var rendered  = await fn(locals || {});
    return rendered.output;
}

describe('#B978 — swig 2.9.4: an import keeps the output before it, and the async path renders includes inside loops', function () {

    copies().forEach(function (copy) {
        var label = copy.label + ' ' + copy.version + ' (swig-core ' + copy.core + ')';

        describe('01 sync: an import no longer discards output — ' + label, function () {
            it('the output before an import is kept', function () {
                assert.equal(syncRender(copy, 'A{% import "m.html" as mm %}B{{ mm.hi() }}C'), 'ABHC',
                    'through @rhinostone/swig ' + copy.version + ' at ' + copy.path);
            });

            it('an import in a block of an extends child keeps the layout output before the block', function () {
                assert.equal(syncRender(copy, '{% extends "layout.html" %}{% block a %}X{% import "m.html" as mm %}{{ mm.hi() }}{% endblock %}'), '<XH>');
            });

            it('a for loop that holds an import renders its items', function () {
                assert.equal(syncRender(copy, '{% for i in [1,2] %}{% import "m.html" as mm %}{{ i }}{{ mm.hi() }}{% endfor %}'), '1H2H');
            });

            it('a macro keeps what it renders before an import', function () {
                assert.equal(syncRender(copy, '{% macro g() %}G{% import "m.html" as mm %}{{ mm.hi() }}{% endmacro %}{{ g() }}'), 'GH');
            });
        });

        describe('02 async: an include or import inside a loop or filter renders, a macro holding one throws when called — ' + label, function () {
            it('an include inside a for loop renders', async function () {
                assert.equal(await asyncRender(copy, '{% for i in [1,2] %}{% include "p.html" %}{% endfor %}'), 'P1P2');
            });

            it('an import inside a for loop renders', async function () {
                assert.equal(await asyncRender(copy, '{% for i in [1,2] %}{% import "m.html" as mm %}{{ mm.hi() }}{% endfor %}'), 'HH');
            });

            it('an include inside a filter tag renders', async function () {
                assert.equal(await asyncRender(copy, '{% filter upper %}{% include "p.html" %}{% endfilter %}', { i: 1 }), 'P1');
            });

            it('a template that only defines a macro holding an include renders', async function () {
                assert.equal(await asyncRender(copy, '{% macro g() %}{% include "p.html" %}{% endmacro %}OK'), 'OK');
            });

            it('calling a macro that holds an include throws an error naming the macro and its template', async function () {
                await assert.rejects(asyncRender(copy, '{% macro g() %}{% include "p.html" %}{% endmacro %}{{ g() }}', { i: 1 }), MACRO_ERROR);
            });
        });

        describe('03 controls: unchanged on 2.9.3 and 2.9.4 — ' + label, function () {
            it('sync: an import at the top of a template', function () {
                assert.equal(syncRender(copy, '{% import "m.html" as mm %}A{{ mm.hi() }}B'), 'AHB');
            });

            it('sync: an import at the top level of an extends child', function () {
                assert.equal(syncRender(copy, '{% extends "layout.html" %}{% import "m.html" as mm %}{% block a %}X{{ mm.hi() }}{% endblock %}'), '<XH>');
            });

            it('sync: an include', function () {
                assert.equal(syncRender(copy, 'A{% include "p.html" %}B', { i: 1 }), 'AP1B');
            });

            it('async: an include', async function () {
                assert.equal(await asyncRender(copy, 'A{% include "p.html" %}B', { i: 1 }), 'AP1B');
            });

            it('async: an import after output', async function () {
                assert.equal(await asyncRender(copy, 'A{% import "m.html" as mm %}B{{ mm.hi() }}C'), 'ABHC');
            });

            it('async: an include in a block of an extends child', async function () {
                assert.equal(await asyncRender(copy, '{% extends "layout.html" %}{% block a %}X{% include "p.html" %}{% endblock %}', { i: 1 }), '<XP1>');
            });
        });
    });

    describe('04 both manifests require the release', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.9.4 or later', function () {
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
