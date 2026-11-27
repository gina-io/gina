/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Referrer-Policy plugin (#HDR3) — emits the `Referrer-Policy` response
 * header on every response to control how much referrer information the
 * browser includes when navigating away from the page or fetching
 * sub-resources.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp          = require('gina');
 *     var referrerPolicy = require('gina').plugins.ReferrerPolicy();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(referrerPolicy);
 *         event.emit('complete', app);
 *     });
 *
 * Eight valid tokens per the W3C Referrer Policy spec
 * (https://www.w3.org/TR/referrer-policy/):
 *
 *   - `no-referrer`                       — send no Referer at all.
 *   - `no-referrer-when-downgrade`        — strip Referer only on HTTPS→HTTP.
 *   - `origin`                            — send origin only.
 *   - `origin-when-cross-origin`          — origin only on cross-origin.
 *   - `same-origin`                       — send Referer only same-origin.
 *   - `strict-origin`                     — origin only, no Referer on HTTPS→HTTP.
 *   - `strict-origin-when-cross-origin`   — default; matches modern browsers.
 *   - `unsafe-url`                        — always send full URL (dangerous).
 *
 * Tokens are case-insensitive per the spec — values are normalised to
 * lowercase before validation and emission. Unknown tokens throw at
 * factory call time to fail fast (mirrors the #CSRF1 SameSite=None+Secure
 * invariant and the #HDR2 ALLOW-FROM rejection).
 *
 * @module plugins/security-headers/referrer-policy
 */

var HEADER_NAME    = 'referrer-policy';
var VALID_VALUES   = [
    'no-referrer',
    'no-referrer-when-downgrade',
    'origin',
    'origin-when-cross-origin',
    'same-origin',
    'strict-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url'
];
var DEFAULT_VALUE  = 'strict-origin-when-cross-origin';


/**
 * Read the active bundle's `settings.json > referrerPolicy.*` block and
 * return the merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `ReferrerPolicy()` invoked at module-require time, before
 * `onInitialize`).
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
            pluginConf   = settings.referrerPolicy || {};
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
 * Mirrors the #HDR2 throw-on-invalid pattern — fast-fail at factory
 * call time so the bundle won't start with a misconfigured header.
 *
 * @param {string|undefined} value
 * @returns {string}
 * @throws  {Error} when value is not one of the eight W3C tokens
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.ReferrerPolicy] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.ReferrerPolicy] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(per the W3C Referrer Policy spec — '
            + 'https://www.w3.org/TR/referrer-policy/).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `Referrer-Policy` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var referrerPolicy = require('gina').plugins.ReferrerPolicy({
 *     value: 'no-referrer'
 * });
 * app.use(referrerPolicy);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="strict-origin-when-cross-origin"] — one
 *                   of the eight W3C tokens
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of the eight W3C tokens
 */
function ReferrerPolicy(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaReferrerPolicy(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
ReferrerPolicy._HEADER_NAME             = HEADER_NAME;
ReferrerPolicy._VALID_VALUES            = VALID_VALUES;
ReferrerPolicy._DEFAULT_VALUE           = DEFAULT_VALUE;
ReferrerPolicy._resolveSettingsDefaults = resolveSettingsDefaults;
ReferrerPolicy._mergeOptions            = mergeOptions;
ReferrerPolicy._resolveValue            = resolveValue;

module.exports = ReferrerPolicy;
