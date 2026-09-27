/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var crypto = require('crypto');

/**
 * @module gina/lib/maintenance
 *
 * Maintenance-mode primitive (#MAINT1). Pure, stateless helpers backing the
 * pre-routing maintenance gate carried by BOTH engines (`core/server.js`
 * `onRequest()` and `core/server.isaac.js`), per the `/_gina/*` endpoint-sync
 * rule.
 *
 * Why a lib rather than two inline blocks: the bypass logic is security-bearing
 * (constant-time compares, a keyed MAC, a fail-closed allowlist) and must be
 * unit-testable in isolation. The engines keep only the placement decision —
 * everything adjudicable lives here.
 *
 * Registered as a PLAIN `require` in `lib/index.js` (not `_require`): a
 * stateless pure-function leaf with no instance/singleton state to hot-reload —
 * the same #B32-residual precedent as `admin` / `merge` / `uuid`.
 *
 * NOTHING in this module reads `process.gina`, the config singleton, or any
 * injected global: every input arrives as an argument, so a caller can exercise
 * each branch without booting a bundle.
 *
 * That includes the `GINA_MAINTENANCE` boot variable (C3 slice b): the engine
 * reads it — on both launcher transports — and hands the VALUE to
 * {@link resolveBootEnv}; this module never consults the environment itself.
 *
 * And the replica sync (C3 slice c, `server.maintenance.store`): the engine
 * hands {@link resolveStoreSync} the kv facade and the bundle name, and
 * {@link createStoreSync} a namespace HANDLE — this module never requires
 * `lib/kv`, so the crypto-only import boundary holds and every branch of the
 * poll runs under a scripted namespace and mocked timers.
 *
 * @example
 * // engine-side, when maintenance is ON for this bundle
 * var verdict = lib.maintenance.evaluateBypass(request, conf, Date.now());
 * if (verdict.allowed && verdict.grant) {
 *     // set verdict.cookie, 302 to verdict.redirectTo
 * } else if (!verdict.allowed) {
 *     // render 503 + Retry-After
 * }
 */

/**
 * Default configuration, applied per-key when a value is absent or malformed.
 *
 * `retryAfter` is 300s (5 minutes) rather than #CE1's 30s: a transient
 * datastore blip resolves in seconds, an operator-declared maintenance window
 * does not, and an over-eager retry storm is exactly what the header exists to
 * prevent.
 *
 * @constant {object}
 */
var DEFAULTS = {
    enabled      : false,
    retryAfter   : 300,
    message      : 'Service Unavailable',
    bypassKey    : '',
    allowFrom    : [],
    store        : '',
    pollInterval : 2000
};

/**
 * Bounds of `server.maintenance.pollInterval` (ms) — the replica-sync poll
 * cadence. 250 ms is already one store round-trip per replica four times a
 * second; 60 s is the longest an operator should wait for a POST to fan out.
 * @constant {number}
 */
var POLL_MIN_MS = 250;
/** @constant {number} */
var POLL_MAX_MS = 60000;
/**
 * Version tag on the replica-sync store record; a record carrying any other
 * value is ignored by {@link applyStoreRecord} (kept last-known, never "off").
 * @constant {number}
 */
var STORE_RECORD_V = 1;

/**
 * Name of the bypass cookie set on a successful `?gina-maintenance-key=` grant.
 * @constant {string}
 */
var BYPASS_COOKIE = 'gina.maintenance';

/**
 * Query-string parameter carrying the bypass key on the human entry path.
 * @constant {string}
 */
var BYPASS_QUERY_PARAM = 'gina-maintenance-key';

/**
 * Request header carrying the bypass key on the programmatic path.
 * @constant {string}
 */
var BYPASS_HEADER = 'x-gina-maintenance-key';

/**
 * Lifetime of a minted bypass cookie, in milliseconds (12 hours).
 *
 * Deliberately NOT configurable: every knob on a security surface is a way to
 * get it wrong, and 12h covers a working day's maintenance window while
 * bounding the damage of a leaked cookie. Rotate `bypassKey` to revoke early.
 *
 * @constant {number}
 */
var BYPASS_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Domain-separation prefix for the bypass-cookie MAC. Versioned so a future
 * format change cannot be confused with this one.
 * @constant {string}
 */
var MAC_CONTEXT = 'gina:maintenance:bypass:v1:';

/**
 * Minimum accepted `bypassKey` length. Shorter keys still work (refusing them
 * could lock an operator out mid-window) but earn a boot warning.
 * @constant {number}
 */
var MIN_KEY_LENGTH = 16;

/**
 * Constant-time string comparison that cannot throw and never early-exits on
 * the first differing byte.
 *
 * A plain `===` on a secret leaks its prefix through timing; `timingSafeEqual`
 * throws on a length mismatch, so the length guard comes first. Mirrors the
 * shipped `_agentKeyValid` shape in `core/server.js` (#INS9b).
 *
 * @inner
 * @param {string} a - first value (typically attacker-supplied)
 * @param {string} b - second value (typically the configured secret)
 * @returns {boolean} true when the two are byte-identical
 *
 * @example
 * _safeEqual('abc', 'abc'); // true
 * _safeEqual('abc', 'abd'); // false
 * _safeEqual('ab',  'abc'); // false (length guard, no throw)
 */
function _safeEqual(a, b) {
    if ( typeof(a) != 'string' || typeof(b) != 'string' || !a.length || !b.length ) {
        return false;
    }
    var bufA = Buffer.from(a);
    var bufB = Buffer.from(b);
    if ( bufA.length !== bufB.length ) {
        return false;
    }
    try {
        return crypto.timingSafeEqual(bufA, bufB);
    } catch (e) {
        return false;
    }
}

/**
 * Resolve a raw `server.maintenance` block into a complete, typed conf.
 *
 * Per-key fallback, never all-or-nothing: a bad `retryAfter` must not silently
 * disable the whole feature and leave an operator believing the site is closed.
 * Kept in sync with `lintConf()` below — the lint explains to a human exactly
 * what this function does silently.
 *
 * @param {object} [block] - the raw `settings.json > server.maintenance` block
 * @returns {object} `{enabled, retryAfter, message, bypassKey, allowFrom, store, pollInterval}` — always complete
 *
 * @example
 * resolveConf({ enabled: true, retryAfter: 60 });
 * // { enabled:true, retryAfter:60, message:'Service Unavailable', bypassKey:'', allowFrom:[] }
 *
 * @example
 * resolveConf({ enabled: 'yes' });   // enabled:false — only a strict boolean turns it on
 * resolveConf(null);                 // every default
 */
