'use strict';
/**
 * #B1176 — outside dev, swig keeps compiled templates: an `{% include %}` is read and compiled once per process
 * instead of on every render and every loop iteration.
 *
 * gina built its per-template-root swig engine with `cache: false` (`controller.js`), so every `{% include %}` —
 * compiled to `_swig.compileFile(path, { resolveFrom })(ctx)` where the tag sits — read its file through the
 * loader and compiled it on each call: once per render, and once per iteration inside a `{% for %}`, with
 * `server.cache.enable` on or off (gina's own page cache holds the page's compiled function, whose include calls
 * still compiled at render time). Outside dev the engine now takes swig's `'memory'` cache, as gina's nunjucks
 * path keeps its templates (noCache in dev only); in dev it stays `false`, so an edit shows on the next render.
 * The cache engages only on swig 2.9.6 or later: before it, swig's memory cache carried one page's override of a
 * nested block into a cached layout (fixed in 2.9.5) and one call's option locals into later calls for the same
 * file (fixed in 2.9.6), so a project rendering with its own older swig keeps `cache: false`.
 * Each page and layout compile passes its own `cache: false` (`controller.render-swig.js`,
 * `controller.render-v1.js`): the page is compiled from content gina assembles per render under one filename
 * (#B1129's tokened layout), and a filename-keyed entry would serve the first render's page to every later one.
 *
 * Sections:
 *   01 — source pins (comment-stripped, each with a raw-text control).
 *   02 — the shipped cache expression, extracted and executed with `isCacheless()` true and false and with the
 *        swig version as the resolver reports it (the copy gina ships, 2.9.6, 2.9.5, none).
 *   03 — the real `@rhinostone/swig` engine with the shipped options, the page mapping built by the shipped
 *        statements, and gina's own `layout-source.js`: outside dev an include loads once across renders, each
 *        render keeps its own layout and values, no per-render token key accumulates, an edit waits for a fresh
 *        engine (a restart), and `invalidateCache()` drops the compiled include; on an older swig and in dev it
 *        loads on every render, and in dev an edit shows.
 *   04 — CONTROLS (they hold on the pre-fix source too): an engine on `cache: false` loads an include per
 *        render and per iteration; an engine on `'memory'` whose page compile has no `cache: false` of its own
 *        serves the first page to a second render.
 *
 * Red-first: GINA_CONTROLLER_SRC=<pre-fix controller.js> GINA_RENDER_SWIG_SRC=<pre-fix controller.render-swig.js>
 * GINA_RENDER_V1_SRC=<pre-fix controller.render-v1.js> node --test <this file>  → the pins of 01, the 'memory' arms
 * of 02 and the cached arms of 03 fail; the arms that hold before and after the fix pass, and 04 holds.
 */

var assert   = require('node:assert/strict');
var fs       = require('fs');
var os       = require('os');
var path     = require('path');
var test     = require('node:test');
var describe = test.describe, it = test.it, after = test.after;

var FW = require('../fw');
// Module-path seams: point the pins and the extracted statements at pre-change copies of the sources.
var CTRL  = fs.readFileSync(process.env.GINA_CONTROLLER_SRC || path.join(FW, 'core/controller/controller.js'), 'utf8');
var RSWIG = fs.readFileSync(process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js'), 'utf8');
var RV1   = fs.readFileSync(process.env.GINA_RENDER_V1_SRC || path.join(FW, 'core/controller/controller.render-v1.js'), 'utf8');

var swig         = require(path.join(FW, 'node_modules/@rhinostone/swig'));
var layoutSource = require(path.join(FW, 'core/controller/layout-source.js'));
var resolver     = require(path.join(FW, 'lib/swig-resolver/src/main'));

/** Block comments removed, and every line that is only a `//` comment emptied (line numbers kept). */
function strip(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, function (m) { return m.replace(/[^\n]/g, ''); })
        .split('\n').map(function (l) { return /^\s*\/\//.test(l) ? '' : l; }).join('\n');
}
var C = strip(CTRL), R = strip(RSWIG), V = strip(RV1);

/** The `cache` value of the shipped swigOptions literal, as source text. */
function cacheExpression() {
    var a = C.indexOf('var swigOptions = {');
    var b = C.indexOf('};', a);
    if (a < 0 || b < 0) { return null; }
    var m = /\bcache\s*:\s*([^\n]+?)\s*$/m.exec(C.slice(a, b));
    return m ? m[1].replace(/,$/, '') : null;
}
/**
 * The shipped expression, executed as controller.js runs it: `self.isCacheless()` returns `dev`, `lib` carries the
 * real resolver, and `swig` is a module reporting `version`.
 */
function shippedCache(dev, version) {
    var expr = cacheExpression();
    assert.ok(expr, 'the swigOptions literal carries a cache value');
    return new Function('self', 'lib', 'swig', 'return (' + expr + ');')(
        { isCacheless: function () { return dev; } },
        { swigResolver: resolver },
        { version: version }
    );
}
/** The page mapping, built by the shipped statements of controller.render-swig.js. */
function shippedPageMapping(filename) {
    var a = R.indexOf('mapping = { filename: path  };');
    var b = R.indexOf('if (', a);
    assert.ok(a > -1 && b > a, 'the page mapping statements are found');
    return new Function('path', 'var mapping;\n' + R.slice(a, b) + '\nreturn mapping;')(filename);
}

// ---- the template tree, a counting loader, gina's compile sequence
var ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'b1176-'));
after(function () { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) { /* temp dir */ } });
fs.mkdirSync(path.join(ROOT, 'partials'));
var ITEM = path.join(ROOT, 'partials/item.html');
var PAGE = path.join(ROOT, 'page.html');
var LAYOUT_A = '<main>LAYOUT-A{% block content %}{% endblock %}</main>';
var LAYOUT_B = '<main>LAYOUT-B{% block content %}{% endblock %}</main>';
var ITEMS = [1, 2, 3];
function writeItem(text) { fs.writeFileSync(ITEM, text || '<li>{{ name }}:{{ i }}</li>'); }
writeItem();

