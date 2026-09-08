/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-Permitted-Cross-Domain-Policies plugin (#HDR12) — emits the
 * `X-Permitted-Cross-Domain-Policies` response header on every response,
 * restricting Adobe Flash and PDF readers from honouring cross-domain
 * policy files served from this origin. **Closes Phase 1.5** of the
 * gina security-headers track.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp                          = require('gina');
 *     var xPermittedCrossDomainPolicies  = require('gina').plugins.XPermittedCrossDomainPolicies();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xPermittedCrossDomainPolicies);
 *         event.emit('complete', app);
 *     });
 *
 * Four valid values:
 *
 *   - `none`            — default. No cross-domain policy files honoured;
 *                         no Flash / PDF cross-origin loading.
 *   - `master-only`     — only the master policy file at /crossdomain.xml
 *                         is honoured.
 *   - `by-content-type` — only `Content-Type: text/x-cross-domain-policy`
 *                         policy files are honoured (lighter than master-only).
 *   - `all`             — any cross-domain policy file is honoured (least
 *                         restrictive; NOT recommended).
 *
 * Flash is end-of-life since December 2020; Adobe Reader historically
 * honoured the header but most modern PDF readers ignore it. helmet
 * still ships `xPermittedCrossDomainPolicies` for defense-in-depth +
 * security-scanner-parity narrative.
 *
 * helmet's middleware uses `{ permittedPolicies: <enum> }` (with a
 * typed enum: `"none" | "master-only" | "by-content-type" | "all"`).
 * gina uses `{ value: <enum> }` matching the existing single-token-
 * enum convention (HDR2 / HDR3 / HDR6 / HDR9 / HDR13 / HDR14). The
 * README documents the helmet-API mapping for migrators.
 *
 * Tokens are case-insensitive at this layer — values are normalised
 * to lowercase before validation and emission. Unknown tokens throw
 * at factory call time to fail fast.
 *
 * Reference:
 * https://docs.adobe.com/content/dam/acom/en/devnet/articles/crossdomain_policy_file_spec/crossdomain_policy_file_specification.pdf
 *
 * @module plugins/security-headers/x-permitted-cross-domain-policies
 */

var HEADER_NAME    = 'x-permitted-cross-domain-policies';
var VALID_VALUES   = ['none', 'master-only', 'by-content-type', 'all'];
var DEFAULT_VALUE  = 'none';


/**
 * Read the active bundle's `settings.json > xPermittedCrossDomainPolicies.*`
 * block and return the merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready
 * yet (e.g. `XPermittedCrossDomainPolicies()` invoked at module-require
 * time, before `onInitialize`).
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
            pluginConf   = settings.xPermittedCrossDomainPolicies || {};
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
 * Mirrors the #HDR3 / #HDR6 / #HDR13 / #HDR14 throw-on-invalid pattern.
 * Fast-fail at factory call time so the bundle won't start with a
 * misconfigured header.
 *
 * @param {string|undefined} value
 * @returns {string}
 * @throws  {Error} when value is not one of the 4 Adobe spec tokens
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.XPermittedCrossDomainPolicies] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.XPermittedCrossDomainPolicies] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(per the Adobe Cross-Domain Policy File Specification).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `X-Permitted-Cross-Domain-Policies` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xPermittedCrossDomainPolicies = require('gina').plugins.XPermittedCrossDomainPolicies({ value: 'none' });
 * app.use(xPermittedCrossDomainPolicies);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="none"] — one of "none", "master-only",
 *                                          "by-content-type", "all"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of the 4 Adobe spec tokens
 */
function XPermittedCrossDomainPolicies(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaXPermittedCrossDomainPolicies(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XPermittedCrossDomainPolicies._HEADER_NAME             = HEADER_NAME;
XPermittedCrossDomainPolicies._VALID_VALUES            = VALID_VALUES;
XPermittedCrossDomainPolicies._DEFAULT_VALUE           = DEFAULT_VALUE;
XPermittedCrossDomainPolicies._resolveSettingsDefaults = resolveSettingsDefaults;
XPermittedCrossDomainPolicies._mergeOptions            = mergeOptions;
XPermittedCrossDomainPolicies._resolveValue            = resolveValue;

module.exports = XPermittedCrossDomainPolicies;
