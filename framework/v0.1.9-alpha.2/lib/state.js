/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

'use strict';

/**
 * @module gina/lib/state
 */

var fs       = require('fs');
var nodePath = require('path');

/**
 * SQLite-backed key-value store for the five `~/.gina/` state files.
 *
 * Replaces:
 *  - `~/.gina/main.json`
 *  - `~/.gina/projects.json`
 *  - `~/.gina/ports.json`
 *  - `~/.gina/ports.reverse.json`
 *  - `~/.gina/{shortVersion}/settings.json`
 *
 * with a single `~/.gina/gina.db` SQLite database, giving:
 *  - Atomic multi-key writes (DatabaseSync transactions)
 *  - Concurrent write safety (SQLite serialises access)
 *  - Simpler container volume mapping (one file instead of five)
 *
 * JSON sidecar files are written alongside every SQLite write so that
 * all existing read paths — `require()`, `requireJSON()`, `fs.readFileSync()` —
 * continue to work without modification. SQLite is the canonical store;
 * the JSON files are derived from it on every write.
 *
 * **Requires Node >= 22.5.0** (`node:sqlite` / `DatabaseSync`).
 * Falls back to a no-op when the module is unavailable so callers
 * revert to the legacy JSON path automatically.
 *
 * Usage:
 * ```javascript
 * var StateStore = require('./state');
 * var store = StateStore.getInstance();
 * store.write('/home/user/.gina/projects.json', { myproject: { path: '...' } });
 * var data = store.read('/home/user/.gina/projects.json'); // { myproject: ... }
 * ```
 *
 * @class StateStore
 * @constructor
 */
