/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * X-Content-Type-Options plugin (#HDR1) — emits the
 * `X-Content-Type-Options: nosniff` response header on every response.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp               = require('gina');
 *     var xContentTypeOptions = require('gina').plugins.XContentTypeOptions();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(xContentTypeOptions);
 *         event.emit('complete', app);
 *     });
 *
 * The header instructs browsers to honour the declared `Content-Type` of a
 * response strictly, blocking MIME-sniffing attacks where a `text/plain`
 * response whose body starts with `<script>` could be upgraded to HTML
 * and the script executed in the page's origin.
 *
 * Per RFC 7034 and the WHATWG Fetch Standard, `nosniff` is the only valid
 * value — there is no `enabled` flag in the configuration surface; register
 * the plugin to opt in, don't register to opt out.
 *
 * @module plugins/security-headers/x-content-type-options
 */

var HEADER_NAME  = 'x-content-type-options';
var HEADER_VALUE = 'nosniff';


/**
 * Read the active bundle's `settings.json > xContentTypeOptions.*` block
 * and return the merged framework defaults.
 *
 * No tunable options today — the header value is fixed to `nosniff` per
 * RFC 7034 / WHATWG Fetch Standard. The settings block is reserved for
 * future fields (e.g. per-route opt-out); reading + passing through
 * pluginConf preserves the shape of sibling header plugins so a future
 * field addition does not need an API break.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `XContentTypeOptions()` invoked at module-require time, before
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
            pluginConf   = settings.xContentTypeOptions || {};
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
 * No tunable options exist today, but the function preserves the shape
 * used by sibling header plugins so opts can be threaded through future
 * revisions without an API break.
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
 * `X-Content-Type-Options: nosniff` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var xContentTypeOptions = require('gina').plugins.XContentTypeOptions();
 * app.use(xContentTypeOptions);
 *
 * @param   {object} [opts] — reserved for future use; ignored today
 * @returns {function} — express middleware `(req, res, next) => void`
 */
function XContentTypeOptions(opts) {
    var defaults = resolveSettingsDefaults();
    mergeOptions(opts, defaults);

    return function ginaXContentTypeOptions(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, HEADER_VALUE);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
XContentTypeOptions._HEADER_NAME             = HEADER_NAME;
XContentTypeOptions._HEADER_VALUE            = HEADER_VALUE;
XContentTypeOptions._resolveSettingsDefaults = resolveSettingsDefaults;
XContentTypeOptions._mergeOptions            = mergeOptions;

module.exports = XContentTypeOptions;
