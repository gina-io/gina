/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var gina    = require('../../../../core/gna');
var lib     = gina.lib;
var console = lib.logger;
// #B432 — express-session must see exactly one callback. Each method below
// wraps `fn` at entry, so a callback that THROWS can no longer be re-invoked
// by that method's own error path (see core/connectors/settle-once.js).
var settleOnce = require('./../../settle-once');

/**
 * One day in seconds — default TTL when cookie.maxAge is absent.
 * @type {number}
 */
var oneDay = 86400;

/**
 * No-op callback placeholder.
 * @type {function}
 */
var noop = function() {};

/**
 * Return the `SqliteStore` class extending `express-session`'s Store.
 *
 * Backed by `node:sqlite` (Node.js built-in, available since 22.5.0 — zero npm deps).
 * On Node < 22.5.0 an informative error is thrown at instantiation time.
 *
 * The store creates a `sessions` table automatically on first use.
 * WAL journal mode is enabled so concurrent readers never block the writer.
 * Expired sessions are purged in the background every `cleanupInterval` seconds
 * (default 900 s / 15 min); set to 0 to disable.
 *
 * Connection settings are read from the bundle's `config/connectors.json`
 * at factory-call time. Per-instance options passed to `new SqliteStore()`
 * are merged on top and take precedence.
 *
 * Good fit for: development, staging, single-pod production.
 * For multi-pod horizontal scaling use the Redis connector instead.
 *
 * @param {object} session       - The `express-session` module (must have `.Store` on it).
 *                                 `session.name` is express-session's read-only function
 *                                 name — the literal `'session'` — so the bundle's
 *                                 connectors.json must declare its store entry under the
 *                                 key `"session"` (#B206).
 * @param {string} bundle        - Bundle name — used to look up `getConfig()[bundle][env]`.
 * @returns {function}           - SqliteStore constructor.
 */
