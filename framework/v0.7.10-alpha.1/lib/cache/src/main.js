'use strict';

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
 * @param {object} [options]
 * @param {number} [options.maxEntries=0] - Maximum number of entries (0 = unlimited).
 *   When the limit is reached and a new key is inserted, the least-recently-accessed
 *   entry is evicted first. Ignored for updates to existing keys.
 */
function Cache(options) {
    var isGFFCtx        = ( ( typeof(module) !== 'undefined' ) && module.exports ) ? false : true;
    // LRU cap: 0 means unlimited. Overridden by from() if the shared Map carries _maxEntries.
    var maxEntries      = (options && options.maxEntries > 0) ? ~~(options.maxEntries) : 0;
    var merge           = (isGFFCtx) ? require('lib/merge') : require('../../../lib/merge');
    var uuid            = (isGFFCtx) ? require('lib/uuid') : require('../../../lib/uuid');
    // var EventEmitter    = (isGFFCtx) ? EventTarget : require('events').EventEmitter;

    // `_events` is a PLAIN ARRAY of `{ id, cacheKey, event }` rows, matched in plain
    // JS. It was a `lib/collection`, whose condition-evaluating query engine cannot
    // handle a cache key: `findOne({cacheKey, event})` THREW on any key holding a
    // querystring (the `?`/`=` chars parse as operator tokens — the condition came out
    // as `"<key>""<key>"`, two operands and no operator), and `delete({...})` silently
    // matched nothing, so rows were never reclaimed. A cache key is opaque data, not a
    // query expression — it must never be handed to an evaluator.
    var instance = {
        _events              : [] //,
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
        // If the shared map was tagged with a cap by server.js, honour it
        if (typeof initialCache._maxEntries === 'number' && initialCache._maxEntries > 0) {
            maxEntries = initialCache._maxEntries;
        }
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
    /**
     * Evict the least-recently-accessed entry (O(n) scan).
     * Entries without a `lastAccessedAt` timestamp are treated as oldest and evicted first.
     * @inner
     */
    function evictLRU() {
        var oldest = null, oldestTime = Infinity;
        for (const [k, entry] of cache.entries()) {
            if (!entry.value || !entry.value.lastAccessedAt) { oldest = k; break; }
            var t = entry.value.lastAccessedAt.getTime();
            if (t < oldestTime) { oldestTime = t; oldest = k; }
        }
        if (oldest !== null) instance['delete'](oldest);
    }

    instance['set'] = function(key, value, cleanupFn = null) {
        const existing = cache.get(key);
        // Cancel existing timer and run cleanup before replacing the entry
        if (existing) {
            if (existing.timeout) clearTimeout(existing.timeout);
            if (existing.cleanup) existing.cleanup();
        }
        // Evict LRU entry when at capacity and this is a new key (not an update)
        if (maxEntries > 0 && !existing && cache.size >= maxEntries) {
            evictLRU();
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
                        // #B113 — route through instance.delete, NOT the raw Map.delete:
                        // the raw delete skips the entry's cleanup fn (leaving an fs body +
                        // .meta orphaned on disk) and its event-registration reclaim
                        // (stranding _events rows) on timer expiry.
                        instance['delete'](key);
                    }, Math.round(value.maxAge * 1000));
                } else if ( typeof(value.ttl) != 'undefined' && value.ttl > 0 ) {
                    // Pure sliding (no hard ceiling):
                    // Timer as a GC safety net for entries that are written but never
                    // accessed again. Reset on each get() call.
                    timeout = setTimeout(() => {
                        instance['delete'](key); // #B113 — cleanup fn + dropEvents run on expiry
                    }, Math.round(value.ttl * 1000));
                }
                // No ttl, no maxAge: no timer — entry lives until manually deleted
            } else {
                // Non-sliding (existing behaviour): absolute TTL from creation
                if ( typeof(value.ttl) != 'undefined' && value.ttl > 0 ) {
                    timeout = setTimeout(() => {
                        instance['delete'](key); // #B113 — cleanup fn + dropEvents run on expiry
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

            // Pure sliding (no maxAge): reset the GC safety-net timer.
            // Sliding + maxAge: no timer reset — the absolute ceiling timer handles final GC.
            if ( !value.expiresAt && entry.timeout ) {
                clearTimeout(entry.timeout);
                entry.timeout = setTimeout(() => {
                    instance['delete'](key); // #B113 — cleanup fn + dropEvents run on expiry
                }, ttlMs);
            }
        }

        // 3. Always stamp lastAccessedAt — needed for LRU eviction tracking across all entry types.
        //    For sliding entries this also resets the window (checked above using the old value).
        value.lastAccessedAt = new Date(now);

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
     * Drop every event registration held for `cacheKey`.
     *
     * An event registration's lifetime IS the entry's lifetime — a deleted entry can
     * never be invalidated again, and the next render re-registers it. Keeping the two
     * in step is what bounds `_events`.
     *
     * @inner
     * @param {string} cacheKey
     * @returns {number} rows dropped
     */
    function dropEvents(cacheKey) {
        if ( !cache._events || !cache._events.length ) {
            return 0;
        }
        var kept = [], dropped = 0;
        for (let i = 0, len = cache._events.length; i < len; i++) {
            if ( cache._events[i].cacheKey === cacheKey ) {
                dropped++;
            } else {
                kept.push(cache._events[i]);
            }
        }
        if ( dropped > 0 ) {
            // Truncate + refill in place: `_events` is stamped on the shared Map, and
            // other Cache instances hold that same array reference.
            cache._events.length = 0;
            for (let i = 0, len = kept.length; i < len; i++) {
                cache._events.push(kept[i]);
            }
        }
        return dropped;
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
        // Reclaim the key's event registrations. #B113: the sliding/TTL timers set()
        // installs now route expiry THROUGH here (was a raw Map.delete that skipped the
        // cleanup fn + this reclaim, orphaning an fs body + .meta and stranding rows), so
        // expiry reclaims them directly. Kept unconditional (runs even on a MISS) as a
        // defensive reclaim for any delete path that finds the entry already gone.
        dropEvents(key);
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
        // No entries left → no registrations left. Truncated in place (other Cache
        // instances hold this same array reference off the shared Map).
        if ( cache._events ) {
            cache._events.length = 0;
        }
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

    /**
     * Returns every key currently held, as a plain array snapshot. Complete —
     * unlike `stats()`, which classifies entries and drops non-object values,
     * this lists ALL keys (object- and string-valued alike). Cheap: a shallow
     * copy of the backing Map's key iterator, no per-entry work.
     *
     * The intended consumer is a scoped/namespaced sweep (e.g. `lib/render-cache`
     * flushing only the `static:`/`data:` output namespaces): enumerate `keys()`,
     * filter, then route each match through `delete(key)` (which clears the timer
     * and runs the cleanup fn).
     *
     * @memberof Cache
     * @returns {string[]} A snapshot of the current cache keys.
     * @example
     * cache.from(serverInstance._cached);
     * cache.keys().filter(function (k) { return /^static:/.test(k); });
     */
    instance['keys'] = function() {
        return Array.from(cache.keys());
    }

    /**
     * Returns a snapshot of the current cache state.
     *
     * Entry type is inferred from the key prefix and value properties:
     * - `'memory'`  — in-process response cache (`fromMemory: true`)
     * - `'fs'`      — filesystem response cache (`filename` set)
     * - `'session'` — HTTP/2 session (`http2session:` key prefix)
     * - `'other'`   — compiled swig templates and anything else
     *
     * `ttlRemaining` / `maxAgeRemaining` are in seconds (1 decimal place).
     * Both are `null` when no TTL is configured or the value is not an object.
     *
     * @memberof Cache
     * @returns {{ size: number, entries: Array<{
     *   key: string,
     *   type: 'memory'|'fs'|'session'|'other',
     *   sliding: boolean,
     *   createdAt: Date|null,
     *   lastAccessedAt: Date|null,
     *   ttlRemaining: number|null,
     *   maxAgeRemaining: number|null
     * }> }}
     */
    instance['stats'] = function() {
        var now = Date.now();
        var entries = [];

        for (const [key, entry] of cache.entries()) {
            var value = entry.value;
            if (!value || !/^object$/i.test(typeof(value))) continue;

            // Classify by key prefix, then value properties
            var type;
            if ( /^http2session:/.test(key) ) {
                type = 'session';
            } else if ( value.fromMemory ) {
                type = 'memory';
            } else if ( value.filename ) {
                type = 'fs';
            } else {
                type = 'other';
            }

            var ttlRemaining = null;
            if ( typeof(value.ttl) != 'undefined' && value.ttl > 0 && value.createdAt ) {
                var ttlMs = Math.round(value.ttl * 1000);
                if ( value.sliding === true ) {
                    var lastAccess = value.lastAccessedAt
                        ? value.lastAccessedAt.getTime()
                        : value.createdAt.getTime();
                    ttlRemaining = Math.max(0, (lastAccess + ttlMs - now) / 1000);
                } else {
                    ttlRemaining = Math.max(0, (value.createdAt.getTime() + ttlMs - now) / 1000);
                }
                ttlRemaining = Math.round(ttlRemaining * 10) / 10;
            }

            var maxAgeRemaining = null;
            if ( value.expiresAt ) {
                maxAgeRemaining = Math.max(0, (value.expiresAt.getTime() - now) / 1000);
                maxAgeRemaining = Math.round(maxAgeRemaining * 10) / 10;
            }

            entries.push({
                key            : key,
                type           : type,
                sliding        : value.sliding === true,
                createdAt      : value.createdAt      || null,
                lastAccessedAt : value.lastAccessedAt || null,
                ttlRemaining   : ttlRemaining,
                maxAgeRemaining: maxAgeRemaining
            });
        }

        return {
            size   : cache.size,
            entries: entries
        };
    }

    /**
     * Evict every entry registered to `event` and reclaim its registrations.
     *
     * @inner
     * @param {string} event
     * @param {*}      [data] - Accepted for signature compatibility; unused.
     * @returns {number} entries evicted (each key counted once, even when several
     *                   registrations point at it)
     */
    function onInvalidateEvent(event, data) {
        if ( !cache._events || !cache._events.length ) {
            return 0;
        }

        // Snapshot the target keys BEFORE deleting: instance.delete() mutates
        // `_events` (via dropEvents), so iterating it live would skip rows.
        var keys = [];
        for (let i = 0, len = cache._events.length; i < len; i++) {
            if ( cache._events[i].event === event && keys.indexOf(cache._events[i].cacheKey) < 0 ) {
                keys.push(cache._events[i].cacheKey);
            }
        }

        var removed = 0;
        for (let i = 0, len = keys.length; i < len; i++) {
            // delete() runs the entry's cleanup fn (removing an `fs` body + its
            // sidecar) and drops the key's registrations. It returns false when the
            // entry is already gone (e.g. a TTL timer beat us to it) — that is NOT an
            // eviction, so it is not counted, and counting successful deletes means a
            // key registered to the event more than once still counts once.
            if ( instance['delete'](keys[i]) ) {
                removed++;
            }
        }

        if (importedMapInstance) {
            importedMapInstance = cache;
        }
        return removed;
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
            cache._events = instance['_events'];
        }
        // if ( typeof(cache.eventHadlerInstance) == 'undefined' ) {
        //     // EventEmitter
        //     cache.eventHadlerInstance = instance['eventHadlerInstance'];
        // }

        for (let i=0, len=cacheEvents.length; i<len; i++ ) {
            // Idempotent: a route re-registers on EVERY cache-miss re-render, so
            // without this the registry would grow one row per render, forever.
            // The match is a plain `===` on both fields — never a query expression
            // (see the `_events` note at the top: a cache key is opaque data).
            var already = false;
            for (let j=0, jLen=cache._events.length; j<jLen; j++ ) {
                if (
                    cache._events[j].cacheKey === cacheKey
                    && cache._events[j].event === cacheEvents[i]
                ) {
                    already = true;
                    break;
                }
            }
            if ( !already ) {
                cache._events.push({
                    id: uuid(),
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
     * Return the UNIQUE cache keys currently registered to `event`, WITHOUT
     * evicting anything. Read-only companion to `invalidateByEvent`.
     *
     * A two-tier render-cache backend (`lib/render-cache`'s redis L2) needs
     * these keys to DEL them from L2 on an event invalidation — `invalidateByEvent`
     * returns only a COUNT, and by the time it returns the registrations are gone,
     * so the L2 keyset must be snapshotted BEFORE the eviction (both are sync, so a
     * `keysForEvent(event)` then `invalidateByEvent(event)` pair has no race). Unlike
     * the count (which tallies only successful L1 deletes), this lists EVERY
     * registered key — an entry already gone from L1 (a TTL beat us to it) may still
     * be live in L2 and must be DEL'd there too.
     *
     * @memberof Cache
     * @param {string} event
     * @returns {string[]} Unique cache keys registered to `event` (empty when none).
     *
     * @example
     * var keys = cache.keysForEvent('post#saved'); // snapshot BEFORE invalidating
     * cache.invalidateByEvent('post#saved');       // evict L1
     * keys.forEach(function (k) { l2.del(k); });    // and drop the same keys from L2
     */
    instance['keysForEvent'] = function(event) {
        if ( !cache._events || !cache._events.length ) {
            return [];
        }
        var keys = [];
        for (let i = 0, len = cache._events.length; i < len; i++) {
            if ( cache._events[i].event === event && keys.indexOf(cache._events[i].cacheKey) < 0 ) {
                keys.push(cache._events[i].cacheKey);
            }
        }
        return keys;
    };

    /**
     * Manually trigger invalidation for all cache keys registered to `event`.
     *
     * Each evicted entry has its cleanup fn run (an `fs` body + sidecar is removed
     * from disk) and its registrations reclaimed.
     *
     * @memberof Cache
     * @param {string} event  - Event name
     * @param {*}      [data] - Accepted for signature compatibility; unused.
     * @returns {number} entries evicted (0 when nothing is registered to `event`)
     *
     * @example
     * cache.setEvents('static:blog:/posts', ['post#saved']);
     * cache.invalidateByEvent('post#saved'); // => 1
     */
    instance['invalidateByEvent'] = function(event, data) {
        // cache.eventHadlerInstance.emit('cache#invalidate::'+event, event, data);
        return onInvalidateEvent(event, data);
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