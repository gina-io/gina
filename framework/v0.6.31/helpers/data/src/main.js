/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */


/**
* DataHelper
*
* @package     Gina.Lib.Helpers
* @author      Rhinostone <contact@gina.io>
* @api public
* */

function DataHelper(){

    /** imports */
    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    // if (!isGFFCtx) {
    //     var console = require('./../../../lib/logger');
    // }

    encodeRFC5987ValueChars = function(str) {
        // return encodeURIComponent(str).
        //   // Bien que la RFC 3986 réserve "!", RFC 5987 ne réserve pas ce caractère,
        //   // il n'est donc pas nécessaire l'échapper
        //   replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16)). // i.e., %27 %28 %29 %2a
        //   // on notera que l'encodage valide pour "*" est %2A et qui faut donc appeler toUpperCase()
        //   // pour encoder exactement.

        //   // Selon la RFC 5987 ce qui suit n'est pas nécessairement requis
        //   // on peut donc bénéficier d'un peu plus de lisibilité : |`^
        //   replace(/%(7C|60|5E)/g, (str, hex) => String.fromCharCode(parseInt(hex, 16)));

        // return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
        //     return '%' + c.charCodeAt(0).toString(16);
        //   });

        return encodeURIComponent(str).
        // Bien que la RFC 3986 réserve "!", RFC 5987 ne réserve pas ce caractère,
        // il n'est donc pas nécessaire l'échapper
        replace(/['()]/g, escape). // c'est-à-dire %27 %28 %29
        replace(/\*/g, '%2A').
            // Selon la RFC 5987 ce qui suit n'est pas nécessairement requis
            // on peut donc bénéficier d'un peu plus de lisibilité : |`^
            replace(/%(?:7C|60|5E)/g, unescape);
    };

    /**
     * Percent-decodes a string, returning the input UNCHANGED when it is not a
     * valid URI component. `decodeURIComponent` throws `URIError` on a malformed
     * escape (a bare `%`, `%zz`, or a truncated `%E0%A`). On the server request
     * path an attacker-controlled malformed `%` in a URL / query string would
     * otherwise reach an unguarded `decodeURIComponent`, throw, and — since the
     * framework runs no `uncaughtException` handler — take the whole bundle down
     * (#B30). Use this at every server-side decode of attacker-controllable
     * input where the decode is the genuine (first) decode and cannot simply be
     * dropped; it mirrors the try/decode/fallback-to-raw idiom already used in
     * the POST/PUT/PATCH body branches of `processRequestData`.
     *
     * @param {string} str - the value to decode
     * @returns {string} the decoded value, or the original string on URIError
     * @example
     *   safeDecodeURIComponent('a%20b'); // 'a b'
     *   safeDecodeURIComponent('100%');  // '100%'  (decodeURIComponent would throw URIError)
     */
    safeDecodeURIComponent = function(str) {
        try {
            return decodeURIComponent(str);
        } catch (err) {
            return str;
        }
    };

    /**
     * Like {@link safeDecodeURIComponent} but for whole-URI decoding: wraps
     * `decodeURI` (which leaves URI-reserved characters such as `/ ? #` intact —
     * used across the routing and error-handler paths to turn `%20` back into a
     * space without touching path separators). `decodeURI` throws the SAME
     * `URIError` as `decodeURIComponent` on a malformed escape, so an unguarded
     * call on the request URL / pathname crashes the bundle the same way (#B30) —
     * including from inside `throwError`, which would turn a graceful error into a
     * crash. Returns the input unchanged on a malformed escape.
     *
     * @param {string} str - the value to decode
     * @returns {string} the decoded value, or the original string on URIError
     * @example
     *   safeDecodeURI('/a%20b');  // '/a b'
     *   safeDecodeURI('/a%E0%A'); // '/a%E0%A'  (decodeURI would throw URIError)
     */
    safeDecodeURI = function(str) {
        try {
            return decodeURI(str);
        } catch (err) {
            return str;
        }
    };

    /**
     * Convert JSON string with structured keys to object
     *
     * @param {string} JSON string with structured keys
     * */
    formatDataFromString = function(bodyStr){

        if ( typeof(bodyStr) == 'object' ) {
            bodyStr = JSON.stringify(bodyStr)
        }

        try {
            bodyStr = decodeURIComponent(bodyStr);
        } catch (err) {
            // Already decoded - ignoring
        }

        // false & true case
        if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) ) {
            bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
        }
        if ( /(\"null\")/i.test(bodyStr) ) {
            bodyStr = bodyStr.replace(/\"null\"/ig, null);
        }

        return parseBody(bodyStr);
    }

    var parseCollection = function (collection, obj) {

        for(var i = 0, len = collection.length; i<len; ++i) {
            obj[i] = parseObject(collection[i], obj);
        }

        return obj
    }

    var parseObject = function (tmp, obj) {
        var el      = []
            , key   = null
        ;

        if (!obj) {
            obj = {}
        }

        for (let o in tmp) {

            el[0]   = o;
            el[1]   = tmp[o];

            if ( /^(.*)\[(.*)\]/.test(el[0]) ) { // some[field] ?
                key = el[0].replace(/\]/g, '').split(/\[/g);
                obj = parseLocalObj(obj, key, 0, el[1])
            } else {
                obj[ el[0] ] = el[1]
            }
        }

        return obj
    }

    var parseBody = function(body) {
        var obj             = null
            , tmp           = null
            , arr           = null
            , isArrayType   = null
        ;
        if ( /^(\{|\[|\%7B|\%5B)/.test(body) ) {
            try {
                isArrayType = ( /^(\{|\%7B)/.test(body) ) ? false : true;
                obj = ( isArrayType ) ? [] : {};

                if ( /^(\%7B|\%5B)/.test(body) ) {
                    tmp = JSON.parse(decodeURIComponent(body))
                } else {
                    tmp = JSON.parse(body)
                }

                if ( Array.isArray(tmp) ) {
                    obj = parseCollection(tmp, obj)
                } else {
                    obj = parseObject(tmp, obj)
                }

                return obj
            } catch (err) {
                console.error('[365] could not parse body:\n' + body)
            }

        } else {
            obj = {};
            arr = body.split(/&/g);
            if ( /(\"false\"|\"true\"|\"on\")/.test(body) )
                body = body.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);


            var el      = {}
                , value = null
                , key   = null;

            for (var i = 0, len = arr.length; i < len; ++i) {
                if (!arr[i]) continue;

                // #B30: tolerate a malformed `%` escape (fall back to the raw
                // segment) instead of letting decodeURIComponent throw URIError —
                // an unguarded throw here propagates to processRequestData with no
                // uncaughtException handler and crashes the bundle.
                arr[i] = safeDecodeURIComponent(arr[i]);

                if ( /^\{/.test(arr[i]) || /\=\{/.test(arr[i]) || /\=\[/.test(arr[i]) ) {
                    try {
                        if (/^\{/.test(arr[i])) {
                            obj = JSON.parse(arr[i]);
                            break;
                        } else {
                            el = arr[i].match(/\=(.*)/);
                            el[0] =  arr[i].split(/\=/)[0];
                            obj[ el[0] ] = JSON.parse( el[1] );
                        }


                    } catch (err) {
                        console.error('[parseBody#1] could not parse body:\n' + arr[i])
                    }
                } else {
                    el = arr[i].split(/=/);
                    if ( /\{\}\"\:/.test(el[1]) ) { //might be a json
                        try {
                            el[1] = JSON.parse(el[1])
                        } catch (err) {
                            console.error('[parseBody#2] could not parse body:\n' + el[1])
                        }
                    }

                    if ( typeof(el[1]) == 'string' && !/\[object /.test(el[1])) {
                        key     = null;
                        // #B30: malformed-%-safe decode (see the arr[] loop above).
                        el[0]   = safeDecodeURIComponent(el[0]);
                        el[1]   = safeDecodeURIComponent(el[1]);

                        if ( /^(.*)\[(.*)\]/.test(el[0]) ) { // some[field] ?
                            key = el[0].replace(/\]/g, '').split(/\[/g);
                            obj = parseLocalObj(obj, key, 0, el[1])
                        } else {
                            obj[ el[0] ] = el[1]
                        }
                    }
                }
            }

            return obj
        }
    }

    // var parseLocalObj = function(obj, key, k, value) {
    //     if ( typeof(obj[ key[k] ]) == 'undefined' ) {
    //         obj[ key[k] ] = {};
    //     }

    //     for (var prop in obj) {

    //         if (k == key.length-1) {

    //             if (prop == key[k]) {
    //                 obj[prop] = ( typeof(value) != 'undefined' ) ? value : '';
    //             }

    //         } else if ( key.indexOf(prop) > -1 ) {
    //             ++k;
    //             if ( !obj[prop][ key[k] ] )
    //                 obj[prop][ key[k] ] = {};


    //             parseLocalObj(obj[prop], key, k, value)

    //         }
    //     }

    //     return obj;
    // }

    var parseLocalObj = function(obj, key, k, value) {

        // #B446 — a bracket-notation field name is client-supplied and every segment is
        // used as an assignment target below (`obj[ key[k] ] = ...`). `__proto__` is an
        // accessor on Object.prototype, so assigning through it mutates the prototype for
        // the whole process; `constructor`/`prototype` reach it in two hops. Measured
        // before the fix: `__proto__[polluted]=x`, `constructor[prototype][polluted]=x`
        // and the percent-encoded `%5F%5Fproto%5F%5F[polluted]=x` each polluted
        // Object.prototype while the parsed body still read `{}` — i.e. silently.
        // Drop the path rather than throwing: these names are never legitimate, and a
        // throw on the request-parse path would turn one bad field into a 500.
        // Kept INLINE (not a closure helper) because test/core/validator-send-formdata-
        // nesting.test.js extracts this function's source text and evals it standalone to
        // pin client/server parity — a helper call would be a ReferenceError there, and
        // the client-side twin in the validator plugin is inline for the same reason.
        for (var _s = 0, _sLen = key.length; _s < _sLen; ++_s) {
            if ( key[_s] === '__proto__' || key[_s] === 'constructor' || key[_s] === 'prototype' ) {
                return obj;
            }
        }

        for (let i=0,len=key.length; i<len; i++) {
            // by default
            let _key = key[k];
            if (i == k) {
                // Array or Object ?
                if ( typeof(obj[ key[k] ]) == 'undefined' || typeof(obj[ key[k] ]) == 'string' ) {
                    if ( Array.isArray(obj) ) {
                        // index
                        // _key = obj.length;
                        _key = ~~key[k];
                        obj[ _key ] = ( /^\d+$/.test(key[k+1]) ) ? [] : {};
                    } else {
                        obj[ key[k] ] = ( /^\d+$/.test(key[k+1]) ) ? [] : {};
                    }
                }

                // Assinging value
                if (k == key.length-1) {
                    let _value = ( typeof(value) != 'undefined' ) ? value : '';
                    if ( Array.isArray( obj[key[k]] ) ) {
                        obj[key[k]].push(_value);
                        // _key = (obj.length > 0) ? obj.length-1 : 0;
                        // obj[ _key ] = _value;
                    }
                    else {
                        obj[ key[k] ] = _value;
                    }
                    break;
                }
                // Assinging index or key
                else {
                    if ( /^\d+$/.test(key[k]) && !Array.isArray(obj) ) {
                        obj = [];
                        // _key = (obj.length > 0) ? obj.length-1 : 0;
                    }
                    // Handle unstructured array from object
                    // E.G.: design[1][id] where design is starting with `1` index instead of `0`
                    // if ( Array.isArray(obj) ) {
                    //     // current Index
                    //     _key = ~~key[k];
                    //     // _key = (obj.length > 0) ? obj.length-1 : 0;
                    // }
                    // Init array or object
                    if ( typeof(obj[ _key ]) == 'undefined' ) {
                        // obj[ _key ] = ( /^\d+$/.test(key[k+1]) ) ? [] : {};
                        obj[ _key ] = null;
                    }

                    parseLocalObj(obj[ _key ], key, k+1, value);
                }
            }
        }

        return obj;
    }

    /**
     * Framework-global alias of parseLocalObj (#B92-adjacent) — nests ONE
     * bracket-notation key path into an accumulator, leaf value assigned
     * verbatim. Exposed like formatDataFromString above so the server's
     * multipart text-field capture (core/server.js) reuses the SAME nesting
     * layer as the urlencoded path instead of a second copy. The client-side
     * form-validator carries a byte-faithful port under the same name (the
     * browser bundle cannot reach server helpers).
     *
     * @global
     * @param {object|array} obj - accumulator (mutated and returned)
     * @param {array} key - bracket-split key path, e.g. `item[0][id]` -> ['item','0','id']
     * @param {number} k - current depth (callers pass 0)
     * @param {*} value - leaf value, assigned verbatim
     * @returns {object|array} the accumulator
     */
    nestBracketNotationKey = parseLocalObj;

} //EO DataHelper

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports  = DataHelper
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function(){ return DataHelper() })
}