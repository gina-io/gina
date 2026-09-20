/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module lib/duration
 * @description Human-readable duration strings to milliseconds — ONE dialect for
 * every configuration key that names a span of time: `"500ms"`, `"30s"`, `"15m"`,
 * `"3h"`, `"15d"`.
 *
 * The unit is REQUIRED. A bare number (`"15"`, `15`) is refused with `NaN` rather
 * than guessed: `15` could be seconds, minutes or milliseconds depending on the
 * key, and a silently-assumed unit is exactly the class of misconfiguration a
 * duration format exists to prevent. `"0s"` is legal and parses to `0` ("off" for
 * interval-shaped keys); whether zero is acceptable is the CALLER's decision.
 *
 * Promoted from `lib/storage`'s private parser (which now delegates here) so the
 * per-bundle login session lifetimes (`security.json > session.expires` /
 * `session.remember`) and the storage interval keys share one parser. Two other
 * duration readers exist in the tree and deliberately stay separate because they
 * ALSO accept a bare number of milliseconds: the global `gina.parseTimeout()`
 * (`core/gna.js`, behind the routing `queryTimeout` normaliser) and
 * `lib/idempotency`'s `parseTimeout`.
 */

/**
 * `<number><unit>` with optional whitespace between them (`500ms`, `30 s`,
 * `1.5h`); the unit is matched case-insensitively.
 *
 * @inner
 * @constant
 * @type {RegExp}
 */
var DURATION_RE = /^([0-9]*\.?[0-9]+)\s*(ms|s|m|h|d)$/i;

/**
 * Parse a unit-suffixed duration string into milliseconds.
 *
 * Never throws: anything that is not a string carrying one of the five units
 * returns `NaN`, so a caller gates its own error message with `isNaN()`.
 *
 * @memberof module:lib/duration
 * @param {string} value - e.g. `'500ms'`, `'30s'`, `'15m'`, `'3h'`, `'15d'`.
 * @returns {number} Milliseconds, or `NaN` when the value is not a unit-suffixed string.
 * @example
 * parse('15m');   // => 900000
 * parse('3h');    // => 10800000
 * parse('15d');   // => 1296000000
 * parse('1.5h');  // => 5400000
 * parse('0s');    // => 0 (legal — the caller decides whether zero is acceptable)
 * parse('15');    // => NaN (no unit — refused, never assumed)
 * parse(15);      // => NaN (bare number — refused)
 * parse(null);    // => NaN
 */
function parse(value) {
    if ( typeof(value) != 'string' ) { return NaN; }
    var m = value.trim().match(DURATION_RE);
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

module.exports = {
    parse : parse
};
