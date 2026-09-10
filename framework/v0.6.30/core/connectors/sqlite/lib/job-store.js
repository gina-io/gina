/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/sqlite/job-store
 *
 * SQLite-backed `JobStore` for the async-job primitive (`lib/job`) — the
 * connector-backed store follow-up of #AI6. Backed by `node:sqlite` (Node.js
 * built-in since 22.5.0 — zero npm deps), the same substrate as the framework
 * state store (`lib/state`) and the SQLite session store.
 *
 * What it buys over the default memory store: job records survive a bundle
 * restart (a client polling `/_gina/jobs/:id` keeps resolving across a
 * deploy), and are visible to any process that opens the same file. The
 * deferred *function* still runs only in the process that created the job —
 * the store shares the record, never the closure (see `lib/job`).
 *
 * Deliberate divergences from the SQLite SESSION store (same file family,
 * different contract):
 *   - `get` / `list` do NOT filter on expiry. The memory store returns
 *     terminal records until `sweep` purges them, and behavioral parity with
 *     the memory store is the contract here — expiry acts only at sweep time.
 *   - No internal cleanup timer. `lib/job` owns the sweep cadence and calls
 *     `sweep(now, fn)` itself.
 *
 * Constructed by the `lib/job-store` dispatcher at boot; not meant to be
 * instantiated from application code.
 */

/**
 * Job lifecycle states — imported so the sweep predicate can never drift from
 * the memory store's (`lib/job` is a plain-required module-singleton; there is
 * no load-time cycle because `lib/job` never requires this file — the
 * `lib/job-store` dispatcher requires it lazily at boot).
 *
 * @inner
 * @type {{PENDING:string, RUNNING:string, COMPLETED:string, FAILED:string}}
 */
var STATES = require('../../../../lib/job/src/main').STATES;

