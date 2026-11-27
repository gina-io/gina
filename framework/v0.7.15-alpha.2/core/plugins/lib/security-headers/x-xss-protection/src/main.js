/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-XSS-Protection plugin (#HDR10) — emits the literal header
 * `X-XSS-Protection: 0` on every response, DISABLING Chrome's legacy
 * XSS auditor (which had its own vulnerabilities — disabling is the
 * modern recommendation).
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp           = require('gina');
 *     var xXssProtection  = require('gina').plugins.XXssProtection();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xXssProtection);
 *         event.emit('complete', app);
 *     });
 *
 * **The value `0` is deliberate — not a typo**. Chrome's XSS auditor
 * (the feature this header controls) had its own vulnerabilities that
 * allowed cross-site information disclosure; modern security guidance
 * is to DISABLE the auditor entirely rather than rely on it. The MDN
 * reference is explicit:
 *
 *     https://developer.mozilla.org/docs/Web/HTTP/Headers/X-XSS-Protection
 *
 * Browser status in 2026:
 *
 *   - Chrome dropped the XSS auditor entirely in v78 (2019).
 *   - Edge follows Chrome.
 *   - Firefox never implemented it.
 *   - Safari never implemented it.
 *   - IE11 honoured it but is end-of-life.
 *
 * The header is therefore effectively a no-op in modern browsers, but
 * helmet ships it for defense-in-depth against the vanishing edge case
 * of a legacy Chrome client still running pre-v78 — and to match what
 * security scanners expect to see. helmet-parity narrative.
 *
 * Takes no options — registering opts in; not registering opts out.
 * Mirrors helmet's no-opts shape (and the #HDR1 XContentTypeOptions
 * plugin shape).
 *
 * @module plugins/security-headers/x-xss-protection
 */

var HEADER_NAME  = 'x-xss-protection';
var HEADER_VALUE = '0';


/**
 * Read the active bundle's `settings.json > xXssProtection.*` block
 * and return the merged framework defaults.
 *
 * No tunable options today — the header value is fixed to `0` per the
 * MDN recommendation. The settings block is reserved for future fields
 * (e.g. per-route opt-out); reading + passing through pluginConf
 * preserves the shape of sibling header plugins so a future field
 * addition does not need an API break.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `XXssProtection()` invoked at module-require time, before
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
            pluginConf   = settings.xXssProtection || {};
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
 * `X-XSS-Protection: 0` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xXssProtection = require('gina').plugins.XXssProtection();
 * app.use(xXssProtection);
 *
 * @param   {object} [opts] — reserved for future use; ignored today
 * @returns {function} — express middleware `(req, res, next) => void`
 */
function XXssProtection(opts) {
    var defaults = resolveSettingsDefaults();
    mergeOptions(opts, defaults);

    return function ginaXXssProtection(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, HEADER_VALUE);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XXssProtection._HEADER_NAME             = HEADER_NAME;
XXssProtection._HEADER_VALUE            = HEADER_VALUE;
XXssProtection._resolveSettingsDefaults = resolveSettingsDefaults;
XXssProtection._mergeOptions            = mergeOptions;

module.exports = XXssProtection;
