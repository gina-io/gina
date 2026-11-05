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
 * `/_gina/cache/stats`, `/_gina/cache/clear`, `/_gina/storage/*`,
 * `/_gina/release/*`, `/_gina/maintenance`; `/_gina/metrics` has its own list
 * in lib/metrics, which applies the same #B709 rule). Both server engines
 * (`server.js` and `server.isaac.js`) previously carried a byte-identical copy
 * of this helper; this module is now the single source and both engines call
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
 * #B709 — a loopback caller is admitted only when it connects DIRECTLY. The
 * default list is loopback, and loopback is also the address a reverse proxy on
 * the bundle's own host connects from, so an address-only gate admitted every
 * client such a proxy forwarded. {@link isClientAllowed} therefore refuses a
 * loopback caller whose request carries a proxy signal — the classifier is
 * lib/maintenance's `isProxiedRequest`, the one the maintenance bypass list
 * already uses, so the two gates can never disagree about what "proxied" means.
 * The engines take that classification once per `/_gina/*` request from the
 * pristine headers ({@link stampProxied}): isaac rewrites an h1 `Host` port-less
 * before handing the request to `server.js`, and a live read after that rewrite
 * would misclassify every direct call. The engines also match the family on
 * {@link controlPath} rather than on the raw url, so a nested endpoint path, the
 * endpoint path in a query string, another letter case or an empty leading
 * segment never reaches a handler.
 *
 * Registered as a PLAIN `require` in `lib/index.js` (not `_require`): no
 * instance/singleton state worth hot-reloading — same #B32-residual precedent as
 * merge / uuid / Collection. Its one piece of module state is the once-per-process
 * flag of the #B709 refusal warning; a reload only re-arms that warning.
 *
 * @example
 * // from an engine handler (lib is the framework lib registry)
 * if (!lib.admin.isClientAllowed(request)) {
 *     response.statusCode = 403;
 *     return response.end(JSON.stringify({ error: 'forbidden' }));
 * }
 */

/**
 * The shared proxy classifier (#B709). Relative require: lib/admin is loaded by
 * plain `require` from `lib/index.js` and directly by the tests, never through the
 * `lib/…` bare-module path.
 * @inner
 */
var maintenance = require('../../maintenance/src/main');

/**
 * Default allowlist used when `admin.allowFrom` is unset — loopback only.
 * @constant {string[]}
 */
var DEFAULT_ALLOW_LIST = ['127.0.0.1', '::1'];

/**
 * Name of the per-request stamp holding the proxy classification of a
 * `/_gina/*` request, taken from its pristine headers (#B709).
 * @constant {string}
 */
var PROXIED_STAMP = '_ginaAdminProxied';

/**
 * Which gates have already logged a relayed-loopback refusal in this process,
 * keyed by the list they read (`admin.allowFrom`, `metrics.allowFrom`).
 * @inner
 * @type {Object.<string, boolean>}
 */
var relayedWarned = Object.create(null);

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
 * #B709 — a caller admitted by the list is still refused when it is a loopback
 * address and its request carries a proxy signal ({@link isRelayedLoopback}): a
 * reverse proxy on the bundle's own host connects from loopback, so without this
 * the default list admitted every client that proxy forwarded. An explicitly
 * listed NON-loopback address keeps admitting relayed requests — listing a proxy
 * on another host is the documented opt-in. The first such refusal is logged
 * once per process.
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
    if ( !_isAllowedWithList(req, list) ) {
        return false;
    }
    if ( isRelayedLoopback(req) ) {
        warnRelayedOnce(req, 'admin.allowFrom');
        return false;
    }
    return true;
}

/**
 * Whether an address is a loopback address: `::1`, or any address of the IPv4
 * loopback block `127.0.0.0/8`, in its plain or IPv6-mapped (`::ffff:`) form.
 *
 * @inner
 * @param {string} ip - a socket's remote address
 * @returns {boolean}
 * @example
 * _isLoopbackAddress('127.0.0.1');        // true
 * _isLoopbackAddress('::ffff:127.0.0.2'); // true
 * _isLoopbackAddress('10.0.0.5');         // false
 */
