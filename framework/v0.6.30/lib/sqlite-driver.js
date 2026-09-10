/**
 * SQLite driver resolver — the single seam through which every framework
 * SQLite consumer obtains its synchronous driver constructor:
 *
 *   - `core/connectors/sqlite/lib/connector.js`      (ORM connector)
 *   - `core/connectors/sqlite/lib/session-store.js`  (session store)
 *   - `core/connectors/sqlite/lib/job-store.js`      (async-job store)
 *   - `lib/state.js`                                 (framework state store, `~/.gina/gina.db`)
 *
 * Resolution order:
 *
 *   1. `node:sqlite` (Node.js built-in since 22.5.0) — tried FIRST, so the
 *      Node path is byte-identical to a direct require, and any future
 *      runtime that implements `node:sqlite` (Bun tracks it upstream as
 *      oven-sh/bun#20412) automatically retires the adapter below.
 *   2. Under the Bun runtime, `bun:sqlite` behind a `DatabaseSync`-shaped
 *      adapter covering exactly the surface the framework uses:
 *      constructor(path) / exec() / prepare() -> get()/all()/run() with
 *      positional parameters / close(). Parity was measured probe-by-probe
 *      against `node:sqlite` (13/13 on bun 1.2.21 and 1.3.14): file
 *      creation, WAL/synchronous/foreign_keys pragmas, `null` bindings,
 *      `run()` result `{ changes, lastInsertRowid }` (both numbers),
 *      `get()` miss, empty `all()`, 0-row `changes`, expando properties
 *      on the handle, `:memory:`, and use-after-close throwing.
 *   3. Neither available -> throws a runtime-aware Error. Callers keep
 *      their own try/catch and prefix their component tag, so per-site
 *      degrade semantics (connector `_err`, store throws, state-store
 *      JSON fallback) are preserved unchanged.
 *
 * Error normalization (the one real node/bun divergence, measured
 * 2026-07-28): `bun:sqlite` reports the numeric SQLite result code on
 * `err.errno` (extended codes included — 5 SQLITE_BUSY, 1555
 * SQLITE_CONSTRAINT_PRIMARYKEY) where `node:sqlite` uses `err.errcode`.
 * The adapter stamps `errcode` from `errno` on every error it rethrows,
 * so downstream transient/permanent classification (`lib/connector-error`,
 * which matches on the numeric `errcode` primary result code) reads both
 * drivers identically.
 *
 * NOT registered in `lib/index.js` — this is an internal seam consumed via
 * relative requires by load-once / bootstrap-scope modules (the same reason
 * they cannot use the registry), it has no cmd/controller consumers, and
 * staying out of the registry keeps the session/job stores standalone-
 * testable and adds no hot-reload eviction surface.
 *
 * @module gina/lib/sqlite-driver
 */
'use strict';

/** @type {Function|null} memoized resolved constructor (success only — a failed resolution is re-attempted, never cached) @private */
var _DatabaseSync = null;

/**
 * Stamps the node-shaped numeric `errcode` onto a bun:sqlite error so the
 * two drivers expose one error contract.
 *
 * bun:sqlite throws `SQLiteError` with the numeric SQLite result code on
 * `errno` and a specific string on `code` (e.g. `'SQLITE_BUSY'`);
 * node:sqlite throws `Error` with `code: 'ERR_SQLITE_ERROR'` and the
 * numeric result code on `errcode`. Consumers (and `lib/connector-error`)
 * key on the numeric `errcode`, so mirror `errno` onto it when absent.
 * The original error object is returned (not wrapped) so `name`, `code`,
 * `message` and the stack all survive verbatim.
 *
 * @private
 * @param {Error} e - The error thrown by bun:sqlite.
 * @returns {Error} The same error, with `errcode` stamped when derivable.
 */
function normalizeBunSqliteError(e) {
    if (e && typeof e.errno === 'number' && typeof e.errcode === 'undefined') {
        try { e.errcode = e.errno; } catch (err) {} // frozen/exotic errors: forward as-is
    }
    return e;
}

/**
 * Builds a `DatabaseSync`-shaped constructor over a `bun:sqlite` module.
 *
 * Pure factory — the bun module is a parameter so the adapter is unit-
 * testable under Node with a stand-in encoding the measured bun contract.
 * Only the surface the framework actually uses is adapted; anything else
 * (`iterate`, named parameters, options objects) is deliberately absent so
 * new consumers surface loudly instead of half-working.
 *
 * @param {object} bunSqlite - The `bun:sqlite` module (`{ Database }`).
 * @returns {Function} A `DatabaseSync`-compatible constructor.
 * @example
 * var BunDatabaseSync = makeAdapter(require('bun:sqlite'));
 * var db = new BunDatabaseSync('/tmp/app.db');
 * db.exec('PRAGMA journal_mode=WAL');
 * var row = db.prepare('SELECT 1 AS one').get(); // { one: 1 }
 */
