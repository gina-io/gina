/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var {Entity}Entity;
/**
 * @class Model.{Model}.{Entity}Entity class
 *
 *
 * @package     Gina
 * @namespace   Gina.Model.{Model}
 * @author      Rhinostone <gina@rhinostone.com>
 * @api         Public
 */

{Entity}Entity = function(configuration){

    var _this = this;

    this.getConfig = function(){
        console.log("{Entity}Entity super ON !", configuration);
        return configuration
    }
};

module.exports = {Entity}Entity