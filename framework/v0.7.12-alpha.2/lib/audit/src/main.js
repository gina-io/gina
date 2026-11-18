/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

/**
 * @module gina/lib/audit
 *
 * The #COMPLY2 audit-trail primitive — a user-attributed, append-only record
 * of "who did what to which record when", DISTINCT from `lib/logger`
 * (severity-level app logging): the trail has its own store and never rides
 * the logger sinks.
 *
 * - **Module-singleton.** Configuration and the store live at module scope and
 *   are adopted ONCE at bundle boot (`core/server.js` `init()` calls
 *   {@link start} after the fail-fast lint). Registered in `lib/index.js` with
 *   a plain `require` (never `_require`) — like `lib/job` / `State` / logger,
 *   `refreshCore()` re-runs `Lib()` on every dev-mode HTTP request, and
 *   `_require` would discard the adopted store + counters on each request.
 * - **File JSONL backend by default.** `audit.enabled: true` with no
 *   `audit.store` writes one JSON line per record to an append-only file
 *   (O_APPEND fd opened at boot — which also proves writability at boot).
 *   Writes are SERIALIZED through a FIFO queue: parallel `fs.write` calls on
 *   one fd complete in threadpool order, so without the queue the on-disk
 *   order could diverge from emit order — harmless for JSONL, fatal for the
 *   slice-3 HMAC hash chain (`hash = HMAC(key, prevHash + canonical(record))`),
 *   which is why the queue ships in the MVP.
 * - **Fire-and-forget by design.** A write failure is counted + logged
 *   (`console.error`) and NEVER thrown into the request path; the optional
 *   per-call callback is for callers that must confirm the write.
 * - **Tamper-evidence (opt-in, `audit.chain`).** Every record gains a `hash`
 *   chaining from its predecessor (HMAC-SHA256 over {@link canonicalV1}, hex),
 *   verified offline by `gina audit:verify` / {@link verifyChain}. Detects
 *   post-hoc edit, deletion, insertion and reordering by anyone WITHOUT the
 *   key. Explicit boundaries, stated rather than implied: truncation at the
 *   exact tail is invisible (nothing after it commits to it); a compromised
 *   writing process holds the key and can forge freely — stream the file to
 *   WORM storage (the documented isolation control) for that adversary; and
 *   without fsync, acknowledged records can be lost on a host crash (the
 *   chain stays consistent — loss is from the tail).
 * - **Correlation, not attribution.** `requestId` mirrors `req._ginaReqId`
 *   (always-on since #COMPLY2 slice 1) and honours a sanitized inbound
 *   `X-Request-Id`, so it is client-influenceable BY DESIGN — attribution is
 *   the `actor` snapshot (session-derived), never the id.
 * - **No require-time app dependency.** Node builtins only — the module loads
 *   standalone (the types-runtime-parity gate requires the whole lib registry
 *   at test load time).
 *
 * @package gina.framework
 * @namespace lib.audit
 * @author Rhinostone <contact@gina.io>
 */

var fs     = require('fs');
var path   = require('path');
var crypto = require('crypto');
var StringDecoder = require('string_decoder').StringDecoder;

/**
 * Chain genesis value — the `prevHash` of the very first chained record.
 * 64 zeros: the same width as a real hex digest, self-describing in a dump.
 *
 * @constant
 * @inner
 * @type {string}
 */
var CHAIN_GENESIS = '0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Upper bound (bytes) on the boot-time backwards tail read. A single trail
 * line larger than this is pathological (records are a few hundred bytes);
 * beyond it the resume gives up gracefully (GENESIS + a torn marker) rather
 * than scanning an unbounded file.
 *
 * @constant
 * @inner
 * @type {number}
 */
var CHAIN_TAIL_MAX = 1048576;

/**
 * The audit store seam — what a backend must implement. The default file
 * backend ({@link createFileStore}) serializes records to JSONL; a connector
 * store (resolved by `lib/audit-store`, demand-gated) would persist the same
 * record object its own way.
 *
 * @typedef {object} AuditStore
 * @property {function(AuditRecord, function(?Error)=): void} append - Persist one record. MUST be append-only (never update/delete) and MUST report failure through the callback, never by throwing.
 * @property {function(): void} close - Release the backend handle. NOT called on the request path — provided for tests and explicit teardown.
 * @property {?string} [path] - The destination path when the backend is file-based (surfaced by {@link stats} and the boot log).
 */

