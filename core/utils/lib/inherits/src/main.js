/**
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @class Inherits
 *
 * @package gina.utils
 * @namesame gina.utils.inherits
 * @author Rhinostone <gina@rhinostone.com>
 *
 * @api Public
 * */
function Inherits(a, b) {

    /**
     * init
     * @constructor
     * */
    var init = function(a, b) {
        var err = check(a, b);


        if (!err) {

            var z = (function() {
                var _inherited = false, cache = a;

                if (!_inherited) {
                    _inherited = true;

                    return function() {

                        if (this) {
                            this.prototype = cache.prototype;

                            if (!this.name) this.name = cache.name;

                            this.prototype.name = this.name;

                            //makes it compatible with node.js classes like EventEmitter
                            for (var prop in b.prototype) {
                                if (!this[prop] /**&& prop != 'instance'*/) {// all but instances
                                    this[prop] = b.prototype[prop]
                                }
                            }

                            b.apply(this, arguments);
                            cache.apply(this, arguments);
                        }
                    }
                }

            }(a, b));

            //makes it compatible with node.js classes like EventEmitter
            if (a.prototype == undefined) {
                a.prototype = {}
            }

            if (b.prototype == undefined) {
                b.prototype = {}
            }

            a.prototype = Object.create(b.prototype, {});
            z.prototype = Object.create(a.prototype, {}); //{ name: { writable: true, configurable: true, value: name }

            return z
        } else {
            throw new Error(err)
        }
    }

    var check = function(a, b) {
        if ( typeof(a) == 'undefined' || typeof(b) == 'undefined') {
            return 'inherits(a, b): neither [ a ] nor [ b ] can\'t be undefined or null'
        }
        return false
    }

    return init
};


if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Inherits()
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return Inherits() })
}
