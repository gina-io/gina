'use strict';
/**
 * #B1131 — with the render cache on, the per-request values whispered into a layout no longer
 * reach every later visitor.
 *
 * `controller.render-swig.js` whispers `data.page.*` and `data.page.environment.*` into the
 * assembled layout (the client loader `gina.onload.min.js` carries 18 `{{ page.environment.* }}`
 * placeholders) BEFORE swig compiles it. With `server.cache.enable` on, the compiled template is
 * kept per view, and the whispered layout is persisted under `.gina-layout-cache` and read back by
 * every later compile without being re-primed. Up to 0.7.10 the first page render after that file
 * was created therefore fixed the public hostname, the webroot, the culture and its validation
 * labels, the proxy host and the section for every later render of every view sharing the layout,
 * across restarts (measured on a booted production bundle: a forwarded host and prefix sent by
 * the first request reached every later page, a cached page included). Those values come from
 * request headers (`X-Forwarded-Host`, `X-Forwarded-Prefix`, `Accept-Language`, the culture
 * cookie) and from the route.
 *
 * The fix: the eight per-request keys (`WHISPER_PER_REQUEST_KEYS`) are left out of the dictionary
 * the layout is whispered with, so their placeholders reach swig, which renders them from each
 * request's data; the http/2 asset scan (`getAssets()`) still reads the layout whispered with
 * every key, so its input is unchanged; and a layout file persisted by an earlier release (the
 * loader present, its hostname placeholder resolved) is re-primed from the raw layout, once.
 *
 * Sections:
 *   01 — source pins (comment-stripped, with an anti-vacuity control).
 *   02 — the dictionary build, extracted from the shipped source and executed over a page holding
 *        every key the controller sets.
 *   03 — the real `@rhinostone/swig` engine and the shipped client loader: one compile, two
 *        requests (a view whose compiled template is cached), autoescape on and off.
 *   04 — the stale-file heal, extracted from the shipped prime decision and executed against temp
 *        files; then the whole prime region, which re-primes the stale file.
 *   05 — the http/2 asset scan's input: byte for byte the layout whispered up to 0.7.10.
 *
 * Arms named CONTROL hold on the pre-fix source too. Red-first:
 * `GINA_RENDER_SWIG_SRC=<pre-fix controller.render-swig.js> node --test <this file>`.
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

// The framework globals the delegate relies on: whisper(), encodeRFC5987ValueChars()
require(path.join(FW, 'helpers'));

var swig         = require(path.join(FW, 'node_modules/@rhinostone/swig'));
var layoutSource = require(path.join(FW, 'core/controller/layout-source.js'));
var LOADER_SRC   = fs.readFileSync(path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.onload.min.js'), 'utf8');
// The loader as config.js wraps it (`templates._common.ginaLoader`)
var GINA_LOADER  = '\n\t\t<script type="text/javascript">\n\t\t<!--\n\t\t' + LOADER_SRC + '\n\t\t//-->\n\t\t</script>';
var RULE         = /\{{ ([a-zA-Z.]+) \}}/g;

var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

var PER_REQUEST = [
    'page.section',
    'page.environment.isProxyHost',
    'page.environment.proxyHost',
    'page.environment.proxyHostname',
    'page.environment.hostname',
    'page.environment.webroot',
    'page.environment.culture',
    'page.environment.validatorLabels'
];

var TMP_ROOTS = [];
after(function () {
    TMP_ROOTS.forEach(function (d) { fs.rmSync(d, { recursive: true, force: true }); });
});

/**
 * Drop full-line `//` comments: the delegate's prose names the very tokens a pin or an extraction
 * anchor looks for (the `// was:` records above all).
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
 * Occurrences of a literal.
 *
 * @inner
 * @param {string} haystack - Text searched
 * @param {string} needle - Literal looked for
 * @returns {number} How many times it occurs
 */
function count(haystack, needle) {
    return haystack.split(needle).length - 1;
}

/**
 * The index just past the brace that closes the `{` at `open`.
 *
 * @inner
 * @param {string} s - Text
 * @param {number} open - Index of an opening brace
 * @returns {number} Index after its closing brace
 */
