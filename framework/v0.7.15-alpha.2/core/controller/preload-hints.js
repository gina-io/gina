'use strict';
/**
 * #B765 — the size and the switch of gina's automatic preload hints: the `link`
 * header of an HTML 200 and the 103 Early Hints sent before it (an `http/2.0`
 * bundle in production).
 *
 * A reverse proxy reads a response's header block into a fixed buffer and
 * answers 502 when it does not fit: nginx's `proxy_buffer_size` is one memory
 * page, 4 KiB on x86_64. Both hints grew by one entry per declared stylesheet
 * and script and per layout image, with no limit and no way to turn them off.
 * Both now go through `shapeLinks()`: an entry whose URL already appeared is
 * dropped (#B767), and the value stops at the last entry that keeps it within
 * `preloadHintsMaxSize` bytes (templates.json, default 1024; `0` = no cap);
 * `preloadHintsEnabled: false` sends neither hint.
 *
 * Parameters only; the one piece of state is the flag that keeps the warning
 * for an invalid size to once per process.
 *
 * @module core/controller/preload-hints
 */

/**
 * The cap applied when `preloadHintsMaxSize` is absent or invalid.
 * @constant {number}
 */
var DEFAULT_MAX_SIZE = 1024;

/**
 * Set once the invalid-size warning has been printed: the check runs on every
 * render, so a bad value is reported once rather than per request (under
 * dev-mode hot-reload the module may be evaluated again, and the warning with it).
 * @type {boolean}
 * @private
 */
var warnedInvalidSize = false;

/**
 * Split a `Link` header value into its entries. A new entry starts at a comma
 * followed by `<` (whitespace allowed in between), so the commas inside an
 * `imagesrcset` value stay in their entry.
 *
 * @param {string} value - A `Link` header value
 * @returns {string[]} The entries, trimmed, empty ones dropped
 *
 * @example
 * splitLinkEntries('</a.css>; as=style; rel=preload,</b.js>; as=script; rel=preload');
 * // -> ['</a.css>; as=style; rel=preload', '</b.js>; as=script; rel=preload']
 */
function splitLinkEntries(value) {
    var entries = [];
    if ( !value ) {
        return entries;
    }
    var parts = String(value).split(/,(?=\s*<)/);
    for (var i = 0, len = parts.length; i < len; ++i) {
        var entry = parts[i].trim().replace(/,+$/, '').trim();
        if ( entry ) {
            entries.push(entry);
        }
    }
    return entries;
}

/**
 * The URL of a `Link` entry: the text between its first `<` and the next `>`.
 *
 * @param {string} entry - One `Link` entry
 * @returns {string|null} The URL, or `null` when the entry has none
 *
 * @example
 * linkEntryUrl('</css/app.css?v=99bf1f0781>; as=style; rel=preload'); // -> '/css/app.css?v=99bf1f0781'
 */
function linkEntryUrl(entry) {
    var start = entry.indexOf('<');
    var end   = ( start > -1 ) ? entry.indexOf('>', start + 1) : -1;
    return ( end > start ) ? entry.slice(start + 1, end) : null;
}

/**
 * Drop every entry whose URL appeared in an earlier entry (#B767). The first
 * one wins, so the order is kept; an entry without a URL is kept as is.
 *
 * @param {string[]} entries
 * @returns {string[]}
 *
 * @example
 * dedupLinkEntries(['</a.css>; as=style; rel=preload', '</a.css>; as=style; rel=preload']);
 * // -> ['</a.css>; as=style; rel=preload']
 */
function dedupLinkEntries(entries) {
    var seen = Object.create(null), kept = [];
    for (var i = 0, len = entries.length; i < len; ++i) {
        var url = linkEntryUrl(entries[i]);
        if ( url !== null ) {
            if ( seen[url] ) {
                continue;
            }
            seen[url] = true;
        }
        kept.push(entries[i]);
    }
    return kept;
}

/**
 * Keep entries, in order, while their joined value stays within `maxSize`
 * bytes; stop at the first entry that would exceed it.
 *
 * @param {string[]} entries
 * @param {number} maxSize - Bytes; `0` keeps every entry
 * @param {string} separator - What the entries will be joined with (`','`, or `', '` for node's HTTP/1.1 array)
 * @returns {string[]}
 *
 * @example
 * capLinkEntries(['</a.css>; as=style; rel=preload', '</b.css>; as=style; rel=preload'], 40, ',');
 * // -> ['</a.css>; as=style; rel=preload']   (31 bytes; the second would make 63)
 */