function resolveConf(block) {
    var conf = {
        enabled    : DEFAULTS.enabled,
        retryAfter : DEFAULTS.retryAfter,
        message    : DEFAULTS.message,
        bypassKey  : DEFAULTS.bypassKey,
        allowFrom  : DEFAULTS.allowFrom.slice(),
        store        : DEFAULTS.store,
        pollInterval : DEFAULTS.pollInterval
    };

    if ( typeof(block) != 'object' || block === null || Array.isArray(block) ) {
        return conf;
    }

    if ( block.enabled === true ) {
        conf.enabled = true;
    }
    if ( typeof(block.retryAfter) == 'number' && isFinite(block.retryAfter)
            && Math.floor(block.retryAfter) === block.retryAfter
            && block.retryAfter >= 1 && block.retryAfter <= 86400 ) {
        conf.retryAfter = block.retryAfter;
    }
    if ( typeof(block.message) == 'string' && block.message.length > 0 ) {
        conf.message = block.message;
    }
    if ( typeof(block.bypassKey) == 'string' && block.bypassKey.length > 0 ) {
        conf.bypassKey = block.bypassKey;
    }
    if ( Array.isArray(block.allowFrom) ) {
        var list = [];
        for (var i = 0; i < block.allowFrom.length; ++i) {
            if ( typeof(block.allowFrom[i]) == 'string' && block.allowFrom[i].length > 0 ) {
                list.push(block.allowFrom[i]);
            }
        }
        conf.allowFrom = list;
    }
    // C3 slice (c) — replica sync through a declared kv namespace. Per-key like
    // the rest: a malformed value falls back (no sync / default cadence) and the
    // lint says so; whether the NAMED namespace is usable is decided at boot by
    // resolveStoreSync(), which refuses rather than degrading.
    if ( typeof(block.store) == 'string' && block.store.length > 0 ) {
        conf.store = block.store;
    }
    if ( typeof(block.pollInterval) == 'number' && Number.isSafeInteger(block.pollInterval)
            && block.pollInterval >= POLL_MIN_MS && block.pollInterval <= POLL_MAX_MS ) {
        conf.pollInterval = block.pollInterval;
    }

    return conf;
}

/**
 * Boot-time shape check. Returns human-readable warnings; NEVER throws and
 * never signals "refuse the boot".
 *
 * Same contract as #CE1's `server.transientErrors` lint: the opt-in governs how
 * a request RENDERS, so a bad value must not cost a boot. `resolveConf()`
 * independently falls back to the same defaults at request time — this function
 * exists purely so the fallback is not silent.
 *
 * @param {object} [block] - the raw `settings.json > server.maintenance` block
 * @returns {string[]} zero or more warning messages, each ready to log verbatim
 *
 * @example
 * lintConf({ enabled: 'true' });
 * // ['`server.maintenance.enabled` must be a strict boolean — treating as disabled']
 *
 * @example
 * lintConf(undefined); // [] — an absent block is valid (feature off)
 */
function lintConf(block) {
    var warnings = [];

    if ( typeof(block) == 'undefined' || block === null ) {
        return warnings;
    }
    if ( typeof(block) != 'object' || Array.isArray(block) ) {
        warnings.push('`server.maintenance` must be an object — ignoring the whole block (feature off)');
        return warnings;
    }
    if ( typeof(block.enabled) != 'undefined' && block.enabled !== true && block.enabled !== false ) {
        warnings.push('`server.maintenance.enabled` must be a strict boolean — treating as disabled');
    }
    if ( typeof(block.retryAfter) != 'undefined'
            && !( typeof(block.retryAfter) == 'number' && isFinite(block.retryAfter)
                  && Math.floor(block.retryAfter) === block.retryAfter
                  && block.retryAfter >= 1 && block.retryAfter <= 86400 ) ) {
        warnings.push('`server.maintenance.retryAfter` must be an integer between 1 and 86400 seconds — using the default (' + DEFAULTS.retryAfter + ')');
    }
    if ( typeof(block.message) != 'undefined' && ( typeof(block.message) != 'string' || block.message.length === 0 ) ) {
        warnings.push('`server.maintenance.message` must be a non-empty string — falling back to the standard status text');
    }
    if ( typeof(block.bypassKey) != 'undefined' && typeof(block.bypassKey) != 'string' ) {
        warnings.push('`server.maintenance.bypassKey` must be a string — ignoring it (no key bypass)');
    } else if ( typeof(block.bypassKey) == 'string' && block.bypassKey.length > 0 && block.bypassKey.length < MIN_KEY_LENGTH ) {
        warnings.push('`server.maintenance.bypassKey` is shorter than ' + MIN_KEY_LENGTH + ' characters — mint a strong one (openssl rand -hex 24)');
    }
    if ( typeof(block.allowFrom) != 'undefined' && !Array.isArray(block.allowFrom) ) {
        warnings.push('`server.maintenance.allowFrom` must be an array of IP strings — ignoring it (no IP bypass)');
    } else if ( Array.isArray(block.allowFrom) && block.allowFrom.length > 0 ) {
        // Visible-footgun warning. The IP arm is skipped for any request
        // carrying a proxy signal, but a proxy that forwards `Host` verbatim
        // AND strips every `x-forwarded-*` header is indistinguishable from a
        // direct client — so listing a SHARED-EGRESS address (a proxy, LB or
        // NAT gateway) grants the bypass to everyone behind it. That is the
        // generic property of any IP allowlist rather than anything specific
        // here (`app.json > admin.allowFrom` behaves the same way, for more
        // sensitive endpoints), but maintenance is the axis most likely to be
        // configured in a hurry during an incident — so say it out loud.
        var _loopback = ( block.allowFrom.indexOf('127.0.0.1') > -1 || block.allowFrom.indexOf('::1') > -1 );
        warnings.push('`server.maintenance.allowFrom` is set — it is honoured ONLY for requests carrying no proxy signal, and it must never list a proxy/load-balancer/NAT address (that would grant the bypass to EVERYONE behind it). Behind a reverse proxy use `bypassKey` instead.'
            + ( _loopback
                ? ' ⚠️ It lists a LOOPBACK address, which is the single riskiest entry here: a same-host reverse proxy (the common nginx-in-front deployment) makes every visitor arrive from 127.0.0.1/::1. Unlike `admin.allowFrom`, loopback is NOT a safe default for this axis.'
                : '' ));
    }
    if ( typeof(block.store) != 'undefined' && ( typeof(block.store) != 'string' || block.store.length === 0 ) ) {
        warnings.push('`server.maintenance.store` must name a declared kv namespace (a non-empty string) — ignoring it (no replica sync)');
    }
    if ( typeof(block.pollInterval) != 'undefined'
            && !( typeof(block.pollInterval) == 'number' && Number.isSafeInteger(block.pollInterval)
                  && block.pollInterval >= POLL_MIN_MS && block.pollInterval <= POLL_MAX_MS ) ) {
        warnings.push('`server.maintenance.pollInterval` must be an integer between ' + POLL_MIN_MS + ' and ' + POLL_MAX_MS + ' milliseconds — using the default (' + DEFAULTS.pollInterval + ')');
    }
    if ( block.enabled === true && !( typeof(block.bypassKey) == 'string' && block.bypassKey.length > 0 ) ) {
        warnings.push('`server.maintenance.enabled` is true with no `bypassKey` — nobody can bypass the maintenance page from outside the host');
    }

    return warnings;
}


/**
 * Resolve the `GINA_MAINTENANCE` boot environment variable — the third way
 * to close a bundle, for processes that must boot CLOSED without a
 * `settings.json` edit (a replacement pod created during a window).
 *
 * The VALUE is injected by the caller, never read here: the two launchers
 * deliver the variable on different transports (`bin/cli` sweeps it into
 * `process.gina`, `bin/gina-container` leaves it in `process.env`), and that
 * transport question belongs to the engine — this module stays free of
 * `process.gina` / `process.env` so every branch is testable without a boot.
 *
 * Contract:
 *   - `'1'` or `'true'` (case-insensitive, trimmed) ⇒ `forced: true`.
 *   - unset / `null` / empty ⇒ `forced: false`, no warning.
 *   - `'0'` / `'false'` ⇒ `forced: false`, `explicitOff: true`, no warning —
 *     accepted as a valid "do not force", and deliberately NOT an override of
 *     a configured `enabled: true`. **It can only CLOSE, never OPEN**: the
 *     same fail-safe asymmetry as an expired `ttlSeconds` reverting to config
 *     rather than to "off" — a rollout-time variable must never be able to
 *     open a site the release's configuration says is closed.
 *   - any other value ⇒ `forced: false` PLUS a warning naming the accepted
 *     values — the #MAINT1 lint contract: never silent, never fatal.
 *
 * The caller folds `forced` into the CONFIG layer (`conf.enabled = true`), so
 * the runtime toggle keeps its meaning — `POST {enable:false}` still reopens
 * the process, exactly as with `enabled: true` in settings — and reports the
 * closure as `source: 'env'` in the status payload.
 *
 * @param {*} [raw] - the variable's value as delivered (a string, or undefined)
 * @returns {{forced: boolean, explicitOff: boolean, warning: ?string}}
 *
 * @example
 * resolveBootEnv('1');        // { forced: true,  explicitOff: false, warning: null }
 * resolveBootEnv('TRUE');     // { forced: true,  explicitOff: false, warning: null }
 * resolveBootEnv(undefined);  // { forced: false, explicitOff: false, warning: null }
 * resolveBootEnv('false');    // { forced: false, explicitOff: true,  warning: null } — cannot open
 * resolveBootEnv('yes');      // { forced: false, explicitOff: false, warning: '`GINA_MAINTENANCE` = "yes" is not recognised — …' }
 */
