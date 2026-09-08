/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/job
 *
 * Async-job primitive (#AI6). Runs a deferred async function out-of-band so a slow
 * call (e.g. an LLM `.infer()` taking 1-30s) does not tie up the request
 * pipeline under load: a controller calls `lib.job.create(fn)` (or
 * `self.startJob(fn)`), gets a `jobId` back immediately, returns it to the
 * client, and the client polls `/_gina/jobs/:id` (or, later, receives a
 * webhook) for the outcome.
 *
 * Design notes:
 *   - **Module-singleton.** The registry, worker state, and sweep timer live
 *     at module scope. Registered in `lib/index.js` with a PLAIN `require`
 *     (like `State` / `logger`) so `refreshCore()` does not discard the live
 *     registry or orphan the sweep timer on every dev-mode HTTP request.
 *   - **Concurrency-limited worker.** At most `maxConcurrency` (default 4)
 *     deferred functions run at once; the rest queue. This is the whole point
 *     of moving the work out-of-band — a burst of requests must not fan out
 *     into N unbounded concurrent (and expensive) LLM calls.
 *   - **Failed-job retry (opt-in).** `create(fn, { maxAttempts: N })` retries
 *     a failed attempt with exponential backoff (`retryBackoffMs`, default
 *     1s, doubling); the record returns to `pending` (last error and
 *     `nextRetryAt` stay visible) until the final attempt — `failed` is
 *     strictly terminal. The deferred fn lives only in the creating process,
 *     so only the origin pod retries; other pods just read records.
 *   - **Pluggable store, memory by default.** Records persist behind a small
 *     callback-shaped store interface (`set / get / remove / list / sweep`).
 *     The in-memory store is the default; a connector-backed store is a
 *     drop-in via `start({ store })` — SQLite ships first
 *     (`core/connectors/sqlite/lib/job-store.js`, wired from `app.json`'s
 *     `jobs.store` through `lib/job-store`), making records survive a bundle
 *     restart and readable cross-process. The deferred *function* always
 *     lives in the creating process's memory (a closure cannot be
 *     serialised); only the *record* (state / result / error) goes in the
 *     store.
 *   - **Self-contained TTL sweep.** Terminal (completed / failed) records past
 *     their TTL are purged by an unref'd `setInterval` (the SQLite
 *     session-store cleanup pattern) — NOT `lib/cron`, which is dormant (not
 *     registered in `lib/index.js`, not instantiated at boot). A bundle may
 *     drive an extra sweep from its own cron, but the internal timer
 *     guarantees baseline retention regardless. Since #B471 the sweep is
 *     preceded by an orphan-reclaim pass on DURABLE stores: a non-terminal
 *     record stranded by a dead process (its deferred fn died with it) is
 *     terminalized as `failed`/`JobOrphanedError` once older than
 *     `orphanTimeout` (default 24h, `0` disables), so retention and the
 *     polling surface stay truthful across process lifetimes.
 *
 * The primitive is always-on. Optional tuning via `app.json` (an absent block
 * means sane defaults):
 *
 *     {
 *       "jobs": {
 *         "maxConcurrency": 4,
 *         "ttl":           3600,
 *         "sweepInterval":  300,
 *         "idSize":          21,
 *         "retryBackoffMs": 1000,
 *         "store":         "jobsDb"
 *       }
 *     }
 *
 * `core/gna.js`'s `server.on('started')` callback calls `lib.job.start(...)`
 * once per bundle with this block. `store` (optional) names a
 * `config/connectors.json` entry; gna.js resolves it through `lib/job-store`
 * into a connector-backed store (records survive restarts / are visible
 * cross-process) and fails the boot if it cannot be built. Absent `store`
 * means the in-memory store, as before.
 *
 * @package    gina.framework
 * @namespace  lib.job
 * @author     Rhinostone <contact@gina.io>
 */

'use strict';

/**
 * Cryptographically-secure base-62 id generator (zero-dep, nanoid-style).
 * Required directly rather than via the `lib` registry so the primitive has
 * no dependency on global-injection ordering.
 *
 * @inner
 * @type {function(number=): string}
 */
var uuid = require('../../uuid/src/main');

/**
 * Job lifecycle states. A job moves `PENDING -> RUNNING -> COMPLETED | FAILED`.
 * With retries (`maxAttempts > 1`) a failed attempt moves `RUNNING -> PENDING`
 * (rescheduled with backoff on the creating process) — `FAILED` and
 * `COMPLETED` are strictly terminal.
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {{PENDING:string, RUNNING:string, COMPLETED:string, FAILED:string}}
 */
var STATES = {
    PENDING:   'pending',
    RUNNING:   'running',
    COMPLETED: 'completed',
    FAILED:    'failed'
};

/**
 * Default maximum number of deferred functions running concurrently.
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_MAX_CONCURRENCY = 4;

/**
 * Default time-to-live (seconds) for a terminal record before the sweep
 * purges it.
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_TTL = 3600;

/**
 * Default interval (seconds) between sweep passes. `0` disables the internal
 * timer (used by tests that call {@link sweep} manually).
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_SWEEP_INTERVAL = 300;

/**
 * Default jobId length (characters). 21 base-62 chars is nanoid-equivalent
 * entropy — long enough that the id is unguessable, since the id is the
 * capability token for the status endpoint.
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_ID_SIZE = 21;

/**
 * Default webhook delivery knobs — best-effort completion POST.
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_WEBHOOK_MAX_ATTEMPTS = 3;
/** Backoff base (ms); doubles each retry. @memberof module:gina/lib/job @constant @type {number} */
var DEFAULT_WEBHOOK_BACKOFF_MS = 500;
/** Per-attempt request timeout (ms). @memberof module:gina/lib/job @constant @type {number} */
var DEFAULT_WEBHOOK_TIMEOUT_MS = 5000;

