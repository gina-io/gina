'use strict';
/**
 * @module lib/security-headers-emitter
 * @description #OW1 — engine-agnostic security-header emission (OWASP A02).
 *
 * WHY THIS EXISTS AT THE FRAMEWORK LAYER, not as a mounted middleware.
 * The `#HDR1-14` plugins are express middleware, and gina's DEFAULT engine is
 * `isaac`, which never runs the express middleware chain for HTTP responses:
 * `server.use()` stores functions in `server._expressMiddlewares`, and the ONLY
 * consumer is the WebSocket session binder, which name-filters the chain down to
 * `session` / `ginaSessionAbsoluteTimeout` and runs it against an inert response
 * whose header methods are all no-ops (measured 2026-09-02). So scaffolding
 * `app.use(gina.plugins.SecurityHeaders())` would emit ZERO headers on the
 * default engine — security theatre. This module is the same shape as the
 * `#HDR8` hidePoweredBy gate, which was built framework-side for exactly this
 * reason and is the established precedent.
 *
 * THE DEFAULT SET IS NARROWER THAN THE ORCHESTRATOR'S "SAFE SET", DELIBERATELY.
 * The orchestrator's 12-plugin safe set is safe to MOUNT deliberately; it is not
 * all safe to DEFAULT ON for every existing bundle. Four are opt-in here, each
 * with a named breakage rather than a guess:
 *   - `corp`  — MEASURED conflict: gina's own `/_gina/*` endpoints emit
 *               `access-control-allow-origin: *` (metrics, health, SSE; the
 *               Inspector's cross-origin GET/SSE channels are a documented
 *               design), and CORP blocks cross-origin LOADING regardless of
 *               CORS. See the `/_gina/*` exemption below.
 *   - `hsts`  — emits regardless of transport (documented spec deviation), so
 *               enabling it commits every https consumer's browsers to 180 days
 *               without them asking.
 *   - `coop`  — severs `window.opener`; breaks OAuth/payment popup flows.
 *   - `xFrameOptions` — breaks a consumer who deliberately embeds their app
 *               cross-origin. (gina itself uses no iframes — measured — so the
 *               risk is consumer-facing only; this is the weakest of the four
 *               and the cheapest to enable.)
 *
 * PRECEDENCE: first-writer-wins. Any header already present on the response is
 * left alone, so an explicitly mounted plugin, an `env.json`
 * `server.response.header` entry, or an upstream proxy always beats the
 * framework default. This mirrors the plugins' own idempotent contract.
 *
 * @example
 * // core/server.js (engine-agnostic, setHeader-based)
 * var secHeaders = require('lib/security-headers-emitter');
 * secHeaders.applyToResponse(conf.server.securityHeaders, request, response);
 *
 * // core/server.isaac.js (writeHead-based, header OBJECT)
 * headers = secHeaders.applyToHeaders(options.securityHeaders, request, headers);
 */

/**
 * The framework-emittable header set, with the values read from each `#HDR`
 * plugin's own `HEADER_VALUE` / `DEFAULT_VALUE` (measured, never invented) so
 * the framework default and the mounted plugin agree byte-for-byte.
 *
 * `onByDefault: false` entries are Tier B — available, opt-in per the rationale
 * in the module docblock.
 *
 * @constant
 * @type {Array<{key: string, header: string, value: string, onByDefault: boolean, ginaExempt: boolean}>}
 * @private
 */
var HEADERS = [
    // ── Tier A — on by default: cannot break a working application ──────────
    { key: 'xContentTypeOptions',          header: 'x-content-type-options',            value: 'nosniff',                          onByDefault: true,  ginaExempt: false },
    { key: 'xDownloadOptions',             header: 'x-download-options',                value: 'noopen',                           onByDefault: true,  ginaExempt: false },
    { key: 'xPermittedCrossDomainPolicies',header: 'x-permitted-cross-domain-policies', value: 'none',                             onByDefault: true,  ginaExempt: false },
    { key: 'xXssProtection',               header: 'x-xss-protection',                  value: '0',                                onByDefault: true,  ginaExempt: false },
    { key: 'referrerPolicy',               header: 'referrer-policy',                   value: 'strict-origin-when-cross-origin',  onByDefault: true,  ginaExempt: false },
    { key: 'xDnsPrefetchControl',          header: 'x-dns-prefetch-control',            value: 'off',                              onByDefault: true,  ginaExempt: false },
    { key: 'originAgentCluster',           header: 'origin-agent-cluster',              value: '?1',                               onByDefault: true,  ginaExempt: false },

    // ── Tier B — opt-in: each can break a legitimate deployment ─────────────
    { key: 'xFrameOptions',                header: 'x-frame-options',                   value: 'SAMEORIGIN',                       onByDefault: false, ginaExempt: false },
    // hsts value = the Hsts plugin's own default composition (max-age only —
    // DEFAULT_MAX_AGE, no includeSubDomains/preload, which stay plugin/proxy
    // territory; first-writer-wins defers to either). Parity is asserted in
    // the tests against the plugin's exported builder, never retyped.
    { key: 'hsts',                         header: 'strict-transport-security',         value: 'max-age=15552000',                 onByDefault: false, ginaExempt: false },
    { key: 'coop',                         header: 'cross-origin-opener-policy',        value: 'same-origin',                      onByDefault: false, ginaExempt: true  },
    // ginaExempt — see applyTo*: never applied to /_gina/*, which is
    // deliberately cross-origin.
    { key: 'corp',                         header: 'cross-origin-resource-policy',      value: 'same-origin',                      onByDefault: false, ginaExempt: true  }
];

