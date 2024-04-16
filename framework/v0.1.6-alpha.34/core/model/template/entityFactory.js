/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
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
 * @author      Rhinostone <contact@gina.io>
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