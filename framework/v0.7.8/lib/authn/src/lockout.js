/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Account lockout (#COMPLY3) — the credential-stuffing brake.
 *
 * Counts consecutive failed attempts against a caller-chosen KEY and refuses
 * further attempts once a threshold is crossed, for a fixed window. The key is
 * the bundle's to choose: a user id, an email, an `email + ':' + ip` pair. Gina
 * never derives it, because gina does not own the user record.
 *
 * **Distinct from rate limiting.** Lockout is per-ACCOUNT and counts credential
 * failures — it stops an attacker working one account with many passwords.
 * Rate limiting is per-CLIENT and counts requests — it stops an attacker
 * working many accounts from one source. They defend different axes and neither
 * substitutes for the other; gina ships this one, and request-rate limiting is
 * tracked separately on the roadmap.
 *
 * **Defaults follow PCI-DSS v4.0.1 §8.3.4** — lock after not more than 10
 * invalid attempts, for a minimum of 30 minutes (or until identity is confirmed
 * out of band, which is {@link Lockout#reset}).
 *
 * **Normalise the key, or the threshold multiplies.** Counters are indexed by
 * the exact string given. If the key comes from user input — an email typed
 * into a form — then `a@x.com`, `A@x.com` and `a@X.com` are three separate
 * counters, and an attacker gets the threshold once per spelling. Measured:
 * three failures across those spellings against a threshold of three left the
 * account unlocked. Pass `normalizeKey` (or lower-case it yourself) whenever
 * the key is user-supplied. There is no safe default here — a user id or an
 * opaque token may legitimately be case-sensitive, so gina will not guess.
 *
 * **State lives in memory by default**, which is per-process: two replicas keep
 * independent counters, so an attacker distributing attempts across N replicas
 * gets N times the threshold. That is a real and documented degradation, not a
 * silent one — pass a shared `store` for multi-replica correctness. The store
 * contract is deliberately the callback shape the job and audit store seams
 * already use.
 *
 * **The memory store grows with distinct keys.** Every key an attacker invents
 * costs an entry until its window expires (measured: 5000 keys, 5000 entries),
 * so hostile traffic can inflate it. It is deliberately NOT capped: evicting
 * entries under pressure would let an attacker flush a victim's counter by
 * flooding, turning a memory bound into a lockout bypass — strictly worse than
 * the memory it saves. Bound key CREATION upstream with request-rate limiting,
 * or use a persistent store with its own eviction policy.
 *
 * @module lib/authn/lockout
 *
 * @example
 * var lockout = require('gina').lib.authn.createLockout();
 *
 * lockout.check(email, function (err, state) {
 *     if (state.locked) {
 *         return self.renderJSON({ error: 'too many attempts', retryAt: state.retryAt });
 *     }
 *     verify(function (ok) {
 *         if (!ok) { return lockout.recordFailure(email, function () { deny(); }); }
 *         lockout.recordSuccess(email, function () { self.req.login(user, done); });
 *     });
 * });
 */

var DEFAULT_MAX_ATTEMPTS  = 10;          // PCI-DSS 8.3.4: "not more than 10"
var DEFAULT_LOCK_MS       = 30 * 60000;  // PCI-DSS 8.3.4: "minimum 30 minutes"
var DEFAULT_WINDOW_MS     = 30 * 60000;  // failures older than this stop counting
var DEFAULT_SWEEP_MS      = 5 * 60000;
/** @constant {number} Upper bound on a lockout key, in characters. @inner @private */
var MAX_KEY_LENGTH        = 512;

/**
 * Build the default in-process store.
 *
 * Entries expire lazily on read (so a stale record can never authorise or
 * refuse anything) and are swept periodically only to bound memory. The sweep
 * timer is `unref`'d — it must never be the reason a process stays alive.
 *
 * @param {number} sweepMs - sweep interval in ms.
 * @returns {{get: function, set: function, del: function, close: function, _map: Map}}
 * @inner
 * @private
 */
function createMemoryStore(sweepMs) {
    var map = new Map();
    var timer = null;

    function alive(entry, now) {
        if (!entry) {
            return null;
        }
        if (typeof entry.expiresAt === 'number' && entry.expiresAt <= now) {
            return null;
        }
        return entry;
    }

    function arm() {
        if (timer) {
            return;
        }
        timer = setInterval(function () {
            var now = Date.now();
            map.forEach(function (entry, key) {
                if (!alive(entry, now)) {
                    map.delete(key);
                }
            });
            if (map.size === 0 && timer) {
                clearInterval(timer);
                timer = null;
            }
        }, sweepMs);
        if (timer && typeof timer.unref === 'function') {
            timer.unref();
        }
    }

    return {
        get: function (key, cb) {
            var entry = alive(map.get(key), Date.now());
            if (!entry) {
                map.delete(key);
            }
            process.nextTick(function () { cb(null, entry || null); });
        },
        set: function (key, entry, cb) {
            map.set(key, entry);
            arm();
            process.nextTick(function () { cb(null); });
        },
        del: function (key, cb) {
            map.delete(key);
            process.nextTick(function () { cb(null); });
        },
        close: function () {
            if (timer) {
                clearInterval(timer);
                timer = null;
            }
            map.clear();
        },
        _map: map
    };
}

/**
 * Validate a caller-supplied store against the contract.
 *
 * @param {object} store
 * @returns {void}
 * @throws {Error} when a required method is missing.
 * @inner
 * @private
 */
function assertStore(store) {
    [ 'get', 'set', 'del' ].forEach(function (m) {
        if (typeof store[m] !== 'function') {
            throw new Error('[gina authn] lockout store must implement get(key, cb), set(key, entry, cb) and del(key, cb) — missing: ' + m);
        }
    });
}

/**
 * Serialize operations on one key.
 *
 * The counter update is a read-modify-write across an asynchronous store call,
 * and that is not atomic: without this, N failures arriving in the same tick all
 * read the same entry, all compute `attempts = 1`, and all write it — so an
 * attacker who sends attempts CONCURRENTLY rather than sequentially never
 * crosses the threshold. Measured before this guard existed: 20 concurrent
 * failures against a threshold of 5 recorded 1 attempt and did not lock.
 *
 * Queued FIFO per key, so one account under attack cannot delay another. The
 * queue is per-key and drains to nothing, so it holds no memory between bursts.
 *
 * @param {Map}      chains - the engine's per-key queue map.
 * @param {string}   key
 * @param {function} fn     - receives `release`, must call it exactly once.
 * @returns {void}
 * @inner
 * @private
 */
function withKeyLock(chains, key, fn) {
    function run(f) {
        var released = false;
        function release() {
            if (released) {
                return;
            }
            released = true;
            var q = chains.get(key);
            if (q && q.length > 0) {
                run(q.shift());
                return;
            }
            chains.delete(key);
        }
        // A store that throws SYNCHRONOUSLY would otherwise never reach its
        // callback, so release would never fire: the key kept a live queue and
        // every later operation on it waited forever — the login request hung
        // with no response AND the counter froze, so the account could never
        // lock again. Store recovery did not clear it. Releasing before
        // rethrowing keeps the failure loud without stranding the key.
        try {
            f(release);
        } catch (err) {
            release();
            throw err;
        }
    }

    var queue = chains.get(key);
    if (queue) {
        queue.push(fn);
        return;
    }
    chains.set(key, []);
    run(fn);
}

/**
 * Reject a key that cannot index a counter.
 *
 * @param {*} key
 * @returns {?Error}
 * @inner
 * @private
 */
function checkKey(key) {
    if (typeof key !== 'string' || key.length === 0) {
        return new Error('[gina authn] lockout key must be a non-empty string (a user id, an email, or an `email:ip` pair — your choice, gina does not derive it)');
    }
    // The key is attacker-supplied in the shape the docs suggest (an email), it
    // is retained for the whole window, and it is written verbatim into the
    // auth.lockout audit record — so an uncapped key inflates both the store and
    // the trail. Measured uncapped: a 1,000,006-character key was accepted.
    if (key.length > MAX_KEY_LENGTH) {
        return new Error('[gina authn] lockout key exceeds ' + MAX_KEY_LENGTH + ' characters — reject it in your form validation before it reaches the lockout engine');
    }
    return null;
}

/**
 * @typedef {object} LockoutState
 * @property {boolean} locked    - true when further attempts must be refused.
 * @property {number}  attempts  - consecutive failures currently counted.
 * @property {number}  remaining - attempts left before locking (0 once locked).
 * @property {?number} retryAt   - epoch ms when the lock lifts, or `null` when not locked.
 */

/**
 * Create a lockout engine.
 *
 * @param {object}   [options]
 * @param {number}   [options.maxAttempts=10]      - consecutive failures before locking.
 * @param {number}   [options.lockMs=1800000]      - how long a lock holds (30 min).
 * @param {number}   [options.windowMs=1800000]    - failures older than this stop counting.
 * @param {number}   [options.sweepMs=300000]      - memory-store sweep interval.
 * @param {object}   [options.store]               - shared store; `{get, set, del[, close]}`, callback-shaped.
 * @param {function} [options.normalizeKey]        - `fn(key) -> key`, applied before every lookup. Use it whenever the key is user-supplied, or case variance multiplies the threshold.
 * @param {boolean}  [options.audit=true]          - emit an `auth.lockout` audit record on the transition into locked.
 * @returns {object} the engine — `check` / `recordFailure` / `recordSuccess` / `reset` / `close`.
 * @throws {Error} on an invalid option or an incomplete store.
 * @memberof module:lib/authn
 *
 * @example <caption>Multi-replica: back it with a shared store</caption>
 * var lockout = lib.authn.createLockout({ store: myRedisBackedStore });
 *
 * @example <caption>Keying on an email — normalise, or the threshold multiplies</caption>
 * var lockout = lib.authn.createLockout({
 *     normalizeKey: function (k) { return k.trim().toLowerCase(); }
 * });
 */
function createLockout(options) {
    options = options || {};

    function num(name, fallback) {
        if (typeof options[name] === 'undefined') {
            return fallback;
        }
        var v = options[name];
        if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
            throw new Error('[gina authn] createLockout: `' + name + '` must be a positive number — got: ' + JSON.stringify(v));
        }
        return v;
    }

    var maxAttempts = num('maxAttempts', DEFAULT_MAX_ATTEMPTS);
    var lockMs      = num('lockMs', DEFAULT_LOCK_MS);
    var windowMs    = num('windowMs', DEFAULT_WINDOW_MS);
    var sweepMs     = num('sweepMs', DEFAULT_SWEEP_MS);
    var auditOn     = options.audit !== false;

    if (Math.floor(maxAttempts) !== maxAttempts) {
        throw new Error('[gina authn] createLockout: `maxAttempts` must be a whole number — got: ' + JSON.stringify(options.maxAttempts));
    }

    var normalizeKeyWarned = false;
    var normalizeKey = options.normalizeKey;
    if (typeof normalizeKey !== 'undefined' && typeof normalizeKey !== 'function') {
        throw new Error('[gina authn] createLockout: `normalizeKey` must be a function — got: ' + JSON.stringify(options.normalizeKey));
    }

    /**
     * Apply the caller's key normaliser, if any. A normaliser that throws or
     * returns a non-string is ignored rather than allowed to break a login.
     *
     * @param {string} key
     * @returns {string}
     * @inner
     * @private
     */
    function norm(key) {
        if (!normalizeKey) {
            return key;
        }
        try {
            var out = normalizeKey(key);
            return (typeof out === 'string' && out.length > 0) ? out : key;
        } catch (err) {
            // Falling back to the raw key keeps a buggy normaliser from breaking
            // logins — but silently, it also restores the split-counter
            // multiplier the normaliser existed to close. Say so once.
            if (!normalizeKeyWarned) {
                normalizeKeyWarned = true;
                try {
                    console.error('[gina authn] lockout normalizeKey threw — falling back to the RAW key, so case/whitespace variants of it now count separately: ' + (err.message || err));
                } catch (e2) { /* never escalate */ }
            }
            return key;
        }
    }

    var store = options.store;
    if (store) {
        assertStore(store);
    } else {
        store = createMemoryStore(sweepMs);
    }

    /**
     * Per-key operation queues — see {@link withKeyLock}.
     *
     * In-process only. With a SHARED store across replicas each process
     * serializes its own operations, so concurrent failures can still be lost
     * BETWEEN replicas: the ceiling degrades to roughly `maxAttempts` per
     * replica, the same bound the memory store already carries. A store whose
     * backend offers an atomic increment closes that too; the contract does not
     * require one, so this is documented rather than assumed away.
     *
     * @type {Map<string, Array<function>>}
     * @inner
     * @private
     */
    var chains = new Map();

    /**
     * Project a stored entry into the caller-facing state.
     *
     * @param {?object} entry
     * @param {number}  now
     * @returns {LockoutState}
     * @inner
     * @private
     */
    function toState(entry, now) {
        if (!entry) {
            return { locked: false, attempts: 0, remaining: maxAttempts, retryAt: null };
        }
        if (typeof entry.lockedUntil === 'number' && entry.lockedUntil > now) {
            return { locked: true, attempts: entry.attempts, remaining: 0, retryAt: entry.lockedUntil };
        }
        // The lock has lapsed, or the last failure fell out of the window: the
        // counter starts over. Reading a lapsed entry must never report locked.
        if (typeof entry.lockedUntil === 'number' || (now - entry.lastFailureAt) > windowMs) {
            return { locked: false, attempts: 0, remaining: maxAttempts, retryAt: null };
        }
        return {
            locked    : false,
            attempts  : entry.attempts,
            remaining : Math.max(0, maxAttempts - entry.attempts),
            retryAt   : null
        };
    }

    /**
     * Emit the lockout audit record. Wholly contained — an audit failure must
     * never change an authentication outcome (the `emitAuthzDenied` shape).
     *
     * @param {string} key
     * @param {object} entry
     * @returns {void}
     * @inner
     * @private
     */
    function emitLocked(key, entry) {
        if (!auditOn) {
            return;
        }
        try {
            var audit = require('../../audit');
            if (!audit || typeof audit.write !== 'function' || (typeof audit.isEnabled === 'function' && !audit.isEnabled())) {
                return;
            }
            // The key IS the record's value here — "which account was locked out"
            // is the question an assessor asks (PCI-DSS 10.2.4, invalid logical-
            // access attempts). It is usually an email or a user id; that
            // identifiability is the point, and the audit trail is already the
            // place where actor identity is recorded.
            audit.write('auth.lockout', {
                meta: {
                    key         : key,
                    attempts    : entry.attempts,
                    lockedUntil : entry.lockedUntil
                }
            });
        } catch (err) {
            try {
                console.error('[gina authn] lockout audit event failed (the lockout itself is unaffected): ' + (err.message || err));
            } catch (e2) { /* never escalate */ }
        }
    }

    return {
        /**
         * Read the current state without recording anything.
         *
         * Call it BEFORE verifying a credential, so a locked account never
         * reaches the KDF.
         *
         * @param {string}   key - the account key.
         * @param {function} cb  - `cb(err, state)`.
         * @returns {void}
         */
        check: function (key, cb) {
            if (typeof cb !== 'function') {
                throw new Error('[gina authn] lockout.check(key, cb) requires a callback function');
            }
            var keyErr = checkKey(key);
            if (keyErr) {
                return process.nextTick(function () { cb(keyErr); });
            }
            store.get(norm(key), function (err, entry) {
                if (err) {
                    return cb(err);
                }
                cb(null, toState(entry, Date.now()));
            });
        },

        /**
         * Record one failed attempt.
         *
         * Returns the state AFTER the failure, so a caller can surface
         * `remaining` or `retryAt` immediately. Emits one `auth.lockout` audit
         * record on the transition into locked — not per attempt.
         *
         * @param {string}   key - the account key.
         * @param {function} cb  - `cb(err, state)`.
         * @returns {void}
         */
        recordFailure: function (key, cb) {
            if (typeof cb !== 'function') {
                throw new Error('[gina authn] lockout.recordFailure(key, cb) requires a callback function');
            }
            var keyErr = checkKey(key);
            if (keyErr) {
                return process.nextTick(function () { cb(keyErr); });
            }
            key = norm(key);
            withKeyLock(chains, key, function (release) {
            var now = Date.now();
            store.get(key, function (err, entry) {
                if (err) {
                    release();
                    return cb(err);
                }
                // An ACTIVE lock is terminal until it lapses: recording over it
                // would rebuild the entry with lockedUntil:null and free the
                // account early. Measured before this guard, with lockMs 60min
                // and windowMs 30min, one failure at t+31min turned
                // {locked:true} into {locked:false, attempts:1} — so the
                // effective lock was silently min(lockMs, windowMs) and a caller
                // that records every failure without consulting check() first
                // (which the API invites — recordFailure documents no
                // precondition) got 43x the intended guesses at lockMs=24h.
                if (entry && typeof entry.lockedUntil === 'number' && entry.lockedUntil > now) {
                    release();
                    return cb(null, toState(entry, now));
                }
                var attempts = 1;
                if (entry
                    && typeof entry.lastFailureAt === 'number'
                    && (now - entry.lastFailureAt) <= windowMs
                    && !(typeof entry.lockedUntil === 'number' && entry.lockedUntil <= now)
                ) {
                    attempts = entry.attempts + 1;
                }

                var fresh = {
                    attempts      : attempts,
                    lastFailureAt : now,
                    lockedUntil   : null,
                    expiresAt     : now + windowMs
                };
                var justLocked = false;
                if (attempts >= maxAttempts) {
                    fresh.lockedUntil = now + lockMs;
                    fresh.expiresAt   = fresh.lockedUntil;
                    // Only a transition emits: an attacker hammering a locked
                    // account must not be able to flood the trail.
                    justLocked = !(entry && typeof entry.lockedUntil === 'number' && entry.lockedUntil > now);
                }

                store.set(key, fresh, function (setErr) {
                    // Release BEFORE the callback: the next queued attempt must
                    // not wait on consumer code, and a consumer that throws must
                    // not strand the key's queue forever.
                    release();
                    if (setErr) {
                        return cb(setErr);
                    }
                    if (justLocked) {
                        emitLocked(key, fresh);
                    }
                    cb(null, toState(fresh, now));
                });
            });
            });
        },

        /**
         * Clear the counter after a successful authentication.
         *
         * @param {string}   key - the account key.
         * @param {function} cb  - `cb(err)`.
         * @returns {void}
         */
        recordSuccess: function (key, cb) {
            if (typeof cb !== 'function') {
                throw new Error('[gina authn] lockout.recordSuccess(key, cb) requires a callback function');
            }
            var keyErr = checkKey(key);
            if (keyErr) {
                return process.nextTick(function () { cb(keyErr); });
            }
            // Serialized with recordFailure: a delete that lands between a
            // concurrent failure's read and its write would otherwise be
            // resurrected by that write.
            key = norm(key);
            withKeyLock(chains, key, function (release) {
                store.del(key, function (err) {
                    release();
                    cb(err);
                });
            });
        },

        /**
         * Lift a lock administratively — the "until the user's identity is
         * confirmed" half of PCI-DSS 8.3.4.
         *
         * @param {string}   key - the account key.
         * @param {function} cb  - `cb(err)`.
         * @returns {void}
         */
        reset: function (key, cb) {
            if (typeof cb !== 'function') {
                throw new Error('[gina authn] lockout.reset(key, cb) requires a callback function');
            }
            var keyErr = checkKey(key);
            if (keyErr) {
                return process.nextTick(function () { cb(keyErr); });
            }
            key = norm(key);
            withKeyLock(chains, key, function (release) {
                store.del(key, function (err) {
                    release();
                    cb(err);
                });
            });
        },

        /**
         * Release the memory store's sweep timer. No-op for a caller-supplied
         * store that exposes no `close`.
         *
         * @returns {void}
         */
        close: function () {
            if (typeof store.close === 'function') {
                store.close();
            }
        },

        /** @private test seam */
        _store: store,
        /** @private test seam — the per-key queues; must drain to empty. */
        _chains: chains,
        /** @private test seam */
        _config: { maxAttempts: maxAttempts, lockMs: lockMs, windowMs: windowMs }
    };
}

module.exports = {
    createLockout            : createLockout,
    _createMemoryStore       : createMemoryStore,
    _DEFAULT_MAX_ATTEMPTS    : DEFAULT_MAX_ATTEMPTS,
    _DEFAULT_LOCK_MS         : DEFAULT_LOCK_MS
};