function _isLoopbackAddress(ip) {
    if ( typeof(ip) != 'string' || ip === '' ) {
        return false;
    }
    if ( ip.indexOf('::ffff:') === 0 ) {
        ip = ip.slice(7);
    }
    return ( ip === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip) );
}

/**
 * Classify a request as proxied from its headers as they are NOW — lib/maintenance's
 * `isProxiedRequest`, honouring `server.proxy.requireForwardedHeaders` (#B152). Fails
 * toward "proxied" for a malformed request.
 *
 * @inner
 * @param {object} req
 * @returns {boolean}
 */
function _classifyProxied(req) {
    var requireForwarded = ( typeof(process.gina) == 'object' && process.gina !== null
                             && process.gina._proxyRequireForwarded === true );
    return maintenance.isProxiedRequest(req, requireForwarded);
}

/**
 * Take the proxy classification of a request ONCE, from its headers as they are
 * at the call, and keep it on the request (`request._ginaAdminProxied`). The
 * engines call it at the top of their request handling for every `/_gina/*`
 * url, before anything rewrites a header: isaac rewrites an h1 `Host`
 * port-less before it hands the request to `server.js`, and the port-less-Host
 * heuristic would then read every direct caller of a `server.js`-only handler
 * (`/_gina/storage/*`) as proxied. First-seer: a later call returns the stamp
 * already there.
 *
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean} the stamped classification (`true` for a malformed request)
 * @example
 * if ( request.url.indexOf('/_gina/') > -1 ) { lib.admin.stampProxied(request); }
 */
function stampProxied(req) {
    if ( typeof(req) != 'object' || req === null ) {
        return true;
    }
    if ( typeof(req[PROXIED_STAMP]) != 'boolean' ) {
        req[PROXIED_STAMP] = _classifyProxied(req);
    }
    return req[PROXIED_STAMP];
}

/**
 * Whether a request is a loopback caller relayed by a proxy on this host: its
 * socket address is loopback and it carries a proxy signal — the stamp when the
 * engine took one ({@link stampProxied}), else a live classification (Express,
 * tests, req-less callers). The admin and metrics gates refuse such a request.
 *
 * A proxy that forwards `Host` with its port and adds no forwarding header is
 * byte-identical to a direct client and is NOT detected — the residual every IP
 * allowlist shares; the docs say to call the bundle's port directly and to block
 * `/_gina/` at the edge.
 *
 * @param {http.IncomingMessage|http2.Http2ServerRequest} req
 * @returns {boolean}
 * @example
 * isRelayedLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'example.com' } });      // true
 * isRelayedLoopback({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1:3100' } });   // false
 * isRelayedLoopback({ socket: { remoteAddress: '10.0.0.5' }, headers: { 'x-forwarded-for': '1.2.3.4' } }); // false
 */
function isRelayedLoopback(req) {
    if ( typeof(req) != 'object' || req === null ) {
        return false;
    }
    var ip = (req.socket && req.socket.remoteAddress)
          || (req.connection && req.connection.remoteAddress)
          || '';
    if ( !_isLoopbackAddress(ip) ) {
        return false;
    }
    if ( typeof(req[PROXIED_STAMP]) == 'boolean' ) {
        return req[PROXIED_STAMP];
    }
    return _classifyProxied(req);
}

/**
 * Log the first relayed-loopback refusal of a gate, once per process — never per
 * request, never at boot (the loopback default applies to every bundle, so a boot
 * line about it would be noise; the refusal is the actionable moment). Names the
 * path without its query.
 *
 * @param {object} req - the refused request
 * @param {string} axis - the list the gate reads: `admin.allowFrom` or `metrics.allowFrom`
 * @returns {void}
 * @example
 * if ( allowed && lib.admin.isRelayedLoopback(req) ) { lib.admin.warnRelayedOnce(req, 'metrics.allowFrom'); allowed = false; }
 */
