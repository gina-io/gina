'use strict';
/**
 * `getAssets()` in core/server.js scans a page's layout for the images, stylesheets
 * and scripts written in it. Its map feeds the `link` header of an `http/2.0`
 * page's 200 (preload hints) and the Inspector's view of the page's assets. Fixed
 * in one arc:
 *   #B774  the CSS `url()` scan read `.match(...)[0]` unguarded: an unquoted
 *          `url(#id)` or a `url()` with no dot in its path threw, and the page
 *          answered 500.
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
