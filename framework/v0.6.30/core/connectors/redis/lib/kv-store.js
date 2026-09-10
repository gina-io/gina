/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/redis/kv-store
 * @description Redis backend for the general-purpose KV primitive (#KV1,
 * slice 1) — the first connector to implement `lib/kv`'s `KvStoreContract`.
 * Backed by the `ioredis` driver, resolved at construction time (byte-parity
 * with the redis session/job/render-cache stores).
 *
 * Reached by declaring the backend in `config/connectors.json` and pointing
 * `settings.json`'s `kv.namespaces.<name>.store` at that entry; `gna.js`
 * builds it at boot through `lib/kv-store`. Never construct it directly.
 *
 * **Every value crossing this seam is an opaque STRING** — `lib/kv` owns JSON
 * serialization, so this module never parses a payload. One consequence is
 * load-bearing and deliberate: the facade stores an integer as its JSON form
 * (`5` → `"5"`), which is exactly what redis `INCRBY` operates on, so counters
 * work natively; a string value is stored QUOTED (`"text"` → `"\"text\""`),
 * so `INCRBY` refuses it — the same refusal the in-memory backend makes, by a
 * different mechanism.
 *
 * **Three verbs need Lua**, because redis has no single command with the
 * contract's semantics (`client.eval`; there was no EVAL precedent in the
 * framework before this store):
 *   - `consume` — atomic read-AND-delete. `GETDEL` (redis >= 6.2) is used when
 *     available and the Lua script is the pre-6.2 fallback, NOT a `GET`+`DEL`
 *     pair: a pair lets two concurrent readers both succeed, which is the one
 *     thing the op exists to prevent. The capability is probed ONCE, lazily,
 *     on the first `consume()` and remembered.
 *   - `incrby` — the contract applies a TTL on CREATE only. Redis `INCRBY`
 *     creates without one and `n === by` is a racy proxy for "was created"
 *     (an expiry between commands defeats it), so existence is checked and the
 *     `PEXPIRE` applied inside one script.
 *   - `compareDel` — delete-iff-equal. A `GET` then `DEL` is the classic unsafe
 *     lock release: the value can change between the two.
 *
 * **Cluster prefixes are NOT hash-tagged by default — a deliberate divergence
 * from the redis job store**, which fails fast without a tag. Every KV op here
 * is SINGLE-key, so keys may spread across slots freely; tagging a namespace
 * would pin it to one node and forfeit exactly the spread a cluster is for.
 * The only multi-key verb, `clear()`, therefore scans each master node rather
 * than assuming one slot. A tagged prefix is still accepted (it just localises
 * the namespace).
 *
 * **Connection policy is the operator's, per connectors entry** — this store
 * passes `commandTimeout`, `maxRetriesPerRequest` and `enableOfflineQueue`
 * through and otherwise keeps ioredis's defaults, rather than imposing the
 * render-cache's fail-fast tuning on every namespace. A namespace running
 * `failMode: "open"` (cache-like) wants the fail-fast trio set so a degrade is
 * immediate; a `failMode: "closed"` namespace (tokens, counters) usually wants
 * the default offline queue, so a reconnect blip waits rather than rejecting.
 *
 * @example
 *   // connectors.json:  { "kvRedis": { "connector": "redis",
 *   //                                  "host": "127.0.0.1", "port": 6379 } }
 *   // settings.json:    { "kv": { "namespaces": { "tokens": { "store": "kvRedis" } } } }
 *   // (wired automatically at boot by gna.js via lib/kv-store)
 */

/**
 * Atomic read-and-delete, for servers without `GETDEL` (redis < 6.2).
 * @constant
 * @inner
 * @type {string}
 */
var LUA_CONSUME = "local v = redis.call('GET', KEYS[1]) "
                + "if v then redis.call('DEL', KEYS[1]) end "
                + "return v";

/**
 * Increment, applying the TTL only when the counter did not previously exist.
 * ARGV[1] = delta, ARGV[2] = TTL in ms or '' for none.
 * @constant
 * @inner
 * @type {string}
 */
var LUA_INCR_TTL = "local existed = redis.call('EXISTS', KEYS[1]) "
                 + "local n = redis.call('INCRBY', KEYS[1], ARGV[1]) "
                 + "if existed == 0 and ARGV[2] ~= '' then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end "
                 + "return n";

/**
 * Delete iff the stored value strictly equals ARGV[1].
 * @constant
 * @inner
 * @type {string}
 */
var LUA_COMPARE_DEL = "if redis.call('GET', KEYS[1]) == ARGV[1] then "
                    + "return redis.call('DEL', KEYS[1]) else return 0 end";

/**
 * Keys deleted per round while draining a `clear()` scan.
 * @constant
 * @inner
 * @type {number}
 */
var CLEAR_BATCH = 256;

