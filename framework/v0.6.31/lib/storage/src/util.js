/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/storage/util
 * @description Pure helpers shared by the storage core and its adapters —
 * id generation, path confinement, size parsing and extension sanitisation.
 *
 * They live in their own module rather than in `src/main` so the adapter can
 * use them without requiring the core back (a cycle), and so each can be
 * unit-tested in isolation. Everything here is pure: no I/O, no globals, no
 * framework imports.
 */

var nodePath = require('path');
var crypto   = require('crypto');

/**
 * Crockford base32 alphabet (ULID) — excludes I, L, O and U so a transcribed
 * key cannot be misread.
 *
 * @inner
 * @constant
 * @type {string}
 */
var CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Generate a ULID: 10 characters of millisecond timestamp followed by 16
 * characters of cryptographic randomness, Crockford base32 throughout.
 *
 * Lexicographically sortable by creation time, which is what makes the
 * `sharded` date prefix cheap to scan; 80 bits of entropy make a
 * within-millisecond collision not worth guarding against.
 *
 * Implemented inline rather than via `lib/uuid` — that is a random base-62
 * generator with no time ordering, and importing it would breach the
 * framework-independence rule.
 *
 * @memberof module:lib/storage/util
 * @param {number} [now] - Epoch ms; defaults to `Date.now()`. Injectable for tests.
 * @returns {string} A 26-character ULID.
 * @example
 * ulid();  // => '01K2S9F3H7QF8ZB4M6N0YCVJ2X'
 * ulid(0); // => '0000000000' followed by 16 random characters
 */
function ulid(now) {
    var ts  = (typeof now === 'number') ? now : Date.now();
    var out = '';
    var i;

    // 48-bit timestamp, most-significant character first.
    for (i = 9; i >= 0; i--) {
        out = CROCKFORD.charAt(ts % 32) + out;
        ts = Math.floor(ts / 32);
    }

    // 16 characters x 5 bits = 80 bits of randomness. Mask to 5 bits rather
    // than taking a byte modulo 32 — 256 is not a multiple of 32, so the
    // modulo form would bias the low characters.
    var rnd = crypto.randomBytes(16);
    for (i = 0; i < 16; i++) {
        out += CROCKFORD.charAt(rnd[i] & 0x1f);
    }
    return out;
}

/**
 * Confine a resolved path to its intended base directory, rejecting traversal
 * escapes that would otherwise canonicalise to a sibling under a shared root.
 *
 * Lib-local copy of the `confineToBase` guard introduced by #B179 (Inspector
 * CWE-22, 0.6.1). The two engine copies live inside closures in
 * `core/server.js` and `core/server.isaac.js`, are unreachable from here, and
 * importing them would breach the framework-independence rule. Behaviourally
 * identical to both — keep it that way.
 *
 * Note the PathObject helper normalises `..` rather than rejecting it, so a
 * naive join is the exploit shape this guard exists to close.
 *
 * Purely lexical: no symlink resolution. A root that can contain
 * attacker-placed symlinks is NOT confined by this, and nothing in the
 * codebase closes that gap today.
 *
 * @memberof module:lib/storage/util
 * @param {string} filename - Candidate absolute path (already percent-decoded).
 * @param {string} base     - The intended base directory.
 * @returns {?string} The canonical in-base path, or `null` when it escapes `base`.
 * @example
 * confineToBase('/srv/data/2026/01/x.pdf', '/srv/data');    // => '/srv/data/2026/01/x.pdf'
 * confineToBase('/srv/data/../../etc/passwd', '/srv/data'); // => null
 * confineToBase('/srv/data-secrets/x', '/srv/data');        // => null (sibling-prefix bypass)
 * confineToBase('/srv/data/x', '');                         // => null (fails closed)
 */
