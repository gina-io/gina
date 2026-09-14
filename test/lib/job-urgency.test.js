/**
 * #H12 slice 2 — urgency-ordered job selection in lib/job.
 *
 * `create(fn, { urgency })` stamps an RFC 9218 urgency (0-7, default 3) on the
 * in-process queue entry; the worker's `_dequeue()` starts the FIRST entry of
 * the LOWEST urgency class (FIFO within a class) instead of a plain FIFO
 * shift; a retried attempt re-enters with the urgency it was created with;
 * the value is never inherited from a request.
 *
 * Module-path SEAM: `GINA_JOB_MAIN` points the WHOLE file — the source pins
 * AND the behavioural arms — at another copy of lib/job, so the red-first
 * reading against the pre-change bytes needs no working-tree revert
 * (`git show HEAD:<path>` into a scratch tree whose `lib/uuid` and
 * `lib/priority` are symlinks, so the module's relative requires resolve).
 *
 * Red-first anchor (measured on the pre-change tree, scratchpad/job-fifo.js):
 * a busy single worker then LOW(u7) / HIGH(u0) / MID(u3) drained
 * [S, LOW, HIGH, MID]; two classes interleaved drained [S, a, b, c, d]. The
 * arms below expect [S, HIGH, MID, LOW] and [S, b, d, a, c]. Arms that pin
 * UNCHANGED behaviour are labelled CONTROL and must stay green on both.
 * Measured while writing the arms: because `create()` pumps on a deferred
 * tick, a burst created in ONE synchronous run is queued whole before the
 * first pump — so the burst is urgency-ordered too (an idle worker given
 * LOW/HIGH/MID in that order starts HIGH first), and a sentinel that must
 * already be running is started in an earlier tick (`runScene`'s `first`).
 */

'use strict';

var { describe, it, beforeEach, afterEach } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

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

describe('job-urgency § 01 — source pins', function() {

    it('defines _dequeue() and drain() selects through it (not a plain FIFO shift)', function() {
        assert.ok(SRC.indexOf('function _dequeue(') > -1, '_dequeue exists');
        var drain = codeOnly(fnBlock(SRC, 'function drain('));
        assert.ok(drain.indexOf('_dequeue()') > -1, 'drain calls _dequeue()');
        assert.ok(drain.indexOf('_queue.shift(') < 0, 'drain no longer shifts the queue head');
        assert.ok(drain.indexOf('_running < _maxConcurrency') > -1, 'anti-vacuity: the stripped drain body still carries the cap check');
    });

    it('_dequeue() picks the lowest urgency with a strict comparison (FIFO within a class) and stops early on the most urgent class', function() {
        var dq = codeOnly(fnBlock(SRC, 'function _dequeue('));
        assert.ok(dq.indexOf('u < bestUrgency') > -1, 'strict less-than keeps insertion order among equals');
        assert.ok(dq.indexOf('priority.URGENCY_MIN') > -1, 'early exit on the most urgent class');
        assert.ok(dq.indexOf('_queue.splice(best, 1)[0]') > -1, 'removes exactly the selected entry');
    });

    it('create() stamps a normalized urgency on the queue entry, never on the record', function() {
        var create = fnBlock(SRC, 'function create(');
        assert.ok(create.indexOf('priority.normalizeUrgency(opts.urgency)') > -1, 'clamped through lib/priority');
        assert.ok(create.indexOf('_queue.push({ id: id, fn: fn, urgency: urgency, context: context });') > -1, 'entry carries urgency');
        var recordIdx = create.indexOf('var record = {');
        var recordEnd = create.indexOf('};', recordIdx);
        assert.ok(recordIdx > -1 && recordEnd > recordIdx, 'record literal found');
        assert.ok(create.slice(recordIdx, recordEnd).indexOf('urgency') < 0, 'the persisted record has no urgency field');
    });

    it('lib/priority is required relatively (no registry-ordering dependency), like uuid', function() {
        assert.ok(SRC.indexOf("require('../../priority/src/main')") > -1);
        assert.ok(SRC.indexOf("require('../../uuid/src/main')") > -1, 'CONTROL: the uuid require is the precedent');
    });

    it('CONTROL — scheduleRetry still re-enqueues the ORIGINAL entry (urgency rides on it)', function() {
        var block = fnBlock(SRC, 'function scheduleRetry(');
        assert.ok(block.indexOf('_queue.push(entry)') > -1);
    });

    it('CONTROL — stats() shape is unchanged (no key was added for urgency)', function() {
        job.reset(); job.start({ sweepInterval: 0 });
        assert.deepEqual(Object.keys(job.stats()).sort(), ['maxConcurrency', 'queued', 'retryWaiting', 'running']);
        job.reset();
    });

});

