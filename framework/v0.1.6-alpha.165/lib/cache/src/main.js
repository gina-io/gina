'use strict';
if ( typeof(module) !== 'undefined' && module.exports ) {
    const lib = require('../../index');
}

var cache = new Map();


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
     * Import exixting cache
     * @param {array} initialCache
     */
    instance['from'] = function(initialCache) {
        cache = importedMapInstance = initialCache;
    }

    /**
     * Set entry by key
     *
     * @param {string} key
     * @param {string|object} value
     * @param {callback} cleanupFn
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
     * Check if cache has entry by key
     *
     * @param {string} key
     * @returns
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
     * Get cache stats
     *
     * @return stats
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
     * Invalidate cache by event
     *
     * @return stats
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
     * Invalidate cache by event
     *
     * @return stats
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