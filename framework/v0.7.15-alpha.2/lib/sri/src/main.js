/**
 * Gina — Subresource Integrity (SRI) attribute computation (#OW3, OWASP A08).
 *
 * Computes `integrity="sha384-<base64>" crossorigin="anonymous"` attribute
 * strings for same-origin `<script>` and `<link rel="stylesheet">` tags whose
 * files resolve on disk, so a tampered or truncated asset is refused by the
 * browser instead of executed. Opt-in per bundle via `templates.json >
 * "_common" > "sriEnabled": true` — the controller's resource builder calls
 * this module for every declared asset when that flag is set.
 *
 * DESIGN INVARIANTS — each is deliberate, none is incidental:
 *
 * - FAIL-OPEN, always. Any condition that prevents an honest hash — external
 *   URL, unresolvable path, unreadable file, missing configuration — yields
 *   an EMPTY attribute string, never a guessed or partial hash. An asset
 *   without `integrity` loads exactly as before; an asset with a wrong
 *   `integrity` is hard-blocked by the browser. Emitting nothing is the safe
 *   degradation by construction.
 * - STAT-VALIDATED CACHE. Hashes are cached per absolute file path, keyed by
 *   `mtimeMs` + `size`, and re-validated with one `fs.statSync` per lookup.
 *   A rebuilt or re-baked asset therefore gets a fresh hash on the next
 *   render with no process restart — the emission side can never serve a
 *   stale hash for the bytes on disk. (Pages already stored by the
 *   render/output cache keep the hash they were rendered with; flushing that
 *   cache after an asset rebuild remains the operator's step.)
 * - sha384, HARDCODED. 48-byte digests base64-encode to exactly 64 characters
 *   with ZERO `=` padding — a measured safety property: the server-side asset
 *   catalog extracts URLs with an unanchored `(src|href|srcset)=` scan, and a
 *   padding-free alphabet makes a false `src="` match inside a hash value
 *   structurally impossible. A configurable algorithm (e.g. sha512, whose
 *   base64 IS padded) would reopen that hazard, so no knob ships.
 *
 * #P48 — the same digest also yields the VERSION TOKEN gina appends to every
 * asset URL it emits (`?v=<first 10 hex of the sha384>`, `getVersionedUrl`),
 * so a consumer can cache those URLs for a year. Tokens resolve URLs the way
 * the static server does (directory mappings included, `resolveServedFile`),
 * which SRI deliberately does not: a token that names a different file than
 * the one served only costs that asset its long-lived caching (the static
 * server answers `no-cache` to a token it cannot match), while a wrong
 * integrity value blocks the asset.
 *
 * The cache is module-scope state and this module is registered with a PLAIN
 * `require` in the lib registry — it must not be hot-swapped per request in
 * dev mode (the securityHeadersEmitter / authn precedent for security-bearing
 * leaves), and the cache is only ever a recomputation saver, so staleness
 * across reload boundaries cannot occur by construction.
 *
 * @module sri
 */
'use strict';

var fs      = require('fs');
var crypto  = require('crypto');

/**
 * Digest algorithm. Fixed on purpose — see the module header for the
 * padding-free safety property that pins it to sha384.
 *
 * @constant
 * @type {string}
 * @private
 */
var ALGORITHM = 'sha384';

/**
 * Stat-validated digest cache, shared by the SRI integrity value and the #P48
 * version token (one read and one digest per file version).
 * Key: absolute file path. Value: {@link SriDigestEntry}.
 * Bounded in practice by the number of distinct assets declared across the
 * bundle's `templates.json` collections plus the files the static server
 * answers a versioned request for (typically a few dozen), so no eviction is
 * needed.
 *
 * @type {object}
 * @private
 */
var _cache = {};

/**
 * Length of the #P48 version token: the first characters of the file's sha384
 * HEX digest. Ten hex characters = 40 bits, far past any collision risk
 * between two versions of one asset, and short enough to keep URLs readable.
 *
 * @constant
 * @type {number}
 * @private
 */
var VERSION_LENGTH = 10;