function capLinkEntries(entries, maxSize, separator) {
    if ( !maxSize ) {
        return entries.slice();
    }
    var sepBytes = Buffer.byteLength(separator), kept = [], bytes = 0;
    for (var i = 0, len = entries.length; i < len; ++i) {
        var add = Buffer.byteLength(entries[i]) + ( (kept.length > 0) ? sepBytes : 0 );
        if ( bytes + add > maxSize ) {
            break;
        }
        kept.push(entries[i]);
        bytes += add;
    }
    return kept;
}

/**
 * Read `preloadHintsEnabled` and `preloadHintsMaxSize` off a resolved template
 * config. Only `false` turns the hints off. A size must be a non-negative
 * integer; any other value (a negative number, a fraction, a string, `NaN`)
 * falls back to `DEFAULT_MAX_SIZE` and prints one warning per process.
 * An absent or `null` size is the default, silently.
 *
 * @param {object} [templateConf] - The page's resolved `templates.json` entry
 * @returns {{enabled: boolean, maxSize: number}}
 *
 * @example
 * resolvePreloadHints({ preloadHintsMaxSize: 0 });     // -> { enabled: true, maxSize: 0 }
 * resolvePreloadHints({ preloadHintsEnabled: false }); // -> { enabled: false, maxSize: 1024 }
 */
function resolvePreloadHints(templateConf) {
    var conf    = templateConf || {};
    var size    = conf.preloadHintsMaxSize;
    var maxSize = DEFAULT_MAX_SIZE;

    if ( typeof(size) != 'undefined' && size !== null ) {
        if ( typeof(size) == 'number' && Number.isInteger(size) && size >= 0 ) {
            maxSize = size;
        } else if ( !warnedInvalidSize ) {
            warnedInvalidSize = true;
            console.warn('[preload-hints] templates.json `preloadHintsMaxSize` must be a whole number of bytes, 0 or more (0 = no cap) - got '+ JSON.stringify(size) +', using '+ DEFAULT_MAX_SIZE +'. Warned once per process.');
        }
    }

    return { enabled: conf.preloadHintsEnabled !== false, maxSize: maxSize };
}

/**
 * The value of an automatic hint (the 200 `link` header or the 103): `''` when
 * `preloadHintsEnabled` is `false`; otherwise duplicates dropped and the cap
 * applied, entries joined with `','` as gina writes them. Under the cap and
 * without duplicates the value comes back byte-identical.
 *
 * @param {string} value - The assembled `Link` value
 * @param {object} [templateConf] - The page's resolved `templates.json` entry
 * @returns {string} `''` when nothing is to be sent
 *
 * @example
 * shapeLinks('</a.css>; as=style; rel=preload,</a.css>; as=style; rel=preload', {});
 * // -> '</a.css>; as=style; rel=preload'
 */
function shapeLinks(value, templateConf) {
    var opts = resolvePreloadHints(templateConf);
    if ( !opts.enabled || !value ) {
        return '';
    }
    return capLinkEntries(dedupLinkEntries(splitLinkEntries(value)), opts.maxSize, ',').join(',');
}

/**
 * The entries `setEarlyHints()` hands node's `res.writeEarlyHints()` over
 * HTTP/1.1: one array element per entry (node validates each element as ONE
 * link value and joins them with `', '`, #B770), capped at the page's
 * `preloadHintsMaxSize` measured on that join.
 *
 * @param {string|string[]} links - What `setEarlyHints()` was given
 * @param {object} [templateConf] - The page's resolved `templates.json` entry
 * @returns {string[]} Possibly empty
 *
 * @example
 * toEarlyHintsList(['</a.css>; rel=preload; as=style', '</b.js>; rel=preload; as=script'], {});
 * // -> ['</a.css>; rel=preload; as=style', '</b.js>; rel=preload; as=script']
 */
function toEarlyHintsList(links, templateConf) {
    var given   = Array.isArray(links) ? links : [links];
    var entries = [];
    for (var i = 0, len = given.length; i < len; ++i) {
        if ( given[i] ) {
            entries = entries.concat(splitLinkEntries(given[i]));
        }
    }
    return capLinkEntries(entries, resolvePreloadHints(templateConf).maxSize, ', ');
}

/**
 * Test seam: re-arm the once-per-process warning.
 * @private
 */
function _resetWarnings() {
    warnedInvalidSize = false;
}

module.exports = {
    DEFAULT_MAX_SIZE    : DEFAULT_MAX_SIZE,
    splitLinkEntries    : splitLinkEntries,
    linkEntryUrl        : linkEntryUrl,
    dedupLinkEntries    : dedupLinkEntries,
    capLinkEntries      : capLinkEntries,
    resolvePreloadHints : resolvePreloadHints,
    shapeLinks          : shapeLinks,
    toEarlyHintsList    : toEarlyHintsList,
    _resetWarnings      : _resetWarnings
};
