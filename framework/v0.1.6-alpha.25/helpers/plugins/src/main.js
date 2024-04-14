/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

 var fs = require('fs');
/**
 * PluginsHelper
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

module.exports = function(loadedPlugins){
    for (let plugin in loadedPlugins) {
        switch (plugin) {
            case 'Validator':
                // Global
                // TODO - load from `loadedPlugins[plugin].helpers { 'ApiError': 'api-error'}
                if ( typeof(ApiError) == 'undefined')
                    ApiError = require('./api-error');
                break;

            default:
                break;
        }
    }
};//EO JSONHelper.
