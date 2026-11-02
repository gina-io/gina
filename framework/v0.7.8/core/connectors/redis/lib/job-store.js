/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/redis/job-store
 *
 * Redis-backed `JobStore` for the async-job primitive (`lib/job`) — the third
 * connector store of the #AI6 family (SQLite, then MongoDB, shipped first).
 * Backed by the `ioredis` driver, resolved at construction time — the
 * framework keeps zero hard dependency on it.
 *
 * Like the MongoDB store, this is a multi-pod backend: the record lives on a
 * redis every pod reaches, so a job created on pod A is pollable from pod B
 * via `/_gina/jobs/:id` and records survive any single bundle restart. The
 * deferred *function* still runs only in the process that created the job —
 * the store shares the record, never the closure (see `lib/job`).
 *
 * Data layout — redis has no secondary queries, so the two query shapes the
 * seam needs (list-by-state, sweep-by-expiry) are materialised as explicit
 * index structures, maintained atomically with the record on every write
 * (one MULTI per `set`/`remove`/`sweep` — indexes can never drift from the
 * records):
 *
 *   <prefix><id>              record — the full JSON string (records
 *                             legitimately gain keys post-create:
 *                             `webhookDeliveredAt`, `webhookFailed`, ...)
 *   <prefix>idx:state:<state> SET of ids per lifecycle state
 *   <prefix>idx:expires       sorted set: score = `expiresAt` (epoch ms),
 *                             member = id — TERMINAL records with a numeric
 *                             `expiresAt` only, so membership+score is exactly
 *                             the memory store's sweep predicate
 *
 * Job ids are base-62 (no colon), so the colon-suffixed `idx:` keys can never
 * collide with a record key under the same prefix.
 *
 * Deliberate divergences from the redis SESSION store (same connector,
 * different contract):
 *   - NO per-key TTL. Redis-side auto-eviction would purge records OUTSIDE
 *     the seam's `sweep` (breaking memory-store parity — expiry acts only at
 *     sweep time), so keys are written without any TTL and `connConf.ttl`
 *     (a session-store knob) is deliberately ignored; retention is governed
 *     by `app.json`'s `jobs.ttl` through the seam.
 *   - `get` / `list` do NOT filter on expiry: a terminal record past its
 *     `expiresAt` stays readable until `sweep` purges it (memory parity).
 *   - Default key prefix is `'jobs:'` (`'{jobs}:'` in cluster mode), not the
 *     session store's `'sess:'` — a shared entry keeps the two namespaces
 *     apart unless the operator explicitly unifies them via `prefix`.
 *
 * Cluster mode: the index design needs MULTI / SUNION / MGET across several
 * keys, which Redis Cluster only allows when all keys hash to one slot. The
 * prefix must therefore carry a `{hash-tag}` in cluster mode — the default is
 * `'{jobs}:'`, and a custom untagged prefix fails fast at construction
 * (instead of CROSSSLOT errors at runtime). Job data is small; single-slot
 * placement is fine.
 *
 * Config keys follow the redis connector's OWN conventions (the session
 * store's connection surface): `host` / `port` / `db` / `password` / `tls` /
 * `cluster`, plus `prefix` (job-store default `'jobs:'`). Canonical entry:
 * `{ "jobsRedis": { "connector": "redis", "host": "127.0.0.1", "port": 6379 } }`.
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

/**
 * The four state values, for the blind per-state index fan-out — derived from
 * `STATES` so a future state cannot silently be missed.
 *
 * @inner
 * @type {Array<string>}
 */