function resolveBootEnv(raw) {
    var out = { forced: false, explicitOff: false, warning: null };
    if ( typeof(raw) == 'undefined' || raw === null ) {
        return out;
    }
    var value = String(raw).trim();
    if ( value === '' ) {
        return out;
    }
    var lower = value.toLowerCase();
    if ( lower === '1' || lower === 'true' ) {
        out.forced = true;
        return out;
    }
    if ( lower === '0' || lower === 'false' ) {
        out.explicitOff = true;
        return out;
    }
    out.warning = '`GINA_MAINTENANCE` = ' + JSON.stringify(value)
        + ' is not recognised — use `1` or `true` to boot with maintenance ON'
        + ' (`0`, `false` or unset leave the configured state); the value is ignored';
    return out;
}

/**
 * Resolve the opt-in replica store sync (`server.maintenance.store`) — the
 * boot-time half of C3 slice (c). Mirrors `lib/rate-limit` / `lib/idempotency`
 * for a namespace reference: a dangling reference REFUSES the boot (thrown; the
 * caller — core/gna.js's `server.on('started')` band, where lib.kv is started
 * — turns it into the emerg + exit(1) refusal), because running silently
 * WITHOUT the coherence the operator configured is that property failing open — a deliberate, narrow exception to this module's "a malformed
 * block never refuses a boot" contract, which covers VALUE shape. Two
 * refusals and two warnings:
 *
 *   - the namespace cannot be handed out by `deps.kv` (kv unconfigured, name
 *     undeclared) ⇒ THROW, carrying the kv error.
 *   - the namespace runs `failMode: 'open'` ⇒ THROW. Under `open` a backend
 *     error degrades `get` to `null` — indistinguishable from "no record" — so
 *     a store outage would revert every replica to config mid-window, which
 *     is the one thing this feature must never do: a store outage must never
 *     OPEN a closed site.
 *   - memory-backed (no `store` on the namespace) ⇒ WARN: the state is per
 *     process and replicas will not follow each other; the feature runs,
 *     honestly labelled (the `lib/rate-limit` precedent).
 *   - redis without the fail-fast trio ⇒ WARN (the shared precedent wording).
 *
 * @param {object} conf - a conf from {@link resolveConf}
 * @param {object} deps
 * @param {object} deps.kv                 - the kv facade (`lib.kv`)
 * @param {string} deps.bundle             - the bundle name — the record's key, so one namespace may serve several bundles
 * @param {object} [deps.kvSettings]       - `settings.kv` (failMode / backend honesty)
 * @param {object} [deps.connectors]       - `connectors.json` content (redis tuning warn)
 * @param {function(string)} [deps.warn]   - warn sink
 * @returns {?{ns: object, name: string, key: string, intervalMs: number}} `null` when no store is configured
 * @throws {Error} on a dangling namespace, an `open` failMode, or a missing kv facade / bundle name
 *
 * @example
 * var sync = resolveStoreSync(conf, { kv: lib.kv, bundle: 'frontend', kvSettings: settings.kv });
 * if (sync) { createStoreSync({ state: state, ns: sync.ns, key: sync.key, name: sync.name, intervalMs: sync.intervalMs }).start(); }
 */
function resolveStoreSync(conf, deps) {
    if ( !conf || typeof(conf.store) != 'string' || conf.store.length === 0 ) {
        return null;
    }
    deps = deps || {};
    var _warn = ( typeof(deps.warn) == 'function' ) ? deps.warn : function(m){ console.warn('[maintenance] ' + m); };
    if ( typeof(deps.bundle) != 'string' || deps.bundle.length === 0 ) {
        throw new Error('[SERVER][#MAINT1] replica sync needs the bundle name as the record key — none reached the resolver');
    }
    if ( !deps.kv || typeof(deps.kv.get) != 'function' ) {
        throw new Error('[SERVER][#MAINT1] `server.maintenance.store` needs the kv primitive — no kv facade reached the resolver');
    }
    var ns;
    try {
        ns = deps.kv.get(conf.store);
    } catch (kvErr) {
        // the kv `default`-naming-undeclared precedent: refuse, never degrade
        // silently to a backend the operator did not ask for
        throw new Error('[SERVER][#MAINT1] `server.maintenance.store` = `' + conf.store + '` is not usable: ' + (kvErr.message || kvErr));
    }
    var nsConf = deps.kvSettings && deps.kvSettings.namespaces && deps.kvSettings.namespaces[conf.store];
    if ( nsConf && nsConf.failMode === 'open' ) {
        throw new Error('[SERVER][#MAINT1] `server.maintenance.store` = `' + conf.store + '` runs `failMode: "open"` — under it a store outage reads as "no record" and would reopen every replica mid-window; use `failMode: "closed"` (the default) for this namespace');
    }
    var storeName = nsConf && nsConf.store;
    if ( !storeName ) {
        _warn('`server.maintenance.store` = `' + conf.store + '` is MEMORY-backed: the maintenance state is PER PROCESS — replicas will NOT follow each other. Replica-shared maintenance needs a redis- or sqlite-backed namespace');
    } else {
        var connEntry = deps.connectors && deps.connectors[storeName];
        if ( connEntry && connEntry.connector === 'redis'
                && ( connEntry.enableOfflineQueue !== false || typeof(connEntry.commandTimeout) == 'undefined' ) ) {
            _warn('redis-backed namespace `' + conf.store + '`: set `enableOfflineQueue: false` and a `commandTimeout` on connectors.json entry `' + storeName + '` — with ioredis defaults an outage QUEUES the POST write and the poll instead of failing fast (the state stays as it was either way). The render-cache L2 ships this exact fail-fast trio');
        }
    }
    return { ns: ns, name: conf.store, key: deps.bundle, intervalMs: conf.pollInterval };
}

/**
 * The record a `POST /_gina/maintenance` writes to the shared store — the
 * runtime override plus who set it and when. Written on BOTH flips: an
 * `enable:false` writes `{active:false}` rather than deleting, so a replica
 * whose CONFIG says closed still sees the runtime-off override win, exactly as
 * it does locally.
 *
 * @param {object} runtime  - the local `{active, until, retryAfter, message}` just applied
 * @param {object} identity - `{pid, hostname}` of the process that took the POST
 * @param {number} [nowMs]  - injectable clock
 * @returns {object} the record (JSON-serializable; never a top-level null)
 *
 * @example
 * buildStoreRecord({ active: true, until: null }, { pid: 42, hostname: 'web-1' }, 1000);
 * // { v: 1, active: true, until: null, setBy: { pid: 42, hostname: 'web-1' }, at: 1000 }
 */