/**
 * Default base delay (ms) between attempts of a failed job with retries
 * remaining (`maxAttempts > 1`) — doubles on each attempt (the webhook-retry
 * backoff shape).
 *
 * @memberof module:gina/lib/job
 * @constant
 * @type {number}
 */
var DEFAULT_RETRY_BACKOFF_MS = 1000;

/**
 * Default orphan-reclaim ceiling, SECONDS (24h). A non-terminal record whose
 * last transition is older than this is presumed stranded by a dead process
 * and reclaimed as `failed` (`JobOrphanedError`) by {@link sweep}'s reclaim
 * pass — durable stores only; see {@link reclaimOrphans}. `0` disables.
 * @constant
 * @type {number}
 */
var DEFAULT_ORPHAN_TIMEOUT = 86400;

/**
 * The active record store (memory store by default). `null` until the first
 * {@link create} or {@link start}.
 *
 * @inner
 * @type {JobStore|null}
 */
var _store = null;

/**
 * `true` when {@link _store} is the BUILT-IN memory store (defaulted, not
 * app-supplied). The orphan-reclaim pass skips it: an in-process store cannot
 * hold another process's orphans (process death wipes it), so reclaim there
 * could only ever produce false positives on long-running live jobs.
 *
 * @inner
 * @type {boolean}
 */
var _storeIsBuiltinMemory = false;

/**
 * Orphan-reclaim ceiling, SECONDS. `0` = disabled. Floored at 60 when armed
 * (a smaller value would reclaim jobs still legitimately mid-flight).
 *
 * @inner
 * @type {number}
 */
var _orphanTimeout = DEFAULT_ORPHAN_TIMEOUT;

/**
 * In-flight worker count. Bounded by {@link _maxConcurrency}.
 *
 * @inner
 * @type {number}
 */
var _running = 0;

/**
 * Pending `{ id, fn }` entries waiting for a worker slot. The deferred
 * function lives here (in-process), never in the store.
 *
 * @inner
 * @type {Array<{id:string, fn:function}>}
 */
var _queue = [];

/** @inner @type {number} */
var _maxConcurrency = DEFAULT_MAX_CONCURRENCY;
/** @inner @type {number} */
var _ttl = DEFAULT_TTL;
/** @inner @type {number} */
var _sweepInterval = DEFAULT_SWEEP_INTERVAL;
/** @inner @type {number} */
var _idSize = DEFAULT_ID_SIZE;
/** @inner @type {*} */
var _sweepTimer = null;
/** @inner @type {number} */
var _webhookMaxAttempts = DEFAULT_WEBHOOK_MAX_ATTEMPTS;
/** @inner @type {number} */
var _webhookBackoffMs = DEFAULT_WEBHOOK_BACKOFF_MS;
/** @inner @type {number} */
var _webhookTimeoutMs = DEFAULT_WEBHOOK_TIMEOUT_MS;
/**
 * Per-bundle HMAC secret for signing webhook payloads (`X-Gina-Signature:
 * sha256=...`). `null` disables signing. Set via `start({ webhookSecret })`
 * from app.json (use a `${secret:KEY}` placeholder rather than hardcoding).
 * @inner
 * @type {?string}
 */
var _webhookSecret = null;
/** @inner @type {number} */
var _retryBackoffMs = DEFAULT_RETRY_BACKOFF_MS;
/**
 * Pending retry timers (unref'd). Tracked so {@link reset} can cancel them —
 * a timer firing after a reset would re-enqueue into a torn-down store.
 * @inner
 * @type {Set<*>}
 */
var _retryTimers = new Set();

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * @typedef  {Object} JobRecord
 * @property {string}      id          - Unguessable base-62 job id.
 * @property {string}      state       - One of {@link STATES}.
 * @property {*}           result      - The resolved value once `completed`; `null` otherwise.
 * @property {?{name:string, message:string, stack:?string}} error - Serialised error once `failed`; `null` otherwise.
 * @property {number}      attempts    - How many times the worker has run the function.
 * @property {number}      maxAttempts - Retry ceiling (default 1 — run once). Above 1, a failed attempt is retried with backoff on the creating process.
 * @property {?string}     callbackUrl - Webhook URL POSTed `{ id, state, result, error }` on completion when set.
 * @property {?Object}     meta        - Caller-supplied opaque metadata.
 * @property {number}      createdAt   - Epoch ms at creation.
 * @property {number}      updatedAt   - Epoch ms of the last transition.
 * @property {?number}     startedAt   - Epoch ms the worker began; `null` while pending.
 * @property {?number}     finishedAt  - Epoch ms of the terminal transition; `null` until then.
 * @property {?number}     expiresAt   - Epoch ms after which a terminal record is sweepable; `null` until terminal — deliberately including while a retry is pending, so the TTL sweep can never purge a retryable job. On a durable store that protection is bounded by the orphan-reclaim pass: a record left non-terminal past `orphanTimeout` is marked `failed` first, which stamps `expiresAt` and hands it to ordinary retention (see {@link reclaimOrphans}). The built-in memory store is exempt, so the guarantee is unbounded there.
 * @property {?number}     nextRetryAt - Epoch ms of the next scheduled attempt while a failed attempt awaits its retry; `null` once terminal (absent if the job never settled).
 * @property {?number}     webhookDeliveredAt - Epoch ms a completion webhook succeeded; absent until delivered.
 * @property {?boolean}    webhookFailed      - `true` once webhook delivery exhausts its retries; absent otherwise.
 * @property {?string}     webhookError       - Last webhook failure reason; absent on success.
 */