/**
 * Build the redis KV backend for one namespace.
 *
 * @class RedisKvStore
 * @constructor
 *
 * @param {object}  connConf                        - Resolved `connectors.json` entry.
 * @param {string}  [connConf.host='127.0.0.1']     - Host (standalone mode).
 * @param {number}  [connConf.port=6379]            - Port (standalone mode).
 * @param {number}  [connConf.db=0]                 - DB index (standalone mode).
 * @param {string}  [connConf.password]             - `AUTH` password.
 * @param {boolean} [connConf.tls]                  - Enable TLS with default options.
 * @param {Array}   [connConf.cluster]              - `{host, port}` nodes; presence selects cluster mode.
 * @param {string}  [connConf.prefix]               - Key prefix. Default `kv:<namespace>:`; two
 *                                                    namespaces sharing one entry never collide.
 * @param {number}  [connConf.commandTimeout]       - Per-command reply deadline in ms (ioredis default when unset).
 * @param {number}  [connConf.maxRetriesPerRequest] - Per-command retry cap (ioredis default when unset).
 * @param {boolean} [connConf.enableOfflineQueue]   - Queue commands while reconnecting (ioredis default `true`).
 * @param {string}  bundle                          - Bundle name, for error attribution.
 * @param {string}  namespaceName                   - KV namespace this store backs (prefix default).
 * @param {object}  [injected]                      - Test seam. `injected.driver` replaces `ioredis`.
 * @returns {object}                                - A `KvStoreContract` instance (see `lib/kv`).
 * @throws {Error}                                  - When ioredis is not installed.
 */