// #B432 — `lib/job` must see exactly one callback. Each method below wraps
// `fn` at entry, so a callback that THROWS can no longer be re-invoked by
// that method's own error path (see core/connectors/settle-once.js).
var settleOnce = require('./../../settle-once');

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * Build a SQLite-backed job store implementing the `lib/job` `JobStore` seam
 * (`set / get / remove / list / sweep`, all Node-callback-shaped). Callbacks
 * fire synchronously (`node:sqlite`'s `DatabaseSync` is a synchronous driver),
 * so the store has the same timing semantics class as the memory store.
 *
 * @param {object}  connConf        - Resolved `connectors.json` entry for this store.
 * @param {string}  [connConf.file] - Path to the SQLite file, or `':memory:'` (volatile —
 *                                    only useful in tests). Defaults to
 *                                    `~/.gina/{version}/jobs-{bundle}.db`.
 *                                    `file` is the PATH key by the sqlite DB-connector
 *                                    convention — the model layer scans every
 *                                    connectors.json entry at boot and treats `database`
 *                                    as a NAME (`~/.gina/{version}/{database}.sqlite`),
 *                                    so a path in `database` fails the boot before this
 *                                    store is even built.
 * @param {string}  bundle          - Bundle name — used for the default file name.
 * @returns {object}                - A `JobStore` instance, plus a `close()` convenience
 *                                    (not part of the seam; releases the file handle).
 * @throws {Error}                  - On Node < 22.5.0 (no `node:sqlite`) or when the
 *                                    database file cannot be opened.
 *
 * @example
 *   // connectors.json:  { "jobsDb": { "connector": "sqlite", "file": "/data/jobs.db" } }
 *   // app.json:         { "jobs": { "store": "jobsDb" } }
 *   // (wired automatically at boot by gna.js via lib/job-store)
 */
module.exports = function SqliteJobStore(connConf, bundle) {
    connConf = connConf || {};

    // Resolve the SQLite driver through the shared seam — node:sqlite on
    // Node (built-in since 22.5.0, zero npm deps), bun:sqlite behind an
    // adapter on Bun. See lib/sqlite-driver.js.
    var DatabaseSync;
    try {
        DatabaseSync = require('./../../../../lib/sqlite-driver').getDatabaseSync();
    } catch (e) {
        throw new Error('[SqliteJobStore] ' + e.message);
    }

    // Resolve DB path: connectors.json `file` > default per-bundle file. The
    // default branch is the only place the injected `_` / `getPath` globals
    // are read, so a test passing an explicit `file` stays standalone.
    var dbPath = connConf.file
        || _(getPath('gina').home + '/jobs-' + (bundle || 'bundle') + '.db', true);

    var db = new DatabaseSync(dbPath);

    // WAL + synchronous=NORMAL: same trade-off as the SQLite session store —
    // concurrent readers never block the writer; a crash can lose the last
    // committed transaction but never corrupts the database.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');

    // Schema bootstrap — idempotent. Thin indexed columns for the two query
    // shapes (list-by-state, sweep-by-expiry); the full record rides as JSON
    // because it legitimately gains keys after creation (webhookDeliveredAt,
    // webhookFailed, ...). All timestamps are epoch MILLISECONDS — the seam's
    // unit (`sweep(now)` receives `Date.now()`).
    db.exec(
        'CREATE TABLE IF NOT EXISTS jobs ('
        + '  id         TEXT    PRIMARY KEY,'
        + '  state      TEXT    NOT NULL,'
        + '  expires_at INTEGER,'
        + '  updated_at INTEGER NOT NULL,'
        + '  record     TEXT    NOT NULL'
        + ')'
    );
    db.exec('CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state)');
    db.exec('CREATE INDEX IF NOT EXISTS jobs_expires ON jobs (expires_at)');

    // Prepare reusable statements once — avoids re-parsing SQL on every call.
    var stmtUpsert    = db.prepare('INSERT OR REPLACE INTO jobs (id, state, expires_at, updated_at, record) VALUES (?, ?, ?, ?, ?)');
    var stmtGet       = db.prepare('SELECT record FROM jobs WHERE id = ?');
    var stmtDel       = db.prepare('DELETE FROM jobs WHERE id = ?');
    var stmtListAll   = db.prepare('SELECT record FROM jobs');
    var stmtListState = db.prepare('SELECT record FROM jobs WHERE state = ?');
    var stmtSweep     = db.prepare(
        'DELETE FROM jobs WHERE expires_at IS NOT NULL AND expires_at <= ?'
        + ' AND state IN (\'' + STATES.COMPLETED + '\', \'' + STATES.FAILED + '\')'
    );

    return {

        /**
         * Upsert `record` under `id`. The record is serialised whole; `state`
         * and `expiresAt` are additionally mirrored into their indexed columns.
         *
         * @param {string}    id
         * @param {JobRecord} record
         * @param {function}  [fn] - `fn(err, record)`.
         * @returns {void}
         */
        set: function(id, record, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('sqlite:job#set', fn, console);
            var json;
            try {
                json = JSON.stringify(record);
            } catch (err) {
                return fn(err);
            }
            try {
                stmtUpsert.run(
                    id,
                    String(record.state || ''),
                    (typeof record.expiresAt === 'number') ? record.expiresAt : null,
                    (typeof record.updatedAt === 'number') ? record.updatedAt : Date.now(),
                    json
                );
                fn(null, record);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Fetch a record by `id`. No expiry filter — a terminal record past its
         * `expiresAt` stays readable until `sweep` purges it (memory-store parity).
         *
         * @param {string}   id
         * @param {function} fn - `fn(err, record|null)`.
         * @returns {void}
         */
        get: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('sqlite:job#get', fn, console);
            var row;
            try {
                row = stmtGet.get(id);
            } catch (err) {
                return fn(err);
            }
            if (!row) return fn(null, null);
            try {
                return fn(null, JSON.parse(row.record));
            } catch (parseErr) {
                return fn(new Error('[SqliteJobStore] could not parse job record `' + id + '`: ' + parseErr.message));
            }
        },

        /**
         * Delete a record by `id`.
         *
         * @param {string}   id
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        remove: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('sqlite:job#remove', fn, console);
            try {
                var res = stmtDel.run(id);
                fn(null, res.changes > 0);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * List records, optionally filtered by `{ state }`. No expiry filter
         * (memory-store parity). A record that fails to parse fails the whole
         * list loudly — silent skipping would hide corruption.
         *
         * @param {?Object}  filter - e.g. `{ state: 'failed' }`; `null` for all.
         * @param {function} fn     - `fn(err, records)`.
         * @returns {void}
         */
        list: function(filter, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('sqlite:job#list', fn, console);
            try {
                var rows = (filter && filter.state) ? stmtListState.all(String(filter.state)) : stmtListAll.all();
                var out  = [];
                for (var i = 0; i < rows.length; i++) {
                    out.push(JSON.parse(rows[i].record));
                }
                fn(null, out);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Purge terminal (`completed` / `failed`) records whose `expiresAt` has
         * elapsed — the exact memory-store predicate, expressed as one DELETE.
         *
         * @param {number}   now - Epoch ms (passed in by `lib/job`).
         * @param {function} fn  - `fn(err, removedCount)`.
         * @returns {void}
         */
        sweep: function(now, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('sqlite:job#sweep', fn, console);
            try {
                var res = stmtSweep.run(now);
                fn(null, res.changes);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Release the underlying file handle. NOT part of the `JobStore` seam —
         * `lib/job` never calls it; provided for tests and explicit teardown.
         *
         * @returns {void}
         */
        close: function() {
            try { db.close(); } catch (e) { /* already closed */ }
        }
    };
};
