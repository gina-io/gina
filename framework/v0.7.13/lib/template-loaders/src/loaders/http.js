/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/template-loaders/http
 * @description Built-in HTTP(S)-fetch template loader for the async loader
 * extension point (`settings.template.<engine>.loader.type === "http"`).
 * Resolves each template identifier to an absolute URL under a configured
 * `origin` + `basePath`, fetches the source over node `https`/`http` (no SDK),
 * and caches it via `lib/cache` keyed by the resolved URL — a Tier-1 source
 * cache with an absolute TTL plus opt-in ETag revalidation. Unblocks
 * deployments where templates ship separately from app code (S3 / R2 / GCS /
 * CDN / a CMS endpoint).
 *
 * Loader contract: `resolve(to, from) -> absolute URL`, `load(id, cb)` (arity 2
 * so swig's `getTemplate()` picks the callback load path), `async: true`. The
 * gina CVE-2023-25345 segment-guard (applied by the wrapper in `main.js`)
 * already rejected `..` / absolute identifiers BEFORE `resolve()` runs;
 * `resolve()` adds the origin/basePath CONTAINMENT check — a second,
 * independent boundary that also catches absolute-URL, protocol-relative and
 * host-swap escapes the segment guard cannot see.
 *
 * Identifiers resolve ROOT-relative under `basePath` (a flat namespace: an
 * `{% include "partials/x.html" %}` resolves to `<origin><basePath>/partials/x.html`,
 * not relative to the including template's directory). Parent-relative `../`
 * includes are rejected upstream by the segment guard.
 *
 * @package gina.framework
 */

var http  = require('http');
var https = require('https');

/**
 * Default source-cache TTL in seconds (absolute, from fetch). 60s bounds
 * staleness even with no revalidation while collapsing per-render fetches to
 * ~once/template/minute under load. Immutable-CDN operators raise it (e.g.
 * `ttl: 86400`); live-CMS operators turn on `revalidate` instead.
 *
 * @constant
 * @inner
 * @type {number}
 */
var DEFAULT_TTL_S = 60;

/**
 * Per-fetch socket timeout (ms). A hung origin must not hang the render.
 *
 * @constant
 * @inner
 * @type {number}
 */
var FETCH_TIMEOUT_MS = 10000;

/**
 * Build an HTTP(S)-fetch loader from its flat config. Validates shape only — it
 * never reaches the backend, so a flaky/unreachable origin at boot is a
 * render-time concern, not a bundle-startup failure (the no-network-probe rule).
 *
 * @param {object}  cfg                    - Loader config (`settings.template.<engine>.loader`)
 * @param {string}  cfg.origin             - `scheme://host[:port]` of the template origin (no path). http or https.
 * @param {string}  [cfg.basePath=""]      - Path prefix under origin every identifier resolves against.
 * @param {number}  [cfg.ttl=60]           - Source-cache TTL in seconds (absolute from fetch). `0` = cache until evicted.
 * @param {boolean} [cfg.revalidate=false] - When true, a cache hit issues a conditional GET (`If-None-Match`).
 * @param {object}  [ctx]                  - Build context (`{ bundle }`) threaded from `initSwigEngine` for cache-key namespacing.
 * @returns {{async: boolean, resolve: function, load: function}} Loader object
 * @throws {Error} When `origin` is missing or not an http(s) URL
 *
 * @example
 * var http = require('lib/template-loaders/http');
 * var loader = http({ type: 'http', origin: 'https://cdn.example.com', basePath: '/templates' }, { bundle: 'site' });
 * loader.load(loader.resolve('pages/home.html'), function (err, source) { ... });
 */
module.exports = function httpLoader(cfg, ctx) {
    if (!cfg || typeof cfg.origin !== 'string' || cfg.origin === '') {
        throw new Error('[template-loader:http] "origin" (scheme://host[:port]) is required');
    }

    var parsedOrigin;
    try {
        parsedOrigin = new URL(cfg.origin);
    } catch (e) {
        throw new Error('[template-loader:http] "origin" must be a valid URL: ' + cfg.origin);
    }
    if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') {
        throw new Error('[template-loader:http] "origin" must use http or https: ' + cfg.origin);
    }

    // Normalise basePath: leading slash, no trailing slash, "" when absent.
    var basePath = (typeof cfg.basePath === 'string') ? cfg.basePath.trim() : '';
    if (basePath.length > 0) {
        if (basePath.charAt(0) !== '/') { basePath = '/' + basePath; }
        basePath = basePath.replace(/\/+$/, '');
    }

    var originConst    = parsedOrigin.origin;            // e.g. https://cdn.example.com
    var containPrefix  = originConst + basePath + '/';   // every resolved URL must start with this (note trailing /)
    var transport      = (parsedOrigin.protocol === 'http:') ? http : https;
    var ttlSeconds     = (typeof cfg.ttl === 'number' && cfg.ttl >= 0) ? cfg.ttl : DEFAULT_TTL_S;
    var revalidate     = (cfg.revalidate === true);
    var bundle         = (ctx && typeof ctx.bundle === 'string' && ctx.bundle) ? ctx.bundle : 'default';

    /**
     * Resolve a template identifier to an absolute URL under origin+basePath and
     * containment-check it. The CVE segment-guard (main.js wrapper) already ran
     * on `to`. Resolution is root-relative against `containPrefix` (`from` is not
     * used for path construction — the namespace is flat under basePath); the
     * containment check rejects anything escaping the configured origin/basePath.
     *
     * @inner
     * @param {string}  to     - Template identifier (page, or an extends/include target)
     * @param {string} [from]  - Resolving template's id (unused — flat-namespace resolution)
     * @returns {string} Absolute URL string (also the cache key suffix + load() arg)
     * @throws {Error} When the resolved URL escapes the configured origin/basePath
     */
    function resolve(to, from) {
        var url;
        try {
            url = new URL(to, containPrefix);
        } catch (e) {
            throw new Error('[template-loader:http] cannot resolve template identifier: ' + to);
        }
        if (url.origin !== originConst || url.href.indexOf(containPrefix) !== 0) {
            throw new Error('[template-loader:http] resolved URL escapes configured origin/basePath: ' + url.href);
        }
        return url.href;
    }

    /**
     * Fetch `url` over the configured transport. Single-settle (error / timeout /
     * end race exactly once). A 304 returns no body. Optional `If-None-Match`
     * makes it a conditional GET.
     *
     * @inner
     * @param {string}   url   - Absolute URL to fetch
     * @param {?string}  etag  - When set, sent as `If-None-Match` (conditional GET)
     * @param {function} cb    - `(err, statusCode, body, responseEtag)`
     * @returns {void}
     */
    function fetchUrl(url, etag, cb) {
        var settled = false;
        function settle(err, status, body, respEtag) {
            if (settled) { return; }
            settled = true;
            cb(err, status, body, respEtag);
        }

        var opts = {};
        if (etag) { opts.headers = { 'If-None-Match': etag }; }

        var req = transport.get(url, opts, function (res) {
            var respEtag = (res.headers && res.headers.etag) ? res.headers.etag : null;
            if (res.statusCode === 304) {
                res.resume(); // drain so the socket frees
                return settle(null, 304, null, etag);
            }
            var chunks = [];
            res.on('data', function (chunk) { chunks.push(chunk); });
            res.on('end', function () {
                settle(null, res.statusCode, Buffer.concat(chunks).toString('utf8'), respEtag);
            });
            res.on('error', function (streamErr) { settle(streamErr); });
        });
        req.on('error', function (reqErr) { settle(reqErr); });
        req.setTimeout(FETCH_TIMEOUT_MS, function () {
            req.destroy(new Error('[template-loader:http] timeout (' + FETCH_TIMEOUT_MS + 'ms) fetching ' + url));
        });
    }

    /**
     * The shared gina cache, resolved LAZILY at load time. It is NOT available
     * at loader-build time — `initSwigEngine` builds the loader before the
     * server's shared Map is created in `start()`, so a build-time capture would
     * grab nothing. The request pipeline points `process.gina._cache` at the
     * server Map before any render-driven `load()`. Returns null when absent
     * (e.g. a unit test with no server) so caching is skipped, not crashed.
     *
     * @inner
     * @returns {?object} A `lib.Cache` instance, or null
     */
    function getCache() {
        return (typeof process.gina === 'object' && process.gina && process.gina._cache) ? process.gina._cache : null;
    }

    /**
     * Cache key for a resolved URL: `tpl:src:<bundle>:<URL>` (mirrors the
     * `static:<bundle>:<url>` convention of the static-HTML response cache, with
     * a distinct `tpl:src:` prefix so the two never collide).
     *
     * @inner
     * @param {string} url - Resolved absolute URL
     * @returns {string} Cache key
     */
    function cacheKey(url) {
        return 'tpl:src:' + bundle + ':' + url;
    }

    return {
        // Dispatch flag — routes the bundle to the async swig delegate and tells
        // swig's renderFile to take the async getTemplate path.
        async: true,

        resolve: resolve,

        // Arity 2 (id, cb) so swig.getTemplate() uses the callback load path. A
        // network fetch is callback-only — there is no synchronous return path.
        load: function (id, cb) {
            var cache = getCache();
            var key   = cacheKey(id);
            var hit   = (cache && typeof cache.get === 'function') ? cache.get(key) : undefined;

            if (hit && typeof hit.source === 'string') {
                if (!revalidate || !hit.etag) {
                    // Fresh hit, no revalidation to do → serve cached source.
                    return void cb(null, hit.source);
                }
                // Revalidate via a conditional GET.
                return void fetchUrl(id, hit.etag, function (err, status, body, respEtag) {
                    if (err) {
                        // Flaky origin during revalidation — serve stale rather
                        // than 500 a page that is only slightly out of date.
                        return void cb(null, hit.source);
                    }
                    if (status === 304) {
                        // Unchanged — refresh the TTL, serve cached source.
                        if (cache) { cache.set(key, makeEntry(hit.source, hit.etag)); }
                        return void cb(null, hit.source);
                    }
                    if (status === 200) {
                        if (cache) { cache.set(key, makeEntry(body, respEtag)); }
                        return void cb(null, body);
                    }
                    return void cb(new Error('[template-loader:http] ' + status + ' revalidating ' + id));
                });
            }

            // Miss (or expired, or no cache) → unconditional GET.
            return void fetchUrl(id, null, function (err, status, body, respEtag) {
                if (err) { return void cb(err); }
                if (status === 200) {
                    if (cache) { cache.set(key, makeEntry(body, respEtag)); }
                    return void cb(null, body);
                }
                return void cb(new Error('[template-loader:http] ' + status + ' fetching ' + id));
            });
        }
    };

    /**
     * Build a cache-entry value. `ttl` (seconds) drives `lib/cache` expiry;
     * `fromMemory` classifies it under "memory" in `/_gina/cache/stats`.
     *
     * @inner
     * @param {string}  source - Template source
     * @param {?string} etag   - Origin ETag (for revalidation), or null
     * @returns {object} Cache value
     */
    function makeEntry(source, etag) {
        return {
            source:     source,
            etag:       etag || null,
            fetchedAt:  Date.now(),
            ttl:        ttlSeconds,
            fromMemory: true
        };
    }
};
