'use strict';
/**
 * @module lib/merge
 * @description Deep-merge utility. Exported as a single function `merge(target, source [, override])`.
 * Works in Node.js (CommonJS) and browser (AMD / GFF) contexts.
 *
 * - Objects are merged recursively.
 * - Missing keys are always filled from `source`; on a CONFLICTING key the
 *   `target` value is preserved by default.
 * - Pass `true` as the last argument (`override`) to make `source` win instead.
 * - Arrays of primitives merge as an ordered union: the target's elements first,
 *   then every source element the result lacks. A number the source repeats more
 *   often than the result is topped up to the source's count (`[25]` + `[25,25]`
 *   gives `[25,25]`), a value already present is never pushed again, and merging
 *   the same source a second time is a no-op (#B436). A nested array is merged
 *   once per level.
 *
 * @example
 * var merge = require('lib/merge');
 * var result = merge({ a: 1 }, { b: 2 }); // { a: 1, b: 2 }
 * merge({ a: 1 }, { a: 9 });       // { a: 1 }  — default: target wins on conflicts
 * merge({ a: 1 }, { a: 9 }, true); // { a: 9 }  — override: source wins
 */

/**
 * Merge factory — returns the `browse` function as the public API.
 * `module.exports = Merge()` exports `browse` directly.
 *
 * @private
 */
