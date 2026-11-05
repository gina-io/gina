/**
 * #B1088 — @rhinostone/swig 2.12.1 keeps a key from the template data that names the prototype
 * chain off it: advisory GHSA-8mf3-p375-389g.
 *
 * Up to 2.12.0 a key from the data that names `__proto__`, `constructor` or `prototype`, or a list
 * holding one of those names, reached the prototype chain wherever a template read a value with
 * it: a subscript such as {{ foo[k] }} printed the Object constructor, a call on such a value ran
 * text from the data as JavaScript ({{ foo[a][b]("…")() }} with a and b set to "constructor"
 * reaches the Function constructor), and a native {% set %} whose bracket target took the key
 * put a property on Object.prototype for the whole process. 2.12.1 reads such a key as missing,
 * a native set target given one throws « Unsafe assignment … (prototype-chain guard) » when the
 * template runs, and a prototype-chain name written as a variable inside a set target's brackets
 * fails at compile.
 *
 * The arms render through gina's call shapes: the sync path's per-bundle engine with
 * cache: false and compile(source, { filename })(locals), the calls controller.render-swig.js
 * makes, and the async path's engine on gina's memory loader (lib/template-loaders) with
 * engine.getTemplate() and the compiled function, the calls controller.render-swig-async.js
 * makes. The set arms run in a child process per copy, so a copy that still writes through the
 * prototype chain cannot leave a property on this process's Object.prototype.
 *
 * 04 pins what stays the same on 2.11.0 and 2.12.1: an ordinary key in a subscript and in a call,
 * a set target keyed by a loop index (2.12.1 compiles it to a runtime key check, whose output is
 * unchanged), a quoted set target, and the compile-time refusal of a quoted `__proto__` target.
 *
 * Both manifests now require 2.12.1 (^2.12.1), whose swig requires swig-core 2.12.1.
 *
 * The arms run through each copy gina resolves: the framework directory's @rhinostone/swig,
 * which a bundle in this tree renders with, and the repository root's, which is what an
 * application that installs gina gets.
 *
 * Seam: GINA_B1088_SWIG_FROM=<dir> resolves @rhinostone/swig from that directory only. On a 2.11.0
 * copy the arms of 01, 02 and 03 fail and those of 04 pass; 05 reads this tree's two package.json
 * files and their lockfiles, so it fails on a tree that still declares or locks a release below
 * 2.12.1.
 *
 * Run standalone:
 *   node --test test/lib/swig-prototype-keys-b1088.test.js
 */

'use strict';

var fs       = require('fs');
var nodePath = require('path');
var cp       = require('child_process');
var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');

var FW   = require('../fw');
var ROOT = nodePath.resolve(__dirname, '..', '..');
var TL   = require(nodePath.join(FW, 'lib/template-loaders/src/main'));

/** The release both manifests require. */
var FIXED = [2, 12, 1];

/**
 * The text of the guard error 2.12.1 throws for a native set target given a prototype-chain key.
 *
 * @constant
 * @type {RegExp}
 */
var SET_GUARD = /Unsafe assignment to "__proto__" via bracket notation is not allowed \(prototype-chain guard\)/;

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
 * @returns {{ path: string, main: string, version: string, core: string, swig: Object }}
 */
function loadCopy(from) {
    var main    = require.resolve('@rhinostone/swig', { paths: [from] });
    var dir     = packageDirOf(main, '@rhinostone/swig');
    var coreDir = packageDirOf(require.resolve('@rhinostone/swig-core/package.json', { paths: [dir] }), '@rhinostone/swig-core');
    return {
        path   : dir,
        main   : main,
        version: JSON.parse(fs.readFileSync(nodePath.join(dir, 'package.json'), 'utf8')).version,
        core   : JSON.parse(fs.readFileSync(nodePath.join(coreDir, 'package.json'), 'utf8')).version,
        swig   : require(main)
    };
}

/**
 * The copies under test, one per distinct package directory.
 *
 * @inner
 * @returns {Array<{ label: string, path: string, main: string, version: string, core: string, swig: Object }>}
 */