/**
 * One audit record (schema v1 — the locked #COMPLY2 shape).
 *
 * @typedef {object} AuditRecord
 * @property {string}  id        - Record id (`crypto.randomUUID()`).
 * @property {number}  ts        - Epoch ms at emit time.
 * @property {?string} requestId - `req._ginaReqId` (always-on since slice 1); null off-request.
 * @property {{key: *, roles: string[], machine: boolean=}} actor - Snapshot: `session.user[actorKey]` + a COPY of `user.roles`. NEVER the whole user object (PII). For a #MS3 machine caller (no session): the caller NAME as `key`, its configured roles, plus `machine: true`.
 * @property {string}  action    - App-defined verb, e.g. `"invoice.delete"`; framework auto-events use `"authz.denied"`.
 * @property {*}       [resource] - App-defined subject, e.g. an id — present only when the caller passed one.
 * @property {object}  [meta]     - App-defined extras — present only when passed. Framework authz auto-events carry `{ outcome: '401'|'login-bounce'|'403-roles'|'403-policy' }` here.
 * @property {?string} ip        - Socket remoteAddress, `::ffff:`-normalized. `X-Forwarded-For` is NEVER read (the #OBS1 rule — that header is attacker-writable).
 * @property {?string} rule      - `req.routing.rule` (cardinality-safe, the metrics precedent).
 * @property {?string} method    - HTTP method.
 * @property {?string} bundle    - The booted bundle (captured at {@link start}).
 * @property {?string} env       - The booted env (captured at {@link start}).
 * @property {string}  [hash]    - Tamper-evidence chain digest (present only when `audit.chain` is enabled): 64-char lowercase hex of `HMAC-SHA256(secret, prevHash + ':' + canonicalV1(record-without-hash))`, where `prevHash` is the previous record's `hash` (or {@link CHAIN_GENESIS} for the first). Appended LAST at write time; the canonical form is key-sorted, so field position never affects the digest.
 */

/**
 * Resolved configuration — adopted once by {@link start}, null until then.
 * `null` doubles as the "audit disabled" state: `core/server.js` only calls
 * `start()` when `settings.json > audit.enabled === true`.
 *
 * @inner
 * @type {?{bundle: ?string, env: ?string, actorKey: string, eventsAuthz: boolean}}
 */
var _conf = null;

/**
 * The adopted store ({@link AuditStore}), null until {@link start}.
 * @inner
 * @type {?AuditStore}
 */
var _store = null;

/** Records successfully persisted since boot. @inner @type {number} */
var _written = 0;

/** Records dropped (serialization or write failure, or a bad `action`). @inner @type {number} */
var _dropped = 0;

/** @inner */
function noop() {}

/**
 * Build the default append-only JSONL file backend.
 *
 * Creates the parent directory (recursive) and opens the file with the
 * `'a'` flag at BOOT — so an unwritable destination fails the boot (the
 * caller's #B57 catch), never the first request. Each record is one
 * `JSON.stringify(record) + '\n'` line; a record whose `meta` cannot be
 * stringified (circular) fails through the callback and is dropped by the
 * caller — other records are unaffected.
 *
 * Writes are serialized (one in-flight `fs.write` at a time, FIFO): O_APPEND
 * makes each line land whole, but only the queue makes on-disk ORDER match
 * emit order — the property the slice-3 hash chain needs.
 *
 * @inner
 * @param   {string} filePath - Absolute destination (`.jsonl`).
 * @returns {AuditStore}
 * @throws  {Error} When the directory cannot be created or the file cannot be opened for append.
 */
function createFileStore(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    var fd = fs.openSync(filePath, 'a');

    var queue   = [];
    var writing = false;

    var drain = function() {
        if (writing || queue.length === 0) return;
        writing = true;
        var item = queue.shift();
        fs.write(fd, item.line, function(err) {
            writing = false;
            item.cb(err || null);
            drain();
        });
    };

    return {
        path: filePath,
        append: function(record, cb) {
            cb = (typeof cb === 'function') ? cb : noop;
            var line;
            try {
                line = JSON.stringify(record) + '\n';
            } catch (serr) {
                return cb(serr);
            }
            queue.push({ line: line, cb: cb });
            drain();
        },
        close: function() {
            try { fs.closeSync(fd); } catch (cerr) { /* best-effort teardown */ }
        }
    };
}

/**
 * Canonical serialization v1 — the deterministic form the chain digest
 * commits to. `JSON.stringify`'s output depends on key insertion order
 * (`resource`/`meta` are conditionally inserted mid-record), so it is NOT a
 * canonicalisation; this one is: object keys are sorted (UTF-16 code-unit
 * order, `Array.prototype.sort` default), arrays keep their order, primitives
 * serialize as `JSON.stringify` does.
 *
 * ⚠️ Operates on JSON VALUE SPACE — callers must project the input through a
 * `JSON.parse(JSON.stringify(x))` round-trip first (the chain store does, and
 * the verifier reads parsed-from-disk values, which are projected by
 * construction). Skipping the projection breaks write/verify symmetry for
 * `toJSON` types: a live `Date` would canonicalise as `{}` here while the
 * disk record holds its ISO string.
 *
 * Versioned by NAME: a future change to the canonical form ships as
 * `canonicalV2` + a records marker, never as a silent edit — every existing
 * trail's digests depend on this exact byte behaviour.
 *
 * @memberof module:gina/lib/audit
 * @param   {*} value - A JSON-projected value (object, array, or primitive).
 * @returns {string|undefined} The canonical string; `undefined` for `undefined` input (mirroring `JSON.stringify`).
 *
 * @example
 *   canonicalV1({ b: 1, a: { d: null, c: [2, 1] } });
 *   // -> '{"a":{"c":[2,1],"d":null},"b":1}'  — identical whatever the insertion order was
 */
