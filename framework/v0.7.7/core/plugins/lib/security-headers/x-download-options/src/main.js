/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-Download-Options plugin (#HDR11) — emits the literal header
 * `X-Download-Options: noopen` on every response, preventing
 * Internet Explorer 8+ from opening downloads in the site's security
 * context.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp             = require('gina');
 *     var xDownloadOptions  = require('gina').plugins.XDownloadOptions();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xDownloadOptions);
 *         event.emit('complete', app);
 *     });
 *
 * **IE-legacy header.** The vulnerability shape: in old IE versions,
 * the "Open" button on a download dialog opened the file in the
 * security context of the SITE that served it, rather than the local
 * filesystem. An attacker could trick a user into "opening" a
 * malicious HTML file from a trusted site, and the resulting page
 * would inherit the site's origin — XSS-equivalent. `noopen` tells
 * IE to remove the "Open" button entirely, forcing the user to "Save"
 * the download before viewing it.
 *
 * Modern browser status:
 *
 *   - Chrome, Edge, Firefox, Safari — all ignore the header silently.
 *   - IE10 / IE11 honour it; both are end-of-life as of June 2022.
 *
 * The header is therefore effectively a no-op in 2026, but helmet
 * ships it for defense-in-depth against the vanishingly-rare IE11
 * holdout (enterprise legacy intranet, etc.). helmet-parity narrative.
 *
 * Takes no options — registering opts in; not registering opts out.
 * Mirrors helmet's no-opts shape (and the #HDR1 XContentTypeOptions
 * / #HDR10 XXssProtection plugin shape).
 *
 * Reference:
 * https://learn.microsoft.com/previous-versions/windows/internet-explorer/ie-developer/compatibility/jj542450(v=vs.85)
 *
 * @module plugins/security-headers/x-download-options
 */

var HEADER_NAME  = 'x-download-options';
var HEADER_VALUE = 'noopen';


/**
 * Read the active bundle's `settings.json > xDownloadOptions.*` block
 * and return the merged framework defaults.
 *
 * No tunable options today — the header value is fixed to `noopen`
 * per the MSDN spec. The settings block is reserved for future fields
 * (e.g. per-route opt-out); reading + passing through pluginConf
 * preserves the shape of sibling header plugins so a future field
 * addition does not need an API break.
 *
 * Falls back to an empty object when the bundle context is not ready
 * yet (e.g. `XDownloadOptions()` invoked at module-require time, before
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
            pluginConf   = settings.xDownloadOptions || {};
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
 * Return an express-compatible middleware that sets the
 * `X-Download-Options: noopen` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xDownloadOptions = require('gina').plugins.XDownloadOptions();
 * app.use(xDownloadOptions);
 *
 * @param   {object} [opts] — reserved for future use; ignored today
 * @returns {function} — express middleware `(req, res, next) => void`
 */
function XDownloadOptions(opts) {
    var defaults = resolveSettingsDefaults();
    mergeOptions(opts, defaults);

    return function ginaXDownloadOptions(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, HEADER_VALUE);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XDownloadOptions._HEADER_NAME             = HEADER_NAME;
XDownloadOptions._HEADER_VALUE            = HEADER_VALUE;
XDownloadOptions._resolveSettingsDefaults = resolveSettingsDefaults;
XDownloadOptions._mergeOptions            = mergeOptions;

module.exports = XDownloadOptions;