function buildStoreRecord(runtime, identity, nowMs) {
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    var rec = {
        v      : STORE_RECORD_V,
        active : !!( runtime && runtime.active === true ),
        until  : ( runtime && typeof(runtime.until) == 'number' && isFinite(runtime.until) ) ? runtime.until : null,
        setBy  : { pid: ( identity && identity.pid ) || null, hostname: ( identity && identity.hostname ) || null },
        at     : now
    };
    if ( runtime && typeof(runtime.retryAfter) == 'number' ) { rec.retryAfter = runtime.retryAfter; }
    if ( runtime && typeof(runtime.message) == 'string' )    { rec.message    = runtime.message; }
    return rec;
}

/**
 * Store TTL for a record: the remaining window in ms when `until` is set — so
 * the record VANISHES when the dead-man switch fires and every replica reverts
 * to config together — or `null` (no expiry) otherwise.
 *
 * @param {object} record - from {@link buildStoreRecord}
 * @param {number} [nowMs]
 * @returns {?number} positive integer ms, or null
 */
function storeRecordTtl(record, nowMs) {
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    if ( record && typeof(record.until) == 'number' && isFinite(record.until) ) {
        return Math.max(1, Math.ceil(record.until - now));
    }
    return null;
}

/**
 * Apply a record read from the store to the local state. Pure — the caller
 * owns the I/O. `null` (no record) clears the runtime: the only ways a key is
 * absent are "nothing written since the store was emptied" and "the record's
 * TTL lapsed", both of which mean CONFIG. A malformed record is IGNORED and
 * the last-known state kept — never read as "off".
 *
 * @param {object} state  - the engine-instance state `{conf, runtime, …}`
 * @param {*}      record - what `ns.get(key)` resolved
 * @returns {string} `'applied'` | `'cleared'` | `'malformed'`
 *
 * @example
 * applyStoreRecord(state, { v: 1, active: true, until: null });  // 'applied' — state.runtime.active === true
 * applyStoreRecord(state, null);                                  // 'cleared' — state.runtime === null
 * applyStoreRecord(state, { v: 7 });                              // 'malformed' — state untouched
 */
function applyStoreRecord(state, record) {
    if ( record === null || typeof(record) == 'undefined' ) {
        state.runtime = null;
        return 'cleared';
    }
    if ( typeof(record) != 'object' || record.v !== STORE_RECORD_V
            || ( record.active !== true && record.active !== false )
            || !( record.until === null || typeof(record.until) == 'undefined'
                  || ( typeof(record.until) == 'number' && isFinite(record.until) ) ) ) {
        return 'malformed';
    }
    var rt = { active: record.active, until: ( typeof(record.until) == 'number' ) ? record.until : null };
    if ( typeof(record.retryAfter) == 'number' ) { rt.retryAfter = record.retryAfter; }
    if ( typeof(record.message) == 'string' )    { rt.message    = record.message; }
    state.runtime = rt;
    return 'applied';
}

/**
 * The poll — the read half of the replica sync. One unref'd interval per
 * process; each tick reads the record and writes it into the LOCAL state the
 * gate already reads synchronously, so the gate never awaits anything (#B383)
 * and costs nothing more when the feature is off (#P39: no interval exists
 * then). Rules the tick enforces:
 *
 *   - ticks never overlap: while a `get` is in flight later ticks are skipped,
 *     so a hung store (an ioredis offline queue) cannot pile them up;
 *   - a resolved record is applied; a resolved `null` clears to config;
 *   - a REJECTION keeps the last-known state — an outage must never open a
 *     closed site — and warns ONCE per outage, then once more on recovery;
 *   - the first tick fires at `start()`, so a replica joining mid-window
 *     converges in one store round-trip rather than one interval.
 *
 * `state.sync` carries `{store, key, lastSyncAt, lastError}` for the status
 * payload. Everything is injected — the namespace handle, the clock, the warn
 * sink — and the timers are the globals, so a test drives it with mocked
 * timers and a scripted namespace.
 *
 * @param {object} opts
 * @param {object} opts.state        - the engine-instance state
 * @param {object} opts.ns           - the kv namespace handle (`get(key)` → Promise)
 * @param {string} opts.key          - the record key (the bundle name)
 * @param {string} [opts.name]       - the namespace name, for the payload
 * @param {number} [opts.intervalMs] - poll cadence (default `DEFAULTS.pollInterval`)
 * @param {function} [opts.now]      - injectable clock
 * @param {function(string)} [opts.warn]
 * @returns {{start: function, stop: function, tick: function, isRunning: function}}
 * @throws {TypeError} when the state, namespace handle or key is missing
 *
 * @example
 * var syncer = createStoreSync({ state: state, ns: sync.ns, key: sync.key, name: sync.name, intervalMs: sync.intervalMs });
 * syncer.start();   // arms the unref'd interval and fires the first tick
 */
function createStoreSync(opts) {
    opts = opts || {};
    var state      = opts.state;
    var ns         = opts.ns;
    var key        = opts.key;
    var intervalMs = ( typeof(opts.intervalMs) == 'number' && opts.intervalMs > 0 ) ? opts.intervalMs : DEFAULTS.pollInterval;
    var now        = ( typeof(opts.now) == 'function' ) ? opts.now : Date.now;
    var warn       = ( typeof(opts.warn) == 'function' ) ? opts.warn : function(m){ console.warn('[maintenance] ' + m); };
    if ( !state || typeof(state) != 'object' )  { throw new TypeError('[maintenance] createStoreSync needs the engine state object'); }
    if ( !ns || typeof(ns.get) != 'function' )   { throw new TypeError('[maintenance] createStoreSync needs a kv namespace handle'); }
    if ( typeof(key) != 'string' || key === '' ) { throw new TypeError('[maintenance] createStoreSync needs a non-empty record key'); }

    var timer    = null;
    var inFlight = false;
    var erroring = false;

    /**
     * One poll. Never rejects — every branch resolves an outcome string, so the
     * interval's dropped promise can never become an unhandled rejection.
     * @inner
     * @returns {Promise<string>} `'applied'` | `'cleared'` | `'malformed'` | `'error'` | `'skipped'`
     */
    function tick() {
        if ( inFlight ) { return Promise.resolve('skipped'); }
        inFlight = true;
        return ns.get(key).then(function (record) {
            inFlight = false;
            var outcome = applyStoreRecord(state, record);
            if ( outcome === 'malformed' ) {
                warn('replica sync: the record under `' + key + '` in namespace `' + (opts.name || '?') + '` is malformed — ignored, keeping the last-known state');
            }
            if ( state.sync ) {
                state.sync.lastSyncAt = now();
                state.sync.lastError  = null;
            }
            if ( erroring ) {
                erroring = false;
                warn('replica sync: the store is reachable again — following the shared state');
            }
            return outcome;
        }, function (err) {
            inFlight = false;
            var msg = (err && err.message) || String(err);
            if ( state.sync ) { state.sync.lastError = msg; }
            if ( !erroring ) {
                erroring = true;
                warn('replica sync: the store is unreachable (' + msg + ') — keeping the last-known maintenance state until it answers again; a store outage never reopens a closed site');
            }
            return 'error';
        });
    }

    /** @inner */
    function start() {
        if ( timer ) { return; }
        state.sync = { store: opts.name || null, key: key, lastSyncAt: null, lastError: null };
        timer = setInterval(function () { tick(); }, intervalMs);
        if ( timer && typeof(timer.unref) == 'function' ) { timer.unref(); }
        tick();
    }

    /** @inner */
    function stop() {
        if ( timer ) { clearInterval(timer); timer = null; }
    }

    return { start: start, stop: stop, tick: tick, isRunning: function () { return timer !== null; } };
}


