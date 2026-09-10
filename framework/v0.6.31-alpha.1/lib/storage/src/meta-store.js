/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/storage/meta-store
 * @description The embedded SQLite {@link StorageMetaStore} — the default
 * metadata backend when a driver names no connector `store`.
 *
 * Sibling of `lib/job`'s `createMemoryStore()`: the dispatcher
 * (`lib/storage-store`) resolves CONNECTOR-backed stores, and the default
 * implementation lives here, on the consumer side, exactly as the async-job
 * primitive arranges it.
 *
 * **Single-process per driver root.** SQLite's locking is a known-broken story
 * on a shared network filesystem, so two bundles (or merged-process siblings)
 * pointing at one root with this backend is NOT supported. The supported
 * multi-process answer IS the seam — a connector-backed store. Nothing here
 * enforces that: cross-process discovery is not something the framework has,
 * and a guess would be worse than a documented boundary.
 *
 * Wraps `node:sqlite` (via the shared `lib/sqlite-driver` seam, which also
 * covers Bun). Consumers must not reach for the driver directly.
 *
 * @example
 * var store = createEmbeddedMetaStore('/var/data/assets/.meta.db');
 * store.set('2026/08/10/01J…', { originalName: 'a.pdf', size: 12 }, function (err) {});
 */

var fs       = require('fs');
var nodePath = require('path');

/**
 * The shared SQLite driver seam — `node:sqlite` first, a `bun:sqlite` adapter
 * under Bun. Required by RELATIVE path because the seam documents staying out
 * of the `lib` registry, which is also what keeps this module loadable in a
 * standalone test.
 *
 * This is the ONE framework import `lib/storage` makes, and it is deliberate:
 * the framework-independence rule forbids gina CORE, the registry and the
 * injected globals — not this dependency-free driver seam.
 * `test/lib/storage-import-boundary.test.js` pins the exception so adding a
 * second one has to be a deliberate act.
 *
 * @inner
 * @type {object}
 */