function confineToBase(filename, base) {
    if ( typeof(filename) != 'string' || typeof(base) != 'string' || base.length === 0 ) {
        return null;
    }
    var _resolvedBase = nodePath.resolve(base);
    var _resolvedFile = nodePath.resolve(filename);
    // separator-aware containment: identical to base, or a proper child of it
    if ( _resolvedFile === _resolvedBase || _resolvedFile.indexOf(_resolvedBase + nodePath.sep) === 0 ) {
        return _resolvedFile;
    }
    return null;
}

/**
 * Parse a unit-suffixed size string into bytes.
 *
 * **Deliberately stricter than the upload path's parser.** `core/server.js`
 * treats a BARE number as megabytes, purely so pre-#B51 upload configs keep
 * working. A new key carries no such debt, and `settings.upload` already gives
 * a bare number two different meanings in one block (`maxFields: 1000` is a
 * count, `maxFieldsSize: 50` would be megabytes) — so there is no house
 * semantic to be consistent with. This parser refuses to guess: a bare number
 * returns `NaN` and the boot lint names the fix. Every explicit-unit string
 * parses identically in both, so the two never disagree where both accept.
 *
 * Units are binary (1024-based) despite the KB/MB/GB spelling, matching the
 * upload parser.
 *
 * @memberof module:lib/storage/util
 * @param {string} value - e.g. `'50MB'`, `'512KB'`, `'1.5GB'`, `'900B'`.
 * @returns {number} Bytes, or `NaN` when the value is not a unit-suffixed string.
 * @example
 * parseSize('50MB');  // => 52428800
 * parseSize('1.5GB'); // => 1610612736
 * parseSize('50');    // => NaN (no unit — refused, never assumed to be MB)
 * parseSize(50);      // => NaN (bare number — refused)
 * parseSize(null);    // => NaN
 */
function parseSize(value) {
    if ( typeof(value) != 'string' ) { return NaN; }
    var m = value.trim().match(/^([0-9]*\.?[0-9]+)\s*(b|kb|k|mb|m|gb|g)$/i);
    if ( !m ) { return NaN; }
    var n = parseFloat(m[1]);
    switch ( m[2].toLowerCase() ) {
        case 'b':
            return n;
        case 'k':
        case 'kb':
            return n * 1024;
        case 'g':
        case 'gb':
            return n * 1024 * 1024 * 1024;
        case 'm':
        case 'mb':
        default:
            return n * 1024 * 1024;
    }
}

/**
 * Parse a unit-suffixed duration string into milliseconds.
 *
 * The time twin of {@link module:lib/storage/util.parseSize}, with the same
 * strictness: a bare number returns `NaN` and the boot lint names the fix.
 * They are SEPARATE parsers on purpose — `'15m'` means 15 minutes here and
 * 15 megabytes there, so one parser serving both keys would have to guess
 * from context, which is the exact bug the unit requirement exists to
 * prevent.
 *
 * @memberof module:lib/storage/util
 * @param {string} value - e.g. `'500ms'`, `'30s'`, `'15m'`, `'1h'`, `'7d'`.
 * @returns {number} Milliseconds, or `NaN` when the value is not a unit-suffixed string.
 * @example
 * parseDuration('15m');  // => 900000
 * parseDuration('1h');   // => 3600000
 * parseDuration('0s');   // => 0 (legal — "off" for interval-shaped keys)
 * parseDuration('15');   // => NaN (no unit — refused, never assumed)
 * parseDuration(15);     // => NaN (bare number — refused)
 */
