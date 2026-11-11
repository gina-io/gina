'use strict';
/**
 * #B1129 (F1) — the swig delegate compiles a template against the layout THIS render
 * assembled, from memory; with the render cache off it writes no shared file.
 *
 * Up to 0.7.10, `controller.render-swig.js` handled a template that extends a layout through
 * one shared file, `<templates>/.gina-layout-cache/<bundle>/swig/<layout>`, on every render with
 * the render cache off: it wrote the raw layout there, read it back, whispered the request's
 * values into it (`{{ page.environment.hostname }}`, `.webroot`, `.culture` …), wrote the
 * assembled layout over it, and swig compiled the template against that file. Concurrent renders
 * of pages sharing a layout read one another's file: a page carried another request's whispered
 * values, or no client loader, and on a bind-mounted templates directory the file could be read
 * as absent while another render renamed over it (measured on a booted bundle: 83 of 112 parallel
 * responses in production mode carried another request's hostname).
 *
 * The fix (`core/controller/layout-source.js` + the delegate): the raw layout is assembled in
 * memory, the template's `{% extends %}` names a per-render token target, and the engine
 * loader's hook serves the assembled layout for that target during the (synchronous) compile.
 * With the cache off nothing is written; in cached mode the file is still primed and persisted.
 *
 * Sections:
 *   01 — source pins on the delegate (comment-stripped, with an anti-vacuity control).
 *   02 — `layout-source.js` on its own: token, install (arity, idempotence, refusals),
 *        register / serve / release, delegation of every other identifier.
 *   03 — the real `@rhinostone/swig` engine with the hook: a registered parent is compiled from
 *        memory, a released one fails closed; CONTROL: the bare cache path reads the file.
 *   04 — the delegate's own I/O regions, EXTRACTED from the shipped source and executed against
 *        a temp templates root with the real swig engine (the layout assembly between them is a
 *        stub of the loader injection + whisper): two renders interleaved at the awaits where
 *        the race happens, in both cache modes, plus a read that follows another render's
 *        persist, and the fail-closed contract.
 *
 * Red-first: `GINA_RENDER_SWIG_SRC=<pre-fix controller.render-swig.js> node --test <this file>`
 * runs 01 and 04 against the pre-fix delegate (02 and 03 test the new module itself).
 */

var assert   = require('node:assert/strict');
var fs       = require('fs');
var os       = require('os');
var path     = require('path');
var test     = require('node:test');
var describe = test.describe, it = test.it, after = test.after;

var FW = require('../fw');
// Module-path seam: point the pins and the extracted regions at a pre-change copy of the delegate.
var SOURCE = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

var swig         = require(path.join(FW, 'node_modules/@rhinostone/swig'));
var layoutSource = require(path.join(FW, 'core/controller/layout-source.js'));

var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

var TMP_ROOTS = [];
after(function () {
    TMP_ROOTS.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); });
});

/**
 * Drop full-line `//` comments: the delegate's prose names the very tokens a pin or an
 * extraction anchor looks for (the `// was:` records above all).
 *
 * @inner
 * @param {string} s - Source text
 * @returns {string} The text without full-line comments
 */
function stripLineComments(s) {
    return s.replace(/^[ \t]*\/\/[^\n]*$/mg, '');
}

var CODE = stripLineComments(SRC);

/**
 * A unique slice of the comment-stripped delegate between two anchors.
 *
 * @inner
 * @param {string} start - Start anchor (included)
 * @param {string} end - End anchor
 * @param {boolean} [inclusive] - Include the end anchor
 * @returns {string} The region
 */
function region(start, end, inclusive) {
    var i = CODE.indexOf(start);
    assert.ok(i > -1, 'region start anchor not found: ' + start);
    assert.equal(CODE.indexOf(start, i + 1), -1, 'region start anchor must be unique: ' + start);
    var j = CODE.indexOf(end, i);
    assert.ok(j > i, 'region end anchor not found after the start: ' + end);
    return CODE.slice(i, inclusive ? j + end.length : j);
}

/**
 * A fresh templates root: `layouts/main.html` (the raw layout) and `content/page.html` (a page
 * extending it).
 *
 * @inner
 * @returns {{ root: string, cacheFile: string, cacheDir: string, child: string, childPath: string }}
 */