var sqliteDriver = require('./../../sqlite-driver');

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * Per-object metadata as persisted by the store.
 *
 * @typedef  {Object} StorageMeta
 * @property {?string} originalName - Client-supplied filename, verbatim and untrusted. NEVER
 *                                    used to build a path — the key owns the layout.
 * @property {?string} contentType  - Client-supplied MIME type, untrusted.
 * @property {number}  size         - Object size in bytes, measured by the adapter as it
 *                                    wrote (never taken from the client).
 * @property {number}  createdAt    - Epoch ms at publish time.
 * @property {?Buffer} data         - The object PAYLOAD, present only for size-tiered
 *                                    inline objects (below the driver's `inlineThreshold`).
 *                                    `null`/absent means the bytes live in the file tree.
 *                                    A store implementation MUST round-trip these bytes
 *                                    exactly (binary-safe — no utf8 coercion, no
 *                                    truncation at NUL): they ARE the object, not a
 *                                    description of it. `get()` returns the key only for
 *                                    file-backed rows so their shape is unchanged.
 * @property {number}  [refs]       - Reference count, present ONLY on refcounted (`cas`)
 *                                    rows — mirroring how `data` stays off file-backed
 *                                    rows, so a non-refcounted row keeps its exact
 *                                    pre-cas shape. Owned by `acquireRef`/`releaseRef`;
 *                                    `set()` must never touch a refcounted row (its
 *                                    REPLACE semantics would reset the count).
 * @property {?number} [zeroAt]     - Epoch ms at which `refs` last reached 0, or `null`
 *                                    while `refs` > 0. Present only alongside `refs`.
 *                                    Invariant: `zeroAt` is non-null exactly when
 *                                    `refs` === 0 — the GC grace window reads it.
 */

/**
 * The metadata persistence seam. The embedded SQLite store below is the v1
 * implementation; a connector-backed store (resolved by `lib/storage-store`,
 * demand-gated) implements the same three methods plus `close`.
 *
 * Since size tiering, a row may CARRY the object payload (`meta.data`, a
 * Buffer) — so a connector implementation needs a binary-safe column/field for
 * it, and losing the store loses those objects, not just their metadata. Both
 * facts are part of the contract, not implementation detail.
 *
 * **The refcount verbs (`acquireRef` / `releaseRef` / `listZeroRefs` /
 * `removeIfZero`) are OPTIONAL — required only to back a `cas` driver**, which
 * refuses to build against a store lacking them. Each MUST be atomic with
 * respect to the others for a given key: `acquireRef` is what makes two
 * concurrent identical `put()`s yield one blob and two references instead of a
 * lost update, and `removeIfZero` is what lets the GC sweep claim a blob
 * without racing a resurrection. The embedded store gets that atomicity from
 * the driver being synchronous (each verb completes inside one JS turn); an
 * async connector implementation must provide it itself (a counter mutation,
 * a compare-and-set loop, a Lua script — whatever the backend's atomic
 * primitive is) and inherits the documented residual: across PROCESSES, the
 * sweep's unlink can in principle race a same-content publish in the
 * nanoseconds between claim and unlink — which is why the sweep only collects
 * blobs at zero for longer than the grace window.
 *
 * Multi-process sweep COORDINATION was expected to arrive with the first
 * connector store; measured against that store (couchbase, 2026-08-14), it
 * turned out to need no election layer, because `removeIfZero`'s atomicity IS
 * the coordination: several processes may sweep one root concurrently and
 * exactly one claim per blob wins, every loser reading a compare-and-set
 * failure and skipping. An election would also have made `storage:gc` report
 * `collected: 0` on whichever process did not hold the lease. The residual
 * above is UNCHANGED by that finding — it is put-vs-sweep, not
 * sweeper-vs-sweeper, so no coordination between sweepers could have closed
 * it; the grace window, the put-side heal and `storage:verify` remain its
 * mitigations.
 *
 * @typedef  {Object} StorageMetaStore
 * @property {function(string, StorageMeta, function=): void} set    - Upsert `meta` under `key`; `fn(err, meta)`. MUST report failure through the callback, never by throwing. NEVER call it on a refcounted row — REPLACE semantics would reset the count; `acquireRef` owns those rows.
 * @property {function(string, function): void}               get    - Fetch by `key`; `fn(err, meta|null)`. Rows holding an inline payload include `data` (Buffer); refcounted rows include `refs` (+ `zeroAt`); rows that are neither omit both keys entirely, keeping their pre-tiering/pre-cas shape.
 * @property {function(string, function=): void}              remove - Delete by `key`; `fn(err, existed)`.
 * @property {function(): void}                               close  - Release the backend handle. NOT called on the request path — provided for teardown and tests.
 * @property {function(string, StorageMeta, function=): void} [acquireRef]  - Atomically insert `meta` under `key` with `refs`=1, or — when the row exists — increment `refs` and clear `zeroAt`, IGNORING the incoming meta (first-write-wins: identical bytes already have a row, and its identity fields stay). `fn(err, {created, refs, meta})` — `meta` is the STORED row's metadata (payload excluded).
 * @property {function(string, function=): void}              [releaseRef]  - Atomically decrement `refs`, flooring at 0 and stamping `zeroAt` when 0 is reached. On a missing, non-refcounted, or already-zero row: `{existed:false}`. `fn(err, {existed, refs})`.
 * @property {function(number, number, function): void}       [listZeroRefs] - Keys with `refs` === 0 whose `zeroAt` <= `olderThanMs`, oldest first, at most `limit`. Non-refcounted rows (refs NULL/absent) are never returned. `fn(err, keys)`.
 * @property {function(string, function=): void}              [removeIfZero] - Delete the row ONLY IF `refs` is still 0 — the sweep's claim step, so a concurrent `acquireRef` resurrection always wins. `fn(err, removed)`.
 * @property {function(function): void}                       [stats]        - Aggregate counts for the operator surface (`storage:stats`): `fn(err, {objects, refcounted, zeroRefPending, inline, bytes})` — reserved rows (dot-keys, e.g. the `.driver` stamp) excluded, `bytes` the SUM of logical object sizes (a deduplicated blob counts once). OPTIONAL — a store lacking it degrades to "store reports no stats" (the refcount-verb vocabulary).
 * @property {function(string, number, function): void}       [listKeys]     - Page over object keys: keys strictly AFTER `afterKey` (lexicographic; `''` starts), reserved dot-key rows excluded, at most `limit`, ordered by key so the cursor is stable under concurrent writes. `fn(err, keys)`. OPTIONAL — backs `storage:verify`'s rows-without-files direction; a store lacking it degrades verify to the files direction only.
 */

/**
 * Build the embedded SQLite metadata store for one driver root.
 *
 * Callbacks fire synchronously (`DatabaseSync` is a synchronous driver), so
 * this has the same timing class as `lib/job`'s memory store.
 *
 * @param {string} dbPath - Absolute path to the metadata database file. Its parent
 *                          directory is created when missing.
 * @returns {StorageMetaStore} A ready store.
 * @throws {Error} On a runtime with no SQLite driver, or when the file cannot be opened —
 *                 the caller treats a throw as fatal, because a driver whose metadata
 *                 cannot be written would answer `stat()` with silence.
 *
 * @example
 * var store = createEmbeddedMetaStore('/var/data/assets/.meta.db');
 */
module.exports = function createEmbeddedMetaStore(dbPath) {

    var DatabaseSync;
    try {
        DatabaseSync = sqliteDriver.getDatabaseSync();
    } catch (e) {
        throw new Error('[storage] ' + e.message);
    }

    // The root may not exist yet on a first boot; the DB is inside it.
    var dir = nodePath.dirname(dbPath);
    if ( !fs.existsSync(dir) ) {
        fs.mkdirSync(dir, { recursive: true });
    }

    var db = new DatabaseSync(dbPath);

    // WAL + synchronous=NORMAL — the same trade-off the SQLite job and session
    // stores take: concurrent readers never block the writer, and a crash can
    // lose the last committed transaction but never corrupts the database.
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA synchronous=NORMAL');

    // Idempotent schema bootstrap. `key` is the opaque storage key; `data`
    // holds the payload ONLY for size-tiered inline objects — file-backed rows
    // leave it NULL; `refs`/`zero_at` are set ONLY on refcounted (cas) rows —
    // everything else leaves them NULL, which is what keeps `WHERE refs = 0`
    // sweeps blind to non-refcounted rows (NULL never equals 0 in SQL).
    db.exec(
        'CREATE TABLE IF NOT EXISTS objects ('
        + '  key           TEXT    PRIMARY KEY,'
        + '  original_name TEXT,'
        + '  content_type  TEXT,'
        + '  size          INTEGER,'
        + '  created_at    INTEGER NOT NULL,'
        + '  data          BLOB,'
        + '  refs          INTEGER,'
        + '  zero_at       INTEGER'
        + ')'
    );

    // Additive, idempotent migrations: a database created before size tiering
    // lacks `data`; one created before cas lacks `refs`/`zero_at`. CREATE TABLE
    // IF NOT EXISTS will not add columns to an existing table, ALTER is cheap
    // (a catalog update, no table rewrite), and running each at most once is
    // guaranteed by the column probe.
    var _have = {};
    var _cols = db.prepare('PRAGMA table_info(objects)').all();
    for (var _c = 0; _c < _cols.length; _c++) {
        _have[_cols[_c].name] = true;
    }
    if ( !_have.data )    { db.exec('ALTER TABLE objects ADD COLUMN data BLOB'); }
    if ( !_have.refs )    { db.exec('ALTER TABLE objects ADD COLUMN refs INTEGER'); }
    if ( !_have.zero_at ) { db.exec('ALTER TABLE objects ADD COLUMN zero_at INTEGER'); }

    // Prepared once — avoids re-parsing SQL on every call.
    // NB deliberately NO `RETURNING` anywhere: the Bun sqlite adapter covers
    // exactly the surface measured against node:sqlite (get/all/run with
    // positional params), and `RETURNING` is not on that list. Every verb
    // below composes from plain UPDATE/SELECT/INSERT/DELETE instead — atomic
    // in-process because the driver is synchronous (each verb completes
    // inside one JS turn; nothing can interleave).
    var stmtUpsert = db.prepare('INSERT OR REPLACE INTO objects (key, original_name, content_type, size, created_at, data) VALUES (?, ?, ?, ?, ?, ?)');
    var stmtGet    = db.prepare('SELECT original_name, content_type, size, created_at, data, refs, zero_at FROM objects WHERE key = ?');
    var stmtDel    = db.prepare('DELETE FROM objects WHERE key = ?');
    // cas refcount verbs. The `refs IS NOT NULL` guard on the increment keeps
    // acquireRef from silently "adopting" a non-refcounted row that happens to
    // share the key (it falls through to INSERT, whose PRIMARY KEY conflict
    // then surfaces loudly instead).
    var stmtIncr   = db.prepare('UPDATE objects SET refs = refs + 1, zero_at = NULL WHERE key = ? AND refs IS NOT NULL');
    var stmtInsRef = db.prepare('INSERT INTO objects (key, original_name, content_type, size, created_at, data, refs, zero_at) VALUES (?, ?, ?, ?, ?, ?, 1, NULL)');
    var stmtRefs   = db.prepare('SELECT original_name, content_type, size, created_at, refs FROM objects WHERE key = ?');
    var stmtDecr   = db.prepare('UPDATE objects SET refs = ?, zero_at = ? WHERE key = ?');
    var stmtZero   = db.prepare('SELECT key FROM objects WHERE refs = 0 AND zero_at <= ? ORDER BY zero_at LIMIT ?');
    var stmtRmZ    = db.prepare('DELETE FROM objects WHERE key = ? AND refs = 0');
    // operator-surface verbs (#STO1 CLI slice). Reserved dot-key rows (the
    // `.driver` stamp) are excluded in SQL — they are infrastructure, and
    // counting the stamp would report one "object" on every empty root.
    var stmtStats  = db.prepare('SELECT COUNT(*) AS objects, COALESCE(SUM(CASE WHEN refs IS NOT NULL THEN 1 ELSE 0 END), 0) AS refcounted, COALESCE(SUM(CASE WHEN refs = 0 THEN 1 ELSE 0 END), 0) AS zeroRefPending, COALESCE(SUM(CASE WHEN data IS NOT NULL THEN 1 ELSE 0 END), 0) AS inline, COALESCE(SUM(size), 0) AS bytes FROM objects WHERE key NOT LIKE \'.%\'');
    var stmtKeys   = db.prepare('SELECT key FROM objects WHERE key > ? AND key NOT LIKE \'.%\' ORDER BY key LIMIT ?');

    return {

        /**
         * Upsert `meta` under `key`.
         *
         * @param {string}      key
         * @param {StorageMeta} meta
         * @param {function}    [fn] - `fn(err, meta)`.
         * @returns {void}
         */
        set: function(key, meta, fn) {
            if (typeof fn !== 'function') fn = noop;
            meta = meta || {};
            try {
                stmtUpsert.run(
                    key,
                    (typeof meta.originalName === 'string') ? meta.originalName : null,
                    (typeof meta.contentType === 'string') ? meta.contentType : null,
                    (typeof meta.size === 'number') ? meta.size : null,
                    (typeof meta.createdAt === 'number') ? meta.createdAt : Date.now(),
                    // Buffer IS a Uint8Array, which the driver binds as BLOB;
                    // anything else (incl. a string — utf8 coercion would
                    // corrupt binary payloads) is refused to NULL.
                    ( meta.data instanceof Uint8Array ) ? meta.data : null
                );
                fn(null, meta);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Fetch metadata by `key`.
         *
         * @param {string}   key
         * @param {function} fn - `fn(err, meta|null)`; `null` when the key is unknown.
         * @returns {void}
         */
        get: function(key, fn) {
            if (typeof fn !== 'function') fn = noop;
            var row;
            try {
                row = stmtGet.get(key);
            } catch (err) {
                return fn(err);
            }
            if (!row) return fn(null, null);
            var meta = {
                originalName : row.original_name,
                contentType  : row.content_type,
                size         : row.size,
                createdAt    : row.created_at
            };
            // Present only for inline objects, so a file-backed row keeps its
            // exact pre-tiering shape. The driver hands BLOBs back as
            // Uint8Array; normalise to Buffer (a zero-length BLOB is a real
            // empty payload, distinct from NULL).
            if ( row.data !== null && typeof row.data !== 'undefined' ) {
                meta.data = Buffer.isBuffer(row.data) ? row.data : Buffer.from(row.data);
            }
            // Present only for refcounted (cas) rows — the same pattern as
            // `data` above, so a non-refcounted row keeps its exact shape.
            if ( row.refs !== null && typeof row.refs !== 'undefined' ) {
                meta.refs   = row.refs;
                meta.zeroAt = ( typeof row.zero_at === 'undefined' ) ? null : row.zero_at;
            }
            return fn(null, meta);
        },

        /**
         * Delete metadata by `key`.
         *
         * @param {string}   key
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        remove: function(key, fn) {
            if (typeof fn !== 'function') fn = noop;
            try {
                var res = stmtDel.run(key);
                fn(null, res.changes > 0);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Atomically take one reference on `key` — insert-or-increment.
         *
         * Missing row: inserted with `meta` and `refs` = 1 (`created: true`).
         * Existing refcounted row: `refs` incremented, `zeroAt` cleared (a
         * blob inside the GC grace window is resurrected), and the INCOMING
         * meta is IGNORED — first-write-wins, because identical bytes already
         * have a row and its identity fields stay. The returned `meta` is
         * always the STORED row's (payload excluded — `put()` needs identity
         * and size, not the bytes it just streamed).
         *
         * Atomic in-process: the synchronous driver runs the whole verb in
         * one JS turn, so two overlapping `put()`s of identical content
         * serialize here — one creates, the other increments.
         *
         * @param {string}      key  - The blob key.
         * @param {StorageMeta} meta - Metadata for the CREATE case (may carry `data` for
         *                             an inline-tiered blob).
         * @param {function}    [fn] - `fn(err, {created: boolean, refs: number, meta: StorageMeta})`.
         * @returns {void}
         */
        acquireRef: function(key, meta, fn) {
            if (typeof fn !== 'function') fn = noop;
            meta = meta || {};
            try {
                var r = stmtIncr.run(key);
                if ( r.changes === 1 ) {
                    var row = stmtRefs.get(key);
                    return fn(null, {
                        created : false,
                        refs    : row.refs,
                        meta    : {
                            originalName : row.original_name,
                            contentType  : row.content_type,
                            size         : row.size,
                            createdAt    : row.created_at,
                            refs         : row.refs
                        }
                    });
                }
                stmtInsRef.run(
                    key,
                    (typeof meta.originalName === 'string') ? meta.originalName : null,
                    (typeof meta.contentType === 'string') ? meta.contentType : null,
                    (typeof meta.size === 'number') ? meta.size : null,
                    (typeof meta.createdAt === 'number') ? meta.createdAt : Date.now(),
                    // same binary-safety rule as set(): a Buffer IS a
                    // Uint8Array and binds as BLOB; anything else is refused
                    // to NULL rather than utf8-coerced.
                    ( meta.data instanceof Uint8Array ) ? meta.data : null
                );
                fn(null, { created: true, refs: 1, meta: meta });
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Atomically drop one reference on `key`.
         *
         * Floors at 0 and stamps `zeroAt` at the 1 → 0 transition — the
         * timestamp the GC grace window reads. A missing, non-refcounted, or
         * already-zero row answers `{existed: false}`: the reference the
         * caller wanted to drop was already gone, which is the outcome they
         * asked for (the idempotency shape `release()` has always had).
         *
         * @param {string}   key  - The blob key.
         * @param {function} [fn] - `fn(err, {existed: boolean, refs: number})` — `refs` is the
         *                          count AFTER the decrement.
         * @returns {void}
         */
        releaseRef: function(key, fn) {
            if (typeof fn !== 'function') fn = noop;
            try {
                var row = stmtRefs.get(key);
                if ( !row || typeof row.refs !== 'number' || row.refs < 1 ) {
                    return fn(null, { existed: false, refs: ( row && typeof row.refs === 'number' ) ? row.refs : 0 });
                }
                var next = row.refs - 1;
                // zero_at is non-null exactly when refs === 0 (the invariant
                // the typedef states) — writing null on a >0 decrement keeps
                // it without a second statement.
                stmtDecr.run(next, ( next === 0 ) ? Date.now() : null, key);
                fn(null, { existed: true, refs: next });
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Keys whose refcount has sat at 0 since before `olderThanMs` —
         * oldest first, at most `limit`. Non-refcounted rows have NULL
         * `refs`, which `refs = 0` never matches, so they are structurally
         * invisible here (measured, with a NULL-row control).
         *
         * @param {number}   olderThanMs - Epoch ms cutoff (typically now − grace).
         * @param {number}   limit       - Batch cap.
         * @param {function} fn          - `fn(err, string[])`.
         * @returns {void}
         */
        listZeroRefs: function(olderThanMs, limit, fn) {
            if (typeof fn !== 'function') fn = noop;
            try {
                var rows = stmtZero.all(olderThanMs, limit);
                var keys = [];
                for (var i = 0; i < rows.length; i++) { keys.push(rows[i].key); }
                fn(null, keys);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Delete the row ONLY IF its refcount is still 0 — the sweep's claim
         * step. A concurrent `acquireRef` resurrection wins: it clears the
         * zero state before this runs, the guarded DELETE matches nothing,
         * and the sweep skips the blob.
         *
         * @param {string}   key  - The blob key.
         * @param {function} [fn] - `fn(err, removed: boolean)`.
         * @returns {void}
         */
        removeIfZero: function(key, fn) {
            if (typeof fn !== 'function') fn = noop;
            try {
                var res = stmtRmZ.run(key);
                fn(null, res.changes > 0);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Aggregate counts over the object rows — the `storage:stats`
         * operator surface. One SELECT; reserved dot-key rows (the `.driver`
         * stamp) are excluded, so an empty root reports zero objects.
         *
         * @param {function} fn - `fn(err, {objects, refcounted, zeroRefPending, inline, bytes})`.
         * @returns {void}
         */
        stats: function(fn) {
            if (typeof fn !== 'function') fn = noop;
            var row;
            try {
                row = stmtStats.get();
            } catch (err) {
                return fn(err);
            }
            fn(null, {
                objects        : row.objects,
                refcounted     : row.refcounted,
                zeroRefPending : row.zeroRefPending,
                inline         : row.inline,
                bytes          : row.bytes
            });
        },

        /**
         * Page over object keys, ordered by key — the enumeration
         * `storage:verify` walks for its rows-without-files direction.
         * Keys strictly AFTER `afterKey` (pass `''` to start); reserved
         * dot-key rows are excluded. Ordering by the PRIMARY KEY makes the
         * cursor stable under concurrent inserts/deletes: a page never
         * re-shuffles, it only ever misses rows created behind the cursor —
         * which the caller's age gate tolerates by construction.
         *
         * @param {string}   afterKey - Exclusive lower bound (`''` for the first page).
         * @param {number}   limit    - Page size cap.
         * @param {function} fn       - `fn(err, string[])`.
         * @returns {void}
         */
        listKeys: function(afterKey, limit, fn) {
            if (typeof fn !== 'function') fn = noop;
            try {
                var rows = stmtKeys.all(( typeof afterKey === 'string' ) ? afterKey : '', limit);
                var keys = [];
                for (var i = 0; i < rows.length; i++) { keys.push(rows[i].key); }
                fn(null, keys);
            } catch (err) {
                fn(err);
            }
        },

        /**
         * Release the underlying file handle.
         *
         * @returns {void}
         */
        close: function() {
            try { db.close(); } catch (e) { /* already closed */ }
        }
    };
};
