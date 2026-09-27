'use strict';

/**
 * @module lib/render-cache
 * @description Pluggable output/render-cache backend dispatcher. Wraps the
 * shared in-process `lib/cache` Map (the `memory` strategy / L1 index) behind a
 * uniform interface so the render controllers and the server read path go
 * through one backend seam instead of touching the backing Map directly.
 *
 * Strategies:
 * - `memory` — in-process Map (via `lib/cache`); volatile, fastest per-serve.
 * - `fs`     — disk-backed under `server.cache.path`; entry metadata lives in
 *              the Map, the rendered body on disk. Survives a restart: on a
 *              Map miss `get()`/`has()` read the body back from disk, replaying
 *              the entry from a sibling `<file>.meta` JSON sidecar and
 *              preserving the ORIGINAL absolute expiry (a restart never extends
 *              a TTL). See `from(store, cachePath)`.
 * - `redis`  — shared L1 (in-process Map) + L2 (redis, connector-homed via
 *              `lib/render-cache-store`, stashed at `process.gina._renderCacheStore`).
 *              `set('redis')` writes L1 synchronously + L2 fire-and-forget (the
 *              response never waits on redis); `warm()` reads L2 on an L1 miss and
 *              repopulates L1 with the AUTHORITATIVE remaining PTTL. `delete` /
 *              `clear` / `invalidateByEvent` also DEL the L2 keys so a stale body
 *              cannot be warmed back (B1). Cross-replica eviction of stale L1
 *              (pub/sub) is a later slice; note an event invalidation DELs from L2
 *              only the keys THIS replica has registered — a key rendered and
 *              registered solely on another replica stays in L2 until its natural
 *              expiry, so the staleness bound is the entry's own TTL (L1 and L2
 *              expire it independently). Fail-open throughout: a down/slow redis
 *              degrades to per-replica caching, never an error on the request path.
 *
 * Server-only: this module is never part of the browser AMD bundle (unlike
 * `lib/cache`, whose `define()` block is dormant — nothing in the browser
 * build graph requires it). Keeping the fs/redis I/O here — out of `lib/cache`
 * — keeps the hot, multi-purpose Map primitive (which also holds `swig:`
 * compiled templates and `http2session:` entries) free of storage-backend
 * logic.
 *
 * The write dispatch is a behaviour-identical extraction of the memory/fs
 * branch previously inlined in each render delegate's `writeCache()`.
 *
 * @example
 * var renderCache = new RenderCache({ store: serverInstance._cached });
 * await renderCache.set('memory', 'static:demo:/', { ttl: 60 }, { content: html });
 * renderCache.get('static:demo:/');   // -> the cached entry, or undefined
 *
 * @example
 * // fs restart-hardening: the server read path configures the cache root so a
 * // Map miss falls back to disk.
 * renderCache.from(serverInstance._cached, options.cachePath);
 * renderCache.has('static:demo:/page');  // true when the disk file exists
 * renderCache.get('static:demo:/page');  // reconstructs the entry from disk + .meta
 */

var fs     = require('fs');
var crypto = require('crypto');
var Cache  = require('../../cache/src/main');

/**
 * Build the on-disk paths for an `fs`-strategy entry. Single source of truth
 * shared by `set('fs')` (write) and the read-back (`has`/`get`), so the write
 * filename and the read-back filename can never drift.
 *
 * Layout: `<root>/<bundle>[/<token>]/<html|data><url>.<ext>`, trailing-slash
 * url → `.../index.<ext>`, resolved through the `_` PathObject global exactly
 * as the pre-strategy code did. The release-namespace `token` (empty by
 * default) is a path segment under the bundle so a namespace change lands NEW
 * files in a fresh dir — old-namespace files are orphaned and, on read-back,
 * never matched (correct cross-namespace invalidation).
 *
 * @inner
 * @param {string} root   - Cache root (`server.cache.path`).
 * @param {string} token  - Release namespace (`buildKey`'s token) or '' for the flat layout.
 * @param {string} bundle - Bundle name.
 * @param {string} kind   - 'data' (JSON, `/data`+`.json`) | anything else (HTML, `/html`+`.html`).
 * @param {string} url    - Request URL (`req.originalUrl`).
 * @returns {{ body: string, meta: string }} Absolute body path + its `.meta` sidecar path.
 */
function fsPaths(root, token, bundle, kind, url) {
    var sub = ( kind === 'data' ) ? '/data' : '/html';
    var ext = ( kind === 'data' ) ? '.json' : '.html';
    if ( url.endsWith('/') ) {
        url += 'index';
    }
    var ns   = token ? ('/' + token) : '';
    var body = _(root + '/' + bundle + ns + sub + url + ext, true);
    return { body: body, meta: body + '.meta' };
}

/**
 * Parse an `fs`-eligible cache key into the pieces needed to reconstruct its
 * on-disk path. Key shape: `[<token>:]<static|data>:<bundle>:<url>` (the
 * optional leading segment is the release namespace `buildKey` prepends). The
 * url may itself contain colons (querystrings), so it is the rejoined
 * remainder; `buildKey` sanitizes the token to `[A-Za-z0-9._-]` (no colon), so
 * the leading segments split unambiguously.
 *
 * `static:` → HTML kind, `data:` → JSON kind (mirrors the delegate write:
 * swig/nunjucks write `static:`+kind `html`, json writes `data:`+kind `data`).
 * Returns `null` for any key that is not one of the two output namespaces (a
 * `swig:` / `http2session:` key has no disk file).
 *
 * @inner
 * @param {string} key
 * @returns {{ token: string, kind: string, bundle: string, url: string }|null}
 */
function parseFsKey(key) {
    if ( typeof(key) != 'string' ) {
        return null;
    }
    var parts = key.split(':');
    var idx   = 0;
    var token = '';
    // A leading segment that is not the kind prefix is the release namespace.
    if ( parts[0] !== 'static' && parts[0] !== 'data' ) {
        token = parts[0];
        idx   = 1;
    }
    var prefix = parts[idx];
    if ( prefix !== 'static' && prefix !== 'data' ) {
        return null;
    }
    var bundle = parts[idx + 1];
    var url    = parts.slice(idx + 2).join(':');
    if ( !bundle || !url ) {
        return null;
    }
    return { token: token, kind: ( prefix === 'data' ) ? 'data' : 'html', bundle: bundle, url: url };
}

