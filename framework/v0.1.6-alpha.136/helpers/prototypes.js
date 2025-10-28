function PrototypesHelper(instance) {

    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;

    var local = instance || null;
    var envVars = null;
    // since for some cases we cannot use gina envVars directly
    if (
        typeof(GINA_DIR) == 'undefined'
        && !isGFFCtx
        && typeof(process) != 'undefined'
        && process.argv.length > 3
    ) {
        if ( /^\{/.test(process.argv[2]) ) {
            envVars = JSON.parse(process.argv[2]).envVars;
        }
        // minions case
        else if ( /\.ctx$/.test(process.argv[2]) ) {
            var fs = require('fs');
            var envVarFile = process.argv[2].split(/\-\-argv\-filename\=/)[1];
            envVars = JSON.parse(fs.readFileSync(envVarFile).toString()).envVars;
        }

    }
    // else if (isGFFCtx) {
    //     envVars = window;
    // }


    // dateFormat proto
    if ( local && typeof(local) != 'undefined' && typeof(local.dateFormat) != 'undefined' ) {
        for (let method in local.dateFormat) {

            if ( typeof(Date[method]) != 'undefined' )
                continue;

            Object.defineProperty( Date.prototype, method, {
                writable:   false,
                enumerable: false,
                //If loaded several times, it can lead to an exception. That's why I put this.
                configurable: true,
                value: function() {

                    var newArgs = { 0: this }, i = 1;
                    for (var a in arguments) {
                        newArgs[i] = arguments[a];
                        ++i
                    }
                    newArgs.length = i;
                    // don't touch this, we need the name
                    const name = method;

                    return local.dateFormat[name].apply(this, newArgs );
                }
            });

        }
    }



    if ( typeof(Array.clone) == 'undefined' ) {
        /**
         * clone array
         *
         * @returns {array} Return cloned array
         * @supress {misplacedTypeAnnotation}
         **/
        Object.defineProperty( Array.prototype, 'clone', {
            writable:   false,
            enumerable: false,
            //If loaded several times, it can lead to an exception. That's why I put this.
            configurable: true,
            value: function(){ return this.slice(0); }
        });
    }

    if ( typeof(JSON.clone) == 'undefined' && !isGFFCtx ) {
        if ( typeof(envVars) != 'undefined' && envVars != null ) {
            JSON.clone = require( envVars.GINA_DIR +'/utils/prototypes.json_clone');
        } else {
            // For unit tests
            if (!envVars) {
                var ginaDir = process.cwd().match(/.*\/gina/)[0];
                require(ginaDir +'/utils/helper');
                setEnvVar('GINA_DIR', ginaDir, true);
                envVars = getEnvVars();
            }

            // JSON.clone = require( GINA_DIR +'/utils/prototypes.json_clone');
            JSON.clone = require( getEnvVar('GINA_DIR') +'/utils/prototypes.json_clone');
        }
    }

    if ( typeof(JSON.escape) == 'undefined' ) {
        /**
         * JSON.escape
         * Escape special characters
         *
         * Changes made here must be reflected in:
         *  - gina/utils/prototypes.js
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


    if ( typeof(Array.toString) == 'undefined' ) {
        Array.prototype.toString = function(){
            return this.join();
        };
    }

    if ( typeof(Array.inArray) == 'undefined' ) {
        Object.defineProperty( Array.prototype, 'inArray', {
            writable:   false,
            enumerable: false,
            //If loaded several times, it can lead to an exception. That's why I put this.
            configurable: true,
            value: function(o){ return this.indexOf(o)!=-1 }
        });
    }

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

    if ( typeof(Object.count) == 'undefined' ) {
        Object.defineProperty( Object.prototype, 'count', {
            writable:   true,
            enumerable: false,
            //If loaded several times, it can lead to an exception. That's why I put this.
            configurable: true,
            value: function(){
                var i = 0;
                try {
                    var self = this;
                    if (this instanceof String) self = JSON.parse(this);

                    for (var prop in this)
                        if (this.hasOwnProperty(prop)) ++i;

                    return i;
                } catch (err) {
                    return i;
                }

            }
        });
    }



    if ( typeof(global) != 'undefined' && typeof(global.__stack) == 'undefined' ) {
        /**
         * __stack Get current stack
         * @returns {Object} stack Current stack
         * @suppress {es5Strict}
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
                /** @suppress {es5Strict} */
                Error.captureStackTrace(err, arguments.callee);
                var stack = err.stack;
                Error.prepareStackTrace = orig;
                return stack;
            }
        });
    }


}

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = PrototypesHelper
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return PrototypesHelper })
}