function makeRoot() {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1129-'));
    TMP_ROOTS.push(root);
    fs.mkdirSync(path.join(root, 'layouts'));
    fs.mkdirSync(path.join(root, 'content'));
    fs.writeFileSync(path.join(root, 'layouts/main.html'),
        '<!doctype html><html><head><title>t</title></head><body>{% block content %}{% endblock %}</body></html>');
    var child = '{% extends "layouts/main.html" %}{% block content %}N={{ n }}{% endblock %}';
    fs.writeFileSync(path.join(root, 'content/page.html'), child);
    return {
        root     : root,
        cacheDir : path.join(root, '.gina-layout-cache'),
        cacheFile: path.join(root, '.gina-layout-cache/web/swig/layouts/main.html'),
        child    : child,
        childPath: path.join(root, 'content/page.html')
    };
}

/**
 * The page a render produced, reduced to what the arms compare.
 *
 * @inner
 * @param {string} html - Executed template output
 * @returns {{ hostname: (string|null), loader: boolean, n: (string|null) }}
 */
function readPage(html) {
    var h = html.match(/hostname:'([^']*)'/);
    var n = html.match(/N=(\d+)/);
    return { hostname: h ? h[1] : null, loader: /window\.onGinaLoaded/.test(html), n: n ? n[1] : null };
}

describe('01 - #B1129 F1 source pins', function () {

    it('anti-vacuity: the comment strip keeps the delegate it is asked about', function () {
        assert.ok(CODE.indexOf('module.exports = async function render') > -1);
        assert.ok(CODE.indexOf('compiledTemplate = swig.compile(_templateContent, mapping);') > -1);
    });

    it('the delegate requires the layout-source helper at module level', function () {
        assert.ok(CODE.indexOf("var layoutSource  = require('./layout-source');") > -1);
    });

    it('the render-cache flag is read once, in render()', function () {
        assert.ok(CODE.indexOf("_layoutCacheOn      = ( String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' )") > -1);
    });

    it('the layout file is primed only with the render cache on (and when it is missing)', function () {
        assert.ok(CODE.indexOf('var shouldWriteLayoutCache = ( _layoutCacheOn && !fs.existsSync( newLayoutFilename ) );') > -1);
    });

    it('the assembled layout is persisted only with the render cache on', function () {
        var persist = region('if (newLayoutFilename) {', 'mapping = { filename: path  };');
        var gate  = persist.indexOf('if ( _layoutCacheOn ) {');
        var write = persist.indexOf('fs.promises.writeFile(_layoutTmpAssets');
        assert.ok(gate > -1 && write > gate, 'the post-asset write must sit inside `if ( _layoutCacheOn )`');
    });

    it('the extends target carries a per-render token', function () {
        assert.ok(CODE.indexOf('layoutSource.token();') > -1);
        assert.ok(CODE.indexOf('_templateContent = spliceExtendsTarget(_templateContent, extendFound, layoutPath, _layoutTarget );') > -1);
    });

    it('the layout read takes the raw layout from memory when this render read it', function () {
        assert.ok(CODE.indexOf("layout = ( _layoutSourceRaw !== null ) ? _layoutSourceRaw : await fs.promises.readFile(layoutPath, 'utf8');") > -1);
    });

    it('the compile is wrapped by register and release', function () {
        var compile = region('var _compileStart = (local._timeline) ? Date.now() : 0;', 'if (_compileStart && local._timeline) {');
        var reg = compile.indexOf('layoutSource.register(');
        var cmp = compile.indexOf('compiledTemplate = swig.compile(_templateContent, mapping);');
        var fin = compile.indexOf('finally');
        var rel = compile.indexOf('layoutSource.release(');
        assert.ok(reg > -1 && cmp > reg && fin > cmp && rel > fin, 'expected register, then the compile, then release in a finally');
    });
});

