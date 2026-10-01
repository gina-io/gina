/**
 * #P48 — versioned asset URLs: the source pins the live test cannot reach, and the
 * client-side dedup driven on the EXTRACTED shipped bytes under jsdom.
 *
 * The behaviour a real bundle shows (tags carry `?v=<10 hex>`, statics answer
 * `immutable` to the current token and `no-cache` to any other, the routing table
 * the same) is driven by test/integration/container-boot-asset-versioning.test.js.
 * This file locks what that live test cannot see.
 *
 * WHAT IT PINS / DRIVES
 *  §01 controller.js — setResources() decides versioning (the view flag `!== false`,
 *      a truthy layoutless test, not cacheless) and passes it to both getNodeRes()
 *      calls; getNodeRes() versions each URL after the webroot rewrite and before its
 *      SRI lookup and preload hint (a js `isExternalPlugin` tag excepted: render-swig
 *      splices it into the layout it compiles), keeps the jQuery warn on the plain
 *      URL, and renders `data-gina-routing-v` (10 hex only, the request's variant) on
 *      gina's own tag, before the SRI attributes; computeH2PreloadPrefix() applies the
 *      same rule after its SRI skip, so a 103 hint names the URL its tag fetches.
 *  §02 the framework baseline templates.json turns versioning on in `_common`.
 *  §03 server.js — the per-variant routing tokens (built beside the ETags, copied
 *      to the engine options before the engine is created) and
 *      `instance._routingVersion` in start().
 *  §04 the routing-table handlers on BOTH engines: the path is tested without its
 *      query; `immutable` is an OVERRIDE after the pinned `no-cache`, granted only to
 *      the token of the variant served; isaac (#B707) looks the file up lower-cased
 *      and falls through on a miss.
 *  §05 handleStatics — only a 10-hex `v` is a gina token, read inside the production
 *      gate and compared with the SOURCE file's token; the HTTP/2 304 carries the
 *      matched Cache-Control while the HTTP/1.x 304 stays bare; both 200s; the
 *      precompressed-sibling guard, in whole seconds (a compressor that keeps its
 *      source's timestamp truncates it — the live test drives the three mtime states).
 *  §06 client — core.js reads the routing token strictly (driven under jsdom);
 *      utils/dom.js bindRegion and the popin key scripts and styles without the token
 *      (one strip literal, five sites).
 *  §07 bindRegion under jsdom: a versioned page tag and a plain fragment tag (either
 *      way round, two tokens, beside another parameter) name the same script; an
 *      author's own `v=2` or an 11-hex value stays significant; the strip table.
 *
 * Red-first: `GINA_P48_FW=<a tree holding the pre-change files at the framework's
 * relative paths>` runs every pin and arm against those bytes (jsdoc.md § "A module-path
 * SEAM"); the arms named CONTROL are expected green on both.
 *
 * Usage: node --test test/core/asset-versioning.test.js
 */
'use strict';
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var { JSDOM } = require('jsdom');

// Module-path seam: every source is read under FW, so one variable points the whole
// file (pins and extracted arms) at pre-change copies.
var FW = process.env.GINA_P48_FW || require('../fw');

function read(rel) {
    return fs.readFileSync(path.join(FW, rel), 'utf8');
}

var CONTROLLER = read('core/controller/controller.js');
var SERVER     = read('core/server.js');
var ISAAC      = read('core/server.isaac.js');
var TEMPLATES  = read('core/template/conf/templates.json');
var CORE_JS    = read('core/asset/plugin/src/vendor/gina/core.js');
var DOM_JS     = read('core/asset/plugin/src/vendor/gina/utils/dom.js');
var POPIN_JS   = read('core/asset/plugin/src/vendor/gina/popin/main.js');

// The one strip expression shared by utils/dom.js and the popin's four sites.
var STRIP = String.raw`.replace(/([?&])v=[0-9a-f]{10}(&|(?=#)|$)/, function (m, sep, next) { return ( next === '&' ) ? sep : ''; })`;

/** Collapse every whitespace run to one space (indentation and wraps are not the contract). */
function norm(s) {
    return s.replace(/\s+/g, ' ');
}