/** A per-template-root engine as controller.js mints it (`new swigMod.Swig(opts)`), its loader counting loads. */
function makeEngine(cache) {
    var loader = swig.loaders.fs(ROOT);
    var loads = Object.create(null);
    var load = loader.load;
    loader.load = function (identifier, cb) {           // the fs loader's arity, so layout-source hooks it the same way
        loads[identifier] = (loads[identifier] || 0) + 1;
        return load.apply(this, arguments);
    };
    var engine = new swig.Swig({ autoescape: false, cache: cache, loader: loader });
    return { engine: engine, loader: engine.options.loader, loads: loads };
}
/** controller.render-swig.js's compile (#B1129): register this render's layout under a token, compile, release. */
function compilePage(E, layoutText, mapping) {
    var target = path.join(ROOT, '.gina-layout-cache/b/layouts/main.html') + layoutSource.token();
    var content = '{% extends "' + target + '" %}{% block content %}{% for i in items %}'
        + '{% include "partials/item.html" %}{% endfor %}{% endblock %}';
    var id = null;
    if (layoutSource.install(E.loader)) {
        id = E.loader.resolve(target);
        layoutSource.register(E.loader, id, layoutText);
    }
    try {
        return E.engine.compile(content, mapping);
    } finally {
        if (id !== null) { layoutSource.release(E.loader, id); }
    }
}
function keys(E) { return Object.keys(E.engine.cache || {}); }
function tokenKeys(E) { return keys(E).filter(function (k) { return k.indexOf('gina-render=') > -1; }); }

