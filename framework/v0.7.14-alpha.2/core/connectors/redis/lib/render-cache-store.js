/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/redis/render-cache-store
 *
 * Redis-backed L2 for the render/output cache (`lib/render-cache`) — the shared
 * store that lets several replicas serve the SAME rendered page without each
 * re-rendering it. Backed by the `ioredis` driver, resolved at construction
 * time; the framework keeps zero hard dependency on it (session-store /
 * job-store parity).
 *
 * Role in the two-tier cache:
 *   - L1 = the in-process `lib/cache` Map (`memory` strategy) — fastest serve,
 *     per-replica, volatile.
 *   - L2 = this redis store — shared across replicas, survives a single bundle
 *     restart. On an L1 miss the server read path `warm()`s from L2 and
 *     populates L1 so the NEXT request on this replica hits L1.
 *
 * Contract — a pure opaque string + TTL key/value store. `lib/render-cache`
 * owns what the value MEANS (it stores a `{content, responseHeaders,
 * visibility}` JSON blob); this store never parses it. TTL is authoritative and
 * drift-free: it lives in redis (via `PSETEX`) and is read back with `PTTL`,
 * never re-derived from a timestamp the way the fs `.meta` sidecar must.
 *
 *   set(key, value, ttlMs)   PSETEX <prefix><key> ttlMs value  (SET when ttlMs falsy)
 *   warmRead(key)            GET then PTTL — { value, ttlMs } | null on miss/expiry
 *   del(key)                 DEL <prefix><key>                 (existed count)
 *   close()                  release the client (tests / teardown)
 *
 * Deliberate divergences from the redis JOB store (same connector, different
 * contract):
 *   - EVERY operation is SINGLE-KEY (set / get / pttl / del on one key each),
 *     so there is NO cross-key MULTI/SUNION/MGET and therefore NO CROSSSLOT
 *     risk in cluster mode — the job store's hash-tagged-prefix requirement is
 *     NOT imposed here. A plain `'cache:'` prefix is cluster-safe as-is.
 *   - PER-KEY TTL is the whole point (`PSETEX`): redis-side expiry is exactly
 *     the render cache's expiry, so a replica that never re-reads a key still
 *     stops serving it when it expires. (The job store deliberately forbids
 *     per-key TTL because its expiry acts only at sweep time; opposite contract.)
 *   - `enableOfflineQueue: false` + a low `maxRetriesPerRequest`: the L2 read
 *     sits on the request hot path, so a command MUST fail fast into
 *     `lib/render-cache`'s fail-open path (render normally, L1 keeps serving)
 *     rather than QUEUE while ioredis reconnects and hang every request for the
 *     whole outage. (The job store leaves ioredis's default offline queue on —
 *     a background job can wait for a reconnect; a page render cannot.)
 *   - Default key prefix `'cache:'` (`'cache:'` in cluster mode too — no hash
 *     tag needed) keeps the render-cache keyspace apart from `sess:` / `jobs:`.
 *
 * Config keys follow the redis connector's OWN conventions (`host` / `port` /
 * `db` / `password` / `tls` / `cluster`), plus `prefix` (store default
 * `'cache:'`). Canonical entry:
 *   `{ "cacheRedis": { "connector": "redis", "host": "127.0.0.1", "port": 6379 } }`
 * named by `settings.json`'s `server.cache.store`.
 *
 * Constructed once at boot by the `lib/render-cache-store` dispatcher (via
 * `gna.js`); not meant to be instantiated from application code.
 */

