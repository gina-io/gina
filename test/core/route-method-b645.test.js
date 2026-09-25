'use strict';
/**
 * #B645 — on a bundle configured `server.protocol: "http/2.0"`, an HTTP/1.1 request
 * (served through the HTTP/2 server's `allowHTTP1` fallback — a direct HTTP/1.1
 * client, or a reverse proxy that speaks HTTP/1.1 upstream) carries no `:method`
 * pseudo-header. The router took the request method from that header whenever the
 * BUNDLE was configured for HTTP/2, so it read `undefined`; `new RegExp(undefined,
 * 'i')` matches every string, and both method checks of the routing loop passed for
 * every method on the static-URL rules. The warm route cache is keyed by the real
 * method, so one such request also left the wrong rule as the answer for every later
 * client of that method and path, HTTP/2 clients included. The CORS preflight check
 * read the method the same way, so an HTTP/1.1 preflight was never recognised.
 *
 * THE FIX: the routing site and the preflight check take the method from the request
 * itself (`req.method`, which Node sets for HTTP/1 and HTTP/2 requests alike), and
 * the preflight rewrite chooses its target by whether the REQUEST carries `:method`.
 *
 * WHICH ARMS CAN GO RED — read this before trusting a green run:
 *   §01  the routing site in `_handleDispatch`: red pre-fix (source pins).
 *   §02  the preflight check and rewrite in `checkPreflightRequest`: red pre-fix.
 *   §03  premise pins on code the fix does NOT change: green pre-fix too.
 *   §04  behaviour — the derivations extracted from the source and executed against
 *        an HTTP/1-shaped and an HTTP/2-shaped request: the HTTP/1 arms are red
 *        pre-fix; the HTTP/2 and http/1.1-bundle arms are controls, green both ways.
 * The booted-bundle twin: test/integration/container-boot-route-method.test.js.
 *
 * Seam: `GINA_B645_SERVER_SRC=<file>` reads that file instead of the tree's
 * `core/server.js`, so the whole file runs red-first against `git show HEAD:…`.
 *
 * Run standalone:
 *   node --test test/core/route-method-b645.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_B645_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER     = fs.readFileSync(SERVER_SRC, 'utf8');

/** Drop full-line `//` comments, so a pin cannot be satisfied by the prose that documents it. */
function activeLines(src) {
    return src.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/** The source between two anchors, each of which must occur exactly once. */
function region(src, startToken, endToken) {
    var s = src.indexOf(startToken);
    assert.ok(s > -1, 'anchor missing: ' + startToken);
    assert.equal(src.indexOf(startToken, s + 1), -1, 'anchor not unique: ' + startToken);
    var e = src.indexOf(endToken, s);
    assert.ok(e > s, 'end anchor missing after the start: ' + endToken);
    return src.slice(s, e);
}

var PREFLIGHT_START = 'var checkPreflightRequest = function(request, response) {';
var PREFLIGHT_END   = 'var serveRenderCacheHit = function';
var DISPATCH_START  = 'var _handleDispatch = async function(';
var DISPATCH_END    = 'var isMethodAllowed = null';

/** A bundle configuration stub, in the shape both call sites read. */
function selfStub(protocol) {
    return { appName: 'app', env: 'dev', conf: { app: { dev: { server: { protocol: protocol } } } } };
}
/** An HTTP/1 request as Node hands it over: `method` is set, no pseudo-header. */
function h1Request(method) { return { method: method, headers: {} }; }
/** An HTTP/2 compat request: `method` reads and writes the `:method` pseudo-header. */
function h2Request(method) {
    var r = { headers: { ':method': method } };
    Object.defineProperty(r, 'method', {
        get: function () { return this.headers[':method']; },
        set: function (v) { this.headers[':method'] = v; },
        enumerable: true
    });
    return r;
}


describe('01 - #B645 routing site: the method comes from the request', function () {

    var raw  = region(SERVER, DISPATCH_START, DISPATCH_END);
    var code = activeLines(raw);

    it('01.1  the dispatch method is read from req.method, with the pseudo-header as fallback', function () {
        assert.ok(/,\s*method\s*=\s*req\.method\s*\|\|\s*req\.headers\[':method'\]/.test(code),
            'expected `, method = req.method || req.headers[\':method\']` in _handleDispatch');
    });

    it('01.2  no configured-protocol ternary picks the pseudo-header there any more', function () {
        assert.ok(!/server\.protocol\s*\)\s*\)\s*\?\s*req\.headers\[':method'\]/.test(code),
            'the dispatch method must not depend on the bundle\'s configured protocol');
    });

    it('01.3  the regexp every method check tests with is still built from that method', function () {
        assert.ok(/,\s*reMethod\s*=\s*new RegExp\(\s*method\s*,\s*'i'\s*\)/.test(code), 'reMethod must be built from method');
    });
});


