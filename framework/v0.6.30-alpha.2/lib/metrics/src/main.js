/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/metrics
 *
 * Prometheus metrics primitive. Wraps `prom-client` (peer dep — must be
 * installed by the project at `node_modules/prom-client`). Backs the
 * built-in `/_gina/metrics` endpoint and the request-lifecycle hook that
 * populates the HTTP counter + histogram.
 *
 * Opt-in via `app.json`:
 *
 *     {
 *       "metrics": {
 *         "enabled":   true,
 *         "path":      "/_gina/metrics",
 *         "allowFrom": ["127.0.0.1", "::1"],
 *         "prefix":    "gina_"
 *       }
 *     }
 *
 * The framework reads this block in `core/gna.js`'s `server.on('started')`
 * callback and calls `metrics.start({ prefix, defaultMetrics })` once per
 * bundle. Subsequent calls are no-ops (idempotent).
 *
 * @package    gina.framework
 * @namespace  lib.metrics
 * @author     Rhinostone <contact@gina.io>
 */

'use strict';

/**
 * Cached `prom-client` module reference. Populated on first successful
 * {@link start} call.
 *
 * @inner
 * @type {*}
 */
var promClient = null;

/**
 * Cached `Registry` instance. Single registry per bundle (per process).
 *
 * @inner
 * @type {*}
 */
var registry = null;

/**
 * Cached counter / histogram instances keyed by short name
 * (`requests`, `duration`).
 *
 * @inner
 * @type {Object<string, *>}
 */
var counters = Object.create(null);

/**
 * `true` once {@link start} has succeeded. {@link recordRequest} is a
 * no-op while this is `false`.
 *
 * @inner
 * @type {boolean}
 */
var enabled = false;

/**
 * Captured peer-dep load error. Once set, future {@link start} calls
 * surface this verbatim with the actionable `npm install prom-client`
 * hint rather than re-attempting the require.
 *
 * @inner
 * @type {Error|null}
 */
var startError = null;

/**
 * IP allowlist for the `/_gina/metrics` endpoint. Captured from
 * `app.json metrics.allowFrom` at {@link start} time. `null` before
 * start; an array thereafter. Empty array `[]` means deny everyone
 * (an explicit lockdown choice).
 *
 * @inner
 * @type {string[]|null}
 */
var allowList = null;

/**
 * Default histogram buckets in seconds — covers 5ms to 10s with finer
 * granularity at the lower end where most HTTP latencies sit.
 *
 * @memberof module:gina/lib/metrics
 * @constant
 * @type {number[]}
 */
var DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/**
 * Default IP allowlist when `app.json metrics.allowFrom` is omitted
 * (loopback only — IPv4 + IPv6).
 *
 * @memberof module:gina/lib/metrics
 * @constant
 * @type {string[]}
 */
var DEFAULT_ALLOW_LIST = ['127.0.0.1', '::1'];

/**
 * Initialise the metrics registry and wire HTTP counters. Idempotent —
 * a second call without an intervening {@link reset} returns `true`
 * without re-creating state.
 *
 * Loads `prom-client` from the project's `node_modules` directory using
 * the same peer-dep convention as the mysql / postgres / AI SDK
 * connectors (`getPath('project') + '/node_modules/prom-client'`).
 * Throws when the package is not installed; the error message includes
 * an actionable `npm install` recipe.
 *
 * @memberof module:gina/lib/metrics
 * @param   {Object}   [opts]
 * @param   {string}   [opts.prefix='gina_']        - Metric-name prefix; appears on every counter / histogram.
 * @param   {boolean}  [opts.defaultMetrics=true]   - When `true`, calls `prom.collectDefaultMetrics()` to seed Node.js process metrics (heap, GC pause, event loop lag, active handles).
 * @param   {number[]} [opts.durationBuckets]       - Override histogram buckets (seconds). Defaults to {@link DEFAULT_BUCKETS}.
 * @param   {string[]} [opts.allowFrom]             - IP allowlist for the `/_gina/metrics` endpoint. Defaults to {@link DEFAULT_ALLOW_LIST} (loopback only). Empty array `[]` means deny everyone.
 * @param   {*}        [opts.client]                - Test-only: inject a mock `prom-client`. Production callers omit this.
 * @returns {boolean}                               - `true` on success.
 * @throws  {Error}                                 - When `prom-client` cannot be loaded.
 *
 * @example
 *   // Production (called by gna.js when app.json `metrics.enabled` is true):
 *   lib.metrics.start({ prefix: 'gina_', defaultMetrics: true });
 *
 * @example
 *   // Test (mock prom-client):
 *   lib.metrics.start({ client: fakeProm, defaultMetrics: false });
 */