function copies() {
    var roots = process.env.GINA_B1088_SWIG_FROM
        ? [ ['GINA_B1088_SWIG_FROM', nodePath.resolve(process.env.GINA_B1088_SWIG_FROM)] ]
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
 * Renders `source` once on the sync path: an engine of the copy with gina's options
 * (cache: false) on a memory loader, then engine.compile(source, { filename }) and the compiled
 * function, the calls controller.render-swig.js makes.
 *
 * @inner
 * @param   {Object} copy   - A copy from copies().
 * @param   {string} source - The template source.
 * @param   {Object} locals - The template locals.
 * @returns {string} The output.
 */
function syncRender(copy, source, locals) {
    var engine = new copy.swig.Swig({ cache: false, loader: copy.swig.loaders.memory({}, '/views') });
    return engine.compile(source, { filename: '/views/page.html' })(locals);
}

/**
 * Renders `source` on the async path: an engine of the copy (cache: false) on gina's memory
 * loader, then engine.getTemplate() and the compiled function, the calls
 * controller.render-swig-async.js makes.
 *
 * @inner
 * @param   {Object} copy   - A copy from copies().
 * @param   {string} source - The template source.
 * @param   {Object} locals - The template locals.
 * @returns {Promise<string>} The output.
 */
async function asyncRender(copy, source, locals) {
    var engine = new copy.swig.Swig({ cache: false, loader: TL.build({ type: 'memory', templates: { 'page.html': source } }) });
    var fn     = await engine.getTemplate('page.html', { filename: 'page.html' });
    return (await fn(locals)).output;
}

/**
 * Renders `source` on the sync path in a child process, with `k` set to "__proto__", and reports
 * the output or the error, and whether a plain object of that process inherits `polluted`.
 *
 * @inner
 * @param   {Object} copy   - A copy from copies().
 * @param   {string} source - The template source.
 * @returns {{ out: string|null, err: string|null, polluted: boolean }}
 */
function childRender(copy, source) {
    var code = ''
        + 'var s = require(' + JSON.stringify(copy.main) + ');'
        + 'var e = new s.Swig({ cache: false, loader: s.loaders.memory({}, "/views") });'
        + 'var r = { out: null, err: null };'
        + 'try { r.out = e.compile(' + JSON.stringify(source) + ', { filename: "/views/page.html" })({ k: "__proto__" }); }'
        + 'catch (x) { r.err = String(x && x.message); }'
        + 'r.polluted = ({}).polluted === 1;'
        + 'process.stdout.write(JSON.stringify(r));';
    var res = cp.spawnSync(process.execPath, ['-e', code], { encoding: 'utf8' });
    assert.equal(res.status, 0, 'the child process failed: ' + res.stderr);
    return JSON.parse(res.stdout);
}

describe('#B1088 — swig 2.12.1: a key from the data that names the prototype chain stays off it', function () {

    copies().forEach(function (copy) {
        var label = copy.label + ' ' + copy.version + ' (swig-core ' + copy.core + ')';

        describe('01 a subscript with a prototype-chain key reads as missing — ' + label, function () {
            it('sync: "constructor", a list holding "__proto__", and "prototype" on a function read as empty', function () {
                assert.equal(syncRender(copy, '[{{ foo[k] }}]', { foo: {}, k: 'constructor' }), '[]',
                    'the subscript reached the Object constructor (through @rhinostone/swig ' + copy.version + ' at ' + copy.path + ')');
                assert.equal(syncRender(copy, '[{{ foo[k] }}]', { foo: {}, k: ['__proto__'] }), '[]',
                    'a list holding "__proto__" reached Object.prototype (through @rhinostone/swig ' + copy.version + ')');
                assert.equal(syncRender(copy, '[{{ f[k] }}]', { f: function () {}, k: 'prototype' }), '[]',
                    'the subscript reached a function\'s prototype (through @rhinostone/swig ' + copy.version + ')');
            });

            it('async: "constructor" reads as empty, through gina\'s memory loader and engine.getTemplate()', async function () {
                assert.equal(await asyncRender(copy, '[{{ foo[k] }}]', { foo: {}, k: 'constructor' }), '[]',
                    'the subscript reached the Object constructor (through @rhinostone/swig ' + copy.version + ')');
            });
        });

        describe('02 a call through prototype-chain keys runs no text from the data — ' + label, function () {
            it('sync: foo[a][b]("return 7")() with a and b set to "constructor" does not render 7', function () {
                var out = null;
                try { out = syncRender(copy, '{{ foo[a][b]("return 7")() }}', { foo: {}, a: 'constructor', b: 'constructor' }); }
                catch (e) { out = null; }
                assert.notEqual(out, '7', 'the template reached the Function constructor and ran text from the data (through @rhinostone/swig ' + copy.version + ')');
            });
        });

        describe('03 a native set target never writes through the prototype chain — ' + label, function () {
            it('a key from the data: the render throws the guard error and Object.prototype stays clean', function () {
                var r = childRender(copy, '{% set obj = { a: { x: 0 } } %}{% set obj[k].polluted = 1 %}ok');
                assert.equal(r.polluted, false, 'the set put a property on Object.prototype (through @rhinostone/swig ' + copy.version + ')');
                assert.equal(r.out, null, 'the render went through: ' + JSON.stringify(r.out));
                assert.match(String(r.err), SET_GUARD);
            });

            it('a prototype-chain name written as a variable inside the brackets fails at compile', function () {
                assert.throws(function () {
                    syncRender(copy, '{% set t = {} %}{% set t[constructor] = "X" %}ok', {});
                }, /Unsafe access to "constructor" is not allowed in templates \(prototype-chain guard\)/,
                'the template compiled (through @rhinostone/swig ' + copy.version + ')');
            });
        });

        describe('04 controls: unchanged on 2.11.0 and 2.12.1 — ' + label, function () {
            it('an ordinary key reads its value, in a subscript and in a call', async function () {
                assert.equal(syncRender(copy, '{{ foo[k] }}', { foo: { a: 'x' }, k: 'a' }), 'x');
                assert.equal(await asyncRender(copy, '{{ foo[k] }}', { foo: { a: 'x' }, k: 'a' }), 'x');
                assert.equal(syncRender(copy, '{{ foo[k](2) }}', { foo: { dbl: function (n) { return n * 2; } }, k: 'dbl' }), '4');
            });

            it('a set target keyed by a loop index writes each item', function () {
                var source = '{% for x in items %}{% set items[loop.index0].label = "w:" + size %}{% endfor %}'
                    + '{{ items[0].label }}|{{ items[1].label }}';
                assert.equal(syncRender(copy, source, { items: [{}, {}], size: 50 }), 'w:50|w:50');
            });

            it('a quoted set target writes, and a quoted "__proto__" target fails at compile', function () {
                assert.equal(syncRender(copy, '{% set t = {} %}{% set t["a-b"] = "X" %}{{ t["a-b"] }}', {}), 'X');
                assert.throws(function () {
                    syncRender(copy, '{% set t = {} %}{% set t["__proto__"] = "X" %}ok', {});
                }, SET_GUARD);
            });
        });
    });

    describe('05 both manifests require the release, and both lockfiles lock it', function () {

        it('package.json and the framework package.json declare the same ^2.x range, at 2.12.1 or later', function () {
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

        it('both lockfiles lock @rhinostone/swig and @rhinostone/swig-core at 2.12.1 or later', function () {
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
