'use strict';
/**
 * #B841 — core/server.js's server-side `throwError` (also the engine instance's `throwError`, which
 * a bundle's `controllers/setup.js` receives as `this.throwError`) wrote an `Error` passed as its
 * message as `"error":{}` on the JSON bodies and as `[object Object]` in a custom error page's
 * `page.data.message`: an Error's `message` and `stack` are not enumerable, so `JSON.stringify`
 * drops them, and the custom page received the object itself. Outside the local scope the #B131
 * gate also deleted the CALLER's stack: `JSON.clone` hands an Error back as is, so the gate's
 * `delete` ran on the caller's object. Feeders that pass an Error: the POST and PATCH body
 * branches (a malformed `application/json` body reaches them; measured on a booted bundle),
 * `requireController`'s catch and the reverse-routing catch in router.js, and a bundle's setup.js.
 *
 * The fix reads an Error (`[object Error]`, so a subclass and another realm's Error count) as its
 * stack text right after the #ERRREF pairing line: the string the other feeders pass
 * (`err.stack`). The #B131 gate then keeps the stack in the local scope and the
 * `Error: <message>` line elsewhere; the custom page and the built-in page read text; the
 * caller's Error is never written.
 *
 *  01 extraction controls — the slice captured the real functions.
 *  02 JSON body over HTTP/1.1 and HTTP/2: `error` is the Error's text (local: its stack;
 *     elsewhere: its first line).
 *  03 custom error page data: `message` is that text, never the object.
 *  04 the built-in page: the Error's text, its stack in the local scope.
 *  05 the caller's Error keeps its stack outside the local scope.
 *  06 controls: a string message and a plain object take the paths they took before; a
 *     TypeError, an Error from another realm and an Error without a stack read as text.
 *  07 source pin: one guard, after the pairing line, before the gate's helper.
 *
 * Seam: GINA_SERVER_SRC=<absolute file> runs every arm against that text. Red-first against the
 * pre-change bytes (`git show <sha>:<fw>/core/server.js > <file>`): the Error arms of 02–06 and
 * 07 read RED; 01 and the 06 string / plain-object controls stay GREEN. No arm waits on a
 * callback of the code under test: each settles synchronously.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var crypto = require('crypto');
var vm     = require('vm');

var FW     = require('../fw');
var SOURCE = process.env.GINA_SERVER_SRC || path.join(FW, 'core/server.js');
require(path.join(FW, 'helpers')); // real safeDecodeURI, JSON.clone, count()
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
/** Drops full-line comments (`//`, `/*`, ` *`), so a `// was:` or a comment naming the guard cannot satisfy a pin. */
function stripComments(src) {
    return src.split('\n').filter(function (l) { return !/^\s*(\/\/|\*|\/\*)/.test(l); }).join('\n');
}

var TE_A   = once('    var throwError = function(res, code, msg, next) {');
var TE_END = once('\n};\n\nServer = inherits(Server, EventEmitter);');
var TE_SRC = SRC.slice(TE_A, TE_END);
var ESC2_SRC = SRC.slice(SRC.indexOf('function escapeLogControlChars(value) {'), SRC.indexOf('/**\n * #B662'));
var GRP_SRC  = sliceTo(once('    var getResponseProtocol = function (response) {'), '\n    }\n');
var MINT_SRC = sliceTo(once('var _mintErrorRef = function(supplied) {'), '\n};\n');
var ESC_SRC  = sliceTo(once('var _escapeHtml = function(value) {'), '\n};\n');
var LANG_SRC = sliceTo(once('var a11yLangTag = function(req) {'), '\n};\n');
var DOC_SRC  = sliceTo(once('var a11yErrorDocument = function(code, bodyHtml, req) {'), '\n};\n');

var H = new Function('crypto', MINT_SRC + ESC_SRC + LANG_SRC + DOC_SRC +
    '\nreturn { _mintErrorRef: _mintErrorRef, _escapeHtml: _escapeHtml, a11yErrorDocument: a11yErrorDocument };')(crypto);