/**
 * @typedef  {Object} JobStore
 * @description Callback-shaped persistence seam. The memory store is the v1
 * implementation; a connector-backed store implements the same five methods.
 * @property {function(string, JobRecord, function=): void}        set    - Upsert `record` under `id`; `fn(err, record)`.
 * @property {function(string, function): void}                    get    - Fetch by `id`; `fn(err, record|null)`.
 * @property {function(string, function=): void}                   remove - Delete by `id`; `fn(err, existed)`.
 * @property {function(?Object, function): void}                   list   - List records matching `filter` (e.g. `{state}`); `fn(err, records)`.
 * @property {function(number, function): void}                    sweep  - Delete terminal records with `expiresAt <= now`; `fn(err, removedCount)`.
 */

/**
 * Build the default in-memory {@link JobStore}. Records are held in a
 * null-prototype map keyed by id; all callbacks fire synchronously.
 *
 * @inner
 * @returns {JobStore}
 */
function createMemoryStore() {
    var map = Object.create(null);
    return {
        set: function(id, record, fn) {
            map[id] = record;
            if (typeof fn === 'function') fn(null, record);
        },
        get: function(id, fn) {
            fn(null, Object.prototype.hasOwnProperty.call(map, id) ? map[id] : null);
        },
        remove: function(id, fn) {
            var existed = Object.prototype.hasOwnProperty.call(map, id);
            if (existed) delete map[id];
            if (typeof fn === 'function') fn(null, existed);
        },
        list: function(filter, fn) {
            var out = [];
            for (var k in map) {
                if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
                var rec = map[k];
                if (filter && filter.state && rec.state !== filter.state) continue;
                out.push(rec);
            }
            fn(null, out);
        },
        sweep: function(now, fn) {
            var removed = 0;
            for (var k in map) {
                if (!Object.prototype.hasOwnProperty.call(map, k)) continue;
                var rec = map[k];
                if (
                    rec.expiresAt && rec.expiresAt <= now
                    && (rec.state === STATES.COMPLETED || rec.state === STATES.FAILED)
                ) {
                    delete map[k];
                    removed++;
                }
            }
            fn(null, removed);
        }
    };
}

/**
 * Coerce any thrown / rejected value into a serialisable error shape. Never
 * store a raw `Error` (its `message` / `stack` are non-enumerable and would
 * vanish through a connector store's `JSON.stringify`).
 *
 * @inner
 * @param   {*} err
 * @returns {?{name:string, message:string, stack:?string}}
 */
function serializeError(err) {
    if (err === null || typeof err === 'undefined') return null;
    if (err instanceof Error) {
        return {
            name:    err.name || 'Error',
            message: err.message || String(err),
            stack:   err.stack || null
        };
    }
    if (typeof err === 'object') {
        var msg;
        try { msg = err.message || JSON.stringify(err); }
        catch (e) { msg = String(err); }
        return { name: err.name || 'Error', message: msg, stack: err.stack || null };
    }
    return { name: 'Error', message: String(err), stack: null };
}

/**
 * Ensure the store and sweep timer exist with the current settings. Called by
 * {@link create} so the primitive works even if {@link start} was never
 * invoked (defaults apply).
 *
 * @inner
 * @returns {void}
 */
function ensureStarted() {
    if (!_store) {
        _store = createMemoryStore();
        _storeIsBuiltinMemory = true;
    }
    ensureSweepTimer();
}

/**
 * Lazily arm the unref'd sweep timer. `unref()` is load-bearing: it lets the
 * process exit cleanly instead of the timer keeping the event loop alive.
 *
 * @inner
 * @returns {void}
 */
function ensureSweepTimer() {
    if (!_sweepTimer && _sweepInterval > 0) {
        _sweepTimer = setInterval(function() { sweep(noop); }, _sweepInterval * 1000);
        if (_sweepTimer && typeof _sweepTimer.unref === 'function') {
            _sweepTimer.unref();
        }
    }
}

/**
 * Pump the queue: while a worker slot is free and a job is waiting, start it.
 * Re-entrancy is safe — settlement always runs on a later microtask (see
 * {@link runOne}), never synchronously inside this loop.
 *
 * @inner
 * @returns {void}
 */
function drain() {
    while (_running < _maxConcurrency && _queue.length > 0) {
        var entry = _queue.shift();
        _running++;
        runOne(entry);
    }
}

/**
 * Transition a job to `running`, invoke its deferred function, and route the
 * outcome to {@link settle}. The function is invoked from inside a resolved
 * Promise so a synchronous `throw` and an async rejection take the identical
 * failure path and settlement is always deferred (no re-entrant {@link drain}).
 *
 * @inner
 * @param   {{id:string, fn:function}} entry
 * @returns {void}
 */
