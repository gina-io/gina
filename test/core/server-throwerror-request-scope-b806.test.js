'use strict';
/**
 * #B806 — core/server.js's `throwError` (and `getResponseProtocol`, which it calls) build the error
 * response from the Server-wide `local.request` closure slot. onInstance overwrites that slot on
 * every request arrival (:4752 / the static branch :6111), so after any async gap an error raised
 * for request A is built from whichever request arrived LAST: the wrong JSON-vs-HTML form, another
 * request's URL / routing / session in the error page, a mis-correlated #ERRREF log line, and CORS
 * headers from the wrong Origin.
 *
 * The fix resolves the request from the response it belongs to — `var _req = ( res && res.req ) ?
 * res.req : local.request;` — in both functions, and uses `_req` in place of every `local.request`
 * read inside `throwError`. `res.req` is the response's own request on node and bun, both engines,
 * through close (measured). The `local.request` fallback keeps today's behaviour for a non-native
 * `res` (a middleware-swapped response, the setup.js alias), which is no-worse-than-today there.
 *
 * Folded in the same commit (same function):
 *  - #B815 — the extensionless-HTML inline fallback page is served with its real `text/html` type;
 *    the server twin lacked the controller twin's `if (!ext) ext = 'html'`, so it sent
 *    `undefined; charset=…`.
 *  - BC1 — `:8823` passed the never-assigned `local.response` (undefined) to checkPreflightRequest;
 *    it now passes `res`, so a preflight-shaped error no longer throws on `response.setHeader`.
 *
 *  01 extraction controls — the slice captured the real functions.
 *  02 behavioural — the REAL `throwError` + `getResponseProtocol` bytes compiled with their closure
 *     inputs, a NATIVE response (res.req === its own request, as node/bun set it). Two dispatches A
 *     and B; B arrives between A's arrival and A's throwError. The reading is which request A's
 *     answer is built from.
 *  03 fallback — a non-native `res` (no `.req`) falls back to `local.request` and does not throw.
 *  04 #B815 — content-type of the extensionless-HTML inline fallback.
 *  05 BC1 — checkPreflightRequest is handed `res`, not undefined.
 *  06 source pins on the two resolution lines + the #B815 line, comment-stripped.
 *
 * Seam: GINA_SERVER_SRC=<absolute file> runs every arm against that text. Red-first against the
 * pre-change bytes (`git show <sha>:<fw>/core/server.js > <file>`): the §02/§04/§05 arms that pin
 * the change read RED, the §02 serialized CONTROL arms and §01 stay GREEN. No arm waits on a
 * callback of the code under test — each settles synchronously on the event loop — so a regression
 * fails and never hangs.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var crypto = require('crypto');

var FW     = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
require(path.join(FW, 'helpers')); // real safeDecodeURI, getEnvVar, __stack, JSON.clone, count()
var SRC = fs.readFileSync(SOURCE, 'utf8');

function once(needle) {
    var i = SRC.indexOf(needle);
    assert.ok(i > -1 && SRC.indexOf(needle, i + 1) === -1, 'anchor not found exactly once: ' + needle);
    return i;
}
function sliceTo(start, endNeedle) {
    var e = SRC.indexOf(endNeedle, start);
    assert.ok(e > -1, 'end anchor not found: ' + endNeedle);
    return SRC.slice(start, e + endNeedle.length);
}

var TE_A   = once('    var throwError = function(res, code, msg, next) {');
var TE_END = once('\n};\n\nServer = inherits(Server, EventEmitter);');
var TE_SRC = SRC.slice(TE_A, TE_END);
var GRP_SRC = sliceTo(once('    var getResponseProtocol = function (response) {'), '\n    }\n');
var MINT_SRC = sliceTo(once('var _mintErrorRef = function(supplied) {'), '\n};\n');
var ESC_SRC  = sliceTo(once('var _escapeHtml = function(value) {'), '\n};\n');
var LANG_SRC = sliceTo(once('var a11yLangTag = function(req) {'), '\n};\n');
var DOC_SRC  = sliceTo(once('var a11yErrorDocument = function(code, bodyHtml, req) {'), '\n};\n');
var CPR_SRC  = sliceTo(once('    var checkPreflightRequest = function(request, response) {'), '\n        return request\n    }');

var H = new Function('crypto', MINT_SRC + ESC_SRC + LANG_SRC + DOC_SRC +
    '\nreturn { _mintErrorRef: _mintErrorRef, _escapeHtml: _escapeHtml, a11yLangTag: a11yLangTag, a11yErrorDocument: a11yErrorDocument };')(crypto);

function makeServer(opts) {
    opts = opts || {};
    var calls = [], logs = [], routes = [];
    var local = {
        router: { route: function (req, res, next, routing) {
            calls.push('router.route(req=' + req.tag + ', res=' + res.tag + ', rule=' + (routing && routing.rule) + ')');
        } },
        hasViews: { fixtureapp: true }
    };
    var common = opts.errorFiles ? { errorFiles: { 500: 'errors/500.html', '5xx': 'errors/5xx.html' } } : {};
    var self = {
        appName: 'fixtureapp', env: 'prod', instance: {},
        conf: { fixtureapp: { prod: {
            template: true, encoding: 'utf-8',
            server: { protocol: 'http/1.1', response: { header: {} },
                coreConfiguration: { statusCodes: { 404: 'Not Found', 500: 'Internal Server Error' },
                                     mime: { html: 'text/html', json: 'application/json' } } },
            content: { templates: { _common: common } }
        } } },
        isLocalScope: function () { return false; },
        isCacheless: function () { return false; }
    };
    var completeHeaders = function (h, req, res) { calls.push('completeHeaders(req=' + req.tag + ', res=' + res.tag + ')'); return h; };
    var checkPreflightRequest = function (req, res) { calls.push('checkPreflightRequest(req=' + (req && req.tag) + ', res=' + (res && res.tag) + ')'); return req; };
    var routingLib = { getRoute: function () { var r = { param: {} }; routes.push(r); return r; } };
    var hasViews = function () { return true; };
    var con = { error: function (s) { logs.push(String(s)); }, log: function () {}, warn: function () {}, info: function () {}, debug: function () {} };
    var getResponseProtocol = new Function('local', 'self', GRP_SRC + '\nreturn getResponseProtocol;')(local, self);
    var throwError = new Function('local', 'self', 'hasViews', 'getResponseProtocol', '_mintErrorRef', 'checkPreflightRequest',
        'completeHeaders', 'safeDecodeURI', 'routingLib', '_escapeHtml', 'a11yErrorDocument', 'console',
        TE_SRC + '\nreturn throwError;')(local, self, hasViews, getResponseProtocol, H._mintErrorRef, checkPreflightRequest,
        completeHeaders, global.safeDecodeURI, routingLib, H._escapeHtml, H.a11yErrorDocument, con);
    return { local: local, throwError: throwError, getResponseProtocol: getResponseProtocol,
             calls: calls, logs: logs, routes: routes, arrive: function (req) { local.request = req; } };
}

function mkReq(tag, o) {
    return { tag: tag, method: o.method || 'GET', url: o.url, httpVersion: o.httpVersion || '1.1', isXMLRequest: !!o.xhr,
             culture: o.culture, headers: { 'user-agent': 'test/1' }, _ginaReqId: 'rid-' + tag,
             routing: { rule: 'own-route-of-' + tag } };
}
function mkRes(tag, ownReq) {
    var r = { tag: tag, headersSent: false, statusCode: 200, head: null, body: null, _h: {} };
    if (ownReq) { r.req = ownReq; } // a native response carries its own request on res.req
    r.writeHead = function (code, h) { r.head = { code: code, contentType: h && h['content-type'] }; };
    r.end = function (b) { r.body = String(b); r.headersSent = true; };
    r.setHeader = function (k, v) { r._h[String(k).toLowerCase()] = v; };
    r.getHeader = function (k) { return r._h[String(k).toLowerCase()]; };
    r.getHeaders = function () { return r._h; };
    return r;
}

// Drive: A arrives; (serialized: A answered, then B arrives) | (interleaved: B arrives, then A errors).
// nativeRes=true links resA.req to A (a native response); false models a non-native res (no .req).
function drive(o) {
    var S = makeServer({ errorFiles: o.errorFiles });
    var A = mkReq('A', o.A), B = mkReq('B', o.B);
    var resA = mkRes('A', o.nativeRes === false ? null : A);
    var threw = null;
    try {
        S.arrive(A);
        if (o.interleaved) { S.arrive(B); S.throwError(resA, 500, 'failure serving A', function () {}); }
        else { S.throwError(resA, 500, 'failure serving A', function () {}); S.arrive(B); }
    } catch (e) { threw = String(e && e.message || e); }
    var kind = resA.body == null ? 'none' : (/^\{/.test(resA.body) ? 'json' : (/^<!doctype html>/i.test(resA.body) ? 'html' : 'other'));
    var log = S.logs[0] || '';
    return {
        threw: threw, form: kind,
        status: resA.head && resA.head.code, contentType: resA.head ? resA.head.contentType : null,
        htmlLang: (resA.body && (resA.body.match(/<html lang="([^"]+)"/) || [])[1]) || null,
        pairsUrl: (log.match(/\] (GET|POST|PUT|PATCH|DELETE) \[ [^\]]+ \] (\S+)/) || [])[2] || null,
        pairsReqId: (log.match(/\]\[ req ([^ ]+) \]/) || [])[1] || null,
        customPathname: S.routes[0] && S.routes[0].param ? S.routes[0].param.error && S.routes[0].param.error.pathname : null,
        aRouting: A.routing && A.routing.rule, bRouting: B.routing && B.routing.rule,
        calls: S.calls
    };
}

// ─── 01 — extraction controls ────────────────────────────────────────────────
describe('#B806 §01 — extraction controls', function () {
    it('the throwError + getResponseProtocol slices captured the real functions', function () {
        assert.ok(TE_SRC.indexOf('var isXMLRequest    = ') > -1, 'throwError slice');
        assert.ok(TE_SRC.indexOf('router.route(') > -1 && TE_SRC.indexOf('.routing = routeObj;') > -1, 'custom-error dispatch');
        assert.ok(GRP_SRC.indexOf('.httpVersion') > -1, 'getResponseProtocol slice');
        assert.ok(/\n    \}$/.test(TE_SRC), 'throwError ends on its own closing brace');
    });
});

// ─── 02 — behavioural: a native response, A's answer is built from A ──────────
describe('#B806 §02 — the error is built from the response\'s own request (native res)', function () {
    it('CONTROL serialized: an XHR error is answered JSON from A', function () {
        var r = drive({ A: { xhr: true, url: '/api/a' }, B: { url: '/page-b' } });
        assert.equal(r.threw, null);
        assert.equal(r.form, 'json'); assert.equal(r.pairsUrl, '/api/a'); assert.equal(r.pairsReqId, 'rid-A');
    });
    it('interleaved: an XHR error still gets JSON (not B\'s HTML page), paired to A', function () {
        var r = drive({ interleaved: true, A: { xhr: true, url: '/api/a' }, B: { url: '/page-b' } });
        assert.equal(r.threw, null);
        assert.equal(r.form, 'json', 'XHR A must get JSON, not B\'s HTML form');
        assert.equal(r.pairsUrl, '/api/a', 'the #ERRREF log line names A, not B');
        assert.equal(r.pairsReqId, 'rid-A');
    });
    it('interleaved: a page error gets HTML in A\'s own culture, not B\'s JSON', function () {
        var r = drive({ interleaved: true, A: { url: '/page-a', culture: 'fr-FR' }, B: { xhr: true, url: '/api/b', culture: 'de-DE' } });
        assert.equal(r.threw, null);
        assert.equal(r.form, 'html', 'page A must get HTML, not B\'s JSON form');
        assert.equal(r.htmlLang, 'fr-FR', 'the fallback page carries A\'s culture, not B\'s');
        assert.equal(r.pairsUrl, '/page-a');
    });
    it('interleaved: the custom error page is dispatched on A, with A\'s pathname; B\'s routing is untouched', function () {
        var r = drive({ interleaved: true, errorFiles: true, A: { url: '/page-a' }, B: { url: '/page-b' } });
        assert.equal(r.threw, null);
        assert.equal(r.customPathname, '/page-a', 'the custom error page renders A\'s URL, not B\'s');
        assert.ok(r.calls.indexOf('router.route(req=A, res=A, rule=custom-error-page@fixtureapp)') > -1, 'dispatched on A');
        assert.equal(r.bRouting, 'own-route-of-B', 'B\'s routing must NOT be overwritten by A\'s error');
    });
    it('interleaved: completeHeaders + checkPreflightRequest are handed A', function () {
        var r = drive({ interleaved: true, A: { url: '/page-a' }, B: { url: '/page-b' } });
        assert.ok(r.calls.indexOf('completeHeaders(req=A, res=A)') > -1, 'CORS headers computed from A, not B');
        assert.ok(r.calls.indexOf('checkPreflightRequest(req=A, res=A)') > -1);
    });
});

// ─── 03 — fallback: a non-native response behaves as today, never throws ──────
describe('#B806 §03 — a non-native response falls back to local.request (no throw)', function () {
    it('res without .req: throwError still answers, does not throw', function () {
        var r = drive({ interleaved: true, nativeRes: false, A: { xhr: true, url: '/api/a' }, B: { url: '/page-b' } });
        assert.equal(r.threw, null, 'the local.request fallback must not throw for a req-less response');
        assert.ok(r.status === 500, 'it still answers');
    });
});

// ─── 04 — #B815: the extensionless-HTML inline fallback has its real type ─────
describe('#B815 §04 — extensionless-HTML inline fallback content-type', function () {
    it('a page error with no file extension is served text/html, not undefined', function () {
        var r = drive({ A: { url: '/page-a' }, B: { url: '/page-b' } });
        assert.equal(r.form, 'html');
        assert.equal(r.contentType, 'text/html; charset=utf-8', 'was `undefined; charset=…` before #B815');
    });
});

// ─── 05 — BC1: checkPreflightRequest is handed res, never undefined ───────────
describe('BC1 §05 — checkPreflightRequest receives the response, not undefined', function () {
    // The real helper throws on a preflight-shaped request when handed undefined (the old
    // local.response), and does not when handed a response. The fix passes res.
    function cpr() {
        var self = { appName: 'app', env: 'prod', conf: { app: { prod: { server: { response: { header: {
            'access-control-allow-methods': 'GET, POST, HEAD', 'access-control-allow-headers': 'x-requested-with' } } } } } } };
        return new Function('self', CPR_SRC + '\nreturn checkPreflightRequest;')(self);
    }
    var preflight = function () { return { method: 'OPTIONS', headers: {
        'access-control-request-method': 'POST', 'access-control-request-headers': 'x-requested-with', 'access-control-allow-methods': '' } }; };
    it('handed undefined (the pre-fix local.response): throws on setHeader', function () {
        assert.throws(function () { cpr()(preflight(), undefined); }, /setHeader/);
    });
    it('handed a real response (the fix passes res): sets the header, no throw', function () {
        var hdrs = {}; var res = { setHeader: function (k, v) { hdrs[k] = v; } };
        assert.doesNotThrow(function () { cpr()(preflight(), res); });
        assert.ok('access-control-allow-headers' in hdrs);
    });
    it('a non-preflight request + undefined response does not throw (the throw is the preflight path)', function () {
        assert.doesNotThrow(function () { cpr()({ method: 'GET', headers: {} }, undefined); });
    });
});

// ─── 06 — source pins (comment-stripped) ──────────────────────────────────────
describe('#B806 §06 — source pins', function () {
    function stripComments(s) { return s.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }
    var liveTE = stripComments(TE_SRC), liveGRP = stripComments(GRP_SRC);
    it('throwError resolves _req from res.req with a local.request fallback', function () {
        assert.match(liveTE, /var _req\s*=\s*\(\s*res\s*&&\s*res\.req\s*\)\s*\?\s*res\.req\s*:\s*local\.request;/);
    });
    it('getResponseProtocol resolves _req from response.req with a local.request fallback', function () {
        assert.match(liveGRP, /var _req\s*=\s*\(\s*response\s*&&\s*response\.req\s*\)\s*\?\s*response\.req\s*:\s*local\.request;/);
        assert.match(liveGRP, /'http\/'\+\s*_req\.httpVersion/);
    });
    it('throwError no longer reads local.request for its live reads (only the one fallback)', function () {
        // exactly one `local.request` remains in code — the fallback operand
        assert.equal((liveTE.match(/local\.request/g) || []).length, 1, 'only the fallback reads local.request');
    });
    it('checkPreflightRequest is called with res, not the never-assigned local.response (BC1)', function () {
        assert.match(liveTE, /checkPreflightRequest\(\s*_req\s*,\s*res\s*\)/);
        assert.equal((liveTE.match(/local\.response/g) || []).length, 0, 'local.response must be gone');
    });
    it('#B815: the extensionless-HTML branch assigns ext = \'html\'', function () {
        assert.match(liveTE, /if\s*\(\s*!ext\s*\)\s*\{\s*ext\s*=\s*'html';\s*\}/);
    });
});