/**
 * Compiles the real `throwError` + `getResponseProtocol` bytes with their closure inputs.
 *
 * @param {object}  o
 * @param {boolean} [o.local]      - what `self.isLocalScope()` answers
 * @param {boolean} [o.errorFiles] - whether a custom `500.html` is configured
 * @param {string}  [o.protocol]   - the bundle's `server.protocol` (`http/1.1` by default)
 * @param {boolean} [o.template]   - `false` models a bundle without templates (the JSON branch)
 * @returns {{throwError: Function, routes: object[], logs: string[]}}
 */
function makeServer(o) {
    var routes = [], logs = [];
    var local = { router: { route: function () {} }, hasViews: { fixtureapp: true } };
    var common = o.errorFiles ? { errorFiles: { 500: 'errors/500.html', '5xx': 'errors/5xx.html' } } : {};
    var self = {
        appName: 'fixtureapp', env: 'prod', instance: {},
        conf: { fixtureapp: { prod: {
            template: o.template !== false, encoding: 'utf-8',
            server: { protocol: o.protocol || 'http/1.1', response: { header: {} },
                coreConfiguration: { statusCodes: { 500: 'Internal Server Error' },
                                     mime: { html: 'text/html', json: 'application/json' } } },
            content: { templates: { _common: common } }
        } } },
        isLocalScope: function () { return !!o.local; },
        isCacheless: function () { return false; }
    };
    var completeHeaders = function (h) { return h; };
    var checkPreflightRequest = function (req) { return req; };
    var routingLib = { getRoute: function () { var r = { param: {} }; routes.push(r); return r; } };
    var con = { error: function (s) { logs.push(String(s)); }, log: function () {}, warn: function () {}, info: function () {}, debug: function () {} };
    var getResponseProtocol = new Function('local', 'self', GRP_SRC + '\nreturn getResponseProtocol;')(local, self);
    var throwError = new Function('local', 'self', 'hasViews', 'getResponseProtocol', '_mintErrorRef', 'checkPreflightRequest',
        'completeHeaders', 'safeDecodeURI', 'routingLib', '_escapeHtml', 'a11yErrorDocument', 'console',
        ESC2_SRC + TE_SRC + '\nreturn throwError;')(local, self, function () { return true; }, getResponseProtocol, H._mintErrorRef,
        checkPreflightRequest, completeHeaders, global.safeDecodeURI, routingLib, H._escapeHtml, H.a11yErrorDocument, con);
    return { throwError: throwError, routes: routes, logs: logs };
}

/** A request: `xhr` selects the JSON branch, an extensionless URL the HTML one. */
function mkReq(xhr, httpVersion) {
    return { method: 'POST', url: '/fixture/page', httpVersion: httpVersion || '1.1', isXMLRequest: !!xhr,
             headers: { 'user-agent': 'test/1' }, _ginaReqId: 'rid-1', routing: { rule: 'page@fixtureapp' } };
}
/** A native response (its own request on `res.req`); `h2` adds a stream the HTTP/2 branch writes to. */
function mkRes(req, h2) {
    var r = { req: req, headersSent: false, statusCode: 200, body: null, _h: {} };
    r.writeHead = function (code) { r.code = code; };
    r.end = function (b) { r.body = String(b); r.headersSent = true; };
    r.setHeader = function (k, v) { r._h[String(k).toLowerCase()] = v; };
    r.getHeader = function (k) { return r._h[String(k).toLowerCase()]; };
    r.getHeaders = function () { return r._h; };
    if (h2) {
        r.stream = { destroyed: false, closed: false,
            respond: function (h) { r.code = h[':status']; },
            end: function (b) { r.body = String(b); r.headersSent = true; } };
    }
    return r;
}
/** An Error with a fixed V8-shaped stack, so the arms read the same under every engine. */
function errWithStack(Ctor, message) {
    var e = new Ctor(message);
    e.stack = e.name + ': ' + message + '\n    at fixture (/srv/app/fixture.js:1:1)\n    at next (/srv/app/next.js:2:2)';
    return e;
}
/** Runs one error through a fresh server; returns the response and the custom page data. */
function drive(msg, o) {
    var S = makeServer(o);
    var req = mkReq(o.xhr, o.protocol === 'http/2.0' ? '2.0' : '1.1');
    var res = mkRes(req, o.protocol === 'http/2.0');
    S.throwError(res, 500, msg, function () {});
    var page = S.routes[0] && S.routes[0].param ? S.routes[0].param.error : null;
    return { res: res, page: page, logs: S.logs, json: (res.body && res.body.charAt(0) === '{') ? JSON.parse(res.body) : null };
}