function runOne(entry) {
    var id = entry.id;
    _store.get(id, function(getErr, rec) {
        if (getErr || !rec) {
            // Record vanished (swept / removed) before the worker picked it up.
            _running--;
            drain();
            return;
        }
        rec.state     = STATES.RUNNING;
        rec.startedAt = Date.now();
        rec.updatedAt = rec.startedAt;
        rec.attempts  = (rec.attempts || 0) + 1;
        // Carried to settle() so the retry decision needs no extra store read
        // (the fn itself rides on the entry — it exists only in this process).
        entry.attempts    = rec.attempts;
        entry.maxAttempts = rec.maxAttempts || 1;
        _store.set(id, rec, function() {
            Promise.resolve().then(function() {
                return entry.fn();
            }).then(function(result) {
                settle(id, result, null, entry);
            }, function(rejErr) {
                settle(id, null, rejErr, entry);
            });
        });
    });
}

/**
 * Route a finished attempt. A failed attempt with retries remaining
 * (`attempts < maxAttempts`) is rescheduled: the record returns to `pending`
 * with the serialised failure kept visible and an informational
 * `nextRetryAt`, while `expiresAt` stays `null` so the sweep can never purge
 * a retryable job. Otherwise the terminal state is written, the worker slot
 * freed, and the queue pumped again. `failed` / `completed` are strictly
 * terminal, and the completion webhook fires only on that final transition.
 *
 * @inner
 * @param   {string} id
 * @param   {*}      result - Resolved value on success.
 * @param   {*}      err    - Thrown / rejected value on failure (mutually exclusive with `result`).
 * @param   {{id:string, fn:function, attempts:number, maxAttempts:number}} entry - In-process queue entry (carries the deferred fn for a reschedule).
 * @returns {void}
 */
function settle(id, result, err, entry) {
    var now = Date.now();

    // Retry path — only the process that created the job holds the fn, so a
    // reschedule can only ever originate here: a pod that merely reads the
    // record through a shared store never reaches this code for that id.
    if (err && entry && entry.attempts < entry.maxAttempts) {
        var delay = _retryBackoffMs * Math.pow(2, entry.attempts - 1);
        update(id, {
            state:       STATES.PENDING,
            error:       serializeError(err),
            nextRetryAt: now + delay
        }, function() {
            _running--;
            drain();
            scheduleRetry(entry, delay);
        });
        return;
    }

    var patch = err
        ? { state: STATES.FAILED,    error: serializeError(err), nextRetryAt: null, finishedAt: now, expiresAt: now + _ttl * 1000 }
        : { state: STATES.COMPLETED, result: result, error: null, nextRetryAt: null, finishedAt: now, expiresAt: now + _ttl * 1000 };

    update(id, patch, function(uErr, rec) {
        _running--;
        drain();
        // Best-effort completion webhook (opt-in via opts.callbackUrl). Fired
        // after drain() so the next job starts promptly; never affects the
        // worker or the job outcome (delivery != job result).
        if (rec && rec.callbackUrl) {
            try { deliverWebhook(rec); } catch (_e) { /* webhook never crashes the worker */ }
        }
    });
}

/**
 * Arm the unref'd backoff timer that re-enqueues a failed attempt's entry.
 * The timer closure is what keeps the deferred function alive between
 * attempts (no separate registry). {@link reset} cancels pending timers so
 * none can fire into a torn-down store, and the timer re-checks the store
 * before re-queueing (a reset may race an already-elapsed timer). Re-entry
 * goes through the normal queue, so retries respect `maxConcurrency` like
 * any other job.
 *
 * @inner
 * @param   {{id:string, fn:function}} entry
 * @param   {number} delay - Backoff delay (ms).
 * @returns {void}
 */
function scheduleRetry(entry, delay) {
    var t = setTimeout(function() {
        _retryTimers.delete(t);
        if (!_store) return; // reset() raced the timer
        _queue.push(entry);
        drain();
    }, delay);
    if (t && typeof t.unref === 'function') t.unref();
    _retryTimers.add(t);
}

/**
 * Best-effort completion webhook. POSTs `{ id, state, result, error }` to the
 * record's `callbackUrl` with retry/backoff and an optional HMAC signature.
 * Fire-and-forget: failures are recorded on the job (`webhookFailed`) but never
 * propagate to the worker or change the job outcome.
 *
 * @inner
 * @param   {JobRecord} record
 * @returns {void}
 */
function deliverWebhook(record) {
    if (!record || !record.callbackUrl) return;
    var payload;
    try {
        payload = JSON.stringify({ id: record.id, state: record.state, result: record.result, error: record.error });
    } catch (e) {
        update(record.id, { webhookFailed: true, webhookError: 'payload_serialize_failed' }, noop);
        return;
    }
    postWebhook(record, payload, 1);
}

/**
 * Single webhook POST attempt. Selects http/https by URL protocol, signs when
 * a secret is configured, and routes non-2xx / network errors to
 * {@link retryWebhook}. A `done` guard ensures exactly one outcome per attempt.
 *
 * @inner
 * @param   {JobRecord} record
 * @param   {string}    payload - Pre-serialised JSON body.
 * @param   {number}    attempt - 1-based attempt counter.
 * @returns {void}
 */
