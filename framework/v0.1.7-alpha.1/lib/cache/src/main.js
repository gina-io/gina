'use strict';
if ( typeof(module) !== 'undefined' && module.exports ) {
    const lib = require('../../index');
}

/**
 * @module lib/cache
 * @description In-process key/value cache backed by a `Map`. Supports optional
 * TTL-based auto-expiry, sliding-window expiration, absolute expiration ceiling
 * (maxAge), event-driven invalidation, and fs-cached entries.
 * Works in Node.js (CommonJS) and browser (AMD / GFF) contexts.
 *
 * Do not share a single `Cache` instance across requests — call `cache.from()`
 * to point a new instance at the server's shared Map.
 *
 * ### Expiration modes
 *
 * | Config | Behaviour |
 * |--------|-----------|
 * | `{ ttl }` | Absolute: entry expires `ttl` seconds after creation. Default. |
 * | `{ ttl, sliding: true }` | Sliding: entry expires `ttl` seconds after the **last access**. No hard ceiling — entry may live indefinitely while busy. |
 * | `{ ttl, sliding: true, maxAge }` | Sliding + ceiling: entry expires `ttl` seconds after the last access **or** `maxAge` seconds after creation, whichever comes first. Recommended when `sliding` is enabled. |
 *
 * `maxAge` is only meaningful when `sliding: true`. Without sliding, `ttl` already
 * defines the absolute lifetime.
 *
 * @example
 * var cache = new Cache();
 * cache.from(serverInstance._cached);   // attach to server-level Map
 * cache.set('key', { value: 'v', ttl: 60 });
 * cache.get('key');                      // { value: 'v', ttl: 60, createdAt: … }
 *
 * cache.set('key2', { content: '…', ttl: 300, sliding: true, maxAge: 3600 });
 * cache.get('key2');  // resets the 300 s sliding window; hard ceiling stays at 1 h
 */

var cache = new Map();


/**
 * In-process cache instance factory.
 * Returns an `instance` object (not `this`) — usage: `var c = new Cache()`.
 *
 * @class Cache
 * @constructor
 */
