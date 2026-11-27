'use strict';
/**
 * #B1168 — `_handleDispatch` (core/server.js) built `new RegExp(<request method>, 'i')` and
 * tested it against each rule's method. Over HTTP/1.1 Node's parser refuses any method it does
 * not know (400) before the request reaches gina, but an HTTP/2 client can send any token as
 * `:method`: `*` or `+` threw at the regexp, outside the dispatch's `try`, so the request was
 * never answered (an unhandled rejection); `.`, `^`, `|` or `P.ST` matched every rule's method,
 * so an action ran under a method its rule does not list, without its body; and a long run of
 * `.*` made the match backtrack. The routing loop also keys the request's bags by the method.
 *
 * THE FIX: a method Node's HTTP parser does not accept is answered 501 Not Implemented
 * (RFC 9110 §15.6.2) at the start of the dispatch, before anything reads it; and the method is
 * escaped where the regexp is built, so it is matched as text. Matching for the methods Node
 * lists does not change (they are letters and `-`; §00 measures it on the running Node).
 *
 * WHICH ARMS CAN GO RED — read this before trusting a green run:
 *   §00  premise on the running Node: green pre-fix too (the one passing arm pre-fix).
 *   §01  the helpers, extracted from the shipped source and run: red pre-fix (no helper).
 *   §02  source pins on the guard and the escape in `_handleDispatch`: red pre-fix.
 *   §03  the guard's own bytes, extracted and executed on stub requests: red pre-fix.
 * The booted evidence (an HTTP/2 client against an isaac bundle) is recorded with the fix.
 *
 * Seam: `GINA_B1168_SERVER_SRC=<file>` reads that file instead of the tree's
 * `core/server.js`, so the whole file runs red-first against the pre-fix source.
 *
 * Run standalone:
 *   node --test test/core/route-method-b1168.test.js
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var http   = require('http');
var path   = require('path');

var FW         = require('../fw');
var SERVER_SRC = process.env.GINA_B1168_SERVER_SRC || path.join(FW, 'core/server.js');
var SERVER     = fs.readFileSync(SERVER_SRC, 'utf8');

/** Drop full-line `//` comments, so a pin cannot be satisfied by the prose that documents it. */
function activeLines(src) {
    return src.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

/** The source between two anchors; the start must occur exactly once. */
function region(src, startToken, endToken) {
    var s = src.indexOf(startToken);
    assert.ok(s > -1, 'anchor missing: ' + startToken);
    assert.equal(src.indexOf(startToken, s + 1), -1, 'anchor not unique: ' + startToken);
    var e = src.indexOf(endToken, s);
    assert.ok(e > s, 'end anchor missing after the start: ' + endToken);
    return src.slice(s, e);
}

/** A module-scope `var <name> = function(` declaration, up to its closing `};` at column 0. */
function extractFunction(src, name) {
    var decl = 'var ' + name + ' = function(';
    var start = src.indexOf(decl);
    assert.ok(start > -1, 'extraction control: server.js declares ' + name + ' at module scope');
    assert.equal(src.indexOf(decl, start + 1), -1, 'extraction control: ' + name + ' is declared once');
    var end = src.indexOf('\n};\n', start);
    assert.ok(end > -1, 'extraction control: ' + name + ' closes at column 0');
    return src.slice(start, end + 3);
}

/** The `KNOWN_HTTP_METHODS` declaration, up to the `})();` that closes it. */
function extractKnownMethods(src) {
    var decl = 'var KNOWN_HTTP_METHODS = (function() {';
    var start = src.indexOf(decl);
    assert.ok(start > -1, 'extraction control: server.js declares KNOWN_HTTP_METHODS at module scope');
    assert.equal(src.indexOf(decl, start + 1), -1, 'extraction control: KNOWN_HTTP_METHODS is declared once');
    var end = src.indexOf('\n})();\n', start);
    assert.ok(end > -1, 'extraction control: KNOWN_HTTP_METHODS closes with })();');
    return src.slice(start, end + 6);
}

/**
 * The three helpers, run from the shipped bytes. `requireFn` stands in for `require`, so the
 * fallback list can be reached with a runtime whose `http` module lists no method.
 */
function loadHelpers(requireFn) {
    var body = [
        extractKnownMethods(SERVER),
        extractFunction(SERVER, 'isKnownHttpMethod'),
        extractFunction(SERVER, 'escapeRegExpSource')
    ].join('\n');
    var ret = '\nreturn { KNOWN_HTTP_METHODS: KNOWN_HTTP_METHODS, isKnownHttpMethod: isKnownHttpMethod, escapeRegExpSource: escapeRegExpSource };';
    return new Function('require', "'use strict';\n" + body + ret)(requireFn || require);
}

var UNKNOWN = ['*', '+', '.', 'P.ST', '^', '|', '$', '.*', '__proto__', 'constructor', 'HEADERS', 'ws', ''];

// ---------------------------------------------------------------------------
describe('route-method-b1168 §00 — premise: the methods Node lists', function () {

    it('00.1  http.METHODS is a non-empty list of upper-case letters and `-` (so escaping them changes nothing)', function () {
        assert.ok(Array.isArray(http.METHODS) && http.METHODS.length > 0, 'http.METHODS');
        http.METHODS.forEach(function (m) { assert.match(m, /^[A-Z][A-Z-]*$/, m); });
        assert.ok(http.METHODS.indexOf('GET') > -1 && http.METHODS.indexOf('POST') > -1, 'control: GET and POST are listed');
    });
});

// ---------------------------------------------------------------------------
describe('route-method-b1168 §01 — the helpers, extracted from the shipped source', function () {

    it('01.1  each helper is declared once at module scope and runs', function () {
        var h = loadHelpers();
        assert.ok(Array.isArray(h.KNOWN_HTTP_METHODS));
        assert.equal(typeof h.isKnownHttpMethod, 'function');
        assert.equal(typeof h.escapeRegExpSource, 'function');
    });

    it('01.2  isKnownHttpMethod admits every method Node lists, in any case, and nothing else', function () {
        var h = loadHelpers();
        http.METHODS.forEach(function (m) {
            assert.equal(h.isKnownHttpMethod(m), true, m);
            assert.equal(h.isKnownHttpMethod(m.toLowerCase()), true, m.toLowerCase());
        });
        UNKNOWN.forEach(function (m) { assert.equal(h.isKnownHttpMethod(m), false, JSON.stringify(m)); });
        [undefined, null, 42, {}, ['GET']].forEach(function (m) { assert.equal(h.isKnownHttpMethod(m), false, String(m)); });
    });

    it('01.3  the list is the runtime\'s own; a runtime whose http module lists none gets the fallback', function () {
        assert.deepEqual(loadHelpers().KNOWN_HTTP_METHODS, http.METHODS, 'Node\'s list, as listed');
        var stubbed = function (methods) {
            return loadHelpers(function (id) { assert.equal(id, 'http'); return methods === undefined ? {} : { METHODS: methods }; }).KNOWN_HTTP_METHODS;
        };
        assert.deepEqual(stubbed(['ONLYTHIS']), ['ONLYTHIS'], 'control: the list comes from the runtime\'s http module');
        [undefined, []].forEach(function (none) {
            var fb = stubbed(none);
            assert.ok(fb.length > 9, 'a fallback list for ' + JSON.stringify(none));
            fb.forEach(function (m) { assert.match(m, /^[A-Z][A-Z-]*$/, m); });
            ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'CONNECT', 'TRACE'].forEach(function (m) {
                assert.ok(fb.indexOf(m) > -1, 'the fallback lists ' + m);
            });
        });
    });

    it('01.4  escapeRegExpSource leaves Node\'s methods as they are and makes every other token literal', function () {
        var h = loadHelpers();
        var ruleMethods = ['GET', 'POST', 'PUT', 'DELETE', 'GET,POST', 'POST,DELETE', 'UNLOCK', 'PROPPATCH', 'M-SEARCH'];
        http.METHODS.forEach(function (m) {
            assert.equal(h.escapeRegExpSource(m), m, m);
            ruleMethods.forEach(function (r) {
                assert.equal(new RegExp(h.escapeRegExpSource(m), 'i').test(r), new RegExp(m, 'i').test(r), m + ' vs ' + r);
            });
        });
        UNKNOWN.filter(function (m) { return m !== ''; }).forEach(function (m) {
            var re;
            assert.doesNotThrow(function () { re = new RegExp(h.escapeRegExpSource(m), 'i'); }, m);
            assert.equal(re.test(m), true, m + ' matches itself');
        });
        ['.', 'P.ST', '^', '|', '$', '.*'].forEach(function (m) {
            ruleMethods.forEach(function (r) {
                assert.equal(new RegExp(h.escapeRegExpSource(m), 'i').test(r), false, m + ' must not match ' + r);
            });
        });
    });

    it('01.5  an escaped run of `.*` is matched as text, without backtracking', function () {
        var h = loadHelpers();
        var re = new RegExp(h.escapeRegExpSource('.*'.repeat(400) + 'X'), 'i');
        var t0 = process.hrtime.bigint();
        ['GET', 'POST', 'DELETE', 'GET,POST'].forEach(function (r) { assert.equal(re.test(r), false, r); });
        var ms = Number(process.hrtime.bigint() - t0) / 1e6;
        assert.ok(ms < 200, 'took ' + ms.toFixed(1) + ' ms');
    });
});

