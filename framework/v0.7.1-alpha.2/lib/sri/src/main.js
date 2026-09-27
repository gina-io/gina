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
 * Stat-validated integrity cache.
 * Key: absolute file path. Value: `{ mtimeMs, size, integrity }`.
 * Bounded in practice by the number of distinct assets declared across the
 * bundle's `templates.json` collections (typically a few dozen), so no
 * eviction is needed.
 *
 * @type {object}
 * @private
 */
var _cache = {};

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
    var stats = null;
    try {
        stats = fs.statSync(filePath);
    } catch (statErr) {
        return null;
    }
    if ( !stats.isFile() ) {
        return null;
    }

    var cached = _cache[filePath];
    if (
        cached
        && cached.mtimeMs === stats.mtimeMs
        && cached.size === stats.size
    ) {
        return cached.integrity;
    }

    var content = null;
    try {
        content = fs.readFileSync(filePath);
    } catch (readErr) {
        return null;
    }

    var integrity = ALGORITHM + '-' + crypto.createHash(ALGORITHM).update(content).digest('base64');
    _cache[filePath] = {
        mtimeMs   : stats.mtimeMs,
        size      : stats.size,
        integrity : integrity
    };

    return integrity;
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

module.exports = {
    computeIntegrity        : computeIntegrity,
    getIntegrityAttributes  : getIntegrityAttributes
};