/**
 * Resolve the release-namespace token that scopes output-cache keys +
 * fs paths: `GINA_CACHE_NAMESPACE` (an operator-set per-deploy id — a git SHA
 * / build number) wins; else `GINA_VERSION` (set at runtime, so the cache
 * auto-invalidates on a framework upgrade); else '' (the flat, pre-namespace
 * layout). Sanitized to a safe identifier so it is usable as BOTH a
 * colon-delimited key segment and an fs path segment. Read fresh each call —
 * process env is stable, and this keeps it test-controllable.
 *
 * @inner
 * @returns {string}
 */
function resolveReleaseToken() {
    var ns = '';
    if ( typeof(getEnvVar) === 'function' ) {
        ns = getEnvVar('GINA_CACHE_NAMESPACE') || getEnvVar('GINA_VERSION') || '';
    }
    return String(ns).replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Remove an `fs` entry's body file and its `.meta` sidecar (best-effort — a
 * missing file is not an error). Used as the eviction cleanup and on read-back
 * of an already-expired disk entry.
 *
 * @inner
 * @param {string} body - Absolute body path (the `.meta` sibling is derived).
 * @returns {void}
 */
function rmFsFiles(body) {
    try { fs.rmSync(body); } catch (e) {}
    try { fs.rmSync(body + '.meta'); } catch (e) {}
}

// Once-per-process flag for `_warnL2Once` — module scope on purpose: several
// RenderCache instances exist per process (one per render delegate + the server
// read path), and the warn's job is ONE signal per deployment, not one per site.
var _l2ErrorWarned = false;

// The recognised output-cache strategies. A defined `cache.type` outside this set is
// a typo that silently disabled caching (#B114) — validateConfig names it loudly.
var _RC_STRATEGIES = /^(memory|fs|redis)$/i;

// #B238 — accepted `server.cache.name` grammar (the RFC 9211 Cache-Status
// identifier): a conservative RFC 8941 Token subset — a letter, then up to 63
// of [A-Za-z0-9._-]. Same charset as resolveReleaseToken's sanitizer, but this
// one VALIDATES rather than sanitizes: an identifier the operator did not
// write must never reach the wire, so an invalid value falls back to the
// default and validateConfig names it at boot.
var _RC_NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * Once-per-process L2 failure warn. Fail-open must stay silent per-operation
 * (no log spam during an outage — the store's client `error` listener already
 * reports connection drops at reconnect cadence), but a PERSISTENT
 * command-level failure (e.g. a WRONGTYPE from a key/prefix collision with
 * another application writing the same redis) would otherwise be COMPLETELY
 * invisible: the deployment silently degrades to per-replica caching forever.
 * One warn names the failure; everything after it stays silent.
 *
 * @inner
 * @param {string} op  - Operation label ('write' | 'del' | 'read' | 'read (corrupt value)').
 * @param {*}      err - The rejection reason.
 * @returns {void}
 */
function _warnL2Once(op, err) {
    if ( _l2ErrorWarned ) {
        return;
    }
    _l2ErrorWarned = true;
    console.warn('[render-cache] redis L2 ' + op + ' failed — fail-open, degrading to per-replica caching (further L2 errors are not logged): ' + ((err && err.message) || err));
}

/**
 * Render-cache dispatcher factory. Returns an `instance` object (not `this`) —
 * usage: `var rc = new RenderCache({ store })`.
 *
 * @class RenderCache
 * @constructor
 * @param {object} [options]
 * @param {Map}    [options.store] - Shared cache Map to adopt (e.g. `serverInstance._cached`).
 * @param {string} [options.path]  - Cache root (`server.cache.path`) for fs read-back.
 */