/**
 * Largest file, in bytes, that gets a #P48 version token (8 MiB). The static
 * server computes the token of the file it serves whenever a request carries
 * `?v=`, synchronously and without authentication — about 0.9 ms per MiB
 * (measured) — so the cost any request can trigger stays bounded. A larger file
 * keeps its plain URL (fail-open) and is served as today. SRI integrity values
 * are not capped: they are computed only for the assets a page declares.
 *
 * @constant
 * @type {number}
 * @private
 */
var VERSION_MAX_BYTES = 8 * 1024 * 1024;

/**
 * @typedef {object} SriDigestEntry
 * @property {number} mtimeMs - The file's mtime when it was digested.
 * @property {number} size - The file's size when it was digested.
 * @property {string} integrity - `sha384-<base64>`.
 * @property {string} version - The first {@link VERSION_LENGTH} hex characters
 *                              of the same digest (#P48).
 * @private
 */

/**
 * Digests a file once per version: stats it, returns the cached entry when its
 * `mtimeMs` and `size` did not move, otherwise reads it, computes one sha384
 * digest and derives BOTH the integrity value and the version token from it.
 *
 * @inner
 * @private
 * @param {string} filePath - Absolute path of the file.
 * @param {number} [maxBytes] - When given, a larger file yields `null` before
 *                              any read or cache lookup (the version cap).
 * @returns {SriDigestEntry|null} `null` when the path is not a readable
 *                                regular file, or is over `maxBytes` (fail-open).
 */
var digestFile = function(filePath, maxBytes) {
    var stats = null;
    try {
        stats = fs.statSync(filePath);
    } catch (statErr) {
        return null;
    }
    if ( !stats.isFile() ) {
        return null;
    }
    // Before the cache lookup too: an entry SRI cached for a large file must
    // not hand out a version token.
    if ( typeof(maxBytes) == 'number' && stats.size > maxBytes ) {
        return null;
    }

    var cached = _cache[filePath];
    if (
        cached
        && cached.mtimeMs === stats.mtimeMs
        && cached.size === stats.size
    ) {
        return cached;
    }

    var content = null;
    try {
        content = fs.readFileSync(filePath);
    } catch (readErr) {
        return null;
    }

    var digest = crypto.createHash(ALGORITHM).update(content).digest();
    var entry = {
        mtimeMs   : stats.mtimeMs,
        size      : stats.size,
        integrity : ALGORITHM + '-' + digest.toString('base64'),
        version   : digest.toString('hex').substring(0, VERSION_LENGTH)
    };
    _cache[filePath] = entry;

    return entry;
};

/**
 * @typedef {object} SriBundleConf
 * @property {string} publicPath - Absolute path of the bundle's public dir;
 *                                 the fallback root for URL→disk resolution.
 * @property {object} [content] - Bundle content configuration slice.
 * @property {object} [content.statics] - Exact-match URL→absolute-path
 *                                        overrides (from `statics.json`);
 *                                        consulted before `publicPath`.
 */

/**
 * Computes the SRI integrity value for a file on disk.
 *
 * Reads the file synchronously and returns `sha384-<base64>` on success.
 * Returns `null` — never throws — when the file cannot be read: the caller
 * treats `null` as "emit no attribute" (fail-open).
 *
 * A stat-validated cache makes repeat calls cheap: one `fs.statSync` per
 * call, and the file is only re-read when its `mtimeMs` or `size` moved.
 *
 * @function computeIntegrity
 * @memberof module:sri
 * @param {string} filePath - Absolute path of the asset file.
 * @returns {string|null} `sha384-<base64>` (64 base64 chars, no padding), or
 *                        `null` when the file is missing or unreadable.
 *
 * @example
 * var sri = require('lib/sri');
 * sri.computeIntegrity('/var/app/public/js/app.js');
 * // => 'sha384-agv0K0aWLDzvDxoOWEsm2s7uAUYBgObriGygDyUIi7eQ/fZ00JWCG74nfkKG5qtv'
 *
 * @example
 * // Missing file — fail-open, no throw
 * sri.computeIntegrity('/var/app/public/js/deleted.js'); // => null
 */
var computeIntegrity = function(filePath) {
    var entry = digestFile(filePath);
    return ( entry ) ? entry.integrity : null;
};