// ─── 02 — behavioural arms (real module, memory store) ──────────────────────

/**
 * Run a scene on a fresh worker and resolve with the order the deferred fns
 * STARTED in. `first` is created and WAITED FOR (every one of its fns has
 * started) before `rest` is created — `create()` pumps through a deferred
 * `setImmediate`, so a whole synchronous burst is queued before the first
 * pump and is itself urgency-ordered (measured, and pinned by its own arm
 * below); a sentinel that must be RUNNING when the others arrive has to be
 * started in an earlier tick. Each item is `{ label, opts, hold, fn }`;
 * `fn(order, recorder)` may replace the default recorder. Rejects (never
 * hangs) if a phase does not settle in time — a red-first run must FAIL,
 * not stall.
 */
function runScene(first, rest, knobs) {
    job.reset();
    job.start(Object.assign({ maxConcurrency: 1, sweepInterval: 0 }, knobs || {}));
    var order = [];
    function recorder(label, hold) {
        return function() { order.push(label); return new Promise(function(r) { setTimeout(r, hold || 8); }); };
    }
    function createAll(plan) {
        plan.forEach(function(p) {
            job.create(p.fn ? p.fn(order, recorder) : recorder(p.label, p.hold), p.opts || {});
        });
    }
    function until(pred, what) {
        return new Promise(function(resolve, reject) {
            var guard = setTimeout(function() { reject(new Error(what + ' did not happen; order so far ' + JSON.stringify(order))); }, 4000);
            var t = setInterval(function() { if (pred()) { clearInterval(t); clearTimeout(guard); resolve(); } }, 2);
        });
    }
    createAll(first);
    return until(function() { return order.length >= first.length; }, 'the sentinel phase starting')
        .then(function() { createAll(rest); })
        .then(function() { return until(function() { var s = job.stats(); return s.running === 0 && s.queued === 0 && s.retryWaiting === 0; }, 'the queue settling'); })
        .then(function() { return order; });
}

