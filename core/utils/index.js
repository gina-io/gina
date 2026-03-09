/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Gina.Core.Utils Class
 *
 * @package    Gina.Core
 * @author     Rhinostone <gina@rhinostone.com>
 */
var fs = require('fs');

function Utils() {

    var _require = function(path) {
        var cacheless       = ( typeof(process.env.IS_CACHELESS) != 'undefined' && process.env.IS_CACHELESS == 'true') ? true : false;
        var isScriptMode    = ( typeof(process.env.IS_SCRIPT_MODE) != 'undefined' ) ? true : false;

        if (cacheless) {
            try {

                delete require.cache[require.resolve(path)];
                return require(path)

            } catch (err) {
                throw err
            }

        } else {
            return require(path)
        }
    }


    var self =  {
        Config      : _require('./lib/config'),
        //dev     : require('./lib/dev'),//must be at the same level than gina.utils => gina.dev
        inherits    : _require('./lib/inherits'),
        helpers     : _require('./helpers'),
        //this one must move to Dev since it's dev related
        Model       : _require('./lib/model'),
        Collection  : _require('./lib/collection'),
        merge       : _require('./lib/merge'),
        generator   : _require('./lib/generator'),//move to gina.dev
        Proc        : _require('./lib/proc'),
        Shell       : _require('./lib/shell'),
        logger      : _require('./lib/logger'),
        math        : _require('./lib/math'),
        url         : _require('./lib/url'),
        routing     : _require('./lib/routing'),
        cmd         : _require('./lib/cmd')
    };

    /**
     * Clean files on directory read
     * Mac os Hack
     * NB.: use once in the server.js
     * TODO - remove it...
     **/
    self.cleanFiles = function(files){
        for(var f=0; f< files.length; f++){
            if(files[f].substring(0,1) == '.')
                files.splice(0,1);
        }
        return files;
    };

    return self
};

module.exports = Utils()