/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Gina.Core.Dev Class
 * Must be loaded by hand.
 *
 * @package    Gina.Core
 * @author     Rhinostone <gina@rhinostone.com>
 */



/**
 * Get function arguments outside its context
 *
 * @return {}
 * */
Object.defineProperty( Function.prototype, 'getArguments', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    //configurable: true,
    value: function(){
        var r =  new RegExp("\(([^\)]+)\)");
        var found, i;
        return ((found = this.toString().match(r)[0]),(i = found.indexOf('(')+1),(found).substring(i)).replace(/ /,'').split(/,/);
    }
});

/**
 * Check if function has callbacks
 *
 * @return {object|boolean} callbacksObject|false
 * */
Object.defineProperty( Function.prototype, 'hasCallbacks', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    //configurable: true,
    value: function(func, args){
        var content = func.prop.removeComments();//func.name
//        var findOccurences = function(patt, content){
//
//        };
//        var a = [];
//        for (var i=0; i<args.length; ++i) {
//            //a.push(args[i])
//        }
        console.log("=> ", content);

        //return undefined;
    }
});

/**
 * Remove comments
 *
 * @return {}
 * */
Object.defineProperty( Object.prototype, 'removeComments', {
    writable:   false,
    enumerable: false,
    //If loaded several times, it can lead to an exception. That's why I put this.
    configurable: true,
    value: function(){
        var r =  new RegExp(/(?:\/\*(?:[\s\S]*?)\*\/)|(?:([\s;])+\/\/(?:.*)$)/gm);
        return this.toString().replace(r, '');
    }
});

//By default.
var dev = {
    tools : require('./lib/tools')(),
    Factory : require('./lib/factory'),
    Class   : require('./lib/class')
};

module.exports = dev;