// ─── 01 — extraction controls ────────────────────────────────────────────────
describe('#B841 §01 — extraction controls', function () {
    it('the throwError slice and its helpers were captured', function () {
        assert.ok(TE_SRC.indexOf('var sanitizeWireError = function(m, c)') > -1, 'the gate helper is inside the slice');
        assert.ok(TE_SRC.indexOf("console.error('[ BUNDLE ][ '+ self.appName") > -1, 'the pairing line is inside the slice');
        assert.equal(typeof makeServer({}).throwError, 'function');
    });
    it('the harness answers a string message (control: the extracted function runs end to end)', function () {
        var out = drive('plain failure', { xhr: true });
        assert.equal(out.res.code, 500);
        assert.equal(out.json.error, 'plain failure');
        assert.match(out.json.ref, /^[A-F0-9]{6}$/);
        assert.equal(out.logs.length, 1, 'one #ERRREF pairing line');
    });
});

// ─── 02 — JSON bodies ────────────────────────────────────────────────────────
describe('#B841 §02 — the JSON body carries the Error as text', function () {
    it('HTTP/1.1, outside the local scope: the first line of its stack', function () {
        var out = drive(errWithStack(Error, 'Could not parse application/json POST body.'), { xhr: true });
        assert.equal(out.res.code, 500);
        assert.equal(typeof out.json.error, 'string', 'pre-fix: {} (an Error serialises to an empty object)');
        assert.equal(out.json.error, 'Error: Could not parse application/json POST body.');
    });
    it('HTTP/1.1, local scope: its whole stack (the dev toolbar reads it, as for the string feeders)', function () {
        var e = errWithStack(Error, 'boom');
        var out = drive(e, { xhr: true, local: true });
        assert.equal(out.json.error, e.stack);
    });
    it('HTTP/1.1, local scope, the engine\'s own stack: written as the Error carries it', function () {
        var e = new Error('native stack');
        var out = drive(e, { xhr: true, local: true });
        assert.equal(typeof out.json.error, 'string');
        assert.equal(out.json.error, e.stack);
    });
    it('HTTP/2, outside the local scope: the same text on the stream', function () {
        var out = drive(errWithStack(Error, 'over h2'), { xhr: true, protocol: 'http/2.0' });
        assert.equal(out.res.code, 500);
        assert.equal(out.json.error, 'Error: over h2');
    });
    it('a bundle without templates answers JSON to a non-XHR request: the same text', function () {
        var out = drive(errWithStack(Error, 'no templates'), { template: false });
        assert.ok(out.json, 'CONTROL: the JSON branch was taken without XHR');
        assert.equal(out.json.error, 'Error: no templates');
    });
});

// ─── 03 — custom error page data ─────────────────────────────────────────────
describe('#B841 §03 — the custom error page receives text', function () {
    it('outside the local scope: page.data.message is the first line', function () {
        var out = drive(errWithStack(Error, 'Upstream down'), { errorFiles: true });
        assert.ok(out.page, 'the custom page was dispatched');
        assert.equal(typeof out.page.message, 'string', 'pre-fix: the Error object, rendered [object Object]');
        assert.equal(out.page.message, 'Error: Upstream down');
    });
    it('local scope: page.data.message is the stack, as for a stack passed as the message', function () {
        var e = errWithStack(Error, 'Upstream down');
        var out = drive(e, { errorFiles: true, local: true });
        assert.equal(out.page.message, e.stack);
    });
});

