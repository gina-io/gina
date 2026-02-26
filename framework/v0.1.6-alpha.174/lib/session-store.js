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
 * @param {object} session        - Session configuration object (`session.name` must match a connector key)
 * @param {string} session.name   - Connector name (e.g. `'couchbase'`)
 * @returns {object} Connector session-store instance (express-session compatible)
 * @throws {Error} When the connector or its session-store file cannot be found
 */
function SessionStore(session) {

    var ctx                 = getContext()
        , bundle            = ctx.bundle
        , env               = ctx.env
        , conf              = getConfig()[bundle][env]
        , connectorsPath    = conf.connectorsPath
        , connector         = null
    ;
    try {
        connector         = conf.content.connectors[session.name].connector;
    } catch (err) {
        throw new Error('[SessionStore] Could not be loaded: Connector issue. Please check your bundle configuration @config/connectors.json\n'+ err.stack);
    }

    var connectorName = 'couchbase';
    var filename = _(connectorsPath + '/'+ connector +'/lib/session-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('[SessionStore] Could not be loaded: `'+ filename+'` is missing');
    }

    return require(filename)(session, bundle)
};

module.exports = SessionStore;