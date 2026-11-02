/**
 * JSON.clone
 * Clone JSON object
 *
 * This is the one server implementation: `gina/utils/prototypes.js` and
 * `gina/framework/version/helpers/prototypes.js` both require it. Changes made
 * here must be reflected in the browser copy:
 *  - gina/framework/version/core/asset/plugin/src/vendor/gina/utils/polyfill.js
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

    // #P39 — a dead sibling allocation was removed here: a per-recursion-level
    // key array was built and never read, feeding the GC one throwaway array
    // per cloned node (measured at ~50% of render CPU being spent in this
    // function, every allocation in the hot loop counts).
    var i               = 0
        , srcObjProps   = Object.getOwnPropertyNames(source)
        , len           = srcObjProps.length || 0
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


                // #B849 — fill when the target has no OWN value for the key: `typeof(target[key])`
                // reads through the prototype chain, so a fresh `{}` target "had" `toString`,
                // `valueOf`, `hasOwnProperty` (and gina's installed `count`), and the inherited
                // function was written back as an own key over the source's value (the #B845
                // shape, in the cloner). The old test stays as the first operand, so every fill
                // that happened before still happens.
                // was: target[key] = (typeof(target[key]) == 'undefined' ) ? JSONClone(source[key], null) : target[key];
                target[key] = ( typeof(target[key]) == 'undefined' || !Object.prototype.hasOwnProperty.call(target, key) ) ? JSONClone(source[key], null) : target[key];
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
    i = null; len = null;

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