/**
 * Classify a request as arriving through a reverse proxy.
 *
 * ⚠️ SECURITY-BEARING, and deliberately ASYMMETRIC. This decides whether the
 * `allowFrom` IP arm may be consulted at all, and every input it reads is
 * client-supplied. It is therefore built to fail toward "proxied", because
 * "proxied" makes that arm INERT — the safe direction. A caller must never
 * read a `false` here as proof of a direct connection; it means only that no
 * proxy signal was found.
 *
 * Signals are a UNION and each may only ADD evidence of proxying:
 *   1. the shipped #B65 stamp `request._ginaIsProxyHost` when it is `true`;
 *   2. ANY `x-forwarded-*` header (or RFC 7239 `Forwarded`);
 *   3. the port-less-Host heuristic, unless `requireForwarded` disables it.
 *
 * ⚠️ The stamp is NOT authoritative when `false`. It is derived from the same
 * client-supplied Host heuristic as (3), so honouring a `false` would inherit
 * its spoofability: a client sending `Host: evil.com:8080` reads as "direct"
 * and, behind a proxy whose address the operator listed in `allowFrom`, would
 * re-open the bypass to everyone. Measured and fixed 2026-08-16 during the
 * #MAINT1 adversarial review — do not "simplify" this back to an early return.
 *
 * @param {object} req - the request
 * @param {boolean} [requireForwarded] - `server.proxy.requireForwardedHeaders` (#B152): disables the port-less-Host heuristic
 * @returns {boolean} true when ANY proxy signal is present (and for a malformed request)
 *
 * @example
 * isProxiedRequest({ headers: { host: 'example.com' } });                  // true  (port-less Host)
 * isProxiedRequest({ headers: { host: 'example.com:8080' } });             // false (no signal found)
 * isProxiedRequest({ headers: { host: 'a.com:1', 'x-forwarded-proto':'https' } }); // true (any XF header)
 * isProxiedRequest({ _ginaIsProxyHost: false, headers: { host: 'a.com' } });       // true (stamp cannot veto)
 * isProxiedRequest(null);                                                  // true  (fail closed)
 */
function isProxiedRequest(req, requireForwarded) {
    if ( typeof(req) != 'object' || req === null ) {
        return true;
    }
    var headers = req.headers || {};

    // (1) The shipped #B65 stamp, when isaac set one. It may only ADD evidence
    //     of proxying — never veto the checks below. The stamp is derived from
    //     the very same client-supplied Host heuristic, so treating `false` as
    //     authoritative would inherit its spoofability wholesale.
    if ( req._ginaIsProxyHost === true ) {
        return true;
    }

    // (2) ANY `x-forwarded-*` header, not just `-Host`. A direct client has no
    //     reason to send one; an attacker who forges one only pushes this
    //     toward "proxied", which makes the IP arm INERT — the safe direction.
    for (var h in headers) {
        if ( h.length > 11 && h.slice(0, 11).toLowerCase() === 'x-forwarded' ) {
            return true;
        }
    }
    if ( headers['forwarded'] ) {          // RFC 7239 canonical form
        return true;
    }

    // (3) The port-less-Host heuristic (disabled by #B152).
    if ( requireForwarded !== true ) {
        var host = headers.host || headers[':authority'] || '';
        if ( typeof(host) == 'string' && host.length > 0 && !/:[0-9]+$/.test(host) ) {
            return true;
        }
    }

    return false;
}

/**
 * Read a named cookie out of a request's raw `Cookie` header.
 *
 * The maintenance gate runs BEFORE routing and before any cookie middleware, so
 * it cannot rely on `req.cookies` existing. Parses only what it needs.
 *
 * @param {object} req - the request
 * @param {string} name - cookie name
 * @returns {string} the decoded value, or `''` when absent
 *
 * @example
 * readCookie({ headers: { cookie: 'a=1; gina.maintenance=xyz' } }, 'gina.maintenance'); // 'xyz'
 * readCookie({ headers: {} }, 'gina.maintenance');                                      // ''
 */
function readCookie(req, name) {
    var raw = ( req && req.headers && typeof(req.headers.cookie) == 'string' ) ? req.headers.cookie : '';
    if ( !raw || typeof(name) != 'string' || !name.length ) {
        return '';
    }
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; ++i) {
        var part = parts[i];
        var eq   = part.indexOf('=');
        if ( eq < 0 ) {
            continue;
        }
        if ( part.slice(0, eq).trim() === name ) {
            try {
                return decodeURIComponent(part.slice(eq + 1).trim());
            } catch (e) {
                return part.slice(eq + 1).trim();
            }
        }
    }
    return '';
}

/**
 * Mint a stateless, self-expiring bypass cookie value.
 *
 * Shape: `<expiryUnixSeconds>.<HMAC-SHA256(bypassKey, MAC_CONTEXT + expiry)>`.
 * Because verification recomputes the MAC, no server-side state is involved —
 * the grant survives a restart and is honoured by every bundle of a merged-mode
 * project that shares the key, with nothing to replicate. Revoke by rotating
 * `bypassKey`.
 *
 * @param {string} bypassKey - the configured secret
 * @param {number} [nowMs] - current epoch ms (injectable for tests)
 * @param {number} [ttlMs] - lifetime in ms; defaults to 12h
 * @returns {string} the cookie value, or `''` when no key is configured
 *
 * @example
 * mintBypassCookie('s3cret-key-of-decent-length', 1700000000000);
 * // '1700043200.9f2c…'
 */
function mintBypassCookie(bypassKey, nowMs, ttlMs) {
    if ( typeof(bypassKey) != 'string' || !bypassKey.length ) {
        return '';
    }
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    var ttl = ( typeof(ttlMs) == 'number' && isFinite(ttlMs) && ttlMs > 0 ) ? ttlMs : BYPASS_TTL_MS;
    var exp = Math.floor((now + ttl) / 1000);
    var mac = crypto.createHmac('sha256', bypassKey).update(MAC_CONTEXT + exp).digest('hex');
    return exp + '.' + mac;
}

/**
 * Verify a bypass-cookie value: well-formed, unexpired, and correctly MAC'd.
 *
 * Fail-closed on every malformed shape. The MAC compare is constant-time, and
 * the expiry is checked BEFORE the compare so an expired cookie costs nothing.
 *
 * @param {string} value - the cookie value presented by the client
 * @param {string} bypassKey - the configured secret
 * @param {number} [nowMs] - current epoch ms (injectable for tests)
 * @returns {boolean} true when the cookie is a valid, live grant
 *
 * @example
 * var c = mintBypassCookie('a-good-long-key', 1700000000000);
 * verifyBypassCookie(c, 'a-good-long-key', 1700000000000);      // true
 * verifyBypassCookie(c, 'a-good-long-key', 1799999999999);      // false (expired)
 * verifyBypassCookie(c, 'rotated-key',     1700000000000);      // false (revoked)
 * verifyBypassCookie('garbage', 'a-good-long-key');             // false
 */
