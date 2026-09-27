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
 * Return the `MongodbStore` class extending `express-session`'s Store.
 *
 * Connection settings are read from the bundle's `config/connectors.json`
 * at factory-call time. Per-instance options passed to `new MongodbStore()`
 * are merged on top and take precedence.
 *
 * Requires `mongodb` to be installed in the consumer project:
 *   `npm install mongodb`
 *
 * The TTL index is created lazily on the first `set()` call (idempotent;
 * cached behind a one-shot `_ttlReady` guard). Storing each session as
 * `{_id: sid, sess: <JSON string>, expiresAt: Date}` lets MongoDB's TTL
 * monitor reap expired documents server-side.
 *
 * **Note on TTL monitor lag.** MongoDB's TTL monitor runs on a 60-second
 * interval, so `get()` and `length()` filter on `{expiresAt: {$gt: now}}`
 * to exclude documents that have expired but not yet been reaped. This is
 * a substantive divergence from the ScyllaDB store (where CQL `USING TTL`
 * reaps rows server-side and "expired" rows literally do not exist) — the
 * intent (return active sessions only) is the same.
 *
 * @param {object} session - The `express-session` module (must have `.Store` on it).
 *                           `session.name` is express-session's read-only function name —
 *                           the literal `'session'` — so the bundle's connectors.json must
 *                           declare its store entry under the key `"session"` (#B206).
 * @param {string} bundle  - Bundle name — used to look up `getConfig()[bundle][env]`.
 * @returns {function}     - MongodbStore constructor.
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
     * Resolve mongodb from the project's node_modules so the framework
     * has zero hard dependency on it.
     *
     * @inner
     * @returns {object} mongodb module
     * @throws {Error} when mongodb is not installed
     */
    var loadDriver = function() {
        try {
            var driverPath = _(getPath('project') + '/node_modules/mongodb', true);
            return require(driverPath);
        } catch(e) {
            throw new Error(
                '[MongodbStore] mongodb is not installed. '
                + 'Run `npm install mongodb` in your project.\n'
                + e.message
            );
        }
    };

    /**
     * Compose the MongoDB connection URI from connectors.json + per-instance
     * options. Accepts either `uri` (preferred) or decomposed
     * host/port/username/password + authSource + replicaSet fields.
     * Mirrors `core/connectors/mongodb/lib/connector.js`'s URI assembly.
     *
     * @inner
     * @param {object} options
     * @returns {string}
     */
    var resolveUri = function(options) {
        var uri = options.uri || connConf.uri;
        if (uri) return uri;

        var host       = options.host       || connConf.host       || '127.0.0.1';
        var port       = options.port       || connConf.port       || 27017;
        var username   = options.username   || connConf.username;
        var password   = options.password   || connConf.password;
        var dbName     = options.database   || connConf.database;
        var authSource = options.authSource || connConf.authSource;
        var replicaSet = options.replicaSet || connConf.replicaSet;

        var auth = '';
        if (username) {
            auth = encodeURIComponent(username);
            if (password) auth += ':' + encodeURIComponent(password);
            auth += '@';
        }
        var u  = 'mongodb://' + auth + host + ':' + port + '/' + encodeURIComponent(dbName || '');
        var qs = [];
        if (authSource) qs.push('authSource=' + encodeURIComponent(authSource));
        if (replicaSet) qs.push('replicaSet=' + encodeURIComponent(replicaSet));
        if (qs.length) u += '?' + qs.join('&');
        return u;
    };

    /**
     * Initialize MongodbStore with the given options.
     *
     * @constructor
     * @param {object} [options]            - Instance-level overrides.
     * @param {string} [options.uri]        - Full mongodb:// or mongodb+srv:// URI.
     * @param {string} [options.host]       - Single host (used when uri absent).
     * @param {number} [options.port]       - Single port (default 27017).
     * @param {string} [options.username]   - Auth username.
     * @param {string} [options.password]   - Auth password.
     * @param {string} [options.database]   - Database name (required).
     * @param {string} [options.authSource] - Auth db (typically "admin").
     * @param {string} [options.replicaSet] - Replica set name.
     * @param {object|boolean} [options.ssl]- TLS configuration.
     * @param {string} [options.collection] - Sessions collection (default 'sessions').
     * @param {number} [options.ttl]        - Default TTL seconds (default: connectors.json ttl;
     *                                        unset → cookie maxAge drives expiry, else 86400).
     *                                        Must be > 0 when set — non-positive refuses (#B207).
     * @throws {Error} when `database` is missing.
     */
    function MongodbStore(options) {
        options = options || {};
        Store.call(this, options);

        this.collection = (options.collection != null) ? options.collection : (connConf.collection || 'sessions');
        // #B207 — a non-positive ttl is refused at construction: `ttl: 0` used
        // to collapse to the maxAge fallback through double truthiness (options
        // preserve + `this.ttl ||` at every use site), silently meaning "unset",
        // while a RESOLVED ttl <= 0 reached backend-specific semantics. A ttl
        // is a positive number of seconds, or unset.
        if (options.ttl != null && !(options.ttl > 0)) {
            throw new Error('[' + bundle + '][MongodbStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(options.ttl) + ' (store options). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        if (connConf.ttl != null && !(connConf.ttl > 0)) {
            throw new Error('[' + bundle + '][MongodbStore] `ttl` must be a positive number of seconds or unset — got '
                + JSON.stringify(connConf.ttl) + ' (connectors.json session entry). `ttl: 0` is not supported (it previously behaved as unset).');
        }
        // #B163 — was `connConf.ttl || oneDay`: the implicit one-day default made the
        // cookie-maxAge fallback in set()/touch() unreachable; unset now stays null (couchbase parity).
        this.ttl        = (options.ttl        != null) ? options.ttl        : (connConf.ttl        || null);

        this._ttlReady   = false;
        this._ttlPromise = null;

        var mongodb = loadDriver();
        var uri     = resolveUri(options);
        var dbName  = options.database || connConf.database;
        if (!dbName) {
            throw new Error('[MongodbStore] missing required `database` field in connectors.json entry or store options');
        }

        var clientOptions = {};
        var ssl           = options.ssl || connConf.ssl;
        if (ssl === true) {
            clientOptions.tls = true;
        } else if (ssl && typeof ssl === 'object') {
            clientOptions.tls = true;
            for (var k in ssl) {
                if (Object.prototype.hasOwnProperty.call(ssl, k)) {
                    clientOptions[k] = ssl[k];
                }
            }
        }

        this.client = new mongodb.MongoClient(uri, clientOptions);
        this._db    = this.client.db(dbName);
        this._coll  = this._db.collection(this.collection);

        var store = this;
        this.client.connect().then(function() {
            console.debug('[MongodbStore] connected (bundle: ' + bundle + ', connector: ' + connName + ')');
            store.emit('connect');
        }).catch(function(err) {
            console.error('[MongodbStore] ' + (err.message || err));
            store.emit('disconnect');
        });
    }

    MongodbStore.prototype.__proto__ = Store.prototype;

    /**
     * Lazily create the TTL index on `expiresAt` the first time `set()` is
     * called. `createIndex` is idempotent in MongoDB when name + spec match,
     * but we additionally cache `_ttlReady` to avoid the round-trip after
     * first success. Concurrent first-set calls dedupe on `_ttlPromise`.
     *
     * On `IndexOptionsConflict` (existing index with a different
     * `expireAfterSeconds`), warn-and-continue — operator intent wins.
     *
     * @inner
     * @param {function} fn - Callback `fn(err)`.
     */
    MongodbStore.prototype._ensureTTL = function(fn) {
        var store = this;
        if (store._ttlReady) return fn(null);

        if (store._ttlPromise) {
            store._ttlPromise.then(function() { fn(null); }, function(err) { fn(err); });
            return;
        }

        store._ttlPromise = store._coll.createIndex(
            { expiresAt: 1 },
            { expireAfterSeconds: 0, name: 'sessionsExpiresTTL' }
        ).then(function() {
            store._ttlReady = true;
        }).catch(function(err) {
            // IndexOptionsConflict: existing index with different options.
            // Operator intent wins — log a warning and continue.
            if (err && (err.codeName === 'IndexOptionsConflict' || err.code === 85)) {
                console.warn('[MongodbStore] TTL index already exists with different options — ' + err.message);
                store._ttlReady = true;
                return;
            }
            store._ttlPromise = null; // allow retry on next call
            throw err;
        });

        store._ttlPromise.then(function() { fn(null); }, function(err) { fn(err); });
    };

    /**
     * Fetch session by `sid`. Filters on `expiresAt` to skip documents
     * that have expired but not yet been reaped by MongoDB's TTL monitor
     * (which runs on a 60-second interval).
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err, session)`.
     */
    MongodbStore.prototype.get = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#get', fn, console);
        console.debug('[MongodbStore] GET ' + sid);

        this._coll.findOne({ _id: sid, expiresAt: { $gt: new Date() } }).then(function(doc) {
            if (!doc) return fn(null, null);
            try {
                fn(null, JSON.parse(doc.sess));
            } catch(parseErr) {
                var sessErr = new Error('[' + bundle + '][MongodbStore] Could not parse session "' + sid + '"\n' + parseErr.stack);
                console.error(sessErr);
                fn(sessErr);
            }
        }).catch(function(err) {
            fn(err);
        });
    };

    /**
     * Commit `sess` against `sid`. Issues an upsert so existing rows are
     * replaced atomically. Lazily creates the TTL index on the first call
     * (idempotent thereafter).
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data.
     * @param {function} fn   - Callback `fn(err)`.
     */
    MongodbStore.prototype.set = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#set', fn, console);
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);

        // #B207 — a resolved ttl <= 0 means the session is already at/past its
        // expiry: writing an immediately-expired document is pointless. No-op
        // for parity with the sibling stores (mirrors the #B166 touch() guard).
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

        var store     = this;
        var expiresAt = new Date(Date.now() + ~~ttl * 1000);
        console.debug('[MongodbStore] SET ' + sid + ' ttl:' + ttl);

        this._ensureTTL(function(ttlErr) {
            if (ttlErr) return fn && fn(ttlErr);
            store._coll.replaceOne(
                { _id: sid },
                { _id: sid, sess: data, expiresAt: expiresAt },
                { upsert: true }
            ).then(function() { fn && fn(null); })
             .catch(function(err) { fn && fn(err); });
        });
    };

    /**
     * Refresh the TTL for an existing session by updating `expiresAt`
     * and rewriting `sess`. Mirrors the ScyllaDB `touch()` shape (rewrites
     * data alongside the TTL extension).
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data.
     * @param {function} fn   - Callback `fn(err)`.
     */
    MongodbStore.prototype.touch = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#touch', fn, console);
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);
        if (ttl <= 0) return fn(null);

        var data;
        try {
            data = JSON.stringify(sess);
        } catch(err) {
            return fn(err);
        }

        var store     = this;
        var expiresAt = new Date(Date.now() + ~~ttl * 1000);

        this._ensureTTL(function(ttlErr) {
            if (ttlErr) return fn && fn(ttlErr);
            store._coll.updateOne(
                { _id: sid },
                { $set: { sess: data, expiresAt: expiresAt } }
            ).then(function() { fn && fn(null); })
             .catch(function(err) { fn && fn(err); });
        });
    };

    /**
     * Destroy the session associated with `sid`.
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err)`.
     */
    MongodbStore.prototype.destroy = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#destroy', fn, console);
        this._coll.deleteOne({ _id: sid })
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Count active (non-expired) sessions. Uses `{expiresAt: {$gt: now}}`
     * to filter out documents that have expired but not yet been reaped
     * by the TTL monitor. Index-backed via the `sessionsExpiresTTL` index.
     *
     * @param {function} fn - Callback `fn(err, count)`.
     */
    MongodbStore.prototype.length = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#length', fn, console);
        this._coll.countDocuments({ expiresAt: { $gt: new Date() } })
            .then(function(count) { fn(null, count); })
            .catch(function(err) { fn(err); });
    };

    /**
     * Drop every session in the collection. Uses `deleteMany({})` instead
     * of `drop()` so the TTL index survives — mirrors ScyllaDB's `TRUNCATE`
     * intent (data only, schema preserved).
     *
     * @param {function} fn - Callback `fn(err)`.
     */
    MongodbStore.prototype.clear = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#clear', fn, console);
        this._coll.deleteMany({})
            .then(function() { fn && fn(null); })
            .catch(function(err) { fn && fn(err); });
    };

    /**
     * Fetch every active (non-expired) session. Returns a hash keyed by
     * sid. Skips documents whose `sess` field is malformed JSON.
     *
     * @param {function} fn - Callback `fn(err, sessions)`.
     */
    MongodbStore.prototype.all = function(fn) {
        if ('function' !== typeof fn) fn = noop;
        fn = settleOnce('mongodb:session#all', fn, console);
        this._coll.find({ expiresAt: { $gt: new Date() } }).toArray().then(function(docs) {
            var out = {};
            for (var i = 0; i < docs.length; i++) {
                try { out[docs[i]._id] = JSON.parse(docs[i].sess); }
                catch (_e) { /* skip malformed docs */ }
            }
            fn(null, out);
        }).catch(function(err) {
            fn(err);
        });
    };

    return MongodbStore;
};