function warnRelayedOnce(req, axis) {
    if ( relayedWarned[axis] === true ) {
        return;
    }
    relayedWarned[axis] = true;
    var url = ( req && typeof(req.originalUrl) == 'string' ) ? req.originalUrl
            : ( req && typeof(req.url) == 'string' ) ? req.url
            : '';
    console.warn('[admin] refused a request to `' + url.split('?')[0] + '` relayed by a proxy on this host: '
        + '`app.json > ' + axis + '` admits a loopback caller only when it connects directly. '
        + 'Call the bundle\'s own port from the host or the pod, or list the address of a proxy running on another host. '
        + 'See https://gina.io/docs/reference/app#admin — logged once per process.');
}

/**
 * Test seam: re-arm the once-per-process refusal warnings.
 * @inner
 * @returns {void}
 */
function _resetRelayedWarnings() {
    relayedWarned = Object.create(null);
}

/**
 * The query-free path a `/_gina/*` control endpoint is matched on (#B709): the
 * url's path when it starts with `/_gina/`, or — for the bundle's OWN webroot —
 * `<webroot>_gina/…` mapped to `/_gina/…`; anything else yields `''`. Case is kept,
 * so `/_GINA/…` yields `''`; an empty leading segment (`//_gina/…`), another prefix
 * and an absolute-form target yield `''` too. A nested endpoint path is returned
 * whole, so an exact compare against `/_gina/<endpoint>` cannot match its tail.
 *
 * @param {string} url - the request url (`request.originalUrl || request.url`)
 * @param {string} [webroot] - the bundle's webroot (`/web/`; normalised if needed)
 * @returns {string} the control path, or `''`
 * @example
 * controlPath('/_gina/cache/clear?bundle=web');        // '/_gina/cache/clear'
 * controlPath('/web/_gina/info', '/web/');             // '/_gina/info'
 * controlPath('/zzz/_gina/info', '/web/');             // ''
 * controlPath('/?next=/_gina/maintenance');            // ''
 * controlPath('/_gina/health/check/_gina/maintenance'); // '/_gina/health/check/_gina/maintenance'
 */
function controlPath(url, webroot) {
    if ( typeof(url) != 'string' ) {
        return '';
    }
    var p = url.split('?')[0];
    if ( p.indexOf('/_gina/') === 0 ) {
        return p;
    }
    if ( typeof(webroot) == 'string' && webroot !== '' && webroot !== '/' ) {
        var w = ( webroot.charAt(0) === '/' ) ? webroot : '/' + webroot;
        if ( w.charAt(w.length - 1) !== '/' ) {
            w += '/';
        }
        if ( p.indexOf(w + '_gina/') === 0 ) {
            return p.slice(w.length - 1);
        }
    }
    return '';
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
 * is the PROXY's address: a proxy on another host must be listed explicitly,
 * and a proxy on the bundle's own host (loopback) is refused whenever its
 * request carries a proxy signal (#B709 — before that fix the default
 * loopback list admitted it, so this "must have opted in" premise was false
 * for exactly that deployment).
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
    isClientAllowed       : isClientAllowed,
    isCrossOriginWrite    : isCrossOriginWrite,
    isSafeMethod          : isSafeMethod,
    isRelayedLoopback     : isRelayedLoopback,
    stampProxied          : stampProxied,
    controlPath           : controlPath,
    warnRelayedOnce       : warnRelayedOnce,
    _isAllowedWithList    : _isAllowedWithList,
    _resetRelayedWarnings : _resetRelayedWarnings,
    DEFAULT_ALLOW_LIST    : DEFAULT_ALLOW_LIST,
    SAFE_HTTP_METHODS     : SAFE_HTTP_METHODS,
    PROXIED_STAMP         : PROXIED_STAMP
};
