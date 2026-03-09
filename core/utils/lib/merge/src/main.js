function Merge() {
    var newTarget = [];
    /**
     *
     * @param {object} target - Target object
     * @param {object} source - Source object
     * @param {boolean} [override] - Override when copying
     *
     * @return {object} [result]
     * */
    var browse = function (target, source) {

        if ( typeof(target) == 'undefined' ) {
            target = ( typeof(source) != 'undefined' && Array.isArray(source)) ? [] : {}
        }

        var override = false;
        if (( typeof(arguments[arguments.length-1]) == 'boolean' )) {
            override = arguments[arguments.length-1]
        }

        var i = 1;
        var length = arguments.length;

        var options, name, src, copy, copyIsArray, clone;



        // Handle case when target is a string or something (possible in deep copy)
        if (typeof(target) !== 'object' && typeof(target) !== 'function') {
            if (override) {
                if (typeof(arguments[2]) == 'undefined') {
                    target = arguments[1]
                } else {
                    target = arguments[2]
                }
            } else {
                if (typeof(arguments[0]) == 'undefined') {
                    target = arguments[1]
                } else {
                    target = arguments[0]
                }
            }

        } else {

            for (; i < length; i++) {
                // Only deal with non-null/undefined values
                if ( typeof(arguments[i]) != 'boolean' && ( options = arguments[i]) != null) {
                    if ( typeof(options) != 'object') {
                       target = options;
                       break;
                    }

                    // both target & options are arrays
                    if ( Array.isArray(options) && Array.isArray(target) ) {


                        target = mergeArray(options, target, override);

                    } else {
                        // Merge the base object
                        for (var name in options) {
                            if (!target) {
                                target = { name: null }
                            }

                            src     = target[ name ] ;
                            copy    = options[ name ];


                            // Prevent never-ending loop
                            if (target === copy) {
                                continue
                            }

                            // Recurse if we're merging plain objects or arrays
                            if (
                                copy
                                && (
                                    isObject(copy) ||
                                    ( copyIsArray = Array.isArray(copy) )
                                )
                            ) {

                                var createMode = false;
                                if (copyIsArray) {
                                    copyIsArray = false;
                                    clone = src && Array.isArray(src) ? src : [];

                                    newTarget = clone;
                                    clone = mergeArray(copy, clone, override);
                                    target[ name ] = clone;
                                    continue

                                } else {

                                    clone = src && isObject(src) ? src : null;

                                    if (!clone) {
                                        createMode = true;
                                        clone = {};
                                        // copy props
                                        for (var prop in copy) {
                                            clone[prop] = copy[prop]
                                        }
                                    }
                                }



                                //[propose] Supposed to go deep... deep... deep...
                                if ( !override ) {
                                    // add those in copy not in clone (target)

                                    for (var prop in copy) {
                                        if (typeof(clone[ prop ]) == 'undefined') {
                                            if ( Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                                clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                            } else {
                                                clone[ prop ] = copy[ prop ] // don't override existing
                                            }
                                        } else if ( Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                            clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                        }
                                    }



                                    // Never move original objects, clone them
                                    if (typeof(src) != "boolean" && !createMode ) {//if property is not boolean
                                        //target[ name ] = browse(clone, copy, override)
                                        process.nextTick(function onBrowse() {
                                            target[ name ] = browse(clone, copy, override)
                                        });

                                    } else if (createMode) {
                                        target[ name ] = clone;
                                    }

                                } else {

                                    for (var prop in copy) {
                                        if ( typeof(copy[ prop ]) != 'undefined' ) {
                                            //clone[prop] = copy[prop]
                                            if ( Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                                clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                            } else {
                                                clone[ prop ] = copy[ prop ] // don't override existing
                                            }
                                        } else if ( Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                            clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                        }
                                    }

                                    target[ name ] = clone
                                }

                            } else if (copy !== undefined) {
                                //[propose]Don't override existing if prop defined or override @ false
                                if (
                                    typeof(src) != "undefined"
                                    && src != null
                                    && src !== copy && !override
                                ) {
                                    target[ name ] = src
                                } else {
                                    target[ name ] = copy;
                                }

                            }
                        }
                    }
                }

            }

        }

        newTarget = [];
        return target
    }

    // Will not merge functions items: this is normal
    // Merging arrays is OK, but merging collections is still experimental
    var mergeArray = function(options, target, override) {
        newTarget = [];

        if (override) {

            // if collection, comparison will be done uppon the `id` attribute
            if (
                typeof(options[0]) == 'object' && typeof(options[0].id) != 'undefined'
                && typeof(target[0]) == 'object' && typeof(target[0].id) != 'undefined'
            ) {

                newTarget       = JSON.parse(JSON.stringify(target));
                var _options    = JSON.parse(JSON.stringify(options));
                var next        = null;

                for (var a = 0, aLen = target.length; a < aLen; ++a) {

                    for (var n = next || 0, nLen = _options.length; n < nLen; ++n) {
                        if ( typeof(_options[n].id) != 'undefined' && _options[n].id === target[a].id ) {
                            newTarget[a] = _options[n];

                            next = n+1;
                            break
                        } else {
                            newTarget.push(_options[n]);

                            next = n+1;
                            break
                        }
                    }
                }

                return newTarget

            } else { // normal case `arrays` or merging from a blank collection
                return options
            }
        }

        if ( options.length == 0 &&  target.length > 0) {
            newTarget = target;
        }

        if ( target.length == 0 && options.length > 0) {
            for (var a = 0; a < options.length; ++a ) {
                target.push(options[a]);
            }
        }

        if (newTarget.length == 0 && target.length > 0) {
            // ok, but don't merge objects
            for (var a = 0; a < target.length; ++a ) {
                if ( typeof(target[a]) != 'object' && newTarget.indexOf(target[a]) == -1)
                    newTarget.push(target[a]);
            }
        }

        if ( target.length > 0 ) {

            // if collection, comparison will be done uppon the `id` attribute
            if (
                typeof(options[0]) == 'object' && typeof(options[0].id) != 'undefined'
                && typeof(target[0]) == 'object' && typeof(target[0].id) != 'undefined'
            ) {

                newTarget       = JSON.parse(JSON.stringify(target))
                var _options    = JSON.parse(JSON.stringify(options));
                var next        = null;

                for (var a = 0, aLen = newTarget.length; a < aLen; ++a) {
                    end:
                        for (var n = next || 0, nLen = _options.length; n < nLen; ++n) {

                            if (
                                _options[n] != null && typeof(_options[n].id) != 'undefined' && _options[n].id !== newTarget[a].id

                            ) {
                                newTarget.push(_options[n]);

                                next = n+1;
                                break end;
                            } else if( _options[n] != null && typeof(_options[n].id) != 'undefined' && _options[n].id === newTarget[a].id ) {

                                next = n+1;
                                break end;

                            } else {
                                break end;
                            }

                        }


                }

                return newTarget


            } else { // normal case `arrays`
                for (var a = 0; a < options.length; ++a ) {
                    if ( target.indexOf(options[a]) > -1 && override) {
                        target.splice(target.indexOf(options[a]), 1, options[a])
                    } else {
                        if (newTarget.indexOf(options[a]) == -1)
                            newTarget.push(options[a]);
                    }
                }
            }


        }

        if (newTarget.length > 0 && target.length > 0 ) {
            return newTarget
        }
    }


    /**
     * Check if object before merging.
     * */
    var isObject = function (obj) {
        if (
            !obj
            || {}.toString.call(obj) !== '[object Object]'
            || obj.nodeType
            || obj.setInterval
        ) {
            return false
        }

        var hasOwn              = {}.hasOwnProperty;
        var hasOwnConstructor   = hasOwn.call(obj, 'constructor');
        // added test for node > v6
        var hasMethodPrototyped = ( typeof(obj.constructor) != 'undefined' ) ? hasOwn.call(obj.constructor.prototype, 'isPrototypeOf') : false;


        if (
            obj.constructor && !hasOwnConstructor && !hasMethodPrototyped
        ) {
            return false
        }

        //Own properties are enumerated firstly, so to speed up,
        //if last one is own, then all properties are own.
        var key;
        return key === undefined || hasOwn.call(obj, key)
    }

    return browse
}

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Merge()
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return Merge() })
}