function Cache() {
    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');
    var uuid            = (isGFFCtx) ? require('vendor/uuid') : require('uuid');
    var Collection      = (isGFFCtx) ? require('lib/collection') : require('../../../lib/collection');
    // var EventEmitter    = (isGFFCtx) ? EventTarget : require('events').EventEmitter;

    var instance = {
        _events              : new Collection() //,
        // eventHadlerInstance  : new EventEmitter()
    };
    var importedMapInstance = null;

    /**
     * Attach this instance to an existing shared `Map` (e.g. `serverInstance._cached`).
     * All subsequent reads/writes will operate on that map.
     *
     * @memberof Cache
     * @param {Map} initialCache - Pre-existing cache Map to adopt
     * @returns {void}
     */
    instance['from'] = function(initialCache) {
        cache = importedMapInstance = initialCache;
    }

    /**
     * Store a value under `key`.
     *
     * When `value.sliding` is `false` (the default), `value.ttl` is an absolute
     * duration from creation — the entry is deleted `ttl` seconds after `set()`.
     * This is the existing behaviour, unchanged.
     *
     * When `value.sliding` is `true`, `value.ttl` becomes a sliding window: the
     * entry is evicted if not accessed for `ttl` seconds. An optional `value.maxAge`
     * (seconds) caps the absolute lifetime from creation regardless of access — this
     * is strongly recommended when `sliding` is enabled to prevent unbounded growth.
     *
     * `set()` counts as the first access: `lastAccessedAt` is stamped equal to
     * `createdAt` at write time.
     *
     * @memberof Cache
     * @param {string}        key                   - Cache key
     * @param {string|object} value                 - Value to store
     * @param {number}   [value.ttl]                - Seconds: absolute TTL (default) or sliding window (`sliding: true`)
     * @param {boolean}  [value.sliding=false]      - Enable sliding expiration
     * @param {number}   [value.maxAge]             - Seconds: absolute lifetime ceiling (only with `sliding: true`)
     * @param {function|null} [cleanupFn=null]      - Called before the entry is evicted or replaced
     * @returns {void}
     */
    instance['set'] = function(key, value, cleanupFn = null) {
        const existing = cache.get(key);
        // Cancel existing timer and run cleanup before replacing the entry
        if (existing) {
            if (existing.timeout) clearTimeout(existing.timeout);
            if (existing.cleanup) existing.cleanup();
        }

        if (
            /^object$/i.test(typeof(value))
        ) {
            value.createdAt = new Date();

            var slidingEnabled = (value.sliding === true);
            // set() counts as the first access
            value.lastAccessedAt = value.createdAt;

            // Pre-compute absolute expiry timestamp — used by get() for the lazy ceiling check.
            // maxAge is only meaningful when sliding is enabled.
            if ( slidingEnabled && typeof(value.maxAge) != 'undefined' && value.maxAge > 0 ) {
                value.expiresAt = new Date( value.createdAt.getTime() + Math.round(value.maxAge * 1000) );
            }

            var timeout = undefined;

            if ( slidingEnabled ) {
                if ( typeof(value.maxAge) != 'undefined' && value.maxAge > 0 ) {
                    // Sliding + absolute ceiling:
                    // One timer for the hard ceiling only — no per-access churn.
                    // The sliding window is enforced lazily in get().
                    timeout = setTimeout(() => {
                        cache.delete(key);
                    }, Math.round(value.maxAge * 1000));
                } else if ( typeof(value.ttl) != 'undefined' && value.ttl > 0 ) {
                    // Pure sliding (no hard ceiling):
                    // Timer as a GC safety net for entries that are written but never
                    // accessed again. Reset on each get() call.
                    timeout = setTimeout(() => {
                        cache.delete(key);
                    }, Math.round(value.ttl * 1000));
                }
                // No ttl, no maxAge: no timer — entry lives until manually deleted
            } else {
                // Non-sliding (existing behaviour): absolute TTL from creation
                if ( typeof(value.ttl) != 'undefined' && value.ttl > 0 ) {
                    timeout = setTimeout(() => {
                        cache.delete(key);
                    }, Math.round(value.ttl * 1000));
                }
            }

            if ( timeout !== undefined ) {
                cache.set(key, { value, timeout, cleanup: cleanupFn || null });
            } else {
                cache.set(key, { value, cleanup: cleanupFn || null });
            }
        } else {
            cache.set(key, {
                value,
                cleanup: cleanupFn || null
            });
        }

        if (importedMapInstance) {
            importedMapInstance = cache;
        }
    }

    /**
     * Get entry by key.
     *
     * For sliding-window entries (`sliding: true`), stamps `lastAccessedAt` and
     * resets the GC safety-net timer (pure sliding only — no timer churn when
     * `maxAge` is set). Returns `undefined` and evicts the entry if either the
     * sliding window or the absolute ceiling has expired.
     *
     * @memberof Cache
     * @param {string} key
     * @returns {string|object|undefined} The stored value, or `undefined` on miss or expiry
     */
    instance['get'] = function(key) {
        const entry = cache.get(key);
        if (!entry) return undefined;

        const value = entry.value;
        // Only object values carry sliding/expiry metadata
        if (!value || !/^object$/i.test(typeof(value))) return value;

        var now = Date.now();

        // 1. Absolute ceiling check (sliding + maxAge)
        if ( value.expiresAt && now >= value.expiresAt.getTime() ) {
            instance['delete'](key);
            return undefined;
        }

        // 2. Sliding window check
        if ( value.sliding === true && typeof(value.ttl) != 'undefined' && value.ttl > 0 ) {
            var ttlMs = Math.round(value.ttl * 1000);
            var lastAccess = value.lastAccessedAt
                ? value.lastAccessedAt.getTime()
                : value.createdAt.getTime();

            if ( now - lastAccess > ttlMs ) {
                // Sliding window expired: not accessed within ttl seconds
                instance['delete'](key);
                return undefined;
            }

            // Still alive: stamp the access time
            value.lastAccessedAt = new Date(now);

            // Pure sliding (no maxAge): reset the GC safety-net timer.
            // Sliding + maxAge: no timer reset — the absolute ceiling timer handles final GC.
            if ( !value.expiresAt && entry.timeout ) {
                clearTimeout(entry.timeout);
                entry.timeout = setTimeout(() => {
                    cache.delete(key);
                }, ttlMs);
            }
        }

        if (importedMapInstance) {
            importedMapInstance = cache;
        }

        return value;
    }

    /**
     * Returns `true` when the cache holds an entry for `key`.
     *
     * @memberof Cache
     * @param {string} key
     * @returns {boolean}
     */
    instance['has'] = function(key) {
        return cache.has(key);
    }

    /**
     * Delete entry by key
     *
     * @param {string} key
     *
     * @return {boolean} successStatus (true||false)
     */
    instance['delete'] = function(key) {
        const entry = cache.get(key);
        if (entry?.timeout) clearTimeout(entry.timeout);
        if (entry) {
            if (entry.cleanup) {
                // Prevent resource leaks
                entry.cleanup();
            }

            cache.delete(key);
            if (importedMapInstance) {
                importedMapInstance = cache;
            }
            return true;
        }
        return false;
    }

    /**
     * Safely clear entire cache
     *
     */
    instance['clear'] = function() {
        for (const [key, entry] of cache.entries()) {
            if (entry?.timeout) clearTimeout(entry.timeout);
            if (entry.cleanup) {
                try {
                    entry.cleanup();
                } catch (err) {
                    console.error('Cache cleanup error for key:', key, err);
                }
            }
        }
        cache.clear();
        if (importedMapInstance) {
            importedMapInstance = cache;
        }
    }

    /**
     * Returns the number of entries currently in the cache.
     *
     * @memberof Cache
     * @returns {number} Entry count
     */
    instance['size'] = function() {
        return cache.size;
    }

    function onInvalidateEvent(event, data) {
        console.debug('[cache::onInvalidateEvent] ', event, data);

        if (!cache._events) {
            return;
        }

        var found = cache._events
            .setSearchOption('cacheKey', 'skipEval', true)
            .find({ event: event});
        for (let i=0, len=found.length; i<len; i++) {
            instance['delete'](found[i].cacheKey);
            cache._events
                .setSearchOption('cacheKey', 'skipEval', true)
                .delete({cacheKey: found[i].cacheKey, event: event });
        }

        if (importedMapInstance) {
            importedMapInstance = cache;
        }
    }


    /**
     * Register cache invalidation rules: when any of `cacheEvents` is emitted,
     * the entry at `cacheKey` is automatically deleted.
     *
     * @memberof Cache
     * @param {string}   cacheKey    - Key to watch
     * @param {string[]} cacheEvents - Event names that trigger invalidation
     * @param {function} [cb]        - Optional callback after registration
     * @returns {void}
     */
    instance['setEvents'] = function(cacheKey, cacheEvents, cb) {
        if ( typeof(cache._events) == 'undefined' ) {
            // collection
            cache._events = instance['_events'];
        }
        // if ( typeof(cache.eventHadlerInstance) == 'undefined' ) {
        //     // EventEmitter
        //     cache.eventHadlerInstance = instance['eventHadlerInstance'];
        // }

        // Placing listeners
        for (let i=0, len=cacheEvents.length; i<len; i++ ) {
            // Only place if not already defiend
            // let trigger = 'cache#invalidate::'+ cacheEvents[i];
            // if ( typeof(cache.eventHadlerInstance._events[trigger]) == 'undefined' ) {
            //     console.debug('[cache][set listener] ',trigger);
            //     cache.eventHadlerInstance.on(trigger, onInvalidateEvent);
            // }

            if ( !cache._events.setSearchOption('cacheKey', 'skipEval', true).findOne({cacheKey: cacheKey, event: cacheEvents[i]}) ) {
                cache._events.insert({
                    id: uuid.v4(),
                    cacheKey: cacheKey,
                    event: cacheEvents[i]
                });
            }
        }

        if (importedMapInstance) {
            importedMapInstance = cache;
        }
    }

    /**
     * Manually trigger invalidation for all cache keys registered to `event`.
     *
     * @memberof Cache
     * @param {string} event - Event name
     * @param {*}      [data] - Arbitrary event payload (passed to the handler)
     * @returns {void}
     */
    instance['invalidateByEvent'] = function(event, data) {
        // console.debug('[cache][invalidateByEvent] ',event, data);
        // cache.eventHadlerInstance.emit('cache#invalidate::'+event, event, data);
        onInvalidateEvent(event, data)
    }

    return instance;
};

if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Publish as node.js module
    module.exports = Cache
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define(function() { return Cache })
}