function braceEnd(s, open) {
    assert.equal(s.charAt(open), '{', 'braceEnd starts on an opening brace');
    var depth = 0;
    for (var i = open; i < s.length; i++) {
        if ( s.charAt(i) === '{' ) { depth++; }
        else if ( s.charAt(i) === '}' ) { depth--; if ( depth === 0 ) { return i + 1; } }
    }
    assert.fail('unbalanced braces from ' + open);
}

/**
 * A unique slice of the comment-stripped delegate between two anchors.
 *
 * @inner
 * @param {string} start - Start anchor (included)
 * @param {string} end - End anchor (excluded), the first one after the start
 * @returns {string} The region
 */
function region(start, end) {
    var i = CODE.indexOf(start);
    assert.ok(i > -1, 'region start anchor not found: ' + start);
    assert.equal(CODE.indexOf(start, i + 1), -1, 'region start anchor must be unique: ' + start);
    var j = CODE.indexOf(end, i);
    assert.ok(j > i, 'region end anchor not found after the start: ' + end);
    return CODE.slice(i, j);
}

// ── The shipped pieces, extracted once ─────────────────────────────────────────

/**
 * The shipped `WHISPER_PER_REQUEST_KEYS` object, or `null` where the source has none.
 *
 * @inner
 * @returns {?Object<string, boolean>}
 */
function shippedConstant() {
    var at = CODE.indexOf('var WHISPER_PER_REQUEST_KEYS = Object.freeze(');
    if ( at < 0 ) { return null; }
    var open = CODE.indexOf('{', at);
    return new Function('return Object.freeze(' + CODE.slice(open, braceEnd(CODE, open)) + ');')();
}
var KEYS = shippedConstant();

// The dictionary build: from `var dic = {}, msg = '';` through the page.environment block.
var DIC_GUARD = "if (typeof data.page.environment === 'object' && data.page.environment !== null) {";
var DIC_START = CODE.indexOf("var dic = {}, msg = '';");
var DIC_IF    = CODE.indexOf(DIC_GUARD, DIC_START);
var DIC_BUILD = ( DIC_START > -1 && DIC_IF > DIC_START )
    ? CODE.slice(DIC_START, braceEnd(CODE, DIC_IF + DIC_GUARD.length - 1))
    : null;
var runDicBuild = ( DIC_BUILD !== null )
    ? new Function('data', 'WHISPER_PER_REQUEST_KEYS',
        DIC_BUILD + "\nreturn { dic: dic, assets: ( typeof(_assetsDic) != 'undefined' ) ? _assetsDic : undefined };")
    : null;

// The pre-#B1131 dictionary build, frozen verbatim: what the layout was whispered with up to 0.7.10
var FORMER_DIC_BUILD = [
    "var dic = {}, msg = '';",
    "for (let d in data.page) {",
    "    dic['page.'+d] = data.page[d]",
    "}",
    "if (typeof data.page.environment === 'object' && data.page.environment !== null) {",
    "    for (let k in data.page.environment) {",
    "        dic['page.environment.' + k] = data.page.environment[k];",
    "    }",
    "}",
    "return dic;"
].join('\n');
var formerDic = new Function('data', FORMER_DIC_BUILD);

/**
 * The shipped dictionary build over a page.
 *
 * @inner
 * @param {object} page - `data.page`
 * @returns {{ dic: object, assets: (object|undefined) }} The layout dictionary and the asset scan's
 */
function buildDic(page) {
    assert.ok(runDicBuild, 'the dictionary build was extracted');
    return runDicBuild({ page: page }, KEYS);
}

// ── A request's page, holding every key the controller sets ─────────────────────

var REQ1 = {
    host: 'one.b1131-one.test', webroot: '/b1131-one/web/', culture: 'fr-FR',
    labels: { 'b1131-one': 'l\'un (1)*' }, proxied: true, proxyHost: 'proxy.b1131-one.test',
    section: 'b1131-one-section'
};
var REQ2 = {
    host: 'two.b1131-two.test', webroot: '/b1131-two/web/', culture: 'en-US',
    labels: { 'b1131-two': 'deux' }, proxied: false, proxyHost: null,
    section: 'b1131-two-section'
};

