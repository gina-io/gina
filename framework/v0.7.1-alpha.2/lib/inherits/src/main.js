'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/inherits
 * @description Prototype-chain inheritance helper compatible with Node.js built-ins
 * such as EventEmitter. Works as a CommonJS module and as an AMD module.
 *
 * Usage: `ChildClass = inherits(ChildClass, ParentClass)`
 *
 * The returned constructor calls `Parent.apply(this, args)` then
 * `Child.apply(this, args)` so both constructors run on every `new` call.
 *
 * @example
 * var inherits = require('lib/inherits');
 * function Dog(name) { this.name = name; }
 * Dog = inherits(Dog, EventEmitter);
 * new Dog('Rex') instanceof EventEmitter // true
 */

/**
 * Inheritance factory — returns the composed constructor `z`.
 * Exported as `inherits(a, b)` via `module.exports = Inherits()`.
 *
 * @function inherits
 * @param {function} a - Child constructor
 * @param {function} b - Parent constructor (e.g. `EventEmitter`)
 * @returns {function} Composed constructor that inherits `b`'s prototype
 * @throws {Error} When either `a` or `b` is undefined
 *
 * @memberof module:lib
 * @author  Rhinostone <contact@gina.io>
 * @api     Public
 */
function Inherits(a, b) {

    /**
     * Build and return the composed constructor.
     *
     * @inner
     * @param {function} a - Child constructor
     * @param {function} b - Parent constructor
     * @returns {function} Composed constructor `z`
     */
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
                                if (!this[prop]) {
                                    this[prop] = b.prototype[prop];
                                }
                            }

                            b.apply(this, arguments);
                            cache.apply(this, arguments);
                        }
                    };
                }

            }(a, b));

            //makes it compatible with node.js classes like EventEmitter
            if (a.prototype == undefined) {
                a.prototype = {};
            }

            if (b.prototype == undefined) {
                b.prototype = {};
            }

            a.prototype = Object.create(b.prototype, {});
            z.prototype = Object.create(a.prototype, {}); //{ name: { writable: true, configurable: true, value: name }

            return z;
        } else {
            throw new Error(err);
        }
    };

    var check = function(a, b) {
        if ( typeof(a) == 'undefined' || typeof(b) == 'undefined') {
            return 'inherits(a, b): neither [ a ] nor [ b ] can\'t be undefined or null'
        }
        return false;
    };

    return init;
}


if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Inherits();
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return Inherits(); });
}