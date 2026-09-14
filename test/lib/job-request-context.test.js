/**
 * #B543 — a queued job runs inside a DETACHED copy of the request context that
 * created it, never under whichever request's settle chain freed the worker.
 *
 * `lib/job` pumps its queue from `drain()`, and `drain()` is called from the
 * settle chain of the job that just finished. Under a busy worker the job that
 * starts next therefore ran inside the AsyncLocalStorage context of the request
 * that created the FINISHED job — measured on the real module: with
 * `maxConcurrency: 1`, a job created by request B executed seeing request A's
 * store, `req` / `res` / `next` included (the `bleed` scene below, and the live
 * fixture in the bug record). Every reader of `process.gina._reqALS` then
 * attributed the job to the wrong request: `lib/routing` built absolute URLs
 * from A's proxy context, `helpers/context.js`'s throwError answered A's
 * response, the JSON logger stamped A's request id.
 *
 * The fix: `create()` captures `{ requestId, startMs, proxy: <shallow copy>,
 * detached: true }` from the creating request's store — never `req` / `res` /
 * `next` — and `runOne()` runs the job's whole lifecycle inside
 * `_reqALS.run(entry.context || undefined)`: a job created with no request
 * context runs with NO store (a plain call would inherit the pump's context,
 * which is the defect), and the ALS is looked up at RUN time.
 *
 * Module-path SEAM: `GINA_JOB_MAIN` points the WHOLE file — pins and arms — at
 * another copy of lib/job (a `git show HEAD:` scratch copy whose `lib/uuid` and
 * `lib/priority` are symlinks), so the red-first reading needs no working-tree
 * revert. Red-first anchor (pre-fix bytes): §01 pins red; §02 B1 read A with
 * keys `next,proxy,req,requestId,res,startMs`; §03 N read A; §04 both attempts
 * read A; §05 the job's store carried `req`/`res`/`next` and its `proxy` was the
 * creator's object BY REFERENCE. Arms labelled CONTROL pin behaviour the change
 * kept and stay green on both.
 */

'use strict';

var { describe, it, before, after, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var { AsyncLocalStorage } = require('node:async_hooks');

var FW       = require('../fw');
var JOB_MAIN = process.env.GINA_JOB_MAIN || path.join(FW, 'lib/job/src/main');
var JOB_FILE = require.resolve(JOB_MAIN);
var job      = require(JOB_MAIN);
var SRC      = fs.readFileSync(JOB_FILE, 'utf8');

/** Strip block and line comments so a NEGATIVE pin cannot trip on prose (jsdoc.md § own-comment trap). */
function codeOnly(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map(function(l) { return l.replace(/\/\/.*$/, ''); }).join('\n');
}
/** The text of a top-level function from its declaration to its closing `\n}` (every function pinned here closes at column 0). */
function fnBlock(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, decl + ' present');
    var end = src.indexOf('\n}', at);
    assert.ok(end > at, decl + ' closes');
    return src.slice(at, end + 2);
}

// ─── 01 — source pins ───────────────────────────────────────────────────────

describe('job-request-context § 01 — source pins', function() {

    it('captureRequestContext() returns the four detached keys and never req / res / next', function() {
        var decl = SRC.indexOf('function captureRequestContext(');
        assert.ok(decl > -1, 'captureRequestContext present');
        var raw  = SRC.slice(SRC.lastIndexOf('/**', decl), decl) + fnBlock(SRC, 'function captureRequestContext(');   // its JSDoc + body
        var code = codeOnly(raw);
        // anti-vacuity: the strip must have removed something, and the RAW text must
        // still name the excluded objects (the JSDoc explains why they are left out),
        // so a negative pin on the stripped text is a real reading, not a no-op
        assert.notEqual(code, raw, 'the comment strip changed the text');
        assert.ok(/\bres\b/.test(raw), 'control: the raw text names res (in prose)');
        assert.ok(!/\bres\b/.test(code), 'and the stripped code does not');
        ['requestId:', 'startMs:', 'proxy:', 'detached:'].forEach(function(k) {
            assert.ok(code.indexOf(k) > -1, 'captured literal carries ' + k);
        });
        assert.ok(code.indexOf('detached:  true') > -1 || code.indexOf('detached: true') > -1, 'detached is stamped true');
        assert.ok(!/\bstore\.(req|res|next)\b/.test(code), 'no req / res / next is read off the request store');
        assert.ok(!/\b(req|res|next)\s*:/.test(code), 'no req / res / next key is placed on the captured context');
        assert.ok(code.indexOf('return null') > -1, 'no active request context ⇒ null (the job then runs with no store)');
    });

    it('runInRequestContext() runs cb under the entry context, or under NO store — never a plain call when an ALS exists', function() {
        var code = codeOnly(fnBlock(SRC, 'function runInRequestContext('));
        assert.ok(code.indexOf('als.run(context || undefined, cb)') > -1,
            'run(undefined) rather than a plain call — a plain call would inherit the pump\'s context, which is the defect');
        assert.ok(code.indexOf('if (!als) return cb();') > -1, 'no AsyncLocalStorage in the process ⇒ plain call');
        assert.ok(code.indexOf('process.gina._reqALS') > -1, 'the ALS is resolved inside the helper — at RUN time, not at module load');
    });

    it('runOne() wraps the WHOLE lifecycle — the store read comes after the context entry', function() {
        var code = codeOnly(fnBlock(SRC, 'function runOne('));
        var wrap = code.indexOf('runInRequestContext(entry.context,');
        var get  = code.indexOf('_store.get(id,');
        assert.ok(wrap > -1, 'runOne enters the entry\'s context');
        assert.ok(get > wrap, 'the record read, the fn and its settlement all sit inside it');
    });

    it('create() captures the context and stamps it on the queue entry', function() {
        var code = codeOnly(fnBlock(SRC, 'function create('));
        var cap  = code.indexOf('var context = captureRequestContext();');
        var push = code.indexOf('_queue.push({ id: id, fn: fn, urgency: urgency, context: context });');
        assert.ok(cap > -1, 'the creator\'s context is captured at create()');
        assert.ok(push > cap, 'and rides the entry (in-process only — never the record)');
    });
});