/**
 * No-op callback used for fire-and-forget `del`.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * Build a Redis-backed render-cache L2 store. All methods return Promises
 * (`lib/render-cache`'s `set`/`warm` are `async`, and its `delete`/`clear`/
 * `invalidateByEvent` fire `del()` and drop the promise).
 *
 * Driver resolution — a strict superset of both existing precedents: a bare
 * `require('ioredis')` first (byte-parity with the redis session/job stores),
 * then the project's `node_modules` (covers the global-install topology where a
 * bare require cannot see a project-local install), then an actionable error.
 *
 * @param {object}  connConf             - Resolved `connectors.json` entry for this store.
 * @param {string}  [connConf.host]      - Redis host (default 127.0.0.1; standalone mode).
 * @param {number}  [connConf.port]      - Redis port (default 6379; standalone mode).
 * @param {number}  [connConf.db]        - Redis DB index (default 0; standalone mode).
 * @param {string}  [connConf.password]  - AUTH password (standalone and cluster).
 * @param {boolean} [connConf.tls]       - Enable TLS (managed providers).
 * @param {Array<{host:string,port:number}>} [connConf.cluster] - Cluster nodes; presence
 *                                         switches to cluster mode (session-store shape).
 * @param {string}  [connConf.prefix]    - Key prefix (default `'cache:'`). No hash tag
 *                                         required in cluster mode (all ops single-key).
 * @param {number}  [connConf.maxRetriesPerRequest] - ioredis per-command retry cap
 *                                         (default 1 — fail fast on the hot path).
 * @param {number}  [connConf.commandTimeout] - Per-command reply deadline in ms (default
 *                                         1000). Bounds a blackholed-TCP hang on the read
 *                                         hot path; a timed-out command rejects → fail-open.
 * @param {string}  bundle               - Bundle name — used in log lines.
 * @param {object}  [injected]           - Test-only DI: `{ driver }` replaces the resolved
 *                                         ioredis module. The dispatcher always calls with two.
 * @returns {object}                     - The L2 store (`set / warmRead / del / health / close`
 *                                         — the seam consumed by lib/render-cache is
 *                                         `set / warmRead / del`; `health` feeds
 *                                         /_gina/cache/stats, `close` is teardown).
 * @throws {Error}                       - When ioredis is not installed.
 *
 * @example
 *   // connectors.json:  { "cacheRedis": { "connector": "redis",
 *   //                                     "host": "127.0.0.1", "port": 6379 } }
 *   // settings.json:    { "server": { "cache": { "type": "redis", "store": "cacheRedis" } } }
 *   // (wired automatically at boot by gna.js via lib/render-cache-store)
 */