function canonicalV1(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        var parts = [];
        for (var i = 0; i < value.length; i++) {
            var av = canonicalV1(value[i]);
            // JSON semantics: an un-serializable array slot becomes null
            parts.push(typeof av === 'undefined' ? 'null' : av);
        }
        return '[' + parts.join(',') + ']';
    }
    var keys = Object.keys(value).sort();
    var out = [];
    for (var k = 0; k < keys.length; k++) {
        var ov = canonicalV1(value[keys[k]]);
        // JSON semantics: an un-serializable object member is dropped
        if (typeof ov === 'undefined') continue;
        out.push(JSON.stringify(keys[k]) + ':' + ov);
    }
    return '{' + out.join(',') + '}';
}

/**
 * Compute one chain digest.
 *
 * @inner
 * @param   {string} secret    - The HMAC key.
 * @param   {string} prevHash  - The previous record's `hash` (or {@link CHAIN_GENESIS}).
 * @param   {string} canonical - {@link canonicalV1} of the record WITHOUT its `hash` field.
 * @returns {string} 64-char lowercase hex. Hex (not base64url, the CSRF token
 *          choice) because the digest lives in a log file read by humans and
 *          SIEM tooling, where hex is the convention — base64url's rationale
 *          (URL-safe compactness in a transported token) does not apply here.
 */
function chainDigest(secret, prevHash, canonical) {
    return crypto.createHmac('sha256', secret)
                 .update(prevHash + ':' + canonical)
                 .digest('hex');
}

/**
 * Wrap a store with the tamper-evidence hash chain. The seam is unchanged —
 * the wrapper IS an {@link AuditStore} — and the inner store stays dumb.
 *
 * Ordering is enforced HERE, by construction: one record in flight at a time,
 * the digest computed at DEQUEUE (so hash order == append order == emit
 * order), and `prevHash` advanced ONLY on a successful inner append — a
 * dropped record (disk full, serialization failure) never forks the on-disk
 * chain; the next record chains from the last record that actually landed.
 * The drop itself is still counted + logged by {@link write}.
 *
 * Caller callbacks are invoked through a guard, so a throwing consumer
 * callback can never stall the queue.
 *
 * @inner
 * @param   {AuditStore} inner - The wrapped backend (the file store today).
 * @param   {{secret: string, prevHash: string}} chainOpts - Key + resume point ({@link readChainTail}).
 * @returns {AuditStore}
 */
function createChainStore(inner, chainOpts) {
    var secret = chainOpts.secret;
    var prev   = chainOpts.prevHash || CHAIN_GENESIS;

    var queue = [];
    var busy  = false;

    var guardedCb = function(cb, err) {
        try { cb(err); } catch (cerr) {
            try { console.error('[audit] a write callback threw (the chain queue is unaffected): '+ (cerr.message || cerr)); } catch (e2) { /* never escalate */ }
        }
    };

    var drain = function() {
        if (busy || queue.length === 0) return;
        busy = true;
        var item   = queue.shift();
        var record = item.record;
        try {
            // Project into JSON value space FIRST (see canonicalV1's contract):
            // the digest must commit to what the DISK will hold, not to live
            // object graphs (Date & friends serialize through toJSON).
            var projected = JSON.parse(JSON.stringify(record));
            record.hash = chainDigest(secret, prev, canonicalV1(projected));
        } catch (serr) {
            busy = false;
            guardedCb(item.cb, serr);
            return drain();
        }
        inner.append(record, function(err) {
            if (!err) {
                prev = record.hash; // advance ONLY on success — a drop never forks the chain
            }
            busy = false;
            guardedCb(item.cb, err || null);
            drain();
        });
    };

    return {
        path: inner.path,
        append: function(record, cb) {
            queue.push({ record: record, cb: (typeof cb === 'function') ? cb : noop });
            drain();
        },
        close: function() {
            if (typeof inner.close === 'function') inner.close();
        }
    };
}