// ─── behavioural arms — the real module under a real AsyncLocalStorage ──────

/** A request store shaped like the one core/server.js handle() enters (keys measured live: next,proxy,req,requestId,res,startMs). */
function requestStore(id) {
    return {
        req:       { url: '/' + id, _ginaReqId: id },
        res:       { headersSent: true },
        next:      function() {},
        requestId: id,
        startMs:   1000 + id.length,
        proxy:     { isProxyHost: false, proxyHostname: null, proxyHost: 'host-' + id }
    };
}
function hold(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function tick()   { return new Promise(function(r) { setImmediate(r); }); }
/** Resolve once no job is running, queued or waiting on a retry timer (4 s guard). */
function settled() {
    return new Promise(function(resolve, reject) {
        var guard = setTimeout(function() { clearInterval(t); reject(new Error('scene did not settle')); }, 4000);
        var t = setInterval(function() {
            var s = job.stats();
            if (s.running === 0 && s.queued === 0 && s.retryWaiting === 0) { clearInterval(t); clearTimeout(guard); resolve(); }
        }, 3);
    });
}
/** What a job sees when it runs: the store's identity and key set, or NO-STORE. */
function seen() {
    var als = (process.gina && process.gina._reqALS) ? process.gina._reqALS : null;
    if (!als) return 'NO-ALS';
    var s = als.getStore();
    if (s === undefined) return 'NO-STORE';
    return { id: s.requestId, keys: Object.keys(s).sort(), detached: s.detached === true, proxy: s.proxy };
}

var DETACHED_KEYS = ['detached', 'proxy', 'requestId', 'startMs'];

describe('job-request-context § 02–06 — the scenes', function() {
    var als, hadGina, prevALS;

    before(function() {
        hadGina = Object.prototype.hasOwnProperty.call(process, 'gina');
        process.gina = process.gina || {};
        prevALS = process.gina._reqALS;
        als = new AsyncLocalStorage();
        process.gina._reqALS = als;
    });
    after(function() {
        if (!hadGina) { delete process.gina; }
        else if (prevALS === undefined) { delete process.gina._reqALS; }
        else { process.gina._reqALS = prevALS; }
    });
    beforeEach(function() { job.reset(); });
    afterEach(function()  { job.reset(); });

    /** A1 (30 ms) under A holds the single worker; then A2 under A and B1 under B are queued. */
    async function bleedScene(out) {
        job.start({ maxConcurrency: 1, sweepInterval: 0 });
        als.run(requestStore('A'), function() { job.create(function() { out.A1 = seen(); return hold(30); }); });
        await tick(); await hold(5);                                   // A1 is running
        als.run(requestStore('A'), function() { job.create(function() { out.A2 = seen(); return hold(5); }); });
        als.run(requestStore('B'), function() { job.create(function() { out.B1 = seen(); return hold(5); }); });
        await settled();
        return out;
    }

    describe('§ 02 — the bleed: a job drained from another request\'s settle chain', function() {

        it("B's job runs under B's own context, not under A's — the request whose settle chain started it", async function() {
            var out = await bleedScene({});
            assert.equal(out.B1.id, 'B', 'B1 sees the request that created it');
        });

        it("the job's store is the DETACHED shape — no req / res / next from any request", async function() {
            var out = await bleedScene({});
            assert.deepEqual(out.B1.keys, DETACHED_KEYS);
            assert.equal(out.B1.detached, true);
        });

        it("CONTROL: A's own jobs still see A", async function() {
            var out = await bleedScene({});
            assert.equal(out.A1.id, 'A');
            assert.equal(out.A2.id, 'A');
        });
    });

    describe('§ 03 — a job created with NO request context', function() {

        it('runs with NO store, even though the pump that started it came from a request', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            als.run(requestStore('A'), function() { job.create(function() { out.A1 = seen(); return hold(30); }); });
            await tick(); await hold(5);
            job.create(function() { out.N = seen(); return hold(5); });   // outside any store
            await settled();
            assert.equal(out.A1.id, 'A');
            assert.equal(out.N, 'NO-STORE', 'a store-less job must not inherit the draining request\'s context');
        });
    });

    describe('§ 04 — a retried attempt', function() {

        it("runs the second attempt under B too, although the retry was armed from B's own settle chain and re-drained later", async function() {
            var out = { B1: [] };
            job.start({ maxConcurrency: 1, sweepInterval: 0, retryBackoffMs: 1 });
            als.run(requestStore('A'), function() { job.create(function() { out.A1 = seen(); return hold(30); }); });
            await tick(); await hold(5);
            var idB;
            als.run(requestStore('B'), function() {
                idB = job.create(function() {
                    out.B1.push(seen());
                    if (out.B1.length === 1) throw new Error('first attempt fails');
                    return hold(5);
                }, { maxAttempts: 2 });
            });
            als.run(requestStore('A'), function() { job.create(function() { out.A2 = seen(); return hold(20); }); });
            await settled();
            assert.equal(out.B1.length, 2, 'two attempts ran');
            assert.equal(out.B1[0].id, 'B');
            assert.equal(out.B1[1].id, 'B');
            var rec = await new Promise(function(r) { job.get(idB, function(e, x) { r(x); }); });
            assert.equal(rec.state, 'completed');            // CONTROL — the retry contract is untouched
            assert.equal(rec.attempts, 2);
        });
    });

    describe('§ 05 — the shape of the captured context', function() {

        it('carries exactly requestId / startMs / proxy / detached, with detached === true', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            als.run(requestStore('C'), function() { job.create(function() { out.C = seen(); return hold(5); }); });
            await settled();
            assert.deepEqual(out.C.keys, DETACHED_KEYS);
            assert.equal(out.C.detached, true);
            assert.equal(out.C.id, 'C');
        });

        it('proxy is a DECOUPLED shallow copy — a mutation of the request\'s object after create() never reaches the job', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            var s = requestStore('C');
            als.run(s, function() { job.create(function() { var st = als.getStore(); out.sameRef = (st.proxy === s.proxy); out.host = st.proxy.proxyHost; return hold(5); }); });
            s.proxy.proxyHost = 'MUTATED-AFTER-CREATE';
            await settled();
            assert.equal(out.sameRef, false, 'the job must not hold the request\'s proxy object by reference');
            assert.equal(out.host, 'host-C', 'the copy carries the value captured at create()');
        });
    });

    describe('§ 06 — CONTROLS: what the change kept', function() {

        it('an IDLE worker still runs a job under its creator (the bleed was conditional on a BUSY worker)', async function() {
            var out = {};
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            als.run(requestStore('X'), function() { job.create(function() { out.X = seen(); return hold(5); }); });
            await settled();
            assert.equal(out.X.id, 'X');
        });

        it('the RECORD never carries the context — it lives on the in-process queue entry only', async function() {
            var id;
            job.start({ maxConcurrency: 1, sweepInterval: 0 });
            als.run(requestStore('R'), function() { id = job.create(function() { return 'done'; }); });
            await settled();
            var rec = await new Promise(function(r) { job.get(id, function(e, x) { r(x); }); });
            assert.equal(rec.state, 'completed');
            assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'context'), 'a durable store must not serialise a request context');
        });

        it('with NO AsyncLocalStorage in the process at all, a job still runs and completes (plain call)', async function() {
            var out = {}, id;
            delete process.gina._reqALS;
            try {
                job.start({ maxConcurrency: 1, sweepInterval: 0 });
                id = job.create(function() { out.P = seen(); return 'ok'; });
                await settled();
            } finally {
                process.gina._reqALS = als;
            }
            assert.equal(out.P, 'NO-ALS');
            var rec = await new Promise(function(r) { job.get(id, function(e, x) { r(x); }); });
            assert.equal(rec.state, 'completed');
        });

        it('the ALS is looked up at RUN time — a job created before one exists runs with no store once one does', async function() {
            var out = {};
            delete process.gina._reqALS;
            try {
                job.start({ maxConcurrency: 1, sweepInterval: 0 });
                job.create(function() { out.L = seen(); return hold(5); });
            } finally {
                process.gina._reqALS = als;                                // installed before the deferred pump runs
            }
            await settled();
            assert.equal(out.L, 'NO-STORE');
        });
    });
});
