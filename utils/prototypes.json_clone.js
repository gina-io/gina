/**
 * JSON.clone
 * Clone JSON object
 *
 * Changes made here must be reflected in:
 *  - gina/utils/prototypes.js
 *  - gina/framework/version/helpers/prototypes.js
 *  - gina/framework/version/core/asset/plugin/src/vendor/gina/js/utils/polyfill.js
 *
 * @param {object} source
 * @param {object} [target]
 *
 * @returns {object} cloned JSON object
 **/
function JSONClone(source, target) {
    if (source == null || typeof source != 'object') return source;
    if (source.constructor != Object && source.constructor != Array) return source;

    if (
        source.constructor == Date
        || source.constructor == RegExp
        || source.constructor == Function
        || source.constructor == String
        || source.constructor == Number
        || source.constructor == Boolean
    ) {
        return new source.constructor(source);
    }


    try {
        target = target || new source.constructor();
    } catch (err) {
        throw err;
    }

    var i               = 0
        , srcObjProps   = Object.getOwnPropertyNames(source)
        , len           = srcObjProps.length || 0
        , keys          = Object.keys(source)
        , warn          = null
    ;

    while (i<len) {
        let key = srcObjProps[i];
        if (key == 'undefined') {
            i++;
            continue;
        }
        if (source[key] === undefined) {
            let warnStr = '';
            warn = new Error('JSON.clone(...) possible error detected: source['+key+'] is undefined !! Key `'+ key +'` should not be left `undefined`. Assigning to `null`');
            warn.stack = warn.stack.replace(/^Error\:\s+/g, '');
            if ( typeof(warn.message) != 'undefined' ) {
                warn.message = warn.message.replace(/^Error\:\s+/g, '');
                warnStr += warn.message +'\n';
            }

            warnStr += warn.stack;
            console.warn(warnStr);

            warn        = null;
            warnStr     = null;
            target[key] = null
        } else {
            // try {

                // if (key == 'contexts') {
                // // if ( typeof(target[key]) == 'undefined' && target[key] != 'null' && typeof(source[key]) == 'object' && !Array.isArray(source[key]) && typeof(source[key]) != 'object' &&  !/\[native code\]/.test(source[key].constructor) ) {
                //     console.log('Kyeyyyyy ', key);

                //     target[key] = {}.toString.call(source[key]);
                //     // target[key] = {};
                //     i++;
                //     continue;
                // }


                target[key] = (typeof(target[key]) == 'undefined' ) ? JSONClone(source[key], null) : target[key];
            // } catch (jsonErr) {
            //     // warn = new Error('JSON.clone(...) Exception detected @ source['+key+']\nKey: '+ key +'\nType: '+ (typeof(source[key])) + '\nisArray ? '+ Array.isArray(source[key]) +'\n');
            //     // warn.stack = warn.stack.replace(/^Error\:\s+/g, '');
            //     // if ( typeof(warn.message) != 'undefined' ) {
            //     //     warn.message = warn.message.replace(/^Error\:\s+/g, '');
            //     // }
            //     // console.warn(warn);
            //     // console.warn('key: '+ key, '\nvalue: ', source[key], jsonErr);

            //     console.warn('JSON.clone(...) Complex Object Exception detected @ source['+key+']\nConstructor: '+ source.constructor +'\nKey: '+ key +'\nType: '+ (typeof(source[key])) + '\nisArray ? '+ Array.isArray(source[key]) +'\nTarget[key]: '+ target[key] +'\n'+jsonErr.stack);
            //     // Break to avoid memory leak
            //     break;

            //     // throw new Error('JSON.clone(...) Complex Object Exception detected @ source['+key+']\nKey: '+ key +'\nType: '+ (typeof(source[key])) + '\nisArray ? '+ Array.isArray(source[key]) +'\n'+jsonErr.stack)

            //     // throw jsonErr;
            // }

        }

        i++;
    }
    i = null; len = null; keys = null;

    return target;
}


// WHY NOT USE SOMETHING ELSE ?
// Could have been fine, but not working when you have references pointing to another object
// return Object.assign({}, source);
// var JSONClone = function(source, target) {
//     return Object.assign(target||{}, source);
// };

// Performences issue
//return JSON.parse(JSON.stringify(source));
// var JSONClone = function(source) {
//     return JSON.parse(JSON.stringify(source));
// };

if ((typeof (module) !== 'undefined') && module.exports) {
    // Publish as node.js module
    module.exports = JSONClone
} else if (typeof (define) === 'function' && define.amd) {
    // Publish as AMD module
    return JSONClone
}