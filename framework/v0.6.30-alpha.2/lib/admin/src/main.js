/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/admin
 *
 * Admin /_gina/* IP-allowlist gate (#S7). Single source of truth for the
 * access check on the admin-grade /_gina/* endpoints (`/_gina/info`,
 * `/_gina/cache/stats`). Both server engines (`server.js` and
 * `server.isaac.js`) previously carried a byte-identical copy of this
 * helper; this module is now the single source and both engines call
 * `lib.admin.isClientAllowed(req)`.
 *
 * The allowlist is resolved from `process.gina._adminAllowList`, which
 * `gna.js` populates at bundle init from `app.json` `admin.allowFrom`
 * (defaults to loopback `['127.0.0.1', '::1']`). Sibling of
 * `lib.metrics.isClientAllowed` on a separate axis — admin endpoints expose
 * process state (memory, uptime, HTTP/2 session counters, cache contents)
 * and are gated separately from Prometheus scrapes.
 *
 * Also the home of the cross-origin WRITE guard (#B384) that fronts the same
 * family. The two are complementary and neither subsumes the other: the IP
 * allowlist answers "may this address talk to admin endpoints at all", while
 * {@link isCrossOriginWrite} answers "did this state-changing request actually
 * originate from the operator, or from a page that merely borrowed their
 * browser's ambient IP". Kept as a SEPARATE function rather than folded into
 * `isClientAllowed` so the six admin GET endpoints keep their existing
 * semantics and the name never over-promises.
 *
 * Registered as a PLAIN `require` in `lib/index.js` (not `_require`): a
 * stateless pure-function leaf with no instance/singleton state to
 * hot-reload — same #B32-residual precedent as merge / uuid / Collection.
 *
 * @example
 * // from an engine handler (lib is the framework lib registry)
 * if (!lib.admin.isClientAllowed(request)) {
 *     response.statusCode = 403;
 *     return response.end(JSON.stringify({ error: 'forbidden' }));
 * }
 */

/**
 * Default allowlist used when `admin.allowFrom` is unset — loopback only.
 * @constant {string[]}
 */
var DEFAULT_ALLOW_LIST = ['127.0.0.1', '::1'];

/**
 * Decide whether a request's client IP is in an explicit allowlist. Inner
 * seam exposed for branch testing without mutating `process.gina` state.
 *
 * Reads the client IP from `req.socket.remoteAddress` only — never trusts
 * `X-Forwarded-For` (reverse proxies could spoof it). Normalises
 * `::ffff:IPv4` (IPv6-mapped IPv4) → `IPv4` so listing `127.0.0.1` matches
 * both forms. An empty list (`[]`) denies everyone (explicit lockdown).
 *
 * @inner
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @param {string[]} list the allowlist to test against
 * @returns {boolean} true if the client IP is in `list`
 * @example
 * _isAllowedWithList({ socket: { remoteAddress: '127.0.0.1' } }, ['127.0.0.1']); // true
 * _isAllowedWithList({ socket: { remoteAddress: '10.0.0.1' } }, []);             // false
 */
function _isAllowedWithList(req, list) {
    if (list.length === 0) return false;
    var ip = (req.socket && req.socket.remoteAddress)
          || (req.connection && req.connection.remoteAddress)
          || '';
    if (ip.indexOf('::ffff:') === 0) ip = ip.slice(7);
    return list.indexOf(ip) >= 0;
}

/**
 * IP-allowlist check for the admin-grade /_gina/* endpoints.
 *
 * Resolves the allowlist from `process.gina._adminAllowList` (set by
 * `gna.js` from `app.json` admin.allowFrom), falling back to loopback-only
 * when the global is missing (init not yet fired — the safest default).
 *
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean} true if the client IP is allowed, false otherwise
 * @example
 * if (!lib.admin.isClientAllowed(request)) { return self.throwError(403); }
 */
function isClientAllowed(req) {
    var list = (typeof process.gina === 'object' && process.gina && Array.isArray(process.gina._adminAllowList))
        ? process.gina._adminAllowList
        : DEFAULT_ALLOW_LIST;
    return _isAllowedWithList(req, list);
}

/**
 * Request methods that cannot mutate state (RFC 9110 §9.2.1). Mirrors the set
 * in `core/controller/controller.js` — a cross-origin GET is not a CSRF vector,
 * and refusing one would break the Inspector's deliberately cross-origin
 * GET/SSE channels (`/_gina/agent`, `/_gina/logs`, `/_gina/indexes`), where
 * `core/server.js` documents that "cross-origin is the norm here".
 * @constant {Object.<string, boolean>}
 */
var SAFE_HTTP_METHODS = { GET: true, HEAD: true, OPTIONS: true, TRACE: true };

/**
 * Decide whether a request method is SAFE (non-mutating).
 *
 * @param {string} method - the HTTP method
 * @returns {boolean} true when the method cannot mutate state
 * @example
 * isSafeMethod('get');   // true
 * isSafeMethod('POST');  // false
 * isSafeMethod(null);    // false
 */
function isSafeMethod(method) {
    return SAFE_HTTP_METHODS[ String(method || '').toUpperCase() ] === true;
}

