/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * HSTS plugin (#HDR4) — emits the `Strict-Transport-Security` response
 * header on every response, instructing browsers to access the host
 * exclusively over HTTPS for the next `maxAge` seconds.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp = require('gina');
 *     var hsts  = require('gina').plugins.Hsts();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(hsts);
 *         event.emit('complete', app);
 *     });
 *
 * Three configuration fields per RFC 6797:
 *
 *   - `maxAge`              — seconds; default 15552000 (180 days).
 *   - `includeSubDomains`   — boolean; default false.
 *   - `preload`             — boolean; default false. Browser-parity
 *                             invariant: preload=true requires
 *                             includeSubDomains=true AND maxAge>=31536000
 *                             (1 year) per the HSTS preload-list
 *                             submission requirements.
 *
 * Browser-parity invariant on `preload` is enforced at factory call
 * time — the factory throws when the combination is invalid, mirroring
 * the #CSRF1 SameSite=None+Secure lock and the #HDR2 ALLOW-FROM
 * rejection.
 *
 * **Spec deviation**: this plugin emits the header on every response
 * regardless of transport. RFC 6797 §7.2 says "An HSTS Host MUST NOT
 * include the STS header field in HTTP responses conveyed over non-secure
 * transport" — but §8.1 also says "the UA MUST ignore any present STS
 * header field(s)" received over insecure transport. The receiver
 * enforces the policy correctly regardless, so the practical wire
 * outcome is identical. This plugin matches helmet's behaviour
 * (emit unconditionally) rather than the sender-side MUST NOT — the
 * design favours proxy-deployment robustness (no dependency on
 * x-forwarded-proto being preserved by intermediaries) over sender-side
 * spec purity. Bundles that need strict §7.2 compliance can simply not
 * register the plugin in non-HTTPS bundles.
 *
 * @module plugins/security-headers/hsts
 */

var HEADER_NAME              = 'strict-transport-security';
var DEFAULT_MAX_AGE          = 15552000;   // 180 days
var DEFAULT_INCLUDE_SUBDOMS  = false;
var DEFAULT_PRELOAD          = false;
var PRELOAD_MIN_MAX_AGE      = 31536000;   // 1 year — HSTS preload-list submission requirement


/**
 * Read the active bundle's `settings.json > hsts.*` block and return the
 * merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `Hsts()` invoked at module-require time, before `onInitialize`).
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
            pluginConf   = settings.hsts || {};
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
 * Coerce a value to boolean with explicit defaults.
 *
 * @param {*}       value
 * @param {boolean} fallback
 * @returns {boolean}
 * @inner
 * @private
 */
function toBool(value, fallback) {
    if (typeof value === 'undefined' || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        if (/^(true|1|yes|on)$/i.test(value))  return true;
        if (/^(false|0|no|off)$/i.test(value)) return false;
    }
    return fallback;
}


/**
 * Validate the merged options against the HSTS spec invariants and
 * return a normalised triplet `{ maxAge, includeSubDomains, preload }`.
 *
 * Browser-parity invariant: `preload: true` requires
 * `includeSubDomains: true` AND `maxAge >= 31536000` (1 year). Per the
 * HSTS preload-list submission requirements at
 * https://hstspreload.org/#deployment-recommendations — the factory
 * throws at call time when the combination is invalid, mirroring the
 * #HDR2 throw-on-invalid pattern.
 *
 * @param {object} merged
 * @returns {{maxAge: number, includeSubDomains: boolean, preload: boolean}}
 * @throws  {Error} when maxAge is not a non-negative integer, or when
 *                  preload=true is not paired with includeSubDomains=true
 *                  and maxAge>=PRELOAD_MIN_MAX_AGE
 * @inner
 * @private
 */
function resolveOptions(merged) {
    var maxAge            = (typeof merged.maxAge === 'undefined' || merged.maxAge === null)
                                ? DEFAULT_MAX_AGE
                                : merged.maxAge;
    var includeSubDomains = toBool(merged.includeSubDomains, DEFAULT_INCLUDE_SUBDOMS);
    var preload           = toBool(merged.preload, DEFAULT_PRELOAD);

    if (typeof maxAge !== 'number' || !isFinite(maxAge) || maxAge < 0 || Math.floor(maxAge) !== maxAge) {
        throw new Error(
            '[gina.plugins.Hsts] maxAge must be a non-negative integer (seconds); '
            + 'received ' + JSON.stringify(merged.maxAge) + '.'
        );
    }

    if (preload) {
        if (!includeSubDomains) {
            throw new Error(
                '[gina.plugins.Hsts] preload=true requires includeSubDomains=true '
                + 'per the HSTS preload-list submission requirements — see '
                + 'https://hstspreload.org/#deployment-recommendations'
            );
        }
        if (maxAge < PRELOAD_MIN_MAX_AGE) {
            throw new Error(
                '[gina.plugins.Hsts] preload=true requires maxAge>=' + PRELOAD_MIN_MAX_AGE
                + ' (1 year) per the HSTS preload-list submission requirements; '
                + 'received maxAge=' + maxAge + '. See '
                + 'https://hstspreload.org/#deployment-recommendations'
            );
        }
    }

    return { maxAge: maxAge, includeSubDomains: includeSubDomains, preload: preload };
}


/**
 * Build the header value string from a normalised triplet.
 *
 * Per RFC 6797 §6.1, `max-age` MUST appear first; the optional
 * `includeSubDomains` and `preload` directives are appended in that
 * order when their fields are true.
 *
 * @param   {{maxAge: number, includeSubDomains: boolean, preload: boolean}} opts
 * @returns {string}
 * @inner
 * @private
 */
function buildHeaderValue(opts) {
    var parts = ['max-age=' + opts.maxAge];
    if (opts.includeSubDomains) parts.push('includeSubDomains');
    if (opts.preload)           parts.push('preload');
    return parts.join('; ');
}


/**
 * Return an express-compatible middleware that sets the
 * `Strict-Transport-Security` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var hsts = require('gina').plugins.Hsts({
 *     maxAge:            63072000,
 *     includeSubDomains: true,
 *     preload:           true
 * });
 * app.use(hsts);
 *
 * @param   {object}  [opts]
 * @param   {number}  [opts.maxAge=15552000]            — seconds (180 days default)
 * @param   {boolean} [opts.includeSubDomains=false]
 * @param   {boolean} [opts.preload=false]              — preload-list opt-in
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when maxAge is not a non-negative integer, or when
 *                  preload=true is not paired with includeSubDomains=true
 *                  and maxAge>=31536000 (1 year)
 */
function Hsts(opts) {
    var defaults    = resolveSettingsDefaults();
    var merged      = mergeOptions(opts, defaults);
    var resolved    = resolveOptions(merged);
    var headerValue = buildHeaderValue(resolved);

    return function ginaHsts(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, headerValue);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
Hsts._HEADER_NAME             = HEADER_NAME;
Hsts._DEFAULT_MAX_AGE         = DEFAULT_MAX_AGE;
Hsts._DEFAULT_INCLUDE_SUBDOMS = DEFAULT_INCLUDE_SUBDOMS;
Hsts._DEFAULT_PRELOAD         = DEFAULT_PRELOAD;
Hsts._PRELOAD_MIN_MAX_AGE     = PRELOAD_MIN_MAX_AGE;
Hsts._resolveSettingsDefaults = resolveSettingsDefaults;
Hsts._mergeOptions            = mergeOptions;
Hsts._resolveOptions          = resolveOptions;
Hsts._buildHeaderValue        = buildHeaderValue;
Hsts._toBool                  = toBool;

module.exports = Hsts;
