/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Cross-Origin-Resource-Policy plugin (#HDR14) — emits the
 * `Cross-Origin-Resource-Policy` (CORP) response header on every
 * response, restricting which other origins may load this resource as
 * a no-CORS / `<img>` / `<script>` / `<link>` etc. embed.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp = require('gina');
 *     var corp  = require('gina').plugins.Corp();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(corp);
 *         event.emit('complete', app);
 *     });
 *
 * Three valid values per the W3C HTML spec
 * (https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-resource-policy-internal-header):
 *
 *   - `same-origin`  — default; only the exact same origin (scheme +
 *                      host + port) may embed this resource. The most
 *                      restrictive practical posture and matches the
 *                      mate of #HDR6 Coep's `require-corp` enforcement.
 *   - `same-site`    — any same-site origin (eTLD+1 match) may embed.
 *                      Allows `app.example.com` to embed resources
 *                      served by `cdn.example.com` while still blocking
 *                      `evil.com`.
 *   - `cross-origin` — any origin may embed. Required for resources
 *                      intended to be publicly embeddable (CDN fonts,
 *                      analytics images, shared assets).
 *
 * Tokens are case-insensitive at this layer — values are normalised to
 * lowercase before validation and emission (mirrors the #HDR3 / #HDR6 /
 * #HDR13 normalisation). Unknown tokens throw at factory call time to
 * fail fast.
 *
 * **Tradeoff with the `same-origin` default**: the strictest practical
 * default is the safest posture (an attacker on another origin cannot
 * embed this resource to probe its size, dimensions, or load timing
 * for fingerprinting / side-channel attacks). But it BREAKS legitimate
 * cross-origin embeds — if `app.example.com` serves the page and
 * `cdn.example.com` serves the fonts, the font load is blocked unless
 * the CDN bundle sets `Corp: same-site` (or wider) on its responses.
 * Bundles serving public CDN-style content (fonts, images, scripts
 * meant to be embedded by arbitrary third-party sites) should pick
 * `cross-origin`.
 *
 * @module plugins/security-headers/corp
 */

var HEADER_NAME    = 'cross-origin-resource-policy';
var VALID_VALUES   = ['same-origin', 'same-site', 'cross-origin'];
var DEFAULT_VALUE  = 'same-origin';


/**
 * Read the active bundle's `settings.json > corp.*` block and return the
 * merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `Corp()` invoked at module-require time, before `onInitialize`).
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
            pluginConf   = settings.corp || {};
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
 * Mirrors the #HDR3 / #HDR6 / #HDR13 throw-on-invalid pattern —
 * fast-fail at factory call time so the bundle won't start with a
 * misconfigured header.
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
            '[gina.plugins.Corp] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.Corp] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(per the W3C HTML spec — '
            + 'https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-resource-policy-internal-header).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `Cross-Origin-Resource-Policy` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var corp = require('gina').plugins.Corp({ value: 'cross-origin' });
 * app.use(corp);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="same-origin"] — one of "same-origin",
 *                                                 "same-site",
 *                                                 "cross-origin"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of the three W3C HTML spec tokens
 */
function Corp(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaCorp(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
Corp._HEADER_NAME             = HEADER_NAME;
Corp._VALID_VALUES            = VALID_VALUES;
Corp._DEFAULT_VALUE           = DEFAULT_VALUE;
Corp._resolveSettingsDefaults = resolveSettingsDefaults;
Corp._mergeOptions            = mergeOptions;
Corp._resolveValue            = resolveValue;

module.exports = Corp;
