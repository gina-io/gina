/**
 * #B988 — the per-render copy of the object an action passes to `self.render()` or
 * `self.renderWithoutLayout()`.
 *
 * ## Why this module exists
 *
 * Every render delegate combines the action's object with gina's own render data
 * (`getData()`: `page.environment`, `page.view`, the request's `page.data.session` block,
 * the Csrf plugin's `gina.csrfToken` / `gina.csrfInput`). Before 0.7.6 the action's object
 * was the TARGET of that combine: `lib/merge` mutates and returns its first argument, filling
 * the keys it lacks, so the swig delegate wrote the request's session block, its CSRF token,
 * its `page.view` and, in dev, its Inspector data into the action's own object. An object an
 * action passes to several renders (a module-level object, a `require()`d JSON module) then
 * carried the first request's values into the pages of later requests, and `lib/merge`'s
 * target-wins rule kept them there.
 *
 * ## What the copy covers
 *
 * Each delegate calls `copyForRender()` before its first combine statement and combines the
 * copy instead. A node of the action's object is copied when gina can write into it during
 * the render:
 *
 * - the nodes of ALWAYS_COPIED: the object itself (the target of every combine), its `page`,
 *   `page.view`, `page.data` and `page.environment` members, and its `gina` and `session`
 *   members. These are the nodes the delegates write into after the combine
 *   (`page.flow`, `page.view.file`, `page.data.flow`, `page.cspNonce`, …) or merge gina's
 *   data into, and the two string leaves `set()` adds during a render
 *   (`page.view.stylesheets` / `.scripts`);
 * - every node that `lib/merge` reaches: a member whose key gina's data also holds as a plain
 *   node, followed down the same way. gina's data is matched at the top level and, because
 *   a layout render merges an object that has no `page` member into `page.data`, also under
 *   `page.data`: an action's own `session` member meets the request's session block there.
 *
 * Every other value stays a reference, so the template reads the same values as before, the
 * walk stays as small as the overlap (a large list under `page.data` is not walked), and the
 * action's object is never written. A delegate that starts writing a new path after the
 * combine adds it to ALWAYS_COPIED.
 *
 * ## What is copied, and how
 *
 * A node is copied when it is an object `lib/merge` descends into (`isMergeObject()`: a
 * plain object, a null-prototype object, an object built on a plain prototype) or an array
 * whose prototype is `Array.prototype`. A class instance, a `Date`, a `Map`, a `Buffer`, a
 * function or an array subclass stays a reference: its internal slots and private fields
 * would not survive a copy. `lib/merge` never descends into such a node; gina writes into one
 * only when an action places it at a path gina writes (`page.view` set to a class instance,
 * for instance), and those shapes keep the pre-0.7.6 behaviour. So does an action object
 * that is itself not a copyable node.
 *
 * A copy keeps its source's prototype and every own key, symbols and non-enumerable keys
 * included, with their enumerability; an accessor stays an accessor and is neither called
 * nor followed; an own `__proto__` key stays an own data property (the prototype does not
 * change); data properties become writable and configurable, so a frozen object gives a
 * writable copy. A node met twice is copied once, so a cycle terminates and keeps its shape.
 * Nodes nested deeper than MAX_DEPTH stay references. Inherited members are not copied (the
 * walk reads own keys only).
 *
 * ## `copyOwn()`
 *
 * The same copy one level deep, for an app's object that gina merges into outside a render
 * (#B672): `throwError()`'s one-argument API-error form becomes the target of `lib/merge`,
 * then receives the response's `status`, its incident `ref`, a callsite `stack` and the
 * custom error page's data. `copyOwn()` gives gina a copy to write into; its members are
 * shared.
 *
 * Server-side only: `core/controller` is not part of the browser bundle.
 *
 * @module core/controller/render-data
 */
'use strict';

/**
 * How many levels below the action's object a node is still copied. gina's deepest write is
 * four levels down (`page.data.session.id`) and gina's data is a few levels deep; the cap
 * keeps a pathological nesting from exhausting the stack.
 *
 * @constant
 * @type {number}
 * @private
 */
var MAX_DEPTH = 32;

/**
 * The nodes of an action's object that are copied whatever gina's data holds: the top level
 * and the members the delegates write into after the combine (see the module doc). Aligned
 * with the action's object; frozen, never written.
 *
 * @constant
 * @type {object}
 * @private
 */