describe('02 - #B645 preflight: detection and rewrite follow the request', function () {

    var raw  = region(SERVER, PREFLIGHT_START, PREFLIGHT_END);
    var code = activeLines(raw);

    it('02.1  the preflight check reads request.method, with the pseudo-header as fallback', function () {
        assert.ok(/var method\s*=\s*request\.method\s*\|\|\s*request\.headers\[':method'\]/.test(code),
            'expected `var method = request.method || request.headers[\':method\']` in checkPreflightRequest');
    });

    it('02.2  the rewrite writes the pseudo-header only when the request carries one', function () {
        assert.ok(/if\s*\(\s*typeof\s*\(\s*request\.headers\[':method'\]\s*\)\s*!=\s*'undefined'\s*\)\s*\{\s*request\.headers\[':method'\]\s*=\s*method;\s*\}\s*else\s*\{\s*request\.method\s*=\s*method;?\s*\}/.test(code),
            'the rewrite must choose its target by whether the request carries :method');
    });

    it('02.3  no line of the preflight check tests the configured protocol', function () {
        assert.ok(!/\.test\(\s*config\.server\.protocol\s*\)/.test(code), 'checkPreflightRequest must not test the configured protocol');
    });
});


describe('03 - #B645 premises: code the fix does not change', function () {

    it('03.1  the render-cache reader keeps its request fallback (it was never affected)', function () {
        assert.ok(activeLines(SERVER).indexOf("if ( !/^get$/i.test(_method || req.method || '') ) { return false; }") > -1);
    });

    it('03.2  the warm route cache is keyed by the request\'s own method', function () {
        assert.ok(activeLines(SERVER).indexOf("routingLib.getCached(req.method +':'+ pathname, req)") > -1);
    });

    it('03.3  the preflight short-circuit still answers 204 before routing', function () {
        assert.ok(/req = checkPreflightRequest\(req, res\);\s*\n[\s\S]{0,200}?if \( req\.isPreflightRequest \) \{/.test(activeLines(SERVER)),
            'the dispatch must short-circuit a preflight right after checkPreflightRequest');
    });
});


describe('04 - #B645 behaviour: the extracted derivations, executed', function () {

    var dispatchCode  = activeLines(region(SERVER, DISPATCH_START, DISPATCH_END));
    var preflightCode = activeLines(region(SERVER, PREFLIGHT_START, PREFLIGHT_END));

    var dm = dispatchCode.match(/,\s*method\s*=\s*([^\n]+?)\s*\n\s*,\s*reMethod\s*=/g);
    var pm = preflightCode.match(/var method\s*=\s*([^\n]+?)\s*\n\s*,\s*reAccessAllowMethod\s*=/g);

    it('04.0  each extraction fires exactly once (a silent zero would pass every arm below)', function () {
        assert.ok(dm && dm.length === 1, 'dispatch method initializer: ' + (dm ? dm.length : 0));
        assert.ok(pm && pm.length === 1, 'preflight method initializer: ' + (pm ? pm.length : 0));
    });

    function dispatchMethod() {
        var expr = dm[0].replace(/^,\s*method\s*=\s*/, '').replace(/\s*\n\s*,\s*reMethod\s*=$/, '');
        return new Function('req', 'self', 'return (' + expr + ');');
    }
    function preflightMethod() {
        var expr = pm[0].replace(/^var method\s*=\s*/, '').replace(/\s*\n\s*,\s*reAccessAllowMethod\s*=$/, '');
        return new Function('request', 'config', 'return (' + expr + ');');
    }

    it('04.1  HTTP/1.1 POST on an http/2.0 bundle: the method is POST, and its regexp does not match GET', function () {
        var m = dispatchMethod()(h1Request('POST'), selfStub('http/2.0'));
        assert.equal(m, 'POST');
        assert.equal(new RegExp(m, 'i').test('GET'), false, 'a POST must not pass a GET-only rule\'s method check');
    });

    it('04.2  HTTP/1.1 GET on an http/2.0 bundle: its regexp does not match POST', function () {
        var m = dispatchMethod()(h1Request('GET'), selfStub('http/2.0'));
        assert.equal(new RegExp(m, 'i').test('POST'), false, 'a GET must not pass a POST-only rule\'s method check');
    });

    it('04.3  control — HTTP/2 POST on an http/2.0 bundle reads POST', function () {
        assert.equal(dispatchMethod()(h2Request('POST'), selfStub('http/2.0')), 'POST');
    });

    it('04.4  control — HTTP/1.1 POST on an http/1.1 bundle reads POST', function () {
        assert.equal(dispatchMethod()(h1Request('POST'), selfStub('http/1.1')), 'POST');
    });

    it('04.5  preflight: an HTTP/1.1 OPTIONS on an http/2.0 bundle is seen as OPTIONS', function () {
        assert.equal(preflightMethod()(h1Request('OPTIONS'), { server: { protocol: 'http/2.0' } }), 'OPTIONS');
    });

    it('04.6  control — preflight: an HTTP/2 OPTIONS is seen as OPTIONS', function () {
        assert.equal(preflightMethod()(h2Request('OPTIONS'), { server: { protocol: 'http/2.0' } }), 'OPTIONS');
    });

    // The rewrite block: from the requested-method assignment to the header parsing that follows it.
    var rw = preflightCode.match(/\['access-control-request-method'\];\s*\n([\s\S]*?)\n\s*accessControlRequestHeaders\s*=\s*\(/g);

    it('04.7  the rewrite extraction fires exactly once', function () {
        assert.ok(rw && rw.length === 1, 'rewrite block: ' + (rw ? rw.length : 0));
    });

    function rewrite() {
        var body = rw[0].replace(/^\['access-control-request-method'\];\s*\n/, '').replace(/\n\s*accessControlRequestHeaders\s*=\s*\($/, '');
        return new Function('request', 'method', 'config', body);
    }

    it('04.8  an HTTP/1.1 preflight on an http/2.0 bundle is rewritten to the requested method', function () {
        var req = h1Request('OPTIONS');
        rewrite()(req, 'POST', { server: { protocol: 'http/2.0' } });
        assert.equal(req.method, 'POST');
    });

    it('04.9  control — an HTTP/2 preflight is rewritten through its pseudo-header', function () {
        var req = h2Request('OPTIONS');
        rewrite()(req, 'POST', { server: { protocol: 'http/2.0' } });
        assert.equal(req.method, 'POST');
        assert.equal(req.headers[':method'], 'POST');
    });

    it('04.10 control — an HTTP/1.1 preflight on an http/1.1 bundle is rewritten', function () {
        var req = h1Request('OPTIONS');
        rewrite()(req, 'POST', { server: { protocol: 'http/1.1' } });
        assert.equal(req.method, 'POST');
    });
});
