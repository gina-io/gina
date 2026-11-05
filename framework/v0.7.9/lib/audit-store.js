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
 * @module lib/audit-store
 * @description Thin factory that loads the connector-specific audit-store
 * implementation from `<connectorsPath>/<connector>/lib/audit-store.js` and
 * returns a ready store for `lib/audit` — the `lib/job-store` /
 * `lib/render-cache-store` sibling for the audit trail (#COMPLY2).
 *
 * Do not call this directly — declare the backend in `config/connectors.json`,
 * point `settings.json`'s `audit.store` at that entry name, and let
 * `core/server.js` wire it at boot (before the first `write()`, since store
 * adoption is once-only).
 *
 * NOTE: no connector ships an audit-store implementation yet — connector
 * backends are demand-gated (sqlite first, per the job-store shipping order).
 * Configuring `audit.store` today therefore refuses the boot with a clear
 * message; the default file JSONL backend (no `store` key) is the v1 path.
 */

/**
 * Resolve `connName` against the bundle's `connectors.json` and build the
 * connector-specific audit store.
 *
 * @class AuditStore
 * @constructor
 *
 * @param {string} connName - `connectors.json` entry name (referenced by `settings.json`'s
 *                            `audit.store`). The entry's `.connector` field selects the
 *                            implementation (a connector without a `lib/audit-store.js`
 *                            is rejected).
 * @returns {object}        - An `AuditStore` instance (`append/close`).
 * @throws {Error}          - When the entry is missing, has no `connector` field, or the
 *                            connector has no audit-store implementation. `core/server.js`
 *                            treats a throw as fatal — an explicitly configured store must
 *                            build, never degrade silently to the file backend.
 *
 * @example
 *   // settings.json:   { "audit": { "enabled": true, "store": "auditDb" } }
 *   // connectors.json: { "auditDb": { "connector": "sqlite", "file": "/data/audit.db" } }
 *   var store = new AuditStore('auditDb'); // done by core/server.js at boot
 */
function AuditStore(connName) {

    if (typeof connName !== 'string' || connName.length === 0) {
        throw new Error('[AuditStore] a connectors.json entry name is required (got: ' + JSON.stringify(connName) + ')');
    }

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        // Same resolution as lib/session-store / lib/job-store (#B10 fix):
        // conf.connectorsPath is never populated by config.js — use
        // GINA_FRAMEWORK_DIR directly.
        , connectorsPath    = GINA_FRAMEWORK_DIR + '/core/connectors'
        , connConf          = null
        , connector         = null
    ;
    try {
        connConf  = conf.content.connectors[connName];
        connector = connConf.connector;
    } catch (err) {
        throw new Error('[AuditStore] could not resolve `' + connName + '`: check your bundle configuration @config/connectors.json\n' + err.stack);
    }
    if (!connector) {
        throw new Error('[AuditStore] connectors.json entry `' + connName + '` has no `connector` field');
    }

    var filename = _(connectorsPath + '/' + connector + '/lib/audit-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[AuditStore] connector `' + connector + '` has no audit-store implementation (`' + filename + '` is missing)');
    }

    var store = require(filename)(connConf, bundle);
    console.debug('[audit-store] loaded connector=' + connector + ' bundle=' + bundle + ' (entry: ' + connName + ')');
    return store;
};

module.exports = AuditStore;