function start(opts) {
    opts = opts || {};
    if (enabled) {
        return true;
    }
    if (startError) {
        throw startError;
    }

    var prefix = (typeof opts.prefix === 'string' && opts.prefix.length > 0) ? opts.prefix : 'gina_';

    if (opts.client) {
        promClient = opts.client;
    } else {
        try {
            var promPath = _(getPath('project') + '/node_modules/prom-client', true);
            promClient = require(promPath);
        } catch (e) {
            startError = new Error(
                '[lib.metrics] prom-client is not installed in your project.\n'
                + 'Run: npm install prom-client\n'
                + e.message
            );
            throw startError;
        }
    }

    registry = new promClient.Registry();

    if (opts.defaultMetrics !== false && typeof promClient.collectDefaultMetrics === 'function') {
        try {
            promClient.collectDefaultMetrics({
                register: registry,
                prefix:   prefix
            });
        } catch (collectErr) {
            // Mock implementations may reject the options shape; tolerate
            // quietly so test injection stays simple.
        }
    }

    counters.requests = new promClient.Counter({
        name:       prefix + 'http_requests_total',
        help:       'Total HTTP requests',
        labelNames: ['method', 'route', 'status'],
        registers:  [registry]
    });

    counters.duration = new promClient.Histogram({
        name:       prefix + 'http_request_duration_seconds',
        help:       'HTTP request duration in seconds',
        labelNames: ['method', 'route', 'status'],
        buckets:    Array.isArray(opts.durationBuckets) ? opts.durationBuckets : DEFAULT_BUCKETS,
        registers:  [registry]
    });

    allowList = Array.isArray(opts.allowFrom) ? opts.allowFrom.slice() : DEFAULT_ALLOW_LIST.slice();

    enabled = true;
    return true;
}

/**
 * Test whether a request's client IP is in the configured allowlist.
 *
 * Reads the IP from `req.socket.remoteAddress` (or `req.connection.remoteAddress`
 * as a fallback for older shapes). Does NOT trust `X-Forwarded-For`: the
 * metrics endpoint is for direct scrapers (Prometheus, internal admin),
 * never proxied public traffic.
 *
 * Normalises IPv6-mapped IPv4 form (`::ffff:127.0.0.1`) so an entry of
 * `'127.0.0.1'` matches both `'127.0.0.1'` and `'::ffff:127.0.0.1'`.
 *
 * Returns `false` before {@link start}, when the allowlist is empty,
 * and when no client IP can be determined.
 *
 * @memberof module:gina/lib/metrics
 * @param   {Object} req - Node `IncomingMessage` (HTTP/1.1) or `Http2ServerRequest`.
 * @returns {boolean}
 *
 * @example
 *   if (!lib.metrics.isClientAllowed(request)) {
 *     response.writeHead(403, { 'content-type': 'application/json' });
 *     return response.end(JSON.stringify({ error: 'forbidden' }));
 *   }
 */
function isClientAllowed(req) {
    var list = (allowList !== null) ? allowList : DEFAULT_ALLOW_LIST;
    if (list.length === 0) {
        return false;
    }

    var ip = '';
    if (req && req.socket && req.socket.remoteAddress) {
        ip = req.socket.remoteAddress;
    } else if (req && req.connection && req.connection.remoteAddress) {
        ip = req.connection.remoteAddress;
    }
    if (!ip) {
        return false;
    }

    var normalized = ip.replace(/^::ffff:/i, '');

    for (var i = 0; i < list.length; i++) {
        var entry = list[i];
        if (entry === ip)         return true;
        if (entry === normalized) return true;
        // Allow listed IPv4 to match the IPv6-mapped form.
        if (/^\d+\.\d+\.\d+\.\d+$/.test(entry) && '::ffff:' + entry === ip) {
            return true;
        }
    }
    return false;
}

/**
 * Read the current IP allowlist. Returns a defensive copy.
 *
 * @memberof module:gina/lib/metrics
 * @returns {string[]} The configured list, or {@link DEFAULT_ALLOW_LIST} before {@link start}.
 */
function getAllowList() {
    if (allowList === null) {
        return DEFAULT_ALLOW_LIST.slice();
    }
    return allowList.slice();
}

/**
 * Override the IP allowlist. Test-only — production code should pass
 * `allowFrom` to {@link start} via the bundle's `app.json` block.
 *
 * @memberof module:gina/lib/metrics
 * @param {string[]} list - New allowlist. Empty array `[]` denies everyone.
 * @returns {void}
 */
