'use strict';
/**
 * `getAssets()` in core/server.js scans a page's layout for the images, stylesheets
 * and scripts written in it. Its map feeds the `link` header of an `http/2.0`
 * page's 200 (preload hints) and the Inspector's view of the page's assets. Fixed
 * in one arc:
 *   #B768  a match ran to the end of its SOURCE LINE and kept the last `src` /
 *          `href` on it, so tags sharing a line were read as one tag: a script
 *          preloaded `as=image`, a stylesheet or a <picture>'s <img> lost, a
 *          minified layout given no hint at all;
 *   #B775  a tag with no `src` / `href` reused the previous tag's URL (`url` was
 *          kept across tags): the FIRST such tag threw, so the page answered 500;
 *          a later one overwrote the previous entry. A missing asset also kept the
 *          previous asset's extension and MIME type;
 *   #B774  the CSS `url()` scan read `.match(...)[0]` unguarded: an unquoted
 *          `url(#id)` or a `url()` with no dot in its path threw, and the page
 *          answered 500;
 *   #B776  a CSS `url()` naming the same file as a layout <img> replaced that
 *          image's entry, so the image lost its hint.
 *
 * Each section runs the REAL getAssets(), lifted out of server.js the way
 * preload-hints-b765 §06 does (between its own two anchors, compiled with
 * `new Function`), with the real isPreloadableLayoutTag and the real
 * buildH2PreloadLinks from render-swig. Only the resolver and `fs` are stubs: the
 * resolver behaves like getAssetFilenameFromUrl() on a path WITHOUT the webroot
 * (a known public directory resolves under a root, anything else is '404.html').
 * The live readings (a real
 * prod bundle, the 200's `link` header over HTTP/1.1 + TLS) are the #B768 scene,
 * not unit arms.
 *
 * Seams — point a section at a pre-change copy for a red-first run:
 * GINA_SERVER_SRC (getAssets and isPreloadableLayoutTag), GINA_RENDER_SWIG_SRC
 * (buildH2PreloadLinks).
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW = require('../fw');

var SERVER_SRC      = process.env.GINA_SERVER_SRC      || path.join(FW, 'core/server.js');
var RENDER_SWIG_SRC = process.env.GINA_RENDER_SWIG_SRC || path.join(FW, 'core/controller/controller.render-swig.js');

/**
 * The text from a unique anchor to the brace that closes the first `{` after it.
 * Only used on code whose braces all balance outside strings and regexes (the
 * balance assertion catches the case where they do not).
 * @inner
 */
function braceBlock(src, anchor) {
    var at = src.indexOf(anchor);
    assert.ok(at > -1, 'anchor present: ' + anchor.slice(0, 70));
    assert.strictEqual(src.indexOf(anchor, at + 1), -1, 'anchor unique: ' + anchor.slice(0, 70));
    var depth = 0, i = src.indexOf('{', at);
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    assert.strictEqual(depth, 0, 'balanced braces after ' + anchor.slice(0, 70));
    return src.slice(at, i);
}

/** The text between two unique anchors (end excluded). @inner */
function between(src, startAnchor, endAnchor) {
    var at = src.indexOf(startAnchor);
    assert.ok(at > -1, 'start anchor present: ' + startAnchor.slice(0, 70));
    assert.strictEqual(src.indexOf(startAnchor, at + 1), -1, 'start anchor unique: ' + startAnchor.slice(0, 70));
    var end = src.indexOf(endAnchor, at);
    assert.ok(end > at, 'end anchor after the start: ' + endAnchor.slice(0, 70));
    return src.slice(at, end);
}