function makeAdapter(bunSqlite) {
    var BunDatabase = bunSqlite.Database;

    /**
     * `node:sqlite.DatabaseSync`-shaped wrapper over `bun:sqlite.Database`.
     * Like the native class it creates the database file when missing
     * (measured parity) and tolerates expando properties on the instance.
     *
     * @constructor
     * @param {string} location - Database file path (or `':memory:'`).
     */
    function BunDatabaseSync(location) {
        try {
            this._db = new BunDatabase(location);
        } catch (e) {
            throw normalizeBunSqliteError(e);
        }
    }

    /**
     * Executes one or more SQL statements without preparing (DDL, pragmas).
     * @param {string} sql - SQL text.
     * @returns {undefined}
     */
    BunDatabaseSync.prototype.exec = function (sql) {
        try { this._db.exec(sql); } catch (e) { throw normalizeBunSqliteError(e); }
    };

    /**
     * Prepares a statement. The returned object exposes the three methods
     * the framework calls — `get` / `all` / `run` — each accepting the same
     * positional parameters as node:sqlite and normalizing errors.
     *
     * @param {string} sql - SQL text with positional `?` placeholders.
     * @returns {{get: Function, all: Function, run: Function}} Prepared statement.
     */
    BunDatabaseSync.prototype.prepare = function (sql) {
        var stmt;
        try { stmt = this._db.prepare(sql); } catch (e) { throw normalizeBunSqliteError(e); }
        return {
            /** First row or `undefined` (bun's `null` miss is mapped to node's `undefined`). */
            get: function () {
                var r;
                try { r = stmt.get.apply(stmt, arguments); } catch (e) { throw normalizeBunSqliteError(e); }
                return (r === null) ? undefined : r;
            },
            /** All rows as an array (empty array when none). */
            all: function () {
                try { return stmt.all.apply(stmt, arguments); } catch (e) { throw normalizeBunSqliteError(e); }
            },
            /** Write execution — returns `{ changes, lastInsertRowid }` (both numbers, measured). */
            run: function () {
                try { return stmt.run.apply(stmt, arguments); } catch (e) { throw normalizeBunSqliteError(e); }
            }
        };
    };

    /**
     * Closes the database. Subsequent use throws, matching node:sqlite.
     * @returns {undefined}
     */
    BunDatabaseSync.prototype.close = function () {
        try { this._db.close(); } catch (e) { throw normalizeBunSqliteError(e); }
    };

    return BunDatabaseSync;
}

/**
 * Resolves the synchronous SQLite driver constructor for this runtime.
 *
 * Returns `node:sqlite`'s `DatabaseSync` verbatim when available (every
 * supported Node, and any future Bun implementing it), else the
 * `bun:sqlite` adapter under Bun. Throws when this runtime offers no
 * SQLite driver — callers wrap the message with their component tag and
 * keep their existing degrade semantics.
 *
 * @returns {Function} A `DatabaseSync`-compatible constructor.
 * @throws {Error} When neither `node:sqlite` nor `bun:sqlite` is available.
 * @example
 * var DatabaseSync;
 * try {
 *     DatabaseSync = require('./sqlite-driver').getDatabaseSync();
 * } catch (e) {
 *     throw new Error('[MyComponent] ' + e.message);
 * }
 * var db = new DatabaseSync('/tmp/app.db');
 */
function getDatabaseSync() {
    if (_DatabaseSync) return _DatabaseSync;

    var nodeErr;
    try {
        _DatabaseSync = require('node:sqlite').DatabaseSync;
        return _DatabaseSync;
    } catch (e) {
        nodeErr = e;
    }

    var runtime = require(__dirname + '/../../../utils/runtime');
    if (runtime.isBun()) {
        var bunSqlite;
        try {
            bunSqlite = require('bun:sqlite');
        } catch (e) {
            // Near-unreachable: bun:sqlite ships with every supported Bun.
            throw new Error('SQLite driver unavailable under Bun (bun:sqlite failed to load): ' + e.message);
        }
        _DatabaseSync = makeAdapter(bunSqlite);
        return _DatabaseSync;
    }

    // Plain Node without node:sqlite — keep the historical message shape.
    throw new Error(
        'node:sqlite requires Node.js >= 22.5.0. '
        + 'Current: ' + process.version + '\n'
        + nodeErr.message
    );
}

module.exports = {
    getDatabaseSync : getDatabaseSync,
    makeAdapter     : makeAdapter,
    // exposed for unit tests
    _normalizeBunSqliteError : normalizeBunSqliteError
};