/**
 * `data.page` as `controller.js` fills it for one request (the per-request values from `req`).
 *
 * @inner
 * @param {object} req - One of REQ1 / REQ2
 * @returns {object} The page
 */
function pageFor(req) {
    return {
        section : req.section,
        myValue : 'b1131-app-value',
        forms   : { b1131: {} },
        view    : { file: 'page', url: '/x' },
        data    : { session: { id: 'sid' } },
        environment: {
            'memory heap'     : '10.00 MB',
            gina              : '0.7.11',
            nodejs            : 'v25.3.0 darwin arm64',
            engine            : 'isaac',
            env               : 'prod',
            envIsDev          : false,
            scope             : 'local',
            scopeIsLocal      : true,
            scopeIsProduction : false,
            date              : { now: '2026-11-11T00:00:00.000Z' },
            isCacheless       : false,
            isProxyHost       : req.proxied,
            proxyHost         : req.proxied ? req.proxyHost : undefined,
            proxyHostname     : req.proxied ? 'https://' + req.proxyHost : undefined,
            hostname          : 'https://' + req.host,
            rootDomain        : 'b1131.test',
            webroot           : req.webroot,
            routing           : encodeRFC5987ValueChars('{}'),
            reverseRouting    : encodeRFC5987ValueChars('{}'),
            forms             : encodeRFC5987ValueChars('{}'),
            bundle            : 'web',
            project           : 'b1131',
            packageVersion    : '1.2.3',
            protocol          : 'http/2.0',
            scheme            : 'https',
            port              : 3100,
            pid               : 4242,
            culture           : req.culture,
            validatorLabels   : encodeRFC5987ValueChars(JSON.stringify(req.labels))
        }
    };
}

// The raw layout: the app's own placeholders (the section, an app value) and the slots gina fills
var RAW_LAYOUT = '<!doctype html><html><head><title>t</title><meta name="app" content="{{ page.myValue }}"></head>'
    + '<body><p id="section">{{ page.section }}</p>{% block content %}{% endblock %}</body></html>';

/**
 * The raw layout with the loader injected before `</head>`, as render-swig does.
 *
 * @inner
 * @returns {string} The assembled layout
 */
function assembled() {
    return RAW_LAYOUT.replace(/<\/head>/i, '\t' + GINA_LOADER + '\n</head>');
}

/**
 * Where a placeholder of the shipped loader sits: the literal text before each of its occurrences,
 * back to the previous `,` `;` or `{` of the minified source (`hostname:'`, `window.__ginaWebroot='`
 * …), so a rendered page can be read at the same spot.
 *
 * @inner
 * @param {string} key - e.g. `page.environment.hostname`
 * @returns {string[]} One prefix per occurrence
 */
function loaderSpots(key) {
    var token = '{{ ' + key + ' }}', spots = [], i = -1;
    while ( (i = LOADER_SRC.indexOf(token, i + 1)) > -1 ) {
        var b = Math.max(LOADER_SRC.lastIndexOf(',', i), LOADER_SRC.lastIndexOf(';', i), LOADER_SRC.lastIndexOf('{', i - 1));
        var prefix = LOADER_SRC.slice(b + 1, i);
        assert.ok(prefix.length > 3 && prefix.indexOf('{{') < 0 && prefix.indexOf('}}') < 0, 'a clean spot before ' + token + ': ' + prefix);
        spots.push(prefix);
    }
    assert.ok(spots.length > 0, 'the shipped loader carries ' + token);
    return spots;
}

/**
 * The values a rendered page carries at a loader placeholder's spots.
 *
 * @inner
 * @param {string} html - Rendered page
 * @param {string} key - Placeholder key
 * @returns {string[]} One value per occurrence
 */