describe('02 - #B1129 layout-source.js', function () {

    it('token(): unique per call, process-tagged, names no file', function () {
        var seen = Object.create(null);
        for (var i = 0; i < 500; i++) {
            var t = layoutSource.token();
            assert.match(t, new RegExp('^\\?gina-render=' + process.pid + '\\.\\d+$'));
            assert.equal(seen[t], undefined, 'token repeated: ' + t);
            seen[t] = true;
        }
    });

    it('install(): same object, resolve untouched, arity kept (2 for the fs loader, 1 for a 1-arg loader)', function () {
        var fsLoader = swig.loaders.fs(os.tmpdir());
        var resolve  = fsLoader.resolve;
        assert.equal(fsLoader.load.length, 2, 'premise: the fs loader takes a callback');
        assert.equal(layoutSource.install(fsLoader), fsLoader);
        assert.equal(fsLoader.resolve, resolve);
        assert.equal(fsLoader.load.length, 2);
        var oneArg = { resolve: function (to) { return to; }, load: function (id) { return 'ORIGINAL:' + id; } };
        layoutSource.install(oneArg);
        assert.equal(oneArg.load.length, 1);
    });

    it('install(): idempotent — a hooked loader is not wrapped twice', function () {
        var l = { resolve: function (to) { return to; }, load: function (id) { return 'ORIGINAL:' + id; } };
        layoutSource.install(l);
        var hooked = l.load;
        assert.equal(layoutSource.install(l), l);
        assert.equal(l.load, hooked);
    });

    it('install(): refuses what it cannot hook', function () {
        assert.equal(layoutSource.install(null), null);
        assert.equal(layoutSource.install({}), null);
        assert.equal(layoutSource.install({ load: 'x' }), null);
        var frozen = Object.freeze({ resolve: function (to) { return to; }, load: function (id) { return id; } });
        assert.equal(layoutSource.install(frozen), null);
        assert.equal(layoutSource.register(frozen, '/a', 'x'), false);
    });

    it('register / serve / release, in both load forms, and delegation of every other identifier', function () {
        var l = {
            resolve: function (to) { return to; },
            load   : function (id, cb) { var v = 'ORIGINAL:' + id; if (cb) { cb(null, v); return; } return v; }
        };
        assert.equal(layoutSource.register(l, '/x?gina-render=1.1', 'MEMORY'), true);
        assert.equal(l.load('/x?gina-render=1.1'), 'MEMORY');
        var viaCb = null;
        l.load('/x?gina-render=1.1', function (err, src) { viaCb = [err, src]; });
        assert.deepEqual(viaCb, [null, 'MEMORY']);
        assert.equal(l.load('/other'), 'ORIGINAL:/other');
        ['constructor', '__proto__', 'toString'].forEach(function (k) {
            assert.equal(l.load(k), 'ORIGINAL:' + k, 'an inherited member name must not be served: ' + k);
        });
        layoutSource.release(l, '/x?gina-render=1.1');
        assert.equal(l.load('/x?gina-render=1.1'), 'ORIGINAL:/x?gina-render=1.1');
    });

    it('the registry is not enumerable on the loader', function () {
        var l = { resolve: function (to) { return to; }, load: function (id) { return id; } };
        layoutSource.install(l);
        assert.deepEqual(Object.keys(l).sort(), ['load', 'resolve']);
    });
});