module.exports = function RedisKvStore(connConf, bundle, namespaceName, injected) {
    connConf = connConf || {};

    // Resolve the ioredis driver: bare require first (session/job/render-cache
    // store parity), then the project's node_modules. The injected branch is
    // test-only; the fallback branch is the only place the injected `_` /
    // `getPath` globals are read, so tests stay standalone.
    var Redis;
    if (injected && injected.driver) {
        Redis = injected.driver;
    } else {
        try {
            Redis = require('ioredis');
        } catch (bareErr) {
            try {
                var driverPath = _(getPath('project') + '/node_modules/ioredis', true);
                Redis = require(driverPath);
            } catch (projectErr) {
                throw new Error(
                    '[RedisKvStore] ioredis is not installed. '
                    + 'Run `npm install ioredis` in your project.\n'
                    + bareErr.message
                );
            }
        }
    }

    var isCluster = Array.isArray(connConf.cluster) && connConf.cluster.length > 0;

    // Namespace-scoped by default, so two namespaces may share one entry.
    // NOT hash-tagged in cluster mode (see the module header): every op below
    // is single-key, and tagging would pin the namespace to one slot.
    var prefix = (typeof connConf.prefix === 'string' && connConf.prefix.length > 0)
        ? connConf.prefix
        : 'kv:' + namespaceName + ':';

    /**
     * Optional connection-policy pass-throughs. Absent keys keep ioredis's
     * own defaults — this store imposes none, because the right policy is
     * per-namespace (see the module header).
     * @inner
     * @param {object} target - Options object to populate.
     * @returns {object} The same object.
     */
    var applyPolicy = function (target) {
        if (typeof connConf.commandTimeout === 'number' && connConf.commandTimeout > 0) {
            target.commandTimeout = connConf.commandTimeout;
        }
        if (typeof connConf.maxRetriesPerRequest === 'number') {
            target.maxRetriesPerRequest = connConf.maxRetriesPerRequest;
        }
        return target;
    };

    var client;
    if (isCluster) {
        var clusterRedisOpts = applyPolicy({});
        if (connConf.password) clusterRedisOpts.password = connConf.password;
        if (connConf.tls) clusterRedisOpts.tls = {};
        var clusterOpts = { redisOptions: clusterRedisOpts };
        // enableOfflineQueue is a TOP-LEVEL ClusterOptions gate — ioredis
        // Omits it from redisOptions, so a per-node value is ignored (the
        // render-cache store learnt this the hard way).
        if (connConf.enableOfflineQueue === false) { clusterOpts.enableOfflineQueue = false; }
        client = new Redis.Cluster(connConf.cluster, clusterOpts);
    } else {
        var clientConf = applyPolicy({
            host : connConf.host || '127.0.0.1',
            port : +(connConf.port || 6379),
            db   : +(connConf.db   || 0)
        });
        if (connConf.password) clientConf.password = connConf.password;
        if (connConf.tls) clientConf.tls = {};
        if (connConf.enableOfflineQueue === false) { clientConf.enableOfflineQueue = false; }
        client = new Redis(clientConf);
    }

    // An 'error' event with no listener would crash the process (EventEmitter
    // semantics). Log it; each op surfaces its own driver error through its
    // rejected promise, which lib/kv routes through the namespace failMode.
    client.on('error', function (err) {
        console.error('[RedisKvStore] ' + ((err && err.message) || err)
            + ' (bundle: ' + bundle + ', namespace: ' + namespaceName + ')');
    });

    /**
     * Prefixed key for a caller key.
     * @inner
     * @param {string} key - Caller key.
     * @returns {string} The physical redis key.
     */
    var k = function (key) { return prefix + key; };

    /**
     * `GETDEL` support, probed once on first use. `null` until probed.
     * @inner
     * @type {?boolean}
     */
    var hasGetDel = null;

    /**
     * Whether a driver error means "this server does not know that command".
     * @inner
     * @param {Error} err - Driver error.
     * @returns {boolean} `true` when the command is unknown/unsupported.
     */
    var isUnknownCommand = function (err) {
        var msg = (err && err.message) || '';
        return /unknown command/i.test(msg) || /wrong number of arguments/i.test(msg);
    };

    /**
     * Normalise redis's non-integer INCRBY refusal to the facade's wording, so
     * the message a caller sees does not depend on which backend answered.
     * @inner
     * @param {Error} err - Driver error.
     * @param {string} key - Caller key, for the message.
     * @returns {Error} The error to reject with.
     */
    var normaliseIncrErr = function (err, key) {
        var msg = (err && err.message) || '';
        if (/not an integer|out of range/i.test(msg)) {
            return new Error('[kv] value at key `' + key + '` is not an integer — incr/decr need an integer value');
        }
        return err;
    };

    /**
     * Every master node backing this store — the scan surface for `clear()`.
     * One entry in standalone mode; each master in cluster mode.
     * @inner
     * @returns {Array<object>} Node clients.
     */
    var scanNodes = function () {
        if (isCluster && typeof client.nodes === 'function') {
            return client.nodes('master');
        }
        return [client];
    };

    return {
        get: function (key) {
            return client.get(k(key));
        },

        set: function (key, s, ttlMs) {
            if (ttlMs) {
                return client.set(k(key), s, 'PX', ttlMs).then(function () { return undefined; });
            }
            return client.set(k(key), s).then(function () { return undefined; });
        },

        del: function (key) {
            return client.del(k(key)).then(function (n) { return +n > 0; });
        },

        has: function (key) {
            return client.exists(k(key)).then(function (n) { return +n > 0; });
        },

        pttl: function (key) {
            // redis: -2 = no such key, -1 = no expiry. The contract wants
            // null for a miss and keeps -1 for "no expiry".
            return client.pttl(k(key)).then(function (ms) {
                var n = +ms;
                if (n === -2) { return null; }
                return n;
            });
        },

        pexpire: function (key, ttlMs) {
            return client.pexpire(k(key), ttlMs).then(function (n) { return +n === 1; });
        },

        setnx: function (key, s, ttlMs) {
            var args = ttlMs ? [k(key), s, 'PX', ttlMs, 'NX'] : [k(key), s, 'NX'];
            // SET ... NX resolves null when the key already existed.
            return client.set.apply(client, args).then(function (res) { return res !== null; });
        },

        consume: function (key) {
            var physical = k(key);
            var viaLua = function () {
                return client.eval(LUA_CONSUME, 1, physical).then(function (v) {
                    return (typeof v === 'undefined' || v === null) ? null : v;
                });
            };
            if (hasGetDel === false) { return viaLua(); }
            if (typeof client.getdel !== 'function') {
                hasGetDel = false;
                return viaLua();
            }
            return client.getdel(physical).then(function (v) {
                hasGetDel = true;
                return (typeof v === 'undefined' || v === null) ? null : v;
            }).catch(function (err) {
                if (isUnknownCommand(err)) {
                    // redis < 6.2 — remember, and never probe again.
                    hasGetDel = false;
                    return viaLua();
                }
                throw err;
            });
        },

        incrby: function (key, by, ttlMs) {
            return client.eval(LUA_INCR_TTL, 1, k(key), String(by), ttlMs ? String(ttlMs) : '')
                .then(function (n) { return +n; })
                .catch(function (err) { throw normaliseIncrErr(err, key); });
        },

        compareDel: function (key, s) {
            return client.eval(LUA_COMPARE_DEL, 1, k(key), s).then(function (n) { return +n > 0; });
        },

        clear: function () {
            var nodes   = scanNodes();
            var pattern = prefix + '*';
            var removed = 0;

            /**
             * Drain one node's keyspace for the namespace prefix.
             * @inner
             * @param {object} node - Node client.
             * @returns {Promise<void>}
             */
            var drainNode = function (node) {
                /**
                 * @inner
                 * @param {string} cursor - SCAN cursor.
                 * @returns {Promise<void>}
                 */
                var step = function (cursor) {
                    return node.scan(cursor, 'MATCH', pattern, 'COUNT', CLEAR_BATCH).then(function (res) {
                        var next = res[0];
                        var keys = res[1] || [];
                        // Deleted one key at a time: in cluster mode an
                        // untagged namespace spans slots, and a multi-key DEL
                        // across slots is a CROSSSLOT error. clear() is an
                        // administrative op, not a hot path.
                        var chain = keys.reduce(function (p, physical) {
                            return p.then(function () {
                                return client.del(physical).then(function (n) { removed += +n; });
                            });
                        }, Promise.resolve());
                        return chain.then(function () {
                            return (String(next) === '0') ? undefined : step(next);
                        });
                    });
                };
                return step('0');
            };

            return nodes.reduce(function (p, node) {
                return p.then(function () { return drainNode(node); });
            }, Promise.resolve()).then(function () { return removed; });
        },

        close: function () {
            try {
                if (typeof client.quit === 'function') { client.quit(); }
            } catch (quitErr) { /* already closing */ }
        }
    };
};