function loaderValues(html, key) {
    return loaderSpots(key).map(function (prefix) {
        var at = html.indexOf(prefix);
        assert.ok(at > -1, 'the rendered loader holds ' + prefix);
        assert.equal(html.indexOf(prefix, at + 1), -1, 'the spot is unique in the page: ' + prefix);
        var start = at + prefix.length;
        return html.slice(start, html.indexOf('\'', start));
    });
}

/**
 * A temp templates root holding `layouts/main.html` (the given layout text, as the layout-cache
 * file holds it) and `content/page.html` extending it.
 *
 * @inner
 * @param {string} layoutText - The parent's text
 * @returns {{ root: string, childPath: string }}
 */
function makeRoot(layoutText) {
    var root = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1131-'));
    TMP_ROOTS.push(root);
    fs.mkdirSync(path.join(root, 'layouts'));
    fs.mkdirSync(path.join(root, 'content'));
    fs.writeFileSync(path.join(root, 'layouts/main.html'), layoutText);
    fs.writeFileSync(path.join(root, 'content/page.html'), '{% extends "layouts/main.html" %}{% block content %}N={{ n }}{% endblock %}');
    return { root: root, childPath: path.join(root, 'content/page.html') };
}

/**
 * The cached-view scene: request 1's render builds the dictionary, whispers it into the assembled
 * layout (the text cached mode persists) and swig compiles the view ONCE; that compiled template
 * then renders request 1 and request 2.
 *
 * @inner
 * @param {boolean} autoescape - The engine's autoescape setting
 * @returns {{ persisted: string, one: string, two: string }}
 */
function renderCachedView(autoescape) {
    var page1 = pageFor(REQ1), page2 = pageFor(REQ2);
    var persisted = whisper(buildDic(page1).dic, assembled(), RULE);
    var r = makeRoot(persisted);
    var engine = new swig.Swig({ autoescape: autoescape, cache: false, loader: swig.loaders.fs(r.root) });
    var tpl = engine.compileFile(r.childPath);
    return { persisted: persisted, one: tpl({ n: 1, page: page1 }), two: tpl({ n: 2, page: page2 }) };
}

/**
 * The script text of the rendered loader (between the config.js `<!--` / `//-->` wrapper).
 *
 * @inner
 * @param {string} html - Rendered page
 * @returns {string} The loader's JavaScript
 */
function loaderScript(html) {
    var a = html.indexOf('<!--\n'), b = html.indexOf('\n\t\t//-->');
    assert.ok(a > -1 && b > a, 'the rendered page holds the loader');
    return html.slice(a + 5, b);
}


// ─── 01 — source pins ─────────────────────────────────────────────────────────

