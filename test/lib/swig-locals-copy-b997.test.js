/**
 * #B997 — @rhinostone/swig 2.9.6 renders on a copy of the locals it is given: advisory
 * GHSA-25w8-77gg-4ccw (data passed to one render reaching other renders).
 *
 * Up to 2.9.5 swig used the locals object a caller passed as the template's context, so a name
 * the template set ({% set %}, a macro, an import, a loop variable) landed in that object, and a
 * later render given the same object read it, on the sync path and on the async render path.
 * 2.9.6 copies the object at the top of each render and keeps its prototype, so its methods and
 * getters still resolve. gina is reached through a class instance an action passes to
 * self.render(): gina's own per-render copy (core/controller/render-data.js, #B988) copies a
 * plain object on every swig version and returns a class instance as is. The arms of 01 render
 * one class instance twice through gina's call shapes: the sync path's per-bundle engine with
 * cache: false and compile(source, { filename })(locals), the calls controller.render-swig.js
 * makes, and the async path's engine on gina's memory loader (lib/template-loaders) with
 * engine.getTemplate() and the compiled function, the calls controller.render-swig-async.js
 * makes.
 *
 * A cached compile, the advisory's first shape: with swig's memory cache, a compile given locals
 * in its options cached a function that kept them, so a later compile of the same filename
 * rendered the first call's locals. gina's render paths build their engines with cache: false
 * (controller.js getDefaultSwigEngine, controller.render-swig-async.js), which never cached: 02
 * runs the scene with cache: 'memory', the control that leaks without the fix, and 03 pins that
 * gina's options render each call's own locals on every copy. The second shape needs default
 * locals on an engine, which gina's engines do not set.
 *
 * 03 also pins what stays the same on 2.9.5 and 2.9.6: gina's copy keeps a plain object
 * unwritten and returns a class instance as is; an include's top-level set still reaches the
 * page; a child template's top-level set still reaches its layout; a dotted set still writes
 * into the nested object it names.
 *
 * Both manifests now require 2.9.6 (^2.9.6), whose swig requires swig-core 2.9.6.
 *
 * The arms run through each copy gina resolves: the framework directory's @rhinostone/swig,
 * which a bundle in this tree renders with, and the repository root's, which is what an
 * application that installs gina gets.
 *
 * Seam: GINA_B997_SWIG_FROM=<dir> resolves @rhinostone/swig from that directory only. On a 2.9.5
 * copy the arms of 01 and 02 fail and those of 03 pass; 04 reads this tree's two package.json
 * files and their lockfiles, so it fails on a tree that still declares or locks 2.9.5.
 *
 * Run standalone:
 *   node --test test/lib/swig-locals-copy-b997.test.js
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');

var FW         = require('../fw');
var ROOT       = nodePath.resolve(__dirname, '..', '..');
var TL         = require(nodePath.join(FW, 'lib/template-loaders/src/main'));
var renderData = require(nodePath.join(FW, 'core/controller/render-data.js'));

/** The release both manifests require. */
var FIXED = [2, 9, 6];

/**
 * A template that prints a name before it sets it, then reads the prototype getter `who`, the
 * prototype method `hi()` and the own property `own` of a Klass instance.
 *
 * @constant
 * @type {string}
 */
var SET_TEMPLATE = 'A=[{{ mark|default("unset") }}]{% set mark = "set" %}W=[{{ who }}]H=[{{ hi() }}]O=[{{ own }}]';

/**
 * What SET_TEMPLATE renders when the name is not set yet: on every render with 2.9.6, on the
 * first only with 2.9.5.
 *
 * @constant
 * @type {string}
 */
var UNSET_OUTPUT = 'A=[unset]W=[W]H=[H]O=[O]';

/**
 * A class whose instances carry one own property, a prototype method and a prototype getter.
 *
 * @inner
 * @constructor
 */
