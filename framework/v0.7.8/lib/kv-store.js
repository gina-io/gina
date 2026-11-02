/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs      = require('fs');
var helpers = require('./../helpers');
var console = require('./logger');
/**
 * @module lib/kv-store
 * @description Thin factory that loads the connector-specific KV namespace
 * store from `<connectorsPath>/<connector>/lib/kv-store.js` and returns a
 * ready backend for `lib/kv` — the `lib/job-store` / `lib/audit-store` /
 * `lib/render-cache-store` / `lib/storage-store` sibling for the KV
 * primitive (#KV1).
 *
 * The returned object must implement the `KvStoreContract` typedef declared
 * in `lib/kv` (promise-returning, opaque STRING values — the facade owns JSON
 * serialization) including the atomicity each verb owes: `setnx` is
 * set-if-absent, `consume` is read-AND-delete in one operation, `compareDel`
 * deletes only on strict equality with the stored string, and `incrby` is an
 * atomic integer add that must reject on a non-integer stored value.
 * Per-namespace key-prefixing is the implementation's duty — the namespace
 * name is passed so two namespaces may share one connectors.json entry
 * without colliding.
 *
 * Do not call this directly — declare the backend in `config/connectors.json`,
 * point `settings.json`'s `kv.namespaces.<name>.store` at that entry name, and
 * let `gna.js` wire it at boot (before the first request; namespace
 * installation is once-only).
 *
 * NOTE: two connectors ship an implementation —
 * `redis` (`core/connectors/redis/lib/kv-store.js`, shared across HOSTS) and
 * `sqlite` (`core/connectors/sqlite/lib/kv-store.js`, zero-dependency and
 * durable, shared across PROCESSES on one host). The rest remain demand-gated
 * (the `lib/audit-store` shipping order), and naming one of them as a
 * namespace's `store` refuses the boot with a clear message. The in-memory
 * backend (no `store` key) stays the zero-config path, and is
 * single-process: two bundles — or two replicas — needing one shared
 * namespace want a connector-backed store, which is exactly this seam.
 */
/**
 * Resolve `connName` against the bundle's `connectors.json` and build the
 * connector-specific KV namespace store.
 *
 * @class KvStore
 * @constructor
 *
 * @param {string} connName      - `connectors.json` entry name (referenced by
 *                                 `settings.json`'s `kv.namespaces.<name>.store`).
 *                                 The entry's `.connector` field selects the
 *                                 implementation (a connector without a
 *                                 `lib/kv-store.js` is rejected).
 * @param {string} namespaceName - KV namespace this store will back. Passed
 *                                 through to the implementation, which uses it
 *                                 to PREFIX its keys.
 * @returns {object}             - A `KvStoreContract` instance (see `lib/kv`).
 * @throws {Error}               - When the entry is missing, has no `connector`
 *                                 field, or the connector has no kv-store
 *                                 implementation. `gna.js` treats a throw as
 *                                 fatal — an explicitly configured store must
 *                                 build, never degrade silently to the
 *                                 in-memory backend, which would put the data
 *                                 somewhere the operator did not ask for.
 *
 * @example
 *   // settings.json:    { "kv": { "namespaces": { "tokens": { "store": "kvRedis" } } } }
 *   // connectors.json:  { "kvRedis": { "connector": "redis", "host": "127.0.0.1",
 *   //                                  "port": 6379 } }
 *   var store = new KvStore('kvRedis', 'tokens'); // done by gna.js at boot
 */
function KvStore(connName, namespaceName) {

    if (typeof connName !== 'string' || connName.length === 0) {
        throw new Error('[KvStore] a connectors.json entry name is required (got: ' + JSON.stringify(connName) + ')');
    }

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        // Same resolution as lib/session-store / lib/job-store / lib/audit-store /
        // lib/storage-store (#B10 fix): conf.connectorsPath is never populated by
        // config.js — use GINA_FRAMEWORK_DIR directly.
        , connectorsPath    = GINA_FRAMEWORK_DIR + '/core/connectors'
        , connConf          = null
        , connector         = null
    ;
    try {
        connConf  = conf.content.connectors[connName];
        connector = connConf.connector;
    } catch (err) {
        throw new Error('[KvStore] could not resolve `' + connName + '`: check your bundle configuration @config/connectors.json\n' + err.stack);
    }
    if (!connector) {
        throw new Error('[KvStore] connectors.json entry `' + connName + '` has no `connector` field');
    }

    var filename = _(connectorsPath + '/' + connector + '/lib/kv-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[KvStore] connector `' + connector + '` has no kv-store implementation (`' + filename + '` is missing)');
    }

    var store = require(filename)(connConf, bundle, namespaceName);
    console.debug('[kv-store] loaded connector=' + connector + ' bundle=' + bundle + ' namespace=' + namespaceName + ' (entry: ' + connName + ')');
    return store;
};

module.exports = KvStore;
