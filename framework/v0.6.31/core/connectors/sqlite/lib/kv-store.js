/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/sqlite/kv-store
 * @description SQLite backend for the general-purpose KV primitive (#KV1,
 * slice 2) — the zero-dependency durable backend, sitting between the
 * in-memory default (fast, process-local, lost on restart) and redis (shared
 * across hosts, needs a server).
 *
 * Backed by `node:sqlite` through the shared `lib/sqlite-driver` seam (the
 * built-in on Node, a `bun:sqlite` adapter under Bun), the same substrate as
 * `lib/state`, the SQLite session/job stores and the storage metadata store.
 *
 * **What it buys over memory:** namespace contents survive a bundle restart,
 * and any process opening the same file sees them — so a single-host
 * multi-bundle deployment can share a namespace without running redis. **What
 * it does not buy:** cross-HOST sharing; that is what the redis backend is
 * for.
 *
 * **Namespaces share a file by a composite key**, not a key prefix: the table
 * is keyed `(ns, key)`, so two namespaces pointing at one `connectors.json`
 * entry never collide and `clear()` is a single `DELETE ... WHERE ns = ?`.
 * (The redis backend prefixes instead, because redis has no composite key.)
 *
 * **Atomicity comes from IMMEDIATE transactions, not from the driver being
 * synchronous.** Being synchronous makes each verb indivisible *within this
 * process*, which is exactly the guarantee that does NOT hold once a second
 * process opens the same file — and multi-process sharing is the reason to
 * choose this backend at all. So every read-modify-write verb (`del`,
 * `setnx`, `consume`, `incrby`, `compareDel`) runs inside
 * `BEGIN IMMEDIATE` / `COMMIT`, which takes SQLite's write lock up front and
 * makes the pair atomic against other processes too. Single-statement verbs
 * need no transaction.
 *
 * **Expiry is lazy on read plus a periodic sweep**, mirroring the in-memory
 * backend: every read filters on `exp`, so an unswept expired row is never
 * observable; the sweep only bounds file growth. `clear()` deliberately counts
 * expired-but-unswept rows, because the in-memory backend's `clear()` reports
 * `map.size` on the same basis.
 *
 * `file` is the PATH key by the sqlite DB-connector convention — the model
 * layer scans every `connectors.json` entry at boot and treats `database` as a
 * NAME, so a path in `database` fails the boot before this store is built.
 *
 * @example
 *   // connectors.json:  { "kvDb": { "connector": "sqlite", "file": "/data/kv.db" } }
 *   // settings.json:    { "kv": { "namespaces": { "tokens": { "store": "kvDb" } } } }
 *   // (wired automatically at boot by gna.js via lib/kv-store)
 */

/**
 * Default expired-row sweep cadence, ms.
 * @constant
 * @inner
 * @type {number}
 */
var DEFAULT_SWEEP_MS = 30000;

/**
 * Build the SQLite KV backend for one namespace.
 *
 * @class SqliteKvStore
 * @constructor
 *
 * @param {object} connConf                 - Resolved `connectors.json` entry.
 * @param {string} [connConf.file]          - SQLite file path, or `':memory:'` (volatile —
 *                                            only useful in tests). Defaults to
 *                                            `~/.gina/{version}/kv-{bundle}.db`.
 * @param {number} [connConf.sweepInterval] - Expired-row sweep cadence in ms (default 30000).
 * @param {string} bundle                   - Bundle name — used for the default file name.
 * @param {string} namespaceName            - KV namespace this store backs (the `ns` column).
 * @returns {object}                        - A `KvStoreContract` instance (see `lib/kv`).
 * @throws {Error}                          - When no SQLite driver is available, or the
 *                                            database file cannot be opened.
 */
