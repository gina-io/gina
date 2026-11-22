/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/core/connectors/mongodb/job-store
 *
 * MongoDB-backed `JobStore` for the async-job primitive (`lib/job`) — the
 * second connector store of the #AI6 family (SQLite shipped first). Backed by
 * the consumer project's own `mongodb` driver, resolved from the project's
 * `node_modules` exactly like the MongoDB session store — the framework keeps
 * zero hard dependency on it.
 *
 * What it buys over the SQLite store: the record lives on a mongod every pod
 * can reach, so this is the true multi-pod backend — a job created on pod A is
 * pollable from pod B via `/_gina/jobs/:id`, and records survive any single
 * bundle restart. The deferred *function* still runs only in the process that
 * created the job — the store shares the record, never the closure (see
 * `lib/job`).
 *
 * Deliberate divergences from the MongoDB SESSION store (same connector,
 * different contract):
 *   - `get` / `list` do NOT filter on expiry. The memory store returns
 *     terminal records until `sweep` purges them, and behavioral parity with
 *     the memory store is the contract here — expiry acts only at sweep time.
 *   - NO server-side TTL index. Mongo's TTL monitor is a Date-indexed reaper
 *     that would purge records OUTSIDE the seam's sweep (breaking the parity
 *     above) — and the job record's `expiresAt` is an epoch-ms NUMBER, which
 *     the TTL monitor ignores anyway (it only reaps BSON Date fields), so a
 *     TTL index here would look configured while silently never firing. The
 *     two secondary indexes created at construction (`jobsState`,
 *     `jobsExpires`) are plain performance indexes with no reaping semantics.
 *   - The record is stored as a JSON STRING (the session store's `sess`
 *     precedent), not a nested document: caller-supplied `meta` may carry
 *     dotted or dollar-prefixed keys that BSON documents reject, and the
 *     JSON round-trip is exactly the fidelity the seam guarantees.
 *
 * Config keys follow the mongodb connector's OWN conventions (the §11 rule —
 * mirrors the session store's URI assembly): `uri` preferred, else
 * host/port/username/password/database/authSource/replicaSet + ssl. For
 * mongodb, `database` is a NAME (the same field the model layer's entity scan
 * reads), so the connectors.json entry is model-scan-compatible by
 * construction — the sqlite `file`-as-path quirk does not apply here.
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

// #B432 — `lib/job` must see exactly one callback. Each method below wraps
// `fn` at entry, so a callback that THROWS can no longer be re-invoked by
// that method's own error path (see core/connectors/settle-once.js).
var settleOnce = require('./../../settle-once');

/**
 * No-op callback used when a caller omits one.
 * @inner
 * @returns {void}
 */
function noop() {}

/**
 * Build a MongoDB-backed job store implementing the `lib/job` `JobStore` seam
 * (`set / get / remove / list / sweep`, all Node-callback-shaped). The driver
 * is promise-based, so callbacks fire asynchronously — `lib/job`'s create-race
 * hardening (drain scheduled inside the `set` callback) is what makes an async
 * store safe as a drop-in.
 *
 * Each record is stored as `{ _id, state, expiresAt, updatedAt, record }`:
 * thin indexed fields for the two query shapes (list-by-state,
 * sweep-by-expiry) — mirroring the SQLite store's columns — with the full
 * record riding as a JSON string because it legitimately gains keys after
 * creation (`webhookDeliveredAt`, `webhookFailed`, ...). All timestamps are
 * epoch MILLISECONDS — the seam's unit (`sweep(now)` receives `Date.now()`;
 * the session store's Date-typed `expiresAt` convention does NOT apply).
 *
 * @param {object}  connConf              - Resolved `connectors.json` entry for this store.
 * @param {string}  [connConf.uri]        - Full mongodb:// or mongodb+srv:// URI (preferred).
 * @param {string}  [connConf.host]       - Single host (used when uri absent; default 127.0.0.1).
 * @param {number}  [connConf.port]       - Single port (default 27017).
 * @param {string}  [connConf.username]   - Auth username.
 * @param {string}  [connConf.password]   - Auth password.
 * @param {string}  connConf.database     - Database NAME (required — the mongodb connector's
 *                                          own convention; the model layer reads the same field).
 * @param {string}  [connConf.authSource] - Auth db (typically "admin").
 * @param {string}  [connConf.replicaSet] - Replica set name.
 * @param {object|boolean} [connConf.ssl] - TLS configuration (true, or a driver options object).
 * @param {string}  [connConf.collection] - Jobs collection (default 'jobs').
 * @param {string}  bundle                - Bundle name — used in log lines.
 * @param {object}  [injected]            - Test-only dependency injection (the entity-layer
 *                                          `injected` precedent): `{ driver }` replaces the
 *                                          project-resolved mongodb module. The dispatcher
 *                                          always calls with two arguments.
 * @returns {object}                      - A `JobStore` instance, plus a `close()` convenience
 *                                          (not part of the seam; releases the client).
 * @throws {Error}                        - When the mongodb driver is not installed in the
 *                                          project, or `database` is missing.
 *
 * @example
 *   // connectors.json:  { "jobsDb": { "connector": "mongodb", "host": "127.0.0.1",
 *   //                                 "port": 27017, "database": "gina_jobs" } }
 *   // app.json:         { "jobs": { "store": "jobsDb" } }
 *   // (wired automatically at boot by gna.js via lib/job-store)
 */
