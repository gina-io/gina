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
 * @module lib/render-cache-store
 * @description Thin factory that loads the connector-specific render-cache L2
 * implementation from `<connectorsPath>/<connector>/lib/render-cache-store.js`
 * and returns a ready store for `lib/render-cache`'s redis strategy — the
 * `lib/job-store` sibling for the output cache (render-cache Slice 4).
 *
 * Do not call this directly — declare the backend in `config/connectors.json`,
 * point `settings.json`'s `server.cache.store` at that entry name, and let
 * `gna.js` wire it at boot (once, before the first request), stashing the built
 * store on `process.gina._renderCacheStore`.
 */

/**
 * Resolve `connName` against the bundle's `connectors.json` and build the
 * connector-specific render-cache L2 store.
 *
 * @class RenderCacheStore
 * @constructor
 *
 * @param {string} connName - `connectors.json` entry name (referenced by `settings.json`'s
 *                            `server.cache.store`). The entry's `.connector` field selects the
 *                            implementation (`redis` ships first; a connector without a
 *                            `lib/render-cache-store.js` is rejected).
 * @returns {object}        - A render-cache L2 store (`set/warmRead/del/close`).
 * @throws {Error}          - When the entry is missing, has no `connector` field, or the
 *                            connector has no render-cache-store implementation. `gna.js`
 *                            treats a throw as fatal — an explicitly configured store must
 *                            build, never degrade silently to memory-only.
 *
 * @example
 *   // settings.json:   { "server": { "cache": { "type": "redis", "store": "cacheRedis" } } }
 *   // connectors.json: { "cacheRedis": { "connector": "redis", "host": "127.0.0.1", "port": 6379 } }
 *   var store = new RenderCacheStore('cacheRedis'); // done by gna.js at boot
 */
function RenderCacheStore(connName) {

    if (typeof connName !== 'string' || connName.length === 0) {
        throw new Error('[RenderCacheStore] a connectors.json entry name is required (got: ' + JSON.stringify(connName) + ')');
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
        throw new Error('[RenderCacheStore] could not resolve `' + connName + '`: check your bundle configuration @config/connectors.json\n' + err.stack);
    }
    if (!connector) {
        throw new Error('[RenderCacheStore] connectors.json entry `' + connName + '` has no `connector` field');
    }

    var filename = _(connectorsPath + '/' + connector + '/lib/render-cache-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[RenderCacheStore] connector `' + connector + '` has no render-cache-store implementation (`' + filename + '` is missing)');
    }

    var store = require(filename)(connConf, bundle);
    console.debug('[render-cache-store] loaded connector=' + connector + ' bundle=' + bundle + ' (entry: ' + connName + ')');
    return store;
};

module.exports = RenderCacheStore;