/**
 * Computes the #P48 version token for a file on disk: the first 10 hex
 * characters of its sha384 digest. It changes whenever the file's bytes do, so
 * a URL carrying it can be cached for a year. Shares the stat-validated digest
 * cache with {@link computeIntegrity} (one read per file version).
 *
 * @function computeVersion
 * @memberof module:sri
 * @param {string} filePath - Absolute path of the asset file.
 * @returns {string|null} 10 lowercase hex characters, or `null` when the file
 *                        is missing, not a regular file, unreadable, or larger
 *                        than 8 MiB ({@link VERSION_MAX_BYTES}).
 *
 * @example
 * var sri = require('lib/sri');
 * sri.computeVersion('/var/app/public/js/app.js'); // => '6a0bf42b46'
 *
 * @example
 * // Missing file — fail-open, no throw
 * sri.computeVersion('/var/app/public/js/deleted.js'); // => null
 */
var computeVersion = function(filePath) {
    var entry = digestFile(filePath, VERSION_MAX_BYTES);
    return ( entry ) ? entry.version : null;
};

/**
 * Builds the attribute string to splice into an emitted asset tag.
 *
 * Returns ` integrity="sha384-..." crossorigin="anonymous"` — note the
 * LEADING SPACE, so the caller concatenates it directly before the tag's
 * closing bracket — or the EMPTY STRING whenever no honest hash can be
 * produced (fail-open). Never throws.
 *
 * Skipped (empty string returned) for:
 * - external URLs (`scheme://` or protocol-relative `//host/...`) — their
 *   bytes are not on this disk;
 * - URLs that resolve to no readable file under the exact-match statics map
 *   or the bundle `publicPath` (directory-mapped statics resolve nowhere
 *   here and are deliberately left uncovered rather than guessed at);
 * - missing or incomplete bundle configuration.
 *
 * URL handling before resolution: any `?query` / `#fragment` suffix is
 * stripped, and when the emitted URL was prefixed with the bundle webroot
 * (the resource builder mutates URLs that way when a webroot is configured),
 * the prefix is stripped back off so resolution happens against the
 * webroot-free public URL.
 *
 * @function getIntegrityAttributes
 * @memberof module:sri
 * @param {string} url - The asset URL exactly as it will be emitted in the
 *                       tag (possibly webroot-prefixed).
 * @param {SriBundleConf} conf - Bundle/env configuration slice (needs
 *                               `publicPath`; `content.statics` optional).
 * @param {string} [webroot='/'] - The bundle webroot; a value other than
 *                                 `'/'` is stripped off `url` when `url`
 *                                 starts with it.
 * @returns {string} ` integrity="..." crossorigin="anonymous"`, or `''`.
 *
 * @example
 * var sri = require('lib/sri');
 * sri.getIntegrityAttributes('/js/vendor/gina/gina.min.js', conf, '/');
 * // => ' integrity="sha384-..." crossorigin="anonymous"'
 *
 * @example
 * // External URL — never hashed from disk
 * sri.getIntegrityAttributes('https://cdn.example.com/lib.js', conf, '/');
 * // => ''
 *
 * @example
 * // Webroot-prefixed URL: '/myapp/js/app.js' resolves as '/js/app.js'
 * sri.getIntegrityAttributes('/myapp/js/app.js', conf, '/myapp/');
 */
