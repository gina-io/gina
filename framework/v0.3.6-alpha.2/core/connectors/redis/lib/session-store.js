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
 * Return the `RedisStore` class extending `express-session`'s Store.
 *
 * Connection settings are read from the bundle's `config/connectors.json`
 * at factory-call time (inside `bundle/index.js` `onInitialize`, after
 * `getConfig()` is populated). Per-instance options passed to `new RedisStore()`
 * are merged on top and take precedence.
 *
 * Requires `ioredis` to be installed in the consumer project:
 *   `npm install ioredis`
 *
 * Supports standalone Redis, Redis Cluster, and TLS (ElastiCache, Cloud Memorystore, Upstash).
 *
 * @param {object} session       - The `express-session` module (must have `.Store` on it).
 *                                 The caller sets `session.name` to the connectors.json key
 *                                 before calling `new SessionStore(session)`.
 * @param {string} bundle        - Bundle name — used to look up `getConfig()[bundle][env]`.
 * @returns {function}           - RedisStore constructor.
 */
module.exports = function(session, bundle) {

    /**
     * Base Store class from express-session.
     * @type {function}
     */
    var Store = session.Store;

    // Read connector config from connectors.json at factory-call time.
    // `getConfig()` and `getContext()` are framework globals injected by gna.js.
    var env      = getContext().env;
    var conf     = getConfig()[bundle][env];
    var connName = session.name; // the key in connectors.json (e.g. "myRedis")
    var connConf = (conf && conf.content && conf.content.connectors && conf.content.connectors[connName]) || {};

    /**
     * Initialize RedisStore with the given options.
     *
     * Connection settings default to `connectors.json` values and can be
     * overridden per-instance via `options`.
     *
     * @constructor
     * @param {object}  [options]           - Instance-level overrides.
     * @param {string}  [options.host]      - Redis host (default: connectors.json → '127.0.0.1').
     * @param {number}  [options.port]      - Redis port (default: connectors.json → 6379).
     * @param {number}  [options.db]        - Redis DB index (default: connectors.json → 0).
     * @param {string}  [options.password]  - Redis AUTH password.
     * @param {boolean} [options.tls]       - Enable TLS (required for managed providers with TLS).
     * @param {string}  [options.prefix]    - Session key prefix (default: connectors.json → 'sess:').
     * @param {number}  [options.ttl]       - Session TTL in seconds (default: connectors.json → 86400).
     */
    function RedisStore(options) {
        var self = this;
        options  = options || {};
        Store.call(this, options);

        this.prefix = (options.prefix != null) ? options.prefix : (connConf.prefix || 'sess:');
        this.ttl    = (options.ttl    != null) ? options.ttl    : (connConf.ttl    || oneDay);

        // Require ioredis at instantiation time so the error message is clear
        // and the framework can still boot if Redis is not configured.
        var Redis;
        try {
            Redis = require('ioredis');
        } catch(e) {
            throw new Error(
                '[RedisStore] ioredis is not installed. '
                + 'Run `npm install ioredis` in your project.\n'
                + e.message
            );
        }

        // Cluster mode: connectors.json has `"cluster": [{ "host": "...", "port": 6379 }, ...]`
        if (Array.isArray(connConf.cluster) && connConf.cluster.length > 0) {
            var clusterNodes = connConf.cluster;
            var clusterRedisOpts = {};
            var clusterPassword = options.password || connConf.password;
            if (clusterPassword) clusterRedisOpts.password = clusterPassword;
            if (options.tls || connConf.tls) clusterRedisOpts.tls = {};

            this.client = new Redis.Cluster(clusterNodes, { redisOptions: clusterRedisOpts });

        } else {
            // Standalone mode
            var clientConf = {
                host : options.host  || connConf.host  || '127.0.0.1',
                port : +(options.port || connConf.port || 6379),
                db   : +(options.db   || connConf.db   || 0)
            };
            var password = options.password || connConf.password;
            if (password) clientConf.password = password;
            if (options.tls || connConf.tls) clientConf.tls = {};

            this.client = new Redis(clientConf);
        }

        var store = this;
        this.client.on('ready', function() {
            console.debug('[RedisStore] connected (bundle: ' + bundle + ', connector: ' + connName + ')');
            store.emit('connect');
        });
        this.client.on('error', function(err) {
            console.error('[RedisStore] ' + (err.message || err));
            store.emit('disconnect');
        });
        this.client.on('reconnecting', function() {
            console.debug('[RedisStore] reconnecting...');
        });
    }

    /**
     * Inherit from express-session Store.
     */
    RedisStore.prototype.__proto__ = Store.prototype;

    /**
     * Fetch session by the given `sid`.
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err, session)`.
     */
    RedisStore.prototype.get = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        var key = this.prefix + sid;
        console.debug('[RedisStore] GET "' + key + '"');

        this.client.get(key, function(err, data) {
            if (err) return fn(err);
            if (!data) return fn();
            try {
                return fn(null, JSON.parse(data));
            } catch(parseErr) {
                var sessErr = new Error('[' + bundle + '][RedisStore] Could not parse session "' + key + '"\n' + parseErr.stack);
                console.error(sessErr);
                return fn(sessErr);
            }
        });
    };

    /**
     * Commit the given `sess` object associated with `sid`.
     * Uses SETEX when TTL > 0, SET otherwise.
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data.
     * @param {function} fn   - Callback `fn(err)`.
     */
    RedisStore.prototype.set = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        var key    = this.prefix + sid;
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);

        if (ttl > 0) {
            sess.lastModified = new Date().toISOString();
        }

        var data;
        try {
            data = JSON.stringify(sess);
        } catch(err) {
            return fn(err);
        }

        console.debug('[RedisStore] SETEX "' + key + '" ttl:' + ttl);

        if (ttl > 0) {
            this.client.setex(key, ~~ttl, data, fn);
        } else {
            this.client.set(key, data, fn);
        }
    };

    /**
     * Destroy the session associated with `sid`.
     *
     * @param {string}   sid - Session ID.
     * @param {function} fn  - Callback `fn(err)`.
     */
    RedisStore.prototype.destroy = function(sid, fn) {
        if ('function' !== typeof fn) fn = noop;
        this.client.del(this.prefix + sid, fn);
    };

    /**
     * Refresh the TTL for an existing session without modifying its data.
     *
     * @param {string}   sid  - Session ID.
     * @param {object}   sess - Session data (used to read cookie.maxAge).
     * @param {function} fn   - Callback `fn(err)`.
     */
    RedisStore.prototype.touch = function(sid, sess, fn) {
        if ('function' !== typeof fn) fn = noop;
        var key    = this.prefix + sid;
        var maxAge = sess.cookie && sess.cookie.maxAge;
        var ttl    = this.ttl || ('number' === typeof maxAge ? maxAge / 1000 | 0 : oneDay);
        if (ttl > 0) {
            this.client.expire(key, ~~ttl, fn);
        } else {
            fn();
        }
    };

    return RedisStore;
};
