/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs          = require('fs');

//var inherits = require(require.resolve('./inherits'));
var helpers = require('./../helpers');
var console = require('./logger');

/**
 * @module lib/session-store
 * @description Thin factory that loads the connector-specific session store
 * implementation from `<connectorsPath>/<connector>/lib/session-store.js`.
 * Wraps the underlying `express-session` compatible store so the framework
 * can swap session backends without changing application code.
 *
 * Do not call this directly — configure the session backend in
 * `config/connectors.json` and let the framework instantiate it.
 */

/**
 * Load and return the connector-specific session store.
 *
 * @class SessionStore
 * @constructor
 *
 * @param {object} session        - The `express-session` module. Its `.name` property
 *                                  (i.e. `'session'`) is used as the key in `connectors.json`
 *                                  that identifies the session backend.
 *                                  The module's `.Store` property is used as the base class.
 * @param {string} session.name   - Resolved from `express-session`'s function name (`'session'`).
 *                                  The bundle must declare a `"session"` entry in
 *                                  `config/connectors.json` whose `.connector` field selects
 *                                  the implementation (e.g. `'couchbase'`, `'redis'`).
 * @returns {function}            - Connector-specific Store constructor (express-session compatible).
 * @throws {Error}                - When the connector config or its session-store file cannot be found.
 */
function SessionStore(session) {

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        // #B10 fix: conf.connectorsPath is never populated by config.js.
        // Use GINA_FRAMEWORK_DIR directly, mirroring the pattern used in lib/model.js and core/model/index.js.
        , connectorsPath    = GINA_FRAMEWORK_DIR + '/core/connectors'
        , connector         = null
    ;
    try {
        connector         = conf.content.connectors[session.name].connector;
    } catch (err) {
        throw new Error('[SessionStore] Could not be loaded: Connector issue. Please check your bundle configuration @config/connectors.json\n'+ err.stack);
    }

    var filename = _(connectorsPath + '/'+ connector +'/lib/session-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[SessionStore] Could not be loaded: `'+ filename+'` is missing');
    }

    var result = require(filename)(session, bundle);
    console.debug('[session-store] loaded connector=' + connector + ' bundle=' + bundle);
    return result;
};

module.exports = SessionStore;