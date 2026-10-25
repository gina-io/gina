/**
 * #B983 — @rhinostone/swig 2.9.5 bounds the async render path and copies cached
 * parse trees: two advisories, GHSA-86pr-x856-xrq5 and GHSA-g628-5x3r-g298.
 *
 * Async path (a bundle with settings.template.swig.loader,
 * controller.render-swig-async.js): up to 2.9.4 nothing limited how deeply
 * templates nested, so a template that includes, imports or extends itself,
 * directly or through another template, loaded templates until the heap ran out
 * and the process aborted (GHSA-86pr-x856-xrq5). 2.9.5 counts the templates a
 * render has in progress and fails past 1000 with « Template "<name>" is nested
 * more than 1000 levels deep », and an extends cycle fails at once with
 * « Illegal circular extends of "<name>" », the sync path's error. gina's async
 * delegate is reached: the arms build gina's own memory loader
 * (lib/template-loaders) on an engine of the copy and call engine.getTemplate()
 * and the compiled function, the calls render-swig-async.js makes. A loader
 * wrapper refuses load 5,001, so a copy without the bound fails an arm instead of
 * exhausting the heap.
 *
 * Compile cache (GHSA-g628-5x3r-g298): up to 2.9.4, with swig's memory cache, a
 * page extending a layout held in the cache rewrote the cached parse tree, so the
 * first page that overrode a block nested inside a tag put its block into the
 * layout for every page compiled after it. gina's render paths are not reached:
 * a bundle renders through a per-bundle engine built with cache: false
 * (controller.js, getDefaultSwigEngine), and 03 pins that the scene renders
 * correctly with those options on every copy. 02 runs the same scene with
 * cache: 'memory', the control that leaks without the fix.
 *
 * Both manifests now require 2.9.5 (^2.9.5), whose swig requires swig-core 2.9.5.
 *
 * The arms run through each copy gina resolves: the framework directory's
 * @rhinostone/swig, which a bundle in this tree renders with, and the repository
 * root's, which is what an application that installs gina gets.
 *
 * Seam: GINA_B983_SWIG_FROM=<dir> resolves @rhinostone/swig from that directory
 * only. On a 2.9.4 copy the arms of 01 and 02 fail and those of 03 pass; 04 reads
 * this tree's two package.json files, so it fails on a tree that still declares
 * ^2.9.4.
 *
 * Run standalone:
 *   node --test test/lib/swig-nesting-cache-b983.test.js
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
var FIXED = [2, 9, 5];

/**
 * The most loads an async arm allows before its loader refuses: a copy without
 * the 2.9.5 bound reaches it, a copy with the bound stops at 1,001.
 *
 * @constant
 * @type {number}
 */
var LOAD_LIMIT = 5000;

/**
 * The error swig 2.9.5 throws on the async path when a render would load a
 * template while 1000 are in progress.
 *
 * @constant
 * @type {RegExp}
 */
var NESTING_ERROR = /^Template "[^"]+" is nested more than 1000 levels deep: a template probably includes, imports or extends itself\.$/;

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
    var roots = process.env.GINA_B983_SWIG_FROM
        ? [ ['GINA_B983_SWIG_FROM', nodePath.resolve(process.env.GINA_B983_SWIG_FROM)] ]
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
 * Renders `page.html` on the async path: gina's memory loader (with its path
 * guard) built from `templates`, wrapped so it counts its loads and refuses the
 * one after LOAD_LIMIT, an engine of the copy on it, then engine.getTemplate()
 * and the compiled function, the calls render-swig-async.js makes.
 *
 * @inner
 * @param   {Object} copy               - A copy from copies().
 * @param   {Object<string, string>} templates - Identifier to source; must hold `page.html`.
 * @param   {Object} [locals]           - The template locals.
 * @returns {Promise<{ output: ?string, error: ?Error, loads: number }>} The output, or the error the render failed with, and the number of loads.
 */
async function asyncRender(copy, templates, locals) {
    var inner  = TL.build({ type: 'memory', templates: templates });
    var loads  = 0;
    var loader = {
        async  : inner.async,
        resolve: inner.resolve,
        // Two parameters, as the guarded loader's: swig reads load.length to
        // choose the callback form.
        load   : function (id, cb) {
            loads++;
            if ( loads > LOAD_LIMIT ) {
                return cb(new Error('the test loader refused load ' + loads + ': the render did not stop'));
            }
            return inner.load(id, cb);
        }
    };
    var engine = new copy.swig.Swig({ cache: false, loader: loader });
    try {
        var fn       = await engine.getTemplate('page.html', { filename: 'page.html' });
        var rendered = await fn(locals || {});
        return { output: rendered.output, error: null, loads: loads };
    } catch (err) {
        return { output: null, error: err, loads: loads };
    }
}

/**
 * The compile-cache scene on the sync path: a layout whose block sits inside an
 * if tag is compiled on its own (so it is in the cache when the cache is on),
 * then page a overrides that block and page b extends the layout without
 * overriding it, each through engine.compile() and the compiled function, the
 * calls render-swig.js makes.
 *
 * @inner
 * @param   {Object} copy             - A copy from copies().
 * @param   {false|string} cacheMode  - The engine's cache option: false (gina's) or 'memory'.
 * @returns {{ a: string, b: string }} What pages a and b render.
 */