function RenderCache(options) {
    options = options || {};

    // The `memory` strategy / L1 index — the shared lib/cache Map primitive.
    // (lib/cache's backing Map is a process singleton, so every RenderCache in
    // the process points at the same store once `from()` is called.)
    var mem = new Cache();
    if ( options.store ) {
        mem.from(options.store);
    }

    // Cache root for the fs read-back. Per-INSTANCE (the backing Map is shared;
    // the path is not). Only the server read path configures it (via `from()`),
    // so on the render delegates' instances it stays null and the disk-aware
    // has()/get() below fall back to the Map-only behaviour — byte-identical.
    var _cachePath = ( typeof(options.path) != 'undefined' && options.path ) ? options.path : null;

    /**
     * The redis L2 store (render-cache Slice 4), resolved LAZILY at each use
     * site. The render delegates construct their `RenderCache` at module load —
     * BEFORE `gna.js` boot stashes `process.gina._renderCacheStore` — so reading
     * it in the constructor would pin `null` forever. `options.l2` is the
     * test-injection seam (a store exposing `set/warmRead/del`); production reads
     * the process stash.
     *
     * @inner
     * @returns {object|null}
     */
    function _l2() {
        return options.l2 || (process.gina && process.gina._renderCacheStore) || null;
    }

    /**
     * Swallow a fire-and-forget L2 promise rejection (fail-open, B4/B5): a
     * down/slow redis must never reject into the request path — L1 keeps serving.
     * The rejection is not fully mute: the FIRST one per process is surfaced via
     * `_warnL2Once` so a persistent command-level failure stays diagnosable.
     *
     * @inner
     * @param {*}      p    - A promise (or non-promise, ignored).
     * @param {string} [op] - Operation label for the once-per-process warn.
     * @returns {void}
     */
    function _forget(p, op) {
        if ( p && typeof(p.catch) === 'function' ) {
            p.catch(function (e) { _warnL2Once(op || 'operation', e); });
        }
    }

    var instance = {};

    /**
     * Reconstruct the on-disk body path for `key`, or `null` when read-back is
     * not applicable (no cache root configured, or a non-output-namespace key).
     *
     * @inner
     * @param {string} key
     * @returns {string|null}
     */
    function fsBodyFor(key) {
        if ( !_cachePath ) {
            return null;
        }
        var p = parseFsKey(key);
        if ( !p ) {
            return null;
        }
        return fsPaths(_cachePath, p.token, p.bundle, p.kind, p.url).body;
    }

    /**
     * Read an `fs` entry back from disk after a restart (Map miss). Reads the
     * `.meta` sidecar, drops an already-expired entry (preserving the ORIGINAL
     * absolute expiry — a restart must never extend a TTL), repopulates the Map
     * and returns the reconstructed entry. `undefined` on any miss.
     *
     * Expiry preservation (the entry's `createdAt` is re-stamped to `now` by
     * `mem.set`, so the adjusted `ttl`/`maxAge` below make it expire at the
     * ORIGINAL absolute time):
     * - non-sliding: `ttl` := remaining seconds to the original `createdAt+ttl`.
     * - sliding + maxAge: `maxAge` := remaining seconds to the original ceiling;
     *   the idle `ttl` window restarts (a read-back IS an access).
     * - pure sliding (no maxAge): the idle window cannot be evaluated from disk
     *   (lastAccess is not persisted), so a read-back is treated as a fresh
     *   access — an accepted restart-recovery imprecision.
     *
     * @inner
     * @param {string} key
     * @returns {object|undefined}
     */
    function readBack(key) {
        var body = fsBodyFor(key);
        if ( !body || !fs.existsSync(body) ) {
            return undefined;
        }
        var meta;
        try {
            meta = JSON.parse(fs.readFileSync(body + '.meta', 'utf8'));
        } catch (e) {
            // No / unreadable sidecar: cannot replay expiry safely — treat as a
            // miss. The next render re-writes both body + sidecar (self-heals).
            return undefined;
        }
        var now       = Date.now();
        var createdMs = new Date(meta.createdAt).getTime();
        if ( isNaN(createdMs) ) {
            return undefined;
        }

        var entry = {
            filename        : body,
            responseHeaders : meta.responseHeaders,
            visibility      : meta.visibility
        };
        var hasTtl = ( typeof(meta.ttl) != 'undefined' && meta.ttl > 0 );

        if ( meta.sliding === true ) {
            entry.sliding = true;
            if ( hasTtl ) {
                // Idle window restarts on this access — ttl unchanged.
                entry.ttl = meta.ttl;
            }
            if ( typeof(meta.maxAge) != 'undefined' && meta.maxAge > 0 ) {
                var ceilRemainingMs = createdMs + Math.round(meta.maxAge * 1000) - now;
                if ( ceilRemainingMs <= 0 ) {
                    rmFsFiles(body);
                    return undefined;
                }
                // Preserve the absolute ceiling: mem.set stamps
                // expiresAt = now + maxAge*1000 = original createdAt + maxAge*1000.
                entry.maxAge = ceilRemainingMs / 1000;
            }
            // pure sliding (no maxAge): fresh access, documented imprecision.
        } else {
            if ( hasTtl ) {
                var remainingMs = createdMs + Math.round(meta.ttl * 1000) - now;
                if ( remainingMs <= 0 ) {
                    rmFsFiles(body);
                    return undefined;
                }
                // Preserve absolute expiry: mem.set stamps createdAt = now, so
                // now + remainingMs = original createdAt + ttl*1000.
                entry.ttl = remainingMs / 1000;
            }
            // no ttl → non-expiring entry (rare) — reconstruct as-is.
        }

        // Repopulate the Map: installs the timer + the same disk-cleanup fn as a
        // fresh write, and stamps createdAt/lastAccessedAt/expiresAt.
        mem.set(key, entry, function () { rmFsFiles(entry.filename); });

        // Restore the event registrations the sidecar carried. Without this the entry
        // comes back off disk with NO registration, so firing its event would not
        // evict it and it would serve stale until TTL — the fs half of the
        // invalidation contract, silently broken across a restart. Registration is
        // in-heap only, so this must not re-write the sidecar (it already holds them).
        if ( Array.isArray(meta.events) && meta.events.length ) {
            mem.setEvents(key, meta.events);
        }

        return mem.get(key);
    }

    /**
     * Point the memory strategy at a shared cache Map. Idempotent — the server
     * hands the same store on every request. Optionally configures the fs cache
     * root used by the disk read-back (only the server read path passes it).
     *
     * @memberof RenderCache
     * @param {Map}    store
     * @param {string} [cachePath] - Cache root (`server.cache.path` / the top-level
     *                               `cachePath` alias) enabling fs restart read-back.
     * @returns {RenderCache} this instance (chainable)
     */
    instance.from = function(store, cachePath) {
        mem.from(store);
        // Only update when provided — never clear a previously-set path.
        if ( typeof(cachePath) != 'undefined' && cachePath ) {
            _cachePath = cachePath;
        }
        return instance;
    };

    /**
     * Build a fully-namespaced output-cache key: `[<token>:]<kind>:<bundle>:<url>`,
     * where `<token>` is the resolved release namespace
     * (`GINA_CACHE_NAMESPACE || GINA_VERSION || ''`). Empty token → the flat,
     * pre-namespace format (`<kind>:<bundle>:<url>`, unchanged).
     *
     * The SINGLE source of the key format — the 3 render delegates (write) and
     * the server read path all call this, so the writer/reader key can never
     * drift (the #C3 bundle-namespace bug was exactly such a drift). Only scope
     * the two output namespaces through here: `static:` (HTML) and `data:`
     * (JSON) — never `swig:` (compiled templates) or `http2session:`.
     *
     * @memberof RenderCache
     * @param {string} kind   - 'static' (HTML) | 'data' (JSON).
     * @param {string} bundle - Bundle name.
     * @param {string} url    - Request URL (`req.originalUrl` on write, `request.url` on read).
     * @returns {string} The namespaced cache key.
     */
    instance.buildKey = function(kind, bundle, url) {
        var token = resolveReleaseToken();
        return ( token ? token + ':' : '' ) + kind + ':' + bundle + ':' + url;
    };

    /**
     * Store a rendered entry under `key`, dispatching on strategy `type`.
     *
     * Behaviour-identical extraction of the memory/fs branch previously inlined
     * in each render delegate's `writeCache()`:
     * - `memory` — stamps `fromMemory: true` + the inline `content`, `set()`s it.
     * - `fs`     — writes the body to `<path>/<bundle>/<html|data><url>.<html|json>`
     *              (creating the dir), stamps `filename`, `set()`s the entry with
     *              a cleanup fn that removes the file (+ its `.meta`) on eviction,
     *              and writes a `<file>.meta` JSON sidecar carrying everything the
     *              server read path replays after a restart
     *              (`createdAt`/`ttl`/`sliding`/`maxAge`/`visibility`/`responseHeaders`).
     * - anything else (incl. `undefined`) — no-op (matches the pre-strategy
     *              behaviour: neither `/^memory$/` nor `/^fs$/` matched, so
     *              nothing was stored).
     *
     * @memberof RenderCache
     * @param {string} type   - 'memory' | 'fs' (case-insensitive).
     * @param {string} key    - Fully-namespaced cache key.
     * @param {object} entry  - The cache entry (responseHeaders / visibility / ttl / sliding / maxAge).
     * @param {object} [payload]
     * @param {string} [payload.content] - Rendered body (memory: stored inline; fs: written to disk).
     * @param {string} [payload.path]    - Cache root (`server.cache.path`) — fs only.
     * @param {string} [payload.bundle]  - Bundle name — fs path segment.
     * @param {string} [payload.url]     - `req.originalUrl` — fs path segment.
     * @param {string} [payload.kind]    - 'html' | 'data' — selects the fs subdir + extension.
     * @returns {Promise<void>}
     */
    instance.set = async function(type, key, entry, payload) {
        payload = payload || {};

        if ( /^memory$/i.test(type) ) {
            entry.fromMemory = true;
            // content is mandatory for the memory strategy
            entry.content = payload.content;
            mem.set(key, entry);
            return;
        }

        if ( /^fs$/i.test(type) ) {
            // The release namespace comes from the key (buildKey embedded it);
            // bundle/kind/url come from the payload (== the key's, by the
            // delegate's own buildKey call), so the write filename and the
            // read-back filename (fsBodyFor, also key-derived) cannot drift.
            var _pk      = parseFsKey(key);
            var _token   = _pk ? _pk.token : '';
            var p        = fsPaths(payload.path, _token, payload.bundle, payload.kind, payload.url);
            var filename = p.body;
            var dir      = filename.split(/\//g).slice(0, -1).join('/');
            var dirObj   = new _(dir);
            if ( !dirObj.existsSync() ) {
                dirObj.mkdirSync();
            }
            dirObj = null;

            await fs.promises.writeFile(filename, payload.content);

            // filename is mandatory for the fs strategy
            entry.filename = filename;
            // cleanupFn: delete the cached file (+ .meta) from disk on eviction.
            mem.set(key, entry, function() {
                rmFsFiles(entry.filename);
            });

            // .meta sidecar — written AFTER mem.set so meta.createdAt is exactly
            // the in-Map entry.createdAt lib/cache just stamped. Carries what the
            // server read path replays on a restart read-back.
            var meta = {
                createdAt       : entry.createdAt.toISOString(),
                ttl             : entry.ttl,
                sliding         : entry.sliding === true,
                maxAge          : entry.maxAge,
                visibility      : entry.visibility,
                responseHeaders : entry.responseHeaders
            };
            await fs.promises.writeFile(p.meta, JSON.stringify(meta));
            return;
        }

        if ( /^redis$/i.test(type) ) {
            // L1 (synchronous): same shape as `memory` — this replica serves from
            // its own Map on the next request without touching redis.
            entry.fromMemory = true;
            entry.content    = payload.content;
            mem.set(key, entry);

            // L2 (fire-and-forget): the shared store other replicas warm from. The
            // response NEVER waits on redis — L1 already holds the entry, so a
            // slow/down L2 degrades to per-replica caching (a follow-up on another
            // replica renders + writes its own L2, self-correcting). B5's
            // enableOfflineQueue:false makes a disconnected client reject fast;
            // _forget swallows it (fail-open, B4).
            var l2 = _l2();
            if ( l2 ) {
                // Pass the RAW ms (positive) or null — the store floors + rounds
                // (Math.max(1, round) → never PSETEX 0). entry.ttl > 0 gates out
                // negative/zero, so the store only ever sees null or positive.
                // NOTE a null ttl → a NON-EXPIRING L2 key. Unlike the in-process
                // Map (dies with the process) it survives in shared redis, and
                // buildKey's release-token rotation (GINA_CACHE_NAMESPACE /
                // GINA_VERSION) then orphans it permanently — clear() enumerates
                // only L1-known keys, and redis has no clearFsBundle analog. A
                // redis route should always carry a ttl (or invalidateOnEvents).
                var _ttlMs = ( typeof(entry.ttl) != 'undefined' && entry.ttl > 0 )
                    ? entry.ttl * 1000
                    : null;
                // Store ONLY what the serve path needs — never a `filename` (fs-only)
                // nor timing fields (PTTL is authoritative on read-back).
                var _l2Value;
                try {
                    _l2Value = JSON.stringify({
                        content         : payload.content,
                        responseHeaders : entry.responseHeaders,
                        visibility      : entry.visibility
                    });
                } catch (e) {
                    return; // unserializable payload → L1-only (fail-open)
                }
                _forget(l2.set(key, _l2Value, _ttlMs), 'write');
            }
            return;
        }
        // Unknown / undefined type → not cached.
    };

    /**
     * Warm the L1 index from the redis L2 (render-cache Slice 4). Called by the
     * server read path on an L1 miss for a `redis` route: reads the shared body
     * back, populates L1 so the NEXT request on THIS replica hits L1 without
     * touching redis, and returns the (memory-shaped) entry to serve now.
     *
     * Fail-open (B5): any L2 error / miss / unparseable value → `undefined`
     * (render normally). The L1 entry's `ttl` is the AUTHORITATIVE remaining life
     * from redis `PTTL` (`raw.ttlMs`), never re-derived — so L1 cannot outlive L2,
     * and a re-warm after L1 expiry reads the SHORTER remaining PTTL (never an
     * extension). The entry carries NO `filename` (that is fs-only, B3) and no
     * cleanup fn (a memory entry has no disk body).
     *
     * @memberof RenderCache
     * @param {string}   key      - Fully-namespaced cache key (`buildKey`).
     * @param {string[]} [events] - The route's `invalidateOnEvents`, re-registered
     *                              after L1 population. A warmed entry skipped the
     *                              render, so the delegate's `setEvents` never ran
     *                              on THIS replica — without this, an event fired
     *                              here could neither evict it from L1 nor DEL it
     *                              from L2 (the fs-restart sidecar class, solved
     *                              there by `readBack()`'s `meta.events` restore).
     *                              Route config is the source of truth, so the L2
     *                              value never needs to carry events; the server
     *                              read path passes the route's list on every warm.
     * @returns {Promise<object|undefined>} The memory-shaped entry, or `undefined` on miss.
     */
    instance.warm = async function(key, events) {
        var l2 = _l2();
        if ( !l2 ) {
            return undefined;
        }
        var raw;
        try {
            raw = await l2.warmRead(key);
        } catch (e) {
            _warnL2Once('read', e);
            return undefined; // redis down / error → miss (render normally)
        }
        if ( !raw || typeof(raw.value) != 'string' ) {
            return undefined;
        }
        var parsed;
        try {
            parsed = JSON.parse(raw.value);
        } catch (e) {
            // A corrupt value is the same diagnosable family as a WRONGTYPE
            // (something else writing our keyspace) — worth the one process warn.
            _warnL2Once('read (corrupt value)', e);
            return undefined; // corrupt L2 value → miss (self-heals on re-render)
        }
        // F5 — a parseable value with no string `content` (a foreign write to our
        // keyspace, a schema drift, or a degenerate contentless render) must be a MISS,
        // never a blank HTTP 200 — serving an empty body is strictly worse than
        // rendering the real page. Same diagnosable family as a corrupt value.
        if ( typeof(parsed.content) !== 'string' ) {
            _warnL2Once('read (missing content)', new Error('L2 value has no string content'));
            return undefined;
        }
        var entry = {
            fromMemory      : true,
            content         : parsed.content,
            responseHeaders : parsed.responseHeaders,
            visibility      : parsed.visibility
        };
        // Remaining life from PTTL (ms → s). null (no expiry) → non-expiring L1
        // entry, matching a non-ttl memory entry.
        if ( raw.ttlMs && raw.ttlMs > 0 ) {
            entry.ttl = raw.ttlMs / 1000;
        }
        // Populate L1 (installs the timer for `entry.ttl` s = the remaining L2
        // life, so L1 expires with L2). mem.set stamps createdAt/lastAccessedAt.
        mem.set(key, entry);
        // Restore the entry's event-invalidation registrations from route config
        // (see the `events` param — the warmed entry skipped the delegate's
        // setEvents, and an unregistered entry cannot be event-evicted).
        if ( Array.isArray(events) && events.length ) {
            mem.setEvents(key, events);
        }
        return entry;
    };

    /**
     * Lenient presence check: true when the entry is in the memory index OR
     * (fs restart-hardening) a body file exists on disk for `key`. The disk
     * check is inert unless a cache root was configured via `from()`, so the
     * render delegates (which never pass a path) keep Map-only semantics.
     *
     * The disk arm is deliberately lenient (existence, not expiry): the server
     * read path calls `get()` right after, which is authoritative and treats an
     * expired/absent entry as a miss.
     *
     * @memberof RenderCache
     * @param {string} key
     * @returns {boolean}
     */
    instance.has = function(key) {
        if ( mem.has(key) ) {
            return true;
        }
        var body = fsBodyFor(key);
        return ( body ) ? fs.existsSync(body) : false;
    };

    /**
     * Authoritative get: the memory entry when present, else (fs
     * restart-hardening) a disk read-back reconstructing the entry from its
     * body + `.meta` sidecar with the original absolute expiry preserved.
     * Returns `undefined` on miss / expiry. The disk arm is inert unless a
     * cache root was configured via `from()`.
     *
     * @memberof RenderCache
     * @param {string} key
     * @returns {object|string|undefined} The stored entry, or `undefined` on miss / expiry.
     */
    instance.get = function(key) {
        var hit = mem.get(key);
        if ( typeof(hit) != 'undefined' ) {
            return hit;
        }
        return readBack(key);
    };

    /**
     * @memberof RenderCache
     * @param {string} key
     * @returns {boolean} success
     */
    instance.delete = function(key) {
        var removed = mem.delete(key);
        // B1: drop from the redis L2 too (fire-and-forget), or the next warm()
        // re-seeds L1 from the stale body and the delete silently un-does itself.
        var l2 = _l2();
        if ( l2 ) {
            _forget(l2.del(key), 'del');
        }
        return removed;
    };

    /**
     * Register cache-invalidation rules for `key`.
     *
     * The in-heap registration is done SYNCHRONOUSLY (before the first `await`), so a
     * caller that does not await still gets correct in-process behaviour. For an `fs`
     * entry the events are then persisted into the `.meta` sidecar, so a restart's
     * disk read-back can restore them — without this the entry comes back serving from
     * disk with NO registration, and firing the event would silently not evict it.
     *
     * Best-effort on the disk half: a sidecar that cannot be read/written leaves the
     * in-heap registration intact and self-heals on the next miss-render.
     *
     * @memberof RenderCache
     * @param {string}   key
     * @param {string[]} events
     * @param {function} [cb]
     * @returns {Promise<void>}
     *
     * @example
     * await renderCache.set('fs', key, entry, payload);
     * await renderCache.setEvents(key, ['post#saved']);
     */
    instance.setEvents = async function(key, events, cb) {
        mem.setEvents(key, events, cb);

        if ( !Array.isArray(events) || !events.length ) {
            return;
        }
        // `fs` entries carry the body path stamped by set('fs'); memory entries do not.
        var entry = mem.get(key);
        if ( !entry || !entry.filename ) {
            return;
        }
        var metaPath = entry.filename + '.meta';
        try {
            var meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
            meta.events = events.slice();
            await fs.promises.writeFile(metaPath, JSON.stringify(meta));
        } catch (e) {
            // Sidecar unreadable/unwritable: the in-heap registration above still
            // stands for this process; only the restart-survival half is lost.
        }
    };

    /**
     * Fire event-based invalidation for every key registered to `event`
     * (delegates to `lib/cache`).
     *
     * Each evicted entry runs its cleanup fn, so an `fs` body + sidecar is removed
     * from disk too.
     *
     * L2 scope: only the keys THIS replica has registered are DEL'd — a key
     * rendered and registered solely on another replica stays in L2 until its
     * natural expiry (`warm()`'s `events` param re-registers on every serving
     * replica, narrowing this to replicas that never served the key at all).
     *
     * @memberof RenderCache
     * @param {string} event
     * @param {*}      [data]
     * @returns {number} entries evicted
     *
     * @example
     * var evicted = renderCache.from(serverInstance._cached).invalidateByEvent('post#saved');
     */
    instance.invalidateByEvent = function(event, data) {
        // B1: snapshot the L2 keyset BEFORE eviction — invalidateByEvent returns a
        // count and clears the registrations, so the keys must be read first (both
        // calls are sync → no race). keysForEvent lists EVERY registered key,
        // including ones already gone from L1 that may still be live in L2.
        var l2   = _l2();
        var keys = l2 ? mem.keysForEvent(event) : null;
        var removed = mem.invalidateByEvent(event, data);
        if ( l2 && keys && keys.length ) {
            for (var i = 0; i < keys.length; i++) {
                _forget(l2.del(keys[i]), 'del');
            }
        }
        return removed;
    };

    /**
     * Flush the output/render cache — the `static:` (HTML) and `data:` (JSON)
     * namespaces only. Never touches `swig:` (compiled templates) or
     * `http2session:` entries, which have their own lifecycle. Optionally scoped
     * to a single `bundle` (matches the key's bundle segment across ALL release
     * tokens present in the Map).
     *
     * Each matched key is routed through the underlying `delete`, so its expiry
     * timer is cleared AND its cleanup fn runs — for an `fs` entry that removes
     * the CURRENT-namespace body + `.meta` from disk. Old-namespace fs orphans (a
     * prior release token's dir) are NOT touched here — an in-process flush
     * leaves them (already token-invalidated on read-back, so never served);
     * `clearFsBundle()` reclaims them from the offline CLI path.
     *
     * Synchronous: pair a `from(store)` + `clear()` in one tick so the shared Map
     * cannot be re-pointed between them.
     *
     * @memberof RenderCache
     * @param {string} [bundle] - Restrict the flush to this bundle's output entries.
     * @returns {number} The number of entries removed.
     */
    instance.clear = function(bundle) {
        var removed = 0;
        var keys    = mem.keys();
        var evicted = [];
        for (var i = 0; i < keys.length; i++) {
            var p = parseFsKey(keys[i]);
            // parseFsKey is null for any non-output namespace (swig: /
            // http2session: / anything else) — those are never flushed here.
            if ( !p ) {
                continue;
            }
            if ( bundle && p.bundle !== bundle ) {
                continue;
            }
            // Collect for the L2 DEL regardless of the L1 delete outcome — an
            // entry already gone from L1 (a TTL beat us) may still be live in L2.
            evicted.push(keys[i]);
            try {
                if ( mem.delete(keys[i]) ) {
                    removed++;
                }
            } catch (e) {
                // Mirror lib/cache clear()'s per-entry isolation: a throwing
                // cleanup fn must not abort the sweep.
            }
        }
        // B1: drop the same keys from the redis L2 (fire-and-forget). NOTE this
        // covers only the L1-KNOWN keys — an L2 entry never warmed on THIS replica
        // is not enumerable here (the comprehensive cross-replica flush is pub/sub,
        // a later slice); each replica's own L1 self-heals at its TTL meanwhile.
        var l2 = _l2();
        if ( l2 && evicted.length ) {
            for (var j = 0; j < evicted.length; j++) {
                _forget(l2.del(evicted[j]), 'del');
            }
        }
        return removed;
    };

    /**
     * Reclaim a bundle's `fs`-strategy render output from disk — the OFFLINE
     * counterpart to `clear()`. Where `clear()` removes the CURRENT-namespace
     * files via the in-Map entries' cleanup fns, this removes ALL of a bundle's
     * render-output dirs directly, including orphaned prior-release token dirs
     * that survive a namespace change (`buildKey`'s token is an fs path segment,
     * so a redeploy lands new files in a fresh dir and abandons the old one).
     *
     * Under `<root>/<bundle>/` the render output lives in the `html`/`data`
     * subtrees — either directly (the flat, empty-token layout) or nested one
     * level under a release token (`<token>/html`, `<token>/data`). The two
     * SIBLING dirs `config` (the boot-time routing-asset cache) and `swig` (the
     * compiled-layout cache) are NOT render output and are preserved.
     *
     * Consequently `config` and `swig` are RESERVED names: a release namespace
     * (`GINA_CACHE_NAMESPACE`) must not be either, or its token dir would be
     * mistaken for the infra cache and skipped.
     *
     * Best-effort: a missing bundle dir (nothing cached yet) or an un-removable
     * child is not an error.
     *
     * @memberof RenderCache
     * @param {string}  root              - Cache root (`server.cache.path` / the top-level `cachePath`).
     * @param {string}  bundle            - Bundle name.
     * @param {object}  [options]
     * @param {boolean} [options.dryRun]  - Report what WOULD be removed without removing it
     *                                      (so a `--dry-run` preview and a real run resolve
     *                                      the same set from the same code — the CLI never
     *                                      re-implements the layout).
     * @returns {string[]} Absolute paths of the dirs removed (or, on a dry run, that would be).
     */
    instance.clearFsBundle = function(root, bundle, options) {
        options = options || {};
        var dryRun  = ( options.dryRun === true );
        var removed = [];
        if ( !root || !bundle ) {
            return removed;
        }
        var bundleDir = root + '/' + bundle;
        // Siblings of the render-output dirs that are NOT render output.
        var preserve  = { config: true, swig: true };
        var children;
        try {
            children = fs.readdirSync(bundleDir, { withFileTypes: true });
        } catch (e) {
            // No cache dir for this bundle → nothing to reclaim.
            return removed;
        }
        for (var i = 0; i < children.length; i++) {
            var name = children[i].name;
            if ( preserve[name] || !children[i].isDirectory() ) {
                continue;
            }
            var target = bundleDir + '/' + name;
            if ( dryRun ) {
                removed.push(target);
                continue;
            }
            try {
                fs.rmSync(target, { recursive: true, force: true });
                removed.push(target);
            } catch (e) { /* best-effort */ }
        }
        return removed;
    };

    /**
     * Snapshot of the current cache state (delegates to `lib/cache`).
     *
     * @memberof RenderCache
     * @returns {object}
     */
    instance.stats = function() {
        return mem.stats();
    };

    return instance;
}

/**
 * Boot-time validation of a bundle's RESOLVED render/output-cache configuration
 * (#RC4 redis). Pure + never-throwing — feed the merged `server.cache` (after the
 * config.js settings→server fold) + the bundle's routing map; returns the findings and
 * whether any route resolves to redis (so the caller knows to build the L2 store). The
 * ttl/sliding/type resolution mirrors the render delegates' `writeCache()` exactly
 * (route value wins; else the bundle-wide `server.cache` default), so what validates
 * here is what actually caches at runtime.
 *
 * FATAL (the caller aborts boot — the #B57 fail-fast convention):
 *   - a redis route with an effective `sliding:true` — redis TTL is per-key absolute, so
 *     sliding + redis is semantically undefined (B3);
 *   - a redis route with no effective ttl AND no `invalidateOnEvents` (F2) — a
 *     non-expiring L2 key that a release-namespace rotation orphans permanently
 *     (`clear()` enumerates only L1-known keys; redis has no fs-orphan reclaim analog);
 *   - any redis route but no `server.cache.store` naming a connectors.json entry (the
 *     L2 store cannot be built).
 * WARN (loud, non-fatal — the surface simply is not cached / is at-risk):
 *   - an unknown `cache.type` (bundle-wide or per-route) — the fold made the config
 *     non-silent; this names the typo (#B114);
 *   - a redis route with no effective ttl but WITH `invalidateOnEvents` — the legit
 *     invalidate-only pattern, still orphaned on a namespace rotation;
 *   - an invalid `server.cache.name` (#B238) — ignored, the Cache-Status identifier
 *     stays `gina-cache` (see {@link RenderCache.resolveCacheName});
 *   - `context.hidePoweredBy` + `context.cacheEnabled` with no validly-set name
 *     (#B238) — the operator declared hide-the-stack intent but every cache-enabled
 *     GET still names the framework in Cache-Status. Warn-not-flip is deliberate:
 *     the identifier is a documented-stable wire value (0.5.18 promised
 *     `gina-cache; hit` grep-stability), so it never changes without an explicit
 *     operator choice — the warn hands them both one-line exits.
 *
 * @memberof RenderCache
 * @static
 * @param {object}  serverCache - Merged `server.cache` (type/store/ttl/sliding/maxAge/name/…).
 * @param {object}  routing     - The bundle routing map (`{ ruleName: { cache, bundle, … } }`).
 * @param {string}  [bundle]    - When set, per-route checks skip routes of another bundle.
 * @param {object}  [context]   - Caller-supplied boot context for the #B238 disclosure
 *                                warn: `{ hidePoweredBy: boolean, cacheEnabled: boolean }`
 *                                (both must be `true` for it to fire). Omitting the
 *                                argument disables only that warn — every other check
 *                                is unchanged (back-compat with pre-#B238 callers).
 * @returns {{ fatal: (string|null), warnings: string[], redisConfigured: boolean }}
 *
 * @example
 * var v = RenderCache.validateConfig(serverCache, gna.getConfig('routing'), bundle,
 *     { hidePoweredBy: hpb, cacheEnabled: enabled });
 * v.warnings.forEach(function (w) { console.warn('[render-cache] ' + w); });
 * if (v.fatal) { console.emerg('[render-cache] ' + v.fatal); process.exit(1); }
 * if (v.redisConfigured) { process.gina._renderCacheStore = lib.RenderCacheStore(serverCache.store); }
 */
RenderCache.validateConfig = function(serverCache, routing, bundle, context) {
    var out = { fatal: null, warnings: [], redisConfigured: false };
    serverCache = serverCache || {};
    routing     = routing || {};

    var bundleType = (typeof(serverCache.type) === 'string') ? serverCache.type : '';
    if ( bundleType.length > 0 && !_RC_STRATEGIES.test(bundleType) ) {
        out.warnings.push('unknown server.cache.type `' + bundleType + '` (expected memory|fs|redis) — this bundle-wide default is ignored; routes inheriting it are NOT cached');
    }

    // #B238 — `server.cache.name` (the Cache-Status identifier) sanity + disclosure.
    var _declaredName = serverCache.name;
    var _nameIsSet    = ( typeof(_declaredName) === 'string' && _RC_NAME_RE.test(_declaredName) );
    if ( typeof(_declaredName) !== 'undefined' && !_nameIsSet ) {
        out.warnings.push('invalid server.cache.name `' + String(_declaredName) + '` — must be a letter followed by up to 63 of [A-Za-z0-9._-] (a conservative RFC 8941 token subset); ignored, the Cache-Status identifier stays `gina-cache`');
    }
    // Gated on the caller context: cacheEnabled (a disabled cache emits no
    // Cache-Status — no disclosure, no noise) and hidePoweredBy (no declared
    // intent, no nag). An explicit `"name": "gina-cache"` counts as validly
    // set — the documented silence path for keeping the default wire.
    if ( context && context.hidePoweredBy === true && context.cacheEnabled === true && !_nameIsSet ) {
        out.warnings.push('server.hidePoweredBy is set but the Cache-Status identifier still names the framework (`gina-cache`) — set server.cache.name (any token, e.g. "cache") to close the disclosure, or explicitly "gina-cache" to keep the current wire and silence this warning');
    }

    for (var name in routing) {
        var route = routing[name];
        if ( !route || typeof(route) !== 'object' ) { continue; } // skip $schema / annotations
        if ( bundle && typeof(route.bundle) === 'string' && route.bundle !== bundle ) { continue; }
        var rc = route.cache;
        if ( !rc ) { continue; } // route does not opt into caching
        var rcObj   = (typeof(rc) === 'string') ? { type: rc } : rc;
        // Effective strategy (F2 — writeCache parity): the route's `type` wins when SET
        // AT ALL (`typeof !== 'undefined'`, mirroring writeCache's inherit gate — a
        // blank/garbage route type is KEPT, not inherited-over, and falls through the
        // guard below as not-cached); only an OMITTED route type inherits the
        // bundle-wide default. (Was `length>0`, which made a route `type:""` falsely
        // inherit a bundle `redis` → `redisConfigured` → a FALSE boot-abort for a route
        // that writeCache never actually caches.)
        var effType = (typeof(rcObj.type) !== 'undefined') ? rcObj.type : bundleType;
        if ( typeof(effType) !== 'string' || effType.length === 0 ) { continue; } // no strategy → not cached (legit)
        if ( !_RC_STRATEGIES.test(effType) ) {
            out.warnings.push('route `' + name + '`: unknown cache.type `' + effType + '` (expected memory|fs|redis) — not cached');
            continue;
        }
        if ( !/^redis$/i.test(effType) ) { continue; } // memory / fs — not this validator's concern

        // --- a redis route ---
        out.redisConfigured = true;
        // ttl / sliding resolution mirrors writeCache: a route value (even 0/false) wins;
        // only an ABSENT route value inherits the bundle-wide default.
        var effSliding = (typeof(rcObj.sliding) !== 'undefined') ? rcObj.sliding : serverCache.sliding;
        var rawTtl     = (typeof(rcObj.ttl) !== 'undefined') ? rcObj.ttl : serverCache.ttl;
        var hasTtl     = (typeof(rawTtl) === 'number' && rawTtl > 0);
        var events     = Array.isArray(rcObj.invalidateOnEvents) ? rcObj.invalidateOnEvents : [];

        if ( effSliding === true ) {
            out.fatal = 'route `' + name + '`: `sliding:true` + redis is unsupported (redis TTL is per-key absolute) — drop sliding, or use the memory/fs strategy';
            return out;
        }
        if ( !hasTtl ) {
            if ( events.length === 0 ) {
                out.fatal = 'route `' + name + '`: a redis route needs a ttl (or invalidateOnEvents) — a non-expiring L2 key is orphaned permanently on a release-namespace rotation';
                return out;
            }
            out.warnings.push('route `' + name + '`: redis route has no ttl (invalidate-only) — its L2 key is still orphaned on a release-namespace rotation (GINA_CACHE_NAMESPACE / GINA_VERSION); prefer adding a ttl');
        }
    }

    if ( out.redisConfigured && !(typeof(serverCache.store) === 'string' && serverCache.store.length > 0) ) {
        out.fatal = 'a route resolves to the redis cache strategy but `server.cache.store` (a connectors.json entry name) is not set';
        return out;
    }

    return out;
};

/**
 * #B238 — resolve the Cache-Status response-header identifier for a bundle (pure, static).
 *
 * RFC 9211 §2 leaves the cache identifier to the deployment (a free-form
 * structured-field Token). gina's default is `gina-cache`; an operator picks
 * their own via `server.cache.name` (the settings.json `cache` block — rides
 * the same #B114 fold as `type`/`store`, so an env.json `server.cache.name`
 * wins over it like every sibling key). An invalid value is IGNORED here
 * (default returned) and named loudly by {@link RenderCache.validateConfig}
 * at boot — never sanitized into a name the operator did not write.
 *
 * Accepted grammar is a deliberate STRICT SUBSET of the RFC 8941 Token
 * (a letter, then up to 63 of `[A-Za-z0-9._-]`) — every accepted value is a
 * valid sf-token, and the charset matches the release-namespace sanitizer
 * (`resolveReleaseToken`), keeping the two token surfaces aligned.
 *
 * Resolved ONCE at boot (server.js stamps `instance._cacheName` beside the
 * sibling cache scalars) and read by all three Cache-Status mint sites —
 * both engines, hit and miss — so the identifier can never disagree across
 * engines or outcomes.
 *
 * @memberof RenderCache
 * @static
 * @param {object} [serverCache] - Merged `server.cache` (the #B114 post-fold block).
 * @returns {string} The identifier to mint (`serverCache.name` when valid, else `'gina-cache'`).
 *
 * @example
 * RenderCache.resolveCacheName({ name: 'cache' });      // 'cache'
 * RenderCache.resolveCacheName({ name: 'bad name!' });  // 'gina-cache' (validateConfig warns at boot)
 * RenderCache.resolveCacheName({});                     // 'gina-cache'
 * RenderCache.resolveCacheName(null);                   // 'gina-cache'
 */
RenderCache.resolveCacheName = function(serverCache) {
    var name = ( serverCache ) ? serverCache.name : null;
    return ( typeof(name) === 'string' && _RC_NAME_RE.test(name) ) ? name : 'gina-cache';
};

/**
 * #B130 — CSP-nonce re-stamp for served cache hits (pure, static).
 *
 * A render/output-cache hit replays the STORED response headers and the STORED
 * body — both minted by the request that WROTE the entry. When the stored
 * Content-Security-Policy header carries `'nonce-…'` sources, replaying the
 * pair verbatim reuses one nonce for every client of that URL until the entry
 * expires (and, pre-#B130, could even replay a header/body PAIR minted by two
 * different requests). The serve sites (server.js `serveRenderCacheHit` + the
 * isaac pre-routing read — keep both in sync) call this to mint a FRESH nonce
 * per response and rewrite the header copy; the body is rewritten with
 * {@link RenderCache.swapNonces}. The Csp middleware never runs on a hit (the
 * hit short-circuits dispatch), so this is the only mint on that path.
 *
 * Inputs are never mutated — the cache entry keeps its original values.
 *
 * @function renonceCspHeaders
 * @memberof RenderCache
 * @static
 *
 * @param {object|null} responseHeaders - The stored headers snapshot (`res.getHeaders()` shape, lowercase keys)
 *
 * @returns {object|null} `null` when no CSP header carries a nonce (serve the stored pair verbatim);
 *   else `{ headers, oldNonces, nonce }` — a fresh headers object with every
 *   `'nonce-…'` value replaced, the distinct old nonce values found, and the new nonce
 *
 * @example
 * var rn = RenderCache.renonceCspHeaders(hit.responseHeaders);
 * if (rn) {
 *     body = RenderCache.swapNonces(hit.content, rn.oldNonces, rn.nonce);
 *     // replay rn.headers instead of hit.responseHeaders
 * }
 */
RenderCache.renonceCspHeaders = function (responseHeaders) {
    if ( !responseHeaders || typeof(responseHeaders) !== 'object' ) {
        return null;
    }
    var cspKeys = [], oldNonces = [], h = null, i = 0;
    for (h in responseHeaders) {
        if (
            /^content-security-policy(-report-only)?$/i.test(h)
            && typeof(responseHeaders[h]) === 'string'
        ) {
            cspKeys.push(h);
            var found = responseHeaders[h].match(/'nonce-[^']+'/g) || [];
            for (i = 0; i < found.length; i++) {
                // `'nonce-` prefix (7 chars) + trailing `'`
                var val = found[i].substring(7, found[i].length - 1);
                if (val && oldNonces.indexOf(val) === -1) {
                    oldNonces.push(val);
                }
            }
        }
    }
    if (oldNonces.length === 0) {
        return null;
    }
    // 16 bytes = 128 bits — parity with the Csp plugin's NONCE_BYTES (the W3C
    // CSP3 nonce-entropy floor). base64 like the middleware mint.
    var nonce   = crypto.randomBytes(16).toString('base64');
    var headers = {};
    for (h in responseHeaders) {
        headers[h] = responseHeaders[h];
    }
    for (i = 0; i < cspKeys.length; i++) {
        headers[ cspKeys[i] ] = RenderCache.swapNonces(headers[ cspKeys[i] ], oldNonces, nonce);
    }
    return { headers: headers, oldNonces: oldNonces, nonce: nonce };
};

/**
 * #B130 — replace every occurrence of each old nonce value with the fresh one.
 * Exact-string swap (split/join — nonce values are base64 and may carry `+/=`,
 * so no regex). Covers the framework bootstrap `nonce="…"` attribute AND any
 * app-template `{{ page.cspNonce }}` occurrence baked into the stored body.
 * Null-safe: a non-string `content` (or empty swap set) is returned unchanged.
 *
 * @function swapNonces
 * @memberof RenderCache
 * @static
 *
 * @param {string} content - The stored response body
 * @param {array} oldNonces - Distinct old nonce values (from {@link RenderCache.renonceCspHeaders})
 * @param {string} nonce - The fresh nonce
 *
 * @returns {string} The body with old nonce values swapped for the fresh one
 *
 * @example
 * RenderCache.swapNonces('<script nonce="abc+/=">', ['abc+/='], 'Zm9v');
 * // -> '<script nonce="Zm9v">'
 */
RenderCache.swapNonces = function (content, oldNonces, nonce) {
    if (
        typeof(content) !== 'string'
        || !Array.isArray(oldNonces)
        || oldNonces.length === 0
        || typeof(nonce) !== 'string'
        || !nonce
    ) {
        return content;
    }
    for (var i = 0; i < oldNonces.length; i++) {
        if (oldNonces[i] === nonce) {
            continue;
        }
        content = content.split(oldNonces[i]).join(nonce);
    }
    return content;
};

module.exports = RenderCache;