var ALWAYS_COPIED = Object.freeze({
    page    : Object.freeze({
        data        : Object.freeze({}),
        environment : Object.freeze({}),
        view        : Object.freeze({})
    }),
    gina    : Object.freeze({}),
    session : Object.freeze({})
});

/**
 * The shape `copyOwn()` aligns with an object: it holds no member, so the object itself is
 * copied and every member stays a reference. Frozen, never written.
 *
 * @constant
 * @type {object}
 * @private
 */
var TOP_LEVEL_ONLY = Object.freeze({});

/** @constant {function} @private */
var hasOwn   = Object.prototype.hasOwnProperty;
/** @constant {function} @private */
var toString = Object.prototype.toString;

/**
 * Whether `lib/merge` descends into a value: a replica of its private `isObject()`
 * (`lib/merge/src/main.js`). An `[object Object]` that is not a DOM node or a window, with
 * an own `constructor` key, with no constructor (a null prototype), or whose constructor's
 * prototype holds an own `isPrototypeOf` (a plain object, or one built on a plain
 * prototype). A class instance is not one.
 *
 * @inner
 * @private
 * @param {*} value - the value to test
 * @returns {boolean} true when `lib/merge` would merge into it
 */
function isMergeObject(value) {
    if (
        !value
        || typeof(value) != 'object'
        || toString.call(value) !== '[object Object]'
        || value.nodeType
        || value.setInterval
    ) {
        return false;
    }
    if ( hasOwn.call(value, 'constructor') ) {
        return true;
    }
    var ctor = value.constructor;
    if ( !ctor ) {
        return true;
    }
    return ( ctor.prototype ) ? hasOwn.call(ctor.prototype, 'isPrototypeOf') : false;
}

/**
 * Whether a value is a node the copy may replace: an object `lib/merge` descends into, or an
 * array whose prototype is `Array.prototype`.
 *
 * @inner
 * @private
 * @param {*} value - the value to test
 * @returns {boolean} true for a copyable node
 */
function isCopyable(value) {
    if ( Array.isArray(value) ) {
        return Object.getPrototypeOf(value) === Array.prototype;
    }
    return isMergeObject(value);
}

/**
 * The value an own key holds in a node of gina's data or of ALWAYS_COPIED, or `undefined`
 * when the holder is not an object or lacks the key. These are gina's own nodes; `lib/merge`
 * reads the same values when it combines.
 *
 * @inner
 * @private
 * @param {*} holder - the object to read
 * @param {string|symbol} key - the key to read
 * @returns {*} the own value, or `undefined`
 */
function ownValue(holder, key) {
    if ( holder === null || typeof(holder) != 'object' || !hasOwn.call(holder, key) ) {
        return undefined;
    }
    return holder[key];
}

/**
 * The copy of a node, or the node itself when gina cannot write into it: when it is not a
 * copyable node, when no aligned shape holds a copyable node at its place, or below
 * MAX_DEPTH. A node already copied returns its copy.
 *
 * The copy has the node's prototype and every own key with its descriptor; its data
 * properties are writable and configurable, its accessors stay accessors, and an array copy
 * keeps its length and its holes. An ordinary data property (writable, enumerable,
 * configurable) of a node whose prototype is `Object.prototype`, `null` or `Array.prototype`
 * is copied by assignment, which keeps the copy in V8's fast mode; any other property, an own
 * `__proto__` key, and every property of a node with another prototype (which may carry an
 * inherited setter) are defined with `Object.defineProperty`.
 *
 * @inner
 * @private
 * @param {*} value - the node of the action's object
 * @param {Array<object|Array>} shapes - the copyable nodes aligned with it: ALWAYS_COPIED and
 *   gina's data
 * @param {number} depth - the depth of `value` below the action's object
 * @param {Map} seen - source node → its copy
 * @returns {*} the copy, or `value`
 */
function copyNode(value, shapes, depth, seen) {
    if ( !isCopyable(value) ) {
        return value;
    }
    var known = seen.get(value);
    if ( typeof(known) != 'undefined' ) {
        return known;
    }
    if ( !shapes.length || depth > MAX_DEPTH ) {
        return value;
    }
    var isArray = Array.isArray(value);
    var proto   = Object.getPrototypeOf(value);
    var out     = isArray ? new Array(value.length) : ( (proto === Object.prototype) ? {} : Object.create(proto) );
    var assign  = isArray || proto === Object.prototype || proto === null;
    seen.set(value, out);

    var keys = Reflect.ownKeys(value);
    for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if ( isArray && key === 'length' ) {
            continue;
        }
        var d = Object.getOwnPropertyDescriptor(value, key);
        if ( !d ) {
            continue;
        }
        var isData = 'value' in d;
        if ( isData && isCopyable(d.value) ) {
            var childShapes = [];
            for (var s = 0; s < shapes.length; s++) {
                var aligned = ownValue(shapes[s], key);
                if ( isCopyable(aligned) ) {
                    childShapes.push(aligned);
                }
            }
            d.value = copyNode(d.value, childShapes, depth + 1, seen);
        }
        if ( assign && isData && key !== '__proto__' && d.writable && d.enumerable && d.configurable ) {
            out[key] = d.value;
        } else {
            d.configurable = true;
            if ( isData ) {
                d.writable = true;
            }
            Object.defineProperty(out, key, d);
        }
    }
    return out;
}