function StateStore() {

    var self = this;

    /** @private {object|null} Open DatabaseSync instance */
    var _db = null;

    /**
     * Map from path suffix (relative to homeDir) → SQLite key.
     * Settings uses a dynamic pattern handled separately.
     * @private
     */
    var _PATH_KEYS = {
        'main.json'         : 'main',
        'projects.json'     : 'projects',
        'ports.json'        : 'ports',
        'ports.reverse.json': 'ports_reverse'
    };

    // ─── Private helpers ────────────────────────────────────────────────────

    /**
     * Return the Gina home directory from the `GINA_HOMEDIR` env variable.
     * Returns null when not yet set (early bootstrap, tests).
     *
     * @returns {string|null}
     */
    var _homeDir = function() {
        if (typeof(getEnvVar) === 'function') {
            return getEnvVar('GINA_HOMEDIR') || null;
        }
        return null;
    };

    /**
     * Open (or reuse) the SQLite connection and ensure the schema exists.
     *
     * Falls back to null when `node:sqlite` is unavailable (Node < 22.5.0)
     * or when `GINA_HOMEDIR` is not yet set.
     *
     * @returns {object|null} DatabaseSync instance or null
     */
    var _open = function() {
        if (_db) return _db;

        var homeDir = _homeDir();
        if (!homeDir) return null;

        var DatabaseSync;
        try {
            DatabaseSync = require('node:sqlite').DatabaseSync;
        } catch(e) {
            return null; // Node < 22.5.0 — fall through to JSON path
        }

        var dbPath = nodePath.join(homeDir, 'gina.db');
        _db = new DatabaseSync(dbPath);
        _db.exec(
            'CREATE TABLE IF NOT EXISTS kv_store (' +
            '  key        TEXT PRIMARY KEY,' +
            '  value      TEXT NOT NULL,' +
            '  updated_at INTEGER NOT NULL' +
            ')'
        );
        return _db;
    };

    /**
     * Convert an absolute file path to a SQLite key.
     * Returns null when the path is not a managed state file.
     *
     * Handled patterns:
     *  - `{homeDir}/main.json`            → `main`
     *  - `{homeDir}/projects.json`        → `projects`
     *  - `{homeDir}/ports.json`           → `ports`
     *  - `{homeDir}/ports.reverse.json`   → `ports_reverse`
     *  - `{homeDir}/{M.N}/settings.json`  → `settings/{M.N}` (e.g. `settings/0.1`)
     *
     * @param {string} filePath - Absolute path to a candidate state file
     * @returns {string|null}
     */
    var _pathToKey = function(filePath) {
        var homeDir = _homeDir();
        if (!homeDir) return null;

        var sep        = nodePath.sep;
        var normalPath = nodePath.normalize(filePath);
        var normalHome = nodePath.normalize(homeDir);

        if (normalPath.indexOf(normalHome + sep) !== 0) return null;

        // Relative path inside homeDir, e.g. "main.json" or "0.1/settings.json"
        var relative = normalPath.slice(normalHome.length + 1);

        // Fixed-name root files
        if (_PATH_KEYS[relative]) return _PATH_KEYS[relative];

        // {shortVersion}/settings.json  →  settings/{shortVersion}
        // Matches "0.1/settings.json", "1.0/settings.json", etc.
        if (/^[0-9]+\.[0-9]+[\/\\]settings\.json$/.test(relative)) {
            return 'settings/' + relative.split(/[\/\\]/)[0];
        }

        return null;
    };

    // ─── Public API ─────────────────────────────────────────────────────────

    /**
     * Returns `true` when `filePath` is a state file managed by this store.
     *
     * Safe to call at any time — returns `false` gracefully when
     * `GINA_HOMEDIR` is not yet set or when the path does not match.
     *
     * @param {string} filePath - Absolute path to test
     * @returns {boolean}
     */
    this.isStatePath = function(filePath) {
        return _pathToKey(filePath) !== null;
    };

    /**
     * Atomically write a state object to SQLite, then sync the JSON sidecar.
     *
     * The sidecar write keeps every legacy read path (`require()`,
     * `requireJSON()`, `fs.readFileSync()`) working without modification.
     * SQLite is canonical; the JSON file is derived from it.
     *
     * Returns `false` when the store is unavailable (Node < 22.5.0 or
     * `GINA_HOMEDIR` not yet set); the caller should fall through to a
     * direct `fs.writeFileSync` in that case.
     *
     * @param {string}         filePath - Absolute path to the target state file
     * @param {object|string}  data     - Data to persist (object or JSON string)
     * @returns {boolean} `true` on success, `false` when store is unavailable
     */
    this.write = function(filePath, data) {
        var key = _pathToKey(filePath);
        if (!key) return false;

        var db = _open();
        if (!db) return false;

        var value = (typeof data === 'object') ? JSON.stringify(data, null, 4) : data;

        db.prepare(
            'INSERT OR REPLACE INTO kv_store (key, value, updated_at) VALUES (?, ?, ?)'
        ).run(key, value, Date.now());

        // Write JSON sidecar — derived from SQLite, needed by all read call sites
        fs.writeFileSync(filePath, value);
        try { fs.chmodSync(filePath, 0o755); } catch(chmodErr) {}

        return true;
    };

    /**
     * Read a state object from SQLite.
     *
     * Returns `null` when the store is unavailable or the key is not found;
     * the caller should fall through to `fs.readFileSync` in that case.
     *
     * @param {string} filePath - Absolute path to the state file
     * @returns {object|null}
     */
    this.read = function(filePath) {
        var key = _pathToKey(filePath);
        if (!key) return null;

        var db = _open();
        if (!db) return null;

        var row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
    };

    /**
     * Close the SQLite connection and reset the internal state.
     * Intended for use in tests; not needed in normal operation.
     */
    this.close = function() {
        if (_db) {
            try { _db.close(); } catch(e) {}
            _db = null;
        }
    };
}

// ─── Singleton ───────────────────────────────────────────────────────────────

/** @type {StateStore|null} */
StateStore._instance = null;

/**
 * Return the shared `StateStore` instance, creating it on first call.
 *
 * @returns {StateStore}
 */
StateStore.getInstance = function() {
    if (!StateStore._instance) {
        StateStore._instance = new StateStore();
    }
    return StateStore._instance;
};

module.exports = StateStore;
