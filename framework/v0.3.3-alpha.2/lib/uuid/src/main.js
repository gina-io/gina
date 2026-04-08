'use strict';
/**
 * @module lib/uuid
 * @description Lightweight, cryptographically secure ID generator.
 * Produces short random strings from a base-62 alphabet (0-9 A-Z a-z).
 * Uses `crypto.getRandomValues` (available in Node.js >= 15 and all modern browsers).
 * Bitmask technique avoids modulo bias — identical to the approach used by the
 * `nanoid` npm package, but with zero external dependencies.
 *
 * Works in Node.js (CommonJS) and browser (AMD / GFF) contexts.
 *
 * @example
 * var uuid = require('lib/uuid');
 * uuid();    // 'aB3x'  (4 chars, default)
 * uuid(8);   // 'kQ7mZp2R'
 * uuid(21);  // 'V1StGXR8_Z5jdHi6B-myT'
 *
 * @param {number} [size=4] - Length of the generated ID
 * @returns {string} Random string of `size` characters from the base-62 alphabet
 */

var _alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
var _mask = 63;  // smallest (2^n - 1) >= 62 — rejects 62,63 (~3% waste, no bias)
var _step = 7;   // ceil(1.6 * 63 * 4 / 62) — enough random bytes per iteration

/**
 * Generate a cryptographically secure random ID.
 *
 * @param {number} [size=4] - Desired ID length
 * @returns {string} Random base-62 string
 */
function uuid(size) {
    size = size || 4;
    var id = '';
    while (true) {
        var bytes = crypto.getRandomValues(new Uint8Array(_step));
        for (var j = 0; j < _step; j++) {
            var idx = bytes[j] & _mask;
            if (idx < 62) {
                id += _alphabet[idx];
                if (id.length === size) return id;
            }
        }
    }
}


if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
    // Server-side: ensure crypto.getRandomValues is available (Node < 19 polyfill)
    if ( typeof(crypto) === 'undefined' || typeof(crypto.getRandomValues) !== 'function' ) {
        var _webcrypto = require('crypto').webcrypto || require('crypto');
        if (typeof(globalThis) !== 'undefined') {
            globalThis.crypto = _webcrypto;
        } else {
            crypto = _webcrypto;
        }
    }
    // Publish as node.js module
    module.exports = uuid
} else if ( typeof(define) === 'function' && define.amd) {
    // Publish as AMD module
    define( function() { return uuid })
}