describe('01 - #B1131 source pins', function () {

    it('anti-vacuity (CONTROL): the comment strip keeps the delegate it is asked about', function () {
        assert.ok(CODE.indexOf('module.exports = async function render') > -1);
        assert.equal(count(CODE, 'layout = whisper(dic, layout, /\\{{ ([a-zA-Z.]+) \\}}/g );'), 1, 'one layout whisper, with `dic`');
    });

    it('the eight per-request keys are a frozen module constant', function () {
        assert.ok(KEYS, 'var WHISPER_PER_REQUEST_KEYS = Object.freeze({…}) at module scope');
        assert.ok(Object.isFrozen(KEYS));
        assert.deepEqual(Object.keys(KEYS).sort(), PER_REQUEST.slice().sort());
        Object.keys(KEYS).forEach(function (k) { assert.equal(KEYS[k], true, k); });
    });

    it('both dictionary loops skip a per-request key, after recording it for the asset scan', function () {
        assert.ok(DIC_BUILD, 'the dictionary build was found');
        var top = DIC_BUILD.indexOf("if ( WHISPER_PER_REQUEST_KEYS['page.'+d] === true ) {");
        var env = DIC_BUILD.indexOf("if ( WHISPER_PER_REQUEST_KEYS['page.environment.' + k] === true ) {");
        assert.ok(top > -1 && env > -1, 'a skip in each loop');
        assert.ok(DIC_BUILD.indexOf("_assetsDic['page.'+d] = data.page[d];") < top, 'recorded before the skip (page.*)');
        assert.ok(DIC_BUILD.indexOf("_assetsDic['page.environment.' + k] = data.page.environment[k];") < env, 'recorded before the skip (page.environment.*)');
    });

    it('the http/2 asset scan reads the layout whispered with every value', function () {
        assert.equal(count(CODE, 'assets = self.serverInstance.getAssets(localOptions.conf, whisper(_assetsDic, _layoutForAssets, /\\{{ ([a-zA-Z.]+) \\}}/g ), null, data);'), 1);
        assert.equal(count(CODE, 'assets = self.serverInstance.getAssets(localOptions.conf, layout, null, data);'), 0, 'the scan no longer reads the compiled layout');
    });

    it('the stale-file heal sits in the prime decision', function () {
        var prime = region('var shouldWriteLayoutCache = (', 'if ( shouldWriteLayoutCache');
        assert.ok(prime.indexOf('if ( _layoutCacheOn && !shouldWriteLayoutCache ) {') > -1);
        assert.ok(prime.indexOf("await fs.promises.readFile( newLayoutFilename, 'utf8' );") > -1);
        assert.ok(prime.indexOf('/window\\.onGinaLoaded/.test(_persistedLayoutText)') > -1);
        assert.ok(prime.indexOf("_persistedLayoutText.indexOf('{{ page.environment.hostname }}') < 0") > -1);
    });

    it('the stale comment that said the loader cannot rely on swig is corrected', function () {
        assert.equal(count(SRC, 'which is inserted after Swig'), 0);
    });
});


// ─── 02 — the dictionary build, extracted and executed ─────────────────────────

describe('02 - #B1131 the dictionary the layout is whispered with', function () {

    it('the eight per-request keys are not in it', function () {
        var dic = buildDic(pageFor(REQ1)).dic;
        PER_REQUEST.forEach(function (k) {
            assert.equal(Object.prototype.hasOwnProperty.call(dic, k), false, k + ' must be left to swig');
        });
    });

    it('CONTROL: every other key of the page is in it, with its value', function () {
        var page = pageFor(REQ1), dic = buildDic(page).dic, former = formerDic({ page: page });
        var others = Object.keys(former).filter(function (k) { return PER_REQUEST.indexOf(k) < 0; });
        assert.ok(others.length > 25, 'the page fixture holds the controller\'s keys');
        others.forEach(function (k) {
            assert.ok(Object.prototype.hasOwnProperty.call(dic, k), k + ' is still whispered');
            assert.equal(dic[k], former[k], k);
        });
    });

    it('CONTROL: an app\'s own page key is still whispered', function () {
        assert.equal(buildDic(pageFor(REQ1)).dic['page.myValue'], 'b1131-app-value');
    });

    it('the asset scan\'s dictionary is the one the layout was whispered with up to 0.7.10', function () {
        var page = pageFor(REQ1), built = buildDic(page);
        assert.ok(built.assets, 'the asset scan has its own dictionary');
        assert.deepEqual(Object.keys(built.assets), Object.keys(formerDic({ page: page })));
        assert.deepEqual(built.assets, formerDic({ page: page }));
    });

    it('CONTROL: a page without an environment object builds without throwing', function () {
        var dic = buildDic({ section: 's', myValue: 'v' }).dic;
        assert.equal(dic['page.myValue'], 'v');
    });
});


// ─── 03 — the real swig engine, one compile, two requests ──────────────────────