/** Block comments and whole-line `//` comments removed (the region-binding helper). */
function active(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(function (l) {
        return !/^\s*\/\//.test(l);
    }).join('\n');
}

/** The normalised active code between two anchors, each asserted present once. */
function region(src, start, end, label) {
    var a = src.indexOf(start);
    assert.ok(a > -1, label + ': the start anchor is present');
    assert.equal(src.indexOf(start, a + 1), -1, label + ': the start anchor is unique');
    var b = src.indexOf(end, a + start.length);
    assert.ok(b > a, label + ': the end anchor follows the start');
    return norm(active(src.slice(a, b)));
}

/** Index of a normalised needle in a normalised text (-1 when absent). */
function at(text, needle) {
    return text.indexOf(norm(needle));
}

function count(text, needle) {
    var n = norm(needle), c = 0, i = -1;
    while ( (i = text.indexOf(n, i + 1)) > -1 ) { c++; }
    return c;
}

/** Extract `<decl> … { … }` by a started-flag brace walk from its unique declaration. */
function extractBlock(src, decl, label) {
    var start = src.indexOf(decl);
    assert.ok(start > -1, label + ': the declaration is present (extraction control)');
    assert.equal(src.indexOf(decl, start + 1), -1, label + ': the declaration is unique');
    var i = start, depth = 0, started = false;
    for (; i < src.length; i++) {
        var ch = src[i];
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    assert.equal(depth, 0, label + ': balanced braces');
    return src.slice(start, i);
}

// ─── §01 controller.js ───────────────────────────────────────────────────────

var SET_RESOURCES = function () { return region(CONTROLLER, 'var setResources = function(viewConf) {', 'var getNodeRes = function(', 'setResources'); };
var GET_NODE_RES  = function () { return region(CONTROLLER, 'var getNodeRes = function(', 'var computeH2PreloadPrefix = function(', 'getNodeRes'); };
var CSS_CASE      = function () { return region(CONTROLLER, "case 'css':", "case 'js':", 'getNodeRes css case'); };
var JS_CASE       = function () { return region(CONTROLLER, "case 'js':", 'var computeH2PreloadPrefix = function(', 'getNodeRes js case'); };
var H2_PREFIX     = function () { return region(CONTROLLER, 'var computeH2PreloadPrefix = function(', 'var isValidURL = function(url){', 'computeH2PreloadPrefix'); };

var VERSION_OBJ_URL = String.raw`obj.url = lib.sri.getVersionedUrl(obj.url, local.options.conf, local.options.conf.server.webroot);`;
var WEBROOT_REWRITE = String.raw`obj.url = local.options.conf.server.webroot + obj.url.substring(1);`;
var SRI_OBJ_URL     = String.raw`var sriAttributes = (sriEnabled) ? lib.sri.getIntegrityAttributes(obj.url, local.options.conf, local.options.conf.server.webroot) : '';`;

describe('§01 controller.js — the URLs a render emits', function () {

    it('01.1 setResources decides versioning: the flag `!== false`, a truthy layoutless test, not cacheless', function () {
        assert.ok(at(SET_RESOURCES(), String.raw`var _versioned = ( viewConf.assetVersioningEnabled !== false && !( local.options && local.options.isWithoutLayout ) && !self.isCacheless() ) ? true : false;`) > -1);
    });

    it('01.2 both getNodeRes calls pass the decision as the fifth argument', function () {
        var t = SET_RESOURCES();
        assert.equal(count(t, String.raw`cssStr = getNodeRes('css', cssColl, useWebroot, _webroot, _versioned);`), 1, 'the css call');
        assert.equal(count(t, String.raw`jsStr = getNodeRes('js', jsColl, useWebroot, _webroot, _versioned);`), 1, 'the js call');
        assert.ok(at(t, 'var _versioned =') < at(t, "getNodeRes('css'"), 'decided before the first call');
    });

    it('01.3 getNodeRes takes the decision as `isVersioned`', function () {
        assert.ok(at(GET_NODE_RES(), 'var getNodeRes = function(type, resArr, useWebroot, webrootStr, isVersioned) {') === 0);
    });

    it('01.4 css: the URL is versioned after the webroot rewrite and before the SRI lookup and the preload hint', function () {
        var t = CSS_CASE();
        var v = at(t, 'if ( isVersioned ) { ' + VERSION_OBJ_URL + ' }');
        assert.ok(v > -1, 'the versioning statement');
        assert.ok(at(t, WEBROOT_REWRITE) > -1 && at(t, WEBROOT_REWRITE) < v, 'after the webroot rewrite');
        assert.ok(v < at(t, SRI_OBJ_URL), 'before the SRI lookup');
        assert.ok(v < at(t, String.raw`local.options.template.h2Links += '<'+ obj.url +'>; as=style; rel=preload,'`), 'before the preload hint');
    });

    it('01.5 js: versioned unless `isExternalPlugin`, the plain URL kept first', function () {
        var t = JS_CASE();
        var v = at(t, 'var _plainUrl = obj.url; if ( isVersioned && !obj.isExternalPlugin ) { ' + VERSION_OBJ_URL + ' }');
        assert.ok(v > -1, 'the versioning statement, external plugins excepted');
        assert.ok(at(t, WEBROOT_REWRITE) > -1 && at(t, WEBROOT_REWRITE) < v, 'after the webroot rewrite');
        assert.ok(v < at(t, SRI_OBJ_URL), 'before the SRI lookup');
        assert.ok(v < at(t, String.raw`local.options.template.h2Links += '<'+ obj.url +'>; as=script; rel=preload,'`), 'before the preload hint');
    });

    it('01.6 js: the jQuery-plugin warn tests the plain URL', function () {
        assert.ok(at(JS_CASE(), String.raw`if ( /\/jquery\.(.*)\.(min\.js|js)$/i.test(_plainUrl) ) {`) > -1);
    });

    it('01.7 js: gina\'s own tag carries `data-gina-routing-v`, before the SRI attributes', function () {
        assert.ok(at(JS_CASE(), String.raw`str += '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"'+ ( ( routingVersion && obj.name == 'gina' ) ? ' data-gina-routing-v="'+ routingVersion +'"' : '' ) + sriAttributes +'></script>';`) > -1);
    });

    it('01.8 the routing token is the request\'s variant, and only ever 10 hex', function () {
        var t = GET_NODE_RES();
        var r = at(t, String.raw`var routingVersion = null; if ( isVersioned && self.serverInstance && self.serverInstance._routingVersion ) { routingVersion = self.serverInstance._routingVersion[ ( isProxyHost === true ) ? 'stripped' : 'full' ]; if ( !/^[0-9a-f]{10}$/.test(routingVersion || '') ) { routingVersion = null; } }`);
        assert.ok(r > -1, 'the block');
        assert.ok(at(t, ', isProxyHost =') > -1 && at(t, ', isProxyHost =') < r, 'after isProxyHost is assigned');
        assert.ok(r < at(t, 'switch(type){'), 'before the tags are built');
    });

    it('01.9 CONTROL — the external-plugin splice is unchanged (its URL is the plain one)', function () {
        assert.ok(at(JS_CASE(), String.raw`local.options.template.externalPlugins.splice(1, 0, '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"'+ sriAttributes +'></script>');`) > -1);
    });

    it('01.10 computeH2PreloadPrefix decides with setResources\' rule, read off local.options', function () {
        assert.ok(at(H2_PREFIX(), String.raw`var isVersioned = ( local.options.template && local.options.template.assetVersioningEnabled !== false && !local.options.isWithoutLayout && !self.isCacheless() ) ? true : false;`) > -1);
    });

    it('01.11 computeH2PreloadPrefix versions after the SRI skip and before the hint is written', function () {
        var t = H2_PREFIX();
        var skip = at(t, String.raw`if ( sriEnabled && lib.sri.getIntegrityAttributes(url, local.options.conf, _webroot) ) { continue; }`);
        var v    = at(t, String.raw`if ( isVersioned && !( as == 'script' && obj.isExternalPlugin ) ) { url = lib.sri.getVersionedUrl(url, local.options.conf, _webroot); }`);
        var hint = at(t, String.raw`links += '<'+ url +'>; as='+ as +'; rel=preload,';`);
        assert.ok(skip > -1 && hint > -1, 'anchors');
        assert.ok(v > skip && v < hint, 'skip < version < hint');
    });
});

// ─── §02 the baseline templates.json ─────────────────────────────────────────

/** JSON with `//` and block comments, strings respected. */
function parseCommentedJSON(text) {
    var out = '', i = 0, inStr = false;
    while (i < text.length) {
        var ch = text[i], nx = text[i + 1];
        if (inStr) {
            out += ch;
            if (ch === '\\') { out += nx; i += 2; continue; }
            if (ch === '"') { inStr = false; }
            i++;
            continue;
        }
        if (ch === '"') { inStr = true; out += ch; i++; continue; }
        if (ch === '/' && nx === '/') { while (i < text.length && text[i] !== '\n') { i++; } continue; }
        if (ch === '/' && nx === '*') { i = text.indexOf('*/', i + 2) + 2; continue; }
        out += ch;
        i++;
    }
    return JSON.parse(out);
}

describe('§02 the framework baseline templates.json', function () {

    it('02.1 `_common.assetVersioningEnabled` is true (versioning is on by default)', function () {
        var conf = parseCommentedJSON(TEMPLATES);
        assert.equal(conf._common.assetVersioningEnabled, true);
    });

    it('02.2 CONTROL — the baseline parses and keeps `sriEnabled: false` (the parser reads the real file)', function () {
        var conf = parseCommentedJSON(TEMPLATES);
        assert.equal(conf._common.sriEnabled, false);
        assert.ok(Array.isArray(conf._common.javascripts) && conf._common.javascripts.some(function (j) { return j.name === 'gina'; }), 'gina\'s own script entry');
    });
});

// ─── §03 server.js — the routing tokens ──────────────────────────────────────

var BOOT  = function () { return region(SERVER, 'self._clientRoutingAssets.strippedEtag =', 'var engine = new Engine(serverOpt);', 'server.js boot'); };
var START = function () { return region(SERVER, "if ( typeof(instance._cacheName) == 'undefined' ) {", '// #MS5 — per-authority query circuit-breaker policy', 'server.js start()'); };

describe('§03 server.js — the per-variant routing tokens', function () {

    it('03.1 each variant\'s token is the head of the sha1 its ETag uses, built before the engine', function () {
        var t = BOOT();
        assert.ok(at(t, String.raw`self._clientRoutingAssets.fullVersion = crypto.createHash('sha1').update(self._clientRoutingAssets.full).digest('hex').substring(0, 10);`) > -1, 'full');
        assert.ok(at(t, String.raw`self._clientRoutingAssets.strippedVersion = crypto.createHash('sha1').update(self._clientRoutingAssets.stripped).digest('hex').substring(0, 10);`) > -1, 'stripped');
    });

    it('03.2 both tokens reach the engine options (isaac reads them there)', function () {
        var t = BOOT();
        assert.ok(at(t, 'serverOpt.clientRoutingAssets.fullVersion = self._clientRoutingAssets.fullVersion;') > -1, 'full');
        assert.ok(at(t, 'serverOpt.clientRoutingAssets.strippedVersion = self._clientRoutingAssets.strippedVersion;') > -1, 'stripped');
    });

    it('03.3 start() stamps `instance._routingVersion` for the controller, guarded', function () {
        assert.ok(at(START(), String.raw`if ( typeof(instance._routingVersion) == 'undefined' && self._clientRoutingAssets ) { instance._routingVersion = { full : self._clientRoutingAssets.fullVersion, stripped : self._clientRoutingAssets.strippedVersion }; }`) > -1);
    });
});

// ─── §04 the routing-table handlers, both engines ────────────────────────────

var ROUTING_SERVER = function () { return region(SERVER, '// ── /_gina/assets/routing.json — client routing map', '// ── /_gina/metrics — Prometheus exposition', 'server.js routing handler'); };
var ROUTING_ISAAC  = function () { return region(ISAAC, 'request._ginaProxyPrefix = _xfp;', "var filename  =  _(localAsset.path +'/'+ localAsset.file, true);", 'isaac routing fast path'); };

describe('§04 the routing-table handlers (the /_gina/* sync rule)', function () {

    it('04.1 server.js tests the path without its query', function () {
        var t = ROUTING_SERVER();
        assert.ok(at(t, String.raw`&& /\/_gina\/assets\/routing\.json$/i.test(request.url.split('?')[0])`) > -1, 'the query-free test');
        assert.equal(at(t, String.raw`routing\.json$/i.test(request.url)`), -1, 'the query-bearing test is gone');
    });

    it('04.2 server.js grants `immutable` only to the served variant\'s token, as an override after the pinned `no-cache`', function () {
        var t = ROUTING_SERVER();
        var noCache  = at(t, String.raw`response.setHeader('cache-control', ( _croutProxied === true ) ? 'private, no-cache' : 'public, no-cache');`);
        var token    = at(t, 'var _croutVersion = lib.sri.getRequestedVersion(request.originalUrl || request.url);');
        var check    = at(t, String.raw`_croutVersion && _croutVersion === ( ( _croutProxied === true ) ? self._clientRoutingAssets.strippedVersion : self._clientRoutingAssets.fullVersion )`);
        var override = at(t, String.raw`response.setHeader('cache-control', ( ( _croutProxied === true ) ? 'private' : 'public' ) + ', max-age=31536000, immutable');`);
        var etag     = at(t, "response.setHeader('etag', _croutEtag);");
        assert.ok(noCache > -1 && etag > -1, 'anchors');
        assert.ok(token > noCache && check > token && override > check && override < etag, 'no-cache < token < check < override < etag (so the 304 carries it too)');
    });

    it('04.3 isaac (#B707): the query-free path, a lower-cased lookup, and a miss falls through', function () {
        var t = ROUTING_ISAAC();
        assert.ok(at(t, String.raw`var _routingPath = ( request.method.toUpperCase() === 'GET' ) ? request.url.split('?')[0] : null;`) > -1, 'the path');
        assert.ok(at(t, String.raw`localAsset = ( _routingPath && /\_gina\/assets\/routing\.json$/i.test(_routingPath) ) ? assetsCollection.findOne({ file: _routingPath.split(/\//g).slice(-1).toString().toLowerCase() }) : null; if ( localAsset ) {`) > -1, 'the lookup, gated on its result');
        assert.equal(at(t, 'assetsCollection.findOne({ file: request.url.split('), -1, 'the case-sensitive, query-bearing lookup is gone');
    });

    it('04.4 isaac grants `immutable` only to the token of the file it serves, after the pinned `no-cache`', function () {
        var t = ROUTING_ISAAC();
        var stripped = at(t, 'localAsset = _strippedRoutingAsset;');
        var noCache  = at(t, String.raw`response.setHeader('cache-control', ( request._ginaIsProxyHost === true ) ? 'private, no-cache' : 'public, no-cache');`);
        var version  = at(t, String.raw`var _routingAssetVersion = ( options.clientRoutingAssets ) ? ( ( localAsset.file === 'routing.stripped.json' ) ? options.clientRoutingAssets.strippedVersion : options.clientRoutingAssets.fullVersion ) : null;`);
        var check    = at(t, String.raw`_routingAssetVersion && lib.sri.getRequestedVersion(request.originalUrl || request.url) === _routingAssetVersion`);
        var override = at(t, String.raw`response.setHeader('cache-control', ( ( request._ginaIsProxyHost === true ) ? 'private' : 'public' ) + ', max-age=31536000, immutable');`);
        assert.ok(stripped > -1 && noCache > -1, 'anchors');
        assert.ok(version > stripped, 'the token is taken after the stripped variant is chosen (the served file)');
        assert.ok(version > noCache && check > version && override > check, 'no-cache < token < check < override');
    });
});

// ─── §05 handleStatics ───────────────────────────────────────────────────────

var STATICS = function () { return region(SERVER, 'var handleStatics = function(staticProps, request, response, next) {', 'var onRequest = function() {', 'handleStatics'); };
var STATICS_304 = function () { return region(SERVER, '// 304 Not Modified — only in production', 'isBinary    = true;', 'handleStatics 304 block'); };

describe('§05 handleStatics — the content token', function () {

    it('05.1 the two new locals follow `acceptEncoding` in the var block', function () {
        assert.ok(at(STATICS(), ', acceptEncoding = null , versionRequested = null , versionMatched = false ;') > -1);
    });

    it('05.2 inside the production gate: only a 10-hex `v` is a token, compared with the SOURCE file\'s, before the conditional-GET read', function () {
        assert.ok(at(STATICS_304(), String.raw`if (!isCacheless) { versionRequested = lib.sri.getRequestedVersion(request.originalUrl || request.url); if ( versionRequested !== null && !/^[0-9a-f]{10}$/.test(versionRequested) ) { versionRequested = null; } versionMatched = ( versionRequested !== null && versionRequested === lib.sri.computeVersion(filename) ) ? true : false; var ifNoneMatch = request.headers['if-none-match'];`) > -1);
    });

    it('05.3 the token is read nowhere else in handleStatics (dev never computes one)', function () {
        var all = STATICS(), prod = STATICS_304();
        assert.equal(count(all, 'lib.sri.'), 2, 'two lib/sri calls in handleStatics');
        assert.equal(count(prod, 'lib.sri.'), 2, 'both inside the production 304 block');
    });

    it('05.4 the HTTP/2 304 carries the matched Cache-Control; the other 304s stay bare', function () {
        assert.ok(at(STATICS_304(), String.raw`if ( /http\/2/.test(protocol) && versionMatched ) { stream.respond({ ':status': 304, 'cache-control': 'public, max-age=31536000, immutable' }); stream.end(); } else if ( /http\/2/.test(protocol) ) { stream.respond({ ':status': 304 }); stream.end(); } else { response.writeHead(304); response.end(); }`) > -1);
    });

    it('05.5 the HTTP/2 200 sets it in the header object before completeHeaders()', function () {
        assert.ok(at(STATICS(), String.raw`header['etag'] = etag; if ( versionRequested !== null ) { header['cache-control'] = ( versionMatched ) ? 'public, max-age=31536000, immutable' : 'no-cache'; } } header = completeHeaders(header, request, response);`) > -1);
    });

    it('05.6 HTTP/1.x: a precompressed sibling older than its source, in whole seconds, is never served `immutable`', function () {
        assert.ok(at(STATICS(), String.raw`filename += acceptEncoding; response.setHeader('content-encoding', acceptEncoding.replace(/^\./, '')); var siblingStat = fs.statSync(filename); response.setHeader('content-length', siblingStat.size); if ( versionMatched && Math.floor(siblingStat.mtimeMs / 1000) < Math.floor(stat.mtimeMs / 1000) ) { versionMatched = false; }`) > -1);
    });

    it('05.7 the HTTP/1.x 200 sets it before writeHead, beside the pinned validators', function () {
        assert.ok(at(STATICS(), String.raw`if ( versionRequested !== null ) { response.setHeader('cache-control', ( versionMatched ) ? 'public, max-age=31536000, immutable' : 'no-cache'); } response.writeHead(200, { 'last-modified': lastModified, 'etag': etag });`) > -1);
    });

    it('05.8 CONTROL — the dev 200 still answers `no-store`', function () {
        assert.ok(at(STATICS(), String.raw`header['cache-control'] = 'no-cache, no-store, must-revalidate';`) > -1);
    });
});

// ─── §06 client sources ──────────────────────────────────────────────────────

var ROUTING_V_DECL = 'var _routingV = null;';

/** A jsdom window whose <head> holds `headHtml`. */
function makeDocWindow(headHtml, bodyHtml) {
    var dom = new JSDOM('<!DOCTYPE html><html><head>' + (headHtml || '') + '</head><body>' + (bodyHtml || '') + '</body></html>', { url: 'http://localhost/page', runScripts: 'outside-only' });
    return dom.window;
}

/** core.js's routing-token read, extracted and run in a window's realm. */
function readRoutingToken(w) {
    var a = CORE_JS.indexOf(ROUTING_V_DECL);
    assert.ok(a > -1, 'the routing-token read is present (extraction control)');
    var b = CORE_JS.indexOf('var arr = [', a);
    assert.ok(b > a, 'the fetch list follows it');
    return new w.Function(CORE_JS.slice(a, b) + '\nreturn _routingV;')();
}

describe('§06 client — the routing token and the dedup keys', function () {

    it('06.1 core.js appends the token as a separate operand after the routing path', function () {
        var t = norm(active(CORE_JS));
        assert.ok(at(t, String.raw`args: [ 'routing', {url: _webroot + '_gina/assets/routing.json' + ( _routingV ? '?v=' + _routingV : '' )} ]`) > -1);
        assert.ok(at(t, ROUTING_V_DECL) > at(t, "var _webroot = (typeof window !== 'undefined' && window.__ginaWebroot)"), 'read after the webroot');
    });

    it('06.2 core.js takes exactly 10 hex off gina\'s tag, anything else is no token', function () {
        var cases = [
            [ '<script src="/js/vendor/gina/gina.min.js" data-gina-routing-v="0a1b2c3d4e"></script>', '0a1b2c3d4e' ],
            [ '<script src="/js/vendor/gina/gina.min.js" data-gina-routing-v="0a1b2c3d4e5"></script>', null ],
            [ '<script src="/js/vendor/gina/gina.min.js" data-gina-routing-v="0A1B2C3D4E"></script>', null ],
            [ '<script src="/js/vendor/gina/gina.min.js" data-gina-routing-v="{{ page.environment.routingVersion }}"></script>', null ],
            [ '<script src="/js/vendor/gina/gina.min.js" data-gina-routing-v=""></script>', null ],
            [ '<script src="/js/vendor/gina/gina.min.js"></script>', null ]
        ];
        cases.forEach(function (c) {
            assert.equal(readRoutingToken(makeDocWindow(c[0])), c[1], c[0]);
        });
    });

    it('06.3 utils/dom.js bindRegion keys the known scripts and each candidate without the token', function () {
        var fn = norm(extractBlock(DOM_JS, 'function bindRegion($root, options) {', 'bindRegion'));
        assert.ok(at(fn, 'var assetKey = function (u) { return ( typeof(u) == \'string\' ) ? u' + STRIP + ' : u; };') > -1, 'the local helper');
        assert.equal(count(fn, 'known.push(assetKey(docScripts[i].src));'), 1, 'the document side');
        assert.equal(count(fn, 'if ( !src || known.indexOf(assetKey(src)) > -1 ) continue;'), 1, 'the candidate compare');
        assert.equal(count(fn, 'known.push(assetKey(src));'), 1, 'an injected script');
        assert.ok(at(fn, 'var assetKey = function') < at(fn, 'known.push(assetKey('), 'defined before its first use');
    });

    it('06.4 the popin keys its four filename sites without the token (the same expression)', function () {
        var t = norm(POPIN_JS);
        assert.equal(count(t, STRIP), 4, 'four sites');
        [ 'scripts[i].src', 'styles[i].href', 'mainDocumentScripts[s].src', 'mainDocumentStyles[s].href' ].forEach(function (s) {
            assert.ok(at(t, 'let filename = ' + s + String.raw` .replace(/(https|http|)\:\/\//, '') .replace(reDomain, '') ` + STRIP + ';') > -1, s);
        });
    });

    it('06.5 CONTROL — the popin still loads the URL as written (the stripped name is only a key)', function () {
        var t = norm(POPIN_JS);
        assert.ok(at(t, 'getScript(scripts[i].src, $popin);') > -1, 'scripts');
        assert.ok(at(t, 'getStyle(styles[i].href, $popin);') > -1, 'styles');
    });
});

// ─── §07 bindRegion under jsdom ──────────────────────────────────────────────

/** A window whose page carries `pageSrc` and whose region #r carries `fragSrc`; bindRegion evaluated inside. */
function makeRegionWindow(pageSrc, fragSrc) {
    var w = makeDocWindow('<script src="' + pageSrc + '"></script>', '<div id="r"><script src="' + fragSrc + '"></script></div>');
    w.gina = null;
    w.eval('window.__bindRegion = (function(){ ' + extractBlock(DOM_JS, 'function bindRegion($root, options) {', 'bindRegion') + ' return bindRegion; }());');
    return w;
}

function created(pageSrc, fragSrc) {
    var w = makeRegionWindow(pageSrc, fragSrc);
    var out = w.__bindRegion(w.document.getElementById('r'), { forms: false, links: false });
    return { n: out.scripts, head: Array.prototype.map.call(w.document.head.querySelectorAll('script'), function (s) { return s.src; }) };
}

/** The helper itself, extracted from bindRegion's text. */
function assetKey() {
    var fn = extractBlock(DOM_JS, 'function bindRegion($root, options) {', 'bindRegion');
    var decl = extractBlock(fn, 'var assetKey = function (u) {', 'assetKey');
    return new Function('return (' + decl.replace(/^var assetKey = /, '') + ');')();
}

describe('§07 bindRegion (utils/dom) — the extracted shipped bytes under jsdom', function () {

    it('07.1 CONTROL — a fragment script the page does not carry is re-created once', function () {
        assert.equal(created('/js/page.js', '/js/app.js').n, 1);
    });

    it('07.2 a versioned page tag and a plain fragment tag name the same script', function () {
        assert.equal(created('/js/app.js?v=0a1b2c3d4e', '/js/app.js').n, 0);
    });

    it('07.3 the other way round: a plain page tag and a versioned fragment tag', function () {
        assert.equal(created('/js/app.js', '/js/app.js?v=0a1b2c3d4e').n, 0);
    });

    it('07.4 two tokens for the same file name the same script', function () {
        assert.equal(created('/js/app.js?v=0a1b2c3d4e', '/js/app.js?v=9f8e7d6c5b').n, 0);
    });

    it('07.5 the token beside another parameter', function () {
        assert.equal(created('/js/app.js?lang=fr&v=0a1b2c3d4e', '/js/app.js?lang=fr').n, 0);
    });

    it('07.6 CONTROL — an author\'s own `v=2` stays significant', function () {
        assert.equal(created('/js/app.js?v=2', '/js/app.js').n, 1);
    });

    it('07.7 CONTROL — an 11-hex value is not a gina token', function () {
        assert.equal(created('/js/app.js?v=0a1b2c3d4e5', '/js/app.js').n, 1);
    });

    it('07.8 CONTROL — a re-created script keeps the fragment\'s own URL (the key is not the URL)', function () {
        var r = created('/js/page.js', '/js/app.js?v=0a1b2c3d4e');
        assert.equal(r.n, 1);
        assert.ok(r.head.indexOf('http://localhost/js/app.js?v=0a1b2c3d4e') > -1, r.head.join(', '));
    });

    it('07.9 the strip table: exactly one gina token removed, everything else untouched', function () {
        var key = assetKey();
        var table = [
            [ '/js/a.js?v=0123456789', '/js/a.js' ],
            [ '/js/a.js?v=0123456789&x=1', '/js/a.js?x=1' ],
            [ '/js/a.js?x=1&v=0123456789', '/js/a.js?x=1' ],
            [ '/js/a.js?x=1&v=0123456789&y=2', '/js/a.js?x=1&y=2' ],
            [ '/js/a.js?v=0123456789#top', '/js/a.js#top' ],
            [ 'https://cdn.example.org/js/a.js?v=0123456789', 'https://cdn.example.org/js/a.js' ],
            [ '/js/a.js?v=2', '/js/a.js?v=2' ],
            [ '/js/a.js?v=0123456789a', '/js/a.js?v=0123456789a' ],
            [ '/js/a.js?xv=0123456789', '/js/a.js?xv=0123456789' ],
            [ '/js/a.js?v=ABCDEF0123', '/js/a.js?v=ABCDEF0123' ],
            [ '/js/a.js', '/js/a.js' ]
        ];
        table.forEach(function (row) {
            assert.equal(key(row[0]), row[1], row[0]);
        });
        assert.equal(key(null), null, 'a non-string passes through');
    });
});
