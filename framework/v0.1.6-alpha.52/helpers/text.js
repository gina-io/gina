/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * TextHelper
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */

module.exports = function(){

    /**
     * @todo
     * __ Translate a given string into the i18n for local value
     *
     * @returns {string} i18nValue Return the translated string
     * */
    __ = function(str){
        var self = __;

    };

    __.prototype.split = function(patt){
        var self = __;
        if (typeof(patt) == "undefined") return self;

        return self.split(patt);
    };



};//EO TextHelper.

/**
 * trim prototype
 *
 * @returns {string} result
 * */
if (!String.prototype.trim) {
    String.prototype.trim = function(){
        return this.replace(/^\s+|\s+$/g, '');
    }
}

/**
 * ltrim prototype
 *
 * @returns {string} result
 * */
String.prototype.ltrim=function(){return this.replace(/^\s+/,'');};

/**
 * rtrim prototype
 *
 * @returns {string} result
 * */
String.prototype.rtrim=function(){return this.replace(/\s+$/,'');};

/**
 * gtrim prototype - Global / full trim
 *
 * @returns {string} result
 * */
String.prototype.gtrim=function(){return this.replace(/(?:(?:^|\n)\s+|\s+(?:$|\n))/g,'').replace(/\s+/g,' ');};