function Klass() { this.own = 'O'; }
Klass.prototype.hi = function () { return 'H'; };
Object.defineProperty(Klass.prototype, 'who', { get: function () { return 'W'; } });

/**
 * Walks up from a resolved module file to the directory of the package that holds it.
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
 * Loads the @rhinostone/swig copy that resolves from `from`, with the version of the swig-core
 * that copy requires.
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
    var roots = process.env.GINA_B997_SWIG_FROM
        ? [ ['GINA_B997_SWIG_FROM', nodePath.resolve(process.env.GINA_B997_SWIG_FROM)] ]
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
 * An engine of the copy with gina's sync render options (cache: false) on a memory loader.
 *
 * @inner
 * @param   {Object} copy                    - A copy from copies().
 * @param   {Object<string, string>} [map]   - Path under /views to source, for includes and layouts.
 * @param   {false|string} [cacheMode=false] - The engine's cache option: false (gina's) or 'memory'.
 * @returns {Object} The engine.
 */
function syncEngine(copy, map, cacheMode) {
    return new copy.swig.Swig({
        cache : (typeof(cacheMode) == 'undefined') ? false : cacheMode,
        loader: copy.swig.loaders.memory(map || {}, '/views')
    });
}

/**
 * Renders `source` once on the sync path: engine.compile(source, { filename }) and the compiled
 * function, the calls controller.render-swig.js makes.
 *
 * @inner
 * @param   {Object} engine - An engine from syncEngine().
 * @param   {string} source - The template source.
 * @param   {Object} locals - The template locals.
 * @returns {string} The output.
 */
function syncRender(engine, source, locals) {
    return engine.compile(source, { filename: '/views/page.html' })(locals);
}

/**
 * Renders `page.html` on the async path: an engine of the copy (cache: false) on gina's memory
 * loader, then engine.getTemplate() and the compiled function, the calls
 * controller.render-swig-async.js makes.
 *
 * @inner
 * @param   {Object} engine - An engine of the copy built on gina's memory loader.
 * @param   {Object} locals - The template locals.
 * @returns {Promise<string>} The output.
 */
async function asyncRender(engine, locals) {
    var fn = await engine.getTemplate('page.html', { filename: 'page.html' });
    return (await fn(locals)).output;
}