module.exports = function(session, bundle) {

    /**
     * Base Store class from express-session.
     * @type {function}
     */
    var Store = session.Store;

    // Read connector config from connectors.json at factory-call time.
    var env      = getContext().env;
    var conf     = getConfig()[bundle][env];
    var connName = session.name;
    var connConf = (conf && conf.content && conf.content.connectors && conf.content.connectors[connName]) || {};

    /**
     * Initialize SqliteStore with the given options.
     *
     * @constructor
     * @param {object}  [options]                   - Instance-level overrides.
     * @param {string}  [options.database]           - Path to the SQLite file, or `':memory:'`
     *                                                 for a volatile in-process store.
     *                                                 Defaults to connectors.json `database`, then
     *                                                 `~/.gina/{version}/sessions-{bundle}.db`.
     * @param {string}  [options.prefix]             - Session key prefix (default: `'sess:'`).
     * @param {number}  [options.ttl]                - Session TTL in seconds (default: connectors.json ttl;
     *                                                 unset → cookie maxAge drives expiry, else 86400).
     *                                                 Must be > 0 when set — non-positive refuses (#B207).
     * @param {number}  [options.cleanupInterval]    - Expired-session purge interval in seconds.
     *                                                 Set to 0 to disable. (default: 900).
     */
    function SqliteStore(options) {
        var self = this;
        options  = options || {};
        Store.call(this, options);

        this.prefix          = (options.prefix          != null) ? options.prefix          : (connConf.prefix          || 'sess:');
        // #B207 — a non-positive ttl is refused at construction: `ttl: 0` used
        // to collapse to the maxAge fallback through double truthiness (options
        // preserve + `this.ttl ||` at every use site), silently meaning "unset",
        // while a RESOLVED ttl <= 0 reached backend-specific semantics. A ttl
        // is a positive number of seconds, or unset.
        if (options.ttl != null && !(options.ttl > 0)) {
            throw new Error('[' + bundle + '][SqliteStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(options.ttl) + ' (store options). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        if (connConf.ttl != null && !(connConf.ttl > 0)) {
            throw new Error('[' + bundle + '][SqliteStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(connConf.ttl) + ' (connectors.json session entry). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        // #B163 — was `connConf.ttl || oneDay`: the implicit one-day default made the
        // cookie-maxAge fallback in set()/touch() unreachable; unset now stays null (couchbase parity).
        this.ttl             = (options.ttl             != null) ? options.ttl             : (connConf.ttl             || null);
        this.cleanupInterval = (options.cleanupInterval != null) ? options.cleanupInterval : (connConf.cleanupInterval || 900);

        // Resolve DB path: option > connectors.json > default per-bundle file
        var defaultDbPath = _(getPath('gina').home + '/sessions-' + bundle + '.db', true);
        var dbPath = options.database || connConf.database || defaultDbPath;

        // Resolve the SQLite driver through the shared seam — node:sqlite on
        // Node (built-in since 22.5.0, zero npm deps), bun:sqlite behind an
        // adapter on Bun. See lib/sqlite-driver.js.
        var DatabaseSync;
        try {
            DatabaseSync = require('./../../../../lib/sqlite-driver').getDatabaseSync();
        } catch(e) {
            throw new Error('[SqliteStore] ' + e.message);
        }

        this.db = new DatabaseSync(dbPath);

        // WAL mode: concurrent readers never block the writer (important under HTTP load).
        // synchronous=NORMAL: safe with WAL — a crash can lose the last committed transaction
        // but never corrupts the database. Full fsync ('FULL') is not needed for session data.
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec('PRAGMA synchronous=NORMAL');

        // Schema bootstrap — idempotent.
        this.db.exec(
            'CREATE TABLE IF NOT EXISTS sessions ('
            + '  sid     TEXT    PRIMARY KEY,'
            + '  data    TEXT    NOT NULL,'
            + '  expires INTEGER NOT NULL'
            + ')'
        );
        this.db.exec('CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires)');

        // Prepare reusable statements once — avoids re-parsing SQL on every request.
        this._stmtGet     = this.db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
        this._stmtUpsert  = this.db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)');
        this._stmtDel     = this.db.prepare('DELETE FROM sessions WHERE sid = ?');
        this._stmtTouch   = this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
        this._stmtCleanup = this.db.prepare('DELETE FROM sessions WHERE expires <= ?');

        // Background cleanup of expired sessions.
        if (this.cleanupInterval > 0) {
            this._cleanupTimer = setInterval(function() {
                self._cleanup();
            }, this.cleanupInterval * 1000);
            // unref() so this timer does not prevent the process from exiting cleanly.
            if (this._cleanupTimer.unref) this._cleanupTimer.unref();
        }

        console.debug('[SqliteStore] opened (bundle: ' + bundle + ', connector: ' + connName + ', db: ' + dbPath + ')');
        this.emit('connect');
    }

    /**
     * Inherit from express-session Store.
     */
    SqliteStore.prototype.__proto__ = Store.prototype;

    /**
     * Remove all expired sessions from the database.
     * Called automatically every `cleanupInterval` seconds.
     * @inner
     */
    SqliteStore.prototype._cleanup = function() {
        var now = Math.floor(Date.now() / 1000);
        try {
            var result = this._stmtCleanup.run(now);
            if (result.changes > 0) {
                console.debug('[SqliteStore] purged ' + result.changes + ' expired session(s)');
            }
        } catch(err) {
            console.error('[SqliteStore] cleanup error: ' + (err.message || err));
        }
    };

    /**
     * Fetch session by the given `sid`.
     * Returns nothing (calls `fn()`) when the session does not exist or has expired.
     *
     * @param {string}   sid - Session ID (without prefix).
     * @param {function} fn  - Callback `fn(err, session)`.
     */
    SqliteStore.prototype.get = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('sqlite:session#get', fn, console);
        var key = this.prefix + sid;
        var now = Math.floor(Date.now() / 1000);
        console.debug('[SqliteStore] GET "' + key + '"');
        try {
            var row = this._stmtGet.get(key, now);
            if (!row) return fn();
            try {
                return fn(null, JSON.parse(row.data));
            } catch(parseErr) {
                var sessErr = new Error('[' + bundle + '][SqliteStore] Could not parse session "' + key + '"\n' + parseErr.stack);
                console.error(sessErr);
                return fn(sessErr);
            }
        } catch(err) {
            return fn(err);
        }
    };

    /**
     * Commit the given `sess` object associated with `sid`.
     * Upserts the row and sets the expiry timestamp.
     *
     * @param {string}   sid  - Session ID (without prefix).
     * @param {object}   sess - Session data.
     * @param {function} fn   - Callback `fn(err)`.
     */
    SqliteStore.prototype.set = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('sqlite:session#set', fn, console);
        var key    = this.prefix + sid;
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);

        // #B207 — a resolved ttl <= 0 means the session is already at/past its
        // expiry: writing an immediately-dead row is pointless. No-op for
        // parity with the sibling stores (mirrors the #B166 touch() guard).
        if (ttl <= 0) {
            return fn(null);
        }

        var expires = Math.floor(Date.now() / 1000) + ~~ttl;

        if (ttl > 0) {
            sess.lastModified = new Date().toISOString();
        }

        var data;
        try {
            data = JSON.stringify(sess);
        } catch(err) {
            return fn(err);
        }

        console.debug('[SqliteStore] SET "' + key + '" expires:' + expires);
        try {
            this._stmtUpsert.run(key, data, expires);
            fn();
        } catch(err) {
            fn(err);
        }
    };

    /**
     * Destroy the session associated with `sid`.
     *
     * @param {string}   sid - Session ID (without prefix).
     * @param {function} fn  - Callback `fn(err)`.
     */
    SqliteStore.prototype.destroy = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('sqlite:session#destroy', fn, console);
        try {
            this._stmtDel.run(this.prefix + sid);
            fn();
        } catch(err) {
            fn(err);
        }
    };

    /**
     * Refresh the expiry timestamp for an existing session without modifying its data.
     *
     * A non-positive resolved ttl is a no-op: express-session's `cookie.maxAge`
     * is a decaying remainder, so it truncates to zero in the session's final
     * second and turns negative once expired. Stamping `now + ttl` from such a
     * value would write an already-past expiry — expiring the very session the
     * caller asked to refresh (#B166). Matches the mongodb / scylladb guard,
     * and redis's inverted `if (ttl > 0)` spelling.
     *
     * @param {string}   sid  - Session ID (without prefix).
     * @param {object}   sess - Session data (used to read `cookie.maxAge`).
     * @param {function} fn   - Callback `fn(err)`. Invoked with `null` and no
     *                          write performed when the resolved ttl is <= 0.
     */
    SqliteStore.prototype.touch = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('sqlite:session#touch', fn, console);
        var maxAge  = sess.cookie && sess.cookie.maxAge;
        var ttl     = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);
        // #B166 — never stamp a past expiry; siblings guard identically.
        if (ttl <= 0) return fn(null);

        var expires = Math.floor(Date.now() / 1000) + ~~ttl;
        try {
            this._stmtTouch.run(expires, this.prefix + sid);
            fn();
        } catch(err) {
            fn(err);
        }
    };

    return SqliteStore;
};
