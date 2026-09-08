/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-Frame-Options plugin (#HDR2) — emits the `X-Frame-Options`
 * response header on every response to defend against clickjacking by
 * controlling whether the page may be rendered inside a `<frame>`,
 * `<iframe>`, `<embed>` or `<object>`.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp         = require('gina');
 *     var xFrameOptions = require('gina').plugins.XFrameOptions();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xFrameOptions);
 *         event.emit('complete', app);
 *     });
 *
 * Two valid values per RFC 7034:
 *
 *   - `DENY`       — page may never be framed, even by same-origin pages.
 *   - `SAMEORIGIN` — page may be framed only by same-origin pages (default).
 *
 * The legacy `ALLOW-FROM <uri>` value is rejected at factory call time.
 * Modern browsers ignore it (Chrome / Edge / Safari never supported it,
 * Firefox dropped it in 70); `Content-Security-Policy: frame-ancestors`
 * is the modern replacement that does work cross-browser.
 *
 * @module plugins/security-headers/x-frame-options
 */

var HEADER_NAME    = 'x-frame-options';
var VALID_VALUES   = ['DENY', 'SAMEORIGIN'];
var DEFAULT_VALUE  = 'SAMEORIGIN';


/**
 * Read the active bundle's `settings.json > xFrameOptions.*` block and
 * return the merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `XFrameOptions()` invoked at module-require time, before
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
            pluginConf   = settings.xFrameOptions || {};
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
 * Validate the resolved `value` and return it normalised to uppercase.
 *
 * Mirrors the #CSRF1 SameSite=None+Secure invariant and the planned
 * #HDR4 preload-list invariant — fast-fail at factory call time so the
 * bundle won't start with a misconfigured header. The legacy
 * `ALLOW-FROM <uri>` value gets its own dedicated error pointing users
 * at the modern CSP `frame-ancestors` replacement.
 *
 * @param {string|undefined} value
 * @returns {string}
 * @throws  {Error} when value is not `DENY` or `SAMEORIGIN`
 * @inner
 * @private
 */
function resolveValue(value) {
    if (typeof value === 'undefined' || value === null || value === '') {
        return DEFAULT_VALUE;
    }
    if (typeof value !== 'string') {
        throw new Error(
            '[gina.plugins.XFrameOptions] value must be a string ("DENY" or '
            + '"SAMEORIGIN"); received ' + typeof value + '.'
        );
    }
    var upper = value.toUpperCase();
    if (/^ALLOW-FROM\b/.test(upper)) {
        throw new Error(
            '[gina.plugins.XFrameOptions] the legacy "ALLOW-FROM <uri>" value '
            + 'is no longer supported by modern browsers (Chrome / Edge / Safari '
            + 'never honoured it, Firefox dropped it in 70). Use '
            + '`Content-Security-Policy: frame-ancestors <source-list>` instead '
            + '— see https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Security-Policy/frame-ancestors'
        );
    }
    if (VALID_VALUES.indexOf(upper) === -1) {
        throw new Error(
            '[gina.plugins.XFrameOptions] invalid value "' + value + '"; '
            + 'expected "DENY" or "SAMEORIGIN" per RFC 7034.'
        );
    }
    return upper;
}


/**
 * Return an express-compatible middleware that sets the
 * `X-Frame-Options` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xFrameOptions = require('gina').plugins.XFrameOptions({ value: 'DENY' });
 * app.use(xFrameOptions);
 *
 * @param   {object} [opts]
 * @param   {string} [opts.value="SAMEORIGIN"] — "DENY" or "SAMEORIGIN"
 * @returns {function} — express middleware `(req, res, next) => void`
 * @throws  {Error} when `value` is not "DENY" or "SAMEORIGIN", or is the
 *                  legacy `ALLOW-FROM <uri>` (rejected explicitly)
 */
function XFrameOptions(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);
    var value    = resolveValue(merged.value);

    return function ginaXFrameOptions(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, value);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XFrameOptions._HEADER_NAME             = HEADER_NAME;
XFrameOptions._VALID_VALUES            = VALID_VALUES;
XFrameOptions._DEFAULT_VALUE           = DEFAULT_VALUE;
XFrameOptions._resolveSettingsDefaults = resolveSettingsDefaults;
XFrameOptions._mergeOptions            = mergeOptions;
XFrameOptions._resolveValue            = resolveValue;

module.exports = XFrameOptions;