function postWebhook(record, payload, attempt) {
    var url;
    try {
        url = new URL(record.callbackUrl);
    } catch (e) {
        update(record.id, { webhookFailed: true, webhookError: 'invalid_callback_url' }, noop);
        return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        update(record.id, { webhookFailed: true, webhookError: 'unsupported_protocol' }, noop);
        return;
    }
    var transport = (url.protocol === 'https:') ? require('https') : require('http');
    var headers = {
        'content-type':   'application/json',
        'content-length': Buffer.byteLength(payload)
    };
    if (_webhookSecret) {
        headers['x-gina-signature'] = 'sha256=' +
            require('crypto').createHmac('sha256', _webhookSecret).update(payload).digest('hex');
    }
    var done = false;
    var fail = function(reason) { if (done) return; done = true; retryWebhook(record, payload, attempt, reason); };
    var ok   = function()       { if (done) return; done = true; update(record.id, { webhookDeliveredAt: Date.now() }, noop); };
    var req;
    try {
        req = transport.request(url, { method: 'POST', headers: headers, timeout: _webhookTimeoutMs }, function(res) {
            var good = (res.statusCode >= 200 && res.statusCode < 300);
            res.resume(); // drain so the socket frees
            if (good) { ok(); } else { fail('http_status_' + res.statusCode); }
        });
    } catch (e) {
        fail((e && e.message) || 'request_failed');
        return;
    }
    req.on('error',   function(err) { fail((err && err.message) || 'request_error'); });
    req.on('timeout', function()    { req.destroy(new Error('webhook_timeout')); });
    req.write(payload);
    req.end();
}

/**
 * Schedule the next webhook attempt with exponential backoff, or mark the job
 * `webhookFailed` once {@link DEFAULT_WEBHOOK_MAX_ATTEMPTS} (configurable) is
 * reached. The retry timer is unref'd so it never holds the process open.
 *
 * @inner
 * @param   {JobRecord} record
 * @param   {string}    payload
 * @param   {number}    attempt - The attempt that just failed (1-based).
 * @param   {string}    reason
 * @returns {void}
 */
function retryWebhook(record, payload, attempt, reason) {
    if (attempt >= _webhookMaxAttempts) {
        update(record.id, { webhookFailed: true, webhookError: reason }, noop);
        return;
    }
    var delay = _webhookBackoffMs * Math.pow(2, attempt - 1);
    var t = setTimeout(function() { postWebhook(record, payload, attempt + 1); }, delay);
    if (t && typeof t.unref === 'function') t.unref();
}

/**
 * Get-merge-set a partial patch onto a record. Store-agnostic (works for the
 * sync memory store and an async connector store).
 *
 * NOT atomic across the get/set pair. Safe because every writer for a given id
 * runs sequentially by construction — create, then the worker, then settle,
 * then the webhook outcome, all on the origin pod (other pods only read). Do
 * not add a concurrent same-id update() caller without adding per-id
 * serialisation first.
 *
 * @inner
 * @param   {string}   id
 * @param   {Object}   patch
 * @param   {function} [cb] - `cb(err, record)`.
 * @returns {void}
 */
function update(id, patch, cb) {
    _store.get(id, function(err, rec) {
        if (err || !rec) { if (cb) cb(err || null, null); return; }
        for (var k in patch) {
            if (Object.prototype.hasOwnProperty.call(patch, k)) rec[k] = patch[k];
        }
        rec.updatedAt = Date.now();
        _store.set(id, rec, function(setErr) {
            if (cb) cb(setErr || null, rec);
        });
    });
}

/**
 * Create and enqueue a job. Returns the `jobId` synchronously — the deferred
 * function starts on a later tick, so the caller can return the id to the
 * client before the slow work begins.
 *
 * Note: the deferred function runs AFTER the originating request has
 * completed. It must not close over `local.req` / `local.res` (the controller
 * nulls those at response exit) — capture plain values instead.
 *
 * @memberof module:gina/lib/job
 * @param   {function(): (Promise<*>|*)} fn   - The deferred work. May be `async`, return a Promise, or return a value synchronously.
 * @param   {Object}   [opts]
 * @param   {string}   [opts.callbackUrl]     - Webhook URL notified on completion (consumed by the webhook slice).
 * @param   {Object}   [opts.meta]            - Opaque metadata stored on the record.
 * @param   {number}   [opts.maxAttempts=1]   - Retry ceiling. Above 1, a failed attempt is retried on the creating process with exponential backoff (`retryBackoffMs`); `failed` is only ever the state after the last attempt.
 * @returns {string}                          - The job id.
 * @throws  {TypeError}                        - When `fn` is not a function.
 *
 * @example
 *   // In a controller action — return immediately, work runs out-of-band:
 *   var jobId = self.startJob(function() {
 *       return getModel('myModel').infer([{ role: 'user', content: prompt }]);
 *   });
 *   self.renderJSON({ jobId: jobId });
 */
function create(fn, opts) {
    if (typeof fn !== 'function') {
        throw new TypeError('lib.job.create: fn must be a function');
    }
    opts = opts || {};
    ensureStarted();

    var id  = uuid(_idSize);
    var now = Date.now();
    /** @type {JobRecord} */
    var record = {
        id:          id,
        state:       STATES.PENDING,
        result:      null,
        error:       null,
        attempts:    0,
        maxAttempts: (typeof opts.maxAttempts === 'number' && opts.maxAttempts > 0) ? Math.floor(opts.maxAttempts) : 1,
        callbackUrl: (typeof opts.callbackUrl === 'string' && opts.callbackUrl.length > 0) ? opts.callbackUrl : null,
        meta:        (opts.meta && typeof opts.meta === 'object') ? opts.meta : null,
        createdAt:   now,
        updatedAt:   now,
        startedAt:   null,
        finishedAt:  null,
        expiresAt:   null
    };

    _queue.push({ id: id, fn: fn });
    // Defer so create() returns the id before the function starts — and pump
    // only once the store has landed the record: with an async connector store
    // an immediate drain could reach runOne's get() before the set() has
    // persisted, and the vanished-record guard would silently drop the job.
    // (The memory store fires this callback synchronously — identical timing.)
    _store.set(id, record, function(setErr) {
        if (setErr) {
            console.warn('[lib.job] create: store.set failed for job `' + id + '` — the job will be dropped: ' + (setErr.message || setErr));
        }
        setImmediate(drain);
    });
    return id;
}