[true, false].forEach(function (autoescape) {
    describe('03 - #B1131 one compiled view, two requests (autoescape ' + autoescape + ')', function () {

        var scene = null;
        test.before(function () { scene = renderCachedView(autoescape); });

        it('the layout cached mode persists keeps the eight placeholders and no request value', function () {
            ['{{ page.section }}', '{{ page.environment.hostname }}', '{{ page.environment.isProxyHost }}',
             '{{ page.environment.proxyHost }}', '{{ page.environment.proxyHostname }}',
             '{{ page.environment.culture }}', '{{ page.environment.validatorLabels }}'].forEach(function (p) {
                assert.ok(scene.persisted.indexOf(p) > -1, p);
            });
            assert.equal(count(scene.persisted, '{{ page.environment.webroot }}'), 2);
            assert.equal(scene.persisted.indexOf('b1131-one'), -1, 'no value of the request that compiled it');
        });

        it('each page carries its own request\'s values, and nothing of the other request', function () {
            [[scene.one, REQ1, 'b1131-two'], [scene.two, REQ2, 'b1131-one']].forEach(function (c) {
                var html = c[0], req = c[1];
                assert.deepEqual(loaderValues(html, 'page.environment.hostname'), ['https://' + req.host]);
                assert.deepEqual(loaderValues(html, 'page.environment.webroot'), [req.webroot, req.webroot]);
                assert.deepEqual(loaderValues(html, 'page.environment.culture'), [req.culture]);
                assert.deepEqual(loaderValues(html, 'page.environment.validatorLabels'), [encodeRFC5987ValueChars(JSON.stringify(req.labels))]);
                assert.deepEqual(loaderValues(html, 'page.environment.isProxyHost'), [String(req.proxied)]);
                assert.deepEqual(loaderValues(html, 'page.environment.proxyHost'), [req.proxied ? req.proxyHost : '']);
                assert.deepEqual(loaderValues(html, 'page.environment.proxyHostname'), [req.proxied ? 'https://' + req.proxyHost : '']);
                assert.ok(html.indexOf('<p id="section">' + req.section + '</p>') > -1, 'the section');
                assert.equal(html.indexOf(c[2]), -1, 'nothing of the other request');
            });
        });

        it('CONTROL: a per-bundle value and an app value are the same on both pages', function () {
            assert.deepEqual(loaderValues(scene.one, 'page.environment.bundle'), ['web']);
            assert.deepEqual(loaderValues(scene.two, 'page.environment.bundle'), ['web']);
            assert.ok(scene.one.indexOf('<meta name="app" content="b1131-app-value">') > -1);
            assert.ok(scene.two.indexOf('<meta name="app" content="b1131-app-value">') > -1);
        });

        it('CONTROL: the rendered loader is valid JavaScript on both pages', function () {
            assert.doesNotThrow(function () { new Function(loaderScript(scene.one)); });
            assert.doesNotThrow(function () { new Function(loaderScript(scene.two)); });
        });
    });
});


// ─── 04 — the stale-file heal ───────────────────────────────────────────────────