function setAllowList(list) {
    if (!Array.isArray(list)) {
        throw new TypeError('setAllowList: list must be an array');
    }
    allowList = list.slice();
}

/**
 * Record one HTTP request into the counter + histogram. No-op when
 * {@link start} has not been called.
 *
 * The `route` label MUST come from the routing.json rule key
 * (`req.routing.rule`), NOT the raw URL — otherwise Prometheus cardinality
 * blows up on every distinct path-parameter value.
 *
 * When `obs.route` is missing, the label is derived from `obs.status`
 * to keep the cardinality bounded:
 *
 *   - `404`   → `'__not_found__'`
 *   - `405`   → `'__method_not_allowed__'`
 *   - `>=500` → `'__error__'`
 *   - other   → `'__no_route__'`
 *
 * @memberof module:gina/lib/metrics
 * @param   {Object}        obs
 * @param   {string}        obs.method     - Uppercased HTTP method (`'GET'`, `'POST'`, …).
 * @param   {string}        [obs.route]    - routing.json rule key (cardinality-safe). When omitted, derived from status.
 * @param   {number|string} obs.status     - HTTP status code.
 * @param   {number}        [obs.duration] - Request duration in milliseconds (NOT seconds — converted internally for the histogram).
 * @returns {void}
 *
 * @example
 *   lib.metrics.recordRequest({
 *     method:   'GET',
 *     route:    'home',
 *     status:   200,
 *     duration: 42  // ms
 *   });
 *
 * @example
 *   // 404 with no matched route → '__not_found__' label
 *   lib.metrics.recordRequest({ method: 'GET', status: 404, duration: 1 });
 */
function recordRequest(obs) {
    if (!enabled) return;
    if (!obs || typeof obs !== 'object') return;
    var route = (typeof obs.route === 'string' && obs.route.length > 0) ? obs.route : null;
    if (!route) {
        var statusNum = parseInt(obs.status, 10);
        if (statusNum === 404)      route = '__not_found__';
        else if (statusNum === 405) route = '__method_not_allowed__';
        else if (statusNum >= 500)  route = '__error__';
        else                        route = '__no_route__';
    }
    var labels = {
        method: typeof obs.method === 'string' ? obs.method.toUpperCase() : 'UNKNOWN',
        route:  route,
        status: String(obs.status || 0)
    };
    counters.requests.inc(labels);
    if (typeof obs.duration === 'number' && obs.duration >= 0) {
        counters.duration.observe(labels, obs.duration / 1000);
    }
}

/**
 * Render current metrics in Prometheus exposition format.
 * `prom-client@15` made `registry.metrics()` async, so the wrapper always
 * returns a Promise even when the underlying call is synchronous.
 *
 * @memberof module:gina/lib/metrics
 * @returns {Promise<string>} Prometheus text. Empty string when metrics are disabled.
 *
 * @example
 *   var body = await lib.metrics.getMetrics();
 *   response.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
 *   response.end(body);
 */
function getMetrics() {
    if (!enabled || !registry) {
        return Promise.resolve('');
    }
    var out = registry.metrics();
    if (out && typeof out.then === 'function') {
        return out;
    }
    return Promise.resolve(String(out || ''));
}

/**
 * Whether {@link start} has been called successfully.
 *
 * @memberof module:gina/lib/metrics
 * @returns {boolean}
 */
function isEnabled() {
    return enabled;
}

/**
 * Direct access to the underlying `prom-client` Registry. Returns `null`
 * before {@link start}. Reserved for advanced users who want to register
 * custom metrics on the same registry the framework owns.
 *
 * @memberof module:gina/lib/metrics
 * @returns {*|null}
 */
function getRegistry() {
    return registry;
}

/**
 * Test-only helper that clears every module-level slot. Production code
 * should not call this — counter references held by callers become stale
 * after a reset.
 *
 * @memberof module:gina/lib/metrics
 * @returns {void}
 */
function reset() {
    promClient = null;
    registry   = null;
    counters   = Object.create(null);
    enabled    = false;
    startError = null;
    allowList  = null;
}

module.exports = {
    start             : start,
    recordRequest     : recordRequest,
    getMetrics        : getMetrics,
    isEnabled         : isEnabled,
    getRegistry       : getRegistry,
    isClientAllowed   : isClientAllowed,
    getAllowList      : getAllowList,
    setAllowList      : setAllowList,
    reset             : reset,
    DEFAULT_BUCKETS   : DEFAULT_BUCKETS,
    DEFAULT_ALLOW_LIST: DEFAULT_ALLOW_LIST
};
