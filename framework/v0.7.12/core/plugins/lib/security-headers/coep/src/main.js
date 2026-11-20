/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Cross-Origin-Embedder-Policy plugin (#HDR6) — emits the
 * `Cross-Origin-Embedder-Policy` (COEP) response header on every response
 * to control which cross-origin resources the page may embed.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp = require('gina');
 *     var coep  = require('gina').plugins.Coep();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(coep);
 *         event.emit('complete', app);
 *     });
 *
 * Three valid values per the W3C HTML spec
 * (https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-embedder-policies):
 *
 *   - `require-corp`   — default; cross-origin resources must opt-in via
 *                        CORP or CORS. Required (paired with
 *                        `COOP: same-origin`) to enable
 *                        `SharedArrayBuffer` and high-resolution
 *                        `performance.now()` in the page.
 *   - `credentialless` — cross-origin no-CORS requests are sent without
 *                        credentials (cookies, client certs, HTTP auth).
 *                        Less restrictive than `require-corp` but still
 *                        gates the cross-origin-isolation combo.
 *   - `unsafe-none`    — browser default; no embedding restrictions.
 *                        Equivalent to not setting the header.
 *
 * Tokens are case-insensitive at this layer — values are normalised to
 * lowercase before validation and emission (mirrors the #HDR3 normalisation).
 * Unknown tokens throw at factory call time to fail fast.
 *
 * **Tradeoff with `require-corp` default**: the default protects
 * cross-origin script-injection isolation and is required for the
 * `SharedArrayBuffer` combo, but it BREAKS pages that load cross-origin
 * resources (images, fonts, scripts on a CDN) that don't carry the
 * matching CORP / CORS header. For pages that embed third-party
 * resources without control over their CORP headers, either pair COEP
 * with a known-safe resource list or downgrade to `credentialless`
 * (cookies stripped on cross-origin no-CORS) or `unsafe-none` (no
 * isolation, but compatible with any embed).
 *
 * @module plugins/security-headers/coep
 */

var HEADER_NAME    = 'cross-origin-embedder-policy';
var VALID_VALUES   = ['require-corp', 'credentialless', 'unsafe-none'];
var DEFAULT_VALUE  = 'require-corp';


/**
 * Read the active bundle's `settings.json > coep.*` block and return the
 * merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `Coep()` invoked at module-require time, before `onInitialize`).
 *
 * @returns {object}
 * @inner
 * @private
 */
function resolveSettingsDefaults() {
    var defaults   = {};
    var pluginConf = {};

    try {
        var ctx    = getContext();
        var bundle = ctx && ctx.bundle;
        var env    = ctx && ctx.env;
        var conf   = (typeof getConfig === 'function') ? getConfig() : null;
        if (bundle && env && conf && conf[bundle] && conf[bundle][env]) {
            var content  = conf[bundle][env].content || {};
            var settings = content.settings || {};
            pluginConf   = settings.coep || {};
        }
    } catch (ignored) {
        pluginConf = {};
    }

    for (var k in pluginConf) {
        if (Object.prototype.hasOwnProperty.call(pluginConf, k)) {
            defaults[k] = pluginConf[k];
        }
    }

    return defaults;
}


/**
 * Merge caller-supplied options on top of the resolved defaults.
 * Caller-supplied values always win (`hasOwnProperty`-guarded).
 *
 * @param {object|undefined} caller
 * @param {object}           defaults
 * @returns {object}
 * @inner
 * @private
 */
function mergeOptions(caller, defaults) {
    caller = caller || {};
    var merged = {};
    for (var dk in defaults) {
        if (Object.prototype.hasOwnProperty.call(defaults, dk)) merged[dk] = defaults[dk];
    }
    for (var ck in caller) {
        if (Object.prototype.hasOwnProperty.call(caller, ck)) merged[ck] = caller[ck];
    }
    return merged;
}


/**
 * Validate the resolved `value` and return it normalised to lowercase.
 *
 * Mirrors the #HDR3 throw-on-invalid pattern — fast-fail at factory
 * call time so the bundle won't start with a misconfigured header.
 *
 * @param {string|undefined} value
 * @returns {string}
 * @throws  {Error} when value is not one of the three W3C HTML spec tokens
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.Coep] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.Coep] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(per the W3C HTML spec — '
            + 'https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-embedder-policies).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `Cross-Origin-Embedder-Policy` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var coep = require('gina').plugins.Coep({ value: 'credentialless' });
 * app.use(coep);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="require-corp"] — one of "require-corp",
 *                                                  "credentialless",
 *                                                  "unsafe-none"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of the three W3C tokens
 */
function Coep(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaCoep(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
Coep._HEADER_NAME             = HEADER_NAME;
Coep._VALID_VALUES            = VALID_VALUES;
Coep._DEFAULT_VALUE           = DEFAULT_VALUE;
Coep._resolveSettingsDefaults = resolveSettingsDefaults;
Coep._mergeOptions            = mergeOptions;
Coep._resolveValue            = resolveValue;

module.exports = Coep;
