'use strict';
/**
 * #B675 — a HEAD served by a GET rule gave the action an undefined `req.get`.
 *
 * gina serves HEAD on every rule that serves GET and runs the GET action in full, so the
 * headers a HEAD answers with (content-type, cache-control, etag) are the ones a GET would
 * send (RFC 9110 §9.3.2). processRequestData keeps a HEAD's params in `req.head` and clears
 * `req.get`, so a GET action reading `req.get.<param>` without a guard threw on the undefined
 * bag and the request answered 500. Fix: once a rule has matched, `_handleDispatch`
 * (core/server.js) exposes the settled `req.head` as `req.get` — the same object — as the
 * first statement inside `if (matched) {`.
 *
 * §01 pins the statement and its placement on the comment-stripped source; §02 lifts the
 * statement out of the SHIPPED source and executes it (its only free identifier is `req`).
 * The booted twin is test/integration/container-boot-head-b675.test.js. Red-first:
 * GINA_SERVER_SRC=<pre-fix server.js> reds §01 and every §02 arm that runs the lifted
 * statement; §02.5, the firing control, does not read server.js.
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

var GATE       = "if ( /^head$/i.test(req.method) && typeof(req.head) == 'object' && req.head !== null ) {";
var ALIAS      = 'req.get = req.head;';
var MATCHED    = 'if (matched) {';
var RESTORE    = 'if (typeof(req[_reqMethodKey]) == "undefined") {';
var CACHE_READ = 'if ( await tryServeRenderCacheHit(req, res, bundle) ) {';

function count(hay, needle) { return hay.split(needle).length - 1; }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&'); }

/**
 * The alias statement as it ships: its gate, its body, its closing brace.
 *
 * @returns {string} The statement's source text
 */
function liftStatement() {
    var at = SERVER_ST.indexOf(GATE);
    assert.ok(at > -1, 'extraction control: the gated alias exists in the source');
    var close = SERVER_ST.indexOf('}', at + GATE.length);
    assert.ok(close > -1, 'extraction control: the gate closes');
    assert.equal(SERVER_ST.slice(at + GATE.length, close).trim(), ALIAS, 'extraction control: the gate holds the alias and nothing else');
    return SERVER_ST.slice(at, close + 1);
}

/**
 * Runs the shipped statement against a request object.
 *
 * @param {object} req - The request as it reaches `if (matched) {`
 * @returns {object} The same request
 */
function runAlias(req) {
    new Function('req', "'use strict';\n" + liftStatement())(req);
    return req;
}

/** A GET action that reads `req.get` without a guard, as a bundle action written for GET does. */
function getAction(req) { return { id: req.get.id, x: req.get.x }; }


// ---------------------------------------------------------------------------
describe('head-req-get-b675 §01 — the alias in _handleDispatch', function () {

    it('01.1  the alias exists once in the live code, inside its HEAD gate and alone there', function () {
        assert.equal(count(SERVER_ST, ALIAS), 1, 'one alias statement');
        assert.equal(count(SERVER_ST, GATE), 1, 'one gate');
        liftStatement();
    });

    it('01.2  it is the first statement inside `if (matched) {`, before the render-cache read', function () {
        assert.equal(count(SERVER_ST, MATCHED), 1, 'control: the dispatch branch is found once');
        assert.equal(count(SERVER_ST, CACHE_READ), 1, 'control: the render-cache read is found once');
        var re = new RegExp(escapeRe(MATCHED) + '\\s*' + escapeRe(GATE) + '\\s*' + escapeRe(ALIAS) + '\\s*\\}\\s*' + escapeRe(CACHE_READ));
        assert.match(SERVER_ST, re);
    });

    it('01.3  it runs after the routing loop and the post-loop restore that settles `req.head`', function () {
        var LOOP_END = '} // EO for (let name in routing) {';
        assert.equal(count(SERVER_ST, LOOP_END), 1, 'control: the routing loop end is found once');
        assert.equal(count(SERVER_ST, RESTORE), 1, 'control: the restore is found once');
        var loopEnd = SERVER_ST.indexOf(LOOP_END);
        var restore = SERVER_ST.indexOf(RESTORE);
        var alias   = SERVER_ST.indexOf(GATE);
        assert.ok(alias > loopEnd, 'the alias follows the routing loop');
        assert.ok(alias > restore && restore > loopEnd, 'the alias follows the restore');
    });

    it('01.4  CONTROL — the strip is proven: the comment above the alias is in the raw source and not in the stripped one', function () {
        assert.ok(SERVER.indexOf('// #B675 — a HEAD served by a GET rule') > -1);
        assert.equal(SERVER_ST.indexOf('#B675'), -1);
    });
});


// ---------------------------------------------------------------------------
describe('head-req-get-b675 §02 — the lifted statement, executed', function () {

    it('02.1  HEAD: `req.get` becomes `req.head` itself, and a GET action reads its params', function () {
        var head = { id: '5', x: '1' };
        var req = runAlias({ method: 'HEAD', get: undefined, head: head });
        assert.equal(req.get, head, 'the same object, not a copy');
        assert.equal(req.head, head, '`req.head` is unchanged');
        assert.deepEqual(getAction(req), { id: '5', x: '1' });
        assert.equal(req.method, 'HEAD', '`req.method` stays HEAD');
    });

    it('02.2  GET: `req.get` is left as it was', function () {
        var get = { id: '5' }, head = {};
        var req = runAlias({ method: 'GET', get: get, head: head });
        assert.equal(req.get, get);
        assert.equal(req.head, head);
    });

    it('02.3  HEAD without a settled `req.head` object: `req.get` is left as it was', function () {
        assert.equal(runAlias({ method: 'HEAD', get: undefined, head: null }).get, undefined, 'head null');
        assert.equal(runAlias({ method: 'HEAD', get: undefined, head: undefined }).get, undefined, 'head undefined');
    });

    it('02.4  another method with a `req.head` object: `req.get` is left as it was', function () {
        ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].forEach(function (m) {
            var req = runAlias({ method: m, get: undefined, head: { id: '5' } });
            assert.equal(req.get, undefined, m);
        });
    });

    it('02.5  CONTROL — without the alias (the pre-fix request), the same GET action throws on HEAD', function () {
        var req = { method: 'HEAD', get: undefined, head: { id: '5', x: '1' } };
        assert.throws(function () { getAction(req); }, TypeError);
    });
});
