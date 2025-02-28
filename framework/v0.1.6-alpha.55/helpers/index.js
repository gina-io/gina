/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs = require('fs');
/**
 * @module Helpers
 *
 * Gina Lib Helpers
 *
 * @package     Gina.Lib
 * @namespace   Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 */
var _require = function(path) {
    var cacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
    if ( cacheless && !/context/.test(path) ) { // all but the context
        try {
            delete require.cache[require.resolve(path)];
            return require(path)
        } catch (err) {
            throw err;
        }

    } else {
        return require(path)
    }
};


var helpers         = {}
    , path          = __dirname
    , files         = fs.readdirSync(path)
    , f             = 0
    , len           = files.length
    , helper        = ''
    , amdDefined    = []
;

var PrototypesHelper = null, PluginsHelper = null;
// loading main helpers
for (; f < len; ++f) {
    if ( ! /^\./.test(files[f]) && files[f] != 'index.js') {
        helper          = files[f].replace(/.js/, '');
        if (/prototypes/i.test(helper)) {
            PrototypesHelper = _require('./' + helper);
            continue;
        }
        if (/plugins/i.test(helper)) {
            PluginsHelper = _require('./' + helper);
            continue;
        }
        helpers[helper] = _require('./' + helper)();
    }
}

new PrototypesHelper({
    dateFormat: helpers.dateFormat
});

// loading plugins helpers
if (
    typeof(getContext) != 'undefined'
    && typeof(getContext().gina) != 'undefined'
) {
    new PluginsHelper(getContext('gina').plugins);
}
// adding ApiError to helper in case Validator plugin is not loaded
if ( typeof(getContext) != 'undefined' && typeof(ApiError) == 'undefined' /*&& typeof(helpers.ApiError) == 'undefined'*/ ) {
    //helpers.ApiError = require('./plugins/src/api-error');
    ApiError = require('./plugins/src/api-error');
}

// loading `gina/utils/helper` if not yet loaded
if ( typeof(getTmpDir) == 'undefined' ) {
    _require(__dirname + '/../../../utils/helper')
}

// Publish as node.js module
module.exports = helpers;