/**
 * Detect a browser-driven CROSS-ORIGIN WRITE to the `/_gina/*` control family
 * (#B384).
 *
 * These endpoints authenticate with an AMBIENT credential — the client's IP,
 * via {@link isClientAllowed} — and a browser attaches that automatically to
 * every request a page makes. That is precisely the precondition for CSRF: an
 * operator browsing from an allowlisted address (loopback by DEFAULT, i.e. the
 * machine running the bundle) can be lured to a page that silently writes to
 * `/_gina/storage/gc`, `/_gina/cache/clear`, `/_gina/release/rebuild` or
 * `/_gina/maintenance`. The first three take their entire input from the QUERY
 * STRING and read no body at all, so the attack needs no `fetch` and no CORS
 * reasoning — a plain auto-submitting `<form>` suffices, and browsers have
 * always permitted a form to POST cross-origin.
 *
 * Two signals, in order of trustworthiness:
 *
 *  1. `Sec-Fetch-Site` — computed by the browser and a FORBIDDEN header name,
 *     so page script cannot forge it. It is also independent of how a reverse
 *     proxy rewrites `Host`, which is why it is preferred. `same-origin`
 *     passes; `none` passes (a user-initiated navigation — typed URL or
 *     bookmark — is not a forged request); `same-site` and `cross-site` are
 *     REFUSED, since a sibling subdomain is still a different origin and can
 *     still forge.
 *  2. `Origin` compared against the authority the client actually connected
 *     to — the fallback for browsers predating Fetch Metadata. Built from
 *     `:authority` (HTTP/2) or `Host` (HTTP/1.1) ONLY, NEVER from
 *     `X-Forwarded-Host` or any other forwarded header: #B367 established
 *     those are attacker-controlled, and a guard comparing against a value the
 *     attacker supplies is no guard. `Origin: null` (sandboxed iframe,
 *     `file://` page) is refused — the #CSRF3 precedent.
 *
 * NO browser signal at all ⇒ ALLOWED. CSRF attacks ambient browser
 * credentials; a client sending neither header is not a browser (curl, the
 * gina CLI's own probes, a deploy script), so refusing it would break every
 * documented operator workflow while stopping nothing.
 *
 * ⚠️ Residual, deliberately pinned: a browser old enough to send NEITHER
 * `Sec-Fetch-Site` NOR `Origin` on a POST would pass. Every current browser
 * sends `Origin` on cross-origin POSTs, so this is a legacy-only gap — and a
 * narrower one than the IP allowlist already fronting these endpoints.
 *
 * ⚠️ Second residual: a reverse proxy that REWRITES `Host` to an internal
 * upstream name desynchronises the fallback comparison, which would refuse a
 * legitimate same-origin write from a pre-Fetch-Metadata browser. Modern
 * browsers are unaffected (signal 1 never consults `Host`), and these
 * endpoints are IP-gated on `req.socket.remoteAddress`, which behind a proxy
 * is the PROXY's address — so the deployment must already have opted in by
 * listing it.
 *
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean} true when the request is a browser-driven cross-origin
 *                    write and must be refused
 * @example
 * isCrossOriginWrite({ headers: { 'sec-fetch-site': 'same-origin' } });          // false
 * isCrossOriginWrite({ headers: { 'sec-fetch-site': 'cross-site' } });           // true
 * isCrossOriginWrite({ headers: {} });                                           // false (curl)
 * isCrossOriginWrite({ headers: { origin: 'http://evil.tld', host: 'app.tld' } }); // true
 * isCrossOriginWrite({ headers: { origin: 'http://app.tld', host: 'app.tld' } }); // false
 */
function isCrossOriginWrite(req) {
    if ( typeof(req) != 'object' || req === null ) {
        return true; // malformed ⇒ fail CLOSED
    }
    var headers = req.headers || {};

    var site = headers['sec-fetch-site'];
    if ( typeof(site) == 'string' && site.trim() !== '' ) {
        site = site.trim().toLowerCase();
        return !( site === 'same-origin' || site === 'none' );
    }

    var origin = headers['origin'];
    if ( typeof(origin) != 'string' || origin.trim() === '' ) {
        return false; // no browser signal ⇒ not a browser ⇒ not CSRF
    }
    origin = origin.trim();
    if ( origin.toLowerCase() === 'null' ) {
        return true; // sandboxed iframe / file:// — #CSRF3 precedent
    }
    var authority = headers[':authority'] || headers['host'] || '';
    if ( typeof(authority) != 'string' || authority === '' ) {
        return true; // nothing trustworthy to compare against ⇒ fail CLOSED
    }
    var originHost = origin.replace(/^[a-z0-9+.\-]+:\/\//i, '');
    return ( originHost.toLowerCase() !== authority.toLowerCase() );
}

module.exports = {
    isClientAllowed    : isClientAllowed,
    isCrossOriginWrite : isCrossOriginWrite,
    isSafeMethod       : isSafeMethod,
    _isAllowedWithList : _isAllowedWithList,
    DEFAULT_ALLOW_LIST : DEFAULT_ALLOW_LIST,
    SAFE_HTTP_METHODS  : SAFE_HTTP_METHODS
};