var PUBLIC = '/b768/public';
var MIME   = { css: 'text/css', js: 'application/javascript', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', ico: 'image/x-icon' };

/**
 * A resolver shaped like getAssetFilenameFromUrl() on a path WITHOUT the webroot:
 * a URL under a known public directory resolves under `root`, anything else (a
 * webroot-prefixed URL included) is '404.html'; a file named `missing` never exists.
 * @inner
 */
function resolverOn(root) {
    return function (conf, url) {
        if ( /missing/.test(url) ) { return '404.html'; }
        return /^\/(img|css|js)\//.test(url) ? root + url : '404.html';
    };
}

/** A stub `fs` serving the given CSS files by their resolved path. @inner */
function cssFs(files) {
    return {
        readFileSync: function (f) {
            if ( Object.prototype.hasOwnProperty.call(files, f) ) { return files[f]; }
            var e = new Error('ENOENT: ' + f); e.code = 'ENOENT'; throw e;
        }
    };
}

var getAssetsBody = null, preloadable = null, buildLinks = null;

/**
 * The real getAssets() bound to a resolver and an `fs`.
 * @inner
 */
function lift(resolver, fsStub) {
    return new Function('fs', 'getAssetFilenameFromUrl', 'isPreloadableLayoutTag', 'return (' + getAssetsBody + ');')(
        fsStub || cssFs({}), resolver || resolverOn(PUBLIC), preloadable);
}

/** A bundle conf; `webroot` optional, as in a conf without one. @inner */
function conf(webroot) {
    var c = { host: 'localhost', encoding: 'utf8', server: { coreConfiguration: { mime: MIME } } };
    if ( webroot ) { c.server.webroot = webroot; }
    return c;
}

/** getAssets()'s map for a layout body (one string per line). @inner */
function scan(lines, opts) {
    opts = opts || {};
    var layout = ['<!DOCTYPE html>', '<html><head>', '<title>t</title>', '</head><body>'].concat(lines, ['</body></html>']).join('\n');
    return JSON.parse(lift(opts.resolver, opts.fs)(opts.conf || conf(), layout, null, opts.data || null));
}

/** The 200 `link` header render-swig builds from that map. @inner */
function header(map) { return buildLinks('', map); }

before(function () {
    var src  = fs.readFileSync(SERVER_SRC, 'utf8');
    var body = between(src, 'var getAssets = function (bundleConf, layoutStr, swig, data) {', '// var getHeaderFromPseudoHeader = function(header) {');
    getAssetsBody = body.slice(body.indexOf('function ('), body.lastIndexOf('}') + 1);
    preloadable = new Function('return (' + braceBlock(src, 'var isPreloadableLayoutTag = function').replace(/^var isPreloadableLayoutTag = /, '') + ');')();
    var swigSrc = fs.readFileSync(RENDER_SWIG_SRC, 'utf8');
    buildLinks = new Function('return (' + braceBlock(swigSrc, 'function buildH2PreloadLinks(h2Links, assets) {') + ');')();
    // getAssets() ends its CSS pass with `assetsInClassFound.count()`, which gina's
    // helpers/prototypes.js defines on Object.prototype at boot — the same descriptor here
    if ( typeof(Object.prototype.count) == 'undefined' ) {
        Object.defineProperty(Object.prototype, 'count', {
            writable: true, enumerable: false, configurable: true,
            value: function () { var i = 0; for (var p in this) { if ( this.hasOwnProperty(p) ) { ++i; } } return i; }
        });
    }
});

after(function () { delete Object.prototype.count; });

var IMG = function (u) { return '<img src="' + u + '" width="1" height="1" alt="">'; };

// ─── 01 — #B768: one entry per tag, wherever the tag sits ───────────────────────

describe('01 - #B768: tags sharing a source line each get their own entry', function () {

    it('01.1 <img> then <script> on one line: the image as=image, the script as=script', function () {
        var map = scan([IMG('/img/a.png') + '<script src="/js/b.js"></script>']);
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image');
        assert.equal(map['/js/b.js'] && map['/js/b.js'].as, 'script');
    });

    it('01.2 a stylesheet <link> then an <img> on one line: both, each with its own `as`', function () {
        var map = scan(['<link rel="stylesheet" href="/css/e.css">' + IMG('/img/f.png')]);
        assert.equal(map['/css/e.css'] && map['/css/e.css'].as, 'style');
        assert.equal(map['/img/f.png'] && map['/img/f.png'].as, 'image');
    });

    it('01.3 an <img> then a stylesheet <link> on one line: both', function () {
        var map = scan([IMG('/img/a.png') + '<link rel="stylesheet" href="/css/b.css">']);
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image');
        assert.equal(map['/css/b.css'] && map['/css/b.css'].as, 'style');
    });

    it('01.4 two <img> on one line: both', function () {
        var map = scan([IMG('/img/a.png') + IMG('/img/b.png')]);
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image');
        assert.equal(map['/img/b.png'] && map['/img/b.png'].as, 'image');
    });

    it('01.5 a minified one-line layout: every tag hinted, in document order', function () {
        var map  = scan([IMG('/img/a.png') + '<link rel="stylesheet" href="/css/e.css">' + IMG('/img/f.png') + '<script src="/js/b.js"></script>']);
        var link = header(map);
        ['</img/a.png>; as=image', '</css/e.css>; as=style', '</img/f.png>; as=image', '</js/b.js>; as=script'].forEach(function (e) {
            assert.ok(link.indexOf(e) > -1, e + ' in ' + link);
        });
        assert.ok(link.indexOf('/img/a.png') < link.indexOf('/css/e.css') && link.indexOf('/css/e.css') < link.indexOf('/js/b.js'), 'document order: ' + link);
    });

    it('01.6 a one-line <picture>: its <img> carries the <source> srcset; the next image carries none', function () {
        var map = scan(['<picture><source type="image/webp" srcset="/img/c.webp">' + IMG('/img/c.png') + '</picture>', IMG('/img/d.png')]);
        assert.equal(map['/img/c.png'] && map['/img/c.png'].as, 'image');
        assert.equal(map['/img/c.png'].imagesrcset, '/img/c.webp');
        assert.equal(map['/img/d.png'] && map['/img/d.png'].imagesrcset, undefined);
    });

    it('01.7 a one-line <picture>, then a script: the srcset stays with the picture\'s image, never the script', function () {
        var map = scan(['<picture><source type="image/webp" srcset="/img/c.webp">' + IMG('/img/c.png') + '</picture>', '<script src="/js/b.js"></script>']);
        assert.equal(map['/img/c.png'] && map['/img/c.png'].imagesrcset, '/img/c.webp');
        assert.equal(map['/js/b.js'] && map['/js/b.js'].imagesrcset, undefined);
    });

    it('01.8 a <picture> whose <img> is skipped (data: URI): its srcset dies with the </picture>', function () {
        var map = scan(['<picture>', '<source type="image/webp" srcset="/img/c.webp">', '<img src="data:image/png;base64,AAAA" alt="">', '</picture>', IMG('/img/d.png')]);
        assert.equal(map['/img/d.png'] && map['/img/d.png'].imagesrcset, undefined);
    });

    it('01.9 the link filters still apply per tag: rel="alternate stylesheet" and an icon on one line enter no entry', function () {
        var map = scan(['<link rel="alternate stylesheet" href="/css/alt.css" title="alt"><link rel="apple-touch-icon" href="/img/t.png">']);
        assert.equal(map['/css/alt.css'], undefined, 'a rel must start with stylesheet');
        assert.equal(map['/img/t.png'], undefined, 'icons are never hinted');
    });

    it('01.10 a start tag spread over several lines is read as one tag', function () {
        var map = scan(['<img', '    src="/img/m.png"', '    alt="">']);
        assert.equal(map['/img/m.png'] && map['/img/m.png'].as, 'image');
    });

    it('01.11 the text of an inline script is not markup: a quoted <img> in it gets no entry', function () {
        var map = scan(['<script>var s = \'<img src="/img/x.png">\';</script>', IMG('/img/a.png')]);
        assert.equal(map['/img/x.png'], undefined);
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image', 'control: the real image after it');
    });

    it('01.12 controls: a `>` inside a quoted value does not end the tag; tags on their own lines are unchanged', function () {
        var map = scan(['<img alt="a > b" src="/img/q.png">', IMG('/img/a.png'), '<script src="/js/b.js"></script>', '<link rel="stylesheet" href="/css/e.css" media="print">']);
        assert.equal(map['/img/q.png'] && map['/img/q.png'].as, 'image');
        assert.equal(map['/img/a.png'].as, 'image');
        assert.equal(map['/js/b.js'].as, 'script');
        assert.equal(map['/css/e.css'] && map['/css/e.css'].as, null, 'a print stylesheet keeps no `as`');
    });
});

// ─── 02 — #B775: no state carried from one tag to the next ──────────────────────

describe('02 - #B775: a tag with no src / href makes no entry and touches no other', function () {

    it('02.1 an <img srcset> with no src as the FIRST asset: no throw (the page answered 500), no entry for it', function () {
        var map;
        assert.doesNotThrow(function () { map = scan(['<img srcset="/img/s.png 1x" alt="">', IMG('/img/d.png')]); });
        assert.equal(map['/img/s.png'], undefined);
        assert.equal(map['/img/d.png'] && map['/img/d.png'].as, 'image');
        assert.equal(map['/img/d.png'].imagesrcset, undefined, 'its srcset does not ride the next image');
    });

    it('02.2 the same tag after another <img>: the earlier entry keeps its own URL and no foreign srcset', function () {
        var map = scan([IMG('/img/a.png'), '<img srcset="/img/s.png 1x" alt="">']);
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image');
        assert.equal(map['/img/a.png'].imagesrcset, undefined);
    });

    it('02.3 a missing asset after a found one keeps no extension or MIME type of its own predecessor', function () {
        var map = scan([IMG('/img/a.png'), IMG('/img/missing.jpg')]);
        assert.equal(map['/img/missing.jpg'].isAvailable, false);
        assert.equal(map['/img/missing.jpg'].ext, null);
        assert.equal(map['/img/missing.jpg'].mime, 'NA');
    });
});

// ─── 03 — #B774: the CSS url() scan never throws ────────────────────────────────

describe('03 - #B774: a layout stylesheet whose CSS the url() scan cannot read is skipped, not thrown on', function () {
    var CSS_LINK = '<link rel="stylesheet" href="/css/s.css">';

    function withCss(css) {
        var files = {}; files[PUBLIC + '/css/s.css'] = css;
        return scan([CSS_LINK, '<div class="x"></div>'], { fs: cssFs(files) });
    }

    it('03.1 an unquoted url(#id), an SVG reference: no throw, the stylesheet keeps its entry', function () {
        var map;
        assert.doesNotThrow(function () { map = withCss('.x { fill: url(#grad); }\n'); });
        assert.equal(map['/css/s.css'] && map['/css/s.css'].as, 'style');
    });

    it('03.2 a url() whose path has no dot: no throw', function () {
        assert.doesNotThrow(function () { withCss('.x { background: url(/img/sprite); }\n'); });
    });

    it('03.3 a quoted url("#id"): no throw', function () {
        assert.doesNotThrow(function () { withCss('.x { fill: url("#grad"); }\n'); });
    });

    it('03.4 control: a url() naming a real file still enters the map, as a CSS asset (no `as`, never hinted)', function () {
        var map = withCss('.x { background: url(/img/bg.png); }\n');
        assert.ok(map['/img/bg.png'], 'the CSS asset is in the map');
        assert.equal(map['/img/bg.png'].as, undefined);
        assert.equal(map['/img/bg.png'].referrer, PUBLIC + '/css/s.css');
    });
});

// ─── 04 — #B776: a layout entry is never replaced by a CSS one ──────────────────

describe('04 - #B776: a CSS url() naming a layout image does not take that image\'s entry', function () {

    it('04.1 the layout <img> keeps as=image and stays in the header', function () {
        var files = {}; files[PUBLIC + '/css/s.css'] = '.x { background: url(/img/a.png); }\n';
        var map = scan(['<link rel="stylesheet" href="/css/s.css">', '<div class="x"></div>', IMG('/img/a.png')], { fs: cssFs(files) });
        assert.equal(map['/img/a.png'] && map['/img/a.png'].as, 'image');
        assert.ok(header(map).indexOf('</img/a.png>; as=image') > -1, header(map));
    });
});
