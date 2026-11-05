/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/lib/error-ref
 *
 * #ERRREF — the incident-ref mint for error responses answered outside a
 * controller (the fast lane, #P49, is its first caller).
 *
 * Every JSON error body carries a top-level `ref`: a short correlation code an
 * end user can relay by voice or typing, paired server-side with the full error
 * detail in ONE log line. A caller-supplied ref is honoured when it is
 * relay-safe — 1 to 32 word characters, dots or dashes, the same bounded-length,
 * restricted-charset discipline as an inbound `X-Request-Id`, which keeps it out
 * of reach of log forging — and anything else gets a fresh mint of 6 uppercase
 * hex characters (`crypto.randomBytes(3)`).
 *
 * The controller (`core/controller/controller.js`) and the server
 * (`core/server.js`) keep their own byte-identical copies of this rule: the
 * controller is evicted per request in dev mode, and both copies are pinned by
 * `test/core/error-ref.test.js`. `test/lib/error-ref.test.js` drives this module
 * against the controller's copy so the three cannot drift apart.
 *
 * Server-side only, stateless; plain-required by the registry (`lib.errorRef`).
 */

var crypto = require('crypto');

/**
 * The relay-safe shape a caller-supplied ref must match to be honoured.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var RELAY_SAFE = /^[\w.\-]{1,32}$/;

/**
 * Return the caller's ref when it is relay-safe, else mint a fresh one.
 *
 * Never throws; any non-string `supplied` (undefined, null, a number, an
 * object) mints.
 *
 * @memberof module:gina/lib/error-ref
 * @param {string} [supplied] - A caller- or producer-provided ref candidate
 * @returns {string} `supplied` when relay-safe, else 6 fresh uppercase hex characters
 *
 * @example
 * var errorRef = require('gina').lib.errorRef;
 * errorRef.mint();                 // 'A1B2C3' — fresh, random
 * errorRef.mint('ORDER-42');       // 'ORDER-42' — honoured
 * errorRef.mint('bad ref!');       // '9F0E1D' — space and `!` are refused, so a fresh mint
 * errorRef.mint('x'.repeat(33));   // a fresh mint — 33 characters is over the 32 cap
 */
function mint(supplied) {
    if ( typeof(supplied) == 'string' && RELAY_SAFE.test(supplied) ) {
        return supplied;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
    mint : mint
};