var STATE_VALUES = Object.keys(STATES).map(function(k) { return STATES[k]; });

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * Build a Redis-backed job store implementing the `lib/job` `JobStore` seam
 * (`set / get / remove / list / sweep`, all Node-callback-shaped). ioredis
 * callbacks fire asynchronously — `lib/job`'s create-race hardening (drain
 * scheduled inside the `set` callback) is what makes an async store safe as a
 * drop-in.
 *
 * Driver resolution — a strict superset of both existing precedents: a bare
 * `require('ioredis')` first (byte-parity with the redis session store, so the
 * two stores resolve identically wherever the session store works), then the
 * project's `node_modules` (the mongodb job-store precedent — covers the
 * global-install topology where a bare require cannot see a project-local
 * install), then an actionable error. No runtime version floor (session-store
 * parity; the CLI connector registry's `>=5.0.0` governs install hints).
 *
 * All timestamps are epoch MILLISECONDS — the seam's unit (`sweep(now)`
 * receives `Date.now()`; the session store's seconds-based TTL convention does
 * NOT apply).
 *
 * @param {object}  connConf             - Resolved `connectors.json` entry for this store.
 * @param {string}  [connConf.host]      - Redis host (default 127.0.0.1; standalone mode).
 * @param {number}  [connConf.port]      - Redis port (default 6379; standalone mode).
 * @param {number}  [connConf.db]        - Redis DB index (default 0; standalone mode).
 * @param {string}  [connConf.password]  - AUTH password (standalone and cluster).
 * @param {boolean} [connConf.tls]       - Enable TLS (managed providers).
 * @param {Array<{host:string,port:number}>} [connConf.cluster] - Cluster nodes; presence
 *                                         switches to cluster mode (session-store shape).
 * @param {string}  [connConf.prefix]    - Key prefix (default `'jobs:'`; `'{jobs}:'` in
 *                                         cluster mode — a custom cluster prefix MUST
 *                                         carry a `{hash-tag}`).
 * @param {string}  bundle               - Bundle name — used in log lines.
 * @param {object}  [injected]           - Test-only dependency injection (the entity-layer
 *                                         `injected` precedent): `{ driver }` replaces the
 *                                         resolved ioredis module. The dispatcher always
 *                                         calls with two arguments.
 * @returns {object}                     - A `JobStore` instance, plus a `close()` convenience
 *                                         (not part of the seam; releases the client).
 * @throws {Error}                       - When ioredis is not installed, or a custom
 *                                         cluster-mode prefix carries no hash tag.
 *
 * @example
 *   // connectors.json:  { "jobsRedis": { "connector": "redis",
 *   //                                    "host": "127.0.0.1", "port": 6379 } }
 *   // app.json:         { "jobs": { "store": "jobsRedis" } }
 *   // (wired automatically at boot by gna.js via lib/job-store)
 */