/**
 * Fetch a job record by id. Returns the full record (treat as read-only) so a
 * bundle's own authenticated route can read `result`. The built-in
 * `/_gina/jobs/:id` endpoint projects this to state-only via
 * {@link toStatusView}.
 *
 * @memberof module:gina/lib/job
 * @param   {string}   id
 * @param   {function} cb - `cb(err, record|null)`.
 * @returns {void}
 *
 * @example
 *   // In an authenticated controller action retrieving the result:
 *   self.jobStatus(req.params.id, function(err, job) {
 *       if (err || !job)              return self.throwError(404, 'unknown job');
 *       if (job.state !== 'completed') return self.renderJSON({ state: job.state });
 *       return self.renderJSON({ state: job.state, result: job.result });
 *   });
 */
function get(id, cb) {
    if (typeof cb !== 'function') cb = noop;
    if (!_store) { cb(null, null); return; }
    _store.get(id, function(err, rec) {
        cb(err || null, rec || null);
    });
}

/**
 * List job records, optionally filtered.
 *
 * @memberof module:gina/lib/job
 * @param   {?Object}  [filter]       - e.g. `{ state: 'failed' }`. Omit / `null` for all.
 * @param   {function} cb             - `cb(err, records)`.
 * @returns {void}
 *
 * @example
 *   lib.job.list({ state: 'running' }, function(err, jobs) { ... });
 */
function list(filter, cb) {
    if (typeof filter === 'function') { cb = filter; filter = null; }
    if (typeof cb !== 'function') cb = noop;
    if (!_store) { cb(null, []); return; }
    _store.list(filter || null, cb);
}

/**
 * Remove a job record by id.
 *
 * @memberof module:gina/lib/job
 * @param   {string}   id
 * @param   {function} [cb] - `cb(err, existed)`.
 * @returns {void}
 */
function remove(id, cb) {
    if (typeof cb !== 'function') cb = noop;
    if (!_store) { cb(null, false); return; }
    _store.remove(id, cb);
}

/**
 * #B471 — reclaim non-terminal records stranded by a DEAD process. The
 * deferred function lives only in its creating process (a closure cannot be
 * serialised), so a record left `running` — or `pending` past its scheduled
 * retry — by a process death can never settle: `expiresAt` stays `null`, the
 * TTL sweep's own `expires_at IS NOT NULL` guard excludes it forever, and a
 * consumer polling it polls forever. This pass terminalizes such records as
 * `failed` with error name `JobOrphanedError`, after which normal retention
 * applies and the ordinary sweep deletes them on schedule.
 *
 * Age gates (both on ceilings, so a LIVE process's work always survives):
 * - `running`:  last transition (`updatedAt`) older than the ceiling.
 * - `pending` with a scheduled retry: `now` past `nextRetryAt` + ceiling —
 *   a live origin retries at ~`nextRetryAt`, so the ceiling past it is
 *   unambiguous, and a record merely WAITING on backoff is never touched.
 * - plain `pending` (never ran): the `updatedAt` gate, like `running`.
 *
 * A record reclaimed while its origin was merely SLOW self-corrects: every
 * origin write (`update()`, the worker's running transition, a retry
 * re-enqueue) is unguarded last-write-wins, so the real outcome overwrites
 * the synthetic failure. The transient `failed` reading is the disclosed
 * cost. Reclaim fires NO completion webhook — under multi-process stores two
 * processes may reclaim concurrently (no cross-process claim verb exists),
 * and a self-healing job would otherwise emit contradictory notifications;
 * the record itself carries the truth.
 *
 * Skipped entirely when disabled (`orphanTimeout: 0`/`false`), when the
 * store is the BUILT-IN memory store (an in-process store cannot hold
 * another process's orphans), or when the store lacks `list` (a minimal
 * third-party store). Never throws; a list/update error is logged and the
 * pass moves on — a reclaim that broke the sweep would be a worse failure
 * than the strand it repairs.
 *
 * @inner
 * @param   {number}   now - Epoch ms.
 * @param   {function} cb  - `cb(reclaimedCount)`; never receives an error.
 * @returns {void}
 */