describe('job-urgency § 02 — selection order', function() {

    afterEach(function() { job.reset(); });

    it('a busy single worker: the lowest urgency starts first ([S, HIGH, MID, LOW] — FIFO read [S, LOW, HIGH, MID])', async function() {
        var order = await runScene([ { label: 'S', hold: 30 } ], [
            { label: 'LOW',  opts: { urgency: 7 } },
            { label: 'HIGH', opts: { urgency: 0 } },
            { label: 'MID',  opts: { urgency: 3 } }
        ]);
        assert.deepEqual(order, ['S', 'HIGH', 'MID', 'LOW']);
    });

    it('FIFO within a class: two interleaved classes drain class by class, insertion order inside each ([S, b, d, a, c])', async function() {
        var order = await runScene([ { label: 'S', hold: 30 } ], [
            { label: 'a', opts: { urgency: 5 } },
            { label: 'b', opts: { urgency: 1 } },
            { label: 'c', opts: { urgency: 5 } },
            { label: 'd', opts: { urgency: 1 } }
        ]);
        assert.deepEqual(order, ['S', 'b', 'd', 'a', 'c']);
    });

    it('CONTROL — a job already RUNNING is never pre-empted: LOW started first keeps the worker ([LOW, HIGH, MID])', async function() {
        var order = await runScene([ { label: 'LOW', opts: { urgency: 7 }, hold: 20 } ], [
            { label: 'HIGH', opts: { urgency: 0 } },
            { label: 'MID',  opts: { urgency: 3 } }
        ]);
        assert.deepEqual(order, ['LOW', 'HIGH', 'MID']);
    });

    it('a synchronous burst on an IDLE worker is urgency-ordered as a whole ([HIGH, MID, LOW] — FIFO read [LOW, HIGH, MID]): create() pumps on a deferred tick', async function() {
        var order = await runScene([], [
            { label: 'LOW',  opts: { urgency: 7 } },
            { label: 'HIGH', opts: { urgency: 0 } },
            { label: 'MID',  opts: { urgency: 3 } }
        ]);
        assert.deepEqual(order, ['HIGH', 'MID', 'LOW']);
    });

    it('CONTROL — with no urgency anywhere the queue drains exactly as the plain FIFO did', async function() {
        var order = await runScene([ { label: 'S', hold: 30 } ], [
            { label: 'p' }, { label: 'q' }, { label: 'r' }
        ]);
        assert.deepEqual(order, ['S', 'p', 'q', 'r']);
    });

    it('an invalid urgency (9, "1", -1, 3.5, absent) falls back to 3: after u=2, before u=4, FIFO among themselves', async function() {
        var order = await runScene([ { label: 'S', hold: 30 } ], [
            { label: 'X', opts: { urgency: 9 } },
            { label: 'Y', opts: { urgency: '1' } },
            { label: 'Z', opts: { urgency: -1 } },
            { label: 'W', opts: { urgency: 3.5 } },
            { label: 'V' },
            { label: 'P', opts: { urgency: 2 } },
            { label: 'Q', opts: { urgency: 4 } }
        ]);
        assert.deepEqual(order, ['S', 'P', 'X', 'Y', 'Z', 'W', 'V', 'Q']);
    });

    it('a retried attempt re-enters with its ORIGINAL urgency ([S, A, D, A, E] — FIFO read [S, A, D, E, A])', async function() {
        var order = await runScene([ { label: 'S', hold: 30 } ], [
            { label: 'A', opts: { urgency: 0, maxAttempts: 2 }, fn: function(order, recorder) {
                var attempts = 0;
                return function() {
                    order.push('A'); attempts++;
                    if (attempts === 1) {
                        // queue a u=1 competitor BEFORE the backoff timer re-enqueues A: with the
                        // urgency retained A (u=0) beats E (u=1); a plain FIFO would run E first
                        job.create(recorder('E', 8), { urgency: 1 });
                        throw new Error('first attempt fails');
                    }
                    return Promise.resolve('ok');
                };
            } },
            { label: 'D', opts: { urgency: 1 }, hold: 30 }
        ], { retryBackoffMs: 1 });
        assert.deepEqual(order, ['S', 'A', 'D', 'A', 'E']);
    });

    it('maxConcurrency 2: the queued remainder is still ordered by urgency ([S1, S2, b, a])', async function() {
        var order = await runScene([ { label: 'S1', hold: 30 }, { label: 'S2', hold: 30 } ], [
            { label: 'a', opts: { urgency: 7 } },
            { label: 'b', opts: { urgency: 0 } }
        ], { maxConcurrency: 2 });
        assert.deepEqual(order, ['S1', 'S2', 'b', 'a']);
    });

    it('the persisted record carries no urgency field (memory store)', async function() {
        job.reset(); job.start({ maxConcurrency: 1, sweepInterval: 0 });
        var id = job.create(function() { return 1; }, { urgency: 0 });
        var rec = await new Promise(function(resolve, reject) { job.get(id, function(err, r) { err ? reject(err) : resolve(r); }); });
        assert.ok(rec && rec.id === id, 'record readable');
        assert.ok(!('urgency' in rec), 'no urgency on the record');
    });

});