module.exports = function RedisRenderCacheStore(connConf, bundle, injected) {
    connConf = connConf || {};

    // Resolve the ioredis driver: bare require first (session/job-store parity),
    // then the project's node_modules. The injected branch is test-only; the
    // fallback branch is the only place the injected `_` / `getPath` globals are
    // read, so tests stay standalone.
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
                    '[RedisRenderCacheStore] ioredis is not installed. '
                    + 'Run `npm install ioredis` in your project.\n'
                    + bareErr.message
                );
            }
        }
    }

    var isCluster = Array.isArray(connConf.cluster) && connConf.cluster.length > 0;

    var prefix = (typeof connConf.prefix === 'string' && connConf.prefix.length > 0)
        ? connConf.prefix
        : 'cache:';

    // Fail fast on the hot path instead of queueing while reconnecting (B5).
    // enableOfflineQueue:false → a command issued while disconnected rejects
    // immediately; a low maxRetriesPerRequest bounds a stuck request.
    var maxRetries = (typeof connConf.maxRetriesPerRequest === 'number')
        ? connConf.maxRetriesPerRequest
        : 1;
    // F1 — commandTimeout covers the case the two above do NOT: a BLACKHOLED TCP
    // (network partition / firewall drop), where the socket still looks alive so
    // enableOfflineQueue never fires and the command hangs until the OS TCP timeout
    // (minutes). warm() is awaited on the render hot path, so an unbounded command
    // hangs every redis-route request. A command with no reply within commandTimeout
    // rejects → lib/render-cache's warm() catch → fail-open (render normally).
    // Default 1s (a warm slower than that is worse than rendering); overridable.
    var commandTimeout = (typeof connConf.commandTimeout === 'number' && connConf.commandTimeout > 0)
        ? connConf.commandTimeout
        : 1000;

    var client;
    if (isCluster) {
        // Per-NODE options. NOTE ioredis strips `enableOfflineQueue` from
        // redisOptions (it is `Omit`ted in the ClusterOptions type) — it belongs
        // at the CLUSTER level, set below. `maxRetriesPerRequest` is a valid
        // per-node RedisOptions field and stays here.
        var clusterRedisOpts = {
            maxRetriesPerRequest: maxRetries,
            commandTimeout      : commandTimeout
        };
        if (connConf.password) clusterRedisOpts.password = connConf.password;
        if (connConf.tls) clusterRedisOpts.tls = {};
        // enableOfflineQueue is a TOP-LEVEL ClusterOptions gate (ioredis default
        // `true`): it decides whether a command issued while the CLUSTER is "not
        // ready" (boot slot-map build, failover, all-nodes-down) is QUEUED or
        // rejected. It MUST be false for B5 — a per-node
        // `redisOptions.enableOfflineQueue` is ignored (Omit'd), so leaving the
        // cluster-level default `true` would hang the render hot path for a whole
        // cluster outage instead of fail-opening.
        client = new Redis.Cluster(connConf.cluster, {
            enableOfflineQueue: false,
            redisOptions      : clusterRedisOpts
        });
    } else {
        var clientConf = {
            host                : connConf.host || '127.0.0.1',
            port                : +(connConf.port || 6379),
            db                  : +(connConf.db   || 0),
            enableOfflineQueue  : false,
            maxRetriesPerRequest: maxRetries,
            commandTimeout      : commandTimeout
        };
        if (connConf.password) clientConf.password = connConf.password;
        if (connConf.tls) clientConf.tls = {};
        client = new Redis(clientConf);
    }

    // #RC5 — connection-level observability for /_gina/cache/stats. The driver's
    // 'error' events (connection-level: refused / reset / DNS) are tallied here and
    // surfaced by health(). Per-COMMAND failures (timeouts, rejections) do NOT fire
    // this event — they fail-open upstream in lib/render-cache and are not counted.
    var errorCount  = 0;
    var lastError   = null;
    var lastErrorAt = null;

    // An 'error' event with no listener would crash the process (EventEmitter
    // semantics). Log it and swallow — every seam operation surfaces its own
    // driver error through its rejected promise, which lib/render-cache catches
    // into fail-open (B4).
    client.on('error', function(err) {
        errorCount++;
        lastError   = String((err && err.message) || err);
        lastErrorAt = new Date().toISOString();
        console.error('[RedisRenderCacheStore] ' + ((err && err.message) || err) + ' (bundle: ' + bundle + ')');
    });

    /**
     * Prefixed record key.
     * @inner
     * @param   {string} key - The already-namespaced render-cache key.
     * @returns {string}
     */
    function recKey(key) { return prefix + key; }

    return {

        /**
         * Write `value` (an opaque string) under `key` with a per-key TTL.
         * `PSETEX` when `ttlMs > 0` (redis-side expiry == the cache's expiry),
         * floored to 1 ms so a sub-millisecond ttl never emits `PSETEX 0` (which
         * redis rejects with `ERR invalid expire time`); a legit ms ttl is
         * unchanged. A non-positive / null / non-number `ttlMs` → plain `SET`
         * (no expiry). `lib/render-cache` only ever passes `null` or a positive
         * value, so the negative branch is defensive.
         *
         * @param {string}          key   - Namespaced render-cache key.
         * @param {string}          value - Opaque serialized entry.
         * @param {number|null}     ttlMs - Milliseconds to live, or null/0 for no expiry.
         * @returns {Promise<void>}
         */
        set: function(key, value, ttlMs) {
            try {
                if (typeof ttlMs === 'number' && ttlMs > 0) {
                    return Promise.resolve(client.psetex(recKey(key), Math.max(1, Math.round(ttlMs)), value)).then(noop);
                }
                return Promise.resolve(client.set(recKey(key), value)).then(noop);
            } catch (e) {
                // A SYNCHRONOUS driver throw (bad arg, wedged client, method not a
                // function) must still REJECT, never escape the seam — fail-open
                // depends on it, and the fire-and-forget `del` caller can only
                // `.catch` a rejection, not a sync throw.
                return Promise.reject(e);
            }
        },

        /**
         * Read an entry back for L1 warming: the stored string plus its
         * authoritative remaining life from redis. `GET` then `PTTL` (two
         * single-key round-trips; a pipeline is a drop-in optimisation later).
         *
         * Returns `null` on any miss — key absent (`GET` null), or gone by the
         * `PTTL` (`PTTL` −2 / 0). A key with no expiry (`PTTL` −1) yields
         * `ttlMs: null` (a non-expiring L1 entry).
         *
         * @param {string} key - Namespaced render-cache key.
         * @returns {Promise<{ value: string, ttlMs: (number|null) }|null>}
         */
        warmRead: function(key) {
            var rk = recKey(key);
            try {
                return Promise.resolve(client.get(rk)).then(function(value) {
                    if (value === null || typeof value === 'undefined') {
                        return null;
                    }
                    return Promise.resolve(client.pttl(rk)).then(function(pttl) {
                        // -2: key vanished between GET and PTTL (expired/evicted) → miss.
                        //  0: ≈expired — redis normally reports -2 for a 0-ms key, so
                        //     this is near-unobservable, but map it to a miss rather
                        //     than a non-expiring entry (the wrong direction).
                        // -1: key exists with no expiry → non-expiring L1 entry.
                        // >0: milliseconds remaining.
                        if (pttl === -2 || pttl === 0) {
                            return null;
                        }
                        return { value: value, ttlMs: (typeof pttl === 'number' && pttl > 0) ? pttl : null };
                    });
                });
            } catch (e) {
                return Promise.reject(e);
            }
        },

        /**
         * Delete `key` from L2. Used fire-and-forget by `lib/render-cache`'s
         * (sync) `delete`/`clear`/`invalidateByEvent`, so the caller drops the
         * returned promise — the `.catch` there swallows a rejection.
         *
         * @param {string} key - Namespaced render-cache key.
         * @returns {Promise<number>} DEL count (1 when the key existed, else 0).
         */
        del: function(key) {
            try {
                return Promise.resolve(client.del(recKey(key))).then(function(n) {
                    return (typeof n === 'number') ? n : 0;
                });
            } catch (e) {
                return Promise.reject(e);
            }
        },

        /**
         * Connection-level L2 health snapshot for `/_gina/cache/stats` (#RC5).
         * Synchronous — a read of the ioredis client's `status` property
         * (standalone AND cluster instances expose it), NO network round-trip,
         * so the admin endpoint can never hang on a dead redis.
         * `errorCount`/`lastError`/`lastErrorAt` tally the driver's
         * connection-level `error` events only — per-command failures fail-open
         * upstream in `lib/render-cache` and are not counted here. Like
         * `close()`, NOT part of the seam consumed by `lib/render-cache`.
         *
         * @returns {object} `{ store, status, mode, prefix, errorCount, lastError, lastErrorAt }`
         *                   — `status` is the ioredis lifecycle string
         *                   (`ready` / `connecting` / `reconnecting` / `close` /
         *                   `end` / …), `'unknown'` when unreadable.
         */
        health: function() {
            var _status = 'unknown';
            try { _status = String(client.status || 'unknown'); } catch (statusErr) { /* wedged client — keep 'unknown' */ }
            return {
                store       : 'redis',
                status      : _status,
                mode        : isCluster ? 'cluster' : 'standalone',
                prefix      : prefix,
                errorCount  : errorCount,
                lastError   : lastError,
                lastErrorAt : lastErrorAt
            };
        },

        /**
         * Release the underlying client. NOT part of the seam consumed by
         * `lib/render-cache`; provided for tests and explicit teardown.
         *
         * @returns {void}
         */
        close: function() {
            try {
                var p = client.quit();
                if (p && typeof p.catch === 'function') p.catch(noop);
            } catch (e) { /* already closed */ }
        }
    };
};
