'use strict';
/**
 * #B543 — `throwError` (helpers/context.js) must not answer the process-wide
 * `router` slot's response when the caller runs under a DETACHED request store.
 *
 * Since #B534 the builder prefers the per-request AsyncLocalStorage store and
 * falls back to the never-cleared `router` slot only for a caller with no store
 * at all. `lib/job` now runs every queued job inside a detached copy of the
 * creating request's context — `{ requestId, startMs, proxy, detached: true }`,
 * deliberately without `req` / `res` / `next`, because the job runs after the
 * response has gone out. Measured on the shipped builder before this fix: such a
 * store has no `res`, so `_fromStore` was false and the SLOT supplied the
 * response — a job's `getConfig()` / `getLib()` failure was written to whichever
 * request had been routed LAST.
 *
 * The fix is one clause after the `next` derivation: a store flagged
 * `detached === true` that did not itself supply `res` nulls `res` and `next`,
 * so the caller falls through to the emerg-log (fatal) / throw (non-fatal)
 * branches. A store that DID supply a live `res` is untouched by the flag, and a
 * store without the flag keeps the #B534 fallback.
 *
 * Harness: the function text is sliced out of the source and compiled under
 * `new Function('getContext', 'console', '_mintErrorRef', 'process', …)`, as the
 * #B533 egress and #B534 request-scope tests do; the SUBTRACT arm derives the
 * pre-fix text from the shipped text and proves the harness reproduces the
 * defect. Seam: `GINA_CONTEXT_SRC=<pre-fix helpers/context.js> node --test
 * <this file>` — §01 and the two detached arms go red; CONTROL arms stay green.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('node:fs');
var path   = require('node:path');
var { AsyncLocalStorage } = require('node:async_hooks');

var FW     = require('../fw');
var SOURCE = process.env.GINA_CONTEXT_SRC || path.join(FW, 'helpers/context.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

/** The whole throwError function, sliced exactly as the #B533 / #B534 tests do. */
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

var DETACHED_GUARD = 'if ( _reqStore && _reqStore.detached === true && !_fromStore ) {';
var NEXT_LINE      = 'next  = ( _fromStore ) ? _reqStore.next : ( ( router ) ? router.next : null )';
var LIVE_BRANCH    = 'if ( res && !res.headersSent ) {';

/** Derive the PRE-FIX text from the shipped text: the guard can never fire. */
function preFixText() {
    var b = block();
    assert.ok(b.indexOf(DETACHED_GUARD) > -1, 'control: the fixed source must contain the detached guard');
    var pre = b.replace(DETACHED_GUARD, 'if ( false ) {');
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
        end         : function (b) { sink.body = String(b); sink.ended = true; }
    };
    return { res: res, sink: sink };
}

/** Lift throwError with a `process` carrying a real _reqALS; `slot` is what the never-cleared router slot holds. */
function harness(src, slot, als) {
    var logs = [];
    var console_ = {
        error: function (m) { logs.push('ERROR ' + String(m).split('\n')[0]); },
        emerg: function (m) { logs.push('EMERG ' + String(m).split('\n')[0]); }
    };
    var ctx = {
        router : slot ? { response: slot.res, next: function () { slot.sink.nextCalled = true; } } : null,
        bundle : 'demo'
    };
    var proc = { env: { NODE_SCOPE_IS_LOCAL: 'false' }, gina: als ? { _reqALS: als } : undefined };
    var fn = new Function('getContext', 'console', '_mintErrorRef', 'process',
        'return (' + src + ');')(function (k) { return ctx[k]; }, console_, MINT, proc);
    return { fn: fn, logs: logs };
}

/** Drive one call under `storeObj` (or none) with the slot holding the LAST-ROUTED response. */
function drive(src, storeObj, isFatal) {
    var als  = new AsyncLocalStorage();
    var slot = makeRes('LAST-ROUTED');
    var H    = harness(src, slot, als);
    var thrown = null;
    var run = function () { try { H.fn(500, new Error('job config failure'), isFatal); } catch (e) { thrown = e; } };
    if (storeObj === null) { run(); } else { als.run(storeObj, run); }
    return { slot: slot.sink, thrown: thrown, logs: H.logs };
}

/** The store a job runs under since #B543 — identity and proxy context, and deliberately no response. */
function detachedStore() { return { requestId: 'req-JOB', startMs: 1, proxy: { isProxyHost: false }, detached: true }; }

