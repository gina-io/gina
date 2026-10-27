'use strict';
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module lib/secrets/backends/env
 * @description Environment-backed resolver for `${secret:KEY}` placeholders.
 * Reads the framework environment first (`getEnvVar(key)`, when the global
 * is present), then falls back to the raw `process.env[key]` — `filterArgs()`
 * (`bin/cli`) moves every `GINA_*`/`VENDOR_*`/`USER_*` key out of
 * `process.env` into `process.gina`, so in CLI and daemon processes a swept
 * key is only visible through `getEnvVar`. Never-swept processes
 * (containers, embedders, tests) resolve through `process.env` as before.
 * Throws the generic `'Secret resolution failed'` Error when neither tier
 * yields a non-empty string — the user-facing message intentionally omits
 * the key name. The key is attached non-enumerably to the thrown Error as
 * `_ginaSecretKey` so callers can log it at debug level without leaking it
 * through `toString()`.
 */

/**
 * Resolve a secret key against the framework environment, then `process.env`.
 *
 * @memberof module:lib/secrets/backends/env
 * @function resolve
 * @param {string} key - Placeholder key, e.g. `'DB_PASSWORD'`
 * @returns {string} Non-empty string value from `getEnvVar(key)` or `process.env[key]`
 * @throws {Error} `'Secret resolution failed'` when neither tier carries a non-empty string
 *
 * @example
 * var env = require('./backends/env');
 * process.env.DB_PASSWORD = 's3cret';
 * env.resolve('DB_PASSWORD'); // → 's3cret'
 *
 * @example
 * // In a CLI/daemon process, a shell-exported GINA_* key was swept out of
 * // process.env into the framework environment — the getEnvVar tier finds it:
 * // process.gina.GINA_API_TOKEN === 'tok';  delete process.env.GINA_API_TOKEN;
 * env.resolve('GINA_API_TOKEN'); // → 'tok'  (#B156)
 *
 * @example
 * delete process.env.MISSING;
 * try {
 *     env.resolve('MISSING');
 * } catch (e) {
 *     e.message;          // 'Secret resolution failed'  ← no key name
 *     e._ginaSecretKey;   // 'MISSING'                  ← non-enumerable, for debug logging
 * }
 */
function resolve(key) {
    // #B156 — framework-environment tier first, then process.env.
    //
    // #B270 — the two tiers are read INDEPENDENTLY, never joined with `||`.
    // The sweep does not store the STRINGS "true"/"false" as an earlier comment
    // here claimed: filterArgs() coerces them to REAL booleans, which
    // test/integration/helper.test.js pins ("converts \"true\" string to boolean
    // true"). A truthy boolean therefore satisfied `||` and process.env was
    // never consulted — so a perfectly good environment string lost to the file
    // tier, inverting the precedence this backend exists to enforce. Only a
    // non-empty STRING from the framework tier may win; anything else (a
    // boolean, a number, undefined, '') falls through to process.env.
    var value = (typeof getEnvVar === 'function') ? getEnvVar(key) : undefined;
    if (typeof value !== 'string' || value === '') {
        value = process.env[key];
    }
    if (typeof value !== 'string' || value === '') {
        var err = new Error('Secret resolution failed');
        Object.defineProperty(err, '_ginaSecretKey', {
            value: key,
            enumerable: false,
            configurable: true,
            writable: true
        });
        throw err;
    }
    return value;
}

/**
 * Is `key` present in one of the environment tiers but carrying an EMPTY value?
 *
 * `resolve()` cannot answer this: it treats empty as unset by contract and
 * throws either way, so a caller that catches its throw knows only "not usable",
 * never "not there". This reads the raw slots to recover the distinction — used
 * solely to decide whether falling back to a lower tier (file or exec) deserves
 * the #B268 warning, never to change which value is returned.
 *
 * Both tiers are checked because `getEnvVar()` itself rejects `''`
 * (`utils/helper.js` guards on `process.gina[key] != ''`), so an empty value in
 * the framework environment is invisible through the normal accessor.
 *
 * Lives HERE — beside the tiers it interrogates — rather than in each lower-tier
 * backend: the file backend carried it privately, and a second copy in the exec
 * backend would have been a third reading of "what does the environment say",
 * the exact drift class #B270 and #B408 already paid for.
 *
 * @memberof module:lib/secrets/backends/env
 * @function isPresentButEmpty
 * @param {string} key - Placeholder key, e.g. `'DB_PASSWORD'`
 * @returns {boolean} `true` only when a tier holds `key` as an empty string
 *
 * @example
 * process.env.EMPTY_ONE = '';
 * var env = require('./backends/env');
 * env.isPresentButEmpty('EMPTY_ONE');   // → true
 * env.isPresentButEmpty('ABSENT_ONE');  // → false
 */
function isPresentButEmpty(key) {
    if (
        typeof process.gina === 'object' && process.gina !== null &&
        typeof process.gina[key] === 'string' && process.gina[key] === ''
    ) {
        return true;
    }
    return (typeof process.env[key] === 'string' && process.env[key] === '');
}

module.exports = {
    resolve: resolve,
    isPresentButEmpty: isPresentButEmpty
};