function verifyBypassCookie(value, bypassKey, nowMs) {
    if ( typeof(value) != 'string' || !value.length ) {
        return false;
    }
    if ( typeof(bypassKey) != 'string' || !bypassKey.length ) {
        return false;
    }
    var dot = value.indexOf('.');
    if ( dot <= 0 || dot === value.length - 1 ) {
        return false;
    }
    var expRaw = value.slice(0, dot);
    var mac    = value.slice(dot + 1);
    // Canonical form only. The MAC is computed over the PARSED integer, so a
    // leading zero would produce a second, differently-spelled string carrying
    // the same valid signature (`0` + exp verified — measured 2026-08-16).
    // Harmless in isolation, but a signature that accepts more than one
    // encoding of the same value is a defect worth closing at the parse.
    if ( !/^[1-9][0-9]{0,14}$/.test(expRaw) ) {
        return false;
    }
    var exp = parseInt(expRaw, 10);
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    if ( !isFinite(exp) || exp * 1000 <= now ) {
        return false;
    }
    var expected = crypto.createHmac('sha256', bypassKey).update(MAC_CONTEXT + exp).digest('hex');
    return _safeEqual(mac, expected);
}

/**
 * Read a bypass key presented on the request, header first then query.
 *
 * Browsers navigating to a URL cannot set a header, so the query parameter is
 * the human entry path; programmatic callers should prefer the header. Mirrors
 * `_agentKeyValid`'s dual-path precedent (#INS9b).
 *
 * @param {object} req - the request
 * @returns {object} `{value, source}` where source is `'header'`, `'query'` or `''`
 *
 * @example
 * readPresentedKey({ headers: { 'x-gina-maintenance-key': 'k' }, url: '/' });
 * // { value: 'k', source: 'header' }
 *
 * @example
 * readPresentedKey({ headers: {}, url: '/a?gina-maintenance-key=k' });
 * // { value: 'k', source: 'query' }
 */
function readPresentedKey(req) {
    var headers = ( req && req.headers ) ? req.headers : {};
    var fromHeader = headers[BYPASS_HEADER];
    if ( typeof(fromHeader) == 'string' && fromHeader.length ) {
        return { value: fromHeader, source: 'header' };
    }
    var url = ( req && typeof(req.url) == 'string' ) ? req.url : '';
    var qi  = url.indexOf('?');
    if ( qi >= 0 ) {
        try {
            var fromQuery = new URLSearchParams(url.slice(qi + 1)).get(BYPASS_QUERY_PARAM);
            if ( typeof(fromQuery) == 'string' && fromQuery.length ) {
                return { value: fromQuery, source: 'query' };
            }
        } catch (e) { /* malformed query — treated as absent */ }
    }
    return { value: '', source: '' };
}

/**
 * Remove the bypass-key parameter from a URL, preserving everything else.
 *
 * The result is used as the `Location` of the grant redirect. It is deliberately
 * PATH-ONLY (never rebuilt from `Host` or any `X-Forwarded-*` header): #B367
 * showed those headers are attacker-controlled, and a redirect target built from
 * them is an open redirect. A relative Location is resolved by the client
 * against the origin it already reached, which is always correct here.
 *
 * @param {string} url - the request URL (path + query)
 * @returns {string} the URL with the bypass parameter stripped; never empty
 *
 * @example
 * stripKeyParam('/dash?gina-maintenance-key=k&page=2'); // '/dash?page=2'
 * stripKeyParam('/dash?gina-maintenance-key=k');        // '/dash'
 * stripKeyParam('/dash');                               // '/dash'
 */
function _safeLocalPath(p) {
    if ( typeof(p) != 'string' || !p.length ) {
        return '/';
    }
    // A scheme means an absolute URL — off-site by definition.
    if ( /^[a-zA-Z][a-zA-Z0-9+.\-]*:/.test(p) ) {
        return '/';
    }
    // Browsers normalise a backslash to a forward slash in the authority
    // position, so `/\evil.com` and `/\/evil.com` are protocol-relative in
    // practice. Fold them BEFORE the leading-slash test rather than after.
    p = p.replace(/\\/g, '/');
    if ( p.charAt(0) !== '/' ) {
        return '/';
    }
    // `//host` is protocol-relative — a same-document-looking off-site jump.
    if ( p.charAt(1) === '/' ) {
        return '/';
    }
    return p;
}

function stripKeyParam(url) {
    if ( typeof(url) != 'string' || !url.length ) {
        return '/';
    }
    var qi = url.indexOf('?');
    if ( qi < 0 ) {
        return _safeLocalPath(url);
    }
    var path = _safeLocalPath(url.slice(0, qi));
    var kept = [];
    try {
        var params = new URLSearchParams(url.slice(qi + 1));
        params.delete(BYPASS_QUERY_PARAM);
        var serialized = params.toString();
        if ( serialized.length ) {
            kept.push(serialized);
        }
    } catch (e) {
        return path;
    }
    return kept.length ? (path + '?' + kept[0]) : path;
}

/**
 * Adjudicate whether a request may bypass an ACTIVE maintenance window.
 *
 * Resolution order — cookie, header, query (+grant), IP-and-not-proxied. The IP
 * arm is LAST and is conditioned on the request not being proxied: behind a
 * proxy every `socket.remoteAddress` is the proxy's, so an unconditioned IP
 * allowlist would either admit the entire internet (proxy listed) or nobody
 * (proxy not listed). The `¬proxied` condition turns that silent-open into
 * fail-closed and leaves the key as the only bypass behind a proxy — which is
 * the point: a key is topology-independent.
 *
 * Callers are expected to have already established that maintenance is ON; this
 * function does not read `conf.enabled`.
 *
 * @param {object} req - the request
 * @param {object} conf - a conf from {@link resolveConf}
 * @param {number} [nowMs] - current epoch ms (injectable for tests)
 * @param {boolean} [requireForwarded] - `server.proxy.requireForwardedHeaders` (#B152)
 * @returns {object} `{allowed, reason, grant, cookie, redirectTo}` — `grant` true means the caller should set `cookie` and 302 to `redirectTo`
 *
 * @example
 * // valid cookie → straight through, nothing to set
 * evaluateBypass(req, conf); // { allowed:true, reason:'cookie', grant:false, … }
 *
 * @example
 * // ?gina-maintenance-key=… → grant: set the cookie, redirect without the secret
 * evaluateBypass(req, conf);
 * // { allowed:true, reason:'query', grant:true, cookie:'…', redirectTo:'/dash' }
 *
 * @example
 * // office IP, but the request came through a proxy → refused
 * evaluateBypass(req, { allowFrom:['203.0.113.4'], … }); // { allowed:false, reason:'none' }
 */
function evaluateBypass(req, conf, nowMs, requireForwarded) {
    var verdict = { allowed: false, reason: 'none', grant: false, cookie: '', redirectTo: '' };

    if ( typeof(req) != 'object' || req === null || typeof(conf) != 'object' || conf === null ) {
        return verdict;
    }

    var key = ( typeof(conf.bypassKey) == 'string' ) ? conf.bypassKey : '';

    // 1. an already-granted, unexpired cookie
    if ( key && verifyBypassCookie(readCookie(req, BYPASS_COOKIE), key, nowMs) ) {
        verdict.allowed = true;
        verdict.reason  = 'cookie';
        return verdict;
    }

    // 2/3. a presented key — header (programmatic) or query (human entry)
    if ( key ) {
        var presented = readPresentedKey(req);
        if ( presented.value ) {
            if ( _safeEqual(presented.value, key) ) {
                verdict.allowed = true;
                verdict.reason  = presented.source;
                if ( presented.source === 'query' ) {
                    // Grant: hand back a cookie so the rest of the browsing
                    // session needs no secret, and redirect to the same URL
                    // without it so it leaves history and the Referer.
                    verdict.grant      = true;
                    verdict.cookie     = mintBypassCookie(key, nowMs);
                    verdict.redirectTo = stripKeyParam(req.url);
                }
                return verdict;
            }
            // A wrong key is worth one log line at the call site (never the
            // value itself) — the #B365 asserting-client precedent.
            verdict.reason = 'invalid-key';
            return verdict;
        }
    }

    // 4. IP allowlist — ONLY for a request that did not arrive through a proxy.
    if ( Array.isArray(conf.allowFrom) && conf.allowFrom.length
            && !isProxiedRequest(req, requireForwarded) ) {
        var ip = ( req.socket && req.socket.remoteAddress )
              || ( req.connection && req.connection.remoteAddress )
              || '';
        if ( ip.indexOf('::ffff:') === 0 ) {
            ip = ip.slice(7);
        }
        if ( ip && conf.allowFrom.indexOf(ip) >= 0 ) {
            verdict.allowed = true;
            verdict.reason  = 'ip';
            return verdict;
        }
    }

    return verdict;
}