function Merge() {

    /**
     * #B446 — keys that must never be written through by a merge. `__proto__` is an
     * accessor on Object.prototype, so assigning it walks through to the prototype;
     * `constructor`/`prototype` reach it in two hops. JSON.parse produces an OWN
     * `__proto__` key, so an own-property check alone does NOT stop this — the key
     * name has to be rejected as well. Request bodies reach merge directly
     * (core/server.js:6657 merges JSON.parse output as the SOURCE), so this is a
     * request-path guard, not a defensive nicety.
     *
     * Key rejection is the WHOLE guard, deliberately. The first cut of #B446 also
     * skipped inherited enumerable source properties, which broke every entity in
     * the model registry: the model layer round-trips entity instances through
     * merge — the in-tree path is the relations assembly (core/model/entity.js),
     * and the registry's setModel (lib/model.js), while it has no in-tree caller,
     * is published through the modelUtil context and stays consumer-reachable —
     * and all six SQL connectors attach their .sql-derived query methods to the
     * PROTOTYPE, so an own-only copy silently dropped them
     * (`db.xEntity.getOneById is not a function`). merge therefore copies the
     * chain, as it always has; only these three key names are refused.
     *
     * @param {string} k - candidate key
     * @returns {boolean} true when the key must be skipped
     * @private
     */
    var isUnsafeMergeKey = function(k) {
        return k === '__proto__' || k === 'constructor' || k === 'prototype';
    };

    var newTarget           = []
        , originalValueshasBeenCached = false
        //, keyComparison     = 'id' // use for collections merging [{ id: 'val1' }, { id: 'val2' }, {id: 'val3' }, ...]
    ;


    /**
     * Deep-merge `source` into `target` and return the merged result.
     * This function is exported directly as `module.exports`.
     *
     * @memberof module:lib/merge
     * @function merge
     *
     * @param {object|Array} target    - Target (base) object or array
     * @param {object|Array} source    - Source object or array to merge into target
     * @param {boolean}      [override=false] - Pass `true` to let `source` overwrite existing target keys; by default they are preserved
     * @returns {object|Array} Merged result (mutates and returns `target`; never
     *   rewrites `source` — a subtree the target lacks is referenced, not walked, #B428)
     *
     * @example
     * merge({ a: 1 }, { b: 2 })          // { a: 1, b: 2 }
     * merge({ a: 1 }, { a: 9 })          // { a: 1 }  — default: target wins
     * merge({ a: 1 }, { a: 9 }, true)    // { a: 9 }
     * merge([1, 2],   [3, 4])            // [1, 2, 3, 4]
     * merge([1, 2],   [3, 4], true)      // [3, 4]
     * merge({ a: [null, 'x'] }, { a: [null, 'x'] })  // { a: [null, 'x'] } — null elements are preserved (#B226)
     * merge({ ports: [8080, 8124] }, { ports: [8124] })  // { ports: [8080, 8124] } — a value already present is not pushed again (#B436)
     */
    var browse = function (_target, _source) {

        var target = _target, source = _source;

        // clone target & source to prevent mutations from the originals
        if (!originalValueshasBeenCached) {
            if ( typeof(_target) == 'object' && Array.isArray(_target) ) {
                // target = _target.slice();
            } else if ( typeof(_target) == 'object' ) {
                // try {
                    // if ( typeof(_target['modelUtil']) != 'undefined' && typeof(_target['loggerInstance']) != 'undefined' ) {
                    //     console.info('Pause ... this is something')
                    // }
                    // target = JSON.clone(_target);
                // } catch(cloneErr) { // might be a complex object
                //     console.warn('Merge ignoring complex object backup: '+ cloneErr.stack);
                // }
            }

            // if ( typeof(_source) == 'object' && Array.isArray(_source) ) {
            //     source = _source.slice();
            // } else if ( typeof(_source) == 'object' && !Array.isArray(_source) ) {
            //     source = JSON.clone(_source);
            // }

            originalValueshasBeenCached = true;
        }

        if ( typeof(target) == 'undefined' ) {
            target = ( typeof(source) != 'undefined' && Array.isArray(source)) ? [] : {}
        }


        var override = false;
        if (( typeof(arguments[arguments.length-1]) == 'boolean' )) {
            override = arguments[arguments.length-1]
        }

        var i = 1;
        var length = arguments.length;

        var options, /**name,*/ src, copy, copyIsArray, clone;



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
            for (; i < length; ++i) {
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
                            // #B446 — reject prototype-reaching key names.
                            if ( isUnsafeMergeKey(name) ) { continue }

                            if (!target) {
                                target = { name: null }
                            }

                            src     = target[ name ];
                            copy    = options[ name ];


                            // Prevent never-ending loop
                            if (target === copy) {
                                continue
                            }
                            // #B428 — a value merged into ITSELF is identity: skip it.
                            // A key the target lacks is grafted by reference below
                            // (`clone[ prop ] = copy[ prop ]`), then the recursion
                            // `browse(clone, copy)` met that graft with src === copy and
                            // merged every array inside it with itself, writing the
                            // copies back INTO the caller's object (identity churn +
                            // silent primitive dedupe). Object/array references only —
                            // equal primitives keep the original path.
                            if (copy !== null && typeof(copy) == 'object' && src === copy) {
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
                                    //clone = src && Array.isArray(src) ? src : [];
                                    if ( src && Array.isArray(src) ) {
                                        clone = src || []
                                    } else if ( isObject(src) ) {
                                        clone = src || {};
                                        target[ name ] = clone;
                                        continue
                                    } else {
                                        clone = []
                                    }

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
                                            // #B446
                                            if ( isUnsafeMergeKey(prop) ) { continue }

                                            clone[prop] = copy[prop]
                                        }
                                    }
                                }



                                //[proposal] Supposed to go deep... deep... deep...
                                if ( !override ) {
                                    // add those in copy not in clone (target)
                                    for (var prop in copy) {
                                        // #B446
                                        if ( isUnsafeMergeKey(prop) ) { continue }

                                        if (typeof(clone[ prop ]) == 'undefined') {
                                            if ( Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                                clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                            } else {
                                                clone[ prop ] = copy[ prop ] // don't override existing
                                            }
                                        } else if ( createMode && Array.isArray(copy[ prop ]) && Array.isArray(clone[ prop ]) ) {
                                            // #B436 — createMode has no recursion below, so this is its one
                                            // pass; on an existing level the `browse(clone, copy)` recursion
                                            // that follows merges this array itself, and merging it here too
                                            // walked every nested array twice (and replaced an array SHARED
                                            // by both sides with a deduped copy, past the #B428 identity guard)
                                            clone[ prop ] = mergeArray(copy[ prop ], clone[ prop ], override);
                                        }
                                    }

                                    // Never move original objects, clone them
                                    if (typeof(src) != 'boolean' && !createMode ) {//if property is not boolean

                                        // Attention: might lead to a `Maximum call stack size exceeded` Error message
                                        target[ name ] = browse(clone, copy, override);

                                    } else if (createMode) {
                                        target[ name ] = clone;
                                    }

                                } else {

                                    for (var prop in copy) {
                                        // #B446
                                        if ( isUnsafeMergeKey(prop) ) { continue }

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

                                    target[ name ] = clone;
                                }

                            } else if (copy !== undefined) {
                                //[proposal] Don't override existing if prop defined or override @ false
                                if (
                                    typeof(src) != 'undefined'
                                    && src != null
                                    && src !== copy && !override
                                ) {
                                    target[ name ] = src;
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
        originalValueshasBeenCached = false;

        return target;
    };

    /**
     * Merge two arrays. Will not merge function items: this is normal.
     * Merging plain arrays is OK, merging collections is still experimental.
     *
     * `null` elements are VALUES and are preserved (#B226): `typeof null ==
     * 'object'`, so the object-exclusion guards below each carry an explicit
     * null exception — without it a no-override merge silently dropped `null`
     * from arrays (while `''` / `false` / `0` survived), which stripped the
     * first slot of positional argument arrays such as the documented
     * validator rule `"setFlash": [null, "message"]` on the client-side
     * rules path.
     *
     * An OBJECT element of `options` fills a HOLE of `target` (an index the
     * target lacks) by copying its keys; an occupied index — an existing
     * object, a primitive or `null` — is never written into. That guard is
     * #B437: the hole test runs on the deduped rebuild, whose indexes shift
     * against a target carrying duplicate primitives, so the key write used to
     * reach a string or null and throw, killing the whole merge.
     *
     * Primitive elements form an ordered union — the target's first, then every
     * source element the result lacks. A `number` the source carries more often
     * than the result so far is pushed again, up to the source's count (#B436):
     * the comparison is by COUNT, so a number already present at another index
     * is never duplicated and merging the same source twice is a no-op.
     *
     * @inner
     * @private
     * @param {Array} options  - Source array (merged INTO target)
     * @param {Array} target   - Target array (wins on conflicts unless `override`)
     * @param {boolean} override - `true` lets `options` win / replace
     * @returns {Array|undefined} the merged array
     */
    var mergeArray = function(options, target, override) {
        newTarget = [];

        var newTargetIds = []
            , keyComparison = browse.getKeyComparison()
            , a             = null
            , aLen          = null
            , i             = 0
        ;

        if (/^true$/i.test(override)) {
            // if collection, comparison will be done uppon the `id` attribute by default unless you call .setKeyComparison('someField')
            if (
                typeof(options[0]) == 'object'
                && options[0] != null
                && typeof(options[0][keyComparison]) != 'undefined'
                && typeof(target[0]) == 'object'
                // #B443 - typeof passes for a null first element; mirror the
                // options-side check two lines above or the next line dereferences it
                && target[0] != null
                && typeof(target[0][keyComparison]) != 'undefined'
            ) {

                newTarget =  (Array.isArray(target)) ? Array.from(target) : JSON.clone(target);
                for (var nt = 0, ntLen = newTarget.length; nt < ntLen; ++nt) {
                    // #B443 - a null (or hole) at a later index has no key to contribute
                    if (newTarget[nt] == null) { continue; }
                    newTargetIds.push(newTarget[nt][keyComparison]);
                }

                var _options    = JSON.clone(options);
                var index       = 0;
                a = 0;
                aLen = _options.length;
                for (var n = next || 0, nLen = target.length; n < nLen; ++n) {

                    // #B443 - a null target element has no key: it can match nothing,
                    // so it neither blocks nor contributes; skip the comparison slot
                    if (target[n] == null) { continue; }

                    // if (newTargetIds.indexOf(target[n][keyComparison]) == -1) {
                    //     newTargetIds.push(target[n][keyComparison]);

                    //     //newTarget.push(target[n]);
                    //     //++index;
                    // }

                    label:
                    for (a = a || 0; a < aLen; ++a) {

                        // #B443 - same disposition for a null source element: no key,
                        // nothing to push, advance the cursor past it
                        if (_options[a] == null) { continue; }

                        if (_options[a][keyComparison] === target[n][keyComparison] ) {

                            if (newTargetIds.indexOf(_options[a][keyComparison]) > -1) {

                                newTarget[index] = _options[a];
                                ++index;

                            } else if (newTargetIds.indexOf(_options[a][keyComparison]) == -1) {

                                newTargetIds.push(_options[a][keyComparison]);
                                //newTarget.push(_options[a]);
                                newTarget[index] = _options[a];
                                ++index;
                            }

                            break label;

                        } else if (newTargetIds.indexOf(_options[a][keyComparison]) == -1) {

                            newTargetIds.push(_options[a][keyComparison]);
                            newTarget.push(_options[a]);
                        }
                    } // EO For
                }

                newTargetIds = [];

                return newTarget;

            } else { // normal case `arrays` or merging from a blank collection
                if (
                    Array.isArray(options) && options.length == 0
                    ||
                    typeof(options) == 'undefined'
                ) {
                    // means that we are trying to replace with an empty array/collection
                    // this does not make any sense, so we just return the target as if the merge had no effect
                    // DO NOT CHANGE THIS, it affects gina merging config
                    if ( /^true$/i.test(override) ) {
                        return options
                    }
                    return target;
                }
                return options;
            }
        }

        if ( options.length == 0 &&  target.length > 0 ) {
            newTarget = target;
            return newTarget;
        }

        if ( target.length == 0 && options.length > 0) {
            a = 0;
            for (; a < options.length; ++a ) {
                target.push(options[a]);
            }
        }

        if (newTarget.length == 0 && target.length > 0) {
            // ok, but don't merge objects
            a = 0;
            for (; a < target.length; ++a ) {
                // #B226 — typeof null == 'object': a null element is a value
                // (e.g. the first slot of a positional rule-argument array),
                // not a collection item to exclude; this rebuild dropped it
                // while '' / false / 0 survived
                // was: if ( typeof(target[a]) != 'object' && newTarget.indexOf(target[a]) == -1 ) {
                if ( ( typeof(target[a]) != 'object' || target[a] === null ) && newTarget.indexOf(target[a]) == -1 ) {
                    newTarget.push(target[a]);
                }
            }
        }

        if ( target.length > 0 ) {

            // if collection, comparison will be done uppon the `id` attribute
            if (
                typeof(options[0]) != 'undefined'
                && typeof (options[0]) == 'object'
                && options[0] != null
                && typeof(options[0][keyComparison]) != 'undefined'
                && typeof(target[0]) == 'object'
                // #B443 - typeof passes for a null first element; mirror the
                // options-side check two lines above or the next line dereferences it
                && target[0] != null
                && typeof(target[0][keyComparison]) != 'undefined'
            ) {

                newTarget       = (Array.isArray(target)) ? Array.from(target) : JSON.clone(target);
                var _options    = JSON.clone(options);
                var next        = null;

                i = 0;
                a = 0; aLen = newTarget.length;
                for (; a < aLen; ++a) {
                    // #B443 - a null (or hole) at a later index has no key to contribute
                    if (newTarget[a] == null) { continue; }
                    newTargetIds.push(newTarget[a][keyComparison]);
                }
                a = 0;
                for (; a < aLen; ++a) {

                    // #B443 - a null slot on the rebuilt target has no key; both arms
                    // of the comparison below dereference it
                    if (newTarget[a] == null) { continue; }

                    end:
                        for (var n = next || 0, nLen = _options.length; n < nLen; ++n) {

                            if (
                                _options[n] != null && typeof(_options[n][keyComparison]) != 'undefined' && _options[n][keyComparison] !== newTarget[a][keyComparison]

                            ) {

                                if ( newTargetIds.indexOf(_options[n][keyComparison]) == -1 ) {
                                    newTarget.push(_options[n]);
                                    newTargetIds.push(_options[n][keyComparison]);

                                    next = n+1;

                                    if (aLen < nLen)
                                        ++aLen;

                                    break end;
                                }

                            } else if( _options[n] != null && typeof(_options[n][keyComparison]) != 'undefined' && _options[n][keyComparison] === newTarget[a][keyComparison] ) {

                                next = n+1;

                                //break end;

                            } else {
                                break end;
                            }
                        }


                }

                return newTarget;


            }
            // normal case `arrays`
            else {
                a = 0;
                // in case there is no keyComparison in options[*].props
                var localKeyComparison = null, ownPropertyNames = null;
                for (; a < options.length; ++a ) {
                    ownPropertyNames = null;
                    if (typeof(options) != 'undefined' && typeof(options[a]) == 'object' && !Array.isArray(options[a]) && options[a] != null ) {
                        ownPropertyNames = Object.getOwnPropertyNames(options[a])
                    }
                    if ( typeof(ownPropertyNames) != 'undefined' && ownPropertyNames != null) {
                        ownPropertyNames = ownPropertyNames[0] || null
                    }
                    // localKeyComparison = (typeof(options) != 'undefined' && typeof(options[a]) == 'object' && !Array.isArray(options[a]) ) ? ownPropertyNames : null;
                    localKeyComparison = ownPropertyNames;
                    if ( target.indexOf(options[a]) > -1 && override) {
                        target.splice(target.indexOf(options[a]), 1, options[a])
                    // #B226 — a null source element must not enter the index-merge:
                    // `for (var k in null)` is a no-op, so null used to surface as
                    // `{}` here; let it fall through to the primitive push below
                    // was: } else if ( typeof(newTarget[a]) == 'undefined' && typeof(options[a]) == 'object' ) {
                    } else if ( typeof(newTarget[a]) == 'undefined' && typeof(options[a]) == 'object' && options[a] != null ) {
                        // merge using index
                        newTarget = target;

                        if (typeof (newTarget[a]) == 'undefined')
                            newTarget[a] = {};

                        // #B437 — the hole test above ran on the DEDUPED rebuild; after
                        // the rebind `newTarget = target` the same index can hold a
                        // primitive or null on the real target (a target carrying
                        // duplicate primitives is SHORTER once deduped), and writing
                        // keys into a string / null threw a TypeError that killed the
                        // whole merge. An occupied slot is not a hole: skip it, as the
                        // chain below already does for an object at an occupied index.
                        if (newTarget[a] !== null && typeof(newTarget[a]) == 'object') {
                            for (let k in options[a]) {
                                // #B446
                                if ( isUnsafeMergeKey(k) ) { continue }

                                if (!newTarget[a].hasOwnProperty(k)) {
                                    newTarget[a][k] = options[a][k]
                                }
                            }
                        }

                    } else {
                        // fixing a = [25]; b = [25,25];
                        // result must be [25,25]
                        if (
                            !override
                            && newTarget.indexOf(options[a]) > -1
                            && /number/i.test( typeof(options[a]) )
                            // ok but not if @ same position
                            //&& options[a] !== newTarget[a]
                        ) {
                            // #B436 — top up by COUNT, never by index. The source may carry a
                            // repeated number the target has fewer copies of (a = [25];
                            // b = [25,25] must give [25,25]), but the old test compared POSITIONS,
                            // so a number already present at a different index was pushed again
                            // ([9,1] + [1] gave [9,1,1]) and the merge was not idempotent — the
                            // second pass a nested level used to take doubled every number.
                            // was: if (options[a] !== newTarget[a]) { newTarget.push(options[a]); continue }
                            var _seenInSource = 0, _seenInTarget = 0, _o = 0;
                            for (; _o <= a; ++_o) { if (options[_o] === options[a]) ++_seenInSource; }
                            for (_o = 0; _o < newTarget.length; ++_o) { if (newTarget[_o] === options[a]) ++_seenInTarget; }
                            if (_seenInSource > _seenInTarget) {
                                newTarget.push(options[a]);
                                continue
                            }
                        }

                        // Collection with keyComparison
                        if (
                            typeof (target[a]) != 'undefined'
                            && !/null/i.test(target[a])
                            && typeof (target[a][keyComparison]) != 'undefined'
                            && typeof (options[a]) != 'undefined'
                            && options[a] != null
                            && typeof (options[a][keyComparison]) != 'undefined'
                            && target[a][keyComparison] == options[a][keyComparison]
                        ) {
                            if (override)
                                newTarget[a] = options[a]
                            else
                               newTarget[a] = target[a]
                        }
                        // array with string key
                        // #B226 — same typeof-null exception as the rebuild above
                        // was: else if (newTarget.indexOf(options[a]) == -1 && typeof(options[a]) != 'object') {
                        else if (newTarget.indexOf(options[a]) == -1 && ( typeof(options[a]) != 'object' || options[a] === null )) {
                            newTarget.push(options[a]);
                        }
                        // collection without keyComparison
                        else if (
                            typeof (target[a]) != 'undefined'
                            && !/null/i.test(target[a])
                            && typeof (target[a][localKeyComparison]) != 'undefined'
                            && typeof (options[a]) != 'undefined'
                            && options[a] != null
                            && typeof (options[a][localKeyComparison]) != 'undefined'
                            && target[a][localKeyComparison] == options[a][localKeyComparison]
                        ) {
                            if (override)
                                newTarget[a] = options[a]
                            else
                               newTarget[a] = target[a]
                        }
                    }
                }
            }


        }

        if ( newTarget.length > 0 && target.length > 0 || newTarget.length == 0 && target.length == 0  ) {
            return newTarget
        }
    }
    mergeArray.prototype.setKeyComparison = function(keyComparison) {
        this.keyComparison = keyComparison
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
        // #B450 — compute lazily, restoring the original short-circuit. An OWN
        // `constructor` key (the shape JSON.parse yields for
        // `{"constructor": <primitive|null|{}|[]>}`) shadows
        // Object.prototype.constructor, so the eager read
        // `obj.constructor.prototype` was undefined (or threw outright for null)
        // and `hasOwn.call(undefined, ...)` crashed the whole merge —
        // request-reachable, since PUT bodies reach merge as the source. When the
        // object HAS an own constructor the rejection branch below cannot fire,
        // so the value is never needed; when it lacks one, guard the `.prototype`
        // read. A 24-shape differential sweep pins identical answers on every
        // input the old form did not crash on (test/lib/merge-b450.test.js).
        // was: var hasMethodPrototyped = ( typeof(obj.constructor) != 'undefined' ) ? hasOwn.call(obj.constructor.prototype, 'isPrototypeOf') : false;
        var hasMethodPrototyped = false;
        if ( !hasOwnConstructor && typeof(obj.constructor) != 'undefined' ) {
            hasMethodPrototyped = ( obj.constructor.prototype ) ? hasOwn.call(obj.constructor.prototype, 'isPrototypeOf') : false;
        }


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

    browse.setKeyComparison = function(keyComparison) {

        mergeArray.keyComparison = keyComparison;

        return browse
    }

    browse.getKeyComparison = function() {

        var keyComparison = mergeArray.keyComparison || 'id';

        // reset for the next merge
        mergeArray.keyComparison = 'id';

        return keyComparison
    }

    // // clone target & source to prevent mutations from the originals
    // if (!browse.originalValueshasBeenCached) {
    //     for (let a = 0, aLen = arguments.length; a < aLen; a++) {
    //         if ( typeof(arguments[a]) == 'object' && Array.isArray(arguments[a])) {
    //             arguments[a] = arguments[a].slice();
    //         } else if ( typeof(arguments[a]) == 'object' ) {
    //             arguments[a] = JSON.clone(arguments[a]);
    //         }
    //     }
    //     browse.originalValueshasBeenCached = true;
    // }

    return browse
}

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // for unit tests
    if ( typeof(JSON.clone) == 'undefined' ) {
        // #M22 — direct require of the clone primitive instead of helpers/index.js's for-loop loader (which transitively requires lib/logger and returns a partial merge under circular load)
        JSON.clone = require(__dirname + '/../../../../../utils/prototypes.json_clone');
    }
    // Publish as node.js module
    module.exports = Merge()
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return Merge() })
}