// ─── 04 — the built-in page ──────────────────────────────────────────────────
describe('#B841 §04 — the built-in page reads the Error as text', function () {
    function pre(body) { return ((body || '').match(/<pre>([\s\S]*?)<\/pre>/) || [])[1] || ''; }
    it('outside the local scope: its first line (unchanged: String(err) gave the same)', function () {
        var out = drive(errWithStack(Error, 'Fallback page'), {});
        assert.match(out.res.body, /^<!doctype html>/i);
        assert.equal(pre(out.res.body).split('\n')[0], 'Error: Fallback page');
    });
    it('local scope: its stack, as the string feeders show it', function () {
        var out = drive(errWithStack(Error, 'Fallback page'), { local: true });
        assert.ok(pre(out.res.body).indexOf('at fixture (/srv/app/fixture.js:1:1)') > -1, 'pre-fix: String(err) carried no frame');
    });
});

// ─── 05 — the caller's object ────────────────────────────────────────────────
describe('#B841 §05 — the caller\'s Error is never written', function () {
    it('outside the local scope its stack survives the call', function () {
        var e = errWithStack(Error, 'kept');
        var before = e.stack;
        drive(e, { xhr: true });
        assert.equal(e.stack, before, 'pre-fix: the gate deleted it (JSON.clone returns the same Error)');
        assert.equal(e.message, 'kept');
    });
    it('CONTROL: JSON.clone hands an Error back as is (the premise of the arm above)', function () {
        var e = new Error('premise');
        assert.equal(JSON.clone(e), e);
    });
});

// ─── 06 — controls and other Error shapes ────────────────────────────────────
describe('#B841 §06 — what is not an Error keeps its path; every Error reads as text', function () {
    it('CONTROL: a string carrying a stack is cut to its first line outside the local scope', function () {
        var out = drive('Could not evaluate PUT request data.\n    at x (/srv/x.js:1:1)', { xhr: true });
        assert.equal(out.json.error, 'Could not evaluate PUT request data.');
    });
    it('CONTROL: a plain object stays an object, its stack stripped outside the local scope', function () {
        var out = drive({ message: 'plain', stack: 'Error: plain\n    at y (/srv/y.js:1:1)' }, { xhr: true });
        assert.deepEqual(out.json.error, { message: 'plain' });
    });
    it('a TypeError reads as its own first line', function () {
        var out = drive(errWithStack(TypeError, 'x is not a function'), { xhr: true });
        assert.equal(out.json.error, 'TypeError: x is not a function');
    });
    it('an Error from another realm is recognised', function () {
        var e = vm.runInNewContext('var e = new Error("other realm"); e.stack = "Error: other realm\\n    at r (/srv/r.js:1:1)"; e');
        assert.equal(e instanceof Error, false, 'CONTROL: instanceof cannot see it');
        var out = drive(e, { xhr: true });
        assert.equal(out.json.error, 'Error: other realm');
    });
    it('an Error without a stack reads as String(err)', function () {
        var e = new Error('stackless');
        e.stack = undefined;
        var out = drive(e, { xhr: true });
        assert.equal(out.json.error, 'Error: stackless');
    });
    it('the pairing line still carries the full stack (it is built before the guard)', function () {
        var out = drive(errWithStack(Error, 'logged'), { xhr: true });
        assert.equal(out.logs.length, 1);
        assert.ok(out.logs[0].indexOf('at fixture (/srv/app/fixture.js:1:1)') > -1);
    });
});

// ─── 07 — source pin ─────────────────────────────────────────────────────────
describe('#B841 §07 — one guard, between the pairing line and the gate', function () {
    var T = stripComments(TE_SRC);
    var GUARD = "if ( Object.prototype.toString.call(msg) === '[object Error]' ) {";
    it('CONTROL: the comment strip drops a full-line comment and keeps code', function () {
        assert.equal(stripComments('a();\n    // was: b();\n    c();'), 'a();\n    c();');
    });
    it('exactly one guard in the active code', function () {
        assert.equal(T.split(GUARD).length - 1, 1);
    });
    it('after the pairing line, before the gate helper and its first call', function () {
        var g = T.indexOf(GUARD);
        var pair = T.indexOf("console.error('[ BUNDLE ][ '+ self.appName");
        var helper = T.indexOf('var sanitizeWireError = function(m, c)');
        assert.ok(pair > -1 && helper > -1, 'CONTROL: both anchors are in the active code');
        assert.ok(pair < g, 'the pairing line logs the Error before it is read as text');
        assert.ok(g < helper, 'outside the helper slice that server-throwerror-stack-gate §02 executes');
    });
});
