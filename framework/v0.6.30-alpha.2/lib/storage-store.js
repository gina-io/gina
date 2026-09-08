/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs          = require('fs');

var helpers = require('./../helpers');
var console = require('./logger');

/**
 * @module lib/storage-store
 * @description Thin factory that loads the connector-specific storage metadata
 * store from `<connectorsPath>/<connector>/lib/storage-store.js` and returns a
 * ready store for `lib/storage` — the `lib/job-store` / `lib/audit-store` /
 * `lib/render-cache-store` sibling for the object-storage layer (#STO1).
 *
 * The store holds the per-object metadata row (originalName, contentType,
 * size, createdAt) that backs `stat()` — and, since size tiering, the PAYLOAD
 * itself (`data`, a Buffer) for objects under the driver's `inlineThreshold`.
 * An implementation therefore needs a binary-safe field that round-trips
 * bytes exactly, and losing the store loses inline objects, not just their
 * metadata; file-backed objects keep their bytes in the driver's adapter.
 *
 * Since cas, a store backing a `cas` driver must ALSO implement the four
 * refcount verbs (`acquireRef`/`releaseRef`/`listZeroRefs`/`removeIfZero` —
 * contract in `lib/storage/src/meta-store.js`'s `StorageMetaStore` typedef,
 * including the per-key atomicity each owes and the multi-process sweep
 * residual). A `cas` driver refuses to build against a store lacking them;
 * `sharded` drivers need only the base four verbs.
 *
 * Do not call this directly — declare the backend in `config/connectors.json`,
 * point the driver's `settings.json` `storage.drivers.<name>.store` at that
 * entry name, and let `gna.js` wire it at boot (before the first `put()`, since
 * store adoption is once-only).
 *
 * NOTE: `couchbase` is the first connector to ship an implementation
 * (`core/connectors/couchbase/lib/storage-store.js`); the others remain
 * demand-gated (the `lib/audit-store` shipping order), and naming one of them
 * as a driver's `store` refuses the boot with a clear message. The embedded
 * SQLite backend (no `store` key) stays the zero-config path, and is
 * documented single-process-per-driver-root: two bundles — or two replicas —
 * sharing one root need a connector-backed store, which is exactly what this
 * seam is for.
 */

/**
 * Resolve `connName` against the bundle's `connectors.json` and build the
 * connector-specific storage metadata store.
 *
 * @class StorageStore
 * @constructor
 *
 * @param {string} connName   - `connectors.json` entry name (referenced by `settings.json`'s
 *                              `storage.drivers.<name>.store`). The entry's `.connector` field
 *                              selects the implementation (a connector without a
 *                              `lib/storage-store.js` is rejected).
 * @param {string} driverName - Storage driver this store will back. Passed through to the
 *                              implementation, which uses it to NAMESPACE its rows: without
 *                              it, two drivers pointing at one connectors entry would share
 *                              a key space and silently collide (cas blob keys are
 *                              content-derived and therefore identical across drivers, and
 *                              each driver writes its own `.driver` strategy stamp). With it,
 *                              sharing one entry across drivers is fully supported.
 * @returns {object}          - A `StorageMetaStore` instance (`set/get/remove/close`; rows may
 *                              carry an inline payload — see the typedef in
 *                              `lib/storage/src/meta-store.js` for the binary-safety contract).
 * @throws {Error}            - When the entry is missing, has no `connector` field, or the
 *                              connector has no storage-store implementation. `gna.js`
 *                              treats a throw as fatal — an explicitly configured store must
 *                              build, never degrade silently to the embedded backend, which
 *                              would put the metadata somewhere the operator did not ask for.
 *
 * @example
 *   // settings.json:    { "storage": { "drivers": { "assets": { "store": "assetsDb" } } } }
 *   // connectors.json:  { "assetsDb": { "connector": "couchbase", "host": "127.0.0.1",
 *   //                                   "database": "gina_storage" } }
 *   var store = new StorageStore('assetsDb', 'assets'); // done by gna.js at boot
 */
function StorageStore(connName, driverName) {

    if (typeof connName !== 'string' || connName.length === 0) {
        throw new Error('[StorageStore] a connectors.json entry name is required (got: ' + JSON.stringify(connName) + ')');
    }

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        // Same resolution as lib/session-store / lib/job-store / lib/audit-store
        // (#B10 fix): conf.connectorsPath is never populated by config.js — use
        // GINA_FRAMEWORK_DIR directly.
        , connectorsPath    = GINA_FRAMEWORK_DIR + '/core/connectors'
        , connConf          = null
        , connector         = null
    ;
    try {
        connConf  = conf.content.connectors[connName];
        connector = connConf.connector;
    } catch (err) {
        throw new Error('[StorageStore] could not resolve `' + connName + '`: check your bundle configuration @config/connectors.json\n' + err.stack);
    }
    if (!connector) {
        throw new Error('[StorageStore] connectors.json entry `' + connName + '` has no `connector` field');
    }

    var filename = _(connectorsPath + '/' + connector + '/lib/storage-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[StorageStore] connector `' + connector + '` has no storage-store implementation (`' + filename + '` is missing)');
    }

    var store = require(filename)(connConf, bundle, driverName);
    console.debug('[storage-store] loaded connector=' + connector + ' bundle=' + bundle + ' driver=' + driverName + ' (entry: ' + connName + ')');
    return store;
};

module.exports = StorageStore;