module.exports = function RedisJobStore(connConf, bundle, injected) {
    connConf = connConf || {};

    // Resolve the ioredis driver: bare require first (session-store parity),
    // then the project's node_modules (mongodb job-store precedent). The
    // injected branch is test-only; the fallback branch is the only place the
    // injected `_` / `getPath` globals are read, so tests stay standalone.
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
                    '[RedisJobStore] ioredis is not installed. '
                    + 'Run `npm install ioredis` in your project.\n'
                    + bareErr.message
                );
            }
        }
    }

    var isCluster = Array.isArray(connConf.cluster) && connConf.cluster.length > 0;

    var prefix = (typeof connConf.prefix === 'string' && connConf.prefix.length > 0)
        ? connConf.prefix
        : (isCluster ? '{jobs}:' : 'jobs:');

    if (isCluster && !/\{.+\}/.test(prefix)) {
        throw new Error(
            '[RedisJobStore] cluster mode requires a hash-tagged `prefix` (e.g. "{jobs}:") '
            + 'so every job key hashes to one slot — the store\'s MULTI/SUNION/MGET '
            + 'operations fail with CROSSSLOT across slots. Got: "' + prefix + '"'
        );
    }

    // Client construction mirrors the redis session store (standalone,
    // cluster, TLS).
    var client;
    if (isCluster) {
        var clusterRedisOpts = {};
        if (connConf.password) clusterRedisOpts.password = connConf.password;
        if (connConf.tls) clusterRedisOpts.tls = {};
        client = new Redis.Cluster(connConf.cluster, { redisOptions: clusterRedisOpts });
    } else {
        var clientConf = {
            host : connConf.host || '127.0.0.1',
            port : +(connConf.port || 6379),
            db   : +(connConf.db   || 0)
        };
        if (connConf.password) clientConf.password = connConf.password;
        if (connConf.tls) clientConf.tls = {};
        client = new Redis(clientConf);
    }

    // An 'error' event with no listener would crash the process (EventEmitter
    // semantics). Log it; each seam operation surfaces its own driver error
    // through its callback (ioredis queues commands while reconnecting).
    client.on('error', function(err) {
        console.error('[RedisJobStore] ' + ((err && err.message) || err) + ' (bundle: ' + bundle + ')');
    });

    /**
     * Record key for a job id.
     * @inner
     * @param   {string} id
     * @returns {string}
     */
    function recKey(id) { return prefix + id; }

    /**
     * Per-state index SET key.
     * @inner
     * @param   {string} state
     * @returns {string}
     */
    function stateKey(state) { return prefix + 'idx:state:' + state; }

    /**
     * Expiry index (sorted set) key — terminal records with a numeric
     * `expiresAt` only.
     * @inner
     * @type {string}
     */
    var expiresKey = prefix + 'idx:expires';

    /**
     * Whether a state is terminal (sweepable once expired).
     * @inner
     * @param   {string} state
     * @returns {boolean}
     */
    function isTerminal(state) {
        return state === STATES.COMPLETED || state === STATES.FAILED;
    }

    /**
     * Extract the first error out of a MULTI exec outcome — the exec-level
     * error, or the first per-command error from the `[err, result]` pairs.
     *
     * @inner
     * @param   {?Error} err     - exec-level error.
     * @param   {?Array} results - Array of `[err, result]` pairs.
     * @returns {?Error}
     */
    function firstExecError(err, results) {
        if (err) return err;
        if (!results) return null;
        for (var i = 0; i < results.length; i++) {
            if (results[i] && results[i][0]) return results[i][0];
        }
        return null;
    }

    return {

        /**
         * Upsert `record` under `id` and maintain the two index structures in
         * the same atomic MULTI: the record JSON, a blind SREM from every
         * other state SET + SADD into the current one, and the expiry index
         * entry (added only for a terminal state with a numeric `expiresAt`,
         * removed otherwise) — so index membership always reflects the last
         * write.
         *
         * @param {string}    id
         * @param {JobRecord} record
         * @param {function}  [fn] - `fn(err, record)`.
         * @returns {void}
         */
        set: function(id, record, fn) {
            if (typeof fn !== 'function') fn = noop;
            var json;
            try {
                json = JSON.stringify(record);
            } catch (err) {
                return fn(err);
            }
            var state = String(record.state || '');
            var multi = client.multi();
            multi.set(recKey(id), json);
            for (var i = 0; i < STATE_VALUES.length; i++) {
                if (STATE_VALUES[i] !== state) {
                    multi.srem(stateKey(STATE_VALUES[i]), id);
                }
            }
            multi.sadd(stateKey(state), id);
            if (isTerminal(state) && typeof record.expiresAt === 'number') {
                multi.zadd(expiresKey, record.expiresAt, id);
            } else {
                multi.zrem(expiresKey, id);
            }
            multi.exec(function(execErr, results) {
                var err = firstExecError(execErr, results);
                if (err) return fn(err);
                fn(null, record);
            });
        },

        /**
         * Fetch a record by `id`. A plain key read — NO expiry filter: a
         * terminal record past its `expiresAt` stays readable until `sweep`
         * purges it (memory-store parity).
         *
         * @param {string}   id
         * @param {function} fn - `fn(err, record|null)`.
         * @returns {void}
         */
        get: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            client.get(recKey(id), function(err, data) {
                if (err) return fn(err);
                if (!data) return fn(null, null);
                var rec;
                try {
                    rec = JSON.parse(data);
                } catch (parseErr) {
                    return fn(new Error('[RedisJobStore] could not parse job record `' + id + '`: ' + parseErr.message));
                }
                fn(null, rec);
            });
        },

        /**
         * Delete a record by `id`, cleaning its index entries in the same
         * MULTI. `existed` is derived from the DEL count.
         *
         * @param {string}   id
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        remove: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            var multi = client.multi();
            multi.del(recKey(id));
            for (var i = 0; i < STATE_VALUES.length; i++) {
                multi.srem(stateKey(STATE_VALUES[i]), id);
            }
            multi.zrem(expiresKey, id);
            multi.exec(function(execErr, results) {
                var err = firstExecError(execErr, results);
                if (err) return fn(err);
                fn(null, !!(results && results[0] && results[0][1] > 0));
            });
        },

        /**
         * List records, optionally filtered by `{ state }` — SMEMBERS on the
         * matching state SET (or SUNION across all four for an unfiltered
         * list), then one MGET for the records. No expiry filter (memory
         * parity). An id whose record key is gone by MGET time was
         * removed/swept between the two reads — equivalent to listing a
         * moment later, so it is skipped; a record that fails to PARSE fails
         * the whole list loudly (silent skipping would hide corruption).
         *
         * @param {?Object}  filter - e.g. `{ state: 'failed' }`; `null` for all.
         * @param {function} fn     - `fn(err, records)`.
         * @returns {void}
         */
        list: function(filter, fn) {
            if (typeof fn !== 'function') fn = noop;
            var onIds = function(err, ids) {
                if (err) return fn(err);
                if (!ids || ids.length === 0) return fn(null, []);
                var keys = [];
                for (var i = 0; i < ids.length; i++) {
                    keys.push(recKey(ids[i]));
                }
                client.mget(keys, function(mgetErr, values) {
                    if (mgetErr) return fn(mgetErr);
                    var out = [];
                    try {
                        for (var j = 0; j < values.length; j++) {
                            if (values[j] === null || typeof values[j] === 'undefined') continue;
                            out.push(JSON.parse(values[j]));
                        }
                    } catch (parseErr) {
                        return fn(new Error('[RedisJobStore] could not parse a job record while listing: ' + parseErr.message));
                    }
                    fn(null, out);
                });
            };
            if (filter && filter.state) {
                client.smembers(stateKey(String(filter.state)), onIds);
            } else {
                var setKeys = [];
                for (var i = 0; i < STATE_VALUES.length; i++) {
                    setKeys.push(stateKey(STATE_VALUES[i]));
                }
                client.sunion(setKeys, onIds);
            }
        },

        /**
         * Purge terminal (`completed` / `failed`) records whose `expiresAt`
         * has elapsed — the exact memory-store predicate. Only terminal
         * records with a numeric `expiresAt` ever enter the expiry index (see
         * `set`), so a range read up to `now` yields exactly the sweepable
         * ids — O(expired), not O(all): pending/running and null-`expiresAt`
         * records are excluded by construction (the SQLite store's
         * `IS NOT NULL` analog). Deletion + index cleanup happen in one MULTI;
         * the removed count is the number of DELs that hit.
         *
         * @param {number}   now - Epoch ms (passed in by `lib/job`).
         * @param {function} fn  - `fn(err, removedCount)`.
         * @returns {void}
         */
        sweep: function(now, fn) {
            if (typeof fn !== 'function') fn = noop;
            client.zrangebyscore(expiresKey, '-inf', now, function(err, ids) {
                if (err) return fn(err);
                if (!ids || ids.length === 0) return fn(null, 0);
                var multi = client.multi();
                for (var i = 0; i < ids.length; i++) {
                    multi.del(recKey(ids[i]));
                    multi.srem(stateKey(STATES.COMPLETED), ids[i]);
                    multi.srem(stateKey(STATES.FAILED), ids[i]);
                    multi.zrem(expiresKey, ids[i]);
                }
                multi.exec(function(execErr, results) {
                    var execFirstErr = firstExecError(execErr, results);
                    if (execFirstErr) return fn(execFirstErr);
                    var removed = 0;
                    // Each swept id contributed 4 commands; every 4th result
                    // (offset 0) is its DEL count.
                    for (var j = 0; j < results.length; j += 4) {
                        if (results[j] && results[j][1] > 0) removed++;
                    }
                    fn(null, removed);
                });
            });
        },

        /**
         * Release the underlying client. NOT part of the `JobStore` seam —
         * `lib/job` never calls it; provided for tests and explicit teardown.
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
