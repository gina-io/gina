'use strict';
/**
 * #B534 — `throwError` must answer the request whose call failed, not whichever
 * request the process-wide `router` context slot saw last.
 *
 * `core/router.js` stores `{response, next, …}` under the `router` context key on
 * every routed request and never clears it, and `helpers/context.js`'s throwError
 * read that slot to find a response. Under concurrency the slot is the wrong
 * request as often as the right one: request A is routed (slot=A), awaits a query;
 * request B is routed (slot=B); A's callback then fails inside `getConfig()` or
 * `getLib()`, throwError reads the slot, finds B's response with headers unsent,
 * and writes A's failure to B's client — while A is never answered at all and
 * hangs to the server timeout. The #B533 pairing line made it worse rather than
 * better: it derived the request from `res.req`, so it printed B's request id
 * beside A's incident ref, and a confidently mislabelled correlation line is worse
 * than none.
 *
 * The fix prefers the per-request AsyncLocalStorage store that `server.js handle()`
 * establishes for every request on both engines (and which propagates across
 * await), falling back to the slot only for a caller that has no store at all —
 * boot, CLI, cron, worker — which is the case the slot was there for.
 *
 * Coverage: source pins · a two-context concurrency drive · the pairing-line
 * attribution · the no-store fallback (behaviour deliberately preserved) · and a
 * frozen PRE-FIX copy driven through the same scene, which must still answer the
 * wrong response — without that arm the concurrency assertions could pass on a
 * harness that never reproduced the defect at all.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('node:fs');
var path   = require('node:path');
var { AsyncLocalStorage } = require('node:async_hooks');

var FW  = require('../fw');
var SRC = fs.readFileSync(path.join(FW, 'helpers/context.js'), 'utf8');
var SERVER_SRC = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');

/** The whole throwError function, sliced exactly as the #B533 egress test does. */
function block() {
    var start = SRC.indexOf('var throwError = function(code, err, isFatal) {');
    assert.ok(start > -1, 'throwError declaration present in helpers/context.js');
    var end = SRC.indexOf('getConfig = function', start);
    assert.ok(end > start, 'getConfig follows throwError (end anchor)');
    return SRC.slice(start, end);
}
function fnText(src) {                       // the function expression, closed at its final `throw err`
    var a = src.indexOf('function(code, err, isFatal) {');
    var z = src.indexOf('throw err', a);
    assert.ok(a > -1 && z > a, 'function bounds resolve');
    return src.slice(a, z + 'throw err'.length) + '\n}';
}

/** Derive the PRE-FIX text from the shipped text, so the subtract cannot drift. */
var STORE_READ = "var _fromStore = ( _reqStore && _reqStore.res ) ? true : false;";
function preFixText() {
    var b = block();
    assert.ok(b.indexOf(STORE_READ) > -1, 'control: the fixed source must contain the store read');
    var pre = b
        .replace("res   = ( _fromStore ) ? _reqStore.res  : ( ( router ) ? router.response : null )",
                 "res   = ( router ) ? router.response : null")
        .replace("next  = ( _fromStore ) ? _reqStore.next : ( ( router ) ? router.next : null )",
                 "next  = ( router ) ? router.next : null")
        .replace("var _req        = ( _fromStore && _reqStore.req ) ? _reqStore.req : ( ( res.req ) ? res.req : null );",
                 "var _req        = ( res.req ) ? res.req : null;");
    assert.notEqual(pre, b, 'the subtract must actually change the bytes it executes');
    return fnText(pre);
}

var MINT = function (ref) { return ref || 'ABC123'; };

function makeRes(label) {
    var sink = { label: label, code: null, body: null, ended: false, nextCalled: false };
    var res = {
        headersSent : false,
        req         : { method: 'GET', url: '/' + label, _ginaReqId: 'req-' + label },
        writeHead   : function (c) { sink.code = c; },
        end         : function (b) { sink.body = b; sink.ended = true; }
    };
    return { res: res, sink: sink };
}

/**
 * Lift throwError with a `process` that carries a real _reqALS, so the store path
 * is exercised. `slotRes` is what the never-cleared router slot holds.
 */
function harness(src, slotRes, als) {
    var logs = [];
    var console_ = { error: function (m) { logs.push(String(m)); }, emerg: function (m) { logs.push('EMERG ' + m); } };
    var ctx = {
        router : slotRes ? { response: slotRes.res, next: function () { slotRes.sink.nextCalled = true; } } : null,
        bundle : 'demo'
    };
    var getContext = function (k) { return ctx[k]; };
    var proc = { env: { NODE_SCOPE_IS_LOCAL: 'false' }, gina: als ? { _reqALS: als } : undefined };
    var fn = new Function('getContext', 'console', '_mintErrorRef', 'process',
        'return (' + src + ');')(getContext, console_, MINT, proc);
    return { fn: fn, logs: logs };
}