/**
 * O(1) boot-time resume: read the TAIL of an existing trail to recover the
 * chain anchor. Never scans the whole file — a bounded backwards window
 * ({@link CHAIN_TAIL_MAX}); whole-file integrity is `gina audit:verify`'s job.
 *
 * Anchor rule: the LAST complete line that parses as JSON and carries a
 * 64-hex `hash` (walking back through at most a handful of damaged lines).
 * A parseable hashless tail (a pre-chain trail) anchors at
 * {@link CHAIN_GENESIS}. Trailing garbage — a torn partial line from a crash
 * mid-write, or an unparseable complete line — is reported so {@link start}
 * can acknowledge it with a chained `audit.chain.break` record.
 *
 * @inner
 * @param   {string} filePath
 * @returns {{prevHash: string, torn: ?{reason: string, bytes: number}}}
 */
function readChainTail(filePath) {
    var fd = null;
    try {
        fd = fs.openSync(filePath, 'r');
    } catch (oerr) {
        return { prevHash: CHAIN_GENESIS, torn: null }; // no trail yet
    }
    try {
        var size = fs.fstatSync(fd).size;
        if (size === 0) {
            return { prevHash: CHAIN_GENESIS, torn: null };
        }
        var want = Math.min(size, CHAIN_TAIL_MAX);
        var buf  = Buffer.alloc(want);
        fs.readSync(fd, buf, 0, want, size - want);
        var text = buf.toString('utf8');

        var endsWithNL = text.charCodeAt(text.length - 1) === 10;
        var lines = text.split('\n');
        var tornPartial = null;
        if (endsWithNL) {
            lines.pop(); // the empty tail after the final newline
        } else if (size > want) {
            // The window itself starts mid-line AND ends mid-line — a single
            // line larger than the whole window: give up gracefully.
            return { prevHash: CHAIN_GENESIS, torn: { reason: 'oversized-tail-line', bytes: want } };
        } else {
            tornPartial = lines.pop(); // a crash mid-write left a partial line
        }

        // Walk back to the last parseable line carrying a valid chain hash.
        var torn = (tornPartial !== null && tornPartial.length > 0)
            ? { reason: 'torn-tail', bytes: Buffer.byteLength(tornPartial) }
            : null;
        var WALK_MAX = 8; // a real crash tears at most one line; more damage is verify's to report
        var walked = 0;
        for (var i = lines.length - 1; i >= 0 && walked < WALK_MAX; i--) {
            var line = lines[i];
            if (line.length === 0) continue; // empty lines carry nothing
            walked++;
            var parsed = null;
            try { parsed = JSON.parse(line); } catch (perr) {
                if (!torn) {
                    torn = { reason: 'unparseable-tail', bytes: Buffer.byteLength(line) };
                }
                continue;
            }
            if (parsed && typeof parsed.hash === 'string' && /^[0-9a-f]{64}$/.test(parsed.hash)) {
                return { prevHash: parsed.hash, torn: torn };
            }
            // Parseable but hashless: a pre-chain trail — the chain starts fresh.
            return { prevHash: CHAIN_GENESIS, torn: torn };
        }
        return { prevHash: CHAIN_GENESIS, torn: torn };
    } finally {
        if (fd !== null) {
            try { fs.closeSync(fd); } catch (cerr) { /* best-effort */ }
        }
    }
}

/**
 * Iterate a file line-by-line, synchronously, in bounded memory (64 KB
 * chunks + a UTF-8-safe decoder). Sync is deliberate: the only consumers are
 * the offline CLI and tests. Returning `false` from `onLine` stops early.
 *
 * @inner
 * @param {string} filePath
 * @param {function(string, number): (boolean|void)} onLine - `(line, lineNo)`, 1-indexed.
 */
function eachLineSync(filePath, onLine) {
    var fd = fs.openSync(filePath, 'r');
    try {
        var decoder = new StringDecoder('utf8');
        var buf = Buffer.alloc(65536);
        var rem = '', pos = 0, n, lineNo = 0, idx;
        while ((n = fs.readSync(fd, buf, 0, buf.length, pos)) > 0) {
            pos += n;
            rem += decoder.write(buf.subarray(0, n));
            while ((idx = rem.indexOf('\n')) >= 0) {
                lineNo++;
                if (onLine(rem.slice(0, idx), lineNo) === false) return;
                rem = rem.slice(idx + 1);
            }
        }
        rem += decoder.end();
        if (rem.length > 0) {
            lineNo++;
            onLine(rem, lineNo);
        }
    } finally {
        try { fs.closeSync(fd); } catch (cerr) { /* best-effort */ }
    }
}

/**
 * @typedef {object} ChainVerifyResult
 * @property {boolean} ok        - `true` when the chain is intact (warnings allowed — read them).
 * @property {number}  records   - Chained records verified.
 * @property {number}  unchained - Pre-chain (hashless) records in the leading prefix.
 * @property {?{line: number, reason: string}} breakAt - First break, when `ok` is false.
 * @property {Array<{line: number, type: string}>} warnings - Non-fatal findings (acknowledged breaks, an unacknowledged torn tail).
 */

