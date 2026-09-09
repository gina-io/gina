'use strict';
/**
 * #B533 — `helpers/context.js`'s `throwError` (the twin behind the implicit-global `getConfig`
 * / `getLib`, reached when a configuration slice or a library cannot be resolved during a live
 * request) now honours the #ERRREF contract its two request-facing twins already implement: an
 * incident `ref` on the wire, ONE full-detail pairing line in the log BEFORE the wire write, and
 * the stack kept off the wire outside local scope. It used to put `err.stack` on the wire
 * verbatim in every scope and record nothing.
 *
 * Drives the SHIPPED bytes: the function text is sliced out of `helpers/context.js` and compiled
 * under `new Function('getContext', 'console', '_mintErrorRef', 'process', …)` — every free
 * identifier it closes over is injected — and §02's first arm proves the harness reproduces the
 * KNOWN pre-fix behaviour (a frozen verbatim copy of the pre-#B533 function, same harness)
 * before any post-fix reading is trusted. The mint used is the shipped one, compiled from the
 * same file.
 *
 * Red-first: `GINA_CONTEXT_SRC=<pre-#B533 blob> node --test <this file>` — the §01 pins and the
 * §02 post-fix arms go red; the arms labelled CONTROL pin what the change kept and stay green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW      = require('../fw');
var SOURCE  = process.env.GINA_CONTEXT_SRC || path.join(FW, 'helpers/context.js');
var SRC     = fs.readFileSync(SOURCE, 'utf8');
var SRV_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');

var MINT_RE = /var _mintErrorRef = function\(supplied\) \{[\s\S]*?\n\};/;   // the #ERRREF twin regex (error-ref.test.js)

function block() {
    var start = SRC.indexOf('var throwError = function(code, err, isFatal) {');
    assert.ok(start > -1, 'throwError declaration present in helpers/context.js');
    var end   = SRC.indexOf('getConfig = function', start);
    assert.ok(end > start, 'getConfig follows throwError (end anchor)');
    return SRC.slice(start, end);
}
function strip(s) { return s.replace(/^\s*\/\/.*$/gm, ''); }
function fnText(src) {                       // the function expression, closed at its final `throw err`
    var a = src.indexOf('function(code, err, isFatal) {');
    var z = src.indexOf('throw err', a);
    assert.ok(a > -1 && z > a, 'function bounds resolve');
    return src.slice(a, z + 'throw err'.length) + '\n}';
}

// The shipped mint, compiled from the file under test; a stub when the file predates it (red-first).
var MINT = (function () {
    var m = SRC.match(MINT_RE);
    if (!m) { return function () { return 'STUB00'; }; }
    return new Function('crypto', m[0] + '\nreturn _mintErrorRef;')(require('crypto'));
})();

// Frozen VERBATIM copy of the pre-#B533 function (helpers/context.js @ v0.6.29, md5
// 5bbff128885c6e62dc3e58d7cd5cf707) — the subtract control and the harness's instrument check.
var PRE_FIX_FN = [
"function(code, err, isFatal) {",
"",
"        if (arguments.length < 2) {",
"            err     = code;",
"            code    = 500",
"        }",
"",
"        var router  = getContext('router')",
"            , res   = ( router ) ? router.response : null",
"            , next  = ( router ) ? router.next : null",
"        ;",
"",
"        if ( res && !res.headersSent ) {",
"            var hasViews          = router.hasViews",
"                , isUsingTemplate = isUsingTemplate",
"            ;",
"",
"            if ( !hasViews || !isUsingTemplate ) {",
"                res.writeHead(code, { 'Content-Type': 'application/json'} );",
"                res.end(JSON.stringify({",
"                    status: code,",
"                    error: 'Error '+ code +'. '+ err.stack",
"                }))",
"            } else {",
"                res.writeHead(code, { 'Content-Type': 'text/html'} );",
"                res.end('<h1>Error '+ code +'.</h1><pre>'+ err.stack + '</pre>')",
"            }",
"            return;",
"        }",
"",
"        if ( res && res.headersSent && typeof next == 'function' ) {",
"            next();",
"            return;",
"        }",
"",
"        if ( isFatal && /^true$/.test(isFatal) ) {",
"            console.emerg(err.stack||err.message||err);",
"            return;",
"        }",
"",
"        throw err",
"}"].join('\n');

function makeRes(headersSent, req) {
    var sink = { code: null, headers: null, body: null, ended: false, logsAtEnd: -1, nextCalled: false };
    var res  = {
        headersSent : !!headersSent,
        req         : ( req === null ) ? undefined : ( req || { method: 'GET', url: '/x', _ginaReqId: 'r-1' }),
        writeHead   : function (c, h) { sink.code = c; sink.headers = h; },
        end         : function (b) { sink.body = b; sink.ended = true; sink.logsAtEnd = sink._logs ? sink._logs.length : -1; }
    };
    return { res: res, sink: sink };
}
function harness(src, opts) {
    var logs = [], emergs = [];
    var console_ = { error: function (m) { logs.push(String(m)); }, emerg: function (m) { emergs.push(String(m)); } };
    var ctx = { router: opts.router, bundle: opts.bundle };
    var getContext = function (k) { return ctx[k]; };
    var proc = { env: {} };
    if (typeof opts.scope !== 'undefined') { proc.env.NODE_SCOPE_IS_LOCAL = opts.scope; }
    var fn = new Function('getContext', 'console', '_mintErrorRef', 'process', 'return (' + src + ');')(getContext, console_, MINT, proc);
    return { fn: fn, logs: logs, emergs: emergs };
}
function live(opts) {                         // a live, writable response wired into the router slot
    var r = makeRes(false, opts && opts.req);
    var h = harness(opts && opts.pre ? PRE_FIX_FN : fnText(block()), {
        router : { response: r.res, next: function () { r.sink.nextCalled = true; }, hasViews: false, isUsingTemplate: false },
        bundle : 'demo',
        scope  : opts ? opts.scope : 'false'
    });
    r.sink._logs = h.logs;
    return { fn: h.fn, sink: r.sink, logs: h.logs, emergs: h.emergs, body: function () { return JSON.parse(r.sink.body); } };
}
var FRAME = /\n\s+at\s/;


describe('01 - #B533 source pins on the live-request branch', function () {

    it('_mintErrorRef is declared exactly once in context.js, at column 0, byte-identical to the server.js twin', function () {
        var decls = SRC.match(/^var _mintErrorRef = function\(supplied\)/gm) || [];
        assert.equal(decls.length, 1, 'exactly one module-level declaration');
        var mine = SRC.match(MINT_RE), theirs = SRV_SRC.match(MINT_RE);
        assert.ok(mine && theirs, 'both mints extract');
        assert.equal(mine[0], theirs[0], 'the third copy is byte-identical to the server.js twin');
    });

    it('the live branch mints the ref BEFORE the wire write', function () {
        var b = block();
        var mint = b.indexOf('_mintErrorRef('), end = b.indexOf('res.end(');
        assert.ok(mint > -1 && end > -1 && mint < end, 'mint precedes res.end');
    });

    it('the pairing line carries [ ref ] + [ req ] and precedes res.writeHead', function () {
        var b = block();
        assert.ok(b.indexOf("[ ref '+ ref +' ][ req '") > -1, 'the ref/req pair is on the log line');
        var log = b.indexOf('console.error('), head = b.indexOf('res.writeHead(');
        assert.ok(log > -1 && head > -1 && log < head, 'the log line precedes the wire write');
    });

    it('the wire literal carries the top-level ref field', function () {
        assert.equal((block().match(/ref\s*:\s*ref/g) || []).length, 1);
    });

    it('the wire detail is scope-gated on the fail-closed NODE_SCOPE_IS_LOCAL read', function () {
        assert.ok(block().indexOf('/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)') > -1);
    });

    it('the retired verbatim-stack wire literal is gone from the live code (comment-stripped)', function () {
        assert.ok(strip(block()).indexOf("'. '+ err.stack") < 0, 'no verbatim-stack wire literal');
    });

    it('the strip is load-bearing: the raw branch names #B533 in a comment and the stripped copy does not', function () {
        var b = block();
        assert.ok(b.indexOf('#B533') > -1, 'raw names #B533');
        assert.ok(strip(b).indexOf('#B533') < 0, 'stripped copy does not');
    });

    it('the dead HTML arm (#B254) is gone: no text/html write, no isUsingTemplate self-assignment', function () {
        var c = strip(block());
        assert.ok(c.indexOf('text/html') < 0, 'no HTML arm');
        assert.ok(c.indexOf('isUsingTemplate') < 0, 'no self-assigned local');
    });

    it('CONTROL — the detached-context structure is untouched (arguments before the slot read, next() before console.emerg(, throw err last)', function () {
        var b = block();
        assert.ok(b.indexOf('arguments.length < 2') < b.indexOf("getContext('router')"));
        assert.ok(b.indexOf('next();') > -1 && b.indexOf('next();') < b.indexOf('console.emerg('));
        assert.ok(b.indexOf('throw err') > b.indexOf('console.emerg('));
    });
});


describe('02 - #B533 behaviour, the shipped branch compiled from the source', function () {

    it('CONTROL — instrument: the harness reproduces the KNOWN pre-fix behaviour (stack on the wire, nothing logged, no ref)', function () {
        var L = live({ pre: true, scope: 'false' });
        L.fn(500, new Error('boom'));
        var body = L.body();
        assert.ok(FRAME.test(body.error), 'pre-fix: stack frames reach the wire');
        assert.equal(typeof body.ref, 'undefined', 'pre-fix: no ref');
        assert.equal(L.logs.length, 0, 'pre-fix: nothing logged');
    });

    it('non-local scope: the wire carries status + the message line + a 6-hex ref, and NO stack frame', function () {
        var L = live({ scope: 'false' });
        L.fn(500, new Error('boom'));
        var body = L.body();
        assert.equal(L.sink.code, 500);
        assert.equal(L.sink.headers['Content-Type'], 'application/json');
        assert.equal(body.status, 500);
        assert.equal(body.error, 'Error 500. boom');
        assert.ok(!FRAME.test(body.error), 'no frames on the wire');
        assert.match(body.ref, /^[0-9A-F]{6}$/);
    });

    it('non-local scope: ONE pairing line carries the ref, the request id, method, url and the FULL stack', function () {
        var L = live({ scope: 'false' });
        L.fn(500, new Error('boom'));
        var body = L.body();
        assert.equal(L.logs.length, 1, 'exactly one log line');
        assert.ok(L.logs[0].indexOf('[ ref ' + body.ref + ' ]') > -1, 'the wire ref is on the line');
        assert.ok(L.logs[0].indexOf('[ req r-1 ]') > -1, 'the request id is on the line');
        assert.ok(L.logs[0].indexOf('GET [ 500 ] /x') > -1, 'method, code, url');
        assert.ok(L.logs[0].indexOf('[ CONTEXT ][ demo ]') > -1, 'the bundle from the context');
        assert.ok(FRAME.test(L.logs[0]), 'the stack is in the log');
        assert.equal(L.emergs.length, 0, 'emerg is not the live-path logger');
    });

    it('the pairing line lands BEFORE the wire write', function () {
        var L = live({ scope: 'false' });
        L.fn(500, new Error('boom'));
        assert.equal(L.sink.logsAtEnd, 1, 'one line already logged when res.end ran');
    });

    it('local scope: the error string keeps the stack (dev toolbar) and still gains the ref + the log line', function () {
        var L = live({ scope: 'true' });
        L.fn(500, new Error('boom'));
        var body = L.body();
        assert.ok(FRAME.test(body.error), 'stack on the wire in local scope');
        assert.match(body.ref, /^[0-9A-F]{6}$/);
        assert.equal(L.logs.length, 1);
    });

    it('local scope: the error string is byte-identical to the pre-fix wire for an Error without a cause', function () {
        var err = new Error('same');
        var A = live({ pre: true, scope: 'true' }); A.fn(500, err);
        var B = live({ scope: 'true' });            B.fn(500, err);
        assert.equal(B.body().error, A.body().error);
    });

    it('an UNSET NODE_SCOPE_IS_LOCAL strips (fail-closed)', function () {
        var L = live({ scope: undefined });
        L.fn(500, new Error('boom'));
        assert.ok(!FRAME.test(L.body().error));
    });

    it('Error.cause reaches the log, never the wire (non-local)', function () {
        var err = new Error('outer'); err.cause = new Error('root-cause-detail');
        var L = live({ scope: 'false' });
        L.fn(500, err);
        assert.ok(L.logs[0].indexOf('caused by: ') > -1 && L.logs[0].indexOf('root-cause-detail') > -1, 'cause in the log');
        assert.ok(L.body().error.indexOf('root-cause-detail') < 0, 'cause not on the wire');
    });

    it('the one-argument string form reports the string, not "undefined" (the pre-fix wire did)', function () {
        var P = live({ pre: true, scope: 'false' }); P.fn('boom-string');
        var L = live({ scope: 'false' });            L.fn('boom-string');
        assert.equal(P.body().error, 'Error 500. undefined', 'pre-fix discriminator');
        assert.equal(L.body().error, 'Error 500. boom-string');
    });

    it('a relay-safe err.ref is honoured; a hostile one is re-minted', function () {
        var a = new Error('x'); a.ref = 'abc-1.2';
        var A = live({ scope: 'false' }); A.fn(500, a);
        assert.equal(A.body().ref, 'abc-1.2');
        var b = new Error('x'); b.ref = '<script>x</script>';
        var B = live({ scope: 'false' }); B.fn(500, b);
        assert.match(B.body().ref, /^[0-9A-F]{6}$/);
    });

    it('a null err on a live response no longer throws inside throwError', function () {
        var L = live({ scope: 'false' });
        assert.doesNotThrow(function () { L.fn(500, null); });
        assert.equal(L.body().error, 'Error 500. null');
    });

    it('a response without res.req logs the pair with placeholders, never throws', function () {
        var L = live({ scope: 'false', req: null });
        L.fn(500, new Error('boom'));
        assert.ok(L.logs[0].indexOf('[ req - ] - [ 500 ] -') > -1);
    });

    it('CONTROL — headers already sent + callable next: hands back to the chain, writes nothing, logs nothing (unchanged)', function () {
        var r = makeRes(true);
        var h = harness(fnText(block()), { router: { response: r.res, next: function () { r.sink.nextCalled = true; } }, scope: 'false' });
        h.fn(500, new Error('boom'));
        assert.equal(r.sink.nextCalled, true);
        assert.equal(r.sink.ended, false);
        assert.equal(h.logs.length, 0);
    });

    it('CONTROL — no live response + isFatal: emerg-logs and returns (unchanged)', function () {
        var h = harness(fnText(block()), { router: undefined, scope: 'false' });
        assert.doesNotThrow(function () { h.fn(500, new Error('boom'), true); });
        assert.equal(h.emergs.length, 1);
        assert.equal(h.logs.length, 0);
    });

    it('CONTROL — no live response, no isFatal: throws (unchanged)', function () {
        var h = harness(fnText(block()), { router: undefined, scope: 'false' });
        assert.throws(function () { h.fn(500, new Error('boom')); }, /boom/);
    });
});