/**
 * Decide whether maintenance is currently ON for a bundle.
 *
 * A runtime override (set by `POST /_gina/maintenance`) wins over config while
 * it is live. An override carrying a `until` timestamp that has passed is
 * treated as absent — the bundle falls back to its CONFIGURED state rather than
 * to "off", so a TTL expiring cannot silently re-open a site that
 * `settings.json` says is closed. That direction is the safe one and is the
 * whole point of the dead-man switch.
 *
 * @param {object} state - the engine-instance state `{conf, runtime}`
 * @param {number} [nowMs] - current epoch ms (injectable for tests)
 * @returns {boolean} true when requests should be answered with 503
 *
 * @example
 * isActive({ conf: { enabled: false }, runtime: null });                    // false
 * isActive({ conf: { enabled: false }, runtime: { active: true } });        // true  (runtime on)
 * isActive({ conf: { enabled: true },  runtime: { active: false } });       // false (runtime off wins)
 *
 * @example
 * // an expired TTL falls back to CONFIG, never to "off"
 * isActive({ conf: { enabled: true }, runtime: { active: false, until: 10 } }, 20); // true
 */
function isActive(state, nowMs) {
    if ( typeof(state) != 'object' || state === null ) {
        return false;
    }
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    var rt  = state.runtime;
    if ( typeof(rt) == 'object' && rt !== null ) {
        var expired = ( typeof(rt.until) == 'number' && isFinite(rt.until) && rt.until <= now );
        if ( !expired ) {
            return rt.active === true;
        }
    }
    return !!( state.conf && state.conf.enabled === true );
}

/**
 * The conf in force right now — config, with any live runtime override applied.
 *
 * `POST /_gina/maintenance` may carry its own `retryAfter` / `message`; those
 * apply only while the override is live, so an expired window reverts to the
 * configured wording as well as the configured state.
 *
 * @param {object} state - the engine-instance state `{conf, runtime}`
 * @param {number} [nowMs] - current epoch ms (injectable for tests)
 * @returns {object} the effective conf (never null)
 *
 * @example
 * effectiveConf({ conf: { retryAfter: 300, message: 'a' }, runtime: { active: true, message: 'b' } });
 * // { …, retryAfter: 300, message: 'b' }
 */
function effectiveConf(state, nowMs) {
    var base = ( state && typeof(state.conf) == 'object' && state.conf !== null )
        ? state.conf
        : resolveConf(null);
    var out = {
        enabled    : base.enabled,
        retryAfter : base.retryAfter,
        message    : base.message,
        bypassKey  : base.bypassKey,
        allowFrom  : base.allowFrom
    };
    var now = ( typeof(nowMs) == 'number' && isFinite(nowMs) ) ? nowMs : Date.now();
    var rt  = ( state && typeof(state.runtime) == 'object' ) ? state.runtime : null;
    if ( rt && !( typeof(rt.until) == 'number' && isFinite(rt.until) && rt.until <= now ) ) {
        if ( typeof(rt.retryAfter) == 'number' && isFinite(rt.retryAfter)
                && Math.floor(rt.retryAfter) === rt.retryAfter
                && rt.retryAfter >= 1 && rt.retryAfter <= 86400 ) {
            out.retryAfter = rt.retryAfter;
        }
        if ( typeof(rt.message) == 'string' && rt.message.length > 0 ) {
            out.message = rt.message;
        }
    }
    return out;
}

/**
 * Minimal HTML escape for text interpolated into the maintenance page.
 *
 * `message` is operator-authored, not attacker-authored, so this is defence in
 * depth rather than a patched hole — but #B367 (one release old) was exactly an
 * unescaped splice into generated markup, and its lesson is that provenance
 * changes (a `${secret:…}` backend, a runtime override reaching further than
 * intended) turn "trusted" into "attacker-supplied" without the emission site
 * noticing. Escaping at the single emission point closes it permanently.
 *
 * @inner
 * @param {*} value - the text to escape
 * @returns {string} the value with HTML-significant characters replaced
 *
 * @example
 * _escapeHtml('a<b & "c"'); // 'a&lt;b &amp; &quot;c&quot;'
 */
function _escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Normalise a raw culture / `Accept-Language` value into a BCP-47 `lang` tag.
 *
 * Same rule as the #A11Y3 `a11yLangTag` helper in `core/server.js`, reproduced
 * here self-contained (no injected globals) because `core/server.isaac.js`
 * carries no a11y helpers of its own and the maintenance page must be
 * conforming on BOTH engines. Falls back to `en` rather than emitting something
 * unparseable — assistive technology that cannot parse the tag picks the wrong
 * voice, which is worse than no tag.
 *
 * @param {string} [raw] - a culture (`en_CM`) or Accept-Language value (`fr;q=0.9,en`)
 * @returns {string} a BCP-47-shaped tag, never empty
 *
 * @example
 * langTag('en_CM');      // 'en-CM'
 * langTag('fr;q=0.9');   // 'fr'
 * langTag('');           // 'en'
 */
function langTag(raw) {
    var culture = ( typeof(raw) == 'string' ) ? raw : '';
    culture = culture.split(',')[0].split(';')[0].trim().replace(/_/g, '-');
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(culture) ? culture : 'en';
}

/**
 * Decide whether a refused request wants JSON or HTML.
 *
 * Header-only, because the gate runs BEFORE routing: nothing has parsed the
 * request yet, so `req.isXMLRequest` does not exist at this point.
 *
 * @param {object} req - the request
 * @returns {string} `'json'` or `'html'`
 *
 * @example
 * negotiate({ headers: { 'x-requested-with': 'XMLHttpRequest' } });   // 'json'
 * negotiate({ headers: { accept: 'application/json' } });             // 'json'
 * negotiate({ headers: { accept: 'text/html,application/json' } });   // 'html'
 * negotiate({ headers: {} });                                         // 'html'
 */
