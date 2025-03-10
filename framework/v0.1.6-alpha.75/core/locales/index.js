/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs              = require('fs');

/**
 * Gina.Core.Locales Class
 *
 * @package    Gina.Core
 * @author     Rhinostone <contact@gina.io>
 */

function Locales() {

    var _require = function(path) {
        var cacheless = (process.env.NODE_ENV_IS_DEV == 'false') ? false : true;
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

    /**
     * init
     *
     * return {array} regions collection
     * */
    var init  = function () {

        var dir         = __dirname + '/dist/region' // regions by language
            , files     = fs.readdirSync(dir)
            , i         = 0
            , key       = null
            , regions   = []
        ;

        for (var f = 0, len = files.length; f < len; ++f) {
            if ( ! /^\./.test(files[f]) || f == len-1 ) {
                key         = files[f].split(/\./)[0];
                regions[i]  = { lang: key, content: _require( dir + '/' + files[f] ) };
                ++i
            }
        }


        return regions
    }


    return init()
};

module.exports = Locales()