/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Security Headers combined wrapper plugin (#HDR15) — composes the
 * full #HDR1 / #HDR2 / #HDR3 / #HDR4 / #HDR5 / #HDR6 / #HDR7 /
 * #HDR8 / #HDR9 / #HDR10 / #HDR11 / #HDR12 / #HDR13 / #HDR14 set
 * into a single mount point with one `settings.json` block.
 *
 * Bundles adopt it inside the bundle bootstrap:
 *
 *     var myapp           = require('gina');
 *     var securityHeaders = require('gina').plugins.SecurityHeaders();
 *
 *     myapp.onInitialize(function(event, app) {
 *         app.use(securityHeaders);
 *         event.emit('complete', app);
 *     });
 *
 * **Batteries-included safe set**: calling `SecurityHeaders()` with no
 * opts mounts the twelve non-footgun plugins with their per-plugin
 * defaults — `XContentTypeOptions` (HDR1), `XFrameOptions` (HDR2),
 * `ReferrerPolicy` (HDR3), `Hsts` (HDR4), `OriginAgentCluster` (HDR7),
 * `HidePoweredBy` (HDR8), `XDnsPrefetchControl` (HDR9),
 * `XXssProtection` (HDR10), `XDownloadOptions` (HDR11),
 * `XPermittedCrossDomainPolicies` (HDR12), `Coop` (HDR13),
 * `Corp` (HDR14). The two opt-in-only plugins — `Csp` (HDR5) and
 * `Coep` (HDR6) — are NOT mounted by default because they have known
 * footguns:
 *
 *   - CSP throws on missing directives (no sensible cross-bundle
 *     default; every bundle has its own resource graph).
 *   - COEP's default `require-corp` BREAKS pages that load cross-
 *     origin resources without matching CORP / CORS headers.
 *
 * Bundles wanting CSP or COEP must opt in explicitly via the
 * sub-config (`csp: { directives: {...} }`, `coep: true` or
 * `coep: { value: '...' }`).
 *
 * Per-sub-config explicit opt-out via `<key>: false` (or `null`) skips
 * that plugin even when it's in the safe set. e.g.
 * `SecurityHeaders({ hsts: false })` mounts the other six safe-set
 * plugins but skips HSTS — useful for HTTP-only bundles where HSTS
 * would be a no-op.
 *
 * Individual plugins remain mountable independently as the power-user
 * escape hatch — `gina.plugins.Csp({...})`, `gina.plugins.Hsts({...})`
 * etc. continue to work, and the idempotent first-writer-wins pattern
 * means stacking the wrapper with an upstream individual mount
 * produces no double-emit.
 *
 * **Mirrors helmet's `helmet()` combined wrapper shape** — one mount,
 * per-header sub-configs, sub-config `= false` opts out. The
 * helmet-parity choice — bundles migrating from helmet should find
 * the API familiar.
 *
 * Closes Phase 2 of the gina security-headers track; extended with
 * the Phase 1.5 helmet-parity plugins (HDR8-12) post-Phase-1.5-closure.
 *
 * @module plugins/security-headers
 */

var XContentTypeOptions             = require('../x-content-type-options/src/main.js');
var XFrameOptions                   = require('../x-frame-options/src/main.js');
var ReferrerPolicy                  = require('../referrer-policy/src/main.js');
var Hsts                            = require('../hsts/src/main.js');
var Csp                             = require('../csp/src/main.js');
var Coep                            = require('../coep/src/main.js');
var OriginAgentCluster              = require('../origin-agent-cluster/src/main.js');
var HidePoweredBy                   = require('../hide-powered-by/src/main.js');
var XDnsPrefetchControl             = require('../x-dns-prefetch-control/src/main.js');
var XXssProtection                  = require('../x-xss-protection/src/main.js');
var XDownloadOptions                = require('../x-download-options/src/main.js');
var XPermittedCrossDomainPolicies   = require('../x-permitted-cross-domain-policies/src/main.js');
var Coop                            = require('../coop/src/main.js');
var Corp                            = require('../corp/src/main.js');

/**
 * Sub-plugin registry. Order = emission order in the composed chain
 * (matters for first-writer-wins idempotency when stacking with
 * upstream individual mounts).
 *
 *   - key          : the sub-config key the wrapper reads on opts +
 *                    settings.json > securityHeaders.<key>.
 *   - factory      : per-plugin factory (re-uses the standalone plugin).
 *   - marker       : the #HDR<N> tag for traceability.
 *   - safeDefault  : true if the plugin is mounted with defaults when
 *                    its sub-config key is missing; false if it's
 *                    opt-in-only (must be explicitly named).
 *
 * @constant
 * @type {Array<object>}
 */
var SUB_PLUGINS = [
    { key: 'xContentTypeOptions',          factory: XContentTypeOptions,           marker: '#HDR1',  safeDefault: true  },
    { key: 'xFrameOptions',                factory: XFrameOptions,                 marker: '#HDR2',  safeDefault: true  },
    { key: 'referrerPolicy',               factory: ReferrerPolicy,                marker: '#HDR3',  safeDefault: true  },
    { key: 'hsts',                         factory: Hsts,                          marker: '#HDR4',  safeDefault: true  },
    { key: 'csp',                          factory: Csp,                           marker: '#HDR5',  safeDefault: false },
    { key: 'coep',                         factory: Coep,                          marker: '#HDR6',  safeDefault: false },
    { key: 'originAgentCluster',           factory: OriginAgentCluster,            marker: '#HDR7',  safeDefault: true  },
    { key: 'hidePoweredBy',                factory: HidePoweredBy,                 marker: '#HDR8',  safeDefault: true  },
    { key: 'xDnsPrefetchControl',          factory: XDnsPrefetchControl,           marker: '#HDR9',  safeDefault: true  },
    { key: 'xXssProtection',               factory: XXssProtection,                marker: '#HDR10', safeDefault: true  },
    { key: 'xDownloadOptions',             factory: XDownloadOptions,              marker: '#HDR11', safeDefault: true  },
    { key: 'xPermittedCrossDomainPolicies',factory: XPermittedCrossDomainPolicies, marker: '#HDR12', safeDefault: true  },
    { key: 'coop',                         factory: Coop,                          marker: '#HDR13', safeDefault: true  },
    { key: 'corp',                         factory: Corp,                          marker: '#HDR14', safeDefault: true  }
];


/**
 * Read the active bundle's `settings.json > securityHeaders.*` block
 * and return the merged framework defaults.
 *
 * Falls back to an empty object when the bundle context is not ready
 * yet (e.g. `SecurityHeaders()` invoked at module-require time, before
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
            pluginConf   = settings.securityHeaders || {};
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
 * Caller-supplied values always win (`hasOwnProperty`-guarded). Shallow
 * — sub-config objects are replaced wholesale, not key-by-key merged.
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
 * Decide per sub-plugin: mount it (return opts for the factory) or
 * skip it (return null).
 *
 * Decision rules:
 *   - sub-config === false or null    → skip (explicit opt-out)
 *   - sub-config === true             → mount with defaults (boolean shorthand)
 *   - sub-config === object           → mount with these opts
 *   - sub-config === undefined and safeDefault === true  → mount with {}
 *   - sub-config === undefined and safeDefault === false → skip
 *   - sub-config === any other type   → throws (invalid shape)
 *
 * @param {object|boolean|null|undefined} subConfig
 * @param {object}                        sub
 * @returns {object|null}
 * @throws  {Error}
 * @inner
 * @private
 */
function resolveSubConfig(subConfig, sub) {
    if (subConfig === false || subConfig === null) {
        return null;
    }
    if (typeof subConfig === 'undefined') {
        return sub.safeDefault ? {} : null;
    }
    if (subConfig === true) {
        return {};
    }
    if (typeof subConfig === 'object' && !Array.isArray(subConfig)) {
        return subConfig;
    }
    throw new Error(
        '[gina.plugins.SecurityHeaders] sub-config for "' + sub.key + '" must be '
        + 'false/null (opt-out), true (mount with defaults), or an object '
        + '(sub-config opts); received ' + typeof subConfig + '.'
    );
}


/**
 * Run an Express-style middleware chain in sequence. Each middleware
 * is called with `(req, res, next)`; the chain advances when a
 * middleware calls `next()` (or `next(err)` to short-circuit to the
 * `done` callback).
 *
 * @param {function[]} mws
 * @param {object}     req
 * @param {object}     res
 * @param {function}   done
 * @inner
 * @private
 */
function runChain(mws, req, res, done) {
    var i = 0;
    var run = function(err) {
        if (err) return done(err);
        if (i >= mws.length) return done();
        var mw = mws[i++];
        try {
            mw(req, res, run);
        } catch (e) {
            done(e);
        }
    };
    run();
}


/**
 * Return an express-compatible middleware that composes the configured
 * security-header sub-plugins.
 *
 * Batteries-included: with no opts, mounts HDR1/2/3/4/7/8/9/10/11/12/
 * 13/14 (12 plugins) with their per-plugin defaults. CSP (#HDR5) and
 * COEP (#HDR6) are opt-in only — pass `csp: { directives: {...} }` or
 * `coep: true` to mount.
 *
 * @example <caption>Default (safe set — 12 plugins)</caption>
 * var securityHeaders = require('gina').plugins.SecurityHeaders();
 * app.use(securityHeaders);
 *
 * @example <caption>With CSP and COEP opt-in</caption>
 * var securityHeaders = require('gina').plugins.SecurityHeaders({
 *     csp: {
 *         directives: {
 *             'default-src': ["'self'"],
 *             'script-src':  ["'self'"]
 *         }
 *     },
 *     coep: true  // require-corp default
 * });
 * app.use(securityHeaders);
 *
 * @example <caption>Opt out of HSTS for an HTTP-only bundle</caption>
 * var securityHeaders = require('gina').plugins.SecurityHeaders({ hsts: false });
 * app.use(securityHeaders);
 *
 * @example <caption>Opt out of the Phase 1.5 legacy headers</caption>
 * var securityHeaders = require('gina').plugins.SecurityHeaders({
 *     hidePoweredBy:                  false,
 *     xDnsPrefetchControl:            false,
 *     xXssProtection:                 false,
 *     xDownloadOptions:               false,
 *     xPermittedCrossDomainPolicies:  false
 * });
 * app.use(securityHeaders);
 *
 * @param   {object}          [opts]
 * @param   {boolean|object}  [opts.xContentTypeOptions=true]            — HDR1; defaults to mount.
 * @param   {boolean|object}  [opts.xFrameOptions=true]                  — HDR2; defaults to mount with SAMEORIGIN.
 * @param   {boolean|object}  [opts.referrerPolicy=true]                 — HDR3; defaults to mount with strict-origin-when-cross-origin.
 * @param   {boolean|object}  [opts.hsts=true]                           — HDR4; defaults to mount with 180-day maxAge.
 * @param   {boolean|object}  [opts.csp]                                 — HDR5; opt-in only. Throws if `{}` (no directives) — directives required.
 * @param   {boolean|object}  [opts.coep]                                — HDR6; opt-in only. Default `require-corp` BREAKS embeds without CORP.
 * @param   {boolean|object}  [opts.originAgentCluster=true]             — HDR7; defaults to mount.
 * @param   {boolean|object}  [opts.hidePoweredBy=true]                  — HDR8; defaults to mount the express middleware (Express engine). For Isaac engine bundles, additionally set `settings.json > server.hidePoweredBy: true` to gate the `_setPoweredByHeader()` helper at every writeHead/setHeader emit site.
 * @param   {boolean|object}  [opts.xDnsPrefetchControl=true]            — HDR9; defaults to mount with `{ value: 'off' }`.
 * @param   {boolean|object}  [opts.xXssProtection=true]                 — HDR10; defaults to mount (emits literal `0` to DISABLE Chrome legacy auditor).
 * @param   {boolean|object}  [opts.xDownloadOptions=true]               — HDR11; defaults to mount (emits `noopen`).
 * @param   {boolean|object}  [opts.xPermittedCrossDomainPolicies=true]  — HDR12; defaults to mount with `{ value: 'none' }`.
 * @param   {boolean|object}  [opts.coop=true]                           — HDR13; defaults to mount with same-origin.
 * @param   {boolean|object}  [opts.corp=true]                           — HDR14; defaults to mount with same-origin.
 * @returns {function}                                                    — express middleware `(req, res, next) => void`
 * @throws  {Error} when a sub-plugin factory throws (invalid config —
 *                  e.g. CSP without directives, COEP with unknown
 *                  token, HSTS with preload-list invariant violation).
 */
function SecurityHeaders(opts) {
    var defaults = resolveSettingsDefaults();
    var merged   = mergeOptions(opts, defaults);

    var middlewares = [];

    for (var i = 0; i < SUB_PLUGINS.length; i++) {
        var sub       = SUB_PLUGINS[i];
        var subConfig = resolveSubConfig(merged[sub.key], sub);
        if (subConfig === null) continue;
        // Per-plugin factory may throw on invalid config (e.g. CSP without
        // directives, COEP with unknown token). Surface those throws to
        // the wrapper caller at factory call time — matches standalone
        // behavior, fail-fast at bundle start.
        middlewares.push(sub.factory(subConfig));
    }

    return function ginaSecurityHeaders(req, res, next) {
        runChain(middlewares, req, res, next);
    };
}


// Exposed for unit testing. Do not rely on these in application code.
SecurityHeaders._SUB_PLUGINS             = SUB_PLUGINS;
SecurityHeaders._resolveSettingsDefaults = resolveSettingsDefaults;
SecurityHeaders._mergeOptions            = mergeOptions;
SecurityHeaders._resolveSubConfig        = resolveSubConfig;
SecurityHeaders._runChain                = runChain;

module.exports = SecurityHeaders;