/**
 * Returns the object a render delegate combines with gina's render data in place of the
 * action's own object, so the action's object is read and never written (#B988). Call it
 * once per render, before the first combine statement, with the delegate's `data` as it
 * stands there.
 *
 * A value that is not a copyable node (`undefined`, `null`, a primitive, a class instance,
 * a `Date`, …) is returned as is.
 *
 * @memberof module:core/controller/render-data
 * @param {*} userData - the object the action passed to `self.render()` / `self.renderWithoutLayout()`
 * @param {object} envelope - the delegate's render data at the combine point (`getData()`
 *   plus what the delegate added before the combine, such as the session block)
 * @returns {*} a copy whose ALWAYS_COPIED nodes, and whose nodes gina's data also holds, are
 *   new nodes, every other value shared; or `userData` itself when it is not a copyable node
 *
 * @example
 * var renderData = require('./render-data');
 * // in a delegate, before `if (!userData) { … } else if ( isWithoutLayout ) { …`
 * userData = renderData.copyForRender(userData, data);
 *
 * @example
 * var shared = { title: 'Home', items: rows };
 * var copy = renderData.copyForRender(shared, { page: { data: { session: { id: 's1' } } } });
 * copy !== shared;               // true: the combine writes into the copy
 * copy.items === shared.items;   // true: a member gina never writes stays shared
 */
function copyForRender(userData, envelope) {
    if ( !isCopyable(userData) ) {
        return userData;
    }
    var shapes = [ALWAYS_COPIED];
    if ( isCopyable(envelope) ) {
        shapes.push(envelope);
    }
    var envelopePageData = ownValue(ownValue(envelope, 'page'), 'data');
    if ( isCopyable(envelopePageData) ) {
        shapes.push(envelopePageData);
    }
    return copyNode(userData, shapes, 0, new Map());
}

/**
 * Returns a copy of an app's object for gina to write into, one level deep (#B672). The copy
 * has the object's prototype and every own key with its descriptor, like a node copied by
 * `copyForRender()`: data properties become writable and configurable (a frozen object gives
 * a writable copy), accessors stay accessors and are not called, symbol and non-enumerable
 * keys are kept. Every member value is shared, except a member that refers back to the object
 * itself, which refers to the copy.
 *
 * A value that is not a copyable node is returned as is: `undefined`, `null`, a primitive, an
 * `Error`, a `Date`, a function, or a class instance, whose internal slots and private fields
 * would not survive a copy; gina writes into such a value as before.
 *
 * @memberof module:core/controller/render-data
 * @param {*} value - the app's object (in `throwError()`, the one-argument error object)
 * @returns {*} a new object with the same prototype and own properties, or `value` itself
 *   when it is not a copyable node
 *
 * @example
 * var renderData = require('./render-data');
 * // throwError(), the one-argument API-error form: merge into a copy, not into the app's object
 * errorObject = merge(renderData.copyOwn(arguments[arguments.length-1]), errorObject);
 *
 * @example
 * var shared = Object.freeze({ error: 'Invalid input', fields: { email: 'required' } });
 * var copy   = renderData.copyOwn(shared);
 * copy !== shared;                 // true
 * copy.fields === shared.fields;   // true: members are shared
 * copy.ref = 'r1';                 // allowed: the copy is writable
 * renderData.copyOwn(new Error('x')) instanceof Error; // true: returned as is
 */
function copyOwn(value) {
    return copyNode(value, [TOP_LEVEL_ONLY], 0, new Map());
}

module.exports = {
    copyForRender : copyForRender,
    copyOwn       : copyOwn,
    /**
     * Exposed for the unit tests only.
     *
     * @private
     * @type {number}
     */
    MAX_DEPTH     : MAX_DEPTH
};
