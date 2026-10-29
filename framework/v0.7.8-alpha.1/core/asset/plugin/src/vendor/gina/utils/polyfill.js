/**
 * Object.assign
 * Ref.: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/assign
 *
 */
if (typeof Object.assign !== 'function') {
    // Must be writable: true, enumerable: false, configurable: true
    Object.defineProperty(Object, "assign", {
        value: function assign(target, varArgs) { // .length of function is 2
            'use strict';
            if (target === null || target === undefined) {
                throw new TypeError('Cannot convert undefined or null to object');
            }

            var to = Object(target);
            for (var index = 1; index < arguments.length; index++) {
                var nextSource = arguments[index];

                if (nextSource !== null && nextSource !== undefined) {
                for (var nextKey in nextSource) {
                    // Avoid bugs when hasOwnProperty is shadowed
                    if (Object.prototype.hasOwnProperty.call(nextSource, nextKey)) {
                    to[nextKey] = nextSource[nextKey];
                    }
                }
                }
            }
            return to;
        },
        writable: true,
        configurable: true
    });
}

if ( typeof(JSON.clone) == 'undefined' ) {
    /**
     * JSON.clone
     * Clone JSON object
     *
     * Changes made here must be reflected in:
     *  - gina/lib/prototypes.js
     *  - gina/framework/version/helpers/prototypes.js
     *  - gina/framework/version/core/asset/plugin/src/vendor/gina/js/utils/polyfill.js
     *
     * @param {object} source
     * @param {object} [target]
     *
     * @returns {object} cloned JSON object
     **/
    var clone = function(source, target) {
        if (source == null || typeof source != 'object') return source;
        if (source.constructor != Object && source.constructor != Array) return source;
        if (source.constructor == Date || source.constructor == RegExp || source.constructor == Function ||
            source.constructor == String || source.constructor == Number || source.constructor == Boolean)
            return new source.constructor(source);

        target = target || new source.constructor();
        var i       = 0
            , len   = Object.getOwnPropertyNames(source).length || 0
            , keys  = Object.keys(source)
        ;

        while (i<len) {
            target[keys[i]] = (typeof target[keys[i]] == 'undefined') ? clone(source[keys[i]], null) : target[keys[i]];
            i++;
        }
        i = null; len = null; keys = null;

        return target;
    };

    JSON.clone = clone;
    // WHY NOT USE SOMETHING ELSE ?
    // Could have been fine, but not working when you have references pointg to another object
    // return Object.assign({}, source);

    // Performences issue
    //return JSON.parse(JSON.stringify(source));
}

if ( typeof(JSON.escape) == 'undefined' ) {
    /**
     * JSON.escape
     * Escape special characters
     *
     * Changes made here must be reflected in:
     *  - gina/lib/prototypes.js
     *  - gina/framework/version/helpers/prototypes.js
     *  - gina/framework/version/core/asset/plugin/src/vendor/gina/js/utils/polyfill.js
     *
     * @param {object} jsonStr
     *
     * @returns {object} escaped JSON string
     **/
     var escape = function(jsonStr){
        try {
            return jsonStr
                       .replace(/\n/g, "\\n")
                       .replace(/\r/g, "\\r")
                       .replace(/\t/g, "\\t")
                   ;
        } catch (err) {
           throw err;
        }
    };

    JSON.escape = escape;
}