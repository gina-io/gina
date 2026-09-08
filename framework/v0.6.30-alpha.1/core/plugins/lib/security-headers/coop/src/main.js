/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Cross-Origin-Opener-Policy plugin (#HDR13) — emits the
 * `Cross-Origin-Opener-Policy` (COOP) response header on every response
 * to control how the page's browsing context relates to popups and
 * cross-origin opener references on top-level navigation.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp = require('gina');
 *     var coop  = require('gina').plugins.Coop();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(coop);
 *         event.emit('complete', app);
 *     });
 *
 * Four valid values per the W3C HTML spec
 * (https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-opener-policies):
 *
 *   - `same-origin`              — default; full isolation. Top-level
 *                                  navigation severs `window.opener`
 *                                  for any cross-origin opener.
 *                                  Required (paired with
 *                                  `COEP: require-corp`) to enable
 *                                  `SharedArrayBuffer` and high-resolution
 *                                  `performance.now()`.
 *   - `same-origin-allow-popups` — keeps `window.opener` for same-origin
 *                                  popups; cross-origin popups still
 *                                  get `null` opener. Compat-friendly
 *                                  for OAuth popup flows.
 *   - `noopener-allow-popups`    — popups open normally but their
 *                                  `window.opener` is forced to `null`
 *                                  even for same-origin popups. Spec
 *                                  addition (Chrome 119+, Firefox 131+).
 *                                  Useful for OAuth flows that want
 *                                  isolation without breaking the
 *                                  popup window itself.
 *   - `unsafe-none`              — browser default; no isolation.
 *                                  Equivalent to not setting the header.
 *
 * Tokens are case-insensitive at this layer — values are normalised to
 * lowercase before validation and emission (mirrors the #HDR3 / #HDR6
 * normalisation). Unknown tokens throw at factory call time to fail fast.
 *
 * **Tradeoff with the `same-origin` default**: the default fully
 * isolates `window.opener` references across top-level navigation,
 * which is the safest posture and is required for the
 * `SharedArrayBuffer` combo when paired with `Coep({ value: 'require-corp' })`.
 * But it BREAKS legitimate OAuth / SSO popup flows where the popup needs
 * to call back into the opener via `window.opener.postMessage(...)` — the
 * popup gets a `null` opener. Bundles running such flows should pick
 * `same-origin-allow-popups` (keeps opener for same-origin popups only)
 * or `noopener-allow-popups` (severs opener but keeps the popup window
 * open, useful for one-way notifications back to the opener via
 * `BroadcastChannel` or `localStorage`).
 *
 * @module plugins/security-headers/coop
 */

var HEADER_NAME    = 'cross-origin-opener-policy';
var VALID_VALUES   = [
    'same-origin',
    'same-origin-allow-popups',
    'noopener-allow-popups',
    'unsafe-none'
];
var DEFAULT_VALUE  = 'same-origin';


/**
 * Read the active bundle's `settings.json > coop.*` block and return the
 * merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `Coop()` invoked at module-require time, before `onInitialize`).
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
            pluginConf   = settings.coop || {};
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
 * Mirrors the #HDR3 / #HDR6 throw-on-invalid pattern — fast-fail at
 * factory call time so the bundle won't start with a misconfigured
 * header.
 *
 * @param {string|undefined} value
 * @returns {string}
 * @throws  {Error} when value is not one of the four W3C HTML spec tokens
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.Coop] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.Coop] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(per the W3C HTML spec — '
            + 'https://html.spec.whatwg.org/multipage/browsers.html#cross-origin-opener-policies).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `Cross-Origin-Opener-Policy` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var coop = require('gina').plugins.Coop({ value: 'same-origin-allow-popups' });
 * app.use(coop);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="same-origin"] — one of "same-origin",
 *                                                "same-origin-allow-popups",
 *                                                "noopener-allow-popups",
 *                                                "unsafe-none"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of the four W3C HTML spec tokens
 */
function Coop(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaCoop(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
Coop._HEADER_NAME             = HEADER_NAME;
Coop._VALID_VALUES            = VALID_VALUES;
Coop._DEFAULT_VALUE           = DEFAULT_VALUE;
Coop._resolveSettingsDefaults = resolveSettingsDefaults;
Coop._mergeOptions            = mergeOptions;
Coop._resolveValue            = resolveValue;

module.exports = Coop;
