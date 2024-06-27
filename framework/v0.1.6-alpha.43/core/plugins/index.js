/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Gina.Core.Plugins Class
 *
 * @package    Gina.Core
 * @author     Rhinostone <contact@gina.io>
 */

function Plugins() {

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


    var self =  {
        Validator   : _require('./lib/validator')
    };

    return self
};

module.exports = Plugins()