describe('#B997 — swig 2.9.6: a render works on a copy of the locals it is given', function () {

    copies().forEach(function (copy) {
        var label = copy.label + ' ' + copy.version + ' (swig-core ' + copy.core + ')';

        describe('01 a class instance rendered twice keeps none of the names the template sets — ' + label, function () {
            it('sync: the second render does not see the first render\'s set, and the instance keeps only its own key', function () {
                var engine = syncEngine(copy);
                var inst   = new Klass();
                var r1     = syncRender(engine, SET_TEMPLATE, inst);
                var r2     = syncRender(engine, SET_TEMPLATE, inst);
                assert.equal(r1, UNSET_OUTPUT);
                assert.equal(r2, UNSET_OUTPUT, 'the second render read the first render\'s set (through @rhinostone/swig ' + copy.version + ' at ' + copy.path + ')');
                assert.deepEqual(Object.keys(inst), ['own'], 'the template\'s set landed in the instance');
            });

            it('async: the same, through gina\'s memory loader and engine.getTemplate()', async function () {
                var engine = new copy.swig.Swig({ cache: false, loader: TL.build({ type: 'memory', templates: { 'page.html': SET_TEMPLATE } }) });
                var inst   = new Klass();
                var r1     = await asyncRender(engine, inst);
                var r2     = await asyncRender(engine, inst);
                assert.equal(r1, UNSET_OUTPUT);
                assert.equal(r2, UNSET_OUTPUT, 'the second render read the first render\'s set (through @rhinostone/swig ' + copy.version + ')');
                assert.deepEqual(Object.keys(inst), ['own'], 'the template\'s set landed in the instance');
            });
        });

        describe('02 sync, memory cache: a compile given locals in its options keeps none of them for the next call — ' + label, function () {
            it('two compiles of one filename render each call\'s own locals', function () {
                var engine = syncEngine(copy, {}, 'memory');
                var a = engine.compile('who=[{{ who }}]', { filename: '/views/c.html', locals: { who: 'a' } })();
                var b = engine.compile('who=[{{ who }}]', { filename: '/views/c.html', locals: { who: 'b' } })();
                assert.equal(a, 'who=[a]');
                assert.equal(b, 'who=[b]', 'the second compile rendered the first call\'s locals (through @rhinostone/swig ' + copy.version + ')');
            });
        });

        describe('03 controls: unchanged on 2.9.5 and 2.9.6 — ' + label, function () {
            it('gina\'s render options (cache: false): two compiles of one filename render each call\'s own locals', function () {
                var engine = syncEngine(copy, {}, false);
                assert.equal(engine.compile('who=[{{ who }}]', { filename: '/views/c.html', locals: { who: 'a' } })(), 'who=[a]');
                assert.equal(engine.compile('who=[{{ who }}]', { filename: '/views/c.html', locals: { who: 'b' } })(), 'who=[b]');
            });

            it('gina\'s per-render copy keeps a plain object unwritten, and returns a class instance as is', function () {
                var shared = { title: 'T', nested: { n: 1 } };
                var copied = renderData.copyForRender(shared, { page: { data: {} } });
                assert.notEqual(copied, shared, 'a plain object is copied');
                assert.equal(syncRender(syncEngine(copy), '{% set mark = "set" %}{{ title }}', copied), 'T');
                assert.deepEqual(Object.keys(shared).sort(), ['nested', 'title'], 'the template\'s set reached the action\'s object');
                var inst = new Klass();
                assert.equal(renderData.copyForRender(inst, { page: { data: {} } }), inst, 'a class instance is returned as is');
            });

            it('an include\'s top-level set still reaches the page', function () {
                var engine = syncEngine(copy, { '/views/inc.html': '{% set fromInc = "I" %}' });
                assert.equal(syncRender(engine, '{% include "inc.html" %}page=[{{ fromInc|default("none") }}]', {}), 'page=[I]');
            });

            it('a child template\'s top-level set still reaches its layout', function () {
                var engine = syncEngine(copy, { '/views/lay.html': 'L[{{ t2|default("none") }}]{% block b %}{% endblock %}' });
                assert.equal(syncRender(engine, '{% extends "lay.html" %}{% set t2 = "C" %}{% block b %}b{% endblock %}', {}), 'L[C]b');
            });

            it('a dotted set still writes into the nested object it names', function () {
                var locals = { site: { user: 'u0' } };
                syncRender(syncEngine(copy), '{% set site.user = "u1" %}', locals);
                assert.equal(locals.site.user, 'u1');
            });
        });
    });

    describe('04 both manifests require the release, and both lockfiles lock it', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.9.6 or later', function () {
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

        it('both lockfiles lock @rhinostone/swig and @rhinostone/swig-core at 2.9.6 or later', function () {
            [nodePath.join(ROOT, 'package-lock.json'), nodePath.join(FW, 'package-lock.json')].forEach(function (f) {
                var packages = JSON.parse(fs.readFileSync(f, 'utf8')).packages || {};
                ['@rhinostone/swig', '@rhinostone/swig-core'].forEach(function (name) {
                    var entry = packages['node_modules/' + name];
                    assert.ok(entry && entry.version, f + ' locks no ' + name);
                    var v = entry.version.split('.').map(Number);
                    assert.ok(v[0] === FIXED[0] && (v[1] > FIXED[1] || (v[1] === FIXED[1] && v[2] >= FIXED[2])),
                        f + ' locks ' + name + ' ' + entry.version + ', below ' + FIXED.join('.'));
                });
            });
        });
    });
});