function reclaimOrphans(now, cb) {
    if (!_orphanTimeout || _storeIsBuiltinMemory || !_store || typeof _store.list !== 'function') {
        cb(0); return;
    }
    var ceilingMs = _orphanTimeout * 1000;
    var reclaimed = 0;
    var states    = [STATES.RUNNING, STATES.PENDING];
    var si        = 0;

    var nextState = function() {
        if (si >= states.length) {
            if (reclaimed > 0) {
                console.info('[lib.job] orphan reclaim: marked ' + reclaimed + ' stranded record(s) `failed` (JobOrphanedError, ceiling ' + _orphanTimeout + 's)');
            }
            cb(reclaimed); return;
        }
        var state = states[si]; si++;
        _store.list({ state: state }, function(listErr, recs) {
            if (listErr || !Array.isArray(recs)) {
                if (listErr) console.warn('[lib.job] orphan reclaim: list(' + state + ') failed — skipping this pass: ' + (listErr.message || listErr));
                return nextState();
            }
            var ri = 0;
            var nextRec = function() {
                if (ri >= recs.length) return nextState();
                var rec = recs[ri]; ri++;
                var stranded = false;
                if (state === STATES.RUNNING) {
                    stranded = (now - (rec.updatedAt || rec.startedAt || rec.createdAt || now)) > ceilingMs;
                } else if (rec.nextRetryAt) {
                    stranded = now > (rec.nextRetryAt + ceilingMs);
                } else {
                    stranded = (now - (rec.updatedAt || rec.createdAt || now)) > ceilingMs;
                }
                if (!stranded) return nextRec();
                update(rec.id, {
                    state:       STATES.FAILED,
                    error:       { name: 'JobOrphanedError', message: 'reclaimed: `' + state + '` past jobs.orphanTimeout (' + _orphanTimeout + 's) — the owning process likely exited before settling this job', stack: null },
                    nextRetryAt: null,
                    finishedAt:  now,
                    expiresAt:   now + _ttl * 1000
                }, function(uErr, updated) {
                    if (uErr) {
                        console.warn('[lib.job] orphan reclaim: update failed for job `' + rec.id + '`: ' + (uErr.message || uErr));
                    } else if (updated) {
                        reclaimed++;
                    }
                    nextRec();
                });
            };
            nextRec();
        });
    };
    nextState();
}

/**
 * Purge terminal records whose TTL has elapsed — preceded by the #B471
 * orphan-reclaim pass (see {@link reclaimOrphans}), so records a dead
 * process stranded become terminal and then age out through this same
 * purge. Invoked automatically by the internal timer; also callable
 * directly (e.g. from a bundle cron, or a test). The callback contract is
 * unchanged: `removedCount` counts DELETIONS only, never reclaims.
 *
 * @memberof module:gina/lib/job
 * @param   {function} [cb] - `cb(err, removedCount)`.
 * @returns {void}
 *
 * @example
 *   lib.job.sweep(function(err, removed) { ... });
 */
function sweep(cb) {
    if (typeof cb !== 'function') cb = noop;
    if (!_store) { cb(null, 0); return; }
    var now = Date.now();
    reclaimOrphans(now, function() {
        _store.sweep(now, cb);
    });
}

/**
 * Configure the primitive. Idempotent for resources (the store and sweep timer
 * are created at most once); knob arguments, when provided, always re-apply.
 * Called once per bundle from `gna.js`'s `server.on('started')`; safe before
 * the first {@link create}.
 *
 * @memberof module:gina/lib/job
 * @param   {Object}   [opts]
 * @param   {number}   [opts.maxConcurrency=4]   - Max concurrent workers.
 * @param   {number}   [opts.ttl=3600]           - Terminal-record TTL (seconds).
 * @param   {number}   [opts.sweepInterval=300]  - Sweep interval (seconds); `0` disables the internal timer.
 * @param   {number}   [opts.idSize=21]          - jobId length (characters).
 * @param   {number}   [opts.retryBackoffMs=1000]    - Base delay (ms) between attempts of a failed job with retries remaining; doubles each attempt.
 * @param   {number|boolean} [opts.orphanTimeout=86400] - Orphan-reclaim ceiling (SECONDS): a non-terminal record whose last transition is older than this is reclaimed as `failed` (`JobOrphanedError`) by the sweep pass — durable stores only, the built-in memory store is exempt. `0`/`false` disables; positive values are floored at 60.
 * @param   {number}   [opts.webhookMaxAttempts=3]   - Completion-webhook retry ceiling.
 * @param   {number}   [opts.webhookBackoffMs=500]   - Webhook backoff base (ms); doubles each retry.
 * @param   {number}   [opts.webhookTimeoutMs=5000]  - Per-attempt webhook request timeout (ms).
 * @param   {string}   [opts.webhookSecret]          - HMAC secret for signing webhook payloads (X-Gina-Signature). Omit to disable signing.
 * @param   {JobStore} [opts.store]              - Custom store (e.g. connector-backed). Defaults to the in-memory store.
 * @returns {boolean}                            - Always `true`.
 *
 * @example
 *   // Production (called by gna.js when the bundle starts):
 *   lib.job.start({ maxConcurrency: 8, ttl: 1800 });
 */