/**
 * Walk a trail file and verify its hash chain — the engine behind
 * `gina audit:verify`.
 *
 * Rules (each one closes a hole, none is cosmetic):
 * - Hashless records are legal ONLY as a contiguous leading prefix (a trail
 *   that predates the chain). Anywhere later they FAIL — otherwise inserting
 *   unhashed lines would be free tampering.
 * - An unparseable line FAILS unless the next record is a chained
 *   `audit.chain.break` acknowledgment ({@link start} writes one when it
 *   resumes over a torn tail) — reported as a warning, never silently passed.
 *   Only ONE damaged line per acknowledgment; consecutive garbage FAILS.
 * - Empty lines are skipped (they carry nothing and cannot smuggle content).
 * - A trailing unparseable line with no acknowledgment yet (the
 *   crash-just-happened state) is a warning: the chain is intact up to the
 *   last complete record, and the next boot will acknowledge.
 * - Digest comparison is constant-time (`crypto.timingSafeEqual`).
 *
 * What an intact chain does NOT prove (documented, by design): truncation at
 * the exact tail is invisible (nothing after it commits to it); an empty or
 * absent file verifies trivially (`records: 0` — read the count); and the
 * process holding the key can forge any chain. Stream the file to WORM
 * storage for the stronger adversary.
 *
 * @memberof module:gina/lib/audit
 * @param   {string} filePath - The trail (JSONL).
 * @param   {string} secret   - The chain HMAC key.
 * @returns {ChainVerifyResult}
 *
 * @example
 *   var result = lib.audit.verifyChain('/srv/app/logs/audit-web-prod.jsonl', process.env.MY_AUDIT_KEY);
 *   // -> { ok: true, records: 1042, unchained: 17, breakAt: null, warnings: [] }
 */
function verifyChain(filePath, secret) {
    var result = { ok: true, records: 0, unchained: 0, breakAt: null, warnings: [] };
    var prev = CHAIN_GENESIS;
    var chainStarted = false;
    var pendingGarbage = null; // {line}

    var fail = function(line, reason) {
        result.ok = false;
        result.breakAt = { line: line, reason: reason };
        return false; // stops eachLineSync
    };

    eachLineSync(filePath, function(line, lineNo) {
        if (line.length === 0) return; // empty lines carry nothing

        var parsed = null;
        try { parsed = JSON.parse(line); } catch (perr) {
            if (pendingGarbage) {
                return fail(lineNo, 'unparseable line (second consecutive — a crash tears at most one)');
            }
            pendingGarbage = { line: lineNo };
            return;
        }

        var hasHash = (parsed && typeof parsed.hash === 'string');
        if (!hasHash) {
            if (pendingGarbage) {
                return fail(pendingGarbage.line, 'unparseable line not followed by a chained acknowledgment');
            }
            if (!chainStarted) {
                result.unchained++;
                return; // pre-chain prefix
            }
            return fail(lineNo, 'unchained record after chain start');
        }

        if (!/^[0-9a-f]{64}$/.test(parsed.hash)) {
            return fail(lineNo, 'malformed hash field');
        }

        var recordHash = parsed.hash;
        delete parsed.hash;
        var expected = chainDigest(secret, prev, canonicalV1(parsed));
        var okDigest = false;
        try {
            okDigest = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(recordHash, 'hex'));
        } catch (terr) {
            okDigest = false;
        }
        if (!okDigest) {
            if (pendingGarbage) {
                return fail(pendingGarbage.line, 'unparseable line not followed by a chained acknowledgment');
            }
            return fail(lineNo, 'hash mismatch — the record does not chain from its predecessor');
        }

        if (pendingGarbage) {
            if (parsed.action === 'audit.chain.break') {
                result.warnings.push({ line: pendingGarbage.line, type: 'acknowledged-break' });
                pendingGarbage = null;
            } else {
                return fail(pendingGarbage.line, 'unparseable line not followed by a chained acknowledgment');
            }
        }

        prev = recordHash;
        chainStarted = true;
        result.records++;
    });

    if (result.ok && pendingGarbage) {
        // The crash-just-happened state: torn tail, no boot has acknowledged yet.
        result.warnings.push({ line: pendingGarbage.line, type: 'torn-tail-unacknowledged' });
    }
    return result;
}

/**
 * Snapshot the acting user off the request session.
 *
 * Reads `req.session.user` (the framework's authenticated contract — the
 * #COMPLY1 `isAuthenticated` predicate) and keeps exactly TWO things: the
 * configured `actorKey` property and a COPY of `user.roles`. The whole user
 * object is never stored (PII — the COMPLY5 synergy); `roles` is `.slice()`d
 * so a later in-request mutation cannot rewrite an already-emitted record.
 *
 * @inner
 * @param   {?object} req
 * @returns {{key: *, roles: string[], machine: boolean=}} `{ key: null, roles: [] }` when
 *          unauthenticated or off-request; `{ key: <callerName>, roles, machine: true }`
 *          for a #MS3 machine caller (no session, `req.machineCaller` stamped by the gate).
 */