function parseDuration(value) {
    if ( typeof(value) != 'string' ) { return NaN; }
    var m = value.trim().match(/^([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)$/i);
    if ( !m ) { return NaN; }
    var n = parseFloat(m[1]);
    switch ( m[2].toLowerCase() ) {
        case 'ms':
            return n;
        case 's':
            return n * 1000;
        case 'h':
            return n * 60 * 60 * 1000;
        case 'd':
            return n * 24 * 60 * 60 * 1000;
        case 'm':
        default:
            return n * 60 * 1000;
    }
}

/**
 * Whether any segment of `key` names driver-internal state.
 *
 * `.tmp` holds in-flight writes and `.meta.db` is the metadata database — both
 * live INSIDE the root by design, so both are reachable by a key that never
 * leaves it. Without this, a caller passing `.meta.db` to `release()` would
 * delete the driver's own index. (The `.driver` strategy-stamp row is store-
 * level only — it has no path — but the same dot rule keeps it unreachable
 * too.)
 *
 * Checked AFTER confinement, never before — see {@link makeResolvePath} for
 * why the order is load-bearing.
 *
 * @inner
 * @param {string} key - A key that has already passed confinement.
 * @returns {boolean} `true` when a segment starts with a dot.
 * @example
 * hasReservedSegment('2026/08/10/01K2…'); // => false
 * hasReservedSegment('.meta.db');         // => true
 * hasReservedSegment('.tmp/x');           // => true
 */
function hasReservedSegment(key) {
    var segments = key.split(/[\\/]/);
    for (var i = 0; i < segments.length; i++) {
        if ( segments[i].charAt(0) === '.' ) { return true; }
    }
    return false;
}

/**
 * Build the key → confined-absolute-path resolver for one driver.
 *
 * ONE implementation for every strategy, hoisted here when cas arrived so the
 * guard sequence cannot drift between drivers — this is a security boundary,
 * and two copies of a security boundary is the #B179 failure class waiting to
 * recur.
 *
 * **The guard ORDER is load-bearing, and got this wrong once.** Confinement
 * runs FIRST. A reserved-segment check placed ahead of it shadows the
 * security boundary entirely: `..` starts with a dot, so every classic
 * traversal attempt is answered with "reserved", `confineToBase` is never
 * reached, and a traversal test passes for the wrong reason — leaving the
 * real guard unexercised by the one input class it exists for. Caught by a
 * smoke run before slice 0 shipped; keep confinement first.
 *
 * The canonical-form check that follows keeps the key and its path 1:1. A
 * key like `a/../b` stays inside the root, so confinement accepts it, but
 * it addresses the same file as `b` while indexing under a different
 * metadata key — so `stat()` would answer for one and `get()` for the
 * other. Keys are opaque and always minted by `put()`, so a non-canonical
 * one never arises honestly.
 *
 * @memberof module:lib/storage/util
 * @param {string} name - Driver name, used only in error messages.
 * @param {string} root - Absolute driver root.
 * @returns {function(string): {path: ?string, error: ?Error}} The resolver — exactly one
 *                        side of its result is set.
 * @example
 * var resolvePath = makeResolvePath('assets', '/var/data/assets');
 * resolvePath('2026/08/10/01K2X.pdf'); // => { path: '/var/data/assets/2026/08/10/01K2X.pdf', error: null }
 * resolvePath('../../etc/passwd');     // => { path: null, error: Error('… escapes the driver root') }
 */
function makeResolvePath(name, root) {
    return function resolvePath(key) {
        if ( typeof(key) != 'string' || key.length === 0 ) {
            return { path: null, error: new Error('[storage:' + name + '] a non-empty string key is required (got: ' + JSON.stringify(key) + ')') };
        }
        // 1. Security boundary, first so it is genuinely exercised.
        var full = confineToBase(nodePath.join(root, key), root);
        if ( full === null ) {
            // Deliberately does NOT echo the resolved path — that would confirm
            // filesystem layout to whoever supplied the hostile key.
            return { path: null, error: new Error('[storage:' + name + '] key `' + key + '` escapes the driver root') };
        }
        // 2. Canonical form, so key and path stay 1:1.
        if ( nodePath.normalize(key) !== key || nodePath.isAbsolute(key) ) {
            return { path: null, error: new Error('[storage:' + name + '] key `' + key + '` is not in canonical form') };
        }
        // 3. Driver-internal paths, reachable without ever leaving the root.
        if ( hasReservedSegment(key) ) {
            return { path: null, error: new Error('[storage:' + name + '] key `' + key + '` is reserved (segments starting with a dot hold driver-internal state)') };
        }
        return { path: full, error: null };
    };
}

/**
 * Derive a safe file extension from a client-supplied filename.
 *
 * The extension is the ONLY part of an untrusted name that reaches the
 * filesystem, and it exists purely so an operator browsing the store can tell
 * a PDF from a PNG — nothing reads it back. It is therefore whitelisted hard
 * rather than escaped: alphanumerics only, at most 10 characters, lowercased.
 * Anything else yields the empty string and the object is stored without an
 * extension, which is always safe.
 *
 * Only the last segment of a multi-dot name survives (`.tar.gz` yields `.gz`);
 * the original name is preserved verbatim in the metadata row, where it
 * belongs.
 *
 * Extraction is delegated to `path.extname` rather than hand-rolled, so the
 * edge cases match the platform's own rule instead of a second opinion about
 * it. Two that a naive `lastIndexOf('.')` gets wrong: a dotfile (`.hidden`) has
 * NO extension — the leading dot marks it hidden, not typed — and a dot in a
 * parent directory (`a.b/c`) does not give `c` an extension.
 *
 * @memberof module:lib/storage/util
 * @param {*} originalName - Untrusted client filename; any type is tolerated.
 * @returns {string} A sanitised extension including the leading dot, or `''`.
 * @example
 * sanitiseExtension('invoice.pdf');        // => '.pdf'
 * sanitiseExtension('IMG_0001.JPEG');      // => '.jpeg'
 * sanitiseExtension('archive.tar.gz');     // => '.gz'
 * sanitiseExtension('../../etc/passwd');   // => ''
 * sanitiseExtension('payload.php%00.jpg'); // => '.jpg'
 * sanitiseExtension('.hidden');            // => ''  (a dotfile is not an extension)
 * sanitiseExtension('noext');              // => ''
 * sanitiseExtension('trailing.');          // => ''
 * sanitiseExtension(null);                 // => ''
 */
function sanitiseExtension(originalName) {
    if ( typeof(originalName) != 'string' ) { return ''; }
    var ext = nodePath.extname(originalName);
    if ( ext.length < 2 ) { return ''; } // '' (no extension) or a bare trailing '.'
    ext = ext.slice(1);
    if ( !/^[A-Za-z0-9]{1,10}$/.test(ext) ) { return ''; }
    return '.' + ext.toLowerCase();
}

/**
 * Build an `Error` carrying a machine-readable `code`.
 *
 * The read verbs (`get`/`getRange`/`resolve`) mint their errors through this
 * so an HTTP serving layer can discriminate 404 vs 416 vs 400 without parsing
 * message text — the message stays the human diagnostic and is byte-identical
 * to the pre-code era. Codes in use (UPPER_SNAKE, the GinaHttp2Error house
 * convention): `STORAGE_NO_OBJECT` (unknown / released / vanished key),
 * `STORAGE_RANGE_UNSATISFIABLE` (start at or beyond the object size — the
 * caller's 416), `STORAGE_INVALID_RANGE` (malformed bounds — a caller bug).
 *
 * @param {string} code    - UPPER_SNAKE machine code, stamped on `err.code`.
 * @param {string} message - Human-readable diagnostic, unchanged wording.
 * @returns {Error} The coded error.
 *
 * @example
 * return fn(util.codedError('STORAGE_NO_OBJECT', '[storage:main] no object for key `k`'));
 */
function codedError(code, message) {
    var err  = new Error(message);
    err.code = code;
    return err;
}

module.exports = {
    ulid              : ulid,
    confineToBase     : confineToBase,
    parseSize         : parseSize,
    parseDuration     : parseDuration,
    makeResolvePath   : makeResolvePath,
    sanitiseExtension : sanitiseExtension,
    codedError        : codedError
};
