/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module conf-view
 *
 * Per-call COPY-ON-WRITE VIEW over a shared configuration tree (#P40) — what
 * `self.getConfig()` hands back instead of a deep clone. Reads pass through to
 * the shared tree at no copy cost; the first write to a node lands in that
 * node's private overlay (the shared tree is never touched, and no other view
 * ever sees the write); the first ENUMERATION of a node — `Object.keys`,
 * `for…in`, spread, `Object.assign`, `JSON.stringify`, `JSON.clone` —
 * materialises that subtree ONCE into a plain private copy (untouched
 * descendants deep-cloned, touched ones carried with their overlays), served
 * natively from then on.
 *
 * Contract:
 *  - a value read through the view equals the shared value until you write it;
 *    a write is visible to you alone; two views over one tree are independent.
 *  - identity is stable: reading the same nested node twice gives the same
 *    object, and two paths to ONE shared object give one view node — so the
 *    conf's `settings` / `content.settings` aliasing is preserved, where a
 *    deep clone silently broke it.
 *  - non-plain values (Buffers, Dates, class instances, functions, primitives)
 *    pass through by reference — exactly what `JSON.clone` did for them.
 *  - an accessor on the shared tree runs against its own object, so a lazy
 *    self-replacing getter (the request conf's `locales`) keeps working.
 *  - a frozen or sealed node is copied ONCE into the overlay on first read,
 *    so it stays mutable as its clone used to be; a frozen ROOT yields a plain
 *    deep copy, never a view.
 *
 * Three things a deep clone allowed that a view cannot serve — documented to
 * consumers, with `settings.json > controller.getConfig.mode: "clone"` as the
 * opt-out: `structuredClone(view)` throws a `DataCloneError`;
 * `Object.freeze` / `Object.seal` / `Object.preventExtensions` on a node you
 * have NOT enumerated throws a `TypeError` (it would freeze the shared object;
 * after enumeration the node's children are plain copies and freeze fine);
 * `console.log` / `util.inspect` render the shared values, not your overlay
 * (property reads and `JSON.stringify` are truthful). One deliberate
 * divergence, bounded by what the engine lets a proxy report: a
 * NON-CONFIGURABLE own property of the shared tree refuses a delete or a
 * redefinition through the view, and refuses a write too when it is also
 * non-writable (an array's `length` — non-configurable but writable — takes
 * writes normally), where a clone would have accepted all of them. The
 * framework defines no such property on any configuration node.
 *
 * Plain objects and arrays only. Never throws on input: a non-plain root is
 * returned as-is (`undefined` in, `undefined` out — the `getConfig('missing')`
 * contract).
 */

var JSONClone = require('./../../../../../utils/prototypes.json_clone');

/**
 * Tag a view answers `true` for. `Symbol.for` keeps it stable across dev-mode
 * module reloads, so `isView` keeps recognising a view built by an earlier
 * instance of this module.
 *
 * @constant
 * @type {symbol}
 */
var VIEW_TAG = Symbol.for('gina.confView');

/**
 * A plain object (`Object.prototype` or `null` prototype) or an array — the
 * only shapes a view wraps; everything else passes through by reference.
 *
 * @inner
 * @private
 * @param {*} v
 * @returns {boolean}
 */
function isPlain(v) {
    if ( v === null || typeof(v) !== 'object' ) {
        return false;
    }
    if ( Array.isArray(v) ) {
        return true;
    }
    var proto = Object.getPrototypeOf(v);
    return ( proto === Object.prototype || proto === null );
}

/**
 * A non-configurable own property of `target` — the kind a proxy may neither
 * delete nor redefine.
 *
 * @inner
 * @private
 * @param {object} target
 * @param {string|symbol} key
 * @returns {boolean}
 */
function isLockedOn(target, key) {
    var d = Reflect.getOwnPropertyDescriptor(target, key);
    return ( typeof(d) !== 'undefined' && !d.configurable );
}

/**
 * A non-configurable own property of `target` whose VALUE a proxy may not
 * report differently: a non-writable data property, or an accessor without a
 * setter. A writable non-configurable one (an array's `length`) takes writes.
 *
 * @inner
 * @private
 * @param {object} target
 * @param {string|symbol} key
 * @returns {boolean}
 */
function isLockedForSet(target, key) {
    var d = Reflect.getOwnPropertyDescriptor(target, key);
    if ( typeof(d) === 'undefined' || d.configurable ) {
        return false;
    }
    return ( 'value' in d ) ? !d.writable : ( typeof(d.set) !== 'function' );
}

/**
 * Own-property write that cannot trip the `__proto__` setter.
 *
 * @inner
 * @private
 * @param {object} out
 * @param {string|symbol} key
 * @param {*} value
 * @returns {void}
 */
function put(out, key, value) {
    if ( key === '__proto__' ) {
        Object.defineProperty(out, key, { value: value, writable: true, enumerable: true, configurable: true });
    } else {
        out[key] = value;
    }
}

/**
 * The plain value a materialised copy holds for `v`: a touched child is
 * materialised in turn so its overlay survives, an untouched plain child is
 * deep-cloned, anything else passes through.
 *
 * @inner
 * @private
 * @param {*} v
 * @param {WeakMap} meta - the view's target → state map
 * @returns {*}
 */
function materializeValue(v, meta) {
    if ( !isPlain(v) ) {
        return v;
    }
    var cm = meta.get(v);
    if ( cm ) {
        return cm.materialized || materialize(v, cm, meta);
    }
    return JSONClone(v);
}

/**
 * Build the node's private plain copy once: every own key of the shared
 * target (string names like `JSON.clone`, plus symbols so the proxy can still
 * report them), minus tombstones, with the overlay's entries on top. Getters
 * run against the shared object here, as they did under the clone.
 *
 * @inner
 * @private
 * @param {object} target - the shared node
 * @param {object} m - the node's view state
 * @param {WeakMap} meta - the view's target → state map
 * @returns {object} the plain copy, now served for every later access
 */
function materialize(target, m, meta) {
    var out     = Array.isArray(target) ? [] : {};
    var names   = Object.getOwnPropertyNames(target).concat(Object.getOwnPropertySymbols(target));
    var isArr   = Array.isArray(target);
    for (var i = 0; i < names.length; i++) {
        var k = names[i];
        if ( m.deleted[k] || ( k in m.overlay ) ) {
            continue;
        }
        if ( isArr && k === 'length' ) {
            continue;
        }
        put(out, k, materializeValue(target[k], meta));
    }
    var oKeys = Object.keys(m.overlay).concat(Object.getOwnPropertySymbols(m.overlay));
    for (var j = 0; j < oKeys.length; j++) {
        put(out, oKeys[j], m.overlay[oKeys[j]]);
    }
    m.materialized = out;
    return out;
}

/**
 * Wrap one shared node, once per view: the same target reached by two paths
 * gives the same proxy.
 *
 * @inner
 * @private
 * @param {object} target - a plain, extensible object or array
 * @param {WeakMap} meta - the view's target → state map
 * @returns {Proxy}
 */
function wrap(target, meta) {
    var m = meta.get(target);
    if ( m ) {
        return m.proxy;
    }
    m = { proxy: null, overlay: Object.create(null), deleted: Object.create(null), materialized: null };
    m.proxy = new Proxy(target, {
        get: function(t, k) {
            if ( k === VIEW_TAG ) {
                return true;
            }
            if ( m.materialized ) {
                return m.materialized[k];
            }
            if ( m.deleted[k] ) {
                return undefined;
            }
            if ( k in m.overlay ) {
                return m.overlay[k];
            }
            var v = t[k]; // an accessor runs against its own object
            if ( !isPlain(v) ) {
                return v;
            }
            if ( !Object.isExtensible(v) ) {
                // a frozen / sealed child: one private copy, stable and writable
                v = JSONClone(v);
                m.overlay[k] = v;
                return v;
            }
            return wrap(v, meta);
        },
        set: function(t, k, v) {
            if ( k === VIEW_TAG || isLockedForSet(t, k) ) {
                return false;
            }
            if ( m.materialized ) {
                put(m.materialized, k, v);
                return true;
            }
            delete m.deleted[k];
            m.overlay[k] = v;
            return true;
        },
        has: function(t, k) {
            if ( m.materialized ) {
                return ( k in m.materialized );
            }
            if ( m.deleted[k] ) {
                return false;
            }
            return ( k in m.overlay ) || ( k in t );
        },
        deleteProperty: function(t, k) {
            if ( isLockedOn(t, k) ) {
                return false;
            }
            if ( m.materialized ) {
                delete m.materialized[k];
                return true;
            }
            delete m.overlay[k];
            if ( Object.prototype.hasOwnProperty.call(t, k) ) {
                m.deleted[k] = true;
            }
            return true;
        },
        ownKeys: function(t) {
            if ( !m.materialized ) {
                materialize(t, m, meta);
            }
            return Reflect.ownKeys(m.materialized);
        },
        getOwnPropertyDescriptor: function(t, k) {
            var td = Reflect.getOwnPropertyDescriptor(t, k);
            if ( td && !td.configurable ) {
                // reported as-is (the engine's rule); a writable one carries the view's current value
                if ( ( 'value' in td ) && td.writable ) {
                    if ( m.materialized ) {
                        td.value = m.materialized[k];
                    } else if ( k in m.overlay ) {
                        td.value = m.overlay[k];
                    }
                }
                return td;
            }
            if ( m.materialized ) {
                return Reflect.getOwnPropertyDescriptor(m.materialized, k);
            }
            if ( m.deleted[k] ) {
                return undefined;
            }
            if ( k in m.overlay ) {
                return { value: m.overlay[k], writable: true, enumerable: true, configurable: true };
            }
            return td;
        },
        defineProperty: function(t, k, desc) {
            if ( k === VIEW_TAG || isLockedOn(t, k) || desc.configurable === false ) {
                return false;
            }
            if ( m.materialized ) {
                Object.defineProperty(m.materialized, k, desc);
                return true;
            }
            if ( typeof(desc.get) === 'undefined' && typeof(desc.set) === 'undefined' ) {
                delete m.deleted[k];
                m.overlay[k] = desc.value;
                return true;
            }
            materialize(t, m, meta);
            Object.defineProperty(m.materialized, k, desc);
            return true;
        },
        preventExtensions: function() {
            return false;
        },
        setPrototypeOf: function() {
            return false;
        }
    });
    meta.set(target, m);
    return m.proxy;
}

/**
 * Build a copy-on-write view over `root`.
 *
 * Never throws: a non-plain root — `undefined`, `null`, a primitive, a Buffer,
 * a class instance — is returned as-is, and a frozen or sealed root comes back
 * as a plain deep copy (the only shape that keeps it mutable for the caller).
 *
 * @memberof module:conf-view
 * @param {*} root - the shared tree (a plain object or array), or anything else
 * @returns {*} the view, or `root` itself / its deep copy for the cases above
 *
 * @example
 * var conf = lib.confView.create(sharedConf);
 * conf.content.app.proxy.api.port = 8443;   // lands in the view's overlay
 * sharedConf.content.app.proxy.api.port;    // → unchanged
 * @example
 * lib.confView.create(undefined);             // → undefined
 * lib.confView.create(Object.freeze({ a: 1 })); // → { a: 1 }, a plain mutable copy
 */
function create(root) {
    if ( !isPlain(root) ) {
        return root;
    }
    if ( !Object.isExtensible(root) ) {
        return JSONClone(root);
    }
    return wrap(root, new WeakMap());
}

/**
 * Whether `value` is a view node produced by `create()`. A materialised node's
 * plain children are not views, and neither is a deep copy handed back for a
 * frozen root.
 *
 * @memberof module:conf-view
 * @param {*} value
 * @returns {boolean}
 *
 * @example
 * lib.confView.isView(lib.confView.create({ a: 1 })); // → true
 * lib.confView.isView({ a: 1 });                      // → false
 * lib.confView.isView(null);                          // → false
 */
function isView(value) {
    return ( value !== null && typeof(value) === 'object' && value[VIEW_TAG] === true );
}

module.exports = { create: create, isView: isView };
