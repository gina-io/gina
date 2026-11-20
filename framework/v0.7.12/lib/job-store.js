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
 * @module lib/job-store
 * @description Thin factory that loads the connector-specific job-store
 * implementation from `<connectorsPath>/<connector>/lib/job-store.js` and
 * returns a ready `JobStore` instance for `lib/job`'s `start({ store })` —
 * the `lib/session-store` sibling for the async-job primitive (#AI6).
 *
 * Do not call this directly — declare the backend in `config/connectors.json`,
 * point `app.json`'s `jobs.store` at that entry name, and let `gna.js` wire it
 * at boot (before the first `create()`, since store adoption is once-only).
 */

/**
 * Resolve `connName` against the bundle's `connectors.json` and build the
 * connector-specific job store.
 *
 * @class JobStore
 * @constructor
 *
 * @param {string} connName - `connectors.json` entry name (referenced by `app.json`'s
 *                            `jobs.store`). The entry's `.connector` field selects the
 *                            implementation (`sqlite` ships first; a connector without a
 *                            `lib/job-store.js` is rejected).
 * @returns {object}        - A `JobStore` instance (`set/get/remove/list/sweep`).
 * @throws {Error}          - When the entry is missing, has no `connector` field, or the
 *                            connector has no job-store implementation. `gna.js` treats a
 *                            throw as fatal — an explicitly configured store must build,
 *                            never degrade silently to the memory store.
 *
 * @example
 *   // app.json:        { "jobs": { "store": "jobsDb" } }
 *   // connectors.json: { "jobsDb": { "connector": "sqlite", "file": "/data/jobs.db" } }
 *   var store = new JobStore('jobsDb'); // done by gna.js at boot
 */
function JobStore(connName) {

    if (typeof connName !== 'string' || connName.length === 0) {
        throw new Error('[JobStore] a connectors.json entry name is required (got: ' + JSON.stringify(connName) + ')');
    }

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        // Same resolution as lib/session-store (#B10 fix): conf.connectorsPath is
        // never populated by config.js — use GINA_FRAMEWORK_DIR directly.
        , connectorsPath    = GINA_FRAMEWORK_DIR + '/core/connectors'
        , connConf          = null
        , connector         = null
    ;
    try {
        connConf  = conf.content.connectors[connName];
        connector = connConf.connector;
    } catch (err) {
        throw new Error('[JobStore] could not resolve `' + connName + '`: check your bundle configuration @config/connectors.json\n' + err.stack);
    }
    if (!connector) {
        throw new Error('[JobStore] connectors.json entry `' + connName + '` has no `connector` field');
    }

    var filename = _(connectorsPath + '/' + connector + '/lib/job-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[JobStore] connector `' + connector + '` has no job-store implementation (`' + filename + '` is missing)');
    }

    var store = require(filename)(connConf, bundle);
    console.debug('[job-store] loaded connector=' + connector + ' bundle=' + bundle + ' (entry: ' + connName + ')');
    return store;
};

module.exports = JobStore;