function deriveActor(req) {
    var user = (
        req && req.session && typeof req.session === 'object'
        && req.session.user && typeof req.session.user === 'object'
    ) ? req.session.user : null;

    if (!user) {
        // #MS3 — a machine caller authenticated by the authz gate (Bearer key)
        // carries its identity on `req.machineCaller`, never on the session.
        // The caller NAME is the actor key (`actorKey` is a session-user
        // concept — a machine principal has no configurable id property), the
        // roles are COPIED for the same mutation-isolation reason as the
        // session path, and the record is marked `machine: true` so a reader
        // can tell machine actors from human ones. Session wins by
        // construction: this branch is only reached when no session user
        // exists — mirroring the gate's own precedence.
        var machine = (
            req && req.machineCaller && typeof req.machineCaller === 'object'
            && typeof req.machineCaller.name === 'string' && req.machineCaller.name
        ) ? req.machineCaller : null;
        if (machine) {
            return {
                key     : machine.name,
                roles   : Array.isArray(machine.roles) ? machine.roles.slice() : [],
                machine : true
            };
        }
        return { key: null, roles: [] };
    }
    var key = (typeof user[_conf.actorKey] !== 'undefined' && user[_conf.actorKey] !== null)
        ? user[_conf.actorKey]
        : null;
    return {
        key   : key,
        roles : Array.isArray(user.roles) ? user.roles.slice() : []
    };
}

/**
 * Resolve the client IP from the SOCKET, never from headers.
 * `X-Forwarded-For` is deliberately not read (the #OBS1 rule — the header is
 * attacker-writable, and an audit trail must not let the audited party choose
 * its own recorded address). IPv6-mapped IPv4 (`::ffff:10.0.0.1`) is
 * normalized to the bare IPv4 form, mirroring `lib/metrics`.
 *
 * @inner
 * @param   {?object} req
 * @returns {?string}
 */
function resolveIp(req) {
    var ip = null;
    if (req && req.socket && req.socket.remoteAddress) {
        ip = req.socket.remoteAddress;
    } else if (req && req.connection && req.connection.remoteAddress) {
        ip = req.connection.remoteAddress;
    }
    if (!ip) return null;
    return ip.replace(/^::ffff:/i, '');
}

/**
 * Build one {@link AuditRecord}. Every request-derived read is null-safe by
 * construction, so a released request (`local.req` nulled at a terminal exit —
 * the #B35 class) still yields a DEGRADED record (`requestId`/`ip`/`rule`/
 * `method` null, `actor` `{key:null, roles:[]}`) instead of a crash or a
 * dropped record — for a compliance trail, present-but-degraded beats absent.
 *
 * @inner
 * @param   {string} action
 * @param   {{req: ?object, resource: *, meta: *, actor: *}} fields
 * @returns {AuditRecord}
 */
function buildRecord(action, fields) {
    var req = fields.req || null;

    var record = {
        id        : crypto.randomUUID(),
        ts        : Date.now(),
        requestId : (req && typeof req._ginaReqId === 'string') ? req._ginaReqId : null,
        actor     : (fields.actor && typeof fields.actor === 'object') ? fields.actor : deriveActor(req),
        action    : action
    };
    if (typeof fields.resource !== 'undefined') {
        record.resource = fields.resource;
    }
    if (typeof fields.meta !== 'undefined') {
        record.meta = fields.meta;
    }
    record.ip     = resolveIp(req);
    record.rule   = (req && req.routing && typeof req.routing.rule === 'string') ? req.routing.rule : null;
    record.method = (req && typeof req.method === 'string') ? req.method : null;
    record.bundle = _conf.bundle;
    record.env    = _conf.env;

    return record;
}

