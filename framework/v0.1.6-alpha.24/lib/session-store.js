/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs          = require('fs');

//var inherits = require(require.resolve('./inherits'));
var helpers = require('./../helpers');
var console = require('./logger');

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
        throw new Error('SessionStore could not be loaded: Connector issue. Please check your bundle configuration @config/connectors.json\n'+ err.stack);
    }

    var connectorName = 'couchbase';
    var filename = _(connectorsPath + '/'+ connector +'/lib/session-store.js', true);

    if ( !fs.existsSync(filename) ) {
        throw new Error('SessionStore could not be loaded: `'+ filename+'` is missing');
    }

    return require(filename)(session, bundle)
};

module.exports = SessionStore;