// ---------------------------------------------------------------------------
describe('route-method-b1168 §02 — the guard and the escape in _handleDispatch', function () {

    var DISPATCH = activeLines(region(SERVER, 'var _handleDispatch = async function(', 'for (let name in routing)'));
    var GUARD    = "if ( !isKnownHttpMethod(req.method || req.headers[':method']) ) {";

    it('02.1  the guard answers 501 through throwError and returns', function () {
        var g = DISPATCH.indexOf(GUARD);
        assert.ok(g > -1, 'the guard');
        assert.equal(DISPATCH.indexOf(GUARD, g + 1), -1, 'one guard');
        assert.match(DISPATCH.slice(g, g + 300), /\{\s*return throwError\(res, 501, '[^']*', next\);\s*\}/);
    });

    it('02.2  the guard runs after the preflight answer and before the method is read, cached or matched', function () {
        var g        = DISPATCH.indexOf(GUARD);
        var pre      = DISPATCH.indexOf('if ( req.isPreflightRequest ) {');
        var read     = DISPATCH.indexOf(", method    = req.method || req.headers[':method']");
        var reMethod = DISPATCH.indexOf(', reMethod  = new RegExp(');
        var cached   = DISPATCH.indexOf("routingLib.getCached(req.method +':'+ pathname, req)");
        assert.ok(pre > -1 && read > -1 && reMethod > -1 && cached > -1, 'anchors');
        assert.ok(pre < g && g < read && read < reMethod && reMethod < cached, 'preflight → guard → method → regexp → route cache');
    });

    it('02.3  the regexp is built from the escaped method', function () {
        assert.match(DISPATCH, /,\s*reMethod\s*=\s*new RegExp\(\s*escapeRegExpSource\(\s*method\s*\)\s*,\s*'i'\s*\)/);
    });

    it('02.4  no active line of server.js builds a regexp from the method unescaped', function () {
        var live = activeLines(SERVER);
        assert.equal(/new RegExp\(\s*(?:req\.|request\.)?method\s*[,)]/.test(live), false);
        assert.ok(/new RegExp\(\s*escapeRegExpSource\(\s*method\s*\)/.test(live), 'control: the escaped form is found by the same reader');
    });
});

// ---------------------------------------------------------------------------
describe('route-method-b1168 §03 — the guard\'s own bytes, run on stub requests', function () {

    function runGuard(method) {
        var dispatch = activeLines(region(SERVER, 'var _handleDispatch = async function(', 'for (let name in routing)'));
        var g = dispatch.indexOf("if ( !isKnownHttpMethod(req.method || req.headers[':method']) ) {");
        assert.ok(g > -1, 'extraction control: the guard');
        var end = dispatch.indexOf('\n        }\n', g);
        assert.ok(end > g, 'extraction control: the guard closes');
        var block = dispatch.slice(g, end + 10);
        var calls = [];
        var throwError = function (res, code, msg, next) { calls.push({ code: code, msg: msg, res: res, next: next }); return 'answered'; };
        var res = { tag: 'res' }, next = function () {};
        var req = { method: method, headers: { ':method': method } };
        var out = new Function('req', 'res', 'next', 'isKnownHttpMethod', 'throwError', block + "\nreturn 'passed';")(
            req, res, next, loadHelpers().isKnownHttpMethod, throwError);
        return { out: out, calls: calls, res: res, next: next };
    }

    it('03.1  an unknown method is answered 501 on the request\'s own response, and the dispatch stops there', function () {
        UNKNOWN.forEach(function (m) {
            var r = runGuard(m);
            assert.equal(r.out, 'answered', JSON.stringify(m));
            assert.equal(r.calls.length, 1, JSON.stringify(m));
            assert.equal(r.calls[0].code, 501);
            assert.equal(r.calls[0].res, r.res);
            assert.equal(r.calls[0].next, r.next);
        });
    });

    it('03.1b the 501 does not echo the method it refuses', function () {
        var r = runGuard('ZQX.Y');
        assert.equal(r.calls.length, 1, 'control: the guard answered');
        assert.equal(String(r.calls[0].msg).indexOf('ZQX'), -1, String(r.calls[0].msg));
    });

    it('03.2  every method Node lists passes the guard untouched, in either case', function () {
        http.METHODS.forEach(function (m) {
            [m, m.toLowerCase()].forEach(function (v) {
                var r = runGuard(v);
                assert.equal(r.out, 'passed', v);
                assert.equal(r.calls.length, 0, v);
            });
        });
    });
});
