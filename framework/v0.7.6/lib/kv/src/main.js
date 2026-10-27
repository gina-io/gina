/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/kv
 * @description General-purpose key-value primitive (#KV1) — strict-declared
 * NAMESPACES, each owning a backend and a failure policy, behind one
 * promise-native handle reached from application code as `gina.kv('<name>')`
 * (or `gina.kv()` for the `kv.default` namespace).
 *
 * **Strict by design.** A namespace must be declared under
 * `settings.json > kv.namespaces` before `get()` hands it out — an unknown
 * name THROWS at the call site rather than silently minting an empty store,
 * for the same reason `lib/storage` keeps its drivers behind a throw-on-unknown
 * contract: the throw is what surfaces a typo. A memory namespace is one line
 * of config: `{ "kv": { "namespaces": { "counters": {} } } }`.
 *
 * **Value model.** Values are JSON-serialized strings end to end. `undefined`
 * and `null` are REFUSED on every write (a stored `null` would be
 * indistinguishable from a miss — store a wrapper object, or use `del()`).
 * TTLs are MILLISECONDS and must be positive safe integers; `ttl: 0` is
 * refused rather than read as "no expiry" (non-positive TTLs are the
 * ambiguity class the render-cache boot lint refuses for the same reason).
 *
 * **The 13-op surface** (all promise-returning): `get` / `set` / `del` /
 * `has` / `ttl` / `expire` / `setnx` (set-if-absent) / `consume` (atomic
 * read-AND-delete — the one-shot-token op; the second reader gets `null`) /
 * `incr` / `decr` (integer counters; `ttl` applies on CREATE only) /
 * `delIfEquals` (compare-and-delete — the safe lock-release primitive) /
 * `clear` (whole-namespace delete) / `getOrSet` (fetch-or-compute with
 * per-process single-flight).
 *
 * **Deliberately NOT here** (demand-gated, documented boundary): redis data
 * structures (lists, hashes, sets, streams, pub/sub — an app doing non-KV
 * redis mints its own client), batch `mget`/`mset`, key scanning (use
 * `clear()` or track your own keys), binary values (the storage layer owns
 * bytes), and a first-class distributed-lock API (compose `setnx` +
 * `delIfEquals`; locks done right need fencing and renewal policy that no
 * half-primitive should imply).
 *
 * **Failure policy is per-namespace, not global** — the measured reason a
 * single shared client was never the design: `failMode: 'closed'` (default)
 * rejects the call on a backend error; `failMode: 'open'` degrades every op
 * to its miss-shaped result with a warning, for cache-like namespaces where
 * availability beats consistency. The knob is consulted on BACKEND errors
 * only (validation errors always reject); the in-memory backend never
 * errors, so it becomes operative with connector-backed stores.
 *
 * **Framework independence — the same hard structural rule as `lib/storage`.**
 * This module must not require gina core, the `lib` registry, or the injected
 * globals (`_()`, `getContext()`, `getConfig()`). Everything it needs is
 * INJECTED by `gna.js` at boot: the validated `kv` block, any connector-backed
 * stores (built through `lib/kv-store`), and a `warn` sink.
 * `test/lib/kv-import-boundary.test.js` enforces it.
 *
 * **Scope.** Namespaces are PROCESS-GLOBAL, read once at boot from the
 * STARTING bundle's `settings.json` (the `lib/storage` driver-set precedent);
 * the whole feature is dormant — zero cost, `get()` throws a named error —
 * when the `kv` block is absent.
 *
 * @example
 * // settings.json
 * // { "kv": {
 * //     "default"    : "cache",
 * //     "namespaces" : {
 * //         "cache"  : { "failMode": "open" },
 * //         "tokens" : {}
 * //     }
 * // } }
 *
 * // controller code
 * var tokens = gina.kv('tokens');
 * tokens.setnx('t:' + hash, { uid: uid }, { ttl: 15 * 60 * 1000 })
 *     .then(function (won) {
 *         if (!won) { return self.throwError(409, 'already pending'); }
 *     });
 * // redeem exactly once — a concurrent second redeemer resolves null:
 * tokens.consume('t:' + hash).then(function (record) { ... });
 */

// ---------------------------------------------------------------------------
// Module state — a singleton by design (plain-require'd from lib/index.js so
// namespace registries and sweep timers survive dev-mode refreshCore()).
// ---------------------------------------------------------------------------

/** @private */
var _namespaces = null;
/** @private */
var _default    = null;
/** @private */
var _warn       = function (msg) {
    try { console.warn('[kv] ' + msg); } catch (warnErr) { /* no sink — drop */ }
};

/**
 * Namespace-name charset — mirrors the storage driver-name pattern.
 * @constant
 * @private
 */
var NAME_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;

/** @constant @private */
var FAIL_MODES = ['closed', 'open'];
/** @constant @private */
var BLOCK_KEYS = ['default', 'namespaces'];
/** @constant @private */
var NS_KEYS = ['store', 'failMode', 'sweepInterval'];
/** @constant @private */
var MAX_KEY_LENGTH = 512;
/** @constant @private */
var DEFAULT_SWEEP_MS = 30000;

/**
 * @typedef {object} KvNamespaceConf
 * @property {string}  [store]         - `connectors.json` entry name backing this
 *                                       namespace. Omitted = the in-memory backend.
 * @property {string}  [failMode]      - `'closed'` (default) or `'open'` — see the
 *                                       module description.
 * @property {number}  [sweepInterval] - Expired-entry sweep cadence in ms for the
 *                                       in-memory backend (default 30000).
 */

/**
 * The per-namespace BACKEND contract a connector `kv-store.js` must implement
 * (`lib/kv-store` resolves and builds one per store-backed namespace at boot).
 * Every method returns a Promise; every value crossing it is an opaque STRING
 * (the facade owns JSON serialization). Key-prefixing per namespace is the
 * implementation's duty — two namespaces may share one connectors entry.
 *
 * @typedef {object} KvStoreContract
 * @property {function(string): Promise<?string>}                   get        - `null` on miss.
 * @property {function(string, string, ?number): Promise<void>}     set        - Third arg: TTL ms or `null`.
 * @property {function(string): Promise<boolean>}                   del        - `true` when a live entry existed.
 * @property {function(string): Promise<boolean>}                   has
 * @property {function(string): Promise<?number>}                   pttl       - `null` miss, `-1` no expiry, else remaining ms.
 * @property {function(string, number): Promise<boolean>}           pexpire    - `false` on miss.
 * @property {function(string, string, ?number): Promise<boolean>}  setnx      - `true` when the write won.
 * @property {function(string): Promise<?string>}                   consume    - Atomic read-and-delete; `null` on miss.
 * @property {function(string, number, ?number): Promise<number>}   incrby     - TTL applies on create only; rejects on a non-integer stored value.
 * @property {function(string, string): Promise<boolean>}           compareDel - Delete iff the stored string strictly equals the given one.
 * @property {function(): Promise<number>}                          clear      - Entries removed.
 * @property {function(): void}                                     close      - Release timers/handles; no promise.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Validate a `settings.json > kv` block WITHOUT building anything.
 *
 * Same contract as the storage validator: an ABSENT block is "feature off",
 * not an error; a declared-but-empty block warns; a malformed one is fatal.
 * `gna.js` treats `fatal` as boot-aborting.
 *
 * @memberof module:lib/kv
 * @param {?object} kvBlock - The raw `kv` block (may be `undefined`/`null`).
 * @returns {{fatal: ?string, warnings: string[], namespaceCount: number}}
 *
 * @example
 * var v = kv.validateConfig(settings.kv);
 * if (v.fatal) { abortBoot(v.fatal); }
 */
function validateConfig(kvBlock) {
    var out = { fatal: null, warnings: [], namespaceCount: 0 };

    if ( typeof(kvBlock) == 'undefined' || kvBlock === null ) {
        return out; // not configured — the feature is off, which is not an error
    }
    if ( typeof(kvBlock) != 'object' || Array.isArray(kvBlock) ) {
        out.fatal = '`settings.json > kv` must be an object — got ' + JSON.stringify(kvBlock);
        return out;
    }
    for (var bk in kvBlock) {
        if ( BLOCK_KEYS.indexOf(bk) < 0 ) {
            out.warnings.push('`kv.' + bk + '` is not a recognised option — ignored (recognised: ' + BLOCK_KEYS.join(', ') + ')');
        }
    }

    var namespaces = kvBlock.namespaces;
    if ( typeof(namespaces) == 'undefined' || namespaces === null ) {
        out.warnings.push('`kv` is declared but has no `namespaces` — no namespace will be available');
        return out;
    }
    if ( typeof(namespaces) != 'object' || Array.isArray(namespaces) ) {
        out.fatal = '`settings.json > kv.namespaces` must be an object keyed by namespace name';
        return out;
    }

    var names = Object.keys(namespaces);
    out.namespaceCount = names.length;

    for (var i = 0; i < names.length; i++) {
        var name = names[i];
        if ( !NAME_RE.test(name) ) {
            out.fatal = 'namespace name `' + name + '` is invalid — names must match ^[A-Za-z][A-Za-z0-9._-]*$';
            return out;
        }
        var conf = namespaces[name];
        if ( conf === null || typeof(conf) != 'object' || Array.isArray(conf) ) {
            out.fatal = '`kv.namespaces.' + name + '` must be an object — use {} for a plain in-memory namespace';
            return out;
        }
        for (var ck in conf) {
            if ( NS_KEYS.indexOf(ck) < 0 ) {
                // a silently-dropped key reads as configured behaviour that
                // never happens — name it (the storage-block convention)
                out.warnings.push('`kv.namespaces.' + name + '.' + ck + '` is not a recognised option — ignored (recognised: ' + NS_KEYS.join(', ') + ')');
            }
        }
        if ( typeof(conf.store) != 'undefined' && (typeof(conf.store) != 'string' || conf.store.length === 0) ) {
            out.fatal = '`kv.namespaces.' + name + '.store` must be a non-empty connectors.json entry name';
            return out;
        }
        if ( typeof(conf.failMode) != 'undefined' && FAIL_MODES.indexOf(conf.failMode) < 0 ) {
            out.fatal = '`kv.namespaces.' + name + '.failMode` must be one of: ' + FAIL_MODES.join(', ') + ' — got ' + JSON.stringify(conf.failMode);
            return out;
        }
        if ( typeof(conf.sweepInterval) != 'undefined' && (!Number.isSafeInteger(conf.sweepInterval) || conf.sweepInterval <= 0) ) {
            out.fatal = '`kv.namespaces.' + name + '.sweepInterval` must be a positive integer of milliseconds';
            return out;
        }
    }

    if ( typeof(kvBlock.default) != 'undefined' ) {
        if ( typeof(kvBlock.default) != 'string' || kvBlock.default.length === 0 ) {
            out.fatal = '`kv.default` must be a non-empty namespace name';
            return out;
        }
        if ( names.indexOf(kvBlock.default) < 0 ) {
            out.fatal = '`kv.default` names `' + kvBlock.default + '`, which is not a declared namespace (declared: ' + (names.join(', ') || 'none') + ')';
            return out;
        }
    }

    return out;
}

/**
 * Build every declared namespace and install the module state. Once-only —
 * a second call warns and is ignored (the `lib/job` store-adoption precedent).
 *
 * Call `validateConfig` first: `start` assumes a validated block and performs
 * no re-validation of its own.
 *
 * @memberof module:lib/kv
 * @param {object} kvBlock          - The validated `kv` block.
 * @param {object} [deps]           - Injected dependencies (framework-independence seam).
 * @param {object} [deps.stores]    - Connector-backed stores keyed by namespace
 *                                    name (built by the caller through `lib/kv-store`);
 *                                    a namespace absent from this map gets the
 *                                    in-memory backend.
 * @param {function} [deps.warn]    - Warning sink (`gna.js` routes it to the logger).
 * @returns {boolean} `true` when the namespaces were installed by THIS call.
 */
function start(kvBlock, deps) {
    if ( _namespaces ) {
        _warn('start: namespaces are already installed — the call was ignored. kv config changes need a bundle restart.');
        return false;
    }
    deps = deps || {};
    if ( typeof(deps.warn) == 'function' ) {
        _warn = deps.warn;
    }
    var stores     = deps.stores || {};
    var namespaces = (kvBlock && kvBlock.namespaces) || {};

    _namespaces = {};
    for (var name in namespaces) {
        var conf  = namespaces[name] || {};
        var store = Object.prototype.hasOwnProperty.call(stores, name)
            ? stores[name]
            : createMemoryStore(conf);
        _namespaces[name] = createNamespace(name, store, conf, _warn);
    }
    _default = (kvBlock && typeof(kvBlock.default) == 'string') ? kvBlock.default : null;
    return true;
}

/**
 * Get a configured namespace handle.
 *
 * Throw-on-unknown is the contract, deliberately — it is what surfaces a
 * typo'd namespace name at the call site instead of handing back a silently
 * empty store (the `lib/storage` `get()` stance).
 *
 * @memberof module:lib/kv
 * @param {string} [name] - Namespace name; omitted returns the `kv.default` namespace.
 * @returns {object} The namespace handle (the 13-op surface).
 * @throws {Error} When kv is not configured, when no default is declared and
 *                 `name` was omitted, or when `name` is not a declared namespace.
 *
 * @example
 * var cache = kv.get();          // the default namespace
 * var tokens = kv.get('tokens'); // a named namespace
 */
function get(name) {
    if ( !_namespaces ) {
        throw new Error('[kv] not configured — add a `kv` block with `namespaces` to settings.json');
    }
    if ( typeof(name) == 'undefined' || name === null ) {
        if ( !_default ) {
            throw new Error('[kv] no `kv.default` is declared — call gina.kv(\'<name>\') with one of: ' + Object.keys(_namespaces).join(', '));
        }
        name = _default;
    }
    if ( !Object.prototype.hasOwnProperty.call(_namespaces, name) ) {
        throw new Error('[kv] no namespace `' + name + '` (configured: ' + (Object.keys(_namespaces).join(', ') || 'none') + ')');
    }
    return _namespaces[name];
}

/**
 * Names of the installed namespaces — the enumeration door for operator
 * surfaces. Answers `[]` before {@link start} (or when kv is unconfigured),
 * so an iterating caller needs no `isStarted()` pre-check. Names only: the
 * handles stay behind {@link get}.
 *
 * @memberof module:lib/kv
 * @returns {string[]} Namespace names, in configuration order.
 */
function list() {
    return _namespaces ? Object.keys(_namespaces) : [];
}

/**
 * Whether {@link start} has installed namespaces.
 *
 * @memberof module:lib/kv
 * @returns {boolean} `true` once namespaces are built.
 */
function isStarted() {
    return !!_namespaces;
}

/**
 * Release every namespace's backend (sweep timers, store handles) and clear
 * module state. Test/teardown seam — the runtime never calls it (the
 * `lib/storage` `reset()` precedent).
 *
 * @memberof module:lib/kv
 * @returns {void}
 */
function reset() {
    if ( _namespaces ) {
        var names = Object.keys(_namespaces);
        for (var i = 0; i < names.length; i++) {
            try { _namespaces[names[i]]._close(); } catch (closeErr) { /* already closed */ }
        }
    }
    _namespaces = null;
    _default    = null;
}

// ---------------------------------------------------------------------------
// Facade-level validation helpers
// ---------------------------------------------------------------------------

/**
 * Validate a caller-supplied key.
 *
 * @inner
 * @param {*} key - Candidate key.
 * @returns {?TypeError} The rejection to use, or `null` when the key is valid.
 */
function checkKey(key) {
    if ( typeof(key) != 'string' || key.length === 0 ) {
        return new TypeError('[kv] keys must be non-empty strings — got ' + (typeof key === 'string' ? 'an empty string' : typeof key));
    }
    if ( key.length > MAX_KEY_LENGTH ) {
        return new TypeError('[kv] key exceeds the ' + MAX_KEY_LENGTH + '-character limit (got ' + key.length + ')');
    }
    return null;
}

/**
 * Extract and validate a TTL from a per-call options object.
 *
 * @inner
 * @param {*} opts - Caller options (`{ ttl }` accepted; absent = no expiry).
 * @returns {{err: ?TypeError, ttl: ?number}} `ttl` in ms, or `null` for no expiry.
 */
function checkTtl(opts) {
    if ( typeof(opts) == 'undefined' || opts === null ) {
        return { err: null, ttl: null };
    }
    if ( typeof(opts) != 'object' || Array.isArray(opts) ) {
        return { err: new TypeError('[kv] per-call options must be an object — got ' + JSON.stringify(opts)), ttl: null };
    }
    if ( typeof(opts.ttl) == 'undefined' || opts.ttl === null ) {
        return { err: null, ttl: null };
    }
    if ( !Number.isSafeInteger(opts.ttl) || opts.ttl <= 0 ) {
        // ttl: 0 is refused, never read as "no expiry" — non-positive TTLs are
        // an ambiguity, not a request
        return { err: new TypeError('[kv] `ttl` must be a positive integer of milliseconds — got ' + JSON.stringify(opts.ttl)), ttl: null };
    }
    return { err: null, ttl: opts.ttl };
}

/**
 * Serialize a caller value to its stored string form.
 *
 * @inner
 * @param {*} value - Caller value.
 * @returns {{err: ?TypeError, s: ?string}}
 */
function serializeValue(value) {
    if ( typeof(value) == 'undefined' ) {
        return { err: new TypeError('[kv] `undefined` cannot be stored — a dropped value is the silent-match-all class this refusal closes'), s: null };
    }
    if ( value === null ) {
        return { err: new TypeError('[kv] `null` cannot be stored — it would be indistinguishable from a miss; store a wrapper object, or use del()'), s: null };
    }
    var s;
    try {
        s = JSON.stringify(value);
    } catch (jsonErr) {
        return { err: new TypeError('[kv] value is not JSON-serializable: ' + (jsonErr.message || jsonErr)), s: null };
    }
    if ( typeof(s) == 'undefined' ) {
        return { err: new TypeError('[kv] value is not JSON-serializable (functions and symbols have no JSON form)'), s: null };
    }
    return { err: null, s: s };
}

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

/**
 * Build the in-memory backend for one namespace: a Map of
 * `key -> { v, exp }` with lazy expiry on read plus an unref'd interval
 * sweep, implementing {@link KvStoreContract}.
 *
 * @memberof module:lib/kv
 * @param {KvNamespaceConf} [conf] - Namespace configuration (`sweepInterval` honoured).
 * @returns {KvStoreContract} The backend instance.
 */
function createMemoryStore(conf) {
    var map     = new Map();
    var sweepMs = (conf && Number.isSafeInteger(conf.sweepInterval) && conf.sweepInterval > 0)
        ? conf.sweepInterval
        : DEFAULT_SWEEP_MS;

    var timer = setInterval(function sweepExpired() {
        var now = Date.now();
        map.forEach(function (rec, key) {
            if ( rec.exp !== null && rec.exp <= now ) {
                map.delete(key);
            }
        });
    }, sweepMs);
    // never keep the process alive for a sweep
    if ( timer.unref ) { timer.unref(); }

    /**
     * Return the live record for `key`, dropping it lazily when expired.
     * @inner
     * @param {string} key - Store key.
     * @returns {?{v: string, exp: ?number}} The record, or `null`.
     */
    var live = function (key) {
        var rec = map.get(key);
        if ( !rec ) { return null; }
        if ( rec.exp !== null && rec.exp <= Date.now() ) {
            map.delete(key);
            return null;
        }
        return rec;
    };

    return {
        get: function (key) {
            var rec = live(key);
            return Promise.resolve(rec ? rec.v : null);
        },
        set: function (key, s, ttlMs) {
            map.set(key, { v: s, exp: ttlMs ? Date.now() + ttlMs : null });
            return Promise.resolve();
        },
        del: function (key) {
            var existed = !!live(key);
            map.delete(key);
            return Promise.resolve(existed);
        },
        has: function (key) {
            return Promise.resolve(!!live(key));
        },
        pttl: function (key) {
            var rec = live(key);
            if ( !rec ) { return Promise.resolve(null); }
            if ( rec.exp === null ) { return Promise.resolve(-1); }
            return Promise.resolve(Math.max(0, rec.exp - Date.now()));
        },
        pexpire: function (key, ttlMs) {
            var rec = live(key);
            if ( !rec ) { return Promise.resolve(false); }
            rec.exp = Date.now() + ttlMs;
            return Promise.resolve(true);
        },
        setnx: function (key, s, ttlMs) {
            if ( live(key) ) { return Promise.resolve(false); }
            map.set(key, { v: s, exp: ttlMs ? Date.now() + ttlMs : null });
            return Promise.resolve(true);
        },
        consume: function (key) {
            var rec = live(key);
            if ( !rec ) { return Promise.resolve(null); }
            map.delete(key);
            return Promise.resolve(rec.v);
        },
        incrby: function (key, by, ttlMs) {
            var rec = live(key);
            var cur = 0;
            if ( rec ) {
                cur = Number(rec.v);
                if ( !Number.isSafeInteger(cur) ) {
                    return Promise.reject(new Error('[kv] value at key `' + key + '` is not an integer — incr/decr need an integer value'));
                }
            }
            var next = cur + by;
            if ( !Number.isSafeInteger(next) ) {
                return Promise.reject(new Error('[kv] increment leaves the safe-integer range at key `' + key + '`'));
            }
            if ( rec ) {
                rec.v = String(next); // ttl applies on CREATE only — keep the existing expiry
            } else {
                map.set(key, { v: String(next), exp: ttlMs ? Date.now() + ttlMs : null });
            }
            return Promise.resolve(next);
        },
        compareDel: function (key, s) {
            var rec = live(key);
            if ( rec && rec.v === s ) {
                map.delete(key);
                return Promise.resolve(true);
            }
            return Promise.resolve(false);
        },
        clear: function () {
            var n = map.size; // includes any expired entries not yet swept
            map.clear();
            return Promise.resolve(n);
        },
        close: function () {
            clearInterval(timer);
            map.clear();
        }
    };
}

// ---------------------------------------------------------------------------
// Namespace handle
// ---------------------------------------------------------------------------

/**
 * Build the public handle for one namespace over a {@link KvStoreContract}
 * backend: JSON (de)serialization, key/TTL/value validation, the
 * per-namespace failure policy, and getOrSet single-flight.
 *
 * @memberof module:lib/kv
 * @param {string} name              - Namespace name (already validated).
 * @param {KvStoreContract} store    - The backend.
 * @param {KvNamespaceConf} [conf]   - Namespace configuration (`failMode` honoured).
 * @param {function} [warn]          - Warning sink for failMode-open degrades.
 * @returns {object} The 13-op namespace handle.
 */
function createNamespace(name, store, conf, warn) {
    var failOpen = !!(conf && conf.failMode === 'open');
    var sink     = (typeof warn == 'function') ? warn : _warn;
    var inflight = {};

    /**
     * Backend-error policy: reject (`closed`) or degrade to the op's
     * miss-shaped result with a warning (`open`). Validation errors never
     * reach this — they reject before the backend is called.
     *
     * @inner
     * @param {string} op   - Operation label for the warning.
     * @param {*}      miss - The op's miss-shaped result.
     * @returns {function(Error): *} A rejection handler.
     */
    var degrade = function (op, miss) {
        return function (err) {
            if ( failOpen ) {
                sink('namespace `' + name + '` ' + op + ' degraded (failMode=open): ' + (err && err.message || err));
                return miss;
            }
            throw err;
        };
    };

    /**
     * Parse a stored string back to its value. A corrupt entry is a backend
     * DATA error — degradable under failMode open.
     *
     * @inner
     * @param {string} s   - Stored string.
     * @param {string} key - Key, for the error message.
     * @returns {*} The parsed value.
     */
    var parseStored = function (s, key) {
        try {
            return JSON.parse(s);
        } catch (parseErr) {
            throw new Error('[kv] namespace `' + name + '` key `' + key + '`: stored value is not valid JSON (' + (parseErr.message || parseErr) + ')');
        }
    };

    var self = {
        /** @type {string} Namespace name (informational). */
        name: name,

        /**
         * Read a key.
         * @param {string} key
         * @returns {Promise<*>} The value, or `null` on miss.
         */
        get: function (key) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            return store.get(key).then(function (s) {
                return (s === null) ? null : parseStored(s, key);
            }).catch(degrade('get', null));
        },

        /**
         * Write a key.
         * @param {string} key
         * @param {*} value          - Any JSON-serializable value except `null`/`undefined`.
         * @param {object} [opts]    - `{ ttl }` in ms (positive integer).
         * @returns {Promise<boolean>} `true` on success (`false` only under failMode open).
         */
        set: function (key, value, opts) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            var ttl = checkTtl(opts);
            if ( ttl.err ) { return Promise.reject(ttl.err); }
            var ser = serializeValue(value);
            if ( ser.err ) { return Promise.reject(ser.err); }
            return store.set(key, ser.s, ttl.ttl).then(function () {
                return true;
            }).catch(degrade('set', false));
        },

        /**
         * Delete a key.
         * @param {string} key
         * @returns {Promise<boolean>} `true` when a live entry existed.
         */
        del: function (key) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            return store.del(key).catch(degrade('del', false));
        },

        /**
         * Whether a live entry exists.
         * @param {string} key
         * @returns {Promise<boolean>}
         */
        has: function (key) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            return store.has(key).catch(degrade('has', false));
        },

        /**
         * Remaining lifetime of a key.
         * @param {string} key
         * @returns {Promise<?number>} `null` on miss, `-1` for no expiry, else remaining ms.
         */
        ttl: function (key) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            return store.pttl(key).catch(degrade('ttl', null));
        },

        /**
         * Set/replace the TTL of an existing key (the sliding-expiration op).
         * @param {string} key
         * @param {number} ttlMs - Positive integer ms.
         * @returns {Promise<boolean>} `false` on miss.
         */
        expire: function (key, ttlMs) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            var ttl = checkTtl({ ttl: ttlMs });
            if ( ttl.err ) { return Promise.reject(ttl.err); }
            return store.pexpire(key, ttl.ttl).catch(degrade('expire', false));
        },

        /**
         * Set-if-absent (conditional set).
         * @param {string} key
         * @param {*} value
         * @param {object} [opts] - `{ ttl }` in ms.
         * @returns {Promise<boolean>} `true` when the write won.
         */
        setnx: function (key, value, opts) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            var ttl = checkTtl(opts);
            if ( ttl.err ) { return Promise.reject(ttl.err); }
            var ser = serializeValue(value);
            if ( ser.err ) { return Promise.reject(ser.err); }
            return store.setnx(key, ser.s, ttl.ttl).catch(degrade('setnx', false));
        },

        /**
         * Atomic read-AND-delete — the one-shot-token op. Exactly one of any
         * number of concurrent consumers resolves the value; the rest resolve
         * `null`. This is NOT `get` + `del`: the atomicity is the contract.
         * @param {string} key
         * @returns {Promise<*>} The value, or `null`.
         */
        consume: function (key) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            return store.consume(key).then(function (s) {
                return (s === null) ? null : parseStored(s, key);
            }).catch(degrade('consume', null));
        },

        /**
         * Atomically increment an integer counter.
         * @param {string} key
         * @param {number} [by=1]  - Positive or negative safe integer.
         * @param {object} [opts]  - `{ ttl }` in ms — applies when the counter is CREATED only.
         * @returns {Promise<?number>} The new value (`null` only under failMode open).
         */
        incr: function (key, by, opts) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            if ( typeof(by) == 'undefined' || by === null ) { by = 1; }
            if ( !Number.isSafeInteger(by) ) {
                return Promise.reject(new TypeError('[kv] `by` must be a safe integer — got ' + JSON.stringify(by)));
            }
            var ttl = checkTtl(opts);
            if ( ttl.err ) { return Promise.reject(ttl.err); }
            return store.incrby(key, by, ttl.ttl).catch(degrade('incr', null));
        },

        /**
         * Atomically decrement an integer counter — `incr` with the sign flipped.
         * @param {string} key
         * @param {number} [by=1]
         * @param {object} [opts] - `{ ttl }` in ms — applies on create only.
         * @returns {Promise<?number>} The new value (`null` only under failMode open).
         */
        decr: function (key, by, opts) {
            if ( typeof(by) == 'undefined' || by === null ) { by = 1; }
            if ( !Number.isSafeInteger(by) ) {
                return Promise.reject(new TypeError('[kv] `by` must be a safe integer — got ' + JSON.stringify(by)));
            }
            return self.incr(key, -by, opts);
        },

        /**
         * Compare-and-delete: delete `key` iff its stored value equals
         * `expected` — the safe lock/lease-release primitive (an unconditional
         * `del` after a lease expiry can delete someone else's entry).
         * Equality is on the JSON-serialized form this facade writes.
         * @param {string} key
         * @param {*} expected - Same value rules as `set`.
         * @returns {Promise<boolean>} `true` when the entry matched and was deleted.
         */
        delIfEquals: function (key, expected) {
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            var ser = serializeValue(expected);
            if ( ser.err ) { return Promise.reject(ser.err); }
            return store.compareDel(key, ser.s).catch(degrade('delIfEquals', false));
        },

        /**
         * Delete every entry in the namespace.
         * @returns {Promise<number>} Entries removed (including expired ones not yet swept).
         */
        clear: function () {
            return store.clear().catch(degrade('clear', 0));
        },

        /**
         * Fetch-or-compute: return the cached value, or run `loader`, store its
         * result, and return it. Concurrent same-process callers whose misses
         * overlap an in-flight load SHARE that load (single-flight); a read
         * that missed before the load completed may still invoke the loader
         * once more — the collapse is best-effort, not a lock. No negative
         * caching: a throwing loader rejects every sharer and caches nothing.
         * The invoking caller receives the loader's value AS-IS; later readers
         * see its JSON round-trip.
         * @param {string} key
         * @param {object|function} [opts] - `{ ttl }` in ms; may be omitted entirely.
         * @param {function} loader        - `function (key) { return value | Promise<value> }`.
         * @returns {Promise<*>}
         */
        getOrSet: function (key, opts, loader) {
            if ( typeof(opts) == 'function' && typeof(loader) == 'undefined' ) {
                loader = opts;
                opts   = null;
            }
            var keyErr = checkKey(key);
            if ( keyErr ) { return Promise.reject(keyErr); }
            var ttl = checkTtl(opts);
            if ( ttl.err ) { return Promise.reject(ttl.err); }
            if ( typeof(loader) != 'function' ) {
                return Promise.reject(new TypeError('[kv] getOrSet needs a loader function — got ' + typeof loader));
            }
            return self.get(key).then(function (hit) {
                if ( hit !== null ) { return hit; }
                if ( Object.prototype.hasOwnProperty.call(inflight, key) ) {
                    return inflight[key];
                }
                var flight = Promise.resolve().then(function () {
                    return loader(key);
                }).then(function (loaded) {
                    if ( typeof(loaded) == 'undefined' ) {
                        throw new TypeError('[kv] getOrSet loader returned `undefined` for key `' + key + '` — return a value, or reject');
                    }
                    return self.set(key, loaded, ttl.ttl !== null ? { ttl: ttl.ttl } : null).then(function () {
                        return loaded;
                    });
                });
                var clearFlight = function () { delete inflight[key]; };
                flight.then(clearFlight, clearFlight);
                inflight[key] = flight;
                return flight;
            });
        },

        /**
         * Release the backend (timers, handles). Called by `reset()`.
         * @private
         * @returns {void}
         */
        _close: function () {
            if ( store.close ) { store.close(); }
        }
    };

    return self;
}

module.exports = {
    validateConfig : validateConfig,
    start          : start,
    get            : get,
    list           : list,
    isStarted      : isStarted,
    reset          : reset,
    // test seams — may change without notice (the lib/storage underscore convention)
    _createMemoryStore : createMemoryStore,
    _createNamespace   : createNamespace
};