function negotiate(req) {
    var headers = ( req && req.headers ) ? req.headers : {};
    var accept  = String(headers.accept || '');
    if ( String(headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest' ) {
        return 'json';
    }
    if ( typeof(headers['x-gina-navigate']) != 'undefined' ) {
        return 'json';
    }
    if ( accept.indexOf('application/json') > -1 && accept.indexOf('text/html') < 0 ) {
        return 'json';
    }
    return 'html';
}

/**
 * Build the 503 body served to a refused request.
 *
 * The JSON shape matches the framework's shipped
 * `core/template/error/server/json/503.json` so a consumer already handling
 * gina error bodies needs no special case. The HTML branch is a complete
 * conforming document (doctype, `lang`, `<title>`, viewport) that is entirely
 * SELF-CONTAINED — no stylesheet, image, font or script — precisely because the
 * gate that produced it also refuses static assets. A maintenance page that
 * referenced `/css/app.css` would render unstyled behind its own gate.
 *
 * @param {object} conf - the effective conf from {@link effectiveConf}
 * @param {string} kind - `'json'` or `'html'` (from {@link negotiate})
 * @param {string} [lang] - a tag from {@link langTag}
 * @returns {object} `{contentType, body}`
 *
 * @example
 * buildBody({ message: 'Back at 14:00 UTC' }, 'json');
 * // { contentType: 'application/json; charset=utf8', body: '{"error":{…}}' }
 *
 * @example
 * buildBody({ message: 'Back soon' }, 'html', 'fr');
 * // { contentType: 'text/html; charset=utf8', body: '<!doctype html><html lang="fr">…' }
 */
function buildBody(conf, kind, lang) {
    var message = ( conf && typeof(conf.message) == 'string' && conf.message.length )
        ? conf.message
        : DEFAULTS.message;

    if ( kind === 'json' ) {
        return {
            contentType : 'application/json; charset=utf8',
            body        : JSON.stringify({
                error: {
                    code     : '503',
                    message  : 'GNA:GLOBAL:ERR:503',
                    explicit : message
                }
            })
        };
    }

    return {
        contentType : 'text/html; charset=utf8',
        body        : '<!doctype html><html lang="'+ langTag(lang) +'">'
            + '<head><meta charset="utf-8">'
            + '<meta name="viewport" content="width=device-width, initial-scale=1">'
            + '<title>Service Unavailable</title>'
            + '<style>'
            + 'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
            + 'font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1f2933;background:#f5f7fa}'
            + 'main{max-width:34rem;padding:2rem;text-align:center}'
            + 'h1{font-size:1.5rem;margin:0 0 .75rem}p{margin:0;color:#52606d}'
            + '@media (prefers-color-scheme:dark){body{color:#e4e7eb;background:#1f2933}p{color:#9aa5b1}}'
            + '</style></head>'
            + '<body><main>'
            + '<h1>Service Unavailable</h1>'
            + '<p>'+ _escapeHtml(message) +'</p>'
            + '</main></body></html>'
    };
}

/**
 * The response headers every refused request carries.
 *
 * `no-store` is load-bearing rather than tidy: a 503 cached by an intermediary
 * would outlive the maintenance window and keep serving the closed page after
 * the site reopened — the failure mode that turns a ten-minute window into an
 * open-ended outage.
 *
 * @param {object} conf - the effective conf from {@link effectiveConf}
 * @param {string} contentType - from {@link buildBody}
 * @returns {object} a header map ready for `writeHead` / `stream.respond`
 *
 * @example
 * responseHeaders({ retryAfter: 300 }, 'text/html; charset=utf8');
 * // { 'retry-after': '300', 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf8' }
 */
function responseHeaders(conf, contentType) {
    var retryAfter = ( conf && typeof(conf.retryAfter) == 'number' ) ? conf.retryAfter : DEFAULTS.retryAfter;
    return {
        'retry-after'   : String(retryAfter),
        'cache-control' : 'no-store',
        'content-type'  : contentType
    };
}

/**
 * Is this request running over TLS?
 *
 * Decides only whether the bypass cookie carries `Secure`. Consults
 * `x-forwarded-proto` in addition to the socket and the HTTP/2 `:scheme`
 * pseudo-header — consistent with the scheme resolution already shipped in
 * `core/server.js`, and fail-SAFE in this particular use: a spoofed
 * `x-forwarded-proto: https` only causes a cookie to be marked `Secure`, so a
 * client lying about it merely stops receiving its own cookie over cleartext.
 * There is no direction in which trusting it here downgrades anyone — which is
 * why this does NOT contradict the framework's refusal to trust
 * `X-Forwarded-For` for the IP allowlist, where the failure direction is
 * privilege escalation.
 *
 * @param {object} req - the request
 * @returns {boolean} true when the client-facing hop is https
 *
 * @example
 * isSecureRequest({ socket: { encrypted: true }, headers: {} });        // true
 * isSecureRequest({ headers: { ':scheme': 'https' } });                 // true
 * isSecureRequest({ headers: { 'x-forwarded-proto': 'https,http' } });  // true
 * isSecureRequest({ headers: {} });                                     // false
 */
function isSecureRequest(req) {
    if ( typeof(req) != 'object' || req === null ) {
        return false;
    }
    if ( req.socket && req.socket.encrypted ) {
        return true;
    }
    var headers = req.headers || {};
    if ( headers[':scheme'] === 'https' ) {
        return true;
    }
    var xfp = headers['x-forwarded-proto'];
    return ( typeof(xfp) == 'string' && /^https\b/i.test(xfp.split(',')[0].trim()) );
}

/**
 * Build the `Set-Cookie` header value for a granted bypass.
 *
 * `HttpOnly` (no script needs it) + `SameSite=Lax` (a cross-site POST must not
 * ride the grant) + `Path=/` (the whole bundle) + `Secure` when the request
 * arrived over TLS. `Max-Age` mirrors the value baked into the MAC, so the
 * browser drops it at the same moment the server stops honouring it.
 *
 * @param {string} value - a value from {@link mintBypassCookie}
 * @param {boolean} [isSecure] - true when the request is https
 * @returns {string} a complete Set-Cookie value
 *
 * @example
 * buildBypassCookieHeader('1700043200.9f2c…', true);
 * // 'gina.maintenance=1700043200.9f2c…; Max-Age=43200; Path=/; HttpOnly; SameSite=Lax; Secure'
 */
function buildBypassCookieHeader(value, isSecure) {
    var parts = [
        BYPASS_COOKIE + '=' + encodeURIComponent(String(value || '')),
        'Max-Age=' + Math.floor(BYPASS_TTL_MS / 1000),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax'
    ];
    if ( isSecure === true ) {
        parts.push('Secure');
    }
    return parts.join('; ');
}

module.exports = {
    DEFAULTS                : DEFAULTS,
    BYPASS_COOKIE           : BYPASS_COOKIE,
    BYPASS_QUERY_PARAM      : BYPASS_QUERY_PARAM,
    BYPASS_HEADER           : BYPASS_HEADER,
    BYPASS_TTL_MS           : BYPASS_TTL_MS,
    MIN_KEY_LENGTH          : MIN_KEY_LENGTH,
    resolveConf             : resolveConf,
    lintConf                : lintConf,
    resolveBootEnv          : resolveBootEnv,
    resolveStoreSync        : resolveStoreSync,
    buildStoreRecord        : buildStoreRecord,
    storeRecordTtl          : storeRecordTtl,
    applyStoreRecord        : applyStoreRecord,
    createStoreSync         : createStoreSync,
    POLL_MIN_MS             : POLL_MIN_MS,
    POLL_MAX_MS             : POLL_MAX_MS,
    STORE_RECORD_V          : STORE_RECORD_V,
    isActive                : isActive,
    effectiveConf           : effectiveConf,
    langTag                 : langTag,
    negotiate               : negotiate,
    buildBody               : buildBody,
    responseHeaders         : responseHeaders,
    isSecureRequest         : isSecureRequest,
    isProxiedRequest        : isProxiedRequest,
    readCookie              : readCookie,
    mintBypassCookie        : mintBypassCookie,
    verifyBypassCookie      : verifyBypassCookie,
    readPresentedKey        : readPresentedKey,
    stripKeyParam           : stripKeyParam,
    evaluateBypass          : evaluateBypass,
    buildBypassCookieHeader : buildBypassCookieHeader,
    _safeEqual              : _safeEqual
};