describe('#B534 — throwError answers the failing request, not the last-routed one', function () {

    describe('01 — source pins', function () {
        var b = block();

        it('the request store is consulted BEFORE the router slot', function () {
            var store = b.indexOf('_reqALS');
            var slot  = b.indexOf("getContext('router')");
            assert.ok(store > -1, 'throwError must consult process.gina._reqALS');
            assert.ok(slot > -1, 'the slot must remain as the req-less fallback');
            assert.ok(store < slot, 'the store is read first');
        });

        it('`process` is guarded before `.gina` is dereferenced', function () {
            assert.ok(b.indexOf("typeof(process) != 'undefined' && process.gina && process.gina._reqALS") > -1,
                'an unguarded process.gina read would throw in a stubbed harness');
        });

        it('res and next come from the SAME source', function () {
            assert.ok(b.indexOf("next  = ( _fromStore ) ? _reqStore.next :") > -1,
                'pairing a store response with the slot next would hand on a stale callback');
        });

        it('the pairing line derives its request from the same source as res', function () {
            assert.ok(b.indexOf("( _fromStore && _reqStore.req ) ? _reqStore.req :") > -1,
                'the #B533 pairing line must not name a different request than res belongs to');
        });

        it('server.js carries the request trio in the store', function () {
            var i = SERVER_SRC.indexOf('var _reqStore = {');
            var j = SERVER_SRC.indexOf('};', i);
            var lit = SERVER_SRC.slice(i, j);
            ['req       : req', 'res       : res', 'next      : next'].forEach(function (k) {
                assert.ok(lit.indexOf(k) > -1, 'the store literal must carry ' + k);
            });
        });
    });

    describe('02 — the concurrency drive (two interleaved requests)', function () {

        // A is routed, then B is routed (so the slot holds B), then A's detached
        // callback fails. This is the exact interleaving the bug describes.
        async function drive(src) {
            var als = new AsyncLocalStorage();
            var A = makeRes('A');
            var B = makeRes('B');
            var H = harness(src, B, als);              // slot holds B — the last routed
            await als.run({ req: A.res.req, res: A.res, next: function () {} }, async function () {
                await new Promise(function (r) { setTimeout(r, 2); });   // A awaits, B routes meanwhile
                H.fn(500, new Error('A failed'));
            });
            return { A: A.sink, B: B.sink, logs: H.logs };
        }

        it("A's failure is written to A's response, and B's is untouched", async function () {
            var r = await drive(fnText(block()));
            assert.equal(r.A.ended, true, "A's own response must be answered");
            assert.equal(r.A.code, 500);
            assert.equal(r.B.ended, false, "B's response must NOT be written to");
            assert.equal(r.B.code, null);
        });

        it("the pairing line names A's request id, not B's", async function () {
            var r = await drive(fnText(block()));
            assert.equal(r.logs.length, 1, 'exactly one pairing line');
            assert.ok(r.logs[0].indexOf('[ req req-A ]') > -1, 'the line must name the failing request');
            assert.ok(r.logs[0].indexOf('req-B') === -1, 'it must not name the last-routed request');
        });

        it('SUBTRACT (control): the frozen pre-fix copy answers B and mislabels the line', async function () {
            var r = await drive(preFixText());
            assert.equal(r.B.ended, true, "pre-fix: B's response IS written to — the harness reproduces the defect");
            assert.equal(r.A.ended, false, "pre-fix: A is never answered");
            assert.ok(r.logs[0].indexOf('[ req req-B ]') > -1, 'pre-fix: the pairing line names the WRONG request');
        });
    });

    describe('03 — the no-store fallback is preserved', function () {

        it('a caller with no store at all still answers through the slot', function () {
            var S = makeRes('S');
            var H = harness(fnText(block()), S, null);   // no _reqALS on process at all
            H.fn(500, new Error('detached'));
            assert.equal(S.sink.ended, true, 'boot / CLI / cron callers keep the slot behaviour');
            assert.equal(S.sink.code, 500);
        });

        it('a store that exists but holds no response also falls back', async function () {
            var als = new AsyncLocalStorage();
            var S = makeRes('S');
            var H = harness(fnText(block()), S, als);
            await als.run({ requestId: 'x', startMs: Date.now(), proxy: null }, async function () {
                H.fn(500, new Error('storeless'));
            });
            assert.equal(S.sink.ended, true, 'a logger-shaped store without res must not break the fallback');
        });
    });
});