module.exports = function MongodbJobStore(connConf, bundle, injected) {
    connConf = connConf || {};

    // Resolve the mongodb driver from the project's node_modules (session-store
    // precedent) so the framework has zero hard dependency on it. The injected
    // branch is test-only; the default branch is the only place the injected
    // `_` / `getPath` globals are read, so tests stay standalone.
    var mongodb;
    if (injected && injected.driver) {
        mongodb = injected.driver;
    } else {
        try {
            var driverPath = _(getPath('project') + '/node_modules/mongodb', true);
            mongodb = require(driverPath);
        } catch (e) {
            throw new Error(
                '[MongodbJobStore] mongodb is not installed. '
                + 'Run `npm install mongodb` in your project.\n'
                + e.message
            );
        }
    }

    var dbName = connConf.database;
    if (!dbName) {
        throw new Error('[MongodbJobStore] missing required `database` field in the connectors.json entry');
    }

    // Compose the connection URI — mirrors the session store's resolveUri()
    // (itself mirroring core/connectors/mongodb/lib/connector.js).
    var uri = connConf.uri;
    if (!uri) {
        var host       = connConf.host || '127.0.0.1';
        var port       = connConf.port || 27017;
        var username   = connConf.username;
        var password   = connConf.password;
        var authSource = connConf.authSource;
        var replicaSet = connConf.replicaSet;

        var auth = '';
        if (username) {
            auth = encodeURIComponent(username);
            if (password) auth += ':' + encodeURIComponent(password);
            auth += '@';
        }
        uri = 'mongodb://' + auth + host + ':' + port + '/' + encodeURIComponent(dbName);
        var qs = [];
        if (authSource) qs.push('authSource=' + encodeURIComponent(authSource));
        if (replicaSet) qs.push('replicaSet=' + encodeURIComponent(replicaSet));
        if (qs.length) uri += '?' + qs.join('&');
    }

    var clientOptions = {};
    var ssl           = connConf.ssl;
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

    var collectionName = connConf.collection || 'jobs';
    var client         = new mongodb.MongoClient(uri, clientOptions);
    var coll           = client.db(dbName).collection(collectionName);

    // Eager connect + plain secondary indexes, fire-and-forget: operations
    // never wait on this (the driver queues them until connected, and index
    // existence is a pure performance concern — no behavioral role). A failure
    // is logged; each subsequent operation then surfaces its own driver error
    // through the seam callbacks.
    client.connect().then(function() {
        return Promise.all([
            coll.createIndex({ state: 1 },     { name: 'jobsState' }),
            coll.createIndex({ expiresAt: 1 }, { name: 'jobsExpires' })
        ]);
    }).catch(function(err) {
        console.error('[MongodbJobStore] connection/index setup failed (bundle: '
            + bundle + '): ' + ((err && err.message) || err));
    });

    return {

        /**
         * Upsert `record` under `id`. The record is serialised whole into the
         * `record` JSON-string field; `state` and `expiresAt` are additionally
         * mirrored into their indexed fields. The driver result is never
         * forwarded to the callback (a resolved UpdateResult in the err slot
         * is the classic express-session-store bug) — `fn(null, record)`
         * explicitly on success.
         *
         * @param {string}    id
         * @param {JobRecord} record
         * @param {function}  [fn] - `fn(err, record)`.
         * @returns {void}
         */
        set: function(id, record, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('mongodb:job#set', fn, console);
            var json;
            try {
                json = JSON.stringify(record);
            } catch (err) {
                return fn(err);
            }
            var doc = {
                _id:       id,
                state:     String(record.state || ''),
                expiresAt: (typeof record.expiresAt === 'number') ? record.expiresAt : null,
                updatedAt: (typeof record.updatedAt === 'number') ? record.updatedAt : Date.now(),
                record:    json
            };
            coll.replaceOne({ _id: id }, doc, { upsert: true })
                .then(function() { fn(null, record); })
                .catch(function(err) { fn(err); });
        },

        /**
         * Fetch a record by `id`. No expiry filter — a terminal record past its
         * `expiresAt` stays readable until `sweep` purges it (memory-store
         * parity; the session store's lag-protection filter does NOT apply).
         *
         * @param {string}   id
         * @param {function} fn - `fn(err, record|null)`.
         * @returns {void}
         */
        get: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('mongodb:job#get', fn, console);
            coll.findOne({ _id: id }).then(function(doc) {
                if (!doc) return fn(null, null);
                var rec;
                try {
                    rec = JSON.parse(doc.record);
                } catch (parseErr) {
                    return fn(new Error('[MongodbJobStore] could not parse job record `' + id + '`: ' + parseErr.message));
                }
                fn(null, rec);
            }).catch(function(err) {
                fn(err);
            });
        },

        /**
         * Delete a record by `id`.
         *
         * @param {string}   id
         * @param {function} [fn] - `fn(err, existed)`.
         * @returns {void}
         */
        remove: function(id, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('mongodb:job#remove', fn, console);
            coll.deleteOne({ _id: id })
                .then(function(res) { fn(null, !!(res && res.deletedCount > 0)); })
                .catch(function(err) { fn(err); });
        },

        /**
         * List records, optionally filtered by `{ state }`. No expiry filter
         * (memory-store parity). A record that fails to parse fails the whole
         * list loudly — silent skipping would hide corruption.
         *
         * @param {?Object}  filter - e.g. `{ state: 'failed' }`; `null` for all.
         * @param {function} fn     - `fn(err, records)`.
         * @returns {void}
         */
        list: function(filter, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('mongodb:job#list', fn, console);
            var query = (filter && filter.state) ? { state: String(filter.state) } : {};
            coll.find(query).toArray().then(function(docs) {
                var out = [];
                try {
                    for (var i = 0; i < docs.length; i++) {
                        out.push(JSON.parse(docs[i].record));
                    }
                } catch (parseErr) {
                    return fn(new Error('[MongodbJobStore] could not parse a job record while listing: ' + parseErr.message));
                }
                fn(null, out);
            }).catch(function(err) {
                fn(err);
            });
        },

        /**
         * Purge terminal (`completed` / `failed`) records whose `expiresAt` has
         * elapsed — the exact memory-store predicate, expressed as one
         * deleteMany. BSON type bracketing makes the `$lte` bound match numeric
         * `expiresAt` values only, so null / absent `expiresAt` records are
         * excluded server-side (the SQLite store's `IS NOT NULL` clause,
         * for free).
         *
         * @param {number}   now - Epoch ms (passed in by `lib/job`).
         * @param {function} fn  - `fn(err, removedCount)`.
         * @returns {void}
         */
        sweep: function(now, fn) {
            if (typeof fn !== 'function') fn = noop;
            fn = settleOnce('mongodb:job#sweep', fn, console);
            coll.deleteMany({
                state:     { $in: [STATES.COMPLETED, STATES.FAILED] },
                expiresAt: { $lte: now }
            }).then(function(res) { fn(null, (res && res.deletedCount) || 0); })
              .catch(function(err) { fn(err); });
        },

        /**
         * Release the underlying MongoClient. NOT part of the `JobStore` seam —
         * `lib/job` never calls it; provided for tests and explicit teardown.
         *
         * @returns {void}
         */
        close: function() {
            try {
                var p = client.close();
                if (p && typeof p.catch === 'function') p.catch(noop);
            } catch (e) { /* already closed */ }
        }
    };
};
