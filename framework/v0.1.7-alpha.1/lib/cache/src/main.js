'use strict';
if ( typeof(module) !== 'undefined' && module.exports ) {
    const lib = require('../../index');
}

/**
 * @module lib/cache
 * @description In-process key/value cache backed by a `Map`. Supports optional
 * TTL-based auto-expiry, event-driven invalidation, and fs-cached entries.
 * Works in Node.js (CommonJS) and browser (AMD / GFF) contexts.
 *
 * Do not share a single `Cache` instance across requests — call `cache.from()`
 * to point a new instance at the server's shared Map.
 *
 * @example
 * var cache = new Cache();
 * cache.from(serverInstance._cached);   // attach to server-level Map
 * cache.set('key', { value: 'v', ttl: 60 });
 * cache.get('key');                      // { value: 'v', ttl: 60, createdAt: … }
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
     * Store a value under `key`. When `value.ttl` is set (seconds), the entry
     * is automatically deleted after that duration.
     *
     * @memberof Cache
     * @param {string}        key              - Cache key
     * @param {string|object} value            - Value to store; objects may include `ttl` (seconds)
     * @param {function|null} [cleanupFn=null] - Called before the entry is evicted or replaced
     * @returns {void}
     */
    instance['set'] = function(key, value, cleanupFn = null) {
        const existing = cache.get(key);
        // If old entry exists, clean it up first
        if (existing && existing.cleanup) {
            existing.cleanup();
        }

        if (
            /^object$/i.test(typeof(value))
        ) {
            value.createdAt = new Date();

            if ( typeof(value.ttl) != 'undefined' ) {
                // Converting Ms to secondes
                var ttlMs = 1000 * ~~(value.ttl);
                const timeout = setTimeout(() => {
                    cache.delete(key);
                }, ttlMs);

                cache.set(key, {
                    value,
                    timeout,
                    cleanup: cleanupFn || null
                });
            } else {
                cache.set(key, {
                    value,
                    cleanup: cleanupFn || null
                });
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
     * Get entry by key
     *
     * @param {string} key
     *
     * @return {object} entry
     */
    instance['get'] = function(key) {
        const entry = cache.get(key);
        return entry ? entry.value : undefined;
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