/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Origin-Agent-Cluster plugin (#HDR7) — emits the
 * `Origin-Agent-Cluster: ?1` response header on every response.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp              = require('gina');
 *     var originAgentCluster = require('gina').plugins.OriginAgentCluster();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(originAgentCluster);
 *         event.emit('complete', app);
 *     });
 *
 * The header is a Structured Field Value (RFC 8941) carrying a boolean —
 * `?1` requests origin-keyed agent clustering (each origin gets its own
 * agent), `?0` keeps the default site-keyed behaviour. This plugin sets
 * `?1` unconditionally per the helmet convention; the header is a hint,
 * not a guarantee, and browsers may decline.
 *
 * Why opt in: origin-keyed clustering gives the page a stronger isolation
 * boundary (cross-origin pages can no longer reach into each other's
 * documents via `document.domain` shenanigans), which mitigates one shape
 * of Spectre-class side-channel attack. The cost is small — same-site
 * cross-origin pages can no longer share `document.domain` to bypass
 * same-origin policy, but that pattern is rare in modern web apps.
 *
 * Per the Origin-Agent-Cluster spec (https://html.spec.whatwg.org/multipage/document-sequences.html#origin-keyed-agent-clusters),
 * `?1` is the only value worth sending — `?0` is the default and emitting
 * it would be a no-op. There is no `enabled` flag in the configuration
 * surface; register the plugin to opt in, don't register to opt out.
 *
 * @module plugins/security-headers/origin-agent-cluster
 */

var HEADER_NAME  = 'origin-agent-cluster';
var HEADER_VALUE = '?1';


/**
 * Read the active bundle's `settings.json > originAgentCluster.*` block
 * and return the merged framework defaults.
 *
 * No tunable options today — the header value is fixed to `?1`. The
 * settings block is reserved for future fields (e.g. per-route opt-out);
 * reading + passing through pluginConf preserves the shape of sibling
 * header plugins so a future field addition does not need an API break.
 *
 * Falls back to an empty object when the bundle context is not ready yet
 * (e.g. `OriginAgentCluster()` invoked at module-require time, before
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
            pluginConf   = settings.originAgentCluster || {};
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
 * `Origin-Agent-Cluster: ?1` response header.
 *
 * Idempotent — if the header is already set by an earlier middleware, the
 * existing value is preserved and `next()` is called immediately.
 *
 * @example
 * var originAgentCluster = require('gina').plugins.OriginAgentCluster();
 * app.use(originAgentCluster);
 *
 * @param   {object} [opts] — reserved for future use; ignored today
 * @returns {function} — express middleware `(req, res, next) => void`
 */
function OriginAgentCluster(opts) {
    var defaults = resolveSettingsDefaults();
    mergeOptions(opts, defaults);

    return function ginaOriginAgentCluster(req, res, next) {
        if (typeof res.getHeader === 'function' && res.getHeader(HEADER_NAME)) {
            return next();
        }
        res.setHeader(HEADER_NAME, HEADER_VALUE);
        next();
    };
}


// Exposed for unit testing. Do not rely on these in application code.
OriginAgentCluster._HEADER_NAME             = HEADER_NAME;
OriginAgentCluster._HEADER_VALUE            = HEADER_VALUE;
OriginAgentCluster._resolveSettingsDefaults = resolveSettingsDefaults;
OriginAgentCluster._mergeOptions            = mergeOptions;

module.exports = OriginAgentCluster;
