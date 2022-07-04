/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs = require('fs');
/**
 * @module Helpers
 *
 * Gina Utils Helpers
 *
 * @package     Gina.Utils
 * @namespace   Gina.Utils.Helpers
 * @author      Rhinostone <gina@rhinostone.com>
 */
var _require = function(path) {
    var cacheless = (process.env.IS_CACHELESS == 'false') ? false : true;
    if ( cacheless && !/context/.test(path) ) { // all but the context
        try {
            delete require.cache[require.resolve(path)];
            return require(path)
        } catch (err) {
            throw err;
            return {}
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
    , helper        = '';

for (; f < len; ++f) {
    if ( ! /^\./.test(files[f]) && files[f] != 'index.js') {
        helper          = files[f].replace(/.js/, '');
        helpers[helper] = _require('./' + helper)()
    }
}

module.exports = helpers;


/**
 * Format date
 * @return {array} Return formated date
 **/
Object.defineProperty( Date.prototype, 'format', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(mask, utc){ return helpers.dateFormat.format(this, mask, utc) }
});
/**
 * Count days between current & dateTo
 * @return {array} Return formated date
 **/
Object.defineProperty( Date.prototype, 'countDaysTo', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(dateTo){ return helpers.dateFormat.countDaysTo(this, dateTo) }
});
/**
 * Get days between current & dateTo
 * @return {array} Return formated date
 **/
Object.defineProperty( Date.prototype, 'getDaysTo', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(dateTo, mask){ return helpers.dateFormat.getDaysTo(this, dateTo, mask) }
});

/**
 * Get days in the current month date
 * @return {array} Return days
 **/
Object.defineProperty( Date.prototype, 'getDaysInMonth', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(){ return helpers.dateFormat.getDaysInMonth(this) }
});

/**
 * Add or subtract hours from current date
 * @param {number} h
 * @return {date} Return date
 **/
Object.defineProperty( Date.prototype, 'addHours', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(h){ return helpers.dateFormat.addHours(this, h) }
});

/**
 * clone array
 * @return {array} Return cloned array
 **/
Object.defineProperty( Array.prototype, 'clone', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(){ return this.slice(0) }
});

/***/
Array.prototype.toString = function(){
    return this.join();
};


Object.defineProperty( Array.prototype, 'inArray', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(o){ return this.indexOf(o)!=-1 }
});

if ( typeof(Array.from) == 'undefined' ) { // if not under ES6

    Object.defineProperty( Array.prototype, 'from', {
        writable:   false,
        enumerable: false,
        //If loaded several times, it can lead to an exception. That's why I put this.
        configurable: true,
        value: function(a){
            var seen    = {}
                , out   = []
                , len   = a.length
                , j     = 0;

            for(var i = 0; i < len; i++) {
                var item = a[i];
                if(seen[item] !== 1) {
                    seen[item] = 1;
                    out[j++] = item
                }
            }

            return out
        }
    });
}

Object.defineProperty( Object.prototype, 'count', {
    writable:   true,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(){
        try {
            var self = this;
            if (this instanceof String) self = JSON.parse(this);
            var i = 0;
            for (var prop in this)
                if (this.hasOwnProperty(prop)) ++i;

            return i;
        } catch (err) {
            return i
        }

    }
});

/**
 * __stack Get current stack
 * @return {Object} stack Current stack
 **/
Object.defineProperty(global, '__stack', {
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    get: function(){
        var orig = Error.prepareStackTrace;
        Error.prepareStackTrace = function(_, stack){
            return stack;
        };
        var err = new Error;
        Error.captureStackTrace(err, arguments.callee);
        var stack = err.stack;
        Error.prepareStackTrace = orig;
        return stack;
    }
});