function start(opts) {
    opts = opts || {};
    if (typeof opts.maxConcurrency === 'number' && opts.maxConcurrency > 0) {
        _maxConcurrency = Math.floor(opts.maxConcurrency);
    }
    if (typeof opts.ttl === 'number' && opts.ttl > 0) {
        _ttl = Math.floor(opts.ttl);
    }
    if (typeof opts.sweepInterval === 'number' && opts.sweepInterval >= 0) {
        _sweepInterval = Math.floor(opts.sweepInterval);
    }
    if (typeof opts.idSize === 'number' && opts.idSize > 0) {
        _idSize = Math.floor(opts.idSize);
    }
    if (typeof opts.retryBackoffMs === 'number' && opts.retryBackoffMs >= 0) {
        _retryBackoffMs = Math.floor(opts.retryBackoffMs);
    }
    // 0 / false disables the orphan-reclaim pass; a positive value is floored
    // at 60s so a mistyped tiny ceiling cannot reclaim jobs mid-flight.
    if (opts.orphanTimeout === 0 || opts.orphanTimeout === false) {
        _orphanTimeout = 0;
    } else if (typeof opts.orphanTimeout === 'number' && opts.orphanTimeout > 0) {
        _orphanTimeout = Math.max(60, Math.floor(opts.orphanTimeout));
    }
    if (typeof opts.webhookMaxAttempts === 'number' && opts.webhookMaxAttempts > 0) {
        _webhookMaxAttempts = Math.floor(opts.webhookMaxAttempts);
    }
    if (typeof opts.webhookBackoffMs === 'number' && opts.webhookBackoffMs >= 0) {
        _webhookBackoffMs = Math.floor(opts.webhookBackoffMs);
    }
    if (typeof opts.webhookTimeoutMs === 'number' && opts.webhookTimeoutMs > 0) {
        _webhookTimeoutMs = Math.floor(opts.webhookTimeoutMs);
    }
    if (typeof opts.webhookSecret === 'string' && opts.webhookSecret.length > 0) {
        _webhookSecret = opts.webhookSecret;
    }
    if (!_store) {
        if (opts.store && typeof opts.store === 'object') {
            _store = opts.store;
            _storeIsBuiltinMemory = false;
        } else {
            _store = createMemoryStore();
            _storeIsBuiltinMemory = true;
        }
    } else if (opts.store && typeof opts.store === 'object' && opts.store !== _store) {
        // Store adoption is once-only: a store arriving after one is installed
        // (e.g. a create() already ran ensureStarted() and defaulted to the
        // memory store) would strand the earlier records, so it is refused —
        // loudly, because silently ignoring it loses the configured durability.
        console.warn('[lib.job] start: a job store is already installed — the `store` option was ignored. Wire `jobs.store` before the first create().');
    }
    ensureSweepTimer();
    return true;
}

/**
 * Snapshot of worker state. Useful for tests (asserting the concurrency cap)
 * and a future admin view. `retryWaiting` counts failed attempts currently
 * awaiting their backoff timer.
 *
 * @memberof module:gina/lib/job
 * @returns {{running:number, queued:number, maxConcurrency:number, retryWaiting:number}}
 */
function stats() {
    return { running: _running, queued: _queue.length, maxConcurrency: _maxConcurrency, retryWaiting: _retryTimers.size };
}

/**
 * Project a record to the state-only view exposed by the always-on
 * `/_gina/jobs/:id` endpoint. Deliberately omits `result` / `error` so the
 * public polling surface never leaks job payloads — authenticated result
 * retrieval goes through a bundle's own route via {@link get}.
 *
 * @memberof module:gina/lib/job
 * @param   {?JobRecord} rec
 * @returns {?{id:string, state:string, createdAt:number, updatedAt:number}}
 *
 * @example
 *   var view = lib.job.toStatusView(rec); // { id, state, createdAt, updatedAt }
 */
function toStatusView(rec) {
    if (!rec) return null;
    return {
        id:        rec.id,
        state:     rec.state,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt
    };
}

/**
 * Clear all module-level state and stop the sweep timer. Test-only — callers
 * holding job ids see them disappear.
 *
 * @memberof module:gina/lib/job
 * @returns {void}
 */
function reset() {
    if (_sweepTimer) {
        clearInterval(_sweepTimer);
        _sweepTimer = null;
    }
    _retryTimers.forEach(function(t) { clearTimeout(t); });
    _retryTimers.clear();
    _store          = null;
    _queue          = [];
    _running        = 0;
    _maxConcurrency = DEFAULT_MAX_CONCURRENCY;
    _ttl            = DEFAULT_TTL;
    _sweepInterval  = DEFAULT_SWEEP_INTERVAL;
    _idSize         = DEFAULT_ID_SIZE;
    _webhookMaxAttempts = DEFAULT_WEBHOOK_MAX_ATTEMPTS;
    _webhookBackoffMs   = DEFAULT_WEBHOOK_BACKOFF_MS;
    _webhookTimeoutMs   = DEFAULT_WEBHOOK_TIMEOUT_MS;
    _webhookSecret      = null;
    _retryBackoffMs     = DEFAULT_RETRY_BACKOFF_MS;
    _orphanTimeout      = DEFAULT_ORPHAN_TIMEOUT;
    _storeIsBuiltinMemory = false;
}

module.exports = {
    create:                 create,
    get:                    get,
    list:                   list,
    remove:                 remove,
    sweep:                  sweep,
    start:                  start,
    stats:                  stats,
    toStatusView:           toStatusView,
    reset:                  reset,
    STATES:                 STATES,
    DEFAULT_MAX_CONCURRENCY: DEFAULT_MAX_CONCURRENCY,
    DEFAULT_TTL:            DEFAULT_TTL,
    DEFAULT_SWEEP_INTERVAL: DEFAULT_SWEEP_INTERVAL,
    DEFAULT_ID_SIZE:        DEFAULT_ID_SIZE,
    DEFAULT_RETRY_BACKOFF_MS: DEFAULT_RETRY_BACKOFF_MS,
    DEFAULT_WEBHOOK_MAX_ATTEMPTS: DEFAULT_WEBHOOK_MAX_ATTEMPTS,
    DEFAULT_WEBHOOK_BACKOFF_MS:   DEFAULT_WEBHOOK_BACKOFF_MS,
    DEFAULT_WEBHOOK_TIMEOUT_MS:   DEFAULT_WEBHOOK_TIMEOUT_MS
};