describe('#B1176 — swig keeps compiled templates outside dev', function () {

    describe('01 — source pins', function () {
        it('the swigOptions literal sets cache from isCacheless() and the swig version: \'memory\' outside dev on swig >= 2.9.6, false otherwise', function () {
            assert.match(C, /var swigOptions = \{[^}]*\bcache\s*:\s*\(\s*self\.isCacheless\(\)\s*\|\|\s*lib\.swigResolver\.compareSemver\(\s*swig\.version\s*,\s*'2\.9\.6'\s*\)\s*<\s*0\s*\)\s*\?\s*false\s*:\s*'memory'/);
            assert.ok(CTRL.indexOf('var swigOptions = {') > -1, 'control: the raw source holds the literal');
        });
        it('the per-root engine is minted with those options (new swigMod.Swig(opts))', function () {
            assert.match(C, /new swigMod\.Swig\(opts\)/);
        });
        it('render-swig: the page mapping takes its own cache: false before the compile', function () {
            var a = R.indexOf('mapping = { filename: path  };');
            var b = R.indexOf('mapping.cache = false;', a);
            var c = R.indexOf('swig.compile(_templateContent, mapping)', a);
            assert.ok(a > -1 && b > a && c > b, 'mapping, then mapping.cache = false, then the compile (' + [a, b, c] + ')');
            assert.ok(RSWIG.indexOf('swig.compile(_templateContent, mapping)') > -1, 'control: the raw source holds the compile');
        });
        it('render-v1: both layout mappings take their own cache: false', function () {
            var m = V.match(/mapping = \{ filename: path \};\s*\n\s*mapping\.cache = false;/g) || [];
            assert.equal(m.length, 2);
            assert.equal((RV1.match(/mapping = \{ filename: path \};/g) || []).length, 2, 'control: two mappings in the raw source');
        });
    });

    describe('02 — the shipped cache expression', function () {
        it('CONTROL: the swig copy this test loads is 2.9.6 or later', function () {
            assert.equal(typeof swig.version, 'string');
            assert.ok(resolver.compareSemver(swig.version, '2.9.6') >= 0, swig.version);
        });
        it('outside dev, on the swig copy gina ships, it is \'memory\'', function () { assert.equal(shippedCache(false, swig.version), 'memory'); });
        it('outside dev, on swig 2.9.6, it is \'memory\'', function () { assert.equal(shippedCache(false, '2.9.6'), 'memory'); });
        it('outside dev, on swig 2.9.5 (a project\'s own older swig), it is false', function () { assert.equal(shippedCache(false, '2.9.5'), false); });
        it('outside dev, with no version to read, it is false', function () { assert.equal(shippedCache(false, undefined), false); });
        it('in dev it is false', function () { assert.equal(shippedCache(true, swig.version), false); });
    });

    describe('03 — the real engine with the shipped options', function () {
        it('outside dev: an include in a 3-item loop loads once across two renders', function () {
            writeItem();
            var E = makeEngine(shippedCache(false, swig.version));
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            assert.equal(E.loads[ITEM], 1);
        });
        it('outside dev: each render keeps its own layout and its own values', function () {
            writeItem();
            var E = makeEngine(shippedCache(false, swig.version));
            var o1 = compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'alice' });
            var o2 = compilePage(E, LAYOUT_B, shippedPageMapping(PAGE))({ items: ITEMS, name: 'bob' });
            assert.equal(o1, '<main>LAYOUT-A<li>alice:1</li><li>alice:2</li><li>alice:3</li></main>');
            assert.equal(o2, '<main>LAYOUT-B<li>bob:1</li><li>bob:2</li><li>bob:3</li></main>');
        });
        it('outside dev: 50 renders leave no per-render token key and one load', function () {
            writeItem();
            var E = makeEngine(shippedCache(false, swig.version));
            for (var k = 0; k < 50; k++) {
                compilePage(E, (k % 2) ? LAYOUT_A : LAYOUT_B, shippedPageMapping(PAGE))({ items: ITEMS, name: 'n' + k });
            }
            assert.deepEqual(tokenKeys(E), []);
            assert.deepEqual(keys(E), [ITEM]);
            assert.equal(E.loads[ITEM], 1);
        });
        it('outside dev: an edit after the first render shows in a fresh engine (a restart), not in the running one', function () {
            writeItem();
            var E1 = makeEngine(shippedCache(false, swig.version));
            compilePage(E1, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            writeItem('<li>EDITED {{ name }}:{{ i }}</li>');
            var o2 = compilePage(E1, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            var E2 = makeEngine(shippedCache(false, swig.version));
            var o3 = compilePage(E2, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            writeItem();
            assert.equal(o2.indexOf('EDITED'), -1, o2);
            assert.ok(o3.indexOf('EDITED x:1') > -1, o3);
        });
        it('outside dev: invalidateCache() drops the compiled include, and the next render loads it again', function () {
            writeItem();
            var E = makeEngine(shippedCache(false, swig.version));
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            E.engine.invalidateCache();
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            assert.equal(E.loads[ITEM], 2);
        });
        it('outside dev on a project\'s own swig below 2.9.6: the include loads on every render', function () {
            writeItem();
            var E = makeEngine(shippedCache(false, '2.9.5'));
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            compilePage(E, LAYOUT_A, shippedPageMapping(PAGE))({ items: ITEMS, name: 'x' });
            assert.equal(E.loads[ITEM], 6);
        });
        it('in dev: the include loads on every render, and an edit shows on the next one', function () {
            writeItem();
            var E = makeEngine(shippedCache(true, swig.version));
            var fn = compilePage(E, LAYOUT_A, shippedPageMapping(PAGE));
            fn({ items: ITEMS, name: 'x' });
            writeItem('<li>EDITED {{ name }}:{{ i }}</li>');
            var o2 = fn({ items: ITEMS, name: 'x' });
            writeItem();
            assert.equal(E.loads[ITEM], 6);
            assert.ok(o2.indexOf('EDITED x:1') > -1, o2);
        });
    });

    describe('04 — CONTROLS (hold on the pre-fix source too)', function () {
        it('CONTROL: an engine on cache: false loads the include once per render and per iteration', function () {
            writeItem();
            var E = makeEngine(false);
            var fn = compilePage(E, LAYOUT_A, { filename: PAGE });
            fn({ items: ITEMS, name: 'x' });
            fn({ items: ITEMS, name: 'x' });
            assert.equal(E.loads[ITEM], 6);
        });
        it('CONTROL: an engine on \'memory\' whose page compile has no cache: false of its own serves the first page again', function () {
            writeItem();
            var E = makeEngine('memory');
            compilePage(E, LAYOUT_A, { filename: PAGE })({ items: ITEMS, name: 'x' });
            var o2 = compilePage(E, LAYOUT_B, { filename: PAGE })({ items: ITEMS, name: 'x' });
            assert.ok(o2.indexOf('LAYOUT-A') > -1, 'the second render returned the first page: ' + o2);
        });
    });
});
