'use strict';
/**
 * #B662 / #B660 / #B659 / #B667 — how `_handleDispatch` (core/server.js) decides which
 * method a routing rule serves a request under.
 *
 * #B662 — a `GET` was dispatched to a rule declared `DELETE` for ANY client: the early
 * method filter let the `GET` through and the URL-matched block rewrote `req.method`.
 * Measured live (2026-09-25): on the Express engine a cross-site-navigation `GET`
 * carrying the victim's session cookie ran the `DELETE` action while the documented
 * Session + Csrf adoption was in place (the plugin runs before dispatch and saw a safe
 * `GET`); on either engine without the plugin, a `GET` ran it. Fix: the override is
 * granted only to an XHR that is not a browser cross-origin request
 * (`isGetToDeleteOverrideAllowed`, over the real `lib.admin.isCrossOriginWrite`).
 * #B660 — a `GET` on a `"POST,DELETE"` rule handed the action `req.method ===
 * "POST,DELETE"`; the override now sets the literal `DELETE`.
 * #B659 — a 405 carried no `Allow` field (RFC 9110 §15.5.6 MUST); it now lists the
 * refusing rules' methods (`buildAllowHeader`).
 * #B667 — `HEAD` answered 404 on a `:param` GET rule and 405 on a `"GET,POST"` rule;
 * the rule is now matched as `HEAD` whenever it serves `GET`.
 *
 * The helpers are EXTRACTED from the shipped source and executed (no replica); the
 * wiring is pinned structurally on the comment-stripped source; §06 drives the REAL
 * `lib/routing` to show why `HEAD` must reach it as `HEAD`. Red-first:
 * GINA_SERVER_SRC=<pre-fix server.js> reds §01–§05 (the helpers and the wiring are
 * absent there); §06 is a control that does not read server.js.
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core', 'server.js');
var SERVER = fs.readFileSync(SOURCE, 'utf8');

// Whole-line `//` comments FIRST, then block comments: a `/*` inside a `// …` line
// would otherwise open a phantom block comment that swallows the code after it.
function stripComments(src) {
    return src
        .split('\n')
        .filter(function (l) { return !/^\s*\/\//.test(l); })
        .join('\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}
var SERVER_ST = stripComments(SERVER);

var HELPERS = ['isGetToDeleteOverrideAllowed', 'ruleListsMethod', 'buildAllowHeader'];

function extractHelper(src, name) {
    var decl = 'var ' + name + ' = function(';
    var start = src.indexOf(decl);
    assert.ok(start > -1, 'extraction control: server.js declares ' + name + ' at module scope');
    assert.equal(src.indexOf(decl, start + 1), -1, 'extraction control: ' + name + ' is declared once');
    var end = src.indexOf('\n};\n', start);
    assert.ok(end > -1, 'extraction control: ' + name + ' closes at column 0');
    return src.slice(start, end + 3);
}

var admin = require(path.join(FW, 'lib/admin'));

function loadHelpers() {
    var body = HELPERS.map(function (n) { return extractHelper(SERVER, n); }).join('\n');
    var ret = '\nreturn { ' + HELPERS.map(function (n) { return n + ': ' + n; }).join(', ') + ' };';
    return new Function('lib', "'use strict';\n" + body + ret)({ admin: admin });
}

function xhr(headers) {
    return { isXMLRequest: true, headers: headers || {} };
}

// ---------------------------------------------------------------------------
describe('route-method-resolution-b662 §01 — the helpers extract from the shipped source', function () {

    it('01.1  each helper is declared once at module scope and runs', function () {
        var h = loadHelpers();
        HELPERS.forEach(function (n) { assert.equal(typeof h[n], 'function', n); });
    });

    it('01.2  CONTROL — the real lib/admin predicate is the one the helper calls', function () {
        assert.equal(typeof admin.isCrossOriginWrite, 'function');
        assert.equal(admin.isCrossOriginWrite({ headers: { 'sec-fetch-site': 'cross-site' } }), true);
        assert.equal(admin.isCrossOriginWrite({ headers: { 'sec-fetch-site': 'same-origin' } }), false);
    });
});

// ---------------------------------------------------------------------------
describe('route-method-resolution-b662 §02 — isGetToDeleteOverrideAllowed (#B662)', function () {

    it('02.1  a same-origin XHR is allowed (Sec-Fetch-Site: same-origin)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'same-origin' })), true);
    });

    it('02.2  an XHR from a user-initiated context is allowed (Sec-Fetch-Site: none)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'none' })), true);
    });

    it('02.3  an XHR with no browser signal is allowed (curl, a server-side query, a legacy same-origin GET)', function () {
        var h = loadHelpers();
        assert.equal(h.isGetToDeleteOverrideAllowed(xhr({})), true);
        assert.equal(h.isGetToDeleteOverrideAllowed({ isXMLRequest: true }), true, 'no headers object at all');
    });

    it('02.4  a legacy-browser XHR whose Origin equals the host is allowed', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ origin: 'https://app.example', host: 'app.example' })), true);
    });

    it('02.5  a navigation (no X-Requested-With) is refused, even same-origin', function () {
        var h = loadHelpers();
        assert.equal(h.isGetToDeleteOverrideAllowed({ isXMLRequest: false, headers: { 'sec-fetch-site': 'same-origin' } }), false);
        assert.equal(h.isGetToDeleteOverrideAllowed({ isXMLRequest: false, headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate' } }), false);
        assert.equal(h.isGetToDeleteOverrideAllowed({ headers: {} }), false, 'isXMLRequest unset');
        assert.equal(h.isGetToDeleteOverrideAllowed({ isXMLRequest: 'true', headers: {} }), false, 'only the boolean true counts');
    });

    it('02.6  a cross-site XHR is refused (an Origin-reflecting CORS preflight let it carry the header)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })), false);
    });

    it('02.7  a same-site XHR is refused (a sibling subdomain is another origin)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'same-site' })), false);
    });

    it('02.8  a legacy-browser cross-origin XHR is refused (Origin differs from the host)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ origin: 'https://evil.example', host: 'app.example' })), false);
    });

    it('02.9  an XHR from an opaque origin is refused (Origin: null)', function () {
        assert.equal(loadHelpers().isGetToDeleteOverrideAllowed(xhr({ origin: 'null', host: 'app.example' })), false);
    });

    it('02.10 the Sec-Fetch-Site value is read case-insensitively', function () {
        var h = loadHelpers();
        assert.equal(h.isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'Same-Origin' })), true);
        assert.equal(h.isGetToDeleteOverrideAllowed(xhr({ 'sec-fetch-site': 'CROSS-SITE' })), false);
    });
});

// ---------------------------------------------------------------------------
describe('route-method-resolution-b662 §03 — ruleListsMethod', function () {

    it('03.1  a list names each of its methods, case-insensitively', function () {
        var h = loadHelpers();
        assert.equal(h.ruleListsMethod('POST,DELETE', 'DELETE'), true);
        assert.equal(h.ruleListsMethod('POST,DELETE', 'delete'), true);
        assert.equal(h.ruleListsMethod('get,post', 'GET'), true);
        assert.equal(h.ruleListsMethod('GET, POST', 'POST'), true, 'a space after the comma is ignored');
    });

    it('03.2  exact items only — no substring, no implied HEAD', function () {
        var h = loadHelpers();
        assert.equal(h.ruleListsMethod('GET', 'HEAD'), false);
        assert.equal(h.ruleListsMethod('POST', 'POS'), false);
        assert.equal(h.ruleListsMethod('POST,DELETE', 'GET'), false);
    });

    it('03.3  a non-string declaration lists nothing', function () {
        var h = loadHelpers();
        assert.equal(h.ruleListsMethod(undefined, 'GET'), false);
        assert.equal(h.ruleListsMethod(null, 'GET'), false);
    });
});

// ---------------------------------------------------------------------------
describe('route-method-resolution-b662 §04 — buildAllowHeader (#B659)', function () {

    it('04.1  a GET-bearing list advertises HEAD right after GET', function () {
        assert.equal(loadHelpers().buildAllowHeader(['GET,POST']), 'GET, HEAD, POST');
    });

    it('04.2  several refusing rules are merged in declaration order, deduplicated', function () {
        var h = loadHelpers();
        assert.equal(h.buildAllowHeader(['POST,DELETE', 'delete']), 'POST, DELETE');
        assert.equal(h.buildAllowHeader(['GET', 'GET,HEAD', 'PUT']), 'GET, HEAD, PUT');
    });

    it('04.3  no refusing rule, or no string, gives an empty value', function () {
        var h = loadHelpers();
        assert.equal(h.buildAllowHeader([]), '');
        assert.equal(h.buildAllowHeader([undefined, null]), '');
    });
});

// ---------------------------------------------------------------------------
describe('route-method-resolution-b662 §05 — the wiring in _handleDispatch', function () {

    it('05.1  the early filter lets a GET reach a DELETE rule only through the gate', function () {
        assert.ok(SERVER_ST.indexOf("} else if ( /^get$/i.test(req.method) && /^delete$/i.test(_routeMethod) && isGetToDeleteOverrideAllowed(req) ) {") > -1);
    });

    it('05.2  the ungated early-filter exception is gone from the live code (kept only as a `// was:` note)', function () {
        var old = '} else if ( /^get$/i.test(req.method) && /^delete$/i.test(_routeMethod) ) {';
        assert.equal(SERVER_ST.indexOf(old), -1);
        assert.ok(SERVER.indexOf('// was: ' + old) > -1, 'the strip is proven: the raw source still carries the old line as a comment');
    });

    it('05.3  the URL-matched override is gated, list-aware, and sets the literal DELETE (#B660)', function () {
        var head = "} else if ( /^get$/i.test(req.method) && ruleListsMethod(_routing.method, 'DELETE') && isGetToDeleteOverrideAllowed(req) ) {";
        var at = SERVER_ST.indexOf(head);
        assert.ok(at > -1, 'the gated override branch');
        var branch = SERVER_ST.slice(at + head.length, SERVER_ST.indexOf('} else {', at));
        assert.match(branch, /req\.method = 'DELETE';/);
        assert.match(branch, /isMethodAllowed = true;/);
    });

    it('05.4  no live line hands the action the rule\'s method list any more (#B660)', function () {
        assert.equal(/req\.method\s*=\s*_routing\.method/.test(SERVER_ST), false);
        assert.ok(/\/\/ was:\s+req\.method = _routing\.method;/.test(SERVER), 'the strip is proven: the raw source carries the old line as a comment');
    });

    it('05.5  HEAD is matched as HEAD on every rule that serves GET (#B667)', function () {
        assert.match(SERVER_ST, /\} else if \( \/\^head\$\/i\.test\(req\.method\) && ruleListsMethod\(method, 'GET'\) \) \{\s*method = 'HEAD';\s*\}/);
    });

    it('05.6  a refusing rule feeds the Allow list before the 405 message is recorded (#B659)', function () {
        assert.match(SERVER_ST, /_methodMismatchAllow\.push\(_routing\.method\);\s*_methodMismatch405msg = 'Method Not Allowed/);
        assert.equal(SERVER_ST.split('var _methodMismatchAllow = [];').length - 1, 1, 'the list is declared once');
    });

    it('05.7  the 405 sets Allow before throwError, inside the 405 branch (#B659)', function () {
        assert.match(SERVER_ST, /if \(!matched && _methodMismatch405msg\) \{\s*if \( !res\.headersSent \) \{\s*res\.setHeader\('allow', buildAllowHeader\(_methodMismatchAllow\)\);\s*\}\s*return throwError\(res, 405, _methodMismatch405msg, next\);/);
    });
});

// ---------------------------------------------------------------------------
// CONTROL — the real lib/routing, independent of server.js: why HEAD must reach it as HEAD.
process.env.NODE_PATH = FW + (process.env.NODE_PATH ? path.delimiter + process.env.NODE_PATH : '');
require('module').Module._initPaths();
require(path.join(FW, '../../utils/prototypes'));
require(path.join(FW, 'helpers'));
if (!process.gina) { process.gina = {}; }
setContext('isProxyHost', false);
setContext('gina', { config: { env: 'dev', bundle: 'b', getRouting: function () { return {}; }, envConf: {} } });
var routing = require(path.join(FW, 'lib/routing'));

var ITEM = { url: '/app/items/:id', method: 'GET', param: { control: 'act', id: ':id' }, requirements: { id: '/^[0-9]+$/' }, bundle: 'b', middleware: [] };

async function compare(ruleMethod, requestMethod, url) {
    var req = { url: url, method: requestMethod, headers: {}, params: { 0: url }, routing: { url: url, method: requestMethod, bundle: 'b' } };
    req[requestMethod.toLowerCase()] = {};
    var params = {
        method: ruleMethod, control: 'act', requirements: ITEM.requirements, namespace: undefined,
        url: url, rule: 'item@b', param: JSON.clone(ITEM.param), middleware: [], bundle: 'b',
        isXMLRequest: false, isWithCredentials: false
    };
    var out = await routing.compareUrls(params, ITEM.url, req, {}, function () {});
    return { past: out.past === true, id: req.params.id };
}

describe('route-method-resolution-b662 §06 — CONTROL: the real lib/routing on a `:param` GET rule', function () {

    it('06.1  CONTROL — GET matched as GET binds the parameter', async function () {
        var r = await compare('GET', 'GET', '/app/items/5');
        assert.equal(r.past, true);
        assert.equal(r.id, '5');
    });

    it('06.2  HEAD matched as GET is refused inside lib/routing — why HEAD on `/items/:id` answered 404', async function () {
        var r = await compare('GET', 'HEAD', '/app/items/5');
        assert.equal(r.past, false);
    });

    it('06.3  HEAD matched as HEAD — what the dispatch now passes — binds the parameter', async function () {
        var r = await compare('HEAD', 'HEAD', '/app/items/5');
        assert.equal(r.past, true);
        assert.equal(r.id, '5');
    });

    it('06.4  CONTROL — the requirement still refuses a non-matching value under HEAD', async function () {
        var r = await compare('HEAD', 'HEAD', '/app/items/abc');
        assert.equal(r.past, false);
    });
});