module.exports = function SqliteKvStore(connConf, bundle, namespaceName) {
    connConf = connConf || {};

    var DatabaseSync;
    try {
        DatabaseSync = require('./../../../../lib/sqlite-driver').getDatabaseSync();
    } catch (e) {
        throw new Error('[SqliteKvStore] ' + e.message);
    }

    // Resolve the DB path: connectors.json `file` > default per-bundle file.
    // The default branch is the only place the injected `_` / `getPath`
    // globals are read, so a test passing an explicit `file` stays standalone.
    var dbPath = connConf.file
        || _(getPath('gina').home + '/kv-' + (bundle || 'bundle') + '.db', true);

    var ns = String(namespaceName || 'default');
    var db = new DatabaseSync(dbPath);

    // WAL + synchronous=NORMAL — the same trade-off as the sibling SQLite
    // stores: concurrent readers never block the writer; a crash can lose the
    // last committed transaction but never corrupts the file.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');

    // Schema bootstrap — idempotent. `exp` is epoch MILLISECONDS or NULL for
    // "no expiry"; the composite primary key is what isolates namespaces
    // sharing one file.
    db.exec(
        'CREATE TABLE IF NOT EXISTS kv ('
        + '  ns    TEXT NOT NULL,'
        + '  key   TEXT NOT NULL,'
        + '  value TEXT NOT NULL,'
        + '  exp   INTEGER,'
        + '  PRIMARY KEY (ns, key)'
        + ')'
    );
    db.exec('CREATE INDEX IF NOT EXISTS kv_exp ON kv (exp)');

    var stmtGet     = db.prepare('SELECT value, exp FROM kv WHERE ns = ? AND key = ?');
    var stmtPut     = db.prepare('INSERT OR REPLACE INTO kv (ns, key, value, exp) VALUES (?, ?, ?, ?)');
    var stmtDel     = db.prepare('DELETE FROM kv WHERE ns = ? AND key = ?');
    var stmtExpire  = db.prepare('UPDATE kv SET exp = ? WHERE ns = ? AND key = ?');
    var stmtClear   = db.prepare('DELETE FROM kv WHERE ns = ?');
    var stmtSweep   = db.prepare('DELETE FROM kv WHERE ns = ? AND exp IS NOT NULL AND exp <= ?');

    /**
     * The live row for a key, or `null` when absent or expired.
     * @inner
     * @param {string} key - Caller key.
     * @returns {?{value: string, exp: ?number}}
     */
    function live(key) {
        var row = stmtGet.get(ns, key);
        if (!row) { return null; }
        if (row.exp !== null && typeof row.exp !== 'undefined' && row.exp <= Date.now()) { return null; }
        return row;
    }

    /**
     * Run `fn` inside `BEGIN IMMEDIATE` / `COMMIT`, rolling back on a throw.
     * IMMEDIATE takes the write lock up front, so a read-modify-write pair is
     * atomic against OTHER PROCESSES sharing the file — the guarantee the
     * synchronous driver alone does not provide.
     *
     * @inner
     * @param {function} fn - Body; its return value is returned.
     * @returns {*} Whatever `fn` returns.
     */
    function tx(fn) {
        db.exec('BEGIN IMMEDIATE');
        var out;
        try {
            out = fn();
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch (rbErr) { /* the throw below is the real error */ }
            throw err;
        }
        db.exec('COMMIT');
        return out;
    }

    /**
     * Lift a synchronous body into the contract's promise shape.
     * @inner
     * @param {function} fn - Body.
     * @returns {Promise<*>}
     */
    function P(fn) {
        try {
            return Promise.resolve(fn());
        } catch (err) {
            return Promise.reject(err);
        }
    }

    var sweepMs = (Number.isSafeInteger(connConf.sweepInterval) && connConf.sweepInterval > 0)
        ? connConf.sweepInterval
        : DEFAULT_SWEEP_MS;

    // Bounds file growth only — reads already filter on `exp`, so an unswept
    // row is never observable. Never keeps the process alive.
    var timer = setInterval(function sweepExpired() {
        try { stmtSweep.run(ns, Date.now()); } catch (sweepErr) { /* next tick retries */ }
    }, sweepMs);
    if (timer.unref) { timer.unref(); }

    return {
        get: function (key) {
            return P(function () {
                var row = live(key);
                return row ? row.value : null;
            });
        },

        set: function (key, s, ttlMs) {
            return P(function () {
                stmtPut.run(ns, key, s, ttlMs ? Date.now() + ttlMs : null);
                return undefined;
            });
        },

        del: function (key) {
            return P(function () {
                return tx(function () {
                    var existed = !!live(key);
                    // Unconditional: an expired row is swept opportunistically
                    // here too, while `existed` keeps the contract's
                    // live-only semantics.
                    stmtDel.run(ns, key);
                    return existed;
                });
            });
        },

        has: function (key) {
            return P(function () { return !!live(key); });
        },

        pttl: function (key) {
            return P(function () {
                var row = live(key);
                if (!row) { return null; }
                if (row.exp === null || typeof row.exp === 'undefined') { return -1; }
                return Math.max(0, row.exp - Date.now());
            });
        },

        pexpire: function (key, ttlMs) {
            return P(function () {
                return tx(function () {
                    if (!live(key)) { return false; }
                    stmtExpire.run(Date.now() + ttlMs, ns, key);
                    return true;
                });
            });
        },

        setnx: function (key, s, ttlMs) {
            return P(function () {
                return tx(function () {
                    // An EXPIRED row must lose, not win: plain INSERT ... ON
                    // CONFLICT DO NOTHING would see the dead row as a conflict
                    // and refuse a write that should succeed.
                    if (live(key)) { return false; }
                    stmtPut.run(ns, key, s, ttlMs ? Date.now() + ttlMs : null);
                    return true;
                });
            });
        },

        consume: function (key) {
            return P(function () {
                return tx(function () {
                    var row = live(key);
                    stmtDel.run(ns, key);
                    return row ? row.value : null;
                });
            });
        },

        incrby: function (key, by, ttlMs) {
            return P(function () {
                return tx(function () {
                    var row = live(key);
                    var cur = 0;
                    if (row) {
                        cur = Number(row.value);
                        if (!Number.isSafeInteger(cur)) {
                            throw new Error('[kv] value at key `' + key + '` is not an integer — incr/decr need an integer value');
                        }
                    }
                    var next = cur + by;
                    if (!Number.isSafeInteger(next)) {
                        throw new Error('[kv] increment leaves the safe-integer range at key `' + key + '`');
                    }
                    // TTL applies on CREATE only — an existing counter keeps
                    // whatever expiry it already had.
                    var exp = row ? ((typeof row.exp === 'undefined') ? null : row.exp)
                                  : (ttlMs ? Date.now() + ttlMs : null);
                    stmtPut.run(ns, key, String(next), exp);
                    return next;
                });
            });
        },

        compareDel: function (key, s) {
            return P(function () {
                return tx(function () {
                    var row = live(key);
                    if (row && row.value === s) {
                        stmtDel.run(ns, key);
                        return true;
                    }
                    return false;
                });
            });
        },

        clear: function () {
            return P(function () {
                // Counts expired-but-unswept rows, matching the in-memory
                // backend's `map.size` basis.
                var res = stmtClear.run(ns);
                return res.changes;
            });
        },

        close: function () {
            clearInterval(timer);
            try { db.close(); } catch (closeErr) { /* already closed */ }
        }
    };
};