describe('04 - #B1131 a layout file persisted with resolved values is re-primed', function () {

    var HEAL = region('var shouldWriteLayoutCache = (', 'if ( shouldWriteLayoutCache');
    // `self` serves the pre-#B1129 form of the decision (it read the flag off the server instance)
    var runHeal = new AsyncFunction('self', 'fs', '_layoutCacheOn', 'newLayoutFilename', HEAL + '\nreturn shouldWriteLayoutCache;');

    var STALE   = '<html><head><script type="text/javascript">window.onGinaLoaded=function(){};var c={hostname:\'https://one.b1131-one.test\',webroot:\'/b1131-one/web/\'};</script></head><body></body></html>';
    var HEALED  = '<html><head><script type="text/javascript">window.onGinaLoaded=function(){};var c={hostname:\'{{ page.environment.hostname }}\',webroot:\'{{ page.environment.webroot }}\'};</script></head><body></body></html>';
    var NO_LOADER = '<html><head><title>{{ page.environment.bundle }}</title></head><body></body></html>';

    /**
     * Runs the shipped decision against one file; the reads it makes are recorded.
     *
     * @inner
     * @param {?string} content - The file's text; `null` for no file
     * @param {boolean} cacheOn - The render cache flag
     * @param {object} [opts] - `{ directory: true }` puts a directory at the path
     * @returns {Promise<{ decision: boolean, reads: string[] }>}
     */
    async function decide(content, cacheOn, opts) {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1131-heal-'));
        TMP_ROOTS.push(dir);
        var file = path.join(dir, 'main.html');
        if ( opts && opts.directory ) { fs.mkdirSync(file); }
        else if ( content !== null ) { fs.writeFileSync(file, content); }
        var reads = [];
        var fsx = {
            existsSync: fs.existsSync,
            promises: { readFile: function (p, enc) { reads.push(p); return fs.promises.readFile(p, enc); } }
        };
        var self = { serverInstance: { _cacheIsEnabled: cacheOn ? 'true' : false } };
        var decision = await runHeal(self, fsx, cacheOn, file);
        return { decision: decision, reads: reads };
    }

    it('a file holding the loader with its hostname resolved is primed again', async function () {
        var out = await decide(STALE, true);
        assert.equal(out.decision, true);
        assert.equal(out.reads.length, 1, 'read once, to decide');
    });

    it('CONTROL: a file whose loader keeps the placeholder (written by this release) is not', async function () {
        assert.equal((await decide(HEALED, true)).decision, false);
    });

    it('CONTROL: a layout without the loader is never primed again', async function () {
        assert.equal((await decide(NO_LOADER, true)).decision, false);
    });

    it('CONTROL: a missing file is primed, as before', async function () {
        assert.equal((await decide(null, true)).decision, true);
    });

    it('CONTROL: with the cache off the decision reads nothing', async function () {
        assert.equal((await decide(STALE, false)).reads.length, 0);
    });

    it('CONTROL: a path that cannot be read is left to the read that follows, as before', async function () {
        assert.equal((await decide(null, true, { directory: true })).decision, false);
    });

    it('the prime region replaces the stale file with the raw layout and assembles from it', async function () {
        // The whole region the #B1129 test executes: the decision, the prime and the re-point
        var R1 = region('var shouldWriteLayoutCache = (', 'localOptions.template.layout = layoutPath;') + 'localOptions.template.layout = layoutPath;';
        var BANNER = '// ---- #B482/#B484 - module-scope helper for the extends layout-cache re-point ----';
        var spliceExtendsTarget = new Function(SRC.slice(SRC.indexOf(BANNER)) + '\nreturn spliceExtendsTarget;')();
        var PARAMS = ['self', 'fs', '_', 'nodePath', 'cachePath', 'localOptions', 'layoutPath', 'newLayoutFilename',
            'newLayoutPath', 'isWithoutLayout', 'fragmentBlockRoster', 'buffer', '_templateContent', 'extendFound',
            'spliceExtendsTarget', 'data', 'layoutSource', '_layoutCacheOn', '_layoutSourceRaw', '_layoutSourceTarget'];
        var runR1 = new (Function.prototype.bind.apply(AsyncFunction, [null].concat(PARAMS, [R1 +
            '\nreturn { _layoutSourceRaw: ( typeof(_layoutSourceRaw) != \'undefined\' ) ? _layoutSourceRaw : null };'])))();
        /** gina's PathObject, as far as the region uses it. @inner */
        function PathStub(p) {
            if ( !(this instanceof PathStub) ) { return String(p); }
            this.p = p;
        }
        PathStub.prototype.existsSync = function () { return fs.existsSync(this.p); };
        PathStub.prototype.mkdirSync  = function () { fs.mkdirSync(this.p, { recursive: true }); };

        var root = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1131-prime-'));
        TMP_ROOTS.push(root);
        fs.mkdirSync(path.join(root, 'layouts'));
        fs.writeFileSync(path.join(root, 'layouts/main.html'), RAW_LAYOUT);
        var cacheDir  = path.join(root, '.gina-layout-cache');
        var cacheFile = path.join(cacheDir, 'web/swig/layouts/main.html');
        fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
        fs.writeFileSync(cacheFile, STALE);

        var child = '{% extends "layouts/main.html" %}{% block content %}N={{ n }}{% endblock %}';
        var self = { serverInstance: { _cacheIsEnabled: 'true' }, isXMLRequest: function () { return false; } };
        var out = await runR1(self, fs, PathStub, path, cacheDir, { template: { html: root }, bundle: 'web' }, 'layouts/main.html',
            cacheFile, 'swig/layouts/main.html', false, null, null, child, child.match(/\{\%(\s+extends|extends)(.*?)\%}/),
            spliceExtendsTarget, { page: { view: {} } }, layoutSource, true, null, null);

        assert.equal(fs.readFileSync(cacheFile, 'utf8'), RAW_LAYOUT, 'the stale file is replaced by the raw layout');
        assert.equal(out._layoutSourceRaw, RAW_LAYOUT, 'this render assembles from the raw layout');
    });
});