describe('#B543 — throwError under a detached (job) store never answers the router slot', function () {

    describe('01 — source pins', function () {
        var b = block();

        it('the detached guard is present', function () {
            assert.ok(b.indexOf(DETACHED_GUARD) > -1, 'a detached store without res must null res / next');
        });

        it('it sits AFTER the next derivation and BEFORE the live-response branch', function () {
            var guard = b.indexOf(DETACHED_GUARD);
            var next  = b.indexOf(NEXT_LINE);
            var live  = b.indexOf(LIVE_BRANCH);
            assert.ok(guard > -1 && next > -1 && live > -1, 'all three anchors resolve');
            assert.ok(guard > next, 'the guard reads the derived res / next');
            assert.ok(guard < live, 'and runs before the response branch can use them');
        });

        it('it nulls BOTH res and next', function () {
            var guard = b.indexOf(DETACHED_GUARD);
            var body  = b.slice(guard, b.indexOf('}', guard));
            assert.ok(body.indexOf('res  = null;') > -1, 'res is nulled');
            assert.ok(body.indexOf('next = null;') > -1, 'next is nulled (never a stale slot callback)');
        });

        it('CONTROL: the #B534 store-first literals are byte-identical', function () {
            [
                'var _fromStore = ( _reqStore && _reqStore.res ) ? true : false;',
                'res   = ( _fromStore ) ? _reqStore.res  : ( ( router ) ? router.response : null )',
                NEXT_LINE,
                '( _fromStore && _reqStore.req ) ? _reqStore.req : ( ( res.req ) ? res.req : null )'
            ].forEach(function (lit) {
                assert.ok(b.indexOf(lit) > -1, 'unchanged: ' + lit.slice(0, 40));
            });
        });
    });

    describe('02 — a detached store', function () {

        it('fatal: nothing is written to the slot, the error is emerg-logged, nothing is thrown', function () {
            var r = drive(fnText(block()), detachedStore(), true);
            assert.equal(r.slot.ended, false, 'the last-routed response must not be answered');
            assert.equal(r.slot.code, null);
            assert.equal(r.slot.nextCalled, false);
            assert.equal(r.thrown, null);
            assert.equal(r.logs.length, 1, 'exactly one line');
            assert.ok(/^EMERG /.test(r.logs[0]), 'the emerg branch: ' + r.logs[0]);
        });

        it('non-fatal: nothing is written to the slot, the error is thrown to the caller', function () {
            var r = drive(fnText(block()), detachedStore(), undefined);
            assert.equal(r.slot.ended, false, 'the last-routed response must not be answered');
            assert.equal(r.slot.nextCalled, false);
            assert.ok(r.thrown instanceof Error, 'thrown');
            assert.equal(r.thrown.message, 'job config failure');
            assert.equal(r.logs.length, 0, 'the throw branch logs nothing here — the caller owns it');
        });

        it('SUBTRACT (control): the derived pre-fix copy answers the slot — the harness reproduces the defect', function () {
            var r = drive(preFixText(), detachedStore(), true);
            assert.equal(r.slot.ended, true, 'pre-fix: the last-routed response IS written');
            assert.equal(r.slot.code, 500);
            assert.ok(r.logs[0].indexOf('[ req req-LAST-ROUTED ]') > -1, 'pre-fix: the pairing line even names the wrong request');
        });
    });

    describe('03 — CONTROLS: what the clause leaves alone', function () {

        it('no store at all still answers through the slot (boot / CLI / cron — the #B534 fallback)', function () {
            var r = drive(fnText(block()), null, true);
            assert.equal(r.slot.ended, true);
            assert.equal(r.slot.code, 500);
        });

        it('a store WITHOUT the flag and without res still falls back to the slot (the #B534 § 03 contract)', function () {
            var r = drive(fnText(block()), { requestId: 'x', startMs: 1, proxy: null }, true);
            assert.equal(r.slot.ended, true);
        });

        it('a store that supplies a LIVE res answers that res, never the slot', function () {
            var own = makeRes('OWN');
            var r = drive(fnText(block()), { req: own.res.req, res: own.res, next: function () {}, requestId: 'req-OWN', startMs: 1, proxy: null }, true);
            assert.equal(own.sink.ended, true);
            assert.equal(own.sink.code, 500);
            assert.equal(r.slot.ended, false);
            assert.ok(r.logs[0].indexOf('[ req req-OWN ]') > -1, 'the pairing line names the store\'s request');
        });

        it('the flag never overrides a real response: detached === true beside a live res still answers that res', function () {
            var own = makeRes('OWN');
            var r = drive(fnText(block()), { req: own.res.req, res: own.res, next: function () {}, requestId: 'req-OWN', startMs: 1, proxy: null, detached: true }, true);
            assert.equal(own.sink.ended, true, 'a store that carries a response is attached, whatever the flag says');
            assert.equal(r.slot.ended, false);
        });
    });
});