/**
 * Adopt the boot-resolved configuration + store. Called ONCE by
 * `core/server.js` `init()` when `settings.json > audit.enabled === true`,
 * AFTER the fail-fast lint. Adoption is once-only (the `lib/job` precedent):
 * a second call is refused loudly — silently swapping the store mid-flight
 * would strand the earlier records.
 *
 * Building the default file store here (rather than at the first write) is
 * deliberate: `mkdirSync` + `openSync` throw on an unwritable destination, and
 * the caller's enclosing #B57 catch turns that into a boot refusal — an audit
 * trail that silently cannot write is the quietly-OFF class the lint exists
 * to prevent.
 *
 * When `opts.chain` is given, the file store is wrapped with the
 * tamper-evidence chain ({@link createChainStore}): the resume anchor is
 * recovered from the trail's TAIL in O(1) ({@link readChainTail}), and a torn
 * tail (crash mid-write) is acknowledged — `'\n'` is appended so the damaged
 * bytes end as their own line (append-only is preserved; nothing is deleted),
 * a loud `console.warn` fires, and a chained `audit.chain.break` record goes
 * out as the first write, carrying the damage report in its `meta`.
 * `gina audit:verify` reports that acknowledgment as a warning, never a pass.
 *
 * @memberof module:gina/lib/audit
 * @param {object}  opts
 * @param {?string} [opts.bundle]      - The booted bundle name (stamped on every record).
 * @param {?string} [opts.env]         - The booted env (stamped on every record).
 * @param {string}  [opts.actorKey=id] - `session.user` property snapshotted as `actor.key`.
 * @param {boolean} [opts.eventsAuthz=true] - Framework authz auto-events ({@link emitAuthzDenied}).
 * @param {AuditStore} [opts.store]    - A pre-built store (the `lib/audit-store` dispatcher path).
 * @param {string}  [opts.file]        - JSONL destination for the default file backend (required when no `store`).
 * @param {{secret: string}} [opts.chain] - Enable the tamper-evidence chain (file backend only).
 * @returns {boolean} `true` when adopted, `false` when already configured.
 * @throws  {Error} When neither `store` nor `file` is given, when the file destination cannot be opened for append, when `chain` is combined with `store` (a connector store cannot guarantee ordered append), or when `chain` lacks a non-empty `secret`.
 *
 * @example
 *   lib.audit.start({ bundle: 'web', env: 'prod', actorKey: 'id', file: '/srv/app/logs/audit-web-prod.jsonl' });
 *
 * @example
 *   // Tamper-evident: every record carries a `hash` chaining from its predecessor.
 *   lib.audit.start({ bundle: 'web', env: 'prod', file: '/srv/app/logs/audit-web-prod.jsonl', chain: { secret: process.env.MY_AUDIT_KEY } });
 */
function start(opts) {
    opts = opts || {};
    if (_conf) {
        console.warn('[audit] start: the audit trail is already configured — the new options were ignored.');
        return false;
    }

    var chainOpts = null;
    if (opts.chain && typeof opts.chain === 'object') {
        if (typeof opts.chain.secret !== 'string' || opts.chain.secret.length === 0) {
            throw new Error('[audit] `chain` requires a non-empty `secret` — tamper-evidence without a key would be silently OFF.');
        }
        chainOpts = { secret: opts.chain.secret, prevHash: CHAIN_GENESIS };
    }

    var store = null;
    var torn  = null;
    if (opts.store && typeof opts.store === 'object') {
        if (chainOpts) {
            // Defensive twin of the boot lint: the seam carries NO ordering
            // obligation, and a chain without ordered append forks silently.
            throw new Error('[audit] the hash chain requires the file backend — a connector `store` cannot guarantee ordered append.');
        }
        store = opts.store;
    } else if (typeof opts.file === 'string' && opts.file.length > 0) {
        if (chainOpts) {
            var tail = readChainTail(opts.file);
            chainOpts.prevHash = tail.prevHash;
            torn = tail.torn;
            if (torn && torn.reason === 'torn-tail') {
                // Terminate the partial line so the next record starts clean.
                // Append-only is preserved: the damaged bytes stay on file as
                // their own (unparseable) line, acknowledged below.
                fs.appendFileSync(opts.file, '\n');
            }
            if (torn) {
                console.warn('[audit] chain resume: the trail tail is damaged ('+ torn.reason +', '+ torn.bytes +' byte(s)) — resuming from the last intact record and appending a chained `audit.chain.break` acknowledgment. Run `gina audit:verify` for the full report.');
            }
        }
        store = createFileStore(opts.file); // throws on unwritable — the caller's #B57 catch owns it
        if (chainOpts) {
            store = createChainStore(store, chainOpts);
        }
    } else {
        throw new Error('[audit] start needs a `store` or a `file` destination.');
    }

    _conf = {
        bundle      : opts.bundle || null,
        env         : opts.env || null,
        actorKey    : (typeof opts.actorKey === 'string' && opts.actorKey.length > 0) ? opts.actorKey : 'id',
        eventsAuthz : (opts.eventsAuthz !== false),
        chain       : !!chainOpts
    };
    _store = store;

    if (torn) {
        // The acknowledgment is a REAL chained record through the normal
        // write path — unforgeable without the key, visible to verify.
        write('audit.chain.break', { meta: { reason: torn.reason, damagedBytes: torn.bytes } });
    }
    return true;
}

/**
 * Whether the trail is active (configured + store adopted). `false` means
 * every {@link write} is a benign no-op — `enabled` is deployment config, so
 * application code never needs to branch on it.
 *
 * @memberof module:gina/lib/audit
 * @returns {boolean}
 */