// ─── 05 — the http/2 asset scan's input ─────────────────────────────────────────

describe('05 - #B1131 the http/2 asset scan reads the layout it read up to 0.7.10', function () {

    var W_LINE  = 'layout = whisper(dic, layout, /\\{{ ([a-zA-Z.]+) \\}}/g );';
    var W_END   = "dic['page.content'] = layout;";
    var W_START = CODE.indexOf('var _layoutForAssets = layout;');
    var wLine   = CODE.indexOf(W_LINE);
    var R5      = CODE.slice( ( W_START > -1 && W_START < wLine ) ? W_START : wLine, CODE.indexOf(W_END, wLine) + W_END.length );
    var CALL    = 'assets = self.serverInstance.getAssets(localOptions.conf, ';
    var callAt  = CODE.indexOf(CALL);
    var ARG     = CODE.slice(callAt + CALL.length, CODE.indexOf(', null, data);', callAt));
    var runR5   = new Function('whisper', 'dic', 'layout',
        R5 + "\nreturn { layout: layout, forAssets: ( typeof(_layoutForAssets) != 'undefined' ) ? _layoutForAssets : undefined };");
    var scanArg = new Function('whisper', 'layout', '_assetsDic', '_layoutForAssets', 'return ' + ARG + ';');

    // An app layout that writes asset URLs with the webroot and the hostname
    var APP_LAYOUT = assembled().replace('</head>',
        '<link rel="stylesheet" href="{{ page.environment.hostname }}/css/a.css"><img src="{{ page.environment.webroot }}img/logo.png"></head>');

    /**
     * The shipped whisper step and the asset scan's argument, for request 1.
     *
     * @inner
     * @returns {{ compiled: string, scanned: string, former: string }}
     */
    function scene() {
        var page = pageFor(REQ1), built = buildDic(page);
        var out = runR5(whisper, built.dic, APP_LAYOUT);
        return {
            compiled: out.layout,
            scanned : scanArg(whisper, out.layout, built.assets, out.forAssets),
            former  : whisper(formerDic({ page: page }), APP_LAYOUT, RULE)
        };
    }

    it('anti-vacuity (CONTROL): the whisper step and the scan\'s argument were extracted', function () {
        assert.ok(wLine > -1 && callAt > -1 && ARG.length > 0);
        assert.ok(R5.indexOf(W_LINE) > -1);
    });

    it('CONTROL: the scan\'s input is byte for byte the layout whispered with every value', function () {
        var s = scene();
        assert.equal(s.scanned, s.former);
        assert.ok(s.scanned.indexOf('<img src="/b1131-one/web/img/logo.png">') > -1, 'the webroot URL resolves for the scan');
        assert.ok(s.scanned.indexOf('<link rel="stylesheet" href="https://one.b1131-one.test/css/a.css">') > -1);
    });

    it('the pre-whisper layout is kept for the scan just before the whisper', function () {
        assert.ok(W_START > -1, 'var _layoutForAssets = layout;');
        assert.equal(CODE.slice(W_START + 'var _layoutForAssets = layout;'.length, wLine).trim(), '', 'nothing between the copy and the whisper');
    });

    it('the layout swig compiles leaves those URLs to swig', function () {
        var s = scene();
        assert.ok(s.compiled.indexOf('<img src="{{ page.environment.webroot }}img/logo.png">') > -1);
        assert.ok(s.compiled.indexOf('href="{{ page.environment.hostname }}/css/a.css"') > -1);
        assert.equal(s.compiled.indexOf('b1131-one'), -1);
    });
});
