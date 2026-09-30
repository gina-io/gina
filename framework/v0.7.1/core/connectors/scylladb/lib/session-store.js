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
 * Return the `ScylladbStore` class extending `express-session`'s Store.
 *
 * Connection settings are read from the bundle's `config/connectors.json`
 * at factory-call time. Per-instance options passed to `new ScylladbStore()`
 * are merged on top and take precedence.
 *
 * Requires `cassandra-driver` to be installed in the consumer project:
 *   `npm install cassandra-driver`
 *
 * Requires the sessions table to exist in the keyspace before the store
 * is used. Recommended schema:
 *
 * ```cql
 * CREATE TABLE IF NOT EXISTS sessions (
 *     sid  TEXT PRIMARY KEY,
 *     sess TEXT
 * ) WITH default_time_to_live = 86400;
 * ```
 *
 * Per-row TTL set via `USING TTL` in `set()` / `touch()` overrides the
 * table-level default. `destroy()` issues an explicit DELETE rather than
 * waiting for TTL to expire.
 *
 * @param {object} session - The `express-session` module (must have `.Store` on it).
 *                           `session.name` is express-session's read-only function name —
 *                           the literal `'session'` — so the bundle's connectors.json must
 *                           declare its store entry under the key `"session"` (#B206).
 * @param {string} bundle  - Bundle name — used to look up `getConfig()[bundle][env]`.
 * @returns {function}     - ScylladbStore constructor.
 */
module.exports = function(session, bundle) {

    /**
     * Base Store class from express-session.
     * @type {function}
     */
    var Store = session.Store;

    var env      = getContext().env;
    var conf     = getConfig()[bundle][env];
    var connName = session.name;
    var connConf = (conf && conf.content && conf.content.connectors && conf.content.connectors[connName]) || {};

    /**
     * Resolve cassandra-driver from the project's node_modules so the
     * framework has zero hard dependency on it.
     *
     * @inner
     * @returns {object} cassandra-driver module
     * @throws {Error} when cassandra-driver is not installed
     */
    var loadDriver = function() {
        try {
            var driverPath = _(getPath('project') + '/node_modules/cassandra-driver', true);
            return require(driverPath);
        } catch(e) {
            throw new Error(
                '[ScylladbStore] cassandra-driver is not installed. '
                + 'Run `npm install cassandra-driver` in your project.\n'
                + e.message
            );
        }
    };

    /**
     * Resolve cluster contact points from connectors.json + per-instance options.
     * Accepts an array of `host:port` strings, a comma-separated string, or a
     * single host+port pair.
     *
     * @inner
     * @param {object} options
     * @returns {string[]}
     */
    var resolveContactPoints = function(options) {
        var configured = options.contactPoints || connConf.contactPoints;
        if (Array.isArray(configured)) return configured.slice();
        if (typeof configured === 'string') return configured.split(/\s*,\s*/);
        var host = options.host || connConf.host;
        var port = options.port || connConf.port || 9042;
        if (host) return [ host + ':' + port ];
        return [ '127.0.0.1:9042' ];
    };

    /**
     * Resolve credentials from connectors.json + per-instance options.
     *
     * @inner
     * @param {object} options
     * @returns {{username: string, password: string}|null}
     */
    var resolveCredentials = function(options) {
        var src = options.credentials || connConf.credentials;
        if (src && src.username) return src;
        var u = options.username || connConf.username;
        if (u) return { username: u, password: options.password || connConf.password || '' };
        return null;
    };

    /**
     * Initialize ScylladbStore with the given options.
     *
     * @constructor
     * @param {object}   [options]                 - Instance-level overrides.
     * @param {string[]} [options.contactPoints]   - Cluster contact points.
     * @param {string}   [options.localDataCenter] - Data center name (default: connectors.json → 'datacenter1').
     * @param {string}   [options.keyspace]        - CQL keyspace (default: connectors.json → keyspace OR database).
     * @param {object}   [options.credentials]     - { username, password }.
     * @param {object}   [options.ssl]             - sslOptions passthrough.
     * @param {string}   [options.table]           - Sessions table name (default: connectors.json → 'sessions').
     * @param {number}   [options.ttl]             - Default TTL seconds (default: connectors.json ttl;
     *                                              unset → cookie maxAge drives expiry, else 86400).
     *                                              Must be > 0 when set — non-positive refuses (#B207).
     */
    function ScylladbStore(options) {
        options = options || {};
        Store.call(this, options);

        this.table = (options.table != null) ? options.table : (connConf.table || 'sessions');
        // #B207 — a non-positive ttl is refused at construction: `ttl: 0` used
        // to collapse to the maxAge fallback through double truthiness (options
        // preserve + `this.ttl ||` at every use site), silently meaning "unset",
        // while a RESOLVED ttl <= 0 reached backend-specific semantics. A ttl
        // is a positive number of seconds, or unset.
        if (options.ttl != null && !(options.ttl > 0)) {
            throw new Error('[' + bundle + '][ScylladbStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(options.ttl) + ' (store options). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        if (connConf.ttl != null && !(connConf.ttl > 0)) {
            throw new Error('[' + bundle + '][ScylladbStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(connConf.ttl) + ' (connectors.json session entry). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        // #B163 — was `connConf.ttl || oneDay`: the implicit one-day default made the
        // cookie-maxAge fallback in set()/touch() unreachable; unset now stays null (couchbase parity).
        this.ttl   = (options.ttl   != null) ? options.ttl   : (connConf.ttl   || null);

        var cassandra = loadDriver();

        var clientConf = {
            contactPoints  : resolveContactPoints(options),
            localDataCenter: options.localDataCenter || connConf.localDataCenter || 'datacenter1',
            keyspace       : options.keyspace        || connConf.keyspace        || connConf.database
        };
        var credentials = resolveCredentials(options);
        if (credentials) {
            clientConf.authProvider = new cassandra.auth.PlainTextAuthProvider(
                credentials.username, credentials.password || ''
            );
        }
        var ssl = options.ssl || connConf.ssl;
        if (ssl) clientConf.sslOptions = ssl;

        this.client = new cassandra.Client(clientConf);

        var store = this;
        this.client.connect().then(function() {
            console.debug('[ScylladbStore] connected (bundle: ' + bundle + ', connector: ' + connName + ')');
            store.emit('connect');
        }).catch(function(err) {
            console.error('[ScylladbStore] ' + (err.message || err));
            store.emit('disconnect');
        });

        this.client.on('log', function(level, className, message) {
            if (level === 'error') {
                console.error('[ScylladbStore] ' + className + ': ' + message);
            }
        });
    }

    ScylladbStore.prototype.__proto__ = Store.prototype;

    /**
     * Fetch session by the given `sid`.
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err, session)`.
     */
    ScylladbStore.prototype.get = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#get', fn, console);
        var query = 'SELECT sess FROM ' + this.table + ' WHERE sid = ?';
        console.debug('[ScylladbStore] GET ' + sid);

        this.client.execute(query, [sid], { prepare: true }).then(function(result) {
            var rows = result.rows || [];
            if (rows.length === 0) return fn(null, null);
            try {
                fn(null, JSON.parse(rows[0].sess));
            } catch(parseErr) {
                var sessErr = new Error('[' + bundle + '][ScylladbStore] Could not parse session "' + sid + '"\n' + parseErr.stack);
                console.error(sessErr);
                fn(sessErr);
            }
        }).catch(function(err) {
            fn(err);
        });
    };

    /**
     * Commit the given `sess` object associated with `sid`.
     * Issues `INSERT … USING TTL <ttl>` for atomic write + expiry.
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data.
     * @param {function} fn   - Callback `fn(err)`.
     */
    ScylladbStore.prototype.set = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#set', fn, console);
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);

        // #B207 — a resolved ttl <= 0 must never reach CQL: `USING TTL 0`
        // stores the row WITHOUT expiry (immortal), and a negative TTL is a
        // server error. No-op — the existing record dies on its original
        // schedule (mirrors the #B166 touch() guard).
        if (ttl <= 0) {
            return fn(null);
        }

        if (ttl > 0) {
            sess.lastModified = new Date().toISOString();
        }

        var data;
        try {
            data = JSON.stringify(sess);
        } catch(err) {
            return fn(err);
        }

        console.debug('[ScylladbStore] SET ' + sid + ' ttl:' + ttl);
        var query = 'INSERT INTO ' + this.table + ' (sid, sess) VALUES (?, ?) USING TTL ?';

        this.client.execute(query, [sid, data, ~~ttl], { prepare: true })
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Refresh the TTL for an existing session. CQL has no equivalent to
     * Redis EXPIRE — extending TTL requires a write. We use UPDATE … USING
     * TTL <ttl> SET sess = ? to keep the data fresh in the same call.
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data (re-written with the new TTL).
     * @param {function} fn   - Callback `fn(err)`.
     */
    ScylladbStore.prototype.touch = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#touch', fn, console);
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);
        if (ttl <= 0) return fn(null);

        var data;
        try {
            data = JSON.stringify(sess);
        } catch(err) {
            return fn(err);
        }

        var query = 'UPDATE ' + this.table + ' USING TTL ? SET sess = ? WHERE sid = ?';
        this.client.execute(query, [~~ttl, data, sid], { prepare: true })
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Destroy the session associated with `sid`.
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err)`.
     */
    ScylladbStore.prototype.destroy = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#destroy', fn, console);
        var query = 'DELETE FROM ' + this.table + ' WHERE sid = ?';
        this.client.execute(query, [sid], { prepare: true })
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Count the number of stored sessions. CQL `COUNT(*)` is a full-table
     * scan — expensive on large tables and may time out. Provided for
     * express-session API completeness; avoid in hot paths.
     *
     * @param {function} fn - Callback `fn(err, count)`.
     */
    ScylladbStore.prototype.length = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#length', fn, console);
        var query = 'SELECT COUNT(*) AS n FROM ' + this.table;
        this.client.execute(query, [], { prepare: true }).then(function(result) {
            var rows = result.rows || [];
            if (rows.length === 0) return fn(null, 0);
            var v = rows[0].n;
            fn(null, (v && typeof v.toNumber === 'function') ? v.toNumber() : Number(v));
        }).catch(function(err) {
            fn(err);
        });
    };

    /**
     * Truncate the sessions table. CQL `TRUNCATE` is a heavy cluster
     * operation — drops all data and waits for consensus across replicas.
     * Provided for express-session API completeness.
     *
     * @param {function} fn - Callback `fn(err)`.
     */
    ScylladbStore.prototype.clear = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#clear', fn, console);
        var query = 'TRUNCATE ' + this.table;
        this.client.execute(query, [], { prepare: false })
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Fetch every session. Full-table scan — expensive on large tables.
     *
     * @param {function} fn - Callback `fn(err, sessions)` where sessions is
     *                        a hash keyed by sid.
     */
    ScylladbStore.prototype.all = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('scylladb:session#all', fn, console);
        var query = 'SELECT sid, sess FROM ' + this.table;
        this.client.execute(query, [], { prepare: true }).then(function(result) {
            var out = {};
            var rows = result.rows || [];
            for (var i = 0; i < rows.length; i++) {
                try { out[rows[i].sid] = JSON.parse(rows[i].sess); }
                catch (_e) { /* skip malformed rows */ }
            }
            fn(null, out);
        }).catch(function(err) {
            fn(err);
        });
    };

    return ScylladbStore;
};