function isEnabled() {
    return !!(_conf && _store);
}

/**
 * Emit one audit record — the single write entry point (`self.audit()` and
 * the framework auto-events both land here).
 *
 * Fire-and-forget by default: a failure is counted ({@link stats} `dropped`)
 * and logged via `console.error`, never thrown into the request path. Pass a
 * callback to observe the write result (`cb(err)`); when the trail is
 * disabled the callback gets `cb(null)` — a vacuous success, so callers stay
 * config-agnostic.
 *
 * @memberof module:gina/lib/audit
 * @param {string}   action     - App-defined verb (`"invoice.delete"`). Non-empty string, else the record is dropped (counted + logged, never thrown).
 * @param {object}   [fields]   - `{ req, resource, meta, actor }` — all optional; `actor` overrides the session-derived snapshot.
 * @param {function(?Error)} [cb] - Optional write confirmation.
 * @returns {void}
 *
 * @example
 *   lib.audit.write('invoice.delete', { req: req, resource: invoiceId });
 */
function write(action, fields, cb) {
    if (typeof fields === 'function') { cb = fields; fields = null; }
    cb     = (typeof cb === 'function') ? cb : noop;
    fields = (fields && typeof fields === 'object') ? fields : {};

    if ( !isEnabled() ) {
        return cb(null);
    }
    if (typeof action !== 'string' || action.length === 0) {
        _dropped++;
        console.error('[audit] dropped a record: `action` must be a non-empty string (got: '+ JSON.stringify(action) +')');
        return cb(new Error('[audit] `action` must be a non-empty string'));
    }

    var record = buildRecord(action, fields);
    _store.append(record, function(err) {
        if (err) {
            _dropped++;
            console.error('[audit] write failed — the record was dropped (dropped so far: '+ _dropped +'): '+ (err.message || err));
            return cb(err);
        }
        _written++;
        return cb(null);
    });
}

/**
 * Framework auto-event for an authorization denial (#COMPLY2 locked decision
 * 3 — ON by default when the trail is enabled; `settings.json >
 * audit.events.authz: false` opts out). Called by `lib/authz-gate`'s two deny
 * writers; the outcome (`'401'` / `'login-bounce'` / `'403-roles'` /
 * `'403-policy'`) rides in `meta.outcome`, so the record schema stays v1.
 *
 * The WHOLE body is contained: an audit failure must never change an
 * authorization outcome, so nothing here can throw into the gate.
 *
 * Flood caveat (documented, accepted): unauthenticated 401s make this an
 * attacker-writable line — like any log line; throttling is COMPLY6's job.
 *
 * @memberof module:gina/lib/audit
 * @param {?object} req     - The denied request (actor derives from its session when present).
 * @param {string}  outcome - `'401' | 'login-bounce' | '403-roles' | '403-policy'`.
 * @returns {void}
 */
function emitAuthzDenied(req, outcome) {
    try {
        if ( !isEnabled() || _conf.eventsAuthz === false ) {
            return;
        }
        write('authz.denied', { req: req, meta: { outcome: String(outcome || 'denied') } });
    } catch (err) {
        try { console.error('[audit] authz auto-event failed (the denial itself is unaffected): '+ (err.message || err)); } catch (e2) { /* never escalate */ }
    }
}

/**
 * Counters + destination snapshot — for tests and the boot log.
 *
 * @memberof module:gina/lib/audit
 * @returns {{enabled: boolean, chain: boolean, written: number, dropped: number, path: ?string}}
 */
function stats() {
    return {
        enabled : isEnabled(),
        chain   : !!(_conf && _conf.chain),
        written : _written,
        dropped : _dropped,
        path    : (_store && _store.path) || null
    };
}

/**
 * Test-only teardown: close the store, reset config + counters so the next
 * `start()` adopts fresh. Never called on a production path (adoption is
 * once-per-boot by design).
 *
 * @memberof module:gina/lib/audit
 * @returns {void}
 */
function _resetForTest() {
    if (_store && typeof _store.close === 'function') {
        try { _store.close(); } catch (err) { /* best-effort */ }
    }
    _conf    = null;
    _store   = null;
    _written = 0;
    _dropped = 0;
}

module.exports = {
    start           : start,
    isEnabled       : isEnabled,
    write           : write,
    emitAuthzDenied : emitAuthzDenied,
    stats           : stats,
    canonicalV1     : canonicalV1,
    verifyChain     : verifyChain,
    _resetForTest   : _resetForTest,
    _readChainTail  : readChainTail,    // test surface only — resume edge cases (torn/oversized tails)
    _createChainStore : createChainStore // test surface only — the drop-never-forks + queue-liveness contracts need a failable inner store
};