var getIntegrityAttributes = function(url, conf, webroot) {
    if ( typeof(url) != 'string' || !url ) {
        return '';
    }
    // External assets: scheme-qualified or protocol-relative — not ours to hash.
    if ( /:\/\//.test(url) || url.substring(0, 2) === '//' ) {
        return '';
    }
    if ( !conf || typeof(conf.publicPath) != 'string' || !conf.publicPath ) {
        return '';
    }

    // The on-disk identity ignores query/fragment suffixes.
    var urlPath = url.split(/[?#]/)[0];

    // Undo the resource builder's webroot prefixing so resolution happens
    // against the webroot-free public URL.
    if (
        typeof(webroot) == 'string'
        && webroot.length > 1
        && webroot !== '/'
        && urlPath.substring(0, webroot.length) === webroot
    ) {
        urlPath = '/' + urlPath.substring(webroot.length);
    }

    // Exact-match statics mapping wins over the publicPath fallback — same
    // precedence as the server's static resolver.
    var filePath = null;
    if (
        conf.content
        && conf.content.statics
        && typeof(conf.content.statics[urlPath]) == 'string'
    ) {
        filePath = conf.content.statics[urlPath];
    } else {
        filePath = conf.publicPath + urlPath;
    }

    var integrity = computeIntegrity(filePath);
    if (!integrity) {
        return '';
    }

    return ' integrity="'+ integrity +'" crossorigin="anonymous"';
};

/**
 * Reduces an emitted asset URL to the webroot-free public path the static
 * server resolves: strips any `?query` / `#fragment`, then the bundle webroot
 * prefix. `null` for anything that is not a same-origin path.
 *
 * @inner
 * @private
 * @param {string} url - The asset URL as emitted (possibly webroot-prefixed).
 * @param {string} [webroot='/'] - The bundle webroot.
 * @returns {string|null} The public path (leading `/`), or `null`.
 */
var toPublicPath = function(url, webroot) {
    if ( typeof(url) != 'string' || !url ) {
        return null;
    }
    if ( /:\/\//.test(url) || url.substring(0, 2) === '//' ) {
        return null;
    }
    var urlPath = url.split(/[?#]/)[0];
    if (
        typeof(webroot) == 'string'
        && webroot.length > 1
        && webroot !== '/'
        && urlPath.substring(0, webroot.length) === webroot
    ) {
        urlPath = '/' + urlPath.substring(webroot.length);
    }
    return ( urlPath.charAt(0) === '/' ) ? urlPath : null;
};

/**
 * Resolves an emitted asset URL to the file the static server serves for it,
 * in the server's own order (`core/server.js` `handleStatics`): an exact
 * `statics.json` file mapping, then the FIRST key of `conf.staticResources`
 * (sorted longest first by `config.js`) that prefixes the path — every key,
 * as the server's prefix loop does: directory keys ending in `/` (e.g. the
 * framework's `/js/vendor/gina/`), keys holding a dot that `config.js` leaves
 * without a trailing slash, and the root `/` whatever it is mapped to — then,
 * only when no key matches, the bundle `publicPath`.
 *
 * Used for #P48 version tokens only. SRI keeps its exact-match resolution
 * ({@link getIntegrityAttributes}), deliberately: a wrong integrity value
 * hard-blocks an asset, while a token computed from a different file than the
 * one served is FAIL-SAFE — the static server compares the requested token with
 * the file it actually serves and answers `immutable` only on a match.
 *
 * @function resolveServedFile
 * @memberof module:sri
 * @param {string} url - The asset URL as emitted (possibly webroot-prefixed).
 * @param {SriBundleConf} conf - Bundle/env configuration slice (`publicPath`;
 *                               `content.statics` and `staticResources`
 *                               optional).
 * @param {string} [webroot='/'] - The bundle webroot.
 * @returns {string|null} Absolute file path, or `null` for an external URL or a
 *                        missing configuration. The file may not exist.
 *
 * @example
 * var sri = require('lib/sri');
 * sri.resolveServedFile('/js/vendor/gina/gina.min.js', conf, '/');
 * // => '<gina>/framework/v<version>/core/asset/plugin/dist/vendor/gina/js/gina.min.js'
 */
var resolveServedFile = function(url, conf, webroot) {
    var urlPath = toPublicPath(url, webroot);
    if ( !urlPath ) {
        return null;
    }
    if ( !conf || typeof(conf.publicPath) != 'string' || !conf.publicPath ) {
        return null;
    }

    var statics = ( conf.content && conf.content.statics && typeof(conf.content.statics) == 'object' )
        ? conf.content.statics
        : {};
    if ( typeof(statics[urlPath]) == 'string' ) {
        return statics[urlPath];
    }

    // The server's prefix loop (`handleStatics`): the first key, longest first,
    // that starts the path wins, and the file is `<target>/<rest of the path>`.
    // A string prefix, not the server's unescaped RegExp: a key holding a dot
    // could match a different path there, which only leaves that URL without a
    // matching token (fail-safe), never a token for bytes it does not serve.
    // The server's second pass (a missing file retried against a key equal to
    // its directory) is not mirrored: a missing file yields no token here.
    var prefixes = ( Array.isArray(conf.staticResources) )
        ? conf.staticResources
        : Object.keys(statics).sort(function(a, b) { return b.length - a.length; });
    for (var p = 0, pLen = prefixes.length; p < pLen; ++p) {
        var prefix = prefixes[p];
        if (
            typeof(prefix) == 'string'
            && prefix
            && typeof(statics[prefix]) == 'string'
            && urlPath.substring(0, prefix.length) === prefix
        ) {
            return statics[prefix] + '/' + urlPath.substring(prefix.length);
        }
    }

    return conf.publicPath + urlPath;
};

/**
 * Returns `url` with the #P48 content token appended — `?v=<token>`, or
 * `&v=<token>` when the URL already has a query; a `#fragment` stays last — so
 * a consumer can serve it `immutable` for a year: the URL changes when the
 * served bytes do.
 *
 * FAIL-OPEN: an external URL, a URL that resolves to no readable file, a
 * missing configuration or a non-string comes back UNCHANGED (it loads exactly
 * as before). A URL the template author already versioned (a `v=` parameter)
 * is left alone.
 *
 * @function getVersionedUrl
 * @memberof module:sri
 * @param {string} url - The asset URL exactly as it will be emitted (possibly
 *                       webroot-prefixed).
 * @param {SriBundleConf} conf - Bundle/env configuration slice.
 * @param {string} [webroot='/'] - The bundle webroot.
 * @returns {string} The versioned URL, or `url` unchanged.
 *
 * @example
 * var sri = require('lib/sri');
 * sri.getVersionedUrl('/js/vendor/gina/gina.min.js', conf, '/');
 * // => '/js/vendor/gina/gina.min.js?v=8e075c42a1'
 *
 * @example
 * // External URL — unchanged
 * sri.getVersionedUrl('https://cdn.example.com/lib.js', conf, '/');
 * // => 'https://cdn.example.com/lib.js'
 */
var getVersionedUrl = function(url, conf, webroot) {
    if ( typeof(url) != 'string' || !url ) {
        return url;
    }
    var hashAt  = url.indexOf('#');
    var base    = ( hashAt > -1 ) ? url.substring(0, hashAt) : url;
    var frag    = ( hashAt > -1 ) ? url.substring(hashAt) : '';
    if ( /[?&]v=/.test(base) ) {
        return url;
    }
    var filePath = resolveServedFile(url, conf, webroot);
    if ( !filePath ) {
        return url;
    }
    var version = computeVersion(filePath);
    if ( !version ) {
        return url;
    }
    return base + ( base.indexOf('?') > -1 ? '&' : '?' ) + 'v=' + version + frag;
};

/**
 * Reads the #P48 token a request asked for: the value of its `v` query
 * parameter, or `null`. Engine-agnostic — pass the request's ORIGINAL URL
 * (isaac and Express both keep it on `request.originalUrl`; `request.url` may
 * already be query-stripped).
 *
 * @function getRequestedVersion
 * @memberof module:sri
 * @param {string} url - The request URL, query included.
 * @returns {string|null} The `v` value, or `null` when absent.
 *
 * @example
 * var sri = require('lib/sri');
 * sri.getRequestedVersion('/js/app.js?v=6a0bf42b46'); // => '6a0bf42b46'
 * sri.getRequestedVersion('/js/app.js');              // => null
 */
var getRequestedVersion = function(url) {
    if ( typeof(url) != 'string' ) {
        return null;
    }
    var q = url.indexOf('?');
    if ( q < 0 ) {
        return null;
    }
    var m = /(?:^|&)v=([^&#]*)/.exec(url.substring(q + 1));
    return ( m ) ? m[1] : null;
};

module.exports = {
    computeIntegrity        : computeIntegrity,
    computeVersion          : computeVersion,
    getIntegrityAttributes  : getIntegrityAttributes,
    resolveServedFile       : resolveServedFile,
    getVersionedUrl         : getVersionedUrl,
    getRequestedVersion     : getRequestedVersion
};