describe('03 - #B1129 the real swig engine with the hook', function () {

    /**
     * A root holding a STALE assembled layout at the cache path (another request's), and an
     * engine minted as controller.js mints the per-bundle one.
     *
     * @inner
     * @returns {object} `{ r, engine, stale }`
     */
    function scene() {
        var r = makeRoot();
        fs.mkdirSync(path.dirname(r.cacheFile), { recursive: true });
        var stale = "<!doctype html><html><head><script>window.onGinaLoaded=1;var gina={hostname:'h-stale.example'};</script></head><body>{% block content %}{% endblock %}</body></html>";
        fs.writeFileSync(r.cacheFile, stale);
        var engine = new swig.Swig({ autoescape: false, cache: false, loader: swig.loaders.fs(r.root) });
        return { r: r, engine: engine };
    }

    var OWN = "<!doctype html><html><head><script>window.onGinaLoaded=1;var gina={hostname:'h-own.example'};</script></head><body>{% block content %}{% endblock %}</body></html>";

    it('a registered parent is compiled from memory, not from the file at the same path', function () {
        var s = scene();
        var target = s.r.cacheFile + layoutSource.token();
        var child  = '{% extends "' + target + '" %}{% block content %}N={{ n }}{% endblock %}';
        var loader = s.engine.options.loader;
        var id = loader.resolve(target);
        layoutSource.register(loader, id, OWN);
        var html;
        try {
            html = s.engine.compile(child, { filename: s.r.childPath })({ n: 7 });
        } finally {
            layoutSource.release(loader, id);
        }
        assert.deepEqual(readPage(html), { hostname: 'h-own.example', loader: true, n: '7' });
    });

    it('a released target fails closed: the token names no file', function () {
        var s = scene();
        var target = s.r.cacheFile + layoutSource.token();
        var child  = '{% extends "' + target + '" %}{% block content %}x{% endblock %}';
        assert.throws(function () { s.engine.compile(child, { filename: s.r.childPath }); }, /ENOENT/);
    });

    it('the callback form of load() serves the registered parent too (compileFile with a callback)', function (t, done) {
        var s = scene();
        var target = s.r.cacheFile + layoutSource.token();
        var loader = s.engine.options.loader;
        var id = loader.resolve(target);
        layoutSource.register(loader, id, '{% block content %}CB{% endblock %}');
        s.engine.compileFile(target, {}, function (err, fn) {
            layoutSource.release(loader, id);
            try {
                assert.ifError(err);
                assert.equal(fn({}), 'CB');
                done();
            } catch (e) { done(e); }
        });
    });

    it('CONTROL - the bare cache path (the pre-fix target) reads whatever file sits there', function () {
        var s = scene();
        var child = '{% extends "' + s.r.cacheFile + '" %}{% block content %}N={{ n }}{% endblock %}';
        var html  = s.engine.compile(child, { filename: s.r.childPath })({ n: 1 });
        assert.equal(readPage(html).hostname, 'h-stale.example');
    });
});

