/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-DNS-Prefetch-Control plugin (#HDR9) — emits the
 * `X-DNS-Prefetch-Control` response header on every response,
 * controlling whether the browser proactively resolves DNS for links,
 * images, CSS, and JavaScript referenced by the page.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp                = require('gina');
 *     var xDnsPrefetchControl  = require('gina').plugins.XDnsPrefetchControl();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xDnsPrefetchControl);
 *         event.emit('complete', app);
 *     });
 *
 * Two valid values:
 *
 *   - `off` — default. Disables DNS prefetching. The privacy-respecting
 *             choice — the browser does not leak intent to navigate by
 *             resolving DNS for links the user has not clicked.
 *   - `on`  — enables DNS prefetching. Faster perceived navigation but
 *             leaks the set of links/resources on the page to the DNS
 *             resolver (typically the user's ISP, but also any
 *             intermediate caching resolver).
 *
 * Marginal practical value in 2026 — modern Chrome / Firefox have
 * their own DNS-prefetch heuristics that mostly ignore the header. The
 * defense-in-depth justification + helmet-parity narrative are why this
 * ships. helmet's middleware uses `{ allow: boolean }` (true → "on",
 * false → "off"); gina uses `{ value: 'on' | 'off' }` matching the
 * existing single-token enum convention (HDR2 / HDR3 / HDR6 / HDR13 /
 * HDR14). The README documents the helmet-API mapping for migrators.
 *
 * Tokens are case-insensitive at this layer — values are normalised to
 * lowercase before validation and emission. Unknown tokens throw at
 * factory call time to fail fast.
 *
 * @module plugins/security-headers/x-dns-prefetch-control
 */

var HEADER_NAME    = 'x-dns-prefetch-control';
var VALID_VALUES   = ['on', 'off'];
var DEFAULT_VALUE  = 'off';


/**
 * Read the active bundle's `settings.json > xDnsPrefetchControl.*` block
 * and return the merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `XDnsPrefetchControl()` invoked at module-require time, before
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
            pluginConf   = settings.xDnsPrefetchControl || {};
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
 * @throws  {Error} when value is not one of "on" / "off"
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.XDnsPrefetchControl] value must be a string (one of '
            + VALID_VALUES.join(', ') + '); received ' + typeof value + '.'
        );
    }
    var lower = value.toLowerCase();
    if (VALID_VALUES.indexOf(lower) === -1) {
        throw new Error(
            '[gina.plugins.XDnsPrefetchControl] invalid value "' + value + '"; '
            + 'expected one of: ' + VALID_VALUES.join(', ') + ' '
            + '(see https://developer.mozilla.org/docs/Web/HTTP/Headers/X-DNS-Prefetch-Control).'
        );
    }
    return lower;
}


/**
 * Return an express-compatible middleware that sets the
 * `X-DNS-Prefetch-Control` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xDnsPrefetchControl = require('gina').plugins.XDnsPrefetchControl({ value: 'off' });
 * app.use(xDnsPrefetchControl);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="off"] — one of "on" or "off"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not one of "on" / "off"
 */
function XDnsPrefetchControl(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaXDnsPrefetchControl(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XDnsPrefetchControl._HEADER_NAME             = HEADER_NAME;
XDnsPrefetchControl._VALID_VALUES            = VALID_VALUES;
XDnsPrefetchControl._DEFAULT_VALUE           = DEFAULT_VALUE;
XDnsPrefetchControl._resolveSettingsDefaults = resolveSettingsDefaults;
XDnsPrefetchControl._mergeOptions            = mergeOptions;
XDnsPrefetchControl._resolveValue            = resolveValue;

module.exports = XDnsPrefetchControl;