/**
 * `/_gina/*` is the framework's own control/observability surface and is
 * DELIBERATELY cross-origin (`access-control-allow-origin: *` at the metrics,
 * health and SSE endpoints; the Inspector's cross-origin GET/SSE channels are a
 * documented design). A cross-origin-isolating header applied there would break
 * gina's own endpoints even for a consumer who opted in knowingly — so the
 * `ginaExempt` entries are skipped on that prefix regardless of configuration.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var GINA_PREFIX = /^\/_gina\//;

/**
 * Decide whether a given entry should be emitted for this request.
 *
 * @param {object}  entry  - a HEADERS row
 * @param {object}  cfg    - the resolved `server.securityHeaders` config
 * @param {string}  url    - `request.url` (may be undefined)
 * @returns {boolean} true when the header should be written
 * @private
 */
var shouldEmit = function(entry, cfg, url) {
    var setting = cfg[entry.key];
    var on = ( typeof(setting) == 'undefined' ) ? entry.onByDefault : (setting === true);
    if ( !on ) { return false }
    if ( entry.ginaExempt && typeof(url) == 'string' && GINA_PREFIX.test(url) ) { return false }
    return true
};

/**
 * Normalise the config block. Absent / non-object ⇒ defaults; `enabled: false`
 * ⇒ the whole emitter is off (one key to restore pre-0.6.23 behaviour).
 *
 * @param {object|undefined} raw - `settings.json > server.securityHeaders`
 * @returns {object|null} the config, or null when disabled entirely
 * @private
 */
var resolveConfig = function(raw) {
    var cfg = ( raw && typeof(raw) == 'object' ) ? raw : {};
    if ( cfg.enabled === false ) { return null }
    return cfg
};

/**
 * Apply to a `setHeader`-based response (the engine-agnostic `core/server.js`
 * path — routed responses, static serves, framework error pages, both engines).
 *
 * First-writer-wins: an already-present header is never overwritten.
 *
 * @param {object|undefined} raw      - `server.securityHeaders` config
 * @param {object}           request  - the incoming request (read for `.url`)
 * @param {object}           response - the outgoing response
 * @returns {void}
 * @example
 * applyToResponse(conf.server.securityHeaders, request, response);
 */
var applyToResponse = function(raw, request, response) {
    var cfg = resolveConfig(raw);
    if ( !cfg || !response || typeof(response.setHeader) != 'function' ) { return }
    if ( response.headersSent ) { return }

    var url = ( request && typeof(request.url) == 'string' ) ? request.url : undefined;

    for (var i = 0, len = HEADERS.length; i < len; ++i) {
        var entry = HEADERS[i];
        if ( !shouldEmit(entry, cfg, url) ) { continue }
        // first-writer-wins — a mounted plugin, an env.json
        // `server.response.header` entry or an upstream proxy always wins.
        if ( typeof(response.getHeader) == 'function' && response.getHeader(entry.header) ) { continue }
        response.setHeader(entry.header, entry.value);
    }
};

/**
 * Apply to a plain header OBJECT (the isaac `writeHead` path — 31 emit sites
 * funnel through `_setPoweredByHeader`, which `writeHead` commits directly,
 * bypassing `setHeader` entirely).
 *
 * @param {object|undefined} raw     - `server.securityHeaders` config
 * @param {object}           request - the incoming request (read for `.url`)
 * @param {object}           headers - the header map about to be written
 * @returns {object} the same map, mutated and returned for chaining
 * @example
 * headers = applyToHeaders(options.securityHeaders, request, headers);
 */
var applyToHeaders = function(raw, request, headers) {
    var cfg = resolveConfig(raw);
    if ( !cfg || !headers || typeof(headers) != 'object' ) { return headers }

    var url = ( request && typeof(request.url) == 'string' ) ? request.url : undefined;

    // Header maps here are written by hand at each writeHead site with mixed
    // casing, so the present-check is case-insensitive — a same-header-different-
    // case entry must still win, or the response carries it twice.
    var present = {};
    for (var k in headers) {
        if ( Object.prototype.hasOwnProperty.call(headers, k) ) { present[String(k).toLowerCase()] = true }
    }

    for (var i = 0, len = HEADERS.length; i < len; ++i) {
        var entry = HEADERS[i];
        if ( !shouldEmit(entry, cfg, url) ) { continue }
        if ( present[entry.header] ) { continue }
        headers[entry.header] = entry.value;
    }
    return headers
};

/**
 * Apply to a header OBJECT that is known to belong to a `/_gina/*` endpoint.
 *
 * Every one of isaac's `_setPoweredByHeader()` call sites is a `/_gina/*`
 * endpoint (measured 29/29, 2026-09-02), and those are deliberately
 * cross-origin: the metrics/health/SSE handlers emit
 * `access-control-allow-origin: *`, and the Inspector's cross-origin GET/SSE
 * channels are a documented design. So the cross-origin-isolating headers are
 * exempted unconditionally here rather than threading `request` through 29
 * writeHead sites — an explicit function beats a synthetic request object.
 *
 * @param {object|undefined} raw     - `server.securityHeaders` config
 * @param {object}           headers - the header map about to be written
 * @returns {object} the same map, mutated and returned for chaining
 * @example
 * headers = applyToGinaEndpointHeaders(options.securityHeaders, headers);
 */
var applyToGinaEndpointHeaders = function(raw, headers) {
    return applyToHeaders(raw, { url: '/_gina/' }, headers);
};

module.exports = {
    applyToResponse            : applyToResponse,
    applyToHeaders             : applyToHeaders,
    applyToGinaEndpointHeaders : applyToGinaEndpointHeaders,
    // Exposed for unit testing. Do not rely on these in application code.
    _HEADERS        : HEADERS,
    _GINA_PREFIX    : GINA_PREFIX,
    _shouldEmit     : shouldEmit,
    _resolveConfig  : resolveConfig
};