function cacheScene(copy, cacheMode) {
    var map = {
        '/views/layout.html': '<{% if true %}{% block inner %}I{% endblock %}{% endif %}>',
        '/views/a.html'     : '{% extends "layout.html" %}{% block inner %}OVERRIDE{% endblock %}',
        '/views/b.html'     : '{% extends "layout.html" %}'
    };
    var engine = new copy.swig.Swig({ cache: cacheMode, loader: copy.swig.loaders.memory(map, '/views') });
    engine.compileFile('/views/layout.html');
    return {
        a: engine.compile(map['/views/a.html'], { filename: '/views/a.html' })({}),
        b: engine.compile(map['/views/b.html'], { filename: '/views/b.html' })({})
    };
}

describe('#B983 — swig 2.9.5: the async render path is bounded, and a cached layout is not rewritten', function () {

    copies().forEach(function (copy) {
        var label = copy.label + ' ' + copy.version + ' (swig-core ' + copy.core + ')';

        describe('01 async: a template that includes, imports or extends itself fails the render — ' + label, function () {
            it('a template that includes itself fails with the nesting error, after 1,001 loads at most', async function () {
                var r = await asyncRender(copy, { 'page.html': '{% include "page.html" %}' });
                assert.ok(r.error, 'the render did not fail (through @rhinostone/swig ' + copy.version + ' at ' + copy.path + ')');
                assert.match(r.error.message, NESTING_ERROR);
                assert.ok(r.loads <= 1001, r.loads + ' loads');
            });

            it('a cycle through another template fails the same way', async function () {
                var r = await asyncRender(copy, { 'page.html': '{% include "b.html" %}', 'b.html': '{% include "page.html" %}' });
                assert.ok(r.error, 'the render did not fail');
                assert.match(r.error.message, NESTING_ERROR);
                assert.ok(r.loads <= 1001, r.loads + ' loads');
            });

            it('a template that imports itself fails the same way', async function () {
                var r = await asyncRender(copy, { 'page.html': '{% import "page.html" as me %}X' });
                assert.ok(r.error, 'the render did not fail');
                assert.match(r.error.message, NESTING_ERROR);
                assert.ok(r.loads <= 1001, r.loads + ' loads');
            });

            it('an extends cycle fails at once with the sync path\'s error', async function () {
                var r = await asyncRender(copy, { 'page.html': '{% extends "l1.html" %}', 'l1.html': '{% extends "page.html" %}' });
                assert.ok(r.error, 'the render did not fail');
                assert.equal(r.error.message, 'Illegal circular extends of "l1.html".');
                assert.ok(r.loads < 10, r.loads + ' loads');
            });
        });

        describe('02 sync, memory cache: a page\'s override of a nested block stays on that page — ' + label, function () {
            it('a page compiled after another page overrode the block renders the layout\'s own block', function () {
                var r = cacheScene(copy, 'memory');
                assert.equal(r.a, '<OVERRIDE>');
                assert.equal(r.b, '<I>', 'page b shows page a\'s override (through @rhinostone/swig ' + copy.version + ')');
            });
        });

        describe('03 controls: unchanged on 2.9.4 and 2.9.5 — ' + label, function () {
            it('sync, gina\'s render options (cache: false): the nested override stays on its page', function () {
                var r = cacheScene(copy, false);
                assert.deepEqual(r, { a: '<OVERRIDE>', b: '<I>' });
            });

            it('sync: an extends cycle fails with « Illegal circular extends »', function () {
                var map    = { '/views/p.html': '{% extends "q.html" %}', '/views/q.html': '{% extends "p.html" %}' };
                var engine = new copy.swig.Swig({ cache: false, loader: copy.swig.loaders.memory(map, '/views') });
                assert.throws(function () {
                    engine.compile(map['/views/p.html'], { filename: '/views/p.html' })({});
                }, /^Error: Illegal circular extends of "\/views\/q\.html"\.$/);
            });

            it('async: a chain of three templates renders', async function () {
                var r = await asyncRender(copy, { 'page.html': 'A{% include "b.html" %}', 'b.html': 'B{% include "c.html" %}', 'c.html': 'C' });
                assert.equal(r.error, null, r.error && r.error.message);
                assert.equal(r.output, 'ABC');
                assert.equal(r.loads, 3);
            });

            it('async: a template that includes itself 50 times and stops renders', async function () {
                var r = await asyncRender(copy, { 'page.html': '{% if n < 50 %}.{% include "page.html" with { n: n + 1 } %}{% endif %}' }, { n: 0 });
                assert.equal(r.error, null, r.error && r.error.message);
                assert.equal(r.output, new Array(51).join('.'));
                assert.equal(r.loads, 51);
            });
        });
    });

    describe('04 both manifests require the release', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.9.5 or later', function () {
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