describe('04 - #B1129 the delegate\'s I/O regions, extracted and executed', function () {

    // The shipped regions, from the (seam-selected) delegate source.
    var R1 = region('var shouldWriteLayoutCache = (', 'localOptions.template.layout = layoutPath;', true);
    var R2 = ( CODE.match(/^[ \t]*layout = [^\n]*fs\.promises\.readFile\(layoutPath, 'utf8'\);[ \t]*$/m) || [null] )[0];
    var R3 = region('if (newLayoutFilename) {', 'if (_compileStart && local._timeline) {');

    // The shipped re-point helper (#B482), compiled from its module-scope region.
    var BANNER = '// ---- #B482/#B484 - module-scope helper for the extends layout-cache re-point ----';
    var spliceExtendsTarget = new Function(SRC.slice(SRC.indexOf(BANNER)) + '\nreturn spliceExtendsTarget;')();

    var R1_PARAMS = ['self', 'fs', '_', 'nodePath', 'cachePath', 'localOptions', 'layoutPath', 'newLayoutFilename',
        'newLayoutPath', 'isWithoutLayout', 'fragmentBlockRoster', 'buffer', '_templateContent', 'extendFound',
        'spliceExtendsTarget', 'data', 'layoutSource', '_layoutCacheOn', '_layoutSourceRaw', '_layoutSourceTarget'];
    var R3_PARAMS = ['self', 'fs', 'newLayoutFilename', 'isWithoutLayout', 'fragmentBlockRoster', 'layout', 'mapping',
        'path', 'localOptions', '_templateContent', 'local', 'swig', 'compiledTemplate', 'layoutSource',
        '_layoutCacheOn', '_layoutSourceTarget', '_layoutSourceText'];

    var runR1 = new (Function.prototype.bind.apply(AsyncFunction, [null].concat(R1_PARAMS, [R1 +
        '\nreturn { _templateContent: _templateContent, layoutPath: layoutPath, _layoutSourceRaw: _layoutSourceRaw, _layoutSourceTarget: _layoutSourceTarget };'])))();
    var runR2 = new AsyncFunction('fs', 'layoutPath', '_layoutSourceRaw', 'var layout = null;\n' + R2 + '\nreturn layout;');
    var runR3 = new (Function.prototype.bind.apply(AsyncFunction, [null].concat(R3_PARAMS, [R3 + '\nreturn compiledTemplate;'])))();

    /**
     * gina's PathObject, as far as the regions use it: `_(p, true)` gives the path string,
     * `new _(dir)` a handle with `existsSync()` / `mkdirSync()`.
     *
     * @inner
     */
    function PathStub(p) {
        if ( !(this instanceof PathStub) ) { return String(p); }
        this.p = p;
    }
    PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };
    PathStub.prototype.mkdirSync  = function () { fs.mkdirSync(this.p, { recursive: true }); };

    /**
     * The fs the regions see: the real one, with every write and rename onto `watch` recorded,
     * and an optional hook run after each real rename.
     *
     * @inner
     * @param {object} log - `{ writes: [] }`, filled with the shared-file writes
     * @param {function} [afterRename] - Awaited after each real rename
     * @returns {object} An fs-shaped object
     */
    function fsFor(log, afterRename) {
        return {
            existsSync   : fs.existsSync,
            writeFileSync: function (p, v) { log.writes.push(p); return fs.writeFileSync(p, v); },
            promises: {
                readFile : fs.promises.readFile,
                writeFile: function (p, v) { log.writes.push(p); return fs.promises.writeFile(p, v); },
                rename   : async function (a, b) {
                    log.writes.push(b);
                    await fs.promises.rename(a, b);
                    if ( afterRename ) { await afterRename(); }
                }
            }
        };
    }

    /**
     * One render's state, with the request's own whispered host.
     *
     * @inner
     */
    function newRender(r, host, n, cacheOn) {
        var self = { serverInstance: { _cacheIsEnabled: cacheOn ? 'true' : false }, isXMLRequest: function () { return false; } };
        return {
            host: host, n: n, r: r,
            self: self,
            cacheOn: ( String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' ),
            localOptions: { template: { html: r.root }, bundle: 'web' },
            data: { page: { view: {} } },
            _templateContent: r.child,
            layoutPath: 'layouts/main.html',
            newLayoutPath: 'swig/layouts/main.html',
            newLayoutFilename: r.cacheFile,
            raw: null, target: null, layout: null
        };
    }

    async function step1(R, fsx) {
        var extendFound = R._templateContent.match(/\{\%(\s+extends|extends)(.*?)\%}/);
        var out = await runR1(R.self, fsx, PathStub, path, R.r.cacheDir, R.localOptions, R.layoutPath,
            R.newLayoutFilename, R.newLayoutPath, false, null, null, R._templateContent, extendFound,
            spliceExtendsTarget, R.data, layoutSource, R.cacheOn, null, null);
        R._templateContent = out._templateContent;
        R.layoutPath = out.layoutPath;
        R.raw = out._layoutSourceRaw;
        R.target = out._layoutSourceTarget;
    }

    // The assembly between the two regions (render-swig.js: the loader injection guarded by
    // `!/window\.onGinaLoaded/.test(layout)`, then `whisper(dic, layout, /\{{ ([a-zA-Z.]+) \}}/g)`
    // with `dictionary[key] || s`), reduced to the one value the arms read.
    async function step2(R, fsx) {
        var layout = await runR2(fsx, R.layoutPath, R.raw);
        if ( !/window\.onGinaLoaded/.test(layout) ) {
            layout = layout.replace(/<\/head>/i, "<script>window.onGinaLoaded=1;var gina={hostname:'{{ page.environment.hostname }}'};</script></head>");
        }
        var dic = { 'page.environment.hostname': R.host };
        R.layout = layout.replace(/\{{ ([a-zA-Z.]+) \}}/g, function (s, key) { return dic[key] || s; });
    }

    function step3(R, fsx, engine) {
        return runR3(R.self, fsx, R.newLayoutFilename, false, null, R.layout, null, R.r.childPath,
            R.localOptions, R._templateContent, {}, engine, null, layoutSource, R.cacheOn, R.target, null);
    }

    /**
     * Two renders A and B of one view, interleaved where the shared file races: both prime, both
     * read and assemble, then A persists and B runs its persist and compile entirely before A
     * compiles. Without a persist (the fix, cache off) A simply completes first.
     *
     * @inner
     * @param {boolean} cacheOn - The render cache flag
     * @returns {Promise<object>} `{ a, b, writes, r }`
     */
    async function raceTwoRenders(cacheOn) {
        var r = makeRoot();
        var engine = new swig.Swig({ autoescape: false, cache: false, loader: swig.loaders.fs(r.root) });
        var log = { writes: [] };
        var A = newRender(r, 'h-a.example', 1, cacheOn), B = newRender(r, 'h-b.example', 2, cacheOn);
        await step1(A, fsFor(log));
        await step1(B, fsFor(log));
        await step2(A, fsFor(log));
        await step2(B, fsFor(log));
        var release, gate = new Promise(function (res) { release = res; });
        var renamedA, aRenamed = new Promise(function (res) { renamedA = res; });
        var pA = step3(A, fsFor(log, async function () { renamedA(); await gate; }), engine);
        await Promise.race([aRenamed, pA]);
        var tplB = await step3(B, fsFor(log), engine);
        release();
        var tplA = await pA;
        return { a: readPage(tplA({ n: 1 })), b: readPage(tplB({ n: 2 })), writes: log.writes, r: r };
    }

    it('anti-vacuity: the three regions were extracted and compile', function () {
        assert.ok(R1.indexOf('spliceExtendsTarget(') > -1 && R1.indexOf('fs.promises.readFile(') > -1);
        assert.ok(R2 && R2.indexOf('fs.promises.readFile(layoutPath') > -1);
        assert.ok(R3.indexOf('swig.compile(_templateContent, mapping)') > -1);
        assert.equal(typeof spliceExtendsTarget, 'function');
    });

    it('cache off: two interleaved renders each serve their own whispered host and the client loader', async function () {
        var out = await raceTwoRenders(false);
        assert.deepEqual(out.a, { hostname: 'h-a.example', loader: true, n: '1' }, 'render A');
        assert.deepEqual(out.b, { hostname: 'h-b.example', loader: true, n: '2' }, 'render B');
    });

    it('cache off: nothing is written under .gina-layout-cache', async function () {
        var out = await raceTwoRenders(false);
        assert.deepEqual(out.writes, []);
        assert.equal(fs.existsSync(out.r.cacheDir), false);
    });

    it('cache off: a render whose layout read follows another render\'s persist keeps its own host and loader', async function () {
        var r = makeRoot();
        var engine = new swig.Swig({ autoescape: false, cache: false, loader: swig.loaders.fs(r.root) });
        var log = { writes: [] };
        var A = newRender(r, 'h-a.example', 1, false), B = newRender(r, 'h-b.example', 2, false);
        await step1(A, fsFor(log));
        await step1(B, fsFor(log));
        await step2(B, fsFor(log));
        var tplB = await step3(B, fsFor(log), engine);
        await step2(A, fsFor(log));
        var tplA = await step3(A, fsFor(log), engine);
        assert.deepEqual(readPage(tplA({ n: 1 })), { hostname: 'h-a.example', loader: true, n: '1' });
        assert.deepEqual(readPage(tplB({ n: 2 })), { hostname: 'h-b.example', loader: true, n: '2' });
    });

    it('cache on: two interleaved first renders each compile their own layout', async function () {
        var out = await raceTwoRenders(true);
        assert.deepEqual(out.a, { hostname: 'h-a.example', loader: true, n: '1' }, 'render A');
        assert.deepEqual(out.b, { hostname: 'h-b.example', loader: true, n: '2' }, 'render B');
    });

    it('CONTROL - cache on: the layout file is still primed and persisted (assembled, with the loader)', async function () {
        var out = await raceTwoRenders(true);
        assert.ok(out.writes.indexOf(out.r.cacheFile) > -1, 'the layout file must still be written in cached mode');
        var persisted = fs.readFileSync(out.r.cacheFile, 'utf8');
        assert.match(persisted, /window\.onGinaLoaded/);
        assert.match(persisted, /hostname:'h-[ab]\.example'/);
    });

    it('fails closed: an engine whose loader cannot be hooked does not compile from a file', async function () {
        var r = makeRoot();
        var engine = new swig.Swig({ autoescape: false, cache: false, loader: swig.loaders.fs(r.root) });
        var unhookable = { compile: engine.compile };
        var log = { writes: [] };
        var A = newRender(r, 'h-a.example', 1, false);
        await step1(A, fsFor(log));
        await step2(A, fsFor(log));
        await assert.rejects(step3(A, fsFor(log), unhookable), /ENOENT/);
    });
});
