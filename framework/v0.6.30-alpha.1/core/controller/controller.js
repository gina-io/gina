"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs              = require('fs');
const {promises: {readFile}} = require("fs");
const { pipeline }  = require('stream/promises');
const exec          = require('child_process').exec;
var util            = require('util');
var crypto          = require('crypto'); // #ERRREF incident-ref mint
var promisify       = util.promisify;
var EventEmitter    = require('events').EventEmitter;

const { Resolver } = require('node:dns').promises;

var lib             = require('./../../lib') || require.cache[require.resolve('./../../lib')];

/**
 * #A11Y3 — BCP-47 language tag for a framework-generated document.
 *
 * Mirror of the helper in `core/server.js`; kept local because the fallback error
 * paths in both engines must stay self-contained. The negotiated culture is stored
 * underscore-separated (`en_CM`) and a raw `accept-language` value can still carry
 * its q-value (`fr;q=0.9`) — neither is a valid `lang` attribute, and a tag AT
 * cannot parse makes it select the wrong voice.
 *
 * @param {object} [req] - request whose negotiated `culture` should be used
 * @returns {string} a BCP-47-shaped language tag, never empty
 *
 * @example
 * a11yLangTag({ culture: 'en_CM' }); // 'en-CM'
 * a11yLangTag(null);                 // 'en'
 *
 * @inner
 */
var a11yLangTag = function(req) {
    var culture = ( req && typeof(req.culture) == 'string' && req.culture )
        ? req.culture
        : ( getEnvVar('GINA_CULTURE') || '' );
    culture = String(culture).split(',')[0].split(';')[0].trim().replace(/_/g, '-');
    return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(culture) ? culture : 'en';
};

/**
 * #A11Y3 — wraps the inline fallback error body in a conforming HTML document.
 *
 * The body was previously sent as a bare `<h1>` + `<pre>` fragment with a
 * `text/html` content type: no doctype (quirks mode), no `<head>`, no `<title>`
 * (WCAG 2.4.2), no `lang` (WCAG 3.1.1) and no landmark. The caller's markup is
 * embedded verbatim, so the status and incident ref that the error-pages guide
 * promises the fallback shows are preserved unchanged.
 *
 * @param {number|string} code - HTTP status code, used for the document title
 * @param {string} bodyHtml - the already-built `msgString` markup
 * @param {object} [req] - request, for language negotiation
 * @returns {string} a complete, conforming HTML document
 *
 * @example
 * a11yErrorDocument(500, '<h1 class="status">Error 500.</h1>', req);
 *
 * @inner
 */
var a11yErrorDocument = function(code, bodyHtml, req) {
    return '<!doctype html><html lang="'+ a11yLangTag(req) +'">'
        + '<head><title>Error '+ code +'</title></head>'
        + '<body><main>'+ bodyHtml +'</main></body></html>';
};

// #B3 — persist resolver and cache across dev-mode cache-busts.
// controller.js is re-required on every request when isCacheless (dev mode), which would
// create a new Resolver and Cache instance each time, silently abandoning in-flight DNS
// lookups and dropping cache-invalidation listeners. Storing on process.gina (which survives
// module cache evictions) ensures both are created exactly once per process lifetime.
if (!process.gina) process.gina = {};
if (!process.gina._resolver) process.gina._resolver = new Resolver();
const resolver = process.gina._resolver;
if (!process.gina._cache) process.gina._cache = new lib.Cache();
const cache = process.gina._cache;
// #QI — AsyncLocalStorage binds the dev query log to the request's async context.
// Without this, process.gina._devQueryLog (a single global pointer) gets overwritten
// by concurrent requests, causing queries from async entity callbacks to push to
// the wrong request's array.
if (!process.gina._queryALS) {
    var { AsyncLocalStorage } = require('async_hooks');
    process.gina._queryALS = new AsyncLocalStorage();
}
// Inspector activation flag — when false, profiling (flow timeline, query log)
// is skipped and JSON responses stay clean. Set to true when the Inspector SPA
// is opened or an SSE client connects to /_gina/agent or /_gina/logs.
// Lives on process.gina so it survives dev-mode cache busting of controller.js.
if (typeof process.gina._inspectorActive === 'undefined') {
    process.gina._inspectorActive = false;
}
// #INS10 — instrumentation-window deadline (epoch ms; 0 = closed). Capture gates
// read this slot directly (process.gina._inspectorWindowUntil > Date.now()) so a
// time-boxed window can open query/flow capture OUTSIDE dev mode. gna.js seeds it
// plus the opt-in/key/bounds at server start; this guard covers very-early/test use.
if (typeof process.gina._inspectorWindowUntil === 'undefined') {
    process.gina._inspectorWindowUntil = 0;
}
var merge           = lib.merge;
var inherits        = lib.inherits;
var console         = lib.logger;
var Collection      = lib.Collection;
var routingLib      = lib.routing;
// removed: Domain import + domainLib instantiation — domainLib was never used in active code
// (only usage at line 508 is commented out); re-instantiating Domain on every dev-mode request
// via refreshCoreDependencies() caused [DOMAIN] PSL Loaded ×2 noise per request
// Swig is resolved through lib.swigResolver (process-cached on
// process.gina._swig). Server.js's initSwigEngine() populates the cache
// during bundle startup; controller.js is re-required on every request
// in dev mode via refreshCoreDependencies(), so this getter sees the
// already-loaded instance without re-running the resolver. Falls back to
// require('@rhinostone/swig') when no bundle has loaded yet (tests, etc).
var swig            = lib.swigResolver.get();
const { type }      = require('node:os');
var SwigFilters     = lib.SwigFilters;
var statusCodes     = requireJSON( _( getPath('gina').core + '/status.codes') );

/**
 * #B466 — is `v` a status code node's `writeHead()` will accept ?
 *
 * Encodes node's own rule (integer 100-999) rather than membership of
 * `statusCodes`: that table carries a `_comment` key, so a bare
 * `typeof(statusCodes[v]) != 'undefined'` test accepts the status
 * `"_comment"`, and it would also coerce a valid-but-unlisted code.
 * `/^\d{3}$/` is not sufficient either — it accepts `"099"`, which node
 * rejects. The `statusCodes` lookup remains in place as the DIAGNOSTIC
 * (the `[ ApiValidator ]` warn); this predicate is the CORRECTNESS gate.
 *
 * @param {*} v - candidate status
 * @returns {boolean} true when node would accept `v` as an HTTP status
 *
 * @example
 *      _isValidHttpStatus(404)      // true
 *      _isValidHttpStatus('404')    // true  (node accepts numeric strings)
 *      _isValidHttpStatus('draft')  // false
 *      _isValidHttpStatus('099')    // false (node rejects it)
 */
var _isValidHttpStatus = function (v) {
    var n = Number(v);
    return Number.isInteger(n) && n >= 100 && n <= 999;
};

// cached at module load — these env vars never change at runtime (#P19)
var _isDev          = process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true';
var _isLocalScope   = process.env.NODE_SCOPE_IS_LOCAL && process.env.NODE_SCOPE_IS_LOCAL.toLowerCase() === 'true';

/**
 * #ERRREF — mint (or validate a caller-supplied) incident ref for error
 * responses. Controller-side copy of the server-side helper — kept in sync
 * with core/server.js `_mintErrorRef` (two deliberate local copies, the
 * pruneDeadModuleChildren discipline: controller.js is evicted per request
 * in dev, so a shared home would churn; the helper is 4 lines).
 *
 * The ref is a short correlation code returned as a top-level `ref` field
 * on every `throwError` JSON error body — in ALL scopes — and paired
 * server-side with the full error detail in the throwError log line, so a
 * user-relayed ref resolves to the exact failure even where the stack
 * egress gate strips the wire. A caller-supplied ref is honoured when
 * relay-safe (bounded length, restricted charset — neutralises log
 * forging); anything else gets a fresh 6-uppercase-hex mint.
 *
 * @private
 * @param {string} [supplied] - caller/producer-provided ref candidate
 * @returns {string} the supplied value when relay-safe (1-32 chars of
 *  word chars, dots or dashes), else 6 fresh uppercase hex chars
 */
var _mintErrorRef = function(supplied) {
    if ( typeof(supplied) == 'string' && /^[\w.\-]{1,32}$/.test(supplied) ) {
        return supplied;
    }
    return crypto.randomBytes(3).toString('hex').toUpperCase();
};

/**
 * #CE1 — resolves the bundle's `server.transientErrors` block into its
 * effective values. Total: never throws, and tolerates any malformed shape
 * by falling back to the documented defaults (the boot-time warn pass in
 * `core/gna.js` names each ignored key once at startup — keep both sites'
 * rules in sync). Strictness rules:
 *   - `enabled` must be strictly boolean `true` — any other type or value
 *     leaves the feature off (an error-rendering opt-in must never turn on
 *     by accident);
 *   - `retryAfter` must be an integer within 1..86400 seconds, else 30;
 *   - `message` must be a non-empty string, else null (the caller falls
 *     back to the standard status text).
 *
 * @private
 * @param {object} bundleConf - the per-request bundle configuration
 * @returns {{enabled: boolean, retryAfter: number, message: (string|null)}} effective values
 */
var _getTransientErrorsConf = function(bundleConf) {
    var out = { enabled: false, retryAfter: 30, message: null };
    try {
        var block = bundleConf && bundleConf.server && bundleConf.server.transientErrors;
        if ( !block || typeof(block) != 'object' ) {
            return out;
        }
        out.enabled = ( block.enabled === true );
        if (
            typeof(block.retryAfter) == 'number'
            && isFinite(block.retryAfter)
            && Math.floor(block.retryAfter) === block.retryAfter
            && block.retryAfter >= 1
            && block.retryAfter <= 86400
        ) {
            out.retryAfter = block.retryAfter;
        }
        if ( typeof(block.message) == 'string' && block.message.length > 0 ) {
            out.message = block.message;
        }
    } catch (confReadErr) {
        // hostile getters on a user-supplied config object — keep the
        // defaults; rendering of the request error must not be derailed
        // by a config-read failure (same total-function bar as
        // lib/connector-error.classify()).
    }
    return out;
};

// #P39 — per-culture locale-resolution memo. setOptions used to build TWO
// Collections per request over the boot-loaded region sets (a full deep copy
// of ~500 nested records each time, plus one 16-char id minted per record —
// ~750 webcrypto calls) to answer two lookups: language → region set, and
// country → one row. The lookups are pure functions of boot-static data
// (`getContext('gina').locales` is set once at bundle start), so they are
// memoized at module level. The memo holds only references into that
// process-global context — no request state — and rebuilds whenever the
// context array's identity changes (or when dev-mode eviction re-requires
// this module, where a rebuild costs one pass over the language rows).
var _localesIdxSrc = null;
var _localesIdx    = null;
var _localeRowMemo = null;

/**
 * Language index over the boot-loaded locales context.
 * Maps a language code to its `{ lang, content }` row — first row wins on a
 * duplicate language, matching the historical first-match lookup semantics.
 *
 * @private
 * @returns {object} lang → locales row (shared, pristine — callers must not mutate)
 */
var _resolveLocalesIndex = function() {
    var src = getContext('gina').locales;
    if (_localesIdxSrc !== src || !_localesIdx) {
        _localesIdxSrc = src;
        _localesIdx    = {};
        _localeRowMemo = {};
        for (var i = 0, len = src.length; i < len; ++i) {
            if ( typeof(_localesIdx[src[i].lang]) == 'undefined' ) {
                _localesIdx[src[i].lang] = src[i];
            }
        }
    }
    return _localesIdx;
};

/**
 * Country-row lookup within a language's region set, memoized per
 * `<lang>|<ISO>` culture pair (misses are memoized too).
 *
 * Region rows key countries by UPPERCASE `isoShort` (ISO 3166-1 alpha-2 —
 * #B101), so a strict compare after `toUpperCase()` matches what the former
 * case-insensitive whole-string lookup resolved on this data.
 *
 * @private
 * @param {array}  contentRows - a language's region set (the index row's `.content`)
 * @param {string} langCode    - the language the rows were resolved FOR (fallback-resolved lang keys consistently)
 * @param {string} countryCode - ISO 3166-1 alpha-2 country code, any case
 * @returns {object|null} the shared pristine row, or null when the country is not in the set
 */
var _resolveLocaleRow = function(contentRows, langCode, countryCode) {
    var iso = countryCode.toUpperCase();
    var key = langCode + '|' + iso;
    if ( typeof(_localeRowMemo[key]) != 'undefined' ) {
        return _localeRowMemo[key];
    }
    var row = null;
    for (var i = 0, len = contentRows.length; i < len; ++i) {
        if ( contentRows[i] && contentRows[i].isoShort === iso ) {
            row = contentRows[i];
            break;
        }
    }
    _localeRowMemo[key] = row;
    return row;
};

/**
 * Defines `conf.locales` as a LAZY, self-replacing accessor: the request's
 * own deep copy of the region set is materialized on first read and cached
 * on the request's conf object from then on.
 *
 * The render path itself never reads `conf.locales` — its only framework
 * reader is `self.getLocales()` — so the common request pays nothing, while
 * a request that does read it gets exactly the isolation the former eager
 * per-request copy provided (a fresh deep copy, safe to mutate). Whole-conf
 * consumers (`self.getConfig()`, serializers) materialize it through the
 * accessor transparently. The accessor is enumerable and writable-through
 * (assignment replaces it with a plain value), and configurable so a second
 * `setOptions()` on the same request re-defines it cleanly.
 *
 * @private
 * @param {object} conf    - the request's conf (the router's per-request shallow copy)
 * @param {array}  srcRows - the resolved language's region set (shared, pristine)
 * @returns {void}
 */
var _defineLazyLocales = function(conf, srcRows) {
    Object.defineProperty(conf, 'locales', {
        configurable: true,
        enumerable: true,
        get: function() {
            var rows = JSON.clone(srcRows);
            Object.defineProperty(this, 'locales', { configurable: true, enumerable: true, writable: true, value: rows });
            return rows;
        },
        set: function(v) {
            Object.defineProperty(this, 'locales', { configurable: true, enumerable: true, writable: true, value: v });
        }
    });
};
var _isProdScope    = process.env.NODE_SCOPE_IS_PRODUCTION && process.env.NODE_SCOPE_IS_PRODUCTION.toLowerCase() === 'true';

/**
 * formatAttachmentDisposition
 *
 * Builds an `attachment` Content-Disposition value whose `filename`
 * parameter is emitted as an RFC 6266 quoted-string — `"` and `\` are
 * backslash-escaped so the value cannot terminate early. A bare token
 * cannot legally carry spaces, `;` or `,`, and user-supplied document
 * titles make those the common case; quoting keeps the header conformant
 * for every filename shape.
 *
 * @function formatAttachmentDisposition
 * @private
 * @param {string} filename - name the client should save the download as
 * @returns {string} headerValue - e.g. `attachment; filename="monthly report.pdf"`
 *
 * @example
 *  formatAttachmentDisposition('monthly report.pdf');
 *  // -> 'attachment; filename="monthly report.pdf"'
 */
function formatAttachmentDisposition(filename) {
    return 'attachment; filename="' + String(filename).replace(/[\\"]/g, '\\$&') + '"';
}

/**
 * Parse an HTTP `Range` request header against a known representation size.
 *
 * Honours a SINGLE `bytes=` range in its three RFC 9110 shapes — `a-b`,
 * `a-` (open-ended) and `-n` (suffix: the last `n` bytes). Everything else —
 * an absent/non-string header, another unit, a multi-range list, syntactic
 * garbage, or `a-b` with `a > b` — returns `null`, which the caller treats as
 * "ignore the header, serve the full 200" (RFC-sanctioned: a server MAY
 * ignore Range). A syntactically valid range that matches no byte of the
 * representation — `start >= size`, a `-0` suffix, or any range against a
 * zero-length object — returns `{unsatisfiable: true}`, the caller's 416.
 * A satisfiable range comes back `{start, end}` with `end` INCLUSIVE and
 * clamped to `size - 1`, matching both the header semantics and the storage
 * drivers' `getRange` contract, so no arithmetic sits between them.
 *
 * @function _parseRangeHeader
 * @private
 * @param {string} header - The raw `Range` header value.
 * @param {number} size   - The representation size in bytes.
 * @returns {object|null} `{start, end}` inclusive · `{unsatisfiable: true}` · `null` (ignore).
 *
 * @example
 *  _parseRangeHeader('bytes=0-499', 1000);   // -> { start: 0, end: 499 }
 *  _parseRangeHeader('bytes=-500', 1000);    // -> { start: 500, end: 999 }
 *  _parseRangeHeader('bytes=0-1,5-9', 1000); // -> null (multi-range: full 200)
 *  _parseRangeHeader('bytes=1000-', 1000);   // -> { unsatisfiable: true } (416)
 */
function _parseRangeHeader(header, size) {
    if ( typeof(header) != 'string' ) {
        return null;
    }
    var m = header.match(/^\s*bytes\s*=\s*(\d*)\s*-\s*(\d*)\s*$/);
    if ( !m ) {
        return null;
    }
    var startStr = m[1], endStr = m[2];
    if ( startStr === '' && endStr === '' ) {
        return null; // "bytes=-" is garbage
    }
    if ( startStr === '' ) {
        // suffix form `-n`: the last n bytes
        var n = parseInt(endStr, 10);
        if ( n === 0 || size === 0 ) {
            return { unsatisfiable: true }; // a -0 suffix matches no byte; empty matches none
        }
        var s = size - n;
        return { start: (s > 0) ? s : 0, end: size - 1 };
    }
    var start = parseInt(startStr, 10);
    if ( size === 0 || start >= size ) {
        return { unsatisfiable: true };
    }
    var end = ( endStr === '' ) ? size - 1 : parseInt(endStr, 10);
    if ( end < start ) {
        return null; // last-byte-pos < first-byte-pos: invalid spec, ignore (RFC 9110)
    }
    return { start: start, end: Math.min(end, size - 1) };
}

/**
 * Resolve the Content-Type a stored object is served with.
 *
 * The stored contentType is UPLOADER-supplied and stored verbatim (untrusted
 * at the seam), so serving it back on the app's own origin is a stored-XSS
 * vector: a declared `text/html`/`image/svg+xml` renders as active content
 * and `nosniff` does not stop a DECLARED type. Fail-closed: active-content
 * types downgrade to `application/octet-stream` unless the app passes an
 * explicit `opts.contentType` — the app's informed choice is served verbatim.
 *
 * @function _resolveServedContentType
 * @private
 * @param {string} [optsContentType] - The caller's explicit choice; wins verbatim.
 * @param {string} [metaContentType] - The stored, uploader-supplied MIME type.
 * @returns {string} The Content-Type to serve.
 *
 * @example
 *  _resolveServedContentType(null, 'image/png');       // -> 'image/png'
 *  _resolveServedContentType(null, 'text/html');       // -> 'application/octet-stream'
 *  _resolveServedContentType('image/svg+xml', 'x/y');  // -> 'image/svg+xml' (explicit)
 */
function _resolveServedContentType(optsContentType, metaContentType) {
    if ( typeof(optsContentType) == 'string' && optsContentType !== '' ) {
        return optsContentType;
    }
    if ( typeof(metaContentType) == 'string' && metaContentType !== '' ) {
        if ( /(html|xml|svg|javascript|ecmascript)/i.test(metaContentType) ) {
            return 'application/octet-stream';
        }
        return metaContentType;
    }
    return 'application/octet-stream';
}

/**
 * @class SuperController
 * @constructor
 * @this {SuperController}
 * @extends EventEmitter
 *
 * Base controller class. Instantiated fresh on every request via `inherits`
 * (`b.apply(this, arguments)` in `lib/inherits/src/main.js:78`), giving each
 * request its own isolated `local` closure. No singleton static properties are
 * maintained. (#M1)
 *
 * @param {object} options - Per-request options injected by the router
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <contact@gina.io>
 *
 * @api         Public
 */
function SuperController(options) {

    //public
    this.name = 'SuperController';
    this.engine = {};


    var self = this;
    //private
    var local = {
        req       : null,
        res       : null,
        next      : null,
        options   : options || null,
        query     : {},
        _data     : {},
        view      : {},
        _queryLog : []
    };

    /**
     * Per-request init — wires `self._options` from the constructor argument.
     * Called on every `new SuperController()` (each request creates a fresh
     * instance via `inherits`: `b.apply(this, arguments)` runs the parent
     * constructor on a brand-new `this` with a brand-new `local` closure).
     * No singleton static properties are used or set. (#M1)
     *
     * @inner
     */
    var init = function() {
        if (local.options) {
            self._options = local.options;
        }
    }


    /**
     * Returns `true` when the current route has a template configured.
     *
     * @inner
     * @returns {boolean}
     */
    var hasViews = function() {
        return ( typeof(local.options.template) != 'undefined' ) ? true : false;
    }

    /**
     * isHttp2
     * Returns `true` if server configured for HTTP/2
     *
     * @returns {boolean} isHttp2
     */
    var isHttp2 = function() {
        var options =  local.options;
        var protocolVersion = ~~options.conf.server.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');
        var httpLib =  options.conf.server.protocol.match(/^(.*)\//)[1] + ( (protocolVersion >= 2) ? protocolVersion : '' );


        return /http2/.test(httpLib)
    }

    /**
     * Returns `true` when response headers have already been sent.
     * Checks both HTTP/2 stream and HTTP/1.1 `res.headersSent`.
     *
     * Also returns `true` when the per-request response refs were already
     * released by a terminal exit (`local.res` is null) — a released response
     * can no longer be written to, so callers' `!headersSent()` guards no-op
     * instead of dereferencing null (#B31).
     *
     * @inner
     * @param {object} [res] - Defaults to `local.res`
     * @returns {boolean}
     */
    var headersSent = function(res) {
        var _res = ( typeof(res) != 'undefined' ) ? res : local.res;
        // #B31 — the per-request response refs may already be released (the
        // terminal-exit triplet: redirect()/renderTEXT()/throwError() and the
        // render delegates set local.res = null once the response is out). A
        // released response cannot be written to anymore, so report it as
        // "sent": callers' existing !headersSent() guards then no-op instead
        // of throwing `Cannot read properties of null (reading 'stream')` —
        // an uncaughtException that proc.js escalates to SIGTERM (bundle kill).
        if ( !_res ) {
            return true;
        }
        if (
            typeof(_res.stream) != 'undefined'
            && typeof(_res.stream.headersSent) != 'undefined'
            // Fixed: was `!= 'null'` (string comparison), which evaluated true for
            // boolean `false` (Http2ServerStream.headersSent before any write), causing
            // self.render() to always fall through to the "Unexpected controller error"
            // error path on HTTP/2. Use strict boolean check instead.
            && _res.stream.headersSent === true
        ) {
            return true
        }

        if ( typeof(_res.headersSent) != 'undefined' ) {
            return _res.headersSent
        }


        return false;
    }
    /**
     * Returns `true` when the server is configured for HTTPS.
     *
     * @inner
     * @returns {boolean}
     */
    var isSecured = function() {
        return /https/.test(local.options.conf.server.scheme)
    }

    /**
     * Returns the current request object.
     *
     * @returns {object} req
     */
    this.getRequestObject = function() {
        return local.req;
    }

    /**
     * Returns the current response object.
     *
     * @returns {object} res
     */
    this.getResponseObject = function() {
        return local.res;
    }

    /**
     * Returns the `next` middleware callback for the current request.
     *
     * @returns {function|null} next
     */
    this.getNextCallback = function() {
        return local.next;
    }

    /**
     * Check if env is running cacheless
     * */
    // replaced: per-request process.env lookup — use cached booleans (#P19)
    this.isCacheless = function() {
        return _isDev;
    }
    /**
     * Check if the project scope is set for local
     * */
    this.isLocalScope = function() {
        return _isLocalScope;
    }
    /**
     * Check if the project scope is set for production
     * */
    this.isProductionScope = function() {
        return _isProdScope;
    }


    /**
     * Inject per-request state into the shared `local` closure.
     * Called by the router on every request before the controller action runs.
     *
     * @param {object}   req     - Incoming request
     * @param {object}   res     - Server response
     * @param {function} next    - Next middleware callback
     * @param {object}   options - Per-request options (conf, template, routing, …)
     * @returns {void}
     */
    this.setOptions = function(req, res, next, options) {
        // #M1 — each request has its own `local` closure; overwrite directly.
        local.options = options;
        local.options.renderingStack = (local.options.renderingStack) ? local.options.renderingStack : [];
        local.options.isRenderingCustomError = (local.options.isRenderingCustomError) ? local.options.isRenderingCustomError : false;

        // #QI — dev-mode query instrumentation: the query log lives on `req` so it
        // survives requireController() and form-validator paths that call setOptions()
        // again with a different controller (and thus a different `local`). Only the
        // FIRST setOptions() for this request creates the array; subsequent calls
        // reuse it. AsyncLocalStorage.enterWith() binds the log to this request's
        // async context so connector queries always push to the correct array,
        // even when concurrent requests interleave.
        // Activated when the Inspector is open locally (_inspectorActive) OR when
        // the request came from a cross-bundle self.query() call with the Inspector
        // header (x-gina-inspector). This ensures QI captures queries on target
        // bundles (e.g. an upstream API bundle) without always-on overhead.
        // #INS10 — also enter capture during a prod instrumentation window. Window-only in prod:
        // the x-gina-inspector header path still requires _isDev, so a spoofed header cannot
        // trigger capture in production (only an explicitly-opened window does).
        if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (_isDev && (process.gina._inspectorActive || (req.headers && req.headers['x-gina-inspector'] === 'true')))) {
            if (!req._devQueryLog) {
                req._devQueryLog = [];
            }
            // #AISTREAM — sibling per-request buffer for AI token-stream inspection,
            // threaded through the SAME _queryALS store for concurrency-correct
            // attribution (the AI connector's stream() reaches it via getStore()).
            if (!req._devAiLog) {
                req._devAiLog = [];
            }
            // #EVTBUS — sibling per-request buffer for observable application
            // events (self.emitEvent / lib.inspectorEvents.emit), threaded through
            // the SAME _queryALS store as queries/AI for concurrency-correct
            // attribution (emit reaches it via getStore()).
            if (!req._devEventLog) {
                req._devEventLog = [];
            }
            local._queryLog = req._devQueryLog;
            local._aiLog    = req._devAiLog;
            local._eventLog = req._devEventLog;
            if (process.gina._queryALS) {
                process.gina._queryALS.enterWith({ _devQueryLog: req._devQueryLog, _devAiLog: req._devAiLog, _devEventLog: req._devEventLog });
            }
            // #FI — propagate request timeline into local for render access
            if (req._devTimeline) {
                local._timeline = req._devTimeline;
            }
        }

        // N.B.: Avoid setting `page` properties as much as possible from the routing.json
        // It will be easier for the framework if set from the controller.
        //
        // Here is a sample if you choose to set  `page.view.title` from the rule
        // ------rouging rule sample -----
        // {
        //    "default": {
        //        "url": ["", "/"],
        //            "param": {
        //            "control": "home",
        //            "title": "My Title"
        //        }
        // }
        //
        // ------controller action sample -----
        // Here is a sample if you decide to set `page.view.title` from your controller
        //
        // this.home = function(req, res, next) {
        //      var data = { page: { view: { title: "My Title"}}};
        //      self.render(data)
        // }

        if ( typeof(options.conf.content.routing[options.rule].param) !=  'undefined' ) {
            var p = options.conf.content.routing[options.rule].param;
            // #B98 — promote the rule-declared title to `page.view.title`.
            // The generic promotion loop that lived here had been inert since
            // its introduction (its dispatch sat after a `continue` that always
            // fired), and every other `param` key already reaches templates
            // through live paths further down:
            //   `:bindings` + static keys -> `page.view.params.<key>`
            //   section                   -> `page.section` (bespoke setter)
            //   file                      -> `page.view.file`
            // `title` was the one promotion with no live equivalent (it is
            // deliberately excluded from `page.view.params`). The route-name
            // write below stays the FALLBACK: `set()` merges target-wins, so
            // this earlier write survives it.
            if ( typeof(p.title) == 'string' && p.title !== '' ) {
                set('page.view.title', p.title);
            }
        }

        local.req = req;
        local.res = res;
        local.next = next;

        getParams(req);
        if (
            typeof(local.options.template) != 'undefined'
            && typeof(local.options.control) != 'undefined'
        ) {
            var  action             = local.options.control
                , rule              = local.options.rule
                , ext               = 'html' // by default
                , isWithoutLayout   = false // by default
                , namespace         = local.options.namespace || ''
            ;

            if (
                typeof(local.options.template) != 'undefined'
                && local.options.template
            ) {
                if (
                    typeof(local.options.template.ext) != 'undefined'
                    && local.options.template.ext
                    && local.options.template.ext != ''
                ) {
                    ext = local.options.template.ext
                }

                if ( !/\./.test(ext) ) {
                    ext = '.' + ext;
                    local.options.template.ext = ext
                }

                if (
                    typeof(local.options.template.layout) == 'undefined'
                    || /^false$/.test(local.options.template.layout)
                    || local.options.template.layout == ''
                ) {
                    isWithoutLayout = true;
                }
            }


            if ( hasViews() ) {

                if ( typeof(local.options.file) == 'undefined') {
                    local.options.file = 'index'
                }

                if ( typeof(local.options.isWithoutLayout) == 'undefined' || !isWithoutLayout ) {
                    local.options.isWithoutLayout = false;
                }

                rule        = local.options.rule;
                namespace   = local.options.namespace || 'default';


                set('page.view.file', local.options.file);
                // replaced: new RegExp('@' + bundle) — use split/join instead (#P1)
                // #B98 — fallback only: a rule-declared `param.title` promoted
                // earlier in setOptions wins (set() merges target-wins), so this
                // route-name write fills the title only when the rule declares none.
                set('page.view.title', rule.split('@' + options.conf.bundle).join(''));
                set('page.view.namespace', namespace);
                // Auto-promote `route.param.section` to `page.section` so templates
                // that compose include paths from the section name (sub-section
                // dispatch from a single index.html that fans out to per-section
                // partials based on the matched route) work without requiring the
                // controller to set `data.page.section` itself.
                if ( local.req && local.req.routing && local.req.routing.param && local.req.routing.param.section ) {
                    set('page.section', local.req.routing.param.section);
                }
            }


            var ctx = getContext('gina');
            // new declaration && overrides
            var arch = process.arch;
            switch (process.arch) {
                case 'x64':
                    arch = 'amd64'
                    break;
                case 'armv7l':
                    arch = 'armhf'
                    break;
                case 'x86':
                    arch = 'i386'
                    break;
                default:
                    break;
            }
            var version = {
                "number"        : ctx.version,
                "platform"      : process.platform,
                "arch"          : arch,
                "nodejs"        : process.versions.node,
                "middleware"    : ctx.middleware
            };

            set('page.environment.memory allocated', (require('v8').getHeapStatistics().heap_size_limit / (1024 * 1024 * 1024)).toFixed(2) +' GB');
            if ( self.isLocalScope() ) {
                const mem = process.memoryUsage();
                set('page.environment.memory heap', `${(mem.heapUsed / 1024 / 1024).toFixed(2)} MB` );
            }

            set('page.environment.gina', version.number);
            // gina-container (daemonless launcher) injects no GINA_PID global — fall back to this pid
            set('page.environment.gina pid', getEnvVar('GINA_PID') || String(process.pid));
            set('page.environment.nodejs', version.nodejs +' '+ version.platform +' '+ version.arch);
            set('page.environment.engine', options.conf.server.engine);//version.middleware
            set('page.environment.uvThreadpoolSize', process.env.UV_THREADPOOL_SIZE);
            set('page.environment.env', process.env.NODE_ENV);
            // replaced: per-request process.env lookups — use cached booleans (#P19)
            set('page.environment.envIsDev', _isDev);
            set('page.environment.scope', process.env.NODE_SCOPE);
            set('page.environment.scopeIsLocal', _isLocalScope);
            set('page.environment.scopeIsProduction', _isProdScope);
            set('page.environment.date.now', new Date().format("isoDateTime"));
            set('page.environment.isCacheless', self.isCacheless());

            // var requestPort = req.headers.port || req.headers[':port'];
            // var isProxyHost = (
            //     typeof(req.headers.host) != 'undefined'
            //     && typeof(requestPort) != 'undefined'
            //     &&  /^(80|443)$/.test(requestPort)
            //     && local.options.conf.server.scheme +'://'+ req.headers.host +':'+ requestPort != local.options.conf.hostname.replace(/\:\d+$/, '') +':'+ local.options.conf.server.port
            //     ||
            //     typeof(req.headers[':authority']) != 'undefined'
            //     && local.options.conf.server.scheme +'://'+ req.headers[':authority'] != local.options.conf.hostname
            //     ||
            //     typeof(req.headers.host) != 'undefined'
            //     && typeof(requestPort) != 'undefined'
            //     && /^(80|443)$/.test(requestPort)
            //     && req.headers.host == local.options.conf.host
            //     ||
            //     typeof(req.headers['x-nginx-proxy']) != 'undefined'
            //     && /^true$/i.test(req.headers['x-nginx-proxy'])
            // ) ? true : false;
            // setContext('isProxyHost', isProxyHost);
            // #B66 S2b — the routing-clone gate (drives the _proxyHostname derivation
            // + the per-route host rewrite below) AND the browser-whispered proxy host
            // (page.environment.proxyHost/proxyHostname -> gina.config.* via loader.js)
            // read THIS request's per-request #B65 classification (local.req slots)
            // instead of the sticky worker-global latch, so a mixed proxied+direct (or
            // concurrent multi-host) worker resolves the request in hand, not the last
            // proxied global. The worker-global stays the fallback for req-less/Express
            // paths that never set the slots.
            var isProxyHost = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false );
            set('page.environment.isProxyHost', isProxyHost);
            if ( /^true$/.test(isProxyHost) ) {
                set('page.environment.proxyHost', ( local.req && local.req._ginaProxyHost ) ? local.req._ginaProxyHost : process.gina.PROXY_HOST);
                set('page.environment.proxyHostname', ( local.req && local.req._ginaProxyHostname ) ? local.req._ginaProxyHostname : process.gina.PROXY_HOSTNAME);
            }

            var _config = ctx.config.envConf[options.conf.bundle][process.env.NODE_ENV];
            // by default
            var hostname    = _config.hostname + _config.server.webroot;
            var scheme      = hostname.match(/^(https|http)/)[0];
            var requestPort = (local.req.headers.port||local.req.headers[':port']);

            var hostPort = hostname.match(/(\:d+\/|\:\d+)$/);
            hostPort = (hostPort) ? ~~(hostPort[0].replace(/\:/g, '')) : _config.port[_config.server.protocol][_config.server.scheme];
            // Linking bundle B from bundle A wihtout proxy
            var isSpecialCase = (
                    getContext('bundle') != _config.bundle
                    && requestPort != hostPort
                    && local.req.headers[':host'] != process.gina.PROXY_HOST
            ) ? true : false;

            if (isSpecialCase) {
                hostname = _config.hostname;
            }

            // if (
            //     isProxyHost
            //     && !isSpecialCase
            // ) {
            //     // Rewrite hostname vs req.headers.host
            //     hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']);

            //     if (
            //         !/^(80|443)$/.test(requestPort)
            //         && !new RegExp(requestPort+'$').test(hostname)
            //     ) {
            //         hostname += ':'+ requestPort;
            //     }
            // }

            // #B66 — the hostname whispered to the browser (gina.config.hostname).
            // On a proxied deployment (per-request #B65 classification) whisper the
            // PUBLIC host-only origin (scheme://public-host, port-less — the webroot is
            // whispered separately below) instead of the bundle's INTERNAL
            // scheme://host:port(+webroot). This closes an information-disclosure AND
            // lets the browser routing self-check flip isProxyHost=true (it cannot while
            // the whispered value carries a port/webroot the self-check can't strip), so
            // cross-bundle toUrl resolves same-origin. The internal `hostname` var above
            // is left byte-identical — it still feeds _proxyHostname + the routing clone
            // below. RAW (direct host:port) whispers the internal value, byte-identical.
            // `_ginaProxyHostname` is the per-request #B65 slot (host-only, forwarded
            // scheme); per-request (NOT a process-global) so it can't leak across a mix
            // of proxied + direct requests. See server.isaac.js for the writer.
            var _publicHostname = hostname;
            if ( local.req && local.req._ginaIsProxyHost === true && local.req._ginaProxyHostname ) {
                _publicHostname = local.req._ginaProxyHostname;
            }
            set('page.environment.hostname', _publicHostname);
            // Updating _config.rootDomain - 2024/04/15
            // _config.rootDomain = domainLib.getRootDomain(hostname).value;


            set('page.environment.rootDomain', _config.rootDomain);
            // Public webroot — composed from the X-Forwarded-Prefix the reverse
            // proxy advertised (captured by server.isaac.js into the per-request
            // `req._ginaProxyPrefix` slot) and the bundle's internal
            // server.webroot. The bundle stays unaware of its public mount
            // path; only this output value (templated into gina.onload.min.js →
            // gina.config.webroot AND into the synchronous window.__ginaWebroot
            // global) carries the prefix so browser-side URL construction
            // (/_gina/assets/routing.json, the gina.min.css link injection,
            // etc.) targets the correct upstream through the proxy. Internal
            // disk-path resolution and asset URL rewriting still use
            // options.conf.server.webroot directly.
            //
            // Per-request slot (NOT a process-global) so the prefix cannot
            // leak across requests when the worker handles a mix of proxied +
            // direct calls. See server.isaac.js for the writer.
            var _publicWebroot = options.conf.server.webroot;
            if ( local.req && typeof(local.req._ginaProxyPrefix) != 'undefined' && local.req._ginaProxyPrefix ) {
                var _prefix = local.req._ginaProxyPrefix;
                var _wr     = _publicWebroot.replace(/^\/+/, '');
                _publicWebroot = _prefix + '/' + _wr;
                if ( !/\/$/.test(_publicWebroot) ) {
                    _publicWebroot += '/';
                }
            }
            set('page.environment.webroot', _publicWebroot);

            if ( typeof(ctx.config.envConf._isRoutingUpdateNeeded) == 'undefined') {
                ctx.config.envConf._isRoutingUpdateNeeded = false;
            }

            // #B67 — a hostname must never carry a webroot. Previously this wrote
            // `hostname` (= _config.hostname + server.webroot), so getRoute's
            // `PROXY_HOSTNAME || envConf._proxyHostname` fallback (main.js:1105)
            // appended a child bundle's webroot to a value already ending in the
            // parent's webroot -> the <host>/<webroot>//<webroot> blend. Write the
            // host-only `_config.hostname`; the primary public-host resolution now
            // comes from the engine-agnostic PROXY_HOSTNAME refresh (router.js),
            // leaving this a webroot-free fallback. Compare host-only too, so the
            // change-detection does not spuriously refire every request.
            if (
                typeof(ctx.config.envConf._proxyHostname) == 'undefined'
                ||
                _config.hostname != ctx.config.envConf._proxyHostname
            ) {
                ctx.config.envConf._proxyHostname = (isProxyHost) ? _config.hostname : null;
                ctx.config.envConf._isRoutingUpdateNeeded = true;
            }

            if ( typeof(ctx.config.envConf._routingCloned) == 'undefined' ) {
                ctx.config.envConf._routingCloned = JSON.clone(ctx.config.envConf.routing);
            }

            var routing = local.options.conf.routing = ctx.config.envConf._routingCloned; // all routes
            if ( String(ctx.config.envConf._isRoutingUpdateNeeded).toLowerCase() === 'true' ) {

                // replaced: for...in — use Object.keys() (#P22)
                var routingKeys = Object.keys(ctx.config.envConf.routing);
                for (var ri = 0; ri < routingKeys.length; ++ri) {
                    var r = routingKeys[ri];
                    if ( isProxyHost ) {
                        local.options.conf.routing[r].host = hostname.replace(/^(https|http)\:\/\//, '');
                        local.options.conf.routing[r].hostname = hostname;
                        var scheme = hostname.match(/^(https|http)/)[0];
                        local.options.conf.routing[r].hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']);
                        var requestPort = (local.req.headers.port||local.req.headers[':port']);
                        // replaced: /^(80|443)$/ + new RegExp(requestPort+'$') — use string methods (#P1, #P12)
                        if (
                            requestPort !== '80' && requestPort !== '443' && requestPort !== 80 && requestPort !== 443
                            && !local.options.conf.routing[r].hostname.endsWith('' + requestPort)
                        ) {
                            local.options.conf.routing[r].hostname += ':'+ requestPort
                        }
                        continue;
                    }
                    // #B423 — copy only what the source actually HAS. A `redirect`
                    // rule is deliberately excluded from the host/hostname defaulting
                    // (config.js gates it on `!/^redirect$/.test(param.control)`), so
                    // those keys are ABSENT on such rules — and an unconditional copy
                    // assigned `undefined`, CREATING own properties valued `undefined`
                    // on `_routingCloned`. That object is cached on envConf for the
                    // process lifetime, so every later no-arg `getConfig()` ->
                    // `JSON.clone(local.options.conf)` walked into the rule, hit
                    // `source[key] === undefined` and emitted the clone's
                    // "should not be left `undefined`. Assigning to `null`" warn —
                    // once per redirect rule per clone, forever. Absent stays absent.
                    if ( typeof(ctx.config.envConf.routing[r].host) != 'undefined' ) {
                        local.options.conf.routing[r].host = ctx.config.envConf.routing[r].host;
                    }
                    if ( typeof(ctx.config.envConf.routing[r].hostname) != 'undefined' ) {
                        local.options.conf.routing[r].hostname = ctx.config.envConf.routing[r].hostname;
                    }
                }
                ctx.config.envConf._isRoutingUpdateNeeded = false;

            }
            // Adding 289 KB of datas in the page when including routing & reverseRouting
            // set('page.environment.routing', encodeRFC5987ValueChars(JSON.stringify(routing))); // export for GFF
            set('page.environment.routing',encodeRFC5987ValueChars('{}'));

            //// reverseRouting
            var reverseRouting = local.options.conf.reverseRouting = ctx.config.envConf.reverseRouting; // all routes
            // set('page.environment.reverseRouting', encodeRFC5987ValueChars(JSON.stringify(reverseRouting))); // export for GFF
            set('page.environment.reverseRouting',encodeRFC5987ValueChars('{}'));

            var forms = local.options.conf.forms = options.conf.content.forms // all forms
            // #B344 -- the `mocks` group (dev fixture data walked from `<bundle>/forms/mocks/`)
            // is server-side only: the client bundle consumes `rules` (validator live-check)
            // and `validators` (user-defined validators), never `mocks` -- so the whispered
            // export excludes it in EVERY env (uniform client contract, page weight).
            // Shallow copy only: `forms` is the SHARED per-process catalog reference also
            // grafted below (`conf.forms`, `page.forms`) -- never mutate it.
            var _whisperedForms = {};
            if ( forms && typeof(forms) == 'object' ) {
                // replaced: for...in -- use Object.keys() (#P22)
                var _formsGroups = Object.keys(forms);
                for (var _fgi = 0; _fgi < _formsGroups.length; ++_fgi) {
                    if (_formsGroups[_fgi] === 'mocks') continue;
                    _whisperedForms[_formsGroups[_fgi]] = forms[_formsGroups[_fgi]];
                }
            }
            set('page.environment.forms', encodeRFC5987ValueChars(JSON.stringify(_whisperedForms))); // export for GFF (#B344: minus `mocks`)
            set('page.forms', options.conf.content.forms);



            set('page.environment.bundle', options.conf.bundle);
            set('page.environment.project', options.conf.projectName);
            set('page.environment.protocol', options.conf.server.protocol);
            set('page.environment.scheme', options.conf.server.scheme);
            set('page.environment.port', options.conf.server.port);
            set('page.environment.debugPort', options.conf.server.debugPort);
            set('page.environment.pid', process.pid);
            // Whisper the request's negotiated culture (server.js negotiateCulture,
            // underscore form e.g. `fr_FR`) to the browser as `gina.config.culture`,
            // so the client validator can select app-registered per-culture built-in
            // rule labels. Empty string when i18n is inactive / no culture negotiated.
            set('page.environment.culture', (req && req.culture) ? req.culture : '');
            // #i18n (client whisper) — resolve the negotiated culture's built-in rule
            // label subset from the bundle catalog (`_validator.<rule>`) and whisper it
            // as `gina.config.validatorLabels`, so the client validator overlays the
            // localized labels even without an app `setErrorLabels()` call. Only the
            // present (app-defined) keys are emitted — English defaults are filled
            // client-side (keeps the payload small). `{}` when i18n is inactive or no
            // `_validator` node exists for the culture. The resolver chain mirrors the
            // server FormValidator overlay (form-validator.js): walkFallback ->
            // getCatalog -> resolveKey('_validator') — keep the two in sync.
            var _validatorLabels = {};
            if ( req && typeof(req.culture) === 'string' && req.culture && lib.i18n ) {
                try {
                    var _vlChain = lib.i18n.walkFallback(req.culture);
                    for (var _vli = 0; _vli < _vlChain.length; _vli++) {
                        var _vlCat = lib.i18n.getCatalog(options.conf.bundle, _vlChain[_vli]);
                        if (_vlCat) {
                            var _vlNode = lib.i18n.resolveKey(_vlCat, '_validator');
                            if (_vlNode && typeof(_vlNode) === 'object') { _validatorLabels = _vlNode; break; }
                        }
                    }
                } catch (_vlErr) { _validatorLabels = {}; }
            }
            set('page.environment.validatorLabels', encodeRFC5987ValueChars(JSON.stringify(_validatorLabels)));

            // #CSRF2 — expose CSRF token + pre-formatted hidden input to swig templates.
            // The Csrf plugin (core/plugins/lib/csrf/src/main.js) attaches `req.csrfToken`
            // when the bundle has registered the middleware. When absent (bundle hasn't
            // adopted the plugin), neither key is exposed — templates guard with
            // `{% if gina.csrfToken %}`. Field name comes from settings.csrf.fieldName
            // (default `_csrf`) and is HTML-attribute-escaped defensively, even though
            // the plugin already restricts it to a settings-controlled string. The
            // token itself is base64url ([A-Za-z0-9_-]) so it needs no escaping.
            if ( local.req && typeof(local.req.csrfToken) == 'string' && local.req.csrfToken ) {
                var _csrfFieldName = '_csrf';
                try {
                    var _csrfSettings = options
                        && options.conf
                        && options.conf.content
                        && options.conf.content.settings
                        && options.conf.content.settings.csrf;
                    if ( _csrfSettings && typeof(_csrfSettings.fieldName) == 'string' && _csrfSettings.fieldName ) {
                        _csrfFieldName = _csrfSettings.fieldName;
                    }
                } catch (e) { /* fall back to default '_csrf' */ }

                var _escapedFieldName = String(_csrfFieldName)
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;')
                    .replace(/</g, '&lt;')
                    .replace(/>/g, '&gt;');

                set('gina.csrfToken', local.req.csrfToken);
                set('gina.csrfInput',
                    '<input type="hidden" name="' + _escapedFieldName + '" value="' + local.req.csrfToken + '">'
                );
            }


            set('page.view.ext', ext);
            set('page.view.control', action);
            set('page.view.controller', local.options.controller.replace(options.conf.bundlesPath, ''), true);
            if (typeof (local.options.controlRequired) != 'undefined' ) {
                set('page.view.controlRequired', local.options.controlRequired);
            }
            set('page.view.method', local.options.method);
            set('page.view.namespace', namespace); // by default
            set('page.view.url', req.url);
            if ( local.options.template ) {
                // replaced: new RegExp(templates+'/') — use split/join instead (#P1)
                set('page.view.layout', local.options.template.layout.split(local.options.template.templates+'/').join('').split('/').slice(1).join('/'));
                set('page.view.html.properties.mode.javascriptsDeferEnabled', local.options.template.javascriptsDeferEnabled);
                set('page.view.html.properties.mode.routeNameAsFilenameEnabled', local.options.template.routeNameAsFilenameEnabled);
            }


            if ( String(self.serverInstance._cacheIsEnabled).toLowerCase() === 'true' ) {
                set('page.view.cacheIsEnabled', self.serverInstance._cacheIsEnabled);
                set('page.view.cacheKey', "static:"+ local.req.url);
                // Some routes might not have caching strategy
                if ( typeof(local.req.routing.cache) != 'undefined' && local.req.routing.cache != null ) {
                    var cachingOption = ( typeof(local.req.routing.cache) == 'string' ) ? { type: local.req.routing.cache } : JSON.clone(local.req.routing.cache);
                    if ( typeof(cachingOption.ttl) == 'undefined' ) {
                        cachingOption.ttl = local.options.conf.server.cache.ttl
                    }
                    set('page.view.cacheType', cachingOption.type);
                    set('page.view.cacheTTL', cachingOption.ttl);
                } else {
                    set('page.view.cacheType', 'Not configured for this route');
                }
            }


            var parameters = JSON.clone(req.getParams());
            parameters = merge(parameters, options.conf.content.routing[rule].param);
            // excluding default page properties
            delete parameters[0];
            delete parameters.file;
            delete parameters.control;
            delete parameters.title;

            if (parameters.count() > 0)
                set('page.view.params', parameters); // view parameters passed through URI or route params

            set('page.view.route', rule);


            // gina-container injects no GINA_CULTURE global — fall back to the framework default
            var acceptLanguage = getEnvVar('GINA_CULTURE') || 'en_CM'; // by default : language-COUNTRY
            if ( typeof(req.headers['accept-language']) != 'undefined' ) {
                acceptLanguage = req.headers['accept-language']
            } else if ( typeof(local.options.conf.server.response.header['accept-language']) != 'undefined' ) {
                acceptLanguage = local.options.conf.server.response.header['accept-language']
            }

            // set user locale: region & culture
            var userCulture     = acceptLanguage.split(',')[0];
            // #I18N1 slice 3 — prefer the formalised req.culture when the
            // request-pipeline negotiator set it (covers URL prefix and
            // cookie sources that the legacy Accept-Language-only block
            // above ignores). Converted underscore → hyphen because the
            // downstream region-data lookup splits on `-`. They agree in
            // the common case (no URL prefix, no cookie); they diverge
            // when negotiation picked a higher-priority source.
            if ( req.culture && typeof req.culture === 'string' ) {
                userCulture = req.culture.replace(/_/g, '-');
            }
            var userCultureCode = userCulture.split(/\-/);
            var userLangCode    = userCultureCode[0];
            var userCountryCode = userCultureCode[1];

            // #P39 — memoized language index over the boot-static locales
            // context (was: a per-request Collection deep-copying every region
            // set and minting an id per record, twice, to answer two lookups).
            var localesIdx      = _resolveLocalesIndex();
            var userLangRow     = localesIdx[userLangCode];
            var userLocales     = null;

            try {
                userLocales = userLangRow.content;
            } catch (err) {
                // #B100 — guarded fallback: the old blind `region.shortCode` deref
                // threw here when the `region` block was absent, and the unguarded
                // fallback lookup threw when the resolved language was not in the
                // loaded region set.
                var _fallbackLang    = getLocaleFallbackLang(local.options.conf);
                console.warn('language code `'+ userLangCode +'` not handled by current locales setup: replacing by default: `'+ _fallbackLang +'`');
                var _fallbackLocales = localesIdx[_fallbackLang] || localesIdx['en'];
                userLocales = ( _fallbackLocales && _fallbackLocales.content ) ? _fallbackLocales.content : [];
            }

            // user locales list
            // #P39 — materialized lazily: the request's own deep copy is built
            // on first read (see _defineLazyLocales), so a request that never
            // reads `conf.locales` — the common case — no longer pays a copy
            // of the whole region set.
            _defineLazyLocales(local.options.conf, userLocales);

            // user locale
            // #B101 — region rows key countries by `isoShort` (uppercase ISO
            // 3166-1 alpha-2); the historical `short` filter matched a key the
            // data never carried, so this resolved `{}` whenever a country code
            // was present — and an arbitrary first record without one, because
            // a filter whose only key is undefined-valued serializes to `{}`
            // and matches everything. A country-less culture (bare `en`) now
            // resolves to an explicit `{}` instead.
            // #P39 — the row comes from the culture memo (shared, pristine) and
            // is deep-copied per request: the `.date` write a few lines below —
            // and anything a template or an action does to `page.view.locale` —
            // must never reach a sibling request.
            options.conf.locale = ( typeof(userCountryCode) == 'string' && userCountryCode.length > 0 )
                ? ( JSON.clone( _resolveLocaleRow(userLocales, userLangCode, userCountryCode) || {} ) )
                : {};

            // current date
            if ( typeof(options.conf.locale) == 'undefined' || !options.conf.locale ) {
                options.conf.locale = {}
            }
            options.conf.locale.date = {
                now: new Date().format("isoDateTime")
            }
            set('page.view.locale', options.conf.locale);
            // #A11Y3 — `userCulture` is underscore-form (`en_CM`) and, when it came from a
            // raw `accept-language`, can still carry a q-value (`fr;q=0.9`). Neither is a
            // valid BCP-47 `lang` attribute. Only the value that reaches the document is
            // normalised — the locale lookup above deliberately keeps the raw form, whose
            // resolution behaviour is out of scope here.
            set('page.view.lang', a11yLangTag({ culture: userCulture }));
        }


        //TODO - detect when to use swig
        var dir = null;
        if (local.options.template || self.templates) {
            dir = local.options.template.html || self.templates;

            // Output auto-escaping — this per-render setDefaults GOVERNS the
            // default (no-loader) render path: it re-applies swig defaults on
            // every request, overriding initSwigEngine's boot default. So it must
            // read the SAME bundle setting (settings.swig.autoescape, mirroring
            // settings.nunjucks.autoescape). `_tSwig` is guarded to {} exactly as
            // initSwigEngine guards `_swigSettings`, so the strict `=== true`
            // select yields a real boolean: ABSENT ⇒ false (unchanged behaviour,
            // byte-identical to the old `: false` — including the JSON.clone'd
            // copy read by swig.getOptions(), where an `undefined` would be
            // dropped); a non-boolean value was already refused at boot by
            // initSwigEngine.
            var _swigAutoescape = false;
            try {
                var _tSwig = ( getConfig()[local.options.conf.bundle][local.options.conf.env].content.settings.swig ) || {};
                _swigAutoescape = ( _tSwig.autoescape === true );
            } catch (_swigAeErr) {
                _swigAutoescape = false;
            }
            var swigOptions = {
                // was: autoescape: ( typeof(local.options.autoescape) != 'undefined') ? local.options.autoescape : false,
                autoescape  : _swigAutoescape,
                // `memory` is no working yet ... advanced rendering setup required
                // cache       : (local.options.isCacheless) ? false : 'memory'
                cache       : false
            };
            if (dir) {
                // #TPL2 — confined loader (mirrors core/server.js initSwigEngine).
                // gina's processed layout cache is now in-root (.gina-layout-cache
                // under the templates root) and the dev statusbar is inlined, so no
                // template resolves outside the bundle templates root. swig-core's
                // basepath confinement (CVE-2023-25345, allowOutsideRoot defaults
                // false) therefore guards every resolution, including untrusted
                // nested {% include %} / {% import %}.
                swigOptions.loader = swig.loaders.fs(dir);
            }
            if ( typeof(local._swigOptions) == 'undefined' ) {
                local._swigOptions = JSON.clone(swigOptions);
            }
            swig.setDefaults(swigOptions);
            // used for self.engine.compile(tpl, swigOptions)(swigData)
            swig.getOptions = function() {
                return local._swigOptions;
            }
            // preserve the same timezone as the system
            var defaultTZOffset = new Date().getTimezoneOffset();
            swig.setDefaultTZOffset(defaultTZOffset);
            defaultTZOffset = null;


            self.engine = swig;

            dir = null;
            swigOptions = null;

        }

    }

    /**
     * Set a value in the render data tree (`local.userData`) by dotted path.
     *
     * `set('page.view.title', 'Home')` writes `local.userData.page.view.title`,
     * creating missing intermediates as plain objects and REPLACING an
     * intermediate that is not a plain object (`null`, an array, a primitive) —
     * the same rule `lib/merge` applies when it descends. Contract at the leaf:
     *
     *  - first write wins: a later `set()` to an existing leaf keeps the existing
     *    value. The `override` argument is accepted for signature compatibility
     *    and is INERT — it never reached the merge in the previous implementation
     *    either (#B427);
     *  - an object written onto an existing object leaf deep-fills it (missing
     *    keys added, existing keys kept), through `lib/merge`;
     *  - a first-write value is stored BY REFERENCE and is never walked, copied
     *    or mutated — `set('page.forms', conf.content.forms)` must not touch the
     *    shared per-process forms catalog.
     *
     * #P39 slice 2 (2026-08-27) — was: a JSON-string path builder + JSON.parse
     * + a `parseDataObject` walk + a merge of the built subtree into
     * `local.userData`, per call. That merge recursed into every grafted object
     * value and re-merged each array inside it with itself, which cost
     * 0.4–1.5 ms per request for a real forms catalog AND swapped the shared
     * catalog's arrays for copies on every request (a mutation of the caller's
     * object). Measured ×4.5 on the 59 primitive sets of a render and ×800+ on
     * the catalog set. Equivalence to the retired implementation is pinned by
     * test/core/controller-set-path.test.js.
     *
     * @param {string} name - dotted path (`a.b.c`); a name without a dot is a flat key
     * @param {*} value - value to store; a flat key's value must be a string (backslashes stripped)
     * @param {boolean} [override] - accepted, inert: first write wins (#B427)
     *
     * @returns {void}
     *
     * @throws {Error} when a path segment is `__proto__` (it would write through the prototype accessor)
     *
     * @example
     * set('page.view.title', 'Home');
     * set('page.view.title', 'Other');          // ignored — first write wins
     * set('page.forms', conf.content.forms);    // stored by reference, never mutated
     * */
    var set = function(name, value, override) {

        if ( typeof(name) == 'string' && /\./.test(name) ) {
            var keys = name.split(/\./g), last = keys.length - 1;
            var node = local.userData;
            if ( node === null || typeof(node) != 'object' ) {
                node = local.userData = {};
            }
            for (var i = 0; i < last; ++i) {
                var k = keys[i];
                if (k === '__proto__') {
                    throw new Error('[SuperController::set] `__proto__` is not a valid path segment in `' + name + '`');
                }
                var next = node[k];
                if ( next === null || typeof(next) != 'object' || Array.isArray(next) ) {
                    next = node[k] = {};
                }
                node = next;
            }
            var leaf = keys[last];
            if (leaf === '__proto__') {
                throw new Error('[SuperController::set] `__proto__` is not a valid path segment in `' + name + '`');
            }
            if ( typeof(node[leaf]) == 'undefined' ) {
                // first write: by reference — the value is not walked, copied or mutated
                node[leaf] = value;
            } else {
                // collision: the exact leaf-level branch the retired whole-tree merge reached
                var one = {};
                one[leaf] = value;
                merge(node, one);
            }
        } else if ( typeof(local.userData[name]) == 'undefined' ) {
            local.userData[name] = value.replace(/\\/g, '');
        }
    }

    /**
     * Get data
     *
     * @param {String} variable Data name to set
     * @returns {Object | String} data Data object or String
     * */
    var get = function(variable) {
        return local.userData[variable]
    }

    /**
     * Set resources
     *
     * @param {object} template - template configuration
     * */
    var setResources = function(viewConf) {
        if (!viewConf) {
            return self.throwError(500, new Error('No views configuration found. Did you try to add views before using Controller::render(...) ? Try to run: gina view:add '+ options.conf.bundle +' @'+ options.conf.projectName));
        }

        var authority = ( typeof(local.req.headers['x-forwarded-proto']) != 'undefined' ) ? local.req.headers['x-forwarded-proto'] : local.options.conf.server.scheme;
        authority += '://'+ local.req.headers.host;
        var useWebroot = false;
        if (
            local.options.conf.server.webroot !== '/'
            && local.options.conf.server.webroot.length > 0
            // && local.options.conf.hostname.replace(/\:\d+$/, '') == authority
        ) {
            useWebroot = true
        }
        authority = null;

        // replaced: new RegExp('^'+ webroot) — use startsWith instead (#P1)
        var _webroot = local.options.conf.server.webroot;

        var cssStr      = ''
            , jsStr     = ''
        ;
        //Get css
        if( viewConf.stylesheets ) {
            // cssStr  = getNodeRes('css', viewConf.stylesheets, useWebroot, reURL);
            // Fixed on 2025-03-08: ordered by route, making sure that _common could all be loaded first
            var cssColl = new Collection(viewConf.stylesheets).orderBy({route: 'asc'})
            cssStr   = getNodeRes('css', cssColl, useWebroot, _webroot);
            cssColl = null;
        }
        //Get js
        if( viewConf.javascripts ) {
            // jsStr   = getNodeRes('js', viewConf.javascripts, useWebroot, reURL);
            // Fixed on 2025-03-08: ordered by route, making sure that _common could all be loaded first
            var jsColl = new Collection(viewConf.javascripts).orderBy({route: 'asc'})
            jsStr   = getNodeRes('js', jsColl, useWebroot, _webroot);
            jsColl = null;
        }

        set('page.view.stylesheets', cssStr);
        set('page.view.scripts', jsStr);

        _webroot = null;
        cssStr  = null;
        jsStr   = null;
    }

    /**
     * Get node resources — builds the `<link>` (css) / `<script>` (js) tag
     * string for the view's declared assets.
     *
     * #OW3 — when the bundle opted in via templates.json `"sriEnabled": true`,
     * every same-origin asset that resolves to a readable file on disk gets an
     * `integrity="sha384-..." crossorigin="anonymous"` attribute pair
     * (computed by lib/sri, fail-open), and its HTTP/2 preload hint is
     * suppressed (the hint carries no integrity metadata, so a hinted fetch
     * could not be matched to the integrity-checked consumer).
     *
     * @param {string} type - `'css'` or `'js'`
     * @param {array} resArr
     * @param {boolean} useWebroot
     * @param {string} webrootStr - Webroot string prefix for startsWith check (#P1)
     *
     * @returns {string} tag string to inject into the layout
     *
     * @private
     * */
    var getNodeRes = function(type, resArr, useWebroot, webrootStr) {

        var r               = 0
            , rLen          = resArr.length
            , obj           = null
            , str           = ''
            // #B66 S2b — read THIS request's per-request #B65 proxy classification
            // (slot) instead of the sticky worker-global latch; worker-global stays
            // the fallback for req-less/Express paths that never set the slot.
            , isProxyHost   = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false )
            , requestHost   = ( /http\/2/.test(local.options.conf.server.protocol) )
                    ? local.req.headers[':host']
                    : local.req.headers.host
            , hostname      = ( typeof(requestHost) != 'undefined' && local.options.conf.host != requestHost)
                    ? local.options.conf.server.scheme +'://'+ requestHost
                    : local.options.conf.hostname
            , scheme = hostname.match(/^(https|http)/)[0]
        ;
        var requestPort = (local.req.headers.port||local.req.headers[':port']);
        var hostPort = local.options.conf.hostname.match(/(\:d+\/|\:\d+)$/);
        hostPort = (hostPort) ? ~~(hostPort[0].replace(/\:/g, '')) : local.options.conf.port[local.options.conf.server.protocol][local.options.conf.server.scheme];
        // Linking bundle B from bundle A wihtout proxy
        var isSpecialCase = (
                getContext('bundle') != local.options.conf.bundle
                && requestPort != hostPort
                && local.req.headers[':host'] != process.gina.PROXY_HOST
        ) ? true : false;

        if (isSpecialCase) {
            hostname = local.options.conf.hostname
        }

        // #OW3 — opt-in Subresource Integrity (templates.json `"sriEnabled": true`).
        // Attribute computation is fully delegated to lib/sri, which is
        // fail-open by design: an asset that cannot be honestly hashed
        // (external URL, unresolvable path, unreadable file) simply gets no
        // integrity attribute and loads exactly as before.
        var sriEnabled = (local.options.template.sriEnabled) ? true : false;


        if (
            isProxyHost
            && !isSpecialCase
        ) {

            // #B66 S2b — last-resort host fallback prefers THIS request's slot over the
            // worker-global (local.req is guaranteed here — headers are dereferenced above).
            hostname    = scheme + '://'+ (local.req.headers.host||local.req.headers[':host']||local.req._ginaProxyHost||process.gina.PROXY_HOST);

            // replaced: /^(80|443)$/ + new RegExp(requestPort+'$') — use string methods (#P1, #P12)
            if (
                requestPort !== '80' && requestPort !== '443' && requestPort !== 80 && requestPort !== 443
                && !hostname.endsWith('' + requestPort)
            ) {
                hostname += ':'+ requestPort;
            }
        }

        switch(type){
            case 'css':
                for (; r < rLen; ++r) {
                    obj = resArr[r];
                    if (useWebroot && !obj.url.startsWith(webrootStr) ) {
                        obj.url = local.options.conf.server.webroot + obj.url.substring(1);
                    }
                    // #OW3 — SRI attribute pair for same-origin disk-resolvable
                    // assets when the bundle opted in; '' otherwise (fail-open).
                    var sriAttributes = (sriEnabled) ? lib.sri.getIntegrityAttributes(obj.url, local.options.conf, local.options.conf.server.webroot) : '';
                    // HTTP2 Push via Link
                    if (
                        /http\/2/.test(local.options.conf.server.protocol)
                        && !self.isCacheless()
                        // #OW3 — no preload hint for an SRI'd asset: the hint
                        // carries no integrity metadata, so a hinted fetch may
                        // not match the integrity-checked consumer and would
                        // then be a wasted double-fetch.
                        && !sriAttributes
                    ) {
                        local.options.template.h2Links += '<'+ obj.url +'>; as=style; rel=preload,'
                    }
                    // TODO - add support for cdn
                    // Remove this part, since it is best to work with relative paths
                    // if (!/\:\/\//.test(obj.url) ) {
                    //     obj.url = hostname + obj.url;
                    // }

                    if (obj.media) {
                        str += '\n\t\t<link href="'+ obj.url +'" media="'+ obj.media +'" rel="'+ obj.rel +'" type="'+ obj.type +'"'+ sriAttributes +'>';
                    } else {
                        str += '\n\t\t<link href="'+ obj.url +'" rel="'+ obj.rel +'" type="'+ obj.type +'"'+ sriAttributes +'>';
                    }
                }
                break;

            case 'js':
                var deferMode = (local.options.template.javascriptsDeferEnabled) ? ' defer' : '';

                for (; r < rLen; ++r) {
                    obj = resArr[r];
                    if (useWebroot && !obj.url.startsWith(webrootStr) ) {
                        obj.url = local.options.conf.server.webroot + obj.url.substring(1);
                    }
                    // #OW3 — SRI attribute pair for same-origin disk-resolvable
                    // assets when the bundle opted in; '' otherwise (fail-open).
                    var sriAttributes = (sriEnabled) ? lib.sri.getIntegrityAttributes(obj.url, local.options.conf, local.options.conf.server.webroot) : '';
                    // HTTP2 Push via Link
                    if (
                        /http\/2/.test(local.options.conf.server.protocol)
                        && !self.isCacheless()
                        // #OW3 — no preload hint for an SRI'd asset: the hint
                        // carries no integrity metadata, so a hinted fetch may
                        // not match the integrity-checked consumer and would
                        // then be a wasted double-fetch.
                        && !sriAttributes
                    ) {
                        local.options.template.h2Links += '<'+ obj.url +'>; as=script; rel=preload,'
                    }
                    // TODO - add support for cdn
                    // Remove this part, since it is best to work with relative paths
                    // if (!/\:\/\//.test(obj.url) ) {
                    //     obj.url = hostname + obj.url;
                    // }


                    if ( /\/jquery\.(.*)\.(min\.js|js)$/i.test(obj.url) ) {
                        console.warn('jQuery Plugin found in templates.json !\nIf you want to load it before [gina.min.js], you should declare it at the top of your handler using requireJS or add property "isExternalPlugin: true" in your templates.json, under: '+ (obj.route || local.req.routing.rule) +' .');
                    }
                    // Allow jQuery & other external plugins to be loaded in the HEAD section before gina
                    if (
                        obj.isExternalPlugin
                    ) {
                        local.options.template.externalPlugins.splice(1, 0, '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"'+ sriAttributes +'></script>');
                    }
                    else {
                        // normal case
                        str += '\n\t\t<script'+ deferMode +' type="'+ obj.type +'" src="'+ obj.url +'"'+ sriAttributes +'></script>';
                    }
                }
                break;
        }
        r       = null;
        rLen    = null;
        obj     = null;


        return str;
    }

    /**
     * #B496 — build the config-declared CSS/JS preload prefix for the 103 Early
     * Hints response, as a PURE read: it allocates its own string and never
     * touches `local.options.template.h2Links`, the asset objects, or anything
     * else the render path shares.
     *
     * Why this exists at all rather than reusing what `getNodeRes()` accumulates:
     * `getNodeRes()` runs from `setResources()`, which every render delegate calls
     * AFTER `render()` has dispatched to it — so at hint time `h2Links` is still
     * the `''` the router seeded (`router.js`), and the automatic 103 could never
     * fire. Recomputing here keeps the final-200 `link` header's producer entirely
     * untouched, which bounds this whole feature's blast radius to the 103.
     *
     * The URL rule is deliberately duplicated from `getNodeRes()` instead of being
     * extracted into a shared helper: extracting would edit the 200 header's hot
     * path, and the worst case of drift here is a slightly inaccurate HINT, never a
     * wrong page. Extract it once this has been proven live if you want the two
     * kept in lockstep.
     *
     * Mirrors `getNodeRes()`: same `Collection.orderBy({route:'asc'})` ordering,
     * same webroot rewrite, same #OW3 rule that an SRI'd asset gets no preload
     * hint (the hint carries no integrity metadata).
     *
     * @param {object} viewConf - The resolved template config (`stylesheets` / `javascripts`)
     * @returns {string} `'<url>; as=style; rel=preload,'`-joined prefix, `''` when nothing qualifies
     *
     * @example
     * computeH2PreloadPrefix({ stylesheets: [{ url: '/css/app.css' }] });
     * // -> '</css/app.css>; as=style; rel=preload,'
     *
     * @private
     */
    var computeH2PreloadPrefix = function(viewConf) {
        if ( !viewConf ) {
            return '';
        }

        var _webroot    = local.options.conf.server.webroot;
        var useWebroot  = ( _webroot !== '/' && _webroot.length > 0 ) ? true : false;
        var sriEnabled  = ( local.options.template && local.options.template.sriEnabled ) ? true : false;
        var links       = '';

        var appendAll = function(as, resArr) {
            if ( !resArr ) {
                return;
            }
            var coll = new Collection(resArr).orderBy({route: 'asc'});
            for (var r = 0, rLen = coll.length; r < rLen; ++r) {
                var obj = coll[r];
                if ( !obj || !obj.url ) {
                    continue;
                }
                var url = ( useWebroot && !obj.url.startsWith(_webroot) )
                    ? _webroot + obj.url.substring(1)
                    : obj.url;
                // #OW3 — an SRI'd asset is never hinted (see getNodeRes)
                if ( sriEnabled && lib.sri.getIntegrityAttributes(url, local.options.conf, _webroot) ) {
                    continue;
                }
                links += '<'+ url +'>; as='+ as +'; rel=preload,';
            }
            coll = null;
        };

        appendAll('style', viewConf.stylesheets);
        appendAll('script', viewConf.javascripts);

        return links;
    }

    /**
     * TODO -  SuperController.setMeta()
     * */
    // this.setMeta = function(metaName, metacontent) {
    //
    // }



    var isValidURL = function(url){
        // var re = /(http|ftp|https|sftp):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/;
        return (/(http|ftp|https|sftp):\/\/[\w-]+(\.[\w-]+)+([\w.,@?^=%&amp;:\/~+#-]*[\w@?^=%&amp;\/~+#-])?/.test(url)) ? true : false;
    }

    /**
     * Override the route's default template path / extension at action time.
     *
     * Use case: a controller action that resolves the template dynamically
     * (e.g. a catch-all router that picks the template by URL pattern). With
     * Gina's standard 1:1 routing.json → template mapping the rule's
     * `param.file` is sufficient, but dynamic dispatch needs a runtime
     * override that survives until render-time.
     *
     * The render delegates (controller.render-swig.js,
     * controller.render-nunjucks.js) read `localOptions._templateOverride`
     * and use it verbatim under the templates root — with no namespace
     * prefixing — before falling back to `data.page.view.file`/`.ext`.
     * Setting this after `setOptions()` has already populated
     * `data.page.view.*` is the supported way to redirect rendering from
     * inside an action — that eviction-order is otherwise unreachable from
     * controller code because `local.options` is closure-private.
     *
     * @memberof BaseController
     * @param {string} file - Template path relative to the bundle's
     *                        templates root (no extension; pass `ext` separately).
     * @param {string} [ext] - File extension (with or without leading dot).
     *                         Defaults to whatever `data.page.view.ext` carries.
     * @returns {void}
     * @example
     * // Catch-all action dispatching to a template chosen at runtime:
     * this.catchAll = function (req, res, next) {
     *     var self = this;
     *     self.setTemplate('errors/' + res.statusCode); // → templates/errors/404(.html)
     *     self.render({ message: 'Not found' });
     * };
     */
    this.setTemplate = function (file, ext) {
        if (!local.options) return; // setOptions hasn't run yet — bail safely
        if (!local.options._templateOverride) local.options._templateOverride = {};
        if (typeof file === 'string') {
            local.options._templateOverride.file = file;
        }
        if (typeof ext === 'string' && ext) {
            local.options._templateOverride.ext = (ext.charAt(0) === '.') ? ext : ('.' + ext);
        }
    };

    /**
     * Render the current view without its layout wrapper.
     * Delegates to `self.render()` after setting `local.options.isWithoutLayout = true`.
     *
     * @param {object}  data            - Template data
     * @param {boolean} [displayInspector] - Show the Gina dev inspector when `true`
     * @returns {void}
     */
    this.renderWithoutLayout = function (data, displayInspector) {

        // preventing multiple call of self.renderWithoutLayout() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false;
        }

        local.options.isWithoutLayout = true;

        self.render(data, displayInspector);
    }


    var getData = function() {
        return refToObj( local.userData )
    }



    /**
     * Render HTML templates : Swig is the default template engine
     *
     *  Extend default filters
     *  - length
     *
     * Available filters:
     *  - getWebroot()
     *  - getUrl()
     *
     *  N.B.: Filters can be extended through your `<project>/src/<bundle>/controllers/setup.js`
     *
     *
     * @param {object} userData
     * @param {boolean} [displayInspector]
     * @param {object} [errOptions]
     * @returns {void}
     * */
    this.render = function (userData, displayInspector, errOptions) {
        // #FI — controller action ended, rendering begins
        if (_isDev && local._timeline && local._timeline._actionStart) {
            var _renderStart = Date.now();
            local._timeline.entries.push({
                label: 'controller-action', cat: 'controller',
                startMs: local._timeline._actionStart, endMs: _renderStart,
                durationMs: _renderStart - local._timeline._actionStart,
                detail: (local.options.control || null)
            });
            local._timeline._renderStart = _renderStart;
        }
        // Dispatch to the render delegate matching the bundle's configured
        // template engine. `settings.json > render.engine` defaults to "swig"
        // so existing bundles see zero change; "nunjucks" routes through
        // controller.render-nunjucks.js (MVP — see that file for the list of
        // deferred features relative to render-swig). The render-nunjucks
        // delegate fetches the nunjucks module itself via
        // `lib.nunjucksResolver.get()`, so the `swig` / `SwigFilters` deps
        // passed below are harmless when unused.
        // #SPA1 — content negotiation, resolved BEFORE the delegate is chosen because
        // this is the one place all four HTML delegates converge and where `local.req`
        // (routing + gina headers) and `local.res` are both live. Two independent effects:
        //
        //   (a) a NEGOTIABLE route ALWAYS advertises `Vary: X-Gina-Navigate` — a cache
        //       must be told the response varies whether or not THIS request asked for a
        //       fragment. Set via res.setHeader so it reaches both engines: every HTTP/2
        //       send site folds res.getHeaders() into stream.respond(). `completeHeaders`
        //       is NOT usable for this — it runs at server.js:6452, before the params
        //       block builds req.routing, so the flag would not exist yet (measured).
        //
        //   (b) `X-Gina-Navigate: fragment` reuses the PROVEN layoutless path by setting
        //       isWithoutLayout, rather than adding a fifth delegate. A custom-error
        //       render is unaffected by construction: those delegates read `errOptions`,
        //       not `local.options`.
        //
        // Wrapped so an absent/undeclared flag leaves the default path byte-identical,
        // and so any unexpected value simply falls through to the full page.
        try {
            if ( local.req && local.req.routing && local.req.routing.negotiate === true ) {
                var _navRes = local.res;
                if ( _navRes && typeof(_navRes.setHeader) == 'function' && !_navRes.headersSent ) {
                    var _existingVary = ( typeof(_navRes.getHeader) == 'function' ) ? _navRes.getHeader('vary') : null;
                    if ( !_existingVary ) {
                        _navRes.setHeader('vary', 'X-Gina-Navigate');
                    } else if ( !/x-gina-navigate/i.test( String(_existingVary) ) ) {
                        // Vary is a LIST header — append, never clobber a sibling value
                        // (the CORS paths set `vary: Origin`).
                        _navRes.setHeader('vary', String(_existingVary) + ', X-Gina-Navigate');
                    }
                }
                if ( local.req.ginaHeaders && local.req.ginaHeaders.navigate === 'fragment' ) {
                    local.options.isWithoutLayout = true;
                }
            }
        } catch (negotiationErr) {
            // Negotiation is an enhancement — it must never break a render.
            console.warn('[#SPA1] content negotiation skipped: '+ (negotiationErr.message || negotiationErr));
        }

        var _engine = 'swig';
        try {
            var _settings = local.options
                && local.options.conf
                && local.options.conf.content
                && local.options.conf.content.settings;
            if (_settings && _settings.render && _settings.render.engine) {
                _engine = _settings.render.engine;
            }
        } catch (e) { /* fall back to default 'swig' */ }

        // #M11 — extension-keyed engine dispatch. An explicit template
        // extension is an unambiguous engine signal, so a single bundle can
        // mix engines per section (templates.json `ext`) or per
        // `self.setTemplate(file, ext)` call: `.njk` renders through
        // nunjucks, `.swig` through swig. The precedence mirrors the
        // delegates' own resolution (setTemplate override ext first, then
        // the rule's template ext) so the dispatch can never disagree with
        // the file the delegate resolves; the ambiguous `.html` default —
        // and any other extension — keeps following `render.engine` above,
        // which leaves every existing bundle byte-unchanged.
        // initNunjucksEngine scans templates.json for `.njk` sections so a
        // mixed bundle still fails fast at startup when the project lacks
        // nunjucks; a pure-runtime `.njk` switch (setTemplate on a bundle
        // with no `.njk` config at all) surfaces the resolver's explicit
        // "get() called before load()" error instead.
        try {
            var _effExt = null;
            if ( local.options && local.options._templateOverride && local.options._templateOverride.ext ) {
                _effExt = local.options._templateOverride.ext;
            } else if ( local.options && local.options.template && local.options.template.ext ) {
                _effExt = local.options.template.ext;
            }
            if (_effExt) {
                _effExt = String(_effExt).toLowerCase();
                if ( !/^\./.test(_effExt) ) {
                    _effExt = '.' + _effExt;
                }
                if (_effExt === '.njk') {
                    _engine = 'nunjucks';
                } else if (_effExt === '.swig') {
                    _engine = 'swig';
                }
            }
        } catch (e) { /* keep the settings-level engine */ }

        var _delegate;
        if (_engine === 'nunjucks') {
            // #TPL1 — a nunjucks bundle with a configured async loader renders
            // through a per-request Environment in controller.render-nunjucks-async.js;
            // every other nunjucks bundle keeps the cached-Environment filesystem
            // path. The dispatch key is the same expression initNunjucksEngine
            // stashed under (conf.content.templates._common.html).
            var _njAsync = false;
            try {
                var _njRoot = local.options && local.options.conf && local.options.conf.content
                    && local.options.conf.content.templates && local.options.conf.content.templates._common
                    && local.options.conf.content.templates._common.html;
                _njAsync = !!(
                    _njRoot && process.gina._nunjucksLoaders && process.gina._nunjucksLoaders[_njRoot]
                    && process.gina._nunjucksLoaders[_njRoot].loader
                    && process.gina._nunjucksLoaders[_njRoot].loader.async === true
                );
            } catch (e) { /* fall back to the cached-env render-nunjucks path */ }
            _delegate = _njAsync ? '/controller.render-nunjucks-async' : '/controller.render-nunjucks';
        } else {
            // #TPL1 — a swig bundle with a configured async loader renders through
            // the isolated per-bundle engine in controller.render-swig-async.js;
            // every other swig bundle keeps the byte-identical filesystem path.
            // The dispatch key is the same expression initSwigEngine stashed under
            // (conf.content.templates._common.html).
            var _swigAsync = false;
            try {
                var _troot = local.options && local.options.conf && local.options.conf.content
                    && local.options.conf.content.templates && local.options.conf.content.templates._common
                    && local.options.conf.content.templates._common.html;
                _swigAsync = !!(
                    _troot && process.gina._swigLoaders && process.gina._swigLoaders[_troot]
                    && process.gina._swigLoaders[_troot].loader
                    && process.gina._swigLoaders[_troot].loader.async === true
                );
            } catch (e) { /* fall back to the filesystem render-swig path */ }
            _delegate = _swigAsync ? '/controller.render-swig-async' : '/controller.render-swig';
        }

        if  (this.isCacheless() ) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-v1', true))];
            delete require.cache[require.resolve( _(__dirname + '/controller.render-swig', true))];
            try {
                delete require.cache[require.resolve( _(__dirname + '/controller.render-nunjucks', true))];
            } catch (e) { /* nunjucks delegate may not exist on older framework dirs */ }
            try {
                delete require.cache[require.resolve( _(__dirname + '/controller.render-swig-async', true))];
            } catch (e) { /* async delegate may not exist on older framework dirs */ }
            try {
                delete require.cache[require.resolve( _(__dirname + '/controller.render-nunjucks-async', true))];
            } catch (e) { /* async delegate may not exist on older framework dirs */ }
        }

        // #B496 — populate the CSS/JS preload prefix for the Early Hints block below.
        //
        // Placement is load-bearing and bounded on both sides. It must run after the
        // #SPA1 negotiation block, because that is what resolves isWithoutLayout for a
        // fragment request and every delegate filters its asset list to common-only
        // under that flag — computing earlier would hint the full list on fragments and
        // disagree with the 200 header. It must run before the dispatch below, which is
        // what keeps the hint engine-agnostic and ahead of getAssets() and compilation.
        // Within that window it sits here, at the far end rather than up against #SPA1,
        // for a test-mechanical reason worth knowing before you move it: the negotiation
        // block owns a 4000-character negative-invariant window (spa-content-negotiation
        // .test.js § 04 asserts nothing inside it reads isXMLRequest) and the gate below
        // legitimately does. Nothing between #SPA1 and here writes isWithoutLayout, the
        // template config or errOptions — measured — so the state read here is the same
        // state #SPA1 left.
        //
        // The delegates resolve their own view config as `errOptions || local.options`
        // (all five of them), so this mirrors that rather than reading local.options
        // directly — otherwise a custom-error render would hint the failing route's
        // assets instead of the error page's.
        //
        // `_ehPopulated` is a PER-CALL local, deliberately not request state: a nested
        // render (a required controller) re-enters render() while the OUTER delegate's
        // getNodeRes() may have already accumulated into the same h2Links, and a
        // request-scoped flag would let the restore below wipe it.
        var _ehPopulated = false;
        try {
            if (
                hasViews()
                && !self.isXMLRequest()
                && !self.isCacheless()
                && /http\/2/.test(local.options.conf.server.protocol)
                && local.options.template
                && local.options.template.h2Links === ''
            ) {
                var _ehOptions  = (errOptions) ? errOptions : local.options;
                var _ehViewConf = _ehOptions.template;
                if ( _ehOptions.isWithoutLayout && _ehViewConf ) {
                    _ehViewConf = JSON.clone(_ehViewConf);
                    if ( Collection && Array.isArray(_ehViewConf.javascripts) ) {
                        _ehViewConf.javascripts = new Collection(_ehViewConf.javascripts)
                            .find({ isCommon: false }, { isCommon: true, name: 'gina' });
                    }
                    if ( Collection && Array.isArray(_ehViewConf.stylesheets) ) {
                        _ehViewConf.stylesheets = new Collection(_ehViewConf.stylesheets)
                            .find({ isCommon: false }, { isCommon: true, name: 'gina' });
                    }
                }
                local.options.template.h2Links = computeH2PreloadPrefix(_ehViewConf);
                _ehPopulated = true;
            }
        } catch (earlyHintsErr) {
            // A preload hint is an enhancement — it must never break a render.
            console.warn('[#B496] early-hints preload skipped: '+ (earlyHintsErr.message || earlyHintsErr));
        }

        // #EH1 — auto-send 103 Early Hints from the accumulated h2Links (CSS/JS preloads).
        // Populated immediately above since #B496; before that it read the router's
        // '' seed here and the hint never fired. Sending before the delegate compiles
        // the template gives the browser the CSS/JS hints during the largest available
        // latency window. The Link header on the final 200 is unaffected — the delegate
        // rebuilds it from a clean h2Links (restored below) exactly as before.
        var _h2Links = local.options && local.options.template && local.options.template.h2Links;
        if (_h2Links) {
            // trim trailing comma inserted by computeH2PreloadPrefix()
            var _hints = /,$/.test(_h2Links) ? _h2Links.slice(0, -1) : _h2Links;
            if (_hints) self.setEarlyHints(_hints);
        }
        // #B496 — restore the router's seed so the delegate's getNodeRes() accumulates
        // the 200's prefix from clean, byte-identically to before this block existed.
        // Guarded on the per-call flag: only the call that populated may restore.
        if ( _ehPopulated ) {
            local.options.template.h2Links = '';
        }

        return require( _(__dirname + _delegate, true) )(userData, displayInspector, errOptions, {
            self        : self,
            local       : local,
            getData     : getData,
            hasViews    : hasViews,
            setResources: setResources,
            swig        : swig,
            SwigFilters : SwigFilters,
            headersSent : headersSent
        }); //(userData, displayInspector, errOptions)
    }



    /**
     * Returns `true` when the current request was made via `XMLHttpRequest`.
     *
     * @returns {boolean}
     */
    this.isXMLRequest = function() {
        return local.options.isXMLRequest;
    }

    /**
     * Returns `true` when the request was made with credentials (cookies / auth headers).
     *
     * @returns {boolean}
     */
    this.isWithCredentials = function() {
        return ( /true/.test(local.options.withCredentials) ) ? true : false;
    }

    /**
     * Returns `true` when the request originated from inside a Gina popin
     * (detected via `x-gina-popin-id` or `x-gina-popin-name` request headers).
     *
     * @returns {boolean}
     */
    this.isPopinContext = function() {
        // #B35 — released-response guard (see getSession, #B31/#B33): a terminal exit
        // (e.g. redirect-then-continue) nulls local.req; reading local.req.headers here
        // would crash the bundle (uncaughtException → SIGTERM). A released request is
        // not a popin context.
        if ( local.req == null ) {
            return false;
        }
        return (
            typeof(local.req.headers['x-gina-popin-id']) != 'undefined'
            || typeof(local.req.headers['x-gina-popin-name']) != 'undefined'
        ) ? true : false;
    }



    /**
     * Serialise `jsonObj` and send it as a JSON response.
     * Delegates to `controller.render-json.js` (cache-busted in dev mode).
     *
     * @param {object|string} jsonObj - Data to serialise; parsed if passed as a string
     * @returns {void}
     */
    this.renderJSON = function(jsonObj) {
        // #FI — controller action ended, rendering begins
        if (_isDev && local._timeline && local._timeline._actionStart) {
            var _renderStart = Date.now();
            local._timeline.entries.push({
                label: 'controller-action', cat: 'controller',
                startMs: local._timeline._actionStart, endMs: _renderStart,
                durationMs: _renderStart - local._timeline._actionStart,
                detail: (local.options.control || null)
            });
            local._timeline._renderStart = _renderStart;
        }
        if  (this.isCacheless() ) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-json', true))];
        }

        return require( _(__dirname + '/controller.render-json', true) )(jsonObj, {
            self        : self,
            local       : local,
            headersSent : headersSent
        });
    }


    /**
     * Stream an AsyncIterable as a chunked HTTP response without buffering.
     * Required for LLM token streaming and SSE endpoints.
     *
     * Content-type determines framing:
     *   - `text/event-stream` (default) — SSE: each yielded chunk becomes `data: {chunk}\n\n`
     *   - any other type               — raw chunks written in sequence
     *
     * HTTP/2: stream.respond() + stream.write() + stream.end()
     * HTTP/1.1: response.write() with automatic chunked transfer-encoding
     *
     * The iterable should yield strings or Buffers. Objects are coerced via String().
     * Buffers pass through byte-exact on non-SSE content-types (SSE decodes them as
     * UTF-8 text). HEAD requests answer headers-only — the iterable is never consumed.
     * Upstream response headers (CORS, Content-Range, etc.) are preserved in the initial
     * headers frame, and the delegate's own defaults yield to pre-set values.
     *
     * @param {AsyncIterable} asyncIterable - Source of chunks; typically an AI SDK stream
     * @param {string}        [contentType] - Response Content-Type (default: text/event-stream)
     * @returns {void}
     *
     * @example
     * Controller.prototype.chat = async function(req, res, next) {
     *     var self = this;
     *     var ai   = getModel('claude');
     *     async function* tokens() {
     *         var s = ai.client.messages.stream({ model: ai.model, max_tokens: 1024,
     *             messages: [{ role: 'user', content: req.post.message }] });
     *         for await (var ev of s)
     *             if (ev.type === 'content_block_delta') yield ev.delta.text;
     *     }
     *     self.renderStream(tokens());
     * };
     */
    this.renderStream = function(asyncIterable, contentType) {
        // #FI — controller action ended, streaming begins
        if (_isDev && local._timeline && local._timeline._actionStart) {
            var _streamRenderStart = Date.now();
            local._timeline.entries.push({
                label: 'controller-action', cat: 'controller',
                startMs: local._timeline._actionStart, endMs: _streamRenderStart,
                durationMs: _streamRenderStart - local._timeline._actionStart,
                detail: (local.options.control || null)
            });
            local._timeline._renderStart = _streamRenderStart;
        }

        if (this.isCacheless()) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-stream', true))];
        }

        return require( _(__dirname + '/controller.render-stream', true) )(asyncIterable, contentType, {
            self        : self,
            local       : local,
            headersSent : headersSent
        });
    }


    /**
     * Send a pre-serialised XML document (#FIN2).
     *
     * The outbound counterpart to #FIN1's verbatim inbound handling: gina does
     * not build XML any more than it parses it. Serialise with the library of
     * your choice and hand over a string — the delegate owns the wire concerns
     * (content-type, charset, HEAD suppression, the HTTP/2 vs HTTP/1.1 split).
     *
     * The status code comes from `response.statusCode`, not from the payload:
     * an XML string has no envelope for `renderJSON`'s `{ status }` convention,
     * so set it upstream or answer errors with `self.throwError()`.
     *
     * Delegates to `controller.render-xml.js` (cache-busted in dev mode).
     *
     * @param {string} xmlContent    - The serialised document. Coerced via `toString()`
     *                                 when not a string; null/undefined sends an empty body.
     * @param {string} [contentType] - Response Content-Type. Default `application/xml`
     *                                 (RFC 7303 §4.1 recommends it over `text/xml`).
     *                                 Pass the suffix family explicitly when needed:
     *                                 `application/soap+xml`, `application/atom+xml`, …
     * @returns {void}
     *
     * @example
     * // routing.json: { "url": "/iso20022/pain001", "method": "POST", ... }
     * Controller.prototype.acknowledge = function(req, res, next) {
     *     var self = this;
     *     var ack  = myXmlBuilder.build({ msgId: req.body });
     *     self.renderXML(ack);
     * };
     *
     * @example
     * // An Atom feed, with the content type the format expects
     * Controller.prototype.feed = function(req, res, next) {
     *     this.renderXML(myFeedBuilder.toXml(), 'application/atom+xml');
     * };
     */
    this.renderXML = function(xmlContent, contentType) {
        // #FI — controller action ended, rendering begins
        if (_isDev && local._timeline && local._timeline._actionStart) {
            var _xmlRenderStart = Date.now();
            local._timeline.entries.push({
                label: 'controller-action', cat: 'controller',
                startMs: local._timeline._actionStart, endMs: _xmlRenderStart,
                durationMs: _xmlRenderStart - local._timeline._actionStart,
                detail: (local.options.control || null)
            });
            local._timeline._renderStart = _xmlRenderStart;
        }

        if ( this.isCacheless() ) {
            delete require.cache[require.resolve( _(__dirname + '/controller.render-xml', true))];
        }

        return require( _(__dirname + '/controller.render-xml', true) )(xmlContent, contentType, {
            self        : self,
            local       : local,
            headersSent : headersSent
        });
    }


    /**
     * Send a plain-text response.
     * Coerces `content` to string if necessary and sets `content-type: text/plain`.
     *
     * @param {string|*} content - Response body; coerced via `.toString()` if not a string
     * @returns {void}
     */
    this.renderTEXT = function(content) {

        // preventing multiple call of self.renderTEXT() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false
        }
        if ( self.isProcessingError ) {
           return;
        }

        var request     = local.req;
        var response    = local.res;
        var next        = local.next || null;
        // var stream      = null;
        // if ( /http\/2/.test(local.options.conf.server.protocol) ) {
        //     stream = response.stream;
        // }

        // Added on 2023-06-12
        if ( headersSent(response) ) {
            local.req = null;
            local.res = null;
            local.next = null;
            return;
        }

        if ( typeof(content) != "string" ) {
            content = content.toString();
        }

        // if (typeof(options) != "undefined" && typeof(options.charset) !="undefined") {
        //     response.setHeader("charset", options.charset);
        // }
        if ( !response.getHeaders()['content-type'] ) {
            response.setHeader('content-type', 'text/plain' + '; charset='+ local.options.conf.encoding);
        }

        if ( !headersSent() ) {
            console.info(request.method +' ['+response.statusCode +'] '+ request.url);
            response.end(content);
            try {
                response.headersSent = true
            } catch(err) {
                // Ignoring warning
                //console.warn(err);
            }

            local.req = null;
            local.res = null;
            local.next = null;
        }
    }



    /**
     * Send a 103 Early Hints informational response (#EH1).
     *
     * Call this at the start of a controller action, before the terminal
     * method (render, renderJSON, etc.), to hint the client about resources
     * it will need so the browser can start preloading while the server is
     * still preparing the final response.
     *
     *   HTTP/2  — `stream.additionalHeaders({ ':status': 103, link: '...' })`
     *   HTTP/1.1 — `res.writeEarlyHints({ link: '...' })` (Node.js 18.11+)
     *
     * Silently no-ops when:
     *   - `links` is falsy or an empty array / string
     *   - headers have already been sent (guards against double-call)
     *   - the runtime does not support `writeEarlyHints` (Node < 18.11)
     *   - any internal error occurs (103 is best-effort, never fatal)
     *
     * Returns `self` for optional chaining.
     *
     * @param {string|string[]} links
     *   Link header value(s), e.g.:
     *     '<https://cdn.example.com/app.css>; rel=preload; as=style'
     *     or an array of such strings (joined with ', ' into one header).
     * @returns {object} self
     */
    this.setEarlyHints = function(links) {
        if (!links) return self;

        var _res  = local.res;
        var _link;

        if (Array.isArray(links)) {
            _link = links.filter(Boolean).join(', ');
        } else {
            _link = String(links).trim();
        }

        if (!_link) return self;
        if (headersSent(_res)) return self;

        try {
            // HTTP/2 — stream.additionalHeaders() sends a HEADERS frame with :status 103
            if (_res.stream && !_res.stream.headersSent) {
                _res.stream.additionalHeaders({ ':status': 103, 'link': _link });
            } else if (typeof _res.writeEarlyHints === 'function') {
                // HTTP/1.1 — available since Node.js 18.11.0
                _res.writeEarlyHints({ 'link': _link });
            }
            // else: silently no-op on older Node.js
        } catch(e) {
            // 103 is best-effort — never let a hint failure affect the main response
        }

        return self;
    };


    /**
     * #H10 — Register HTTP/2 response trailers (trailing headers) to be emitted
     * after the response body.
     *
     * Opt-in and best-effort: calling this only RECORDS the trailer fields; the
     * active render delegate (renderStream / renderJSON / swig / nunjucks) then
     * sets `waitForTrailers: true` on `stream.respond()` and sends the trailers
     * in the HTTP/2 `wantTrailers` event after the final DATA frame. When no
     * trailers are registered the response path is byte-for-byte unchanged, so
     * existing bundles are unaffected.
     *
     * Trailers here are an HTTP/2-only mechanism. On HTTP/1.1 the call is a
     * silent no-op (the chunked-trailer path is out of scope). HEAD responses,
     * already-destroyed streams, and the framework error path never emit
     * trailers.
     *
     * Pseudo-header keys (those beginning with `:`) are stripped — HTTP/2
     * forbids pseudo-headers in a trailing HEADERS frame. Other header validity
     * is the caller's responsibility.
     *
     * Typical use is gRPC-style streaming (a final `grpc-status` / `grpc-message`)
     * or a content-integrity `Digest` emitted after a chunked body.
     *
     * @param {object} fields  Map of trailer header names to string values.
     * @returns {object} self — for optional chaining.
     *
     * @example
     * // In a controller action streaming a gRPC-style response:
     * self.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'OK' });
     * self.renderStream(myAsyncIterable, 'application/grpc+proto');
     */
    this.sendTrailers = function(fields) {
        if (!fields || typeof(fields) !== 'object') return self;
        // Strip HTTP/2 pseudo-headers (`:`-prefixed) — forbidden in a trailing
        // HEADERS frame and would throw at sendTrailers() time.
        var _clean = {};
        var _has   = false;
        for (var k in fields) {
            if (!Object.prototype.hasOwnProperty.call(fields, k)) continue;
            if (k.charAt(0) === ':') continue;
            _clean[k] = fields[k];
            _has = true;
        }
        // Arm the trailer path only when at least one valid field remains.
        local._trailers = _has ? _clean : null;
        return self;
    };


    /**
     * #AI6 — Start an async job. Runs `fn` out-of-band on the framework's
     * concurrency-limited job worker and returns a job id immediately, so the
     * action can respond before the slow work (e.g. a 1-30s model `.infer()`)
     * finishes. Thin pass-through to `lib.job.create`.
     *
     * Unlike `sendTrailers` / `setEarlyHints`, this stashes NOTHING on the
     * per-request `local` closure: the job outlives the request, so there is no
     * in-request reader. The deferred function runs AFTER this request has
     * completed, so it MUST NOT close over `req` / `res` (the controller nulls
     * `local.req` / `local.res` at response exit) — capture plain values.
     *
     * @param {function(): (Promise<*>|*)} fn - Deferred work. May be `async`, return a Promise, or return a value synchronously.
     * @param {Object} [opts]                 - Forwarded to `lib.job.create` (e.g. `meta`, `callbackUrl`, `maxAttempts`).
     * @returns {string}                      - The job id; return it to the client to poll `/_gina/jobs/:id`.
     *
     * @example
     *   this.summarise = function(req, res, next) {
     *       var prompt = req.post.text;
     *       var jobId  = self.startJob(function() {
     *           return getModel('myModel').infer([{ role: 'user', content: prompt }]);
     *       });
     *       self.renderJSON({ jobId: jobId });
     *   };
     */
    this.startJob = function(fn, opts) {
        return lib.job.create(fn, opts);
    };


    /**
     * #AI6 — Read a job's full record by id (state, result, error, timestamps).
     * Thin pass-through to `lib.job.get`. Use this from your OWN authenticated
     * route to return a completed job's `result` — the built-in
     * `/_gina/jobs/:id` endpoint is state-only and never exposes `result`.
     *
     * @param {string} id                    - The job id returned by {@link startJob}.
     * @param {function(?Error, ?Object)} cb - Node-style callback `cb(err, record|null)`.
     * @returns {void}
     *
     * @example
     *   this.jobResult = function(req, res, next) {
     *       self.jobStatus(req.params.id, function(err, job) {
     *           if (err || !job)               return self.throwError(404, 'unknown job');
     *           if (job.state !== 'completed') return self.renderJSON({ state: job.state });
     *           return self.renderJSON({ state: job.state, result: job.result });
     *       });
     *   };
     */
    this.jobStatus = function(id, cb) {
        lib.job.get(id, cb);
    };


    /**
     * #AI6 — Start an async job that runs a model inference out-of-band and
     * return its job id immediately. Convenience wrapper composing the AI
     * connector (`getModel(connector).infer(...)`) through `self.startJob`,
     * since the 1-30s `.infer()` latency is the motivating case for #AI6.
     *
     * The job `result` is the trimmed inference `{ content, model, usage }` —
     * the raw provider response is dropped to keep the record lean and
     * serialisable for a connector-backed store. Poll `/_gina/jobs/:id` for
     * state; read the result from your own authenticated route via
     * `self.jobStatus`.
     *
     * `messages` / `options` are captured as plain values, and the connector
     * is resolved lazily inside the worker via the global `getModel` — so the
     * deferred function never touches `req` / `res` (safe after response exit).
     *
     * @param {Array<{role:string, content:string}>} messages - Chat messages for the model.
     * @param {Object} [options]            - Inference options forwarded to `.infer()` (`model`, `maxTokens`, `temperature`, `system`).
     * @param {string} [options.connector]  - Name of the AI connector (the key from connectors.json) passed to `getModel`. Required to resolve a model.
     * @param {Object} [jobOpts]            - Forwarded to `lib.job.create` (`meta`, `callbackUrl`, `maxAttempts`).
     * @returns {string}                    - The job id; return it to the client to poll `/_gina/jobs/:id`.
     *
     * @example
     *   this.summarise = function(req, res, next) {
     *       var jobId = self.inferAsync(
     *           [{ role: 'user', content: req.post.text }],
     *           { connector: 'myModel', maxTokens: 500 }
     *       );
     *       self.renderJSON({ jobId: jobId });
     *   };
     */
    this.inferAsync = function(messages, options, jobOpts) {
        options = options || {};
        var _connector = options.connector;
        return self.startJob(function() {
            return getModel(_connector).infer(messages, options).then(function(_r) {
                return { content: _r.content, model: _r.model, usage: _r.usage };
            });
        }, jobOpts);
    };

    /**
     * #EVTBUS — Emit an observable application event into the Inspector's Event
     * tab. Thin pass-through to `lib.inspectorEvents.emit`: under the dev /
     * instrumentation-window gate it emits a live `inspector#event` frame over
     * `/_gina/agent`, and — when called inside a request's async context — also
     * pushes a `{type:'event',id,name,t}` entry into the per-request buffer (→
     * end-of-request `user.events` snapshot). Called outside a request (a detached
     * timer / background job) it still emits the live frame; only the snapshot is
     * skipped. A cheap no-op only when the gate is closed or `name` is invalid.
     *
     * The event NAME always rides the wire; the `metadata` object's VALUES ride
     * only when `settings.inspector.events.captureArgs` is on (default false) —
     * the gate + opt-in + authenticated channel are the protection, not redaction.
     *
     * @param {string} name       - Dotted event name, e.g. `'order.created'`.
     * @param {Object} [metadata] - Optional metadata; values gated by captureArgs.
     * @returns {boolean} true if the live frame was emitted (gate open + valid name);
     *                    false only when gated out or the name is invalid.
     *
     * @example
     *   this.checkout = function(req, res, next) {
     *       // ... create the order ...
     *       self.emitEvent('order.created', { orderId: order.id });
     *       self.renderJSON({ ok: true });
     *   };
     */
    this.emitEvent = function(name, metadata) {
        return lib.inspectorEvents.emit(name, metadata);
    };


    /**
     * Render/output-cache handle for controller (and model) code — the firing half of
     * the per-route `cache.invalidateOnEvents` contract.
     *
     * A route declares WHICH events evict it:
     * ```json
     * "invoice-get": {
     *     "url": "/invoice/:id",
     *     "cache": { "type": "memory", "ttl": 3600, "invalidateOnEvents": ["invoice#saved"] }
     * }
     * ```
     * …and this fires them. Every entry registered to the event is evicted immediately,
     * whatever its remaining TTL; for an `fs`-cached entry the body + its `.meta`
     * sidecar are removed from disk too.
     *
     * Scope is the CALLING PROCESS's cache. The `memory` store lives in the bundle's own
     * heap, so a cross-bundle invalidation (bundle A's write must evict bundle B's cached
     * pages) needs the external trigger instead — `POST /_gina/cache/clear?event=<name>`
     * or `gina cache:clear --event=<name>`.
     *
     * Deliberately NARROW: it exposes invalidation only. The underlying store is a
     * process-wide singleton whose `from()` re-points the shared Map — handing bundle
     * code the raw cache would let one route silently re-point every other route's store.
     *
     * @namespace SuperController#cache
     *
     * @example <caption>Evict on a domain write</caption>
     *   this.save = function(req, res, next) {
     *       invoice.onComplete(function(err) {
     *           if (err) { return self.throwError(err); }
     *           self.cache.invalidateByEvent('invoice#saved'); // => 3 (entries evicted)
     *           self.renderJSON({ ok: true });
     *       });
     *       invoice.save();
     *   };
     */
    this.cache = {
        /**
         * Evict every cached entry registered to `event`.
         *
         * @memberof SuperController#cache
         * @param {string} event - Event name, exactly as spelled in the route's
         *                         `cache.invalidateOnEvents` array.
         * @returns {number} entries evicted (0 when nothing is registered to `event`,
         *                   or when the server's store is not reachable).
         */
        invalidateByEvent: function(event) {
            if ( !self.serverInstance || !self.serverInstance._cached ) {
                return 0;
            }
            // from() + the call in ONE tick: from() re-points the process-wide backing
            // Map, so nothing may run between adopting the store and reading it.
            return new lib.RenderCache()
                .from(self.serverInstance._cached)
                .invalidateByEvent(event);
        },

        /**
         * Flush the output cache — the `static:` (HTML) and `data:` (JSON) namespaces
         * only; compiled templates and HTTP/2 sessions share the Map and are never
         * touched.
         *
         * @memberof SuperController#cache
         * @param {string} [bundle] - Restrict to one bundle; omit to flush every bundle
         *                            in this process.
         * @returns {number} entries removed.
         */
        clear: function(bundle) {
            if ( !self.serverInstance || !self.serverInstance._cached ) {
                return 0;
            }
            return new lib.RenderCache()
                .from(self.serverInstance._cached)
                .clear(bundle);
        }
    };


    /**
     * #I18N1 — Translate a key using the bundle's loaded i18n catalogs.
     * Auto-binds the request's culture from `req.culture` (formalised by
     * slice 3) and the bundle name from `local.options.conf.bundle`.
     *
     * Caller can override the auto-bound culture via the optional 3rd
     * argument (useful when an action needs to render a confirmation
     * email in a specific locale, etc.).
     *
     * Returns the key verbatim when no translation is found anywhere in
     * the fallback chain (specific culture → base language → bundle
     * default → process default → 'en'); a `[MISSING] <key>` marker is
     * available via `settings.json > i18n.devMissingKey` (slice 1
     * surfaces the knob; the controller wires it through).
     *
     * @param {string}      key          - Dotted-path key, e.g. `'common.welcome'`.
     * @param {Object|null} [params]     - Interpolation values. Pass `count` for
     *                                     CLDR plural-form resolution.
     * @param {string}      [culture]    - Override of the auto-bound `req.culture`.
     * @returns {string}
     *
     * @example
     *   this.home = function(req, res, next) {
     *       var msg = self.t('common.welcome');
     *       self.render({ msg: msg });
     *   };
     *
     * @example
     *   var subject = self.t('email.confirmSubject', { name: user.name }, user.preferredCulture);
     */
    this.t = function(key, params, culture) {
        if ( !culture ) {
            culture = (local.req && local.req.culture) || null;
        }
        var bundleName = (
            local.options
            && local.options.conf
            && local.options.conf.bundle
        ) ? local.options.conf.bundle : null;
        var devMissingKey = (
            local.options
            && local.options.conf
            && local.options.conf.content
            && local.options.conf.content.settings
            && local.options.conf.content.settings.i18n
            && typeof local.options.conf.content.settings.i18n.devMissingKey === 'string'
        ) ? local.options.conf.content.settings.i18n.devMissingKey : null;
        var fallbackChain = (
            local.options
            && local.options.conf
            && local.options.conf.content
            && local.options.conf.content.settings
            && local.options.conf.content.settings.i18n
            && Array.isArray(local.options.conf.content.settings.i18n.fallbackChain)
        ) ? local.options.conf.content.settings.i18n.fallbackChain : null;
        return lib.i18n.t(key, params, culture, {
            bundleName    : bundleName,
            devMissingKey : devMissingKey,
            fallbackChain : fallbackChain
        });
    };

    /**
     * #I18N2 — ICU MessageFormat opt-in. Same auto-binding shape as
     * {@link this.t} (culture from `req.culture`, bundle / devMissingKey /
     * fallbackChain from `local.options.conf.content.settings.i18n`) but
     * resolves the catalog string as ICU MessageFormat syntax.
     *
     * @param {string}      key
     * @param {Object|null} [params]
     * @param {string}      [culture] - Override of the auto-bound `req.culture`.
     * @returns {string}
     *
     * @example
     *   this.cart = function(req, res, next) {
     *       var msg = self.t.icu('cart.itemCount', { count: cart.items.length });
     *       self.render({ msg: msg });
     *   };
     */
    this.t.icu = function(key, params, culture) {
        if ( !culture ) {
            culture = (local.req && local.req.culture) || null;
        }
        var bundleName = (
            local.options
            && local.options.conf
            && local.options.conf.bundle
        ) ? local.options.conf.bundle : null;
        var devMissingKey = (
            local.options
            && local.options.conf
            && local.options.conf.content
            && local.options.conf.content.settings
            && local.options.conf.content.settings.i18n
            && typeof local.options.conf.content.settings.i18n.devMissingKey === 'string'
        ) ? local.options.conf.content.settings.i18n.devMissingKey : null;
        var fallbackChain = (
            local.options
            && local.options.conf
            && local.options.conf.content
            && local.options.conf.content.settings
            && local.options.conf.content.settings.i18n
            && Array.isArray(local.options.conf.content.settings.i18n.fallbackChain)
        ) ? local.options.conf.content.settings.i18n.fallbackChain : null;
        return lib.i18n.tIcu(key, params, culture, {
            bundleName    : bundleName,
            devMissingKey : devMissingKey,
            fallbackChain : fallbackChain
        });
    };


    /**
     * Set method - Override current method
     * E.g.: in case of redirect, to force PUT to GET
     *
     * @param {string} requestMethod - GET, POST, PUT, DELETE
     */
    var localRequestMethod = null, localRequestMethodParams = null;
    this.setRequestMethod = function(requestMethod, conf) {
        // #B35 — released-response guard (see getSession): skip on a released request;
        // reading the request method / routing here would crash the bundle.
        if ( local.req == null ) {
            return null;
        }
        // http/2 case
        if ( /http\/2/i.test(conf.server.protocolShort) ) {
            local.req.headers[':method'] = local.req.method.toUpperCase()
        }

        localRequestMethod = local.req.method = local.req.routing.method = requestMethod.toUpperCase();

        local.res.setHeader('access-control-allow-methods', localRequestMethod);

        return localRequestMethod;
    }

    /**
     * Returns the (possibly overridden) HTTP method for the current request.
     *
     * @returns {string|null} HTTP method in uppercase, e.g. `'GET'`
     */
    this.getRequestMethod = function() {
        return localRequestMethod;
    }

    /**
     * Override the parsed request-method params on `req[method]`.
     *
     * @param {object} params - Parsed request params to store
     * @returns {void}
     */
    this.setRequestMethodParams = function(params) {
        // #B35 — released-response guard: skip the local.req write on a released request.
        if ( local.req == null ) {
            return;
        }
        localRequestMethodParams = local.req[local.req.method.toLowerCase()] = localRequestMethodParams = params
    }

    /**
     * Returns the request-method params set via `setRequestMethodParams`,
     * falling back to the raw `req[method]` object.
     *
     * @returns {object}
     */
    this.getRequestMethodParams = function() {
        // #B35 — released-response guard: return the cached value without dereferencing local.req.
        if ( local.req == null ) {
            return localRequestMethodParams;
        }
        return (localRequestMethodParams) ? localRequestMethodParams : local.req[local.req.method.toLowerCase()]
    }

    /**
     * isStaticRoute
     * Trying to determine if url is a `statics` ressource
     *
     * @param {string} url
     * @param {string} method
     *
     * @returns {boolean} isStaticRoute
     */
    var isStaticRoute = function(url, method, bundle, env, conf) {

        // replaced: !/get/i.test() (#P13)
        if ( method.toUpperCase() !== 'GET' ) {
            return false
        }

        // priority to statics - this portion of code has been duplicated to Server.js

        var staticsArr = conf[bundle][env].publicResources;
        var staticProps = {
            firstLevel          : '/' + url.split(/\//g)[1] + '/',
            // to be considered as a stativ content, url must content at least 2 caracters after last `.`: .js, .html are ok
            isStaticFilename    : /(\.([A-Za-z0-9]+){2}|\/)$/.test(url)
        };

        // handle resources from public with webroot in url
        if ( staticProps.isStaticFilename && conf[bundle][env].server.webroot != '/' && staticProps.firstLevel == conf[bundle][env].server.webroot ) {
            var matchedFirstInUrl = url.replace(conf[bundle][env].server.webroot, '').match(/[A-Za-z0-9_-]+\/?/);
            if ( matchedFirstInUrl && matchedFirstInUrl.length > 0 ) {
                staticProps.firstLevel = conf[bundle][env].server.webroot + matchedFirstInUrl[0];
            }
            matchedFirstInUrl = null;
        }

        if (
            staticProps.isStaticFilename && staticsArr.indexOf(url) > -1
            || staticProps.isStaticFilename && staticsArr.indexOf( url.replace(url.substring(url.lastIndexOf('/')+1), '') ) > -1
            || staticProps.isStaticFilename && staticsArr.indexOf(staticProps.firstLevel) > -1
        ) {
            staticProps = null;
            return true
        }
        staticProps = null;

        return false;
    }

    /**
     * redirect
     *
     * TODO - improve redirect based on `lib.routing`
     * e.g.: self.redirect('project-get', { companyId: companyId, clientId: clientId, id: projectId }, true)
     *
     * How to avoid redirect inside popin context
     * N.B.: When you are in a popin context, add an `id` to your template tag so it can be ignored by the default PopinHandler
     *    E.g.: id="delete-link" -> <a href="#" id="delete-link">delete</a>
     *
     * You have two ways of using this method
     *
     * 1) Through routing.json
     * ---------------------
     * Allows you to redirect to an internal [ route ], an internal [ path ], or an external [ url ]
     *
     * For this to work you have to set in your routing.json a new route using  "param":
     * { "control": "redirect", "route": "one-valid-route" }
     * OR
     * { "control": "redirect", "url": "http://www.somedomain.com/page.html" }
     *
     * OR
     * { "control": "redirect", "path": "/", "ignoreWebRoot": true }
     *
     * OR
     * { "control": "redirect", "url": "http://home@public/production", "ignoreWebRoot": true }
     *
     * if you are free to use the redirection [ code ] of your choice, we've set it to 301 by default
     *
     * Add [ keep-params ] to carry the incoming request's query string onto the
     * redirect target (#B352). Default is `false`: the target is used verbatim and the
     * caller's query is dropped, which is the historical behaviour of every redirect
     * route. Set it when the redirect is a path normalisation and must stay transparent
     * to request state — the framework's own auto-generated `webroot@<bundle>` route
     * does exactly that, which is why `/webroot?token=…` now lands on
     * `/webroot/?token=…` instead of losing the parameter:
     * { "control": "redirect", "path": "/documentation/", "keep-params": true }
     *
     * Only a LOCAL target inherits the query. An absolute [ url ] names another origin,
     * and forwarding the caller's parameters there would disclose whatever the query
     * carried to a third party, so the flag is ignored for the absolute form. If the
     * target already carries a query the incoming one is appended with `&`.
     *
     *
     * 2) By calling this.redirect(rule, [ignoreWebRoot]):
     * ------------------------------------------------
     * where `this` is :
     *  - a Controller instance
     *
     * Where `rule` is either a string defining
     *  - the rule/route name
     *      => home (will use same bundle, same protocol scheme & same environment)
     *      => home@public (will use same protocol scheme & same environment)
     *      => http://home@public/dev (port style for more precision)
     *
     *  - an URI
     *      => /home
     *
     *  - a URL
     *      => http://www.google.com/
     *
     *
     * And Where `ignoreWebRoot` is an optional parameter used to ignore web root settings (Standalone mode or user set web root)
     * `ignoreWebRoot` behaves the like set to `false` by default
     *
     * N.B.: Gina will tell browsers not to cache redirections when running in the `dev` environment
     * OR when the request is classified as reverse-proxied — a proxied redirect's target host is
     * composed from proxy context, so a browser-cacheable 301 would freeze a transient value
     *
     * Data carry: when the current request holds params (the current method bucket merged
     * with the pre-switch one), they cross the redirect through the session flash channel
     * (`inheritedData` on the session user or the session itself) whenever a live session
     * exists; router.js merges them into `req.get` on the next routed GET, one-shot — a
     * page refresh does not replay them. Session-less bundles fall back to the clear-text
     * `?inheritedData=` URL form (2000-char cap → 424), as before.
     *
     * Trobleshouting:
     * ---------------
     *
     * Redirecting to a popin from the controller while posting from a form
     *      If this does not work, like doing a real redirect, this
     *      only means that the ID you are using for the form might be
     *      a duplicate one from the the main document !!!
     *
     * Async since #B121: the relative-path form (`self.redirect('/path')`) resolves its
     * target through the async route matcher (`getRouteByUrl` awaits the same
     * `compareUrls` machinery as the engine's routing loop). The URL, route-name and
     * `ignoreWebRoot` forms carry no await and still complete synchronously before the
     * returned promise settles. Prefer `return self.redirect(...)` from controller
     * actions — the router attaches a rejection handler to a returned thenable.
     *
     * @param {object|string} req|rule|url - Request Object or Rule/Route name
     * @param {object|boolean} res|ignoreWebRoot - Response Object or Ignore WebRoot & start from domain root: /
     * @param {object} [params] TODO
     *
     * @callback [ next ]
     * */
    this.redirect = async function(req, res, next) {
        // #B37 — released-response guard (see getSession / #B31/#B35/#B36): redirect
        // reads local.req/local.res throughout; a terminal exit (a prior redirect, or a
        // render-error path) nulls the triplet, and a second redirect on the released
        // instance would crash the bundle (uncaughtException → SIGTERM). Nothing to
        // redirect once the response was already sent/released. The relative-path form
        // suspends on an await (#B121), so it re-checks this guard after resuming.
        if ( local.req == null ) {
            return;
        }
        var conf    = self.getConfig();
        var bundle  = conf.bundle;
        var env     = conf.env;
        var wroot   = conf.server.webroot;
        var ctx     = getContext('gina');
        var routing = ctx.config.getRouting();//conf.content.routing;
        var route   = '', rte = '';
        var ignoreWebRoot = null, isRelative = false;
        var originalUrl = null;
        var method = null;
        var originalMethod = null;

        if ( typeof(req) === 'string' ) {

            // if ( typeof(res) == 'undefined') {
            //     // nothing to do
            //     ignoreWebRoot = false
            // } else
            if (typeof(res) === 'string' || typeof(res) === 'number' || typeof(res) === 'boolean') {
                if ( /^(true|1)$/i.test(res) ) {
                    ignoreWebRoot = true
                } else if ( /^(false|0)$/i.test(res) ) {
                    ignoreWebRoot = false
                } else {
                    res = local.res;
                    var stack = __stack.splice(1).toString().split(',').join('\n');
                    self.throwError(res, 500, new Error('RedirectError: @param `ignoreWebRoot` must be a boolean\n' + stack));
                    return;
                }
            } else {
                // detect by default
                if (!ignoreWebRoot) {
                    // replaced: new RegExp('^'+wroot) — use startsWith instead (#P1)
                    ignoreWebRoot = req.startsWith(wroot);
                }

            }

            if ( req.substring(0,1) === '/') { // is relative (not checking if the URI is defined in the routing.json)
                // if (wroot.substring(wroot.length-1,1) == '/') {
                //     wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                // }

                if ( /^\//.test(req) && !ignoreWebRoot )
                    req = req.substring(1);

                rte             = ( ignoreWebRoot != null && ignoreWebRoot  ) ? req : wroot + req;
                // cleaning url in case of ?param=value
                originalUrl     = rte;
                rte             = rte.replace(/\?(.*)/, '');

                req             = local.req;
                originalMethod = ( typeof(req.originalMethod) != 'undefined') ? req.originalMethod :  req.method;
                console.debug('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] trying to get route: ', rte, bundle, req.method);
                if ( !ignoreWebRoot || !isStaticRoute(rte, req.method, bundle, env, ctx.config.envConf) && !ignoreWebRoot ) {
                    // #B121 — the route matcher is async (it awaits the same `compareUrls`
                    // machinery as the engine's routing loop, incl. `validator::`
                    // requirements); the historical un-awaited call could never match, and
                    // its `false` sentinel crashed the whole bundle downstream. Resolution
                    // errors are contained here: a bad redirect target must cost the
                    // request, never the process. The result lands in a local FIRST —
                    // never straight onto `req.routing` — because the matcher itself
                    // reads and stamps `request.routing` on the request it is handed
                    // (a `false` in that slot silently voids those writes), and because
                    // the error reporters downstream expect the request to keep a valid
                    // routing: on a miss the request keeps the route that dispatched it.
                    var resolvedRouting = null;
                    try {
                        resolvedRouting = await lib.routing.getRouteByUrl(rte, bundle, req.method, req);
                        // try alternative method
                        if (!resolvedRouting) {
                            resolvedRouting = await lib.routing.getRouteByUrl(rte, bundle, 'GET', req, true); // true == override
                            if (resolvedRouting) {
                                method = req.method = 'GET'
                            }
                        }
                    } catch (redirectRouteErr) {
                        return self.throwError(500, redirectRouteErr);
                    }
                    // post-await release re-guard (the #M1/#B37 discipline): a concurrent
                    // terminal exit during the await released the triplet — nothing left
                    // to redirect on this instance.
                    if ( local.req == null ) {
                        return;
                    }
                    if ( !resolvedRouting ) {
                        // closes the long-admitted gap ("should throw a 404"): an
                        // unresolvable redirect target now 404s the request instead of
                        // falling through with a `false` routing sentinel (pre-#B121 that
                        // sentinel killed the bundle at the response-header composer;
                        // it would also have crashed the 404 reporter itself on its
                        // routing-derefing diagnostics).
                        return self.throwError(404, new Error('redirect target not found: `'+ rte +'` (method: '+ req.method +')'));
                    }
                    req.routing = resolvedRouting;

                    //route = route = req.routing.name;
                } else {
                    req.routing = {
                        param : {
                            url: rte
                        }
                    }
                }

                res             = local.res;
                next            = local.next;
                isRelative      = true;

                req.routing.param.path = rte
            } else if ( isValidURL(req) ) { // might be an URL
                rte             = req;
                originalUrl     = rte;
                rte             = rte.replace(/\?(.*)/, '');

                req     = local.req;
                res     = local.res;
                next    = local.next;

                req.routing.param.url = rte
            } else { // is by default a route name

                if ( /\@/.test(req) ) {
                    var rteArr = req.split(/\//);
                    if ( typeof(rteArr[1]) != 'undefined' )
                        env = rteArr[1];

                    rte = route = rteArr[0];
                    rteArr = rteArr[0].split(/\@/);

                    bundle = rteArr[1];

                } else {
                    // replaced: new RegExp('^/'+bundle+'-$') — use === instead (#P1)
                    rte = route = ( req === '/'+conf.bundle+'-' ) ? req : wroot.match(/[^/]/g).join('') +'-'+ req;
                }


                req     = local.req;
                res     = local.res;
                next    = local.next;

                req.routing.param.route = routing[rte]
            }

        } else {
            route = req.routing.param.route;
        }

        if ( !originalMethod ) {
            originalMethod = ( typeof(req.originalMethod) != 'undefined') ? req.originalMethod :  req.method;
        }

        var path        = originalUrl || req.routing.param.path || '';
        var url         = req.routing.param.url;
        var code        = req.routing.param.code || 301;

        var keepParams  = req.routing.param['keep-params'] || false;

        var condition   = true; //set by default for url @ path redirect

        if (route) { // will go with route first
            condition = ( typeof(routing[route]) != 'undefined') ? true : false;
        }

        if ( !self.forward404Unless(condition, req, res) ) { // forward to 404 if bad route

            var localRequestPort = local.req.headers.port || local.req.headers[':port'];
            var isProxyHost = (
                typeof(local.req.headers.host) != 'undefined'
                && typeof(localRequestPort) != 'undefined'
                && (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
                && local.options.conf.server.scheme +'://'+ local.req.headers.host +':'+ localRequestPort != local.options.conf.hostname.replace(/\:\d+$/, '') +':'+ local.options.conf.server.port
                ||
                typeof(local.req.headers[':authority']) != 'undefined'
                && local.options.conf.server.scheme +'://'+ local.req.headers[':authority'] != local.options.conf.hostname
                ||
                typeof(local.req.headers.host) != 'undefined'
                && typeof(localRequestPort) != 'undefined'
                && (localRequestPort === '80' || localRequestPort === '443' || localRequestPort === 80 || localRequestPort === 443)
                && req.headers.host == local.options.conf.host
                ||
                typeof(local.req.headers['x-nginx-proxy']) != 'undefined'
                && String(local.req.headers['x-nginx-proxy']).toLowerCase() === 'true'
                ||
                // #B66 S2b — the freeze-prone catch-all term: prefer THIS request's
                // per-request #B65 classification (slot) over the worker-global "has this
                // worker ever seen a proxy" latch, so a raw/direct request on a worker
                // that previously served a proxied one is not misclassified as proxied.
                // Worker-global stays the fallback for req-less/Express paths (no slot).
                ( ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost === true : typeof(process.gina.PROXY_HOSTNAME) != 'undefined' )
            ) ? true : false;

            // var isProxyHost = getContext('isProxyHost');
            // #B66 S2b — redirect target host prefers THIS request's slot over the worker-global.
            var hostname = (isProxyHost)
                    ? ( ( local.req && local.req._ginaProxyHostname ) ? local.req._ginaProxyHostname : process.gina.PROXY_HOSTNAME )
                    : ctx.config.envConf[bundle][env].hostname;

            // #B75 — mirror #B68's no-store onto the XHR/popin redirect JSON exits.
            // These renderJSON responses carry a proxy-context-derived target host
            // (popin.url / location), exactly like the writeHead 30x Location, so a
            // heuristically-cacheable copy could replay a stale host after a fix ships.
            // Gated identically to the writeHead path (dev OR proxied); a direct-prod
            // redirect stays byte-identical. Set on local.res so render-json's HTTP/2
            // getHeaders() fold and the HTTP/1.1 path both carry it.
            var _applyNoStoreToRedirectJSON = function() {
                var _noStoreNeeded = ( self.isCacheless() || isProxyHost );
                if ( _noStoreNeeded ) {
                    local.res.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    local.res.setHeader('pragma', 'no-cache');
                    local.res.setHeader('expires', '0');
                }
            };


            if (route) { // will go with route first

                if ( /\,/.test(routing[route].url) ) {
                    var paths = routing[route].url.split(/\,/g);
                    path = (ignoreWebRoot) ? paths[0].replace(wroot, '') : paths[0];
                } else {
                    path = (ignoreWebRoot) ? routing[route].url.replace(wroot, '') : routing[route].url;
                }

                if (bundle != conf.bundle) {
                    path = hostname + path;
                }
            } else if (url && !path) {
                path = ( (/\:\/\//).test(url) ) ? url : req.scheme + '://' + url;

                if (/\@/.test(path)) {
                    // #B152 — same re-point as the getUrl filters: the route object
                    // inherits the worker-global proxy latch from getRoute; prefer
                    // THIS request's #B65 slots so a port-less internal caller's
                    // PROXY_* rewrite can't leak into this redirect's target host.
                    // No slot (req-less / slot-less engine) -> untouched route,
                    // byte-identical.
                    var _rteRedirect = lib.routing.getRoute(path);
                    if ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) {
                        _rteRedirect.isProxyHost = ( local.req._ginaIsProxyHost === true );
                        if ( _rteRedirect.isProxyHost && local.req._ginaProxyHostname ) {
                            _rteRedirect.proxy_hostname = local.req._ginaProxyHostname;
                        }
                    }
                    path = _rteRedirect.toUrl(ignoreWebRoot);
                }

            //} else if(path && typeof(isRelative) !=  'undefined') {
            // nothing to do, just ignoring
            //} else {
            } else if ( !path && typeof(isRelative) ==  'undefined' ) {

                path = hostname + path
                //path = local.req.headers.host + path
            }

            // #B352 — `keep-params`: carry the incoming request's query string onto the
            // redirect target. The option has been documented as a redirect-route key
            // since the pre-GitHub import, but was never implemented: `keepParams` was
            // read into a local above and then dropped, so EVERY redirect-control route
            // silently discarded the caller's query.
            //
            // This is what made the framework's own auto-generated `webroot@<bundle>`
            // route lossy (config.js — it now sets the flag): that route's `param.path`
            // is a CONSTANT (the configured webroot), so nothing else could ever have
            // carried the query, and a bare-webroot hit carrying a token or a redirect
            // target — `/app?t=…` -> 302 `/app/` — arrived at the application with the
            // parameter already gone. A path-normalisation redirect must be transparent
            // to request state.
            //
            // Query source is `originalUrl || url`, the established idiom here (#B219,
            // pauseRequest, server.js access logs): the isaac engine strips the query
            // from `req.url` before controllers run and preserves the byte-exact
            // incoming URL on `req.originalUrl` (stamped as its listener's first
            // statement); express sets `originalUrl` natively. A request carrying
            // neither (bare/harness) simply contributes no query.
            //
            // Deliberately narrow scope — LOCAL targets only. An absolute `param.url`
            // names another origin, and forwarding the caller's parameters there would
            // hand a third party whatever the query carried (session tokens, ids). An
            // opt-in convenience flag must not be able to leak cross-origin, so the
            // absolute form is excluded rather than trusted.
            //
            // Placement is load-bearing: it runs BEFORE the `inheritedData` block below,
            // whose `?`-vs-`&` test must see the query appended here. On the wrong-method
            // (HEAD -> GET, 303) path both mechanisms fire, so the target carries the
            // query verbatim AND the `inheritedData` copy — redundant but consistent.
            if ( keepParams && !(/\:\/\//).test(path) ) {
                var _incomingUrl = local.req.originalUrl || local.req.url || '';
                var _queryIndex  = _incomingUrl.indexOf('?');
                if ( _queryIndex > -1 ) {
                    // verbatim — already percent-encoded as received, so re-encoding
                    // would corrupt it. CR/LF stripped: a Location built from client
                    // input must not be able to split the response header.
                    var _incomingQuery = _incomingUrl.substring(_queryIndex + 1).replace(/[\r\n]/g, '');
                    if ( _incomingQuery ) {
                        path += ( (/\?/).test(path) ? '&' : '?' ) + _incomingQuery;
                    }
                }
            }

            var isPopinContext = false;
            if (
                typeof(req.routing.param.isPopinContext) != 'undefined'
                && String(req.routing.param.isPopinContext).toLowerCase() === 'true'
                && self.isXMLRequest()
                ||
                self.isPopinContext()
                && self.isXMLRequest()
            ) {
                isPopinContext = true;
            }

            if (!headersSent()) {

                // backing up oldParams
                var oldParams = local.req[originalMethod.toLowerCase()];
                var requestParams = req[req.method.toLowerCase()] || {};
                if ( typeof(requestParams) != 'undefined' && typeof(requestParams.error) != 'undefined' ) {
                    var redirectError = requestParams.error;
                    self.throwError(requestParams.error);
                    return;
                }

                // #B353 — HEAD is a SAFE method: it is GET without a response body, so a
                // redirect must treat it exactly as it treats GET. This gate exists to stop
                // an UNSAFE method being replayed against the target — its own warning says
                // "A redirection is not permitted in this scenario", which is a
                // POST/PUT/DELETE concern — but it tested `!== 'GET'`, so HEAD was swept in
                // with them. Every consequence was wrong for a safe method: a warning on a
                // route that explicitly lists HEAD in its own `method` list (the framework's
                // auto-generated `webroot@<bundle>` route does), a 303 telling the client to
                // re-issue as GET and fetch a body it deliberately did not ask for, and —
                // because switching the method made `originalMethod !== req.method` — an
                // `inheritedData` copy appended to the target that the same request as a GET
                // never receives. Admitting HEAD converges it on GET: same status, same
                // Location, no warning.
                //
                // Kept as string comparisons rather than a regex, per #P13 below, which
                // deliberately moved this condition off `/GET/i.test()`.
                var _reqMethod  = req.method.toUpperCase();
                var _origMethod = originalMethod ? originalMethod.toUpperCase() : null;
                // replaced: !/GET/i.test() (#P13)
                if (
                    ( _reqMethod !== 'GET' && _reqMethod !== 'HEAD' )
                    ||
                    ( _origMethod && _origMethod !== 'GET' && _origMethod !== 'HEAD' )
                ) { // trying to redirect using the wrong method ?

                    console.warn(new Error('Your are trying to redirect using the wrong method: `'+ req.method+'`.\nThis can often occur while redirecting from a controller to another controller or from a bundle to another.\nA redirection is not permitted in this scenario.\nDon\'t panic :)\nSwitching request method to `GET` method instead.\n').message);
                    method = local.req.method = self.setRequestMethod('GET', conf);
                    code = 303;
                }

                var inheritedDataIsNeeded = ( req.method.toLowerCase() == originalMethod.toLowerCase() ) ? false: true;

                // merging new & olds params
                requestParams = merge(requestParams, oldParams);
                // remove session to prevent reaching the 2000 chars limit
                // if you need the session, you need to find another way to retrieve while in the next route
                if ( typeof(requestParams.session) != 'undefined' ) {
                    delete requestParams.session;
                }
                if ( typeof(requestParams) != 'undefined' && requestParams.count() > 0 ) {
                    //if ( typeof(requestParams.error) != 'undefined' )

                    // #B75 — a session-less bundle (no Session plugin mounted) must
                    // not deref req.session.user here (an XHR redirect carrying
                    // request params would 500). Null userSession falls to the
                    // session-less fallback, where inheritedData rides in the URL as before.
                    var userSession = ( typeof(req.session) != 'undefined' && req.session )
                        ? ( req.session.user || req.session )
                        : null;

                    // Session-less fallback ONLY: the data rides the URL in clear — capped.
                    // With a live session, `requestParams` rides the session instead (below):
                    // no URL string is built and the 2000-char cap does not apply.
                    var inheritedData = null;
                    if ( !userSession ) {
                        if ( /\?/.test(path) ) {
                            inheritedData = '&inheritedData='+ encodeRFC5987ValueChars(JSON.stringify(requestParams));
                        } else {
                            inheritedData = '?inheritedData='+ encodeRFC5987ValueChars(JSON.stringify(requestParams));
                        }

                        if ( inheritedData.length > 2000 ) {
                            var error = new ApiError('Controller::redirect(...) exceptions: `inheritedData` reached 2000 chars limit', 424);
                            self.throwError(error);
                            return;
                        }
                    }

                    // if redirecting from a xhrRequest
                    if ( self.isXMLRequest() ) {
                        // `requestParams` should be stored in the session to avoid passing datas in clear
                        var redirectObj = { isXhrRedirect: true };
                        if (isPopinContext) {
                            redirectObj.popin = {
                                url: path
                            }
                        } else {
                            redirectObj.location = path;
                        }
                        if (requestParams.count() > 0)  {
                            if ( userSession ) {
                                // consumed by router.js's route dispatch on the next
                                // routed GET (one-shot merge into `req.get`, then deleted)
                                userSession.inheritedData = requestParams;
                            } else { // session-less fallback: will be passed in clear
                                if (isPopinContext) {
                                    redirectObj.popin.url += inheritedData
                                } else {
                                    redirectObj.location += inheritedData;
                                }
                            }
                        }

                        _applyNoStoreToRedirectJSON(); // #B75
                        self.renderJSON(redirectObj);
                        return;
                    }

                    if (inheritedDataIsNeeded) {
                        if ( userSession ) {
                            // method-switching redirect (e.g. POST→GET 303): same session
                            // carry as the XHR branch — consumed by router.js on the next
                            // routed GET; the clear-text URL form stays the session-less fallback
                            userSession.inheritedData = requestParams;
                        } else {
                            path += inheritedData;
                        }
                    }
                }
                // Popin redirect
                if ( isPopinContext ) {
                    _applyNoStoreToRedirectJSON(); // #B75
                    return self.renderJSON({
                        isXhrRedirect: true,
                        popin: {
                            url: path
                        }
                    })
                }

                var ext = 'html';
                res.setHeader('content-type', local.options.conf.server.coreConfiguration.mime[ext]);

                var resHeaderACAM = res.getHeader('access-control-allow-methods');
                if (
                    // typeof(local.res._headers) != 'undefined'
                    // && typeof(local.res._headers['access-control-allow-methods']) != 'undefined'
                    // && local.res._headers['access-control-allow-methods'] != req.method
                    typeof(resHeaderACAM) != 'undefined'
                    && resHeaderACAM != req.method
                    ||
                    // replaced: new RegExp(method, 'i') — use indexOf + toLowerCase instead (#P1)
                    (res.getHeader('access-control-allow-methods') || '').toLowerCase().indexOf(req.method.toLowerCase()) < 0
                ) {
                    res.setHeader('access-control-allow-methods', req.method.toUpperCase() );
                }
                //path += '?query='+ JSON.stringify(self.getRequestMethodParams());
                local.req[req.method.toLowerCase()] = self.getRequestMethodParams() || {};

                var headInfos = {
                    'location': path
                };

                // A proxied request's redirect target is composed from proxy context (see the
                // `hostname` pick above): a browser-cacheable 301 would freeze a transient value
                // permanently. Folded into `headInfos` — not the writeHead call — so the
                // inter-bundle query 3xx intercepts, which replay `{ status, headers }`
                // verbatim, inherit the no-store set too.
                if (self.isCacheless() || isProxyHost) {
                    headInfos = merge(headInfos, {
                        'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from using cache
                        'pragma': 'no-cache',
                        'expires': '0'
                    });
                }
                res.writeHead(code, headInfos);
                // in case of query from another bundle waiting for a response
                var redirectObject = JSON.stringify({ status: code, headers: headInfos });

                try {
                    res.end(redirectObject);
                    local.res.headersSent = true;// done for the render() method
                } catch(err){
                    // ignoring the warning
                    // console.warn(err.stack);
                }

                console.info(local.req.method.toUpperCase() +' ['+code+'] '+ path);

                // Release per-request refs before exiting — next is already a local copy.
                local.req = null;
                local.res = null;
                local.next = null;

                if ( typeof(next) != 'undefined' )
                    next();
            }

        }
    }

    /**
     * Move files to assets dir
     *
     * #B223 — each move streams the source into a temp sibling
     * (`<target>.<pid>.<rand>.tmp`) inside the destination directory, then
     * publishes it with an atomic `rename(2)`: a reader never observes a
     * partial file under the final name, and a pre-existing destination is
     * replaced atomically instead of being deleted up front. Failures settle
     * the callback ONCE with the real filesystem `Error` — source-side stream
     * errors included (they previously had no listener, so a source vanishing
     * mid-move escalated to an uncaughtException that killed the bundle
     * process) — and a failed move never consumes the source file.
     *
     * @inner
     * @param {number} i - Current index in `files`
     * @param {object} res - Response reference (unused; kept for signature stability)
     * @param {array} files - `{ source, target }` pairs — spliced as moves complete
     *
     * @callback cb
     * @param {Error|boolean} err - `false` once every file moved; the real `Error` on the first failure
     * */
    var movefiles = function (i, res, files, cb) {
        if (!files.length || files.length == 0) {
            cb(false)
        } else {
            // #B223 — no destination pre-delete: the atomic rename below replaces
            // it only once the new content is fully written
            // was: if ( fs.existsSync(files[i].target) ) new _(files[i].target).rmSync();
            var _tmpTarget  = files[i].target + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp';
            var _settled    = false;

            var sourceStream = fs.createReadStream(files[i].source);
            // was: var destinationStream = fs.createWriteStream(files[i].target);
            var destinationStream = fs.createWriteStream(_tmpTarget);

            var onMoveError = function (err) {
                if (_settled) return;
                _settled = true;
                try { destinationStream.destroy() } catch (_e) {}
                try { if ( fs.existsSync(_tmpTarget) ) fs.unlinkSync(_tmpTarget) } catch (_e) {}
                cb(err)
            };

            // #B223 — the source stream previously had NO error listener: an
            // unreadable/vanished source raised an unhandled 'error' event
            sourceStream.on('error', onMoveError);

            sourceStream
                .pipe(destinationStream)
                .on('error', onMoveError)
                .on('close', function () {
                    // 'close' also follows 'error' on an autoDestroyed stream — the
                    // settled latch keeps a failed move from resuming the loop (the
                    // pre-fix shape settled the callback a second time, as a success,
                    // and unlinked the source of a move that had just failed)
                    if (_settled) return;

                    try {
                        fs.renameSync(_tmpTarget, files[i].target);
                    } catch (err) {
                        return onMoveError(err)
                    }
                    try {
                        fs.unlinkSync(files[i].source);
                    } catch (err) {
                        // the source vanishing AFTER a successful publish is not a
                        // move failure (e.g. the upload tmp-cleanup timer took it)
                        if (err.code != 'ENOENT') {
                            return onMoveError(err)
                        }
                    }
                    files.splice(i, 1);

                    movefiles(i, res, files, cb)
                })
        }
    }

    /**
     * Health-check action — responds with `{ status: 200, isAlive: true }`.
     * Mount on a route with `"control": "getBundleStatus"` in `routing.json`.
     *
     * @param {object}   req  - Incoming request
     * @param {object}   res  - Server response
     * @param {function} next - Next middleware callback
     * @returns {void}
     */
    this.getBundleStatus = function(req, res, next) {
        var conf = self.getConfig();
        self.renderJSON({
            status: 200,
            isAlive: true,
            message: 'I am alive !',
            // bundle: conf.bundle,
            // project: conf.projectName
        });
    }

    /**
     * Ping a sibling bundle's health-check endpoint and return its status.
     *
     * @param {string}   bundle - Bundle name to probe (must have a `bundle-status@<bundle>` route)
     * @param {function} [cb]   - `cb(err, { isAlive: boolean })` — omit to get a Promise
     * @returns {Promise<object>|void}
     */
    this.checkBundleStatus = async function(bundle, cb) {
        var opt     = self.getConfig('app').proxy[bundle];
        var route   = lib.routing.getRoute('bundle-status@'+bundle);
        opt.method  = 'GET';
        opt.path    = route.url;
        var response = { isAlive: false }, error = false;
        await util.promisify(self.query)(opt, {})
            .then( function onQueryResponse(_status) {
                response = _status
            });

        if (cb) {
            cb(error, response);
        } else {
            return response;
        }
    }

    /**
     * downloadFromURL
     * Download from an URL
     *  - attachment/inline
     *  OR
     *  - locally: `Controller.store(target, cb)` must be called to store on `onComplete` event
     *
     *      - Will trigger on frontend : Failed to load resource: Frame load interrupted
     *        because there is no `res.end()`: whitch is normal, we want to stay on the referrer page
     *
     *      - To avoid this, add to your download link the attribute `data-gina-link`
     *        This will convert the regular HTTP Request to an XML Request
     *
     * @param {string} url - eg.: https://upload.wikimedia.org/wikipedia/fr/2/2f/Firefox_Old_Logo.png
     * @param {object} [options]
     *
     * N.B.: when `options.contentDisposition` is left at its `attachment`
     * default, the emitted header carries the target filename as an RFC 6266
     * quoted-string (see `formatAttachmentDisposition`).
     * */
    this.downloadFromURL = async function(url, options, cb) {

        var defaultOptions = {
            // file name i  you want to rename the file
            file: null,
            fileSize: null,
            // only if you want to store locally the downloaded file
            toLocalDir: false, // this option will disable attachment download
            // content-disposition (https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Content-Disposition)
            contentDisposition: 'attachment',
            // content-type (https://developer.mozilla.org/en-US/docs/Web/Security/Securing_your_site/Configuring_server_MIME_types)
            contentType: 'application/octet-stream',

            agent: false,
            // set to false to ignore certificate verification
            rejectUnauthorized: true,
            //responseType: 'blob',
            port: 80,
            method: 'GET',
            keepAlive: true,
            headers: {}
        };

        var opt = ( typeof(options) != 'undefined' ) ? merge(options, defaultOptions) : defaultOptions;

        // replaced: for...in + regex test — use Object.keys() + string checks (#P22)
        var requestOptions = {};
        var optKeys = Object.keys(opt);
        for (var oi = 0; oi < optKeys.length; ++oi) {
            var o = optKeys[oi];
            if ( o !== 'toLocalDir' && o !== 'contentDisposition' && o !== 'contentType' && o !== 'file' )
                requestOptions[o] = opt[o];
        }

        // defining protocol & scheme
        var protocol    = null;
        var scheme      = null;

        if ( /\:\/\//.test(url) ) {
            scheme = url.match(/^\w+\:/)[0];
            scheme = scheme.substring(0, scheme.length-1);

            if ( !/^http/.test(scheme) ) {
                self.throwError(local.res, 500, new Error('[ '+ scheme +' ] Scheme not supported. Ref.: `http` or `https` only'));
                return;
            }

        } else { // by default
            scheme = 'http';
        }

        requestOptions.scheme = scheme +':';

        //defining port
        // console.debug('[ CONTROLLER ][ HTTP/2.0#downloadFromURL ] defining port from: ', url);
        var port = url.match(/\:\d+\//) || null;
        if ( port != null ) {
            port = port[0].match(/\d+/)[0];
            requestOptions.port = ~~port;
        }

        // defining hostname & path
        // replaced: new RegExp(scheme + '://') — use string replace (#P1)
        var parts = url.replace(scheme + '://', '').split('/');
        requestOptions.host = parts[0].replace(/\:\d+/, '');
        requestOptions.path = '/' + parts.splice(1).join('/');

        // check for protocol upgrade
        // Compare with current proxy list if available
        var appConf = self.getConfig('app');
        if ( typeof(appConf.proxy) != 'undefined' ) {
            var ctx = getContext();
            for ( let service in appConf.proxy) {
                let bundleObj = appConf.proxy[service];

                if ( /\@/.test(bundleObj.hostname) ) {

                    let bundle  = ( bundleObj.hostname.replace(/(.*)\:\/\//, '') ).split(/\@/)[0];
                    // No shorcut possible because conf.hostname might differ from user inputs
                    bundleObj.host        = ctx.gina.config.envConf[bundle][ctx.env].host.replace(/(.*)\:\/\//, '').replace(/\:\d+/, '');
                    bundleObj.hostname    = ctx.gina.config.envConf[bundle][ctx.env].hostname;
                    bundleObj.port        = ~~ctx.gina.config.envConf[bundle][ctx.env].server.port;

                    if (
                        requestOptions.host == bundleObj.host
                        && requestOptions.port != bundleObj.port
                    ) {
                        // Override
                        console.info("Overriding port to fit protocol upgrade: "+ requestOptions.port +" -> "+ bundleObj.port);
                        requestOptions.host = bundleObj.port
                        break;
                    }
                }
            }
        }


        // extension and mime
        var filename    = url.split(/\//g).pop();
        if (!filename) {
            self.throwError(local.res, 500, new Error('Filename not found in url: `'+ url +'`'));
            return;
        }


        if ( !/\.\w+$/.test(filename) ) {
            self.throwError(local.res, 500, new Error('[ '+ filename +' ] extension not found.'));
            return;
        }


        // filename renaming
        if (opt.file)
            filename = opt.file;

        if ( opt.contentDisposition == 'attachment') {
            opt.contentDisposition = formatAttachmentDisposition(filename);
        }

        var ext             = filename.match(/\.\w+$/)[0].substring(1)
            , contentType   = null
            , tmp           = _(GINA_TMPDIR +'/'+ filename, true)
        ;

        if ( typeof(local.options.conf.server.coreConfiguration.mime[ext]) != 'undefined' ) {

            contentType = (opt.contentType != defaultOptions.contentType) ? opt.contentType : local.options.conf.server.coreConfiguration.mime[ext];

        } else { // extension not supported
            self.throwError(local.res, 500, new Error('[ '+ ext +' ] Extension not supported. Ref.: gina/core mime.types'));
            return;
        }

        // defining responseType
        requestOptions.headers['content-type'] = contentType;
        requestOptions.headers['content-disposition'] = opt.contentDisposition;

        if (
            typeof(local.req.headers['x-client-ip']) != 'undefined'
            && local.req.headers['x-client-ip'] != requestOptions.headers['x-client-ip']
        ) {
            requestOptions.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }
        // [HTTP1] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if (
            typeof(local.req.headers['x-ingress-ip']) != 'undefined'
            && local.req.headers['x-ingress-ip'] != requestOptions.headers['x-ingress-ip']
        ) {
            requestOptions.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        if (
            typeof(local.req.headers['x-forwarded-for']) != 'undefined'
            && local.req.headers['x-forwarded-for'] != requestOptions.headers['x-forwarded-for']
        ) {
            requestOptions.headers['x-forwarded-for'] = local.req.headers['x-forwarded-for']
        }

        // MS1 — forward the always-on correlation id so a fan-out stays traceable.
        // Source is the sanitised, resolved req._ginaReqId (never a raw inbound
        // header); a caller that set x-request-id explicitly always wins.
        if (
            local.req && local.req._ginaReqId
            && typeof(requestOptions.headers['x-request-id']) == 'undefined'
        ) {
            requestOptions.headers['x-request-id'] = local.req._ginaReqId;
        }

        var browser = require(''+ scheme);

        try {
             const response = await new Promise((resolve, reject) => {
                const req = browser.get(requestOptions, (res) => {
                    // Vérification du status HTTP (optionnel mais conseillé)
                    if (res.statusCode >= 400) {
                        res.destroy(); // release the undrained IncomingMessage — nobody will consume it
                        return reject(new Error(`Server responded with ${res.statusCode}`));
                    }
                    resolve(res);
                });

                // Capture l'erreur de connexion (ECONNREFUSED, etc.)
                req.on('error', reject);
            });

            // We need this before piping so we can send back to the requester the final response
            local.res.setHeader('content-type', contentType + '; charset='+ local.options.conf.encoding);
            local.res.setHeader('content-disposition', opt.contentDisposition);
            if (opt.fileSize) {
                local.res.setHeader('content-length', opt.fileSize);
            }

            await pipeline(response, local.res);
            if ( typeof(cb) != 'undefined' ) {
                cb(false)
            }
        } catch (err) {
            if (err.code === 'ECONNREFUSED') {
                let helpMessage = '\nSwitching [SCOPE] for testing? \nCheck if your document url matches the current scope & env\nbefore calling Controller::downloadFromURL(url, opt)\n=> ' + url;
                helpMessage += '\n\nHere is a suggested fix to add in your logic: \n';
                helpMessage += `
// Override for local scope when switching env
if ( /^local$/i.test(process.env.NODE_SCOPE) ) {
    var ctx = getContext();
    var envHostname = ctx.gina.config.envConf['api'][ctx.env].hostname;
    var re = new RegExp('^'+ envHostname);
    if (!re.test(file.url) ) {
        var urlHostname = file.url.match(/^[a-z]+:\/\/[^/:]+(?::\d+)?/)[0];
        file.url = file.url.replace(new RegExp('^' + urlHostname), envHostname);
    }
}`;
                err.message = (err.message || "") + helpMessage;
                err.error = err.message;
            }

            if ( typeof(cb) != 'undefined' ) {
                return cb(err)
            }
            self.throwError(local.res, 500, err);
        }

    } // EO this.downloadFromURL()


    /**
     * Download to targeted filename.ext - Will create target if new
     * Use `cb` callback or `onComplete` event
     *
     *      - Will trigger on frontend : Failed to load resource: Frame load interrupted
     *        because there is no `res.end()`: whitch is normal, we want to stay on the referrer page
     *
     *      - To avoid this, add to your download link the attribute `data-gina-link`
     *        This will convert the regular HTTP Request to an XML Request
     *
     * N.B.: the `content-disposition` header carries the file's basename as
     * an RFC 6266 quoted-string (see `formatAttachmentDisposition`).
     *
     * @param {string} filename
     **/
    this.downloadFromLocal = function(filename) {

        // #B38 — released-response guard (see #B31): a terminal exit (redirect()/
        // renderTEXT()/throwError()/a render-error path) nulled the per-request refs.
        // downloadFromLocal is terminal — it streams a file as the response — so a
        // released instance means the response is already out; a no-op return is correct
        // (a live request is unaffected: the guard is skipped while the refs exist).
        if ( local.res == null ) {
            return;
        }

        var file            = filename.split(/\//g).pop();
        var ext             = file.split(/\./g).pop()
            , contentType   = null
        ;

        if ( typeof(local.options.conf.server.coreConfiguration.mime[ext]) != 'undefined' ) {

            contentType = local.options.conf.server.coreConfiguration.mime[ext];
            local.res.setHeader('content-type', contentType);
            local.res.setHeader('content-disposition', formatAttachmentDisposition(file));

            var filestream = fs.createReadStream(filename);
            filestream.pipe(local.res);

        } else { // extension not supported
            self.throwError(local.res, 500, new Error('[ '+ ext +' ] Extension not supported. Ref.: gina/core mime.types'));
            return;
        }
    }


    /**
     * Serve a stored object over HTTP with full Range support — the read-side
     * companion of `store()`'s driver-routed upload path (#STO1).
     *
     * Terminal: renders the bytes (via `renderStream`) or ends the response
     * itself (304/416), or routes through `throwError` (404/500). The whole
     * HTTP protocol dance is owned here so applications never re-implement it:
     *
     *  - `stat()`-gated: an unknown/released key answers 404; on the `stream`
     *    strategy a finalize-heal residue (row write failed, bytes readable)
     *    also 404s until the idempotent finalize heals the row.
     *  - Strong validators: `ETag: "<key>"` (storage keys are immutable — every
     *    strategy publishes via temp+rename and no in-place mutation API
     *    exists) + `Last-Modified` from the publish time.
     *  - Conditional GET: `If-None-Match` matching the key ETag → 304, no
     *    driver read.
     *  - Range (GET only, gated on `driver.capabilities.ranges`): a single
     *    `bytes=` range → 206 with `Content-Range`/exact `Content-Length`;
     *    unsatisfiable → 416 + `Content-Range: bytes *\/<size>`; multi-range /
     *    other units / garbage → the full 200 (RFC-sanctioned ignore).
     *    `If-Range` honours the Range only on an exact validator match —
     *    anything unevaluable degrades to the full 200, fail-safe.
     *  - `Accept-Ranges: bytes` advertised whenever the driver can serve them.
     *  - Content-Type: `opts.contentType` verbatim (the app's informed choice),
     *    else the STORED type with active-content downgrade — it is
     *    uploader-supplied, so `text\/html`/`svg`/`xml`/`javascript` fall back
     *    to `application\/octet-stream` (stored-XSS fail-closed). Every
     *    response carries `X-Content-Type-Options: nosniff`.
     *  - Caching: `Cache-Control: private, max-age=31536000, immutable` by
     *    default (correct for immutable-per-key objects; `private` keeps
     *    shared caches out of the application's authorization), overridable
     *    verbatim via `opts.cacheControl`.
     *  - HEAD answers headers-only (full-size accounting, no driver read).
     *  - OFFLOAD (`capabilities.offload`, the `s3` adapter): GET/HEAD answer
     *    **307** to a short-lived presigned URL instead of proxying the bytes
     *    — after the 304 check, with the facade's decisions riding the URL as
     *    signed `response-*` overrides (the DOWNGRADED content type included,
     *    so the stored-XSS guard holds when the provider serves). Range goes
     *    with the client to the provider, which answers 206/416 natively. The
     *    redirect itself is `no-store` (it outlives no signature); the
     *    payload's caching policy rides `response-cache-control`.
     *    `opts.offload: false` forces the proxy path (`get`/`getRange`) —
     *    private buckets, IP-gated egress, or byte-level control.
     *
     * Works identically on both engines: headers/status ride `local.res`, and
     * the byte emission is `renderStream`'s two arms.
     *
     * @param {string}  driverName            - The `settings.storage` driver name (as `store()` routed it).
     * @param {string}  key                   - The opaque storage key (from the `store()` result slot).
     * @param {object}  [opts]                - Serving options.
     * @param {string}  [opts.contentType]    - Explicit Content-Type; served verbatim, bypasses the downgrade.
     * @param {string}  [opts.cacheControl]   - Explicit Cache-Control; replaces the immutable default.
     * @param {boolean} [opts.download]       - `true` → `Content-Disposition: attachment`.
     * @param {string}  [opts.filename]       - Download filename (implies attachment); defaults to the stored originalName.
     * @param {boolean} [opts.offload]        - `false` → proxy the bytes even on an offload-capable
     *                                          driver (no redirect). Default: offload when the
     *                                          driver can.
     * @returns {void}
     *
     * @example
     * // a document route: GET /files/:id — Range, 304 and HEAD handled for free
     * this.download = function(req, res) {
     *     var self = this;
     *     var doc  = getDocFromDb(req.params.id);   // { storageKey, mime, name }
     *     self.serveFromStorage('media', doc.storageKey, { contentType: doc.mime });
     * };
     *
     * @example
     * // force a download dialog with a safe filename
     * self.serveFromStorage('media', record.storageKey, { download: true, filename: 'report-2026.pdf' });
     */
    this.serveFromStorage = function(driverName, key, opts) {
        // #B31/#B38 family — released-response guard: a prior terminal exit
        // nulled the per-request refs; a live request is unaffected.
        if ( local.res == null ) {
            return;
        }
        opts = opts || {};

        var request  = local.req;
        var response = local.res;
        var method   = ( request && request.method ) ? request.method.toUpperCase() : 'GET';

        var driver = null;
        try {
            driver = lib.storage.get(driverName);
        } catch (acquireErr) {
            // not configured / unknown driver — an app config error, never a 404
            return self.throwError(response, 500, acquireErr);
        }

        driver.stat(key, function onServeStat(statErr, meta) {
            // re-guard after the async hop (the #M1/#B37 discipline)
            if ( local.res == null ) {
                return;
            }
            if ( statErr ) {
                return self.throwError(response, 500, statErr);
            }
            if ( !meta ) {
                return self.throwError(response, 404, new Error('serveFromStorage(): no object for key `' + key + '` on driver `' + driverName + '`'));
            }

            var size         = meta.size;
            var contentType  = _resolveServedContentType(opts.contentType, meta.contentType);
            var etag         = '"' + key + '"';
            var lastModified = ( typeof(meta.createdAt) == 'number' ) ? new Date(meta.createdAt).toUTCString() : null;
            var rangesOn     = !!( driver.capabilities && driver.capabilities.ranges );

            /**
             * Headers every serve outcome shares (200/206/304/416/HEAD).
             * Applied only once an outcome is decided, so a driver error can
             * still route through `throwError` with no Range headers leaked.
             *
             * @inner
             * @returns {void}
             */
            var setCommonHeaders = function() {
                response.setHeader('x-content-type-options', 'nosniff');
                response.setHeader('etag', etag);
                if ( lastModified ) {
                    response.setHeader('last-modified', lastModified);
                }
                if ( rangesOn ) {
                    response.setHeader('accept-ranges', 'bytes');
                }
                response.setHeader('cache-control',
                    ( typeof(opts.cacheControl) == 'string' && opts.cacheControl !== '' )
                        ? opts.cacheControl
                        : 'private, max-age=31536000, immutable'
                );
                if ( opts.download === true || typeof(opts.filename) == 'string' ) {
                    // the stored originalName is uploader-supplied: strip control
                    // chars so setHeader cannot throw on CR/LF (header injection)
                    var _fname = String(opts.filename || meta.originalName || 'download').replace(/[\x00-\x1f\x7f]/g, '');
                    response.setHeader('content-disposition', formatAttachmentDisposition(_fname));
                }
            };

            // Conditional GET — If-None-Match vs the strong key ETag (weak
            // comparison per RFC 9110, hence indexOf: a W/-prefixed echo matches).
            var inm = ( request && request.headers ) ? request.headers['if-none-match'] : null;
            if ( inm && ( method === 'GET' || method === 'HEAD' )
                && ( inm === '*' || String(inm).indexOf(etag) > -1 )
            ) {
                setCommonHeaders();
                response.statusCode = 304;
                local.req = null; local.res = null; local.next = null;
                return response.end();
            }

            // #STO1 s3 — OFFLOAD: an offload-capable driver hands the byte
            // transfer to its provider through a short-lived presigned URL.
            // Runs AFTER the 304 check (the key ETag needs no presign) and
            // carries this facade's decisions into the PROVIDER's response as
            // signed response-* overrides — the DOWNGRADED content type
            // included, which is what keeps the stored-XSS guard intact when
            // the provider serves the bytes. Range is deliberately NOT
            // evaluated here: the client re-issues it against the redirect
            // target and the provider answers 206/416 natively. 307 preserves
            // the method (HEAD stays HEAD). The redirect itself is `no-store`
            // — a cached redirect would outlive its signature — while the
            // payload's caching policy rides response-cache-control.
            var offloadOn = !!( driver.capabilities && driver.capabilities.offload ) && ( opts.offload !== false );
            if ( offloadOn && ( method === 'GET' || method === 'HEAD' ) ) {
                var wantsAttachment = ( opts.download === true || typeof(opts.filename) == 'string' );
                driver.resolve(key, {
                    contentType  : contentType,
                    download     : wantsAttachment,
                    filename     : wantsAttachment
                        ? String(opts.filename || meta.originalName || 'download').replace(/[\x00-\x1f\x7f]/g, '')
                        : undefined,
                    cacheControl : ( typeof(opts.cacheControl) == 'string' && opts.cacheControl !== '' )
                        ? opts.cacheControl
                        : 'private, max-age=31536000, immutable'
                }, function onServeResolve(resolveErr, resolved) {
                    if ( local.res == null ) {
                        return;
                    }
                    if ( resolveErr ) {
                        return self.throwError(response, ( resolveErr.code === 'STORAGE_NO_OBJECT' ) ? 404 : 500, resolveErr);
                    }
                    if ( !resolved || resolved.kind !== 'url' || typeof(resolved.url) != 'string' ) {
                        // capability said offload, resolve() answered something
                        // else — a driver contract violation, surfaced loudly
                        // rather than silently degraded to the proxy path.
                        return self.throwError(response, 500, new Error('serveFromStorage(): driver `' + driverName + '` declares capabilities.offload but resolve() returned no `{kind:\'url\'}` — driver contract violation'));
                    }
                    response.setHeader('x-content-type-options', 'nosniff');
                    response.setHeader('cache-control', 'private, no-store');
                    response.setHeader('location', resolved.url);
                    response.statusCode = 307;
                    local.req = null; local.res = null; local.next = null;
                    return response.end();
                });
                return;
            }

            // HEAD — full-size accounting, headers only, no driver read; the
            // renderStream HEAD branch ends the response without a body.
            if ( method === 'HEAD' ) {
                setCommonHeaders();
                response.setHeader('content-length', String(size));
                response.statusCode = response.statusCode || 200;
                return self.renderStream(null, contentType);
            }

            // Range evaluation — GET only, and only when the driver can serve
            // ranges (capability-gated: an offloading adapter that cannot is
            // transparently answered with the full 200).
            var range = null;
            if ( method === 'GET' && rangesOn && request && request.headers && request.headers.range ) {
                var ifRange   = request.headers['if-range'];
                var ifRangeOk = true;
                if ( typeof(ifRange) == 'string' && ifRange !== '' ) {
                    // exact validator match only; anything unevaluable → full 200
                    ifRangeOk = ( ifRange === etag ) || ( lastModified != null && ifRange === lastModified );
                }
                if ( ifRangeOk ) {
                    range = _parseRangeHeader(request.headers.range, size);
                }
            }

            if ( range && range.unsatisfiable ) {
                setCommonHeaders();
                response.setHeader('content-range', 'bytes */' + size);
                response.statusCode = 416;
                local.req = null; local.res = null; local.next = null;
                return response.end();
            }

            /**
             * Apply the decided outcome's headers and stream the bytes.
             * Runs only in a driver-success callback (headers-on-success).
             *
             * @inner
             * @param {number} status       - 200 or 206.
             * @param {object} extraHeaders - Outcome-specific headers.
             * @param {object} readable     - The driver's byte stream.
             * @returns {void}
             */
            var sendStream = function(status, extraHeaders, readable) {
                if ( local.res == null ) {
                    return;
                }
                setCommonHeaders();
                for (var h in extraHeaders) {
                    response.setHeader(h, extraHeaders[h]);
                }
                response.statusCode = status;
                return self.renderStream(readable, contentType);
            };

            if ( range ) {
                driver.getRange(key, range.start, range.end, function onServeRange(rErr, readable) {
                    if ( local.res == null ) {
                        return;
                    }
                    if ( rErr ) {
                        // post-stat race (cas grace expiry, vanished file) → 404;
                        // anything else is an I/O anomaly → 500
                        return self.throwError(response, ( rErr.code === 'STORAGE_NO_OBJECT' ) ? 404 : 500, rErr);
                    }
                    sendStream(206, {
                        'content-range'  : 'bytes ' + range.start + '-' + range.end + '/' + size,
                        'content-length' : String(range.end - range.start + 1)
                    }, readable);
                });
                return;
            }

            driver.get(key, function onServeGet(gErr, readable) {
                if ( local.res == null ) {
                    return;
                }
                if ( gErr ) {
                    return self.throwError(response, ( gErr.code === 'STORAGE_NO_OBJECT' ) ? 404 : 500, gErr);
                }
                sendStream(200, { 'content-length': String(size) }, readable);
            });
        });
    }


    /**
     * Store file(s) to a targeted directory - Will create target if new
     * You only need to provide the destination path
     * Use `cb` callback or `onComplete` event
     *
     * Files are published atomically (temp sibling + rename — #B223), so a
     * reader never observes a partially-written file under the final name.
     *
     * #STO1 (slice 1) — a file whose upload group carries a `driver` key
     * (`settings.json > upload.groups.<name>.driver`) is published through the
     * named `settings.storage` driver instead of moving to `target`; its result
     * entry then carries an OPAQUE `key` (+ `group`, `driver`, and the layer's
     * on-disk `size`) and NO `filename` — read it back via
     * `gina.storage(driver)`. Files in groups without a `driver` keep the
     * historical move path byte-for-byte, and one call may mix both kinds
     * (result slots stay 1:1 with the input array). `target` may be `null`
     * ONLY when every file routes to a driver.
     *
     * @param {?string} target is the upload dir destination (required when any
     *   file is NOT driver-routed)
     * @param {array} [files]
     *
     * @callback [cb]
     *  @param {Error|boolean} error - `false` on success; the real move/publish
     *    `Error` on failure (`No file to upload` only when there was nothing to
     *    store)
     *  @param {array} files
     *
     * @returns {{onComplete: function}|undefined} the fluent handle when `cb`
     *   is omitted OR is not a function (`null` included, #B480) —
     *   `store(target).onComplete(cb)`, delivering to that call's callback
     *   alone (#B475) — or `undefined` when a function `cb` is provided.
     *   `onComplete()` throws a `TypeError` synchronously when given a
     *   non-function (#B480): fail fast at the caller's line rather than
     *   inside an fs callback.
     *
     * @example
     * // store the request's uploaded files, surfacing the real failure cause
     * self.store(uploadDir, req.files, function onStored(err, files) {
     *     if (err) {
     *         // err.code carries the filesystem diagnostic (EACCES, ENOSPC, ENOENT, ...)
     *         return self.throwError(500, err);
     *     }
     *     self.renderJSON({ files: files });
     * });
     *
     * @example
     * // a driver-routed group's entries carry a storage key, not a path
     * self.store(uploadDir, req.files, function onStored(err, files) {
     *     if (err) { return self.throwError(500, err); }
     *     // files[i] = { file, filename, size, type, encoding }        (moved)
     *     // files[i] = { file, group, driver, key, size, type, encoding } (driver-routed)
     *     self.renderJSON({ files: files });
     * });
     *
     * @example
     * // fluent form — no callback argument: chain .onComplete(cb).
     * // #B420: the declaration is deliberately NOT `async` — this handle must
     * // be returned synchronously; an `async` wrapper would hand back a
     * // Promise carrying no `onComplete`.
     * self.store(uploadDir).onComplete(function onStored(err, files) {
     *     if (err) { return self.throwError(500, err); }
     *     self.renderJSON({ files: files });
     * });
     * */
    this.store = function(target, files, cb) {

        // #STO1 — per-group storage-driver routing (slice 1). Group config is
        // read DIRECTLY off the request's resolved bundle conf (a getConfig()
        // call would clone the whole settings block per store() call); only the
        // literal `driver` string is consumed here — every placeholder-bearing
        // upload key stays boot-side territory.
        var _uploadGroups = ( local.options
            && local.options.conf
            && local.options.conf.content
            && local.options.conf.content.settings
            && local.options.conf.content.settings.upload
            && local.options.conf.content.settings.upload.groups
        ) ? local.options.conf.content.settings.upload.groups : null;

        /**
         * Resolve a file record's upload group to its configured storage driver
         * name, or `null` when the group is not driver-routed.
         *
         * A record with no `group` routes as `untagged` — the same default the
         * multipart gate applies — which also covers caller-synthesized file
         * lists that never went through the parser.
         *
         * @inner
         * @param {object} fileRecord - A `req.files`-shaped record.
         * @returns {?string} The driver name, or `null` (historical move path).
         */
        var getFileDriverName = function(fileRecord) {
            var g = ( fileRecord && fileRecord.group ) ? fileRecord.group : 'untagged';
            if ( _uploadGroups
                && _uploadGroups[g]
                && typeof(_uploadGroups[g].driver) == 'string'
                && _uploadGroups[g].driver.length > 0
            ) {
                return _uploadGroups[g].driver;
            }
            return null;
        };

        /**
         * Publish driver-routed entries through `lib/storage`, sequentially —
         * mirroring `movefiles`: abort on the FIRST failure, keep
         * already-published objects, and tolerate a source consumed by the
         * upload tmp-cleanup timer AFTER a successful publish (ENOENT).
         *
         * Each entry's pre-filled result slot receives the layer's opaque `key`
         * and its on-disk `size` on publish.
         *
         * @inner
         * @param {object[]} entries - `{ record, fileName, driverName, slot }` tuples.
         * @param {function} done - `done(err)` — `false` once every entry published.
         * @returns {void}
         */
        var putfiles = function(entries, done) {
            var e = 0;
            var next = function() {
                if ( e >= entries.length ) {
                    return done(false);
                }
                var entry  = entries[e];
                var driver = null;
                try {
                    driver = lib.storage.get(entry.driverName);
                } catch (resolveErr) {
                    return done(resolveErr);
                }
                driver.put(fs.createReadStream(entry.record.path), {
                    originalName : entry.fileName,
                    contentType  : entry.record.type
                }, function (putErr, putRes) {
                    if (putErr) {
                        return done(putErr);
                    }
                    try {
                        fs.unlinkSync(entry.record.path);
                    } catch (unlinkErr) {
                        // the source vanishing AFTER a successful publish is not
                        // a failure (e.g. the upload tmp-cleanup timer took it)
                        if (unlinkErr.code != 'ENOENT') {
                            return done(unlinkErr);
                        }
                    }
                    entry.slot.key  = putRes.key;
                    entry.slot.size = putRes.size;
                    ++e;
                    next();
                });
            };
            next();
        };

        var start = function(target, files, cb) {

            if (arguments.length == 2 && typeof(arguments[1]) == 'function' ) {
                var cb = arguments[1];
            }

            // #B38 — released-response guard (see #B31): the documented
            // `store(target).onComplete(cb)` form calls start() SYNCHRONOUSLY from the
            // returned wrapper, OUTSIDE the store() body, so on a released request
            // (the per-request refs nulled by a terminal exit) this is a SIGTERM bundle
            // kill — not the non-fatal async class. Notify through cb, then bail.
            // #B480 — cb is always a function here; the former `else { self.emit('uploaded', …) }` arm is gone.
            if ( local.req == null ) {
                var _releasedErr = new Error('Controller::store — response already released');
                cb(_releasedErr);
                return;
            }

            if ( typeof(files) == 'undefined' || typeof(files) == 'function' ) {
                files = local.req.files
            }

            var uploadedFiles = [];

            if ( typeof(files) == 'undefined' || files.count() == 0 ) {
                cb(new Error('No file to upload'))
            } else {
                // saving files
                var uploadDir   = null
                    , list      = []
                    , i         = 0
                    , folder    = null;

                // #STO1 — partition FIRST: a driver-routed file never touches
                // `target`, so the target dir is only required — and only
                // created — when at least one file stays on the historical
                // move path.
                var fileName    = null
                    , routed    = []
                    , unrouted  = [];
                for (var len = files.length; i < len; ++i ){

                    fileName = files[i].filename || files[i].originalFilename

                    var _driverName = getFileDriverName(files[i]);
                    if ( _driverName ) {
                        // slot filled now so the result keeps 1:1 index parity
                        // with `files`; `key`/`size` land on publish
                        uploadedFiles[i] = {
                            file        : fileName,
                            group       : ( files[i].group ) ? files[i].group : 'untagged',
                            driver      : _driverName,
                            key         : null,
                            size        : files[i].size,
                            type        : files[i].type,
                            encoding    : files[i].encoding
                        };
                        routed.push({ record: files[i], fileName: fileName, driverName: _driverName, slot: uploadedFiles[i] });
                        continue;
                    }
                    unrouted.push({ record: files[i], fileName: fileName, slotIndex: i });
                }

                if ( unrouted.length && (target == null || target === '') ) {
                    // #STO1 — an all-routed call may omit the target; a call
                    // with files on the move path cannot
                    var _targetErr = new Error('Controller::store — a target directory is required: `'+ unrouted[0].fileName +'` (group `'+ (( unrouted[0].record.group ) ? unrouted[0].record.group : 'untagged') +'`) is not routed to a storage driver');
                    cb(_targetErr)
                    return;
                }

                if ( unrouted.length ) {
                    uploadDir   = new _(target);
                    folder      = uploadDir.mkdirSync();
                }

                if (folder instanceof Error) {
                    cb(folder)
                } else {
                    // files list
                    for (var u = 0, uLen = unrouted.length; u < uLen; ++u ){

                        list[u] = {
                            source: unrouted[u].record.path,
                            target: _(uploadDir.toString() + '/' + unrouted[u].fileName)
                        };

                        uploadedFiles[unrouted[u].slotIndex] = {
                            file        : unrouted[u].fileName,
                            filename    : list[u].target,
                            size        : unrouted[u].record.size,
                            type        : unrouted[u].record.type,
                            encoding    : unrouted[u].record.encoding
                        };

                    }

                    movefiles(0, local.res, list, function (err) {
                        if (err) {
                            // #B223 — surface the REAL move error: every failure used
                            // to be reported as the fabricated empty-upload message,
                            // masking the actual filesystem diagnostics (ENOSPC,
                            // EACCES, a vanished source, ...)
                            var _moveErr = ( err instanceof Error ) ? err : new Error(String(err));
                            cb(_moveErr)
                        } else {
                            // #STO1 — then the driver-routed files; abort on the
                            // first failure, keep already-published objects (the
                            // mover's partial-success semantics — no rollback)
                            putfiles(routed, function (putErr) {
                                if (putErr) {
                                    var _putErr = ( putErr instanceof Error ) ? putErr : new Error(String(putErr));
                                    cb(_putErr)
                                } else {
                                    cb(false, uploadedFiles)
                                }
                            })
                        }
                    })
                }
            }
        }

        // #B480 — mint the handle for ANY non-function cb, `null` included, mirroring
        // query()'s guard: `store(target, files, null)` used to fall into the callback
        // branch and lose its outcome to an event nobody listened to. start() is
        // therefore only ever entered with a function, so its seven former
        // `else { emit('uploaded', …) }` arms are gone — nothing in-tree ever
        // listened to that event and it was never a documented @fires.
        if ( typeof(cb) != 'function' ) {

            return {
                onComplete : function(cb){
                    // #B480 — fail fast at the caller's line: a non-function would otherwise
                    // reach start()'s delivery sites inside fs callbacks, where the TypeError
                    // is an uncaughtException, not a caught error.
                    if ( typeof(cb) != 'function' ) {
                        throw new TypeError('Controller::store — onComplete expects a function, got ' + ( cb === null ? 'null' : typeof(cb) ));
                    }
                    // #B475 — deliver through the callback path: a per-call channel,
                    // no listener left on the shared instance emitter (the .on() this
                    // used to register was never removed, so a later store() on the
                    // same instance re-invoked every earlier callback with its result)
                    start(target, files, cb)
                }
            }
        } else {
            start(target, files, cb)
        }
    }


    /**
     * Query
     *
     * Allows you to act as a proxy between your frontend and a 1/3 API
     * */
    function sha256(s) {
        return crypto.createHash('sha256').update(s).digest('base64');
    }
    local.query.data = {};
    local.query.options = {
        // Must be an IP
        host                : undefined,
        // cname of the host e.g.: `www.google.com` or `localhost`
        hostname            : undefined,
        // e.g.: /test.html
        path                : undefined,
        // #80 by default but can be 3000 or <bundle>@<project>/<environment>
        port                : 80,
        // POST|GET|PUT|DELETE|HEAD
        method              : 'GET',
        // `"username:password"` — minted into an `Authorization: Basic` header
        // before dispatch on BOTH transports (#B465); a caller-supplied
        // authorization header wins.
        auth                : undefined,
        keepAlive           : true,
        // Simultanous active conns
        maxSockets          : 100,
        keepAliveMsecs      : 1000,
        // Only keep 10 open conn while idle
        maxFreeSockets      : 10,
        // Set to false to ignore certificate verification when requesting on https (443)
        // Same as process.env.NODE_TLS_REJECT_UNAUTHORIZED = "1";
        rejectUnauthorized  : true,
        headers             : {
            'content-type': 'application/json',
            'content-length': local.query.data.length
        },
        // Will try x3 (0, 1, 2). Hard ceiling is 10 (see retry handler) to bound timer accumulation under sustained failure.
        maxRetry            : 2,
        // #B53 — when true, allow auto-retry of a non-safe method (POST/PUT/PATCH/DELETE) after
        // a post-send transient failure. Default false: only safe methods (GET/HEAD/OPTIONS/TRACE)
        // auto-retry, so a request the upstream already executed is never silently re-run. Opt in
        // per call only when the target endpoint is genuinely replay-safe. See isRetryableMethod().
        retryUnsafe         : false,
        // Socket inactivity timeout — accepts "30s", "500ms", "1m" or a number (ms)
        requestTimeout      : "10s",
        agent               : false/**,
        checkServerIdentity: function(host, cert) {
            // Make sure the certificate is issued to the host we are connected to
            const err = tls.checkServerIdentity(host, cert);
            if (err) {
                return err;
            }

            // Pin the public key, similar to HPKP pin-sha25 pinning
            const pubkey256 = 'pL1+qb9HTMRZJmuC/bB/ZI9d302BYrrqiVuRyW+DGrU=';
            if (sha256(cert.pubkey) !== pubkey256) {
                const msg = 'Certificate verification error: ' +
                    `The public key of '${cert.subject.CN}' ` +
                    'does not match our pinned fingerprint';
                return new Error(msg);
            }

            // Pin the exact certificate, rather then the pub key
            const cert256 = '25:FE:39:32:D9:63:8C:8A:FC:A1:9A:29:87:' +
                'D8:3E:4C:1D:98:DB:71:E4:1A:48:03:98:EA:22:6A:BD:8B:93:16';
            if (cert.fingerprint256 !== cert256) {
                const msg = 'Certificate verification error: ' +
                    `The certificate of '${cert.subject.CN}' ` +
                    'does not match our pinned fingerprint';
                return new Error(msg);
            }

            // This loop is informational only.
            // Print the certificate and public key fingerprints of all certs in the
            // chain. Its common to pin the public key of the issuer on the public
            // internet, while pinning the public key of the service in sensitive
            // environments.
            do {
                console.debug('Subject Common Name:', cert.subject.CN);
                console.debug('  Certificate SHA256 fingerprint:', cert.fingerprint256);

                hash = crypto.createHash('sha256');
                console.debug('  Public key ping-sha256:', sha256(cert.pubkey));

                lastprint256 = cert.fingerprint256;
                cert = cert.issuerCertificate;
            } while (cert.fingerprint256 !== lastprint256);

        }*/

    };

    /**
     * #B399 — own an async app-callback rejection at every query delivery seam.
     * `query()` delivers outcomes to the app through a Node-style callback (or
     * the `{onComplete}` facade registering one): a SYNC throw inside that
     * callback is caught by the success-delivery guards, but an `async`
     * callback's rejected promise passed through every bare `callback(...)` /
     * `cb(...)` delivery unowned — no response, the request hung to
     * client/proxy timeout, and the only trace floated to the process-level
     * rejection handler (same class as the reserved-action hook half of
     * #B399). Every app-callback delivery expression is wrapped with this
     * helper: a thenable return gets a `.catch` routing to the same
     * `throwError` shape the sync-delivery catches build (flat 500 — parity
     * with those guards). Sync behaviour at every wrapped site is
     * byte-unchanged, plain callbacks mint zero promises, and a callback that
     * already responded before rejecting is absorbed by the #B31
     * released-response guard (warn + ignore).
     *
     * @inner
     * @param {*} result - the app callback's return value
     * @returns {*} `result`, unchanged
     */
    var _ownAsyncCbRejection = function(result) {
        if ( result && typeof(result.then) == 'function' ) {
            result.catch(function(asyncErr) {
                var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                var msg = 'Controller Query Exception on async callback rejection.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + ( asyncErr && (asyncErr.stack || asyncErr.message) || String(asyncErr) );
                var exception = new Error(msg);
                exception.status = 500;
                self.throwError(exception);
            });
        }
        return result;
    };

    /**
     * Owns a SYNCHRONOUS app-callback throw on a transport-error delivery (#B402).
     * The error-path deliveries had no try/catch at all: on the event/timer-frame
     * sites a sync throw escaped to the process handler (lib/proc.js emerg + SIGTERM
     * -- a whole-bundle kill on both engines for consumer bundles), and on the
     * caller-frame sites it re-entered the query-scope catch, invoking the app
     * callback a second time with its own exception. Same exception shape as the
     * sync-delivery catches, distinct marker, flat 500; the #ERRREF ref and pairing
     * line are minted inside throwError itself.
     *
     * @inner
     * @param {*} syncErr - whatever the app callback threw
     * @returns {boolean|undefined} the self.throwError(exception) return value
     */
    var _ownSyncCbThrow = function(syncErr) {
        var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
        var msg = 'Controller Query Exception on transport-error callback throw.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + ( syncErr && (syncErr.stack || syncErr.message) || String(syncErr) );
        var exception = new Error(msg);
        exception.status = 500;
        return self.throwError(exception);
    };

    /**
     * Build the per-call delivery adapter behind the fluent `{onComplete}`
     * handle (#B475). Reproduces the contract the former emitter-side facades
     * gave the application: a JSON-looking string body is parsed, a
     * single-argument error delivery (#B404) reaches `cb(err)`, a known
     * non-2xx status reaches `cb(data)`, success reaches `cb(false, data)`,
     * and a native or typed `Error` — the bare shape the callback path hands
     * over on a transport or pre-transport failure — is wrapped as the
     * `{status, error}` object the fluent form documents (`err.status` when
     * the error carries one, 500 otherwise). A synchronous throw inside `cb`
     * is answered by the same "while catching back" 500 as the callback path;
     * a rejected thenable is owned by `_ownAsyncCbRejection`. Returns nothing,
     * so the delivering site's own async-rejection wrap around its callback
     * never sees the thenable a second time.
     *
     * @inner
     * @param {function} cb - The application callback registered through `onComplete`
     * @returns {function} `deliver(err, data)` — invoked by the per-call channel
     */
    var _fluentDelivery = function(cb) {
        return function deliverToFluentCallback(err, data) {
            if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                try {
                    data = JSON.parse(data)
                } catch (parseErr) {
                    data = {
                        status    : 500,
                        error     : data
                    }
                }
            }
            // a bare Error (transport or pre-transport failure) rides the
            // {status, error} wrap the fluent form has always delivered
            if ( err instanceof Error ) {
                err = { status: err.status || 500, error: err };
            }
            try {
                // #B404 — error deliveries are single-argument (`cb(err)` on
                // failure, `cb(false, data)` on success): with `data` undefined
                // the payload rides the error slot
                if ( typeof(data) == 'undefined' ) {
                    _ownAsyncCbRejection(cb(err));
                    return;
                }
                if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined') {
                    _ownAsyncCbRejection(cb(data));
                    return;
                }
                _ownAsyncCbRejection(cb(err, data));
            } catch (e) {
                var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
                var exception = new Error(msg);
                exception.status = 500;
                self.throwError(exception);
            }
        };
    };

    /**
     * Make an outbound HTTP/HTTPS request from a controller action.
     *
     * Accepts arguments in any of these forms:
     * - `query(options, data, callback)`
     * - `query(options, callback)`
     * - `query(options, data)` — returns a handle exposing `onComplete(cb)`.
     *   Since #B475 the handle is a PER-CALL channel: concurrent fluent
     *   queries on one controller each deliver to their own callback, every
     *   registration fires (`onComplete()` returns the handle, so it chains),
     *   a registration made after the call settled still fires on the next
     *   tick, and the handle comes back on EVERY path — a synchronous failure
     *   (missing host, unreadable certificate, open circuit, a nested-render
     *   refusal) reaches `cb(err)` on the next tick instead of throwing at the
     *   call site. `query#complete`
     *   is emitted on the controller only when nothing consumed the outcome
     *   (no callback, no `onComplete`), one tick after settlement.
     *   The handle is NOT a thenable — to `await`, promisify the call the way
     *   the framework does internally:
     *   `await require('util').promisify(self.query)(options, {})`.
     *   A non-2xx upstream status rejects the promisified call with the plain
     *   `{status, error, message}` object; a connection failure rejects with a
     *   native `Error`.
     *   `onComplete(cb)` itself delivers err-first (#B404): on failure
     *   `cb(err)` with `data` undefined — a plain `{status, error}` object for
     *   a non-2xx status or a transport failure, a native `Error` for a
     *   pre-transport failure (missing host, unreadable certificate, open
     *   circuit, nested-render refusal) — and on success `cb(false, data)`.
     *
     * A query issued while the controller is rendering from another required
     * controller (`renderingStack` deeper than one frame — the required
     * controller shares the caller's options object) is refused without
     * contacting the upstream (#B479): the callback receives an `Error` whose
     * `code` is `NESTED_RENDER` — in-line in the callback form, on the next
     * tick through the handle — and the handle still comes back.
     *
     * An `async` callback's rejected promise is owned at every delivery seam
     * (#B399): it answers 500 instead of leaving the request hanging.
     *
     * @param {object}   options          - Request options (host, port, path, method, …).
     *   `options.auth` (`"user:password"`) is minted into an `Authorization: Basic`
     *   header on both transports before dispatch; a caller-supplied
     *   `authorization` header wins (#B465).
     *   `options.body` (Buffer | string, #B489) is sent verbatim under the caller's
     *   own `headers['content-type']` (defaulting to `application/octet-stream`) on
     *   both transports — the json labelling and the HTTP/2 incoming content-type
     *   relabel are both skipped. `data` must then be empty (`BODY_AND_DATA`); any
     *   other body type is refused (`BODY_TYPE`). Both refusals are synchronous and
     *   the upstream is never contacted.
     * @param {object}   [data]           - Request body / query params
     * @param {function} [callback]       - `callback(err, result)` — omit (or pass `null`) to get the onComplete handle
     * @fires SuperController#query.complete only from the one-tick fallback, when nothing consumed the outcome (no callback, no `onComplete`) — the two transport handlers never emit
     * @returns {void|object} `undefined` in callback form; the `{onComplete}` handle otherwise — on every path, including the synchronous failures (#B475) and the nested-render refusal (#B479)
     */
    // replaced: arguments object — use named params (#P23)
    this.query = function(options, data, callback) {
        var err = null;
        if ( typeof(data) == 'function' ) {
            callback = data;
            data = {};
        }
        data = data || {};
        // #B475 — the fluent form gets ONE per-call delivery channel. A missing
        // (or null) callback used to mean "emit `query#complete` on the shared
        // instance emitter", which the `{onComplete}` facades consumed with a
        // destructive `removeAllListeners` + `once`: a second fluent query on
        // the same instance evicted the first listener (its callback never
        // fired, the survivor could receive the other call's payload), and the
        // synchronous failure paths returned emit()'s boolean instead of the
        // handle. Now every fluent query rides the callback path — every
        // delivery guard and every retry carries this channel — and query()
        // returns the handle on every path. The event still fires, one tick
        // after settlement, when nothing consumed the outcome (a discarded
        // handle, a direct listener): the documented "if omitted, emits".
        var _handle = undefined;
        if ( typeof(callback) != 'function' ) {
            var _fluentCbs = [], _settledArgs = null;
            _handle = {
                onComplete: function(cb) {
                    // #B485 — fail fast at the caller's line, mirroring store()'s
                    // registration guard (#B480): a non-function used to be minted
                    // into a deliverer whose call threw inside _fluentDelivery's own
                    // try/catch and came back as a "Query Exception while catching
                    // back" 500 blaming the application callback.
                    if ( typeof(cb) != 'function' ) {
                        throw new TypeError('Controller::query — onComplete expects a function, got ' + ( cb === null ? 'null' : typeof(cb) ));
                    }
                    var deliver = _fluentDelivery(cb);
                    _fluentCbs.push(deliver);
                    if (_settledArgs) { // registered after the call settled
                        var lateArgs = _settledArgs;
                        process.nextTick(function() { deliver.apply(null, lateArgs); });
                    }
                    return _handle;
                }
            };
            callback = function perCallDelivery(err, data) {
                var args = arguments;
                if (_fluentCbs.length) {
                    _settledArgs = args;
                    for (var i = 0, len = _fluentCbs.length; i < len; ++i) {
                        _fluentCbs[i].apply(null, args);
                    }
                    return;
                }
                // nothing registered yet — a synchronous failure settling before
                // `.onComplete()` could run, or a handle nobody chained on: hold
                // one tick, then deliver if a callback arrived, else emit
                process.nextTick(function() {
                    _settledArgs = args;
                    if (_fluentCbs.length) {
                        for (var i = 0, len = _fluentCbs.length; i < len; ++i) {
                            _fluentCbs[i].apply(null, args);
                        }
                        return;
                    }
                    if (args.length > 1) {
                        self.emit('query#complete', args[0], args[1]);
                    } else {
                        self.emit('query#complete', args[0]);
                    }
                });
            };
        }
        // preventing multiple call of self.query() when controller is rendering from another required controller
        if (
            typeof(local.options) != 'undefined'
            && typeof(local.options.renderingStack) != 'undefined'
            && local.options.renderingStack.length > 1
        ) {
            // #B479 — this exit handed back a bare boolean and delivered nothing:
            // the callback form never fired and the fluent chain threw on it. A
            // refused query now settles like every other synchronous failure
            // (#B475): a coded Error reaches the per-call channel — in-line for
            // the callback form, next tick through the handle — under both
            // owners, the handle comes back, and the upstream is never contacted.
            // No emitter fallback: after the minting above `callback` is always
            // a function here.
            err = new Error('SuperController::query() refused: the controller is rendering from another required controller (renderingStack depth '+ local.options.renderingStack.length +')');
            err.code = 'NESTED_RENDER';
            try {
                _ownAsyncCbRejection(callback(err))
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
            return _handle;
        }
        // by default
        self.isProcessingError = false;

        // H3: critical flag — extract before merge() so it is never forwarded as an HTTP header.
        // When critical: false, HTTP/2 errors are swallowed (log-only) rather than propagating
        // to the caller or triggering throwError. Use for fire-and-forget calls like
        // updateLastLoginDate() where a background failure must not kill the user-facing response.
        var isCritical = typeof options.critical === 'boolean' ? options.critical : true;
        delete options.critical; // not an HTTP option — remove before merge/clean

        // #B489 — raw-body pass-through: a Buffer or string sent as-is under the caller's
        // own content-type. Extracted HERE, before the clone/merge below, for the same
        // reason `critical` is: JSON.clone() recurses into any object, so a Buffer left on
        // `options` would come out of the clone as a plain object of bytes.
        var rawBody    = options.body;
        var hasRawBody = ( typeof(rawBody) != 'undefined' && rawBody !== null );
        // Whether the CALLER labelled it: defaultOptions below fills content-type with the
        // json mime, so after the merge an unlabelled raw body is indistinguishable from a
        // deliberately json-labelled one. Decided here, while options is still the caller's.
        var hasRawBodyCT = !!( hasRawBody && options.headers && options.headers['content-type'] );
        delete options.body;
        if ( hasRawBody && !Buffer.isBuffer(rawBody) && typeof(rawBody) != 'string' ) {
            err = new Error('SuperController::query() `body` must be a Buffer or a string, got ' + typeof(rawBody));
            err.code = 'BODY_TYPE';
            try {
                _ownAsyncCbRejection(callback(err))
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
            return _handle;
        }

        var queryData           = {}
            , defaultOptions    = local.query.options
            , path              = options.path
            , browser           = null
        ;

        // Priority chain — all checks must run BEFORE merge(defaultOptions), which fills in "10s":
        //   1. options.requestTimeout  — explicit call-site override (highest priority)
        //   2. req.routing.queryTimeout — per-route default from routing.json
        //   3. "10s" from defaultOptions (lowest, filled by merge below)

        // Fall back to the calling route's queryTimeout if still not set.
        if (
            typeof options.requestTimeout === 'undefined'
            && typeof local.req !== 'undefined' && local.req
            && local.req.routing
            && local.req.routing.queryTimeout
        ) {
            options.requestTimeout = local.req.routing.queryTimeout;
        }

        // options must be used as a copy in case of multiple calls of self.query(options, ...)
        options = merge(JSON.clone(options), defaultOptions);
        // replaced: for...in + delete — build filtered copy (#P22, #P20)
        var cleanedOptions = {};
        var optionKeys = Object.keys(options);
        for (var oi = 0; oi < optionKeys.length; ++oi) {
            if ( typeof(options[optionKeys[oi]]) != 'undefined' && options[optionKeys[oi]] != undefined) {
                cleanedOptions[optionKeys[oi]] = options[optionKeys[oi]];
            }
        }
        options = cleanedOptions;

        // #B465 — mint Authorization from `auth`, then drop the option.
        // Node's `request()` consumed `auth` on HTTP/1.x only; on HTTP/2 the
        // option-copy loop forwarded it as a literal `auth:` header (the strip
        // set did not list it) and no Authorization was ever minted — credential
        // disclosure in a nonstandard header plus silently-unperformed auth.
        // Minting here and deleting the option gives both transports identical
        // wire bytes through one code path. A caller-supplied authorization
        // header always wins (node behaved the same way on HTTP/1.x). The block
        // reads `options` and the global `Buffer` only — keep it self-contained.
        if ( typeof(options.auth) != 'undefined' ) {
            if ( typeof(options.auth) == 'string' && options.auth != '' ) {
                if ( !options.headers ) {
                    options.headers = {};
                }
                var _hasAuthorizationHeader = false;
                var _authHeaderKeys = Object.keys(options.headers);
                for (var _ahi = 0; _ahi < _authHeaderKeys.length; ++_ahi) {
                    if ( _authHeaderKeys[_ahi].toLowerCase() == 'authorization' ) {
                        _hasAuthorizationHeader = true;
                        break;
                    }
                }
                if ( !_hasAuthorizationHeader ) {
                    options.headers.authorization = 'Basic ' + Buffer.from(options.auth).toString('base64');
                }
            }
            // Deleted unconditionally — an empty or malformed credential must
            // not leak as a header either.
            delete options.auth;
        }
        // end #B465

        // Normalize requestTimeout to ms once — covers both HTTP/1 and HTTP/2 paths.
        if (typeof options.requestTimeout !== 'undefined') {
            options.requestTimeout = parseTimeout(options.requestTimeout);
        }

        if (self.isCacheless() || self.isLocalScope() ) {
            options.rejectUnauthorized = false;
        }

        if ( !options.host && !options.hostname ) {
            err = new Error('SuperController::query() needs at least a `host IP` or a `hostname`');
            try {
                _ownAsyncCbRejection(callback(err))
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
            return _handle;
        }


        
        if ( hasRawBody ) {
            // #B489 — the raw body travels verbatim; data beside it has no wire form and is
            // refused rather than silently dropped.
            if ( data && typeof(data) == 'object' && Object.keys(data).length > 0 ) {
                err = new Error('SuperController::query() refused: `body` and a non-empty `data` were both given');
                err.code = 'BODY_AND_DATA';
                try {
                    _ownAsyncCbRejection(callback(err))
                } catch (_syncCbErr) {
                    _ownSyncCbThrow(_syncCbErr);
                }
                return _handle;
            }
            queryData = rawBody;
            // read by the HTTP/2 request prep (skips the incoming content-type relabel);
            // listed in _NON_HTTP_OPTS so it never becomes a header
            options._rawBody = true;
        } else if ( typeof(data) != 'undefined' &&  data.count() > 0) {

            queryData = '?';
            // TODO - if 'application/json' && method == (put|post)
            if ( ['put', 'post'].indexOf(options.method.toLowerCase()) >-1 && /(text\/plain|application\/json|application\/x\-www\-form)/i.test(options.headers['content-type']) ) {
                // Send the body as raw JSON. The wire content-type is forced to
                // application/json below, and the receiving parser (server.js
                // processRequestData) reads application/json verbatim — so the body must
                // NOT be percent-encoded. RFC5987 value-encoding is defined for HTTP
                // header values (e.g. filename*=), not request bodies; applying it here
                // produced a body the framework's own parser rejected.
                queryData = JSON.stringify(data)
            } else {
                //Sample request.
                //options.path = '/updater/start?release={"version":"0.0.5-dev","url":"http://10.1.0.1:8080/project/bundle/repository/archive?ref=0.0.5-dev","date":1383669077141}&pid=46493';
                // do not alter the orignal data
                // replaced: for...in — use Object.keys() (#P22)
                var tmpData = JSON.clone(data);
                var dataKeys = Object.keys(tmpData);
                for (var di = 0; di < dataKeys.length; ++di) {
                    var d = dataKeys[di];
                    if ( typeof(tmpData[d]) == 'object') {
                        tmpData[d] = JSON.stringify(tmpData[d]);
                    }
                    queryData += d + '=' + encodeRFC5987ValueChars(tmpData[d]) + '&';
                }

                queryData = queryData.substring(0, queryData.length-1);
                queryData = queryData.replace(/\s/g, '%20');

                options.path += queryData;
            }

        } else {
            queryData = ''
        }


        // #B489 — a raw body keeps the caller's own label; the forcing below belongs to
        // the data-encoded path, whose wire form really is json (or the MSIE text/plain).
        if ( !hasRawBody ) {
            // Internet Explorer override
            if ( local.req != null && /msie/i.test(local.req.headers['user-agent']) ) {
                options.headers['content-type'] = 'text/plain';
            } else {
                options.headers['content-type'] = local.options.conf.server.coreConfiguration.mime['json'];
            }
        } else if ( !hasRawBodyCT ) {
            options.headers['content-type'] = 'application/octet-stream'; // #B489 — unlabelled raw bytes
        }

        // if ( typeof(local.req.headers.cookie) == 'undefined' && typeof(local.res._headers['set-cookie']) != 'undefined' ) { // useful for CORS : forward cookies from the original request
        //     //options.headers.cookie = local.req.headers.cookie;
        //     var originalResponseCookies = local.res._headers['set-cookie'];
        //     options.headers.cookie = [];
        //     for (var c = 0, cLen = originalResponseCookies.length; c < cLen; ++c) {
        //         options.headers.cookie.push(originalResponseCookies[c])
        //     }
        // }

        // adding gina headers
        if ( local.req != null && typeof(local.req.ginaHeaders) != 'undefined' ) {
            // replaced: for...in — use Object.keys() + cache property ref (#P22, #P24)
            var formHeaders = local.req.ginaHeaders.form;
            var formKeys = Object.keys(formHeaders);
            for (var fi = 0; fi < formKeys.length; ++fi) {
                var h = formKeys[fi];
                var k = h.charAt(0).toUpperCase() + h.substring(1);
                options.headers['X-Gina-Form-' + k] = formHeaders[h];
            }
        }

        var ctx             = getContext()
            , protocol      = null
            , scheme        = null
            // #B65 — prefer THIS request's proxy classification (per-request slot) over
            // the sticky worker-global latch, so the internal-call forward reflects the
            // triggering request; fall back to the global for req-less callers.
            , isProxyHost   = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false )
            , bundle        = null
            , webroot       = options.webroot || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.webroot;// bundle servers's webroot by default
        ;
        // cleanup options.path
        if (/\:\/\//.test(options.path)) {

            var hArr    = options.path.split(/^(https|http)\:\/\//);
            var domain  = hArr[1] +'://';
            var host    = hArr[2].split(/\//)[0];
            var port    = parseInt(host.split(/\:/)[1] || 80);

            options.port = port;
            options.host = domain + host.replace(':'+port, '');
            options.path = options.path
                                .replace(options.host, '')
                                .replace(':'+port, '');
        }

        // if ( typeof(options.protocol) == 'undefined' ) {
        //     options.protocol = ctx.gina.config.envConf[ctx.bundle][ctx.env].server.protocol;
        // }

        // retrieve protocol & scheme: if empty, take the bundles protocol
        protocol    = options.protocol || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.protocol;// bundle servers's protocol by default
        protocol    = protocol.match(/[.a-z 0-9]+/ig)[0];
        scheme      = options.scheme || ctx.gina.config.envConf[ctx.bundle][ctx.env].server.scheme;// bundle servers's scheme by default
        scheme      = scheme.match(/[a-z 0-9]+/ig)[0];

        // retrieve credentials
        if ( typeof(options.ca) == 'undefined' || ! options.ca ) {
            options.ca  = ctx.gina.config.envConf[ctx.bundle][ctx.env].server.credentials.ca;
        }

        //retrieving dynamic host, hostname & port
        if ( /\@/.test(options.hostname) ) {

            bundle              = ( options.hostname.replace(/(.*)\:\/\//, '') ).split(/\@/)[0];
            // No shorcut possible because conf.hostname might differ from user inputs
            options.host        = ctx.gina.config.envConf[bundle][ctx.env].host.replace(/(.*)\:\/\//, '').replace(/\:\d+/, '');
            options.hostname    = ctx.gina.config.envConf[bundle][ctx.env].hostname;
            options.port        = ctx.gina.config.envConf[bundle][ctx.env].server.port;
            options.protocol    = options.protocol ||  ctx.gina.config.envConf[bundle][ctx.env].server.protocol;
            options.scheme      = ctx.gina.config.envConf[bundle][ctx.env].server.scheme;

            // retrieve credentials
            if ( typeof(options.ca) == 'undefined' || ! options.ca ) {
                options.ca = ctx.gina.config.envConf[bundle][ctx.env].server.credentials.ca;
            }
        }

        if ( typeof(options.protocol) == 'undefined' ) {
            options.protocol = protocol
        }
        if ( typeof(options.scheme) == 'undefined' ) {
            options.scheme = scheme
        }

        // reformating scheme
        if( !/\:$/.test(options.scheme) ) {
            options.scheme += ':';
        }

        if (isProxyHost) {
            // #B65 — forward THIS request's proxied host (per-request slot), falling back
            // to the worker-global for req-less callers (released-response / ws-query).
            // X-Forwarded-Host
            options.headers['x-forwarded-host'] = ( local.req && local.req._ginaProxyHost ) ? local.req._ginaProxyHost : process.gina.PROXY_HOST;
            // X-Forwarded-Proto
            options.headers['x-forwarded-proto'] = process.gina.PROXY_SCHEME;
        }

        // #QI — propagate Inspector profiling to the target bundle so it
        // captures queries and timeline entries for cross-bundle propagation.
        // #INS10 — also propagate to the target bundle during a prod instrumentation window.
        if ((process.gina && process.gina._inspectorWindowUntil > Date.now()) || (_isDev && process.gina._inspectorActive)) {
            options.headers['x-gina-inspector'] = 'true';
        }

        if ( ctx.gina.config.envConf[ctx.bundle][ctx.env].server.resolvers.length > 0 ) {
            var resolversColl = new Collection(ctx.gina.config.envConf[ctx.bundle][ctx.env].server.resolvers);
            options.nameservers = resolversColl.findOne({ scope: process.env.NODE_SCOPE}).nameservers;
            resolversColl = null;
        }

        try {
            options.queryData = queryData;

            // #FI — save target bundle name before clearing (for Flow label)
            if (_isDev && bundle) {
                options._targetBundle = bundle;
            }
            bundle = null;

            // TODO - Add preferred communication method option: cCurl or HTTP
            // return handleCurlRequest(options, callback);

            var protocolVersion = ~~options.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');
            var httpLib =  options.protocol.match(/^(.*)\//)[1] + ( (protocolVersion >= 2) ? protocolVersion : '' );
            if ( !/http2/.test(httpLib) && /https/.test(options.scheme) ) {
                httpLib += 's';
            }

            // #MS5 — per-authority circuit breaker (opt-in: settings.json
            // `server.query.circuitBreaker`, boot-resolved onto the engine
            // instance by server.js `start()`). Gating happens HERE, above the
            // protocol dispatch, so an open circuit rejects before any
            // connection, retry or pre-flight machinery runs: the #B34/#B52/#B53
            // invariants inside the handlers are untouched, and retries can
            // never hammer an open circuit.
            var _cbConf = self.serverInstance && self.serverInstance._queryCircuitBreaker;
            if ( _cbConf && _cbConf.enabled ) {
                var _cbAuthority = options.hostname + ':' + options.port;
                var _cbEntry     = _getCircuitEntry(_cbAuthority);
                var _cbGate      = _circuitAdmit(_cbEntry, _cbConf, isCritical);
                if ( !_cbGate.admitted ) {
                    var _cbErr = new GinaCircuitOpenError(_cbAuthority, _cbGate.retryAfterMs);
                    if (!isCritical) {
                        // mirror the H3 `_swallowIfNonCritical` contract: log-only, no callback
                        console.warn('[QUERY][circuit-open][non-critical] swallowed '+ (options.method || '') +' '+ (options.path || '') +' to '+ _cbAuthority);
                        return _handle;
                    }
                    try {
                        _ownAsyncCbRejection(callback(_cbErr));
                    } catch (_syncCbErr) {
                        _ownSyncCbThrow(_syncCbErr);
                    }
                    return _handle;
                }
                // every admitted query records its outcome: since #B475 `callback` is
                // always a function here (the fluent form rides the per-call channel),
                // so a half-open probe is observable in both forms and nothing has to
                // release the slot early
                var _cbOriginalCallback = callback;
                var _cbSettled = false;
                callback = function onCircuitObservedOutcome(err) {
                    if (!_cbSettled) { // record once, whatever the terminal
                        _cbSettled = true;
                        _circuitRecord(_cbEntry, _cbConf, _cbGate.probe, err);
                    }
                    return _cbOriginalCallback.apply(this, arguments);
                };
            }

            browser = require(''+ httpLib);
            // #FI — capture query call start time for Flow timeline
            if (_isDev && local._timeline) {
                options._timelineStart = Date.now();
            }
            if ( /http2/.test(httpLib) ) {
                handleHTTP2ClientRequest(browser, options, callback, 0, isCritical);
            } else {
                handleHTTP1ClientRequest(browser, options, callback);
            }
            return _handle;

        } catch(err) {
            try {
                _ownAsyncCbRejection(callback(err))
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
            return _handle;
        }
    }

    // var handleCurlRequest = async function(opt, callback) {

    //     var body = null;
    //     // https://docs.couchbase.com/server/current/n1ql-rest-query/index.html#Request
    //     var cmd = [
    //         '$(which curl)'
    //     ];

    //     if (!opt.rejectUnauthorized) {
    //         // (SSL) This option explicitly allows curl to perform "insecure" SSL connections and transfers
    //         // same as --insecure
    //         cmd.splice(1,0,'-k');
    //     }

    //     // method
    //     if ( !/get/i.test(opt.method) ) {
    //         cmd.splice(1,0,'-X '+ opt.method.toUpperCase() );
    //     }


    //     if ( /(post|put)/i.test(opt.method) && opt.queryData.length > 0) {
    //         cmd.push('-d '+ opt.queryData );
    //         body = Buffer.from(opt.queryData);
    //         opt.headers['content-length'] = body.length;
    //     } else if (
    //         /get/i.test(opt.method)
    //         && typeof(opt.headers['content-length']) != 'undefined'
    //     ) {
    //         delete opt.headers['content-length'];
    //     }

    //     if ( opt.headers.count() > 0) {
    //         for (let h in opt.headers) {
    //             cmd.splice(1,0,'-H "'+ h +': '+ opt.headers[h] +'"');
    //         }
    //     }

    //     // resolvers
    //     if (opt.nameservers) {
    //         resolver.setServers(opt.nameservers);
    //         await resolver
    //             .resolve4(opt.host)
    //             .catch( function onResolverErr(e) {
    //                 var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                 var msg = 'Could not resolve with these `settings.server.resolvers`:\n'+ opt.nameservers.toString() +'\n' + e.stack+ '\nController Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r';
    //                 var exception = new Error(msg);
    //                 exception.status = 500;
    //                 return self.throwError(exception);
    //             })
    //             .then( function onResolved(ips) {
    //                 if ( typeof(ips) == 'undefined' || !Array.isArray(ips) || !ips.length ) {
    //                     var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                     var e = new Error('`Unable to resolve ${opt.host}`');
    //                     var msg = 'Please check`settings.server.resolvers`:\n'+ opt.nameservers.toString() +'\n'+ e.stack + 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r';
    //                     var exception = new Error(msg);
    //                     exception.status = 500;
    //                     return self.throwError(exception);
    //                 }
    //                 for (let i=0, len=ips.length; i<len; i++) {
    //                     // e.g.: --resolve www.example.com:443:127.0.0.1
    //                     cmd.push('--resolve '+ opt.host +':'+ opt.port +':'+ ips[i]);
    //                 }
    //             });
    //     }




    //     cmd.push('-v "'+ opt.hostname + opt.path +'"');

    //     // Default maxBuffer is 200KB (=> 1024 * 200)
    //     // Setting it to 10MB - preventing: stdout maxBuffer length exceeded
    //     var maxBuffer = (1024 * 1024 * 10);
    //     exec(cmd.join(' '), { maxBuffer: maxBuffer }, function onResult(err, dataStr, infos) {
    //         var error = null;
    //         if (err) {
    //             try {
    //                 // by default
    //                 error = new Error('[ CONTROLLER ][ CURL#query ] request aborted\n'+ err.stack);
    //                 if (
    //                     typeof(err.message) != 'undefined'
    //                     && /Failed to connect/i.test(err.message)
    //                 ) {
    //                     var port = getContext('gina').ports[opt.protocol][opt.scheme.replace(/\:/, '')][ opt.port ];
    //                     error.accessPoint = port;
    //                     error.message = 'Could not connect to [ ' + error.accessPoint + ' ].\nThe `'+port.split(/\@/)[0]+'` bundle is offline or unreachable.\n';
    //                 }
    //                 console.error(error.stack);
    //                 if ( typeof(callback) != 'undefined' ) {
    //                     callback(error)
    //                 } else {
    //                     self.emit('query#complete', error)
    //                 }
    //             } catch (e) {
    //                 // console.error(e.stack);
    //                 var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //                 var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
    //                 var exception = new Error(msg);
    //                 exception.status = 500;
    //                 self.throwError(exception);
    //             }
    //             return;
    //         }


    //         try {
    //             let data = JSON.parse(dataStr);
    //             if ( typeof(data) == 'undefined' ) {
    //                 data = {}
    //             }
    //             if ( typeof(callback) != 'undefined' ) {
    //                 callback(err, data)
    //             } else {
    //                 self.emit('query#complete', err, data)
    //             }
    //         } catch (e) {
    //             // _err.stack = '[ CONTROLLER ][ CURL#query ] onCallbackError: '+ e.stack;
    //             // console.error(e.stack);
    //             var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
    //             var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
    //             var exception = new Error(msg);
    //             exception.status = 500;
    //             self.throwError(exception);
    //             return;
    //         }
    //     });
    // }

    // var handleHTTP1ClientRequestv2 = function (browser, options, callback) {
    //     var agent = new browser.Agent({ keepAlive: true });
    //     var options = {
    //         host: options.host,
    //         port: options.port,
    //         path: options.path,
    //         method: 'GET',
    //         agent: agent
    //     };

    //     var req = browser.request(options, function(res) {
    //         var str = "";
    //         var err = false;
    //         res.on('data', function (chunk) {
    //             str += chunk;
    //         });
    //         res.on('end', function () {
    //             // done
    //             return callback( err, data );
    //         });
    //     });
    //     req.write('');
    //     req.end();
    //     req.on('error', function(error) {
    //         err = error
    //     });
    // };

    /**
     * Error surfaced by `query()` when the target authority's circuit is OPEN (#MS5).
     *
     * Minted ABOVE the HTTP/1.x / HTTP/2 dispatch — before any connection attempt,
     * retry or pre-flight PING runs — so it applies identically to both client
     * paths. The field shape mirrors `GinaHttp2Error` (`code`, `retryable`,
     * `status`, `retryCount`) so machine consumers can switch on `code` without
     * caring which transport would have been used; the name is protocol-neutral
     * on purpose.
     *
     * @constructor
     * @param {string} authority    - `hostname:port` whose circuit is open
     * @param {number} retryAfterMs - Milliseconds until the next half-open probe may be admitted (0 = a probe slot is free now)
     */
    function GinaCircuitOpenError(authority, retryAfterMs) {
        Error.call(this);
        this.name    = 'GinaCircuitOpenError';
        this.message = 'Controller::query() circuit is OPEN for [ '+ authority +' ] — failing fast'+ ( retryAfterMs > 0 ? ' (next probe allowed in '+ retryAfterMs +'ms)' : '' );
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, GinaCircuitOpenError);
        } else {
            this.stack = (new Error(this.message)).stack;
        }
        this.code         = 'CIRCUIT_OPEN';
        this.retryable    = false;
        this.status       = 503;
        this.retryCount   = 0;
        this.authority    = authority;
        this.retryAfterMs = retryAfterMs;
    }
    GinaCircuitOpenError.prototype             = Object.create(Error.prototype);
    GinaCircuitOpenError.prototype.constructor = GinaCircuitOpenError;

    /**
     * Transport-failure classifier for the #MS5 circuit breaker.
     *
     * Counts ONLY errors that indicate the upstream (or the path to it) is
     * unhealthy: every `GinaHttp2Error` (all of its codes are transport-class —
     * post-#B34 an application response, whatever its status, flows through the
     * SUCCESS terminus as data, never as `err`) plus the HTTP/1.x socket-level
     * codes, checked on `err.code` and `err.cause.code` (the HTTP/1.x error path
     * annotates both shapes). Anything else — a caller bug surfacing through the
     * sync dispatch `catch`, a malformed option, an app-level error — is NEUTRAL:
     * it neither trips nor resets the circuit, because it says nothing about
     * upstream health.
     *
     * @inner
     * @param   {*} err - Whatever the client path surfaced to the query callback
     * @returns {boolean} `true` when the error counts toward opening the circuit
     */
    var _CB_TRANSPORT_CODES = /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|ECONNABORTED|EHOSTUNREACH|ENETUNREACH)$/;
    var _isCircuitTransportFailure = function(err) {
        if (!err) return false;
        if (err.name === 'GinaHttp2Error') return true;
        var code = err.code || (err.cause && err.cause.code);
        return _CB_TRANSPORT_CODES.test(String(code || ''));
    };

    /**
     * Lazily fetch (or mint) the per-authority breaker entry (#MS5).
     *
     * State lives on the SERVER instance — the same home as `_http2Sessions` —
     * because dev mode re-requires this module per request (see the #B52 note):
     * module- or controller-level state would reset on every hot-reload, while
     * instance state survives reloads and dies on restart, which is exactly the
     * lifetime circuit state wants. Entries are keyed per distinct
     * `hostname:port`; query targets come from bundle config and app code (a
     * trusted surface), so cardinality is not attacker-controlled.
     *
     * @inner
     * @param   {string} authority - `hostname:port`
     * @returns {object} `{ state, consecutiveFailures, openedAt, probeInFlight }`
     */
    var _getCircuitEntry = function(authority) {
        if (!self.serverInstance._queryCircuitBreakers) {
            self.serverInstance._queryCircuitBreakers = {};
        }
        var registry = self.serverInstance._queryCircuitBreakers;
        if (!registry[authority]) {
            registry[authority] = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
        }
        return registry[authority];
    };

    /**
     * Admission decision for one outgoing query under the #MS5 breaker.
     *
     * Runs the lazy OPEN → HALF-OPEN transition first (the breaker owns NO
     * timers: elapsed time is computed on access), then answers:
     *
     *  - CLOSED            → admit
     *  - OPEN, cooling     → reject, reporting the remaining cooldown
     *  - OPEN, cooled down → become HALF-OPEN and fall through
     *  - HALF-OPEN         → admit exactly ONE probe, and only for a CRITICAL
     *    request: a non-critical failure is swallowed by `_swallowIfNonCritical`
     *    (its callback never fires), so a non-critical probe could never report
     *    back and would wedge `probeInFlight` forever. Everything else is
     *    rejected until the probe settles.
     *
     * @inner
     * @param   {object}  entry      - Breaker entry from `_getCircuitEntry()`
     * @param   {object}  conf       - Resolved policy (`failureThreshold`, `cooldownMs`)
     * @param   {boolean} isCritical - The query's H3 criticality flag
     * @returns {object}  `{ admitted, probe, retryAfterMs }`
     */
    var _circuitAdmit = function(entry, conf, isCritical) {
        if (entry.state === 'open') {
            var elapsed = Date.now() - entry.openedAt;
            if (elapsed < conf.cooldownMs) {
                return { admitted: false, probe: false, retryAfterMs: conf.cooldownMs - elapsed };
            }
            entry.state = 'half-open';
            entry.probeInFlight = false;
        }
        if (entry.state === 'half-open') {
            if (entry.probeInFlight || !isCritical) {
                return { admitted: false, probe: false, retryAfterMs: 0 };
            }
            entry.probeInFlight = true;
            return { admitted: true, probe: true, retryAfterMs: 0 };
        }
        return { admitted: true, probe: false, retryAfterMs: 0 };
    };

    /**
     * Record one settled query outcome against its authority's circuit (#MS5).
     *
     *  - success             → CLOSED, counter reset (a settling probe closes the circuit)
     *  - transport failure   → counter + 1; reaching `failureThreshold` — or failing
     *                          the half-open probe — re-opens with a fresh cooldown
     *  - neutral (non-transport) error → releases a probe slot but otherwise
     *    changes nothing (see `_isCircuitTransportFailure`)
     *
     * @inner
     * @param {object}  entry   - Breaker entry
     * @param {object}  conf    - Resolved policy
     * @param {boolean} isProbe - Whether this outcome settles the half-open probe
     * @param {*}       err     - The callback's error argument (`false` on success — see §9's sentinel)
     */
    var _circuitRecord = function(entry, conf, isProbe, err) {
        if (isProbe) {
            entry.probeInFlight = false;
        }
        if (!err) {
            entry.state = 'closed';
            entry.consecutiveFailures = 0;
            return;
        }
        if ( !_isCircuitTransportFailure(err) ) {
            return; // neutral — caller bug or app-level error
        }
        entry.consecutiveFailures++;
        if (isProbe || entry.consecutiveFailures >= conf.failureThreshold) {
            entry.state = 'open';
            entry.openedAt = Date.now();
        }
    };

    /**
     * #B53 — Idempotency guard for inter-bundle client retries.
     *
     * A transient failure can land AFTER the upstream bundle already executed its handler
     * (stream timeout, ECONNRESET, GOAWAY premature-close, proxy 502) — only the response is
     * lost, not the side effect. Auto-retrying then silently re-executes the request, so a
     * non-idempotent POST/PUT/PATCH/DELETE runs twice. Both client paths
     * (handleHTTP1ClientRequest / handleHTTP2ClientRequest) therefore re-send on a transient
     * failure only when replay is safe.
     *
     * Idempotency (PUT/DELETE) is a transport property, not a side-effect property — a PUT or
     * DELETE fronting a side-effecting handler is still unsafe to replay — so by default only
     * the HTTP "safe" methods (no side effects, idempotent) auto-retry. A caller that owns a
     * genuinely replay-safe non-safe endpoint opts in per-call with `retryUnsafe: true`.
     *
     * @inner
     * @param   {string}  method        - HTTP method, any case (HTTP/2 `:method` is already upper-cased).
     * @param   {boolean} [retryUnsafe] - When strictly `true`, allow re-sending any method.
     * @returns {boolean} `true` when the request may be safely re-sent on a transient failure.
     *
     * @example
     * isRetryableMethod('GET');         // → true  (safe method)
     * isRetryableMethod('post');        // → false (non-idempotent, not opted in)
     * isRetryableMethod('POST', true);  // → true  (caller affirmed replay-safety)
     */
    var SAFE_HTTP_METHODS = { GET: true, HEAD: true, OPTIONS: true, TRACE: true };
    var isRetryableMethod = function(method, retryUnsafe) {
        if (retryUnsafe === true) { return true; }
        return SAFE_HTTP_METHODS[ String(method || '').toUpperCase() ] === true;
    };

    /**
     * HTTP/1.x client request handler with the #B53 idempotency-gated retry.
     *
     * Sends an HTTP/1.x request to an upstream (inter-bundle `self.query()`) and
     * re-sends on a connection failure while `retryCount` stays under
     * `min(options.maxRetry, 10)` and `isRetryableMethod` allows the replay, with a
     * linear 500 ms × attempt backoff. Every terminal — transport error, ALPN
     * mismatch, unparsable body, non-2xx, success — delivers through `callback`;
     * nothing is emitted here (the `query#complete` fallback belongs to `query()`).
     *
     * @inner
     * @param {object}   browser         - HTTP/1.x client module (node:http or node:https)
     * @param {object}   options         - Request options (host, port, path, method, headers, …)
     * @param {function} callback        - Node-style callback — always supplied by `query()` since #B475 (the per-call channel behind the fluent handle)
     * @param {number}   [retryCount=0]  - Current retry attempt (0 = first try)
     */
    var handleHTTP1ClientRequest = function(browser, options, callback, retryCount = 0) {


        // [HTTP1] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if ( local.req != null && typeof(local.req.headers['x-client-ip']) != 'undefined' && local.req.headers['x-client-ip'] != options.headers['x-client-ip'] ) {
            options.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }

        if ( local.req != null && typeof(local.req.headers['x-ingress-ip']) != 'undefined' && local.req.headers['x-ingress-ip'] != options.headers['x-ingress-ip'] ) {
            options.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        // MS1 — forward the always-on correlation id (sanitised req._ginaReqId);
        // a caller-set x-request-id always wins.
        if ( local.req != null && local.req._ginaReqId && typeof(options.headers['x-request-id']) == 'undefined' ) {
            options.headers['x-request-id'] = local.req._ginaReqId;
        }

        if ( /https/.test(options.scheme) && typeof(options.ca) == 'undefined' ) {
            console.warn('[ CONTROLLER ][ HTTPS/1.1#query ] options.ca not found !');
        }
        else if ( /https/.test(options.scheme) ) {
            try {
                if ( !/-----BEGIN/.test(options.ca) ) {
                    options.ca = fs.readFileSync(options.ca);
                }
            } catch(err) {
                try {
                    return _ownAsyncCbRejection(callback(err))
                } catch (_syncCbErr) {
                    return _ownSyncCbThrow(_syncCbErr);
                }
            }
        }
        if ( retryCount > 0 && typeof(options.queryData) == 'undefined' && Buffer.isBuffer(options._body) ) {
            options.queryData = options._body; // #B494 — restore the stashed body: the first attempt deleted queryData
        }
        let body = "";
        if (options.queryData) {
            // Convert into Buffer to properly handle UTF-8
            body = Buffer.isBuffer(options.queryData)
                ? options.queryData
                : Buffer.from(typeof options.queryData === 'string' ? options.queryData : JSON.stringify(options.queryData));

            options.headers['content-length'] = body.length;
            options.queryData = body;
            options._body = body; // #B494 — stash (mirrors the HTTP/2 handler) so a retry re-sends the same body
        } else {
            options.headers['content-length'] = 0;
        }
        delete options.queryData;


        // Shared Agent
        options.agent = new browser.Agent(options);

        const req = browser.request(options, function(res) {

            res.setEncoding('utf8');

            // upgrade response headers to handler
            if ( typeof(res.headers['access-control-allow-credentials']) != 'undefined' ) {
                local.options.withCredentials = res.headers['access-control-allow-credentials'];
            }

            let data = '';
            res.on('data', function onData (chunk) {
                data += chunk;
            });

            res.on('end', function onEnd(err) {
                // exceptions filter
                if ( typeof(data) == 'string' && /^Unknown ALPN Protocol/.test(data) ) {
                    err = {
                        status: 500,
                        error: new Error(data)
                    };

                    try {
                        return _ownAsyncCbRejection(callback(err))
                    } catch (_syncCbErr) {
                        return _ownSyncCbThrow(_syncCbErr);
                    }
                }

                if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
                    try {
                        data = JSON.parse(data)
                    } catch (err) {
                        data = {
                            status    : 500,
                            error     : err
                        };
                        console.error(err);
                    }
                }

                try {
                    if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
                        // replaced: self.throwError(data) — throwError() bypasses the callback,
                        // preventing controllers from implementing graceful degradation (e.g. degraded
                        // mode when a non-critical upstream service fails). Pass the error to the
                        // callback so the caller decides whether to degrade or surface it. (#Q1)
                        return _ownAsyncCbRejection(callback(data));
                    }

                    return _ownAsyncCbRejection(callback( false, data ));
                } catch (e) {
                    var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                    var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
                    var exception = new Error(msg);
                    exception.status = 500;

                    return self.throwError(exception);
                }
            })
        });


        //starting from from >0.10.15
        req.on('error', function onError(err) {

            // If conn is down (ECONNRESET, ETIMEDOUT),retry
            // #B53 — but only re-send when replay is safe: a safe method, or a caller that opted
            // in via options.retryUnsafe. This handler also fires for post-send failures (the
            // requestTimeout below calls req.destroy() after the body is written), so an unguarded
            // retry would silently re-execute a non-idempotent request.
            if (retryCount < Math.min(options.maxRetry, 10) && isRetryableMethod(options.method, options.retryUnsafe)) {
                const delay = 500 * (retryCount + 1); // Délai progressif
                return setTimeout(() => handleHTTP1ClientRequest(browser, options, callback, retryCount + 1), delay);
            }

            if (
                typeof(err.code) != 'undefined' && /ECONNREFUSED|ECONNRESET/.test(err.code)
                || typeof(err.cause) != 'undefined' && typeof(err.cause.code) != 'undefined' &&  /ECONNREFUSED|ECONNRESET/.test(err.cause.code)
            ) {

                var port = getContext('gina').ports[options.protocol][options.scheme.replace(/\:/, '')][ options.port ];//err.port || err.cause.port
                if ( typeof(port) != 'undefined' ) {
                    err.accessPoint = port;
                    err.message = '`Controller::query()` could not connect to [ ' + err.accessPoint + ' ] using port '+options.port+'.\n';
                }
            }


            console.error(err.stack||err.message);
            // you can get here if :
            //  - you are trying to query using: `enctype="multipart/form-data"`
            //  -
            try {
                return _ownAsyncCbRejection(callback(err))
            } catch (_syncCbErr) {
                return _ownSyncCbThrow(_syncCbErr);
            }
        });

        req.setTimeout(parseTimeout(options.requestTimeout), () => {
            req.destroy(); // Will trigger 'error' event
        });


        if (req) { // don't touch this please

            if (req.write) req.write(body);
            if (req.end) req.end();
        }

        // #B475 — no per-transport {onComplete} facade here any more: query()
        // mints ONE per-call channel for the fluent form and returns the handle
        // itself, so this handler always receives a callback.

    }

    /**
     * Typed HTTP/2 client error — H4.
     * All HTTP/2 failure modes (GOAWAY, timeout, stream error, premature close, 502,
     * pre-flight PING failure) surface as GinaHttp2Error instances, giving callers
     * machine-readable `code`, `retryable`, `status`, and `retryCount` fields
     * without having to inspect message strings or embedded status objects.
     *
     * @constructor
     * @param {string}  message            - Human-readable error description
     * @param {object}  opts
     * @param {string}  opts.code          - PREMATURE_CLOSE | TIMEOUT | STREAM_ERROR | ECONNRESET | ECONNREFUSED | BAD_GATEWAY | PREFLIGHT_TIMEOUT | PREFLIGHT_FAILED
     * @param {boolean} opts.retryable     - true when further retries are still possible
     * @param {number}  opts.status        - HTTP status to surface to the caller (502, 503, 500…)
     * @param {number}  opts.retryCount    - number of retries already attempted (0 = original request failed)
     */
    function GinaHttp2Error(message, opts) {
        Error.call(this);
        this.name    = 'GinaHttp2Error';
        this.message = message;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, GinaHttp2Error);
        } else {
            this.stack = (new Error(message)).stack;
        }
        opts             = opts || {};
        this.code        = opts.code        || 'UNKNOWN';
        this.retryable   = typeof opts.retryable  === 'boolean' ? opts.retryable  : false;
        this.status      = opts.status      || 500;
        this.retryCount  = typeof opts.retryCount === 'number' ? opts.retryCount : 0;
        // Backward compatibility: retriedOnce is derived from retryCount
        this.retriedOnce = this.retryCount > 0;
    }
    GinaHttp2Error.prototype             = Object.create(Error.prototype);
    GinaHttp2Error.prototype.constructor = GinaHttp2Error;

    // Maps native Node.js error codes to GinaHttp2Error.code values.
    var _http2ErrCodeMap = {
        'ERR_HTTP2_STREAM_ERROR'  : 'STREAM_ERROR',
        'ERR_HTTP2_SESSION_ERROR' : 'STREAM_ERROR',
        'ECONNRESET'              : 'ECONNRESET',
        'ECONNREFUSED'            : 'ECONNREFUSED'
    };

    /**
     * HTTP/2 client request handler with retry, backoff, and pre-flight PING.
     *
     * Sends an HTTP/2 request to an upstream bundle (inter-bundle `self.query()`).
     * Caches sessions per-authority. Validates session freshness via pre-flight PING
     * before sending on a cached session whose last PONG is older than HTTP2_PREFLIGHT_STALE_MS.
     * Retries up to HTTP2_MAX_RETRIES times on transient failures (timeout, stream error,
     * premature close, 502, pre-flight failure) with HTTP2_RETRY_DELAY_MS backoff on 2nd+ retry.
     * ECONNREFUSED is never retried.
     *
     * @inner
     * @param {object}   browser     - HTTP/2 client module (node:http2)
     * @param {object}   options     - Request options (:authority, :method, :path, :scheme, headers, etc.)
     * @param {function} callback    - Node-style callback — always supplied by `query()` since #B475 (the per-call channel behind the fluent handle); every terminal delivers through it and nothing is emitted here
     * @param {number}   [retryCount=0] - Current retry attempt (0 = first try)
     * @param {boolean}  [isCritical=true] - When false, errors are swallowed silently (H3)
     */
    var handleHTTP2ClientRequest = function(browser, options, callback, retryCount = 0, isCritical = true) {

        var HTTP2_SESSION_MAX = 50;           // max concurrent HTTP/2 sessions in cache
        var HTTP2_MAX_RETRIES = 2;            // total retry attempts (original + 2 retries = 3 tries)
        var HTTP2_RETRY_DELAY_MS = 500;       // delay before 2nd+ retry (backoff)
        var HTTP2_PREFLIGHT_STALE_MS = 3000;  // session stale if last PONG > 3s ago
        var HTTP2_PREFLIGHT_DEADLINE_MS = 1500; // pre-flight PING timeout

        // H3: non-critical error helper. When isCritical is false, errors are swallowed
        // (log-only) instead of propagating to the caller. Returns true when swallowed
        // so call sites can `return _swallowIfNonCritical(err)` and stop processing.
        var _swallowIfNonCritical = function(err) {
            if (isCritical) return false;
            console.warn('[HTTP2][non-critical] swallowed error on '+ (options[':method'] || '') +' '+ (options[':path'] || '') +': '+ (err && err.message || err));
            return true;
        };

        //cleanup
        options[':authority'] = options.hostname;

        if ( typeof(options[':path']) == 'undefined' ) {
            options[':path'] = options.path;
            delete options.path;
        }
        if ( typeof(options[':method']) == 'undefined' ) {
            options[':method'] = options.method.toUpperCase();
            delete options.method;
        }

        if ( typeof(options[':scheme']) == 'undefined' ) {
            options[':scheme'] = options.scheme;
        }

        if ( typeof(options[':hostname']) == 'undefined' ) {
            options[':hostname'] = options.hostname;
        }
        if (
            typeof(options[':port']) == 'undefined'
            && typeof(options.port) != 'undefined'
            && options.port
        ) {
            options[':port'] = options.port;
            options[':hostname'] = options.host;
        }
        delete options.host;

        if ( /https/.test(options.scheme) && typeof(options.ca) == 'undefined' ) {
            console.warn('[ CONTROLLER ][ HTTP/2.0#query ] options.ca not found !');
        }
        else if ( /https/.test(options.scheme) ) {
            try {
                if ( !/-----BEGIN/.test(options.ca) ) {
                    options.ca = fs.readFileSync(options.ca);
                }
            } catch(err) {
                try {
                    return _ownAsyncCbRejection(callback(err))
                } catch (_syncCbErr) {
                    return _ownSyncCbThrow(_syncCbErr);
                }
            }
        }


        var body = options.queryData
            ? Buffer.from(options.queryData)
            : Buffer.alloc(0);
        options.headers['content-length'] = body.length;
        options._body = body; // stash before deleting queryData so retries can reuse it
        delete options.queryData;


        options.settings = {
            // Prevents the NGHTTP2_PROTOCOL_ERROR on long URLs (UUIDs)
            maxHeaderListSize: 65535,
            maxConcurrentStreams: 100,
            enablePush: false
        }

        let authority = options.hostname;
        cache.from(self.serverInstance._cached);
        let sessKey = "http2session:"+ authority;
        let requestId = `${options[':method']}:${options[':path']}:${Date.now()}`; // For debugging

        // Session key tracker — stored on server instance (same scope as cache)
        if (!self.serverInstance._http2Sessions) {
            self.serverInstance._http2Sessions = [];
        }

        let client = cache.get(sessKey);
        // Checking client status: is closed or being closed
        // Note: client.connecting === false means the session is ESTABLISHED (connected), not stale.
        // Only evict sessions that are actually closed or destroyed.
        if (client && (client.closed || client.destroyed)) {
            client = null;
            cache.delete(sessKey);
            var _staleIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
            if (_staleIdx !== -1) self.serverInstance._http2Sessions.splice(_staleIdx, 1);
            _staleIdx = null;
        }

        var _pingInterval = null; // keepalive interval — scoped here so all handlers below can reference it

        if (!client || client.destroyed || client.closed) {

            // Evict the oldest session if the cache has reached its limit
            if (self.serverInstance._http2Sessions.length >= HTTP2_SESSION_MAX) {
                var _evictKey    = self.serverInstance._http2Sessions.shift();
                var _evictClient = cache.get(_evictKey);
                if (_evictClient && !_evictClient.destroyed) _evictClient.destroy();
                cache.delete(_evictKey);
                console.warn('[HTTP2] Session cache limit ('+ HTTP2_SESSION_MAX +') reached. Evicted oldest session: '+ _evictKey);
                _evictKey    = null;
                _evictClient = null;
            }

            client = browser.connect(authority, options);
            client._lastPongAt = Date.now(); // session just connected — inherently validated

            // Optional but recommended on M4/Orbstack
            client.setTimeout(0); // disable the default timeout to keep session active

            client.on('error', (error) => {
                // #H9 — the whole listener body is wrapped in try/catch so that a throw
                // from enhancement (undefined options.protocol/scheme), cache mutation,
                // or self.throwError cannot escape an 'error' event and become an
                // uncaughtException that crashes the bundle.
                try {
                    if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
                    try { console.error( '`'+ (options && options[':path']) +'` : '+ (error && (error.stack || error.message) || error)); } catch (_logErr) {}
                    try {
                        cache.delete(sessKey);
                        var _errIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                        if (_errIdx !== -1) self.serverInstance._http2Sessions.splice(_errIdx, 1);
                        _errIdx = null;
                    } catch (_cleanupErr) {
                        console.error('[HTTP2] Session cleanup failed in error handler: ' + (_cleanupErr.stack || _cleanupErr.message));
                    }
                    if (
                        error && (
                            (typeof(error.cause) != 'undefined' && typeof(error.cause.code) != 'undefined' && /ECONNREFUSED|ECONNRESET/.test(error.cause.code))
                            || /ECONNREFUSED|ECONNRESET/.test(error.code)
                        )
                    ) {
                        // #H9 — safe-navigate the port lookup; callers sometimes pass a bare
                        // hostname so options.protocol/options.scheme are undefined and the
                        // original `ports[undefined][undefined.replace(...)]` chain threw a
                        // TypeError from inside this error listener.
                        try {
                            var _ginaCtx = (typeof getContext === 'function') ? getContext('gina') : null;
                            var _portsMap = (_ginaCtx && _ginaCtx.ports && options && options.protocol)
                                ? _ginaCtx.ports[options.protocol] : null;
                            var _schemeKey = (options && options.scheme && typeof options.scheme.replace === 'function')
                                ? options.scheme.replace(/\:/, '') : null;
                            var _schemeMap = (_portsMap && _schemeKey) ? _portsMap[_schemeKey] : null;
                            var port = (_schemeMap && options) ? _schemeMap[options.port] : undefined;
                            if ( typeof(port) != 'undefined' && port !== null ) {
                                error.accessPoint = port;
                                var _bundleName = (typeof port === 'string') ? port.split(/\@/)[0] : String(port);
                                error.message = 'Could not connect to [ ' + error.accessPoint + ' ].\nThe `'+ _bundleName +'` bundle is offline or unreachable.\n';
                            }
                        } catch (_enhErr) {
                            console.error('[HTTP2] Error while enhancing connect-error message: ' + (_enhErr.stack || _enhErr.message));
                        }
                    }
                    // #B403 — the session-level answer is RETIRED: every live stream on a
                    // failing session self-delivers through its own handlers (request
                    // 'error' / 'close' / 'end' typed terminals), so this throwError only
                    // raced the app callback's own response for the SAME failure — and on
                    // a REUSED session this closure's local/req belong to the CREATING
                    // query, so it could answer with a stale request's context. Session
                    // cleanup and the error log above stay; request notification is owned
                    // by the stream-level deliveries.
                    // // local.req/res may be null when the error fires outside a request context
                    // // (background socket event) — log and return instead of crashing
                    // if (!local.req || !local.res) {
                    // console.error('[HTTP2] Session error outside request context — cannot send error response.\n' + (error && (error.stack || error.message) || error));
                    // return;
                    // }
                    // try {
                    // self.throwError(error);
                    // } catch (_throwErr) {
                    // console.error('[HTTP2] self.throwError failed in error handler: ' + (_throwErr.stack || _throwErr.message));
                    // }
                } catch (_handlerErr) {
                    // Last-resort swallow — throwing from an 'error' listener crashes the
                    // process. Log and return so the session failure stays contained.
                    try { console.error('[HTTP2] Uncaught failure inside error listener: ' + (_handlerErr.stack || _handlerErr.message)); } catch (_) {}
                }
                return;
            });

            client.on('close', () => {
                if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
                console.log('[CLIENT] Session expired or closed by server. Removing from cache.');
                cache.delete(sessKey);
                var _closeIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_closeIdx !== -1) self.serverInstance._http2Sessions.splice(_closeIdx, 1);
                _closeIdx = null;
            });

            client.on('goaway', (errorCode, lastStreamID) => {
                // #H5 — log GOAWAY details for upstream connection debugging
                console.warn('[http2] GOAWAY received — errorCode: ' + errorCode + ', lastStreamID: ' + lastStreamID + ', session: ' + sessKey);
                if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
                cache.delete(sessKey);
                var _goawayIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_goawayIdx !== -1) self.serverInstance._http2Sessions.splice(_goawayIdx, 1);
                _goawayIdx = null;
            });

            cache.set(sessKey, client);
            self.serverInstance._http2Sessions.push(sessKey);

            // Proactive keepalive: send HTTP/2 PING frames to prevent OrbStack ARM64 (and
            // any network layer) from silently dropping idle TCP connections. PING is the
            // application-level mechanism designed for exactly this — no socket manipulation.
            //
            // Two-layer detection:
            //   1. client.ping() callback — fires immediately if the server replies (fast path)
            //   2. _pingDeadline setTimeout — fires if PONG never arrives (silent TCP drop:
            //      kernel won't know the connection is dead without TCP keepalive probes,
            //      so the PONG callback becomes a ghost listener). The deadline evicts the
            //      dead session proactively so the next request uses a fresh connection
            //      instead of waiting for the 10s stream timeout.
            _pingInterval = setInterval(function onHttp2Ping() {
                if (!client || client.destroyed || client.closed) {
                    clearInterval(_pingInterval);
                    _pingInterval = null;
                    return;
                }
                var _pingDeadline = setTimeout(function onPingDeadline() {
                    // PONG never arrived within 3s — connection is silently dead
                    clearInterval(_pingInterval);
                    _pingInterval = null;
                    console.warn('[HTTP2] PING timeout — evicting dead session proactively: '+ sessKey);
                    if (!client.destroyed) client.destroy();
                    cache.delete(sessKey);
                    var _pingDeadErrIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                    if (_pingDeadErrIdx !== -1) self.serverInstance._http2Sessions.splice(_pingDeadErrIdx, 1);
                    _pingDeadErrIdx = null;
                }, 3000);
                client.ping(function(err) {
                    clearTimeout(_pingDeadline); // PONG arrived — cancel the deadline
                    if (err) {
                        clearInterval(_pingInterval);
                        _pingInterval = null;
                        console.warn('[HTTP2] PING failed — evicting dead session proactively: '+ sessKey);
                        if (!client.destroyed) client.destroy();
                        cache.delete(sessKey);
                        var _pingErrIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                        if (_pingErrIdx !== -1) self.serverInstance._http2Sessions.splice(_pingErrIdx, 1);
                        _pingErrIdx = null;
                    } else {
                        client._lastPongAt = Date.now(); // track for pre-flight freshness check
                    }
                });
            }, 5000);
        }


        const {
            HTTP2_HEADER_PROTOCOL,
            HTTP2_HEADER_SCHEME,
            HTTP2_HEADER_AUTHORITY,
            HTTP2_HEADER_PATH,
            HTTP2_HEADER_METHOD,
            HTTP2_HEADER_STATUS
        } = browser.constants;


        // #B33 — every retry re-entry (setTimeout → handleHTTP2ClientRequest) re-executes
        // these forwards, and a terminal exit (e.g. redirect-then-continue) may have
        // released local.req in between: each forward is null-guarded with query()'s own
        // idiom. Skipping a forward on a released request is a no-op, not a behavior
        // change — options.headers already carries the attempt-1 values (the same options
        // object travels through every retry).
        if ( local.req != null && typeof(local.req.headers['x-requested-with']) != 'undefined' ) {
            options.headers['x-requested-with'] = local.req.headers['x-requested-with']
        }

        if ( local.req != null && typeof(local.req.headers['access-control-allow-credentials']) != 'undefined' ) {
            options.headers['access-control-allow-credentials'] = local.req.headers['access-control-allow-credentials']
        }

        // #FORMCT2 — never clobber an `application/json` outbound Content-Type with the
        // INCOMING request's. query() serializes the inter-bundle body as raw JSON
        // (queryData = JSON.stringify) and labels it application/json; forwarding the
        // incoming CT here re-labels that JSON body (e.g. as urlencoded when the browser
        // request was a plain form POST — canonical case: a haltedRequest resume), and the
        // receiving bundle's urlencoded parse then corrupts `+`/`%XX` inside JSON string
        // values (same corruption #FORMCT fixed in the browser validator). The forward is
        // kept for non-JSON outbound bodies (e.g. the MSIE text/plain override).
        if ( local.req != null && typeof(local.req.headers['content-type']) != 'undefined' && local.req.headers['content-type'] != options.headers['content-type'] && !/application\/json/i.test(options.headers['content-type']) && !options._rawBody ) {
            options.headers['content-type'] = local.req.headers['content-type']
        }

        // [HTTP2] For your Nginx Ingress service host, you should add :
        // # BO - Specific headers for Gina
		// proxy_set_header X-Client-IP $remote_addr;
		// proxy_set_header X-Ingress-IP $server_addr
		// proxy_set_header X-Forwarded-For $remote_addr;
		// # EO - Specific headers for Gina
        if ( local.req != null && typeof(local.req.headers['x-client-ip']) != 'undefined' && local.req.headers['x-client-ip'] != options.headers['x-client-ip'] ) {
            options.headers['x-client-ip'] = local.req.headers['x-client-ip']
        }

        if ( local.req != null && typeof(local.req.headers['x-ingress-ip']) != 'undefined' && local.req.headers['x-ingress-ip'] != options.headers['x-ingress-ip'] ) {
            options.headers['x-ingress-ip'] = local.req.headers['x-ingress-ip']
        }

        // MS1 — forward the always-on correlation id (sanitised req._ginaReqId);
        // a caller-set x-request-id always wins.
        if ( local.req != null && local.req._ginaReqId && typeof(options.headers['x-request-id']) == 'undefined' ) {
            options.headers['x-request-id'] = local.req._ginaReqId;
        }

        // replaced: delete operator + for...in + forEach-delete — build filtered object in one pass (#P20, #P22)
        var headers = merge({
            [HTTP2_HEADER_METHOD]: options[':method'],
            [HTTP2_HEADER_PATH]: options[':path']
        }, options.headers);

        // merging with user options — filter out pseudo-headers, `headers` key, content-length, and null/undefined
        var optKeys = Object.keys(options);
        for (var oi = 0; oi < optKeys.length; ++oi) {
            var o = optKeys[oi];
            if (
                o.charAt(0) !== ':'
                && o !== 'headers'
                && typeof(headers[o]) == 'undefined'
            ) {
                headers[o] = options[o];
            }
        }
        // 2. CRUCIAL SECURITY: Remove manual content-length for HTTP/2
        // Node.js will calculate it automatically and correctly with req.end(body)
        // Strict sanitization for HTTP/2:
        //   - Remove content-length (auto-computed by Node.js)
        //   - Remove Buffer-valued entries (e.g. _body — the request body stash): sending a
        //     166KB Buffer as a header value exceeds maxHeaderListSize (64KB) and causes
        //     nghttp2 to refuse the stream client-side with NGHTTP2_REFUSED_STREAM
        //   - Remove known TLS/connection config keys that leaked in from the options object
        //     and are not valid HTTP headers
        //   - Remove undefined/null values
        var _NON_HTTP_OPTS = new Set([
            'auth', // #B465 belt — minted into Authorization pre-dispatch, never a header itself
            '_body', '_rawBody', '_comment', 'ca', 'hostname', 'host', 'port',
            'requestTimeout', 'keepAlive', 'maxSockets', 'keepAliveMsecs', 'maxFreeSockets',
            'rejectUnauthorized', 'maxRetry', 'retryUnsafe', 'agent', 'protocol', 'scheme',
            'nameservers', 'settings', 'webroot', 'queryData', 'method', 'path'
        ]);
        var headerKeys = Object.keys(headers);
        var cleanHeaders = {};
        for (var hi = 0; hi < headerKeys.length; ++hi) {
            var hk = headerKeys[hi];
            if (
                hk !== 'content-length' && hk !== 'Content-Length'
                && headers[hk] !== undefined && headers[hk] !== null
                && !Buffer.isBuffer(headers[hk])
                && !_NON_HTTP_OPTS.has(hk)
            ) {
                cleanHeaders[hk] = headers[hk];
            }
        }
        headers = cleanHeaders;


        // ─────────────────────────────────────────────────────────────
        // Pre-flight PING — validate cached sessions before use
        //
        // OrbStack (and other Docker networking layers) can silently drop
        // TCP connections between PING intervals. A request sent on a dead
        // session is buffered in the kernel socket and never delivered.
        //
        // Before creating a stream, check if the session was validated by
        // a successful PONG within the last HTTP2_PREFLIGHT_STALE_MS. If
        // not, send a PING and wait up to HTTP2_PREFLIGHT_DEADLINE_MS for
        // a response. On failure: evict the session and retry with a fresh
        // connection.
        //
        // New sessions skip this — _lastPongAt is set to Date.now() at
        // connection time, so they're inherently fresh.
        // ─────────────────────────────────────────────────────────────
        var _sendRequest = function _sendRequest() {

        const req = client.request(headers);

        let isFinished  = false;
        let data        = '';
        let httpStatus  = null; // captured from the HTTP/2 HEADERS frame (:status pseudo-header)
        const chunks    = []; // collect Buffer chunks — avoids peak-memory doubling from string concat

        // #B52 — release the settled outbound stream so the cached HTTP/2 session stops
        // retaining it (and, through the per-request controller it captures, the large
        // per-request `options.conf` clone made in router.js). Idempotent; invoked at every
        // NON-retry terminal below (retry paths client.destroy() the session, which tears the
        // old stream down). Never throws — cleanup must not break the response path.
        var _finalized = false;
        var _finalizeStream = function _finalizeStream() {
            if (_finalized) { return; }
            _finalized = true;
            try { req.setTimeout(0); } catch (e) {}
            try { req.removeAllListeners(); } catch (e) {}
            try { if (!req.closed && !req.destroyed) { req.close(); } } catch (e) {}
        };

        // Capture the HTTP/2 response status code from the HEADERS frame.
        // Without this, the :status pseudo-header is never read and nginx-level errors
        // (e.g. 502 Bad Gateway) are indistinguishable from JSON parse failures.
        req.on('response', function onResponseHeaders(respHeaders) {
            httpStatus = +respHeaders[':status'] || null;
        });

        // Stream-level timeout — mirrors the HTTP/1 path (handleHTTP1ClientRequest line ~2744).
        // Without this, a stream that receives no events hangs indefinitely (OrbStack ARM64
        // silently drops idle inter-container TCP connections without RST or FIN).
        // On timeout: evict the dead session and retry with a fresh connection (up to
        // HTTP2_MAX_RETRIES times, with HTTP2_RETRY_DELAY_MS backoff on 2nd+ retry).
        var _streamTimeout = parseTimeout(options.requestTimeout) || 10000;
        req.setTimeout(_streamTimeout, function onStreamTimeout() {
            if (isFinished) return;
            isFinished = true;
            console.warn('[HTTP2] Stream timeout ('+ (_streamTimeout > 1000 ? (_streamTimeout / 1000) + 's' : _streamTimeout + 'ms') +') on '+ options[':method'] +' '+ options[':path'] +' — evicting dead session (attempt '+ (retryCount + 1) +'/'+ (HTTP2_MAX_RETRIES + 1) +')');
            // Synchronous eviction ensures the retry below creates a fresh session.
            cache.delete(sessKey);
            var _tIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
            if (_tIdx !== -1) self.serverInstance._http2Sessions.splice(_tIdx, 1);
            if (!client.destroyed) client.destroy(); // no error arg — suppresses session 'error' event
            // #B53 — only re-send non-idempotent methods when the caller opted in (replay-safe).
            if (retryCount < HTTP2_MAX_RETRIES && isRetryableMethod(options[':method'], options.retryUnsafe)) {
                options.queryData = options._body;
                var _tNext = retryCount + 1;
                if (_tNext > 1) {
                    // Backoff on 2nd+ retry — gives OrbStack time to stabilize
                    return setTimeout(function() {
                        handleHTTP2ClientRequest(browser, options, callback, _tNext, isCritical);
                    }, HTTP2_RETRY_DELAY_MS);
                }
                return handleHTTP2ClientRequest(browser, options, callback, _tNext, isCritical);
            }
            // All retries exhausted — surface the error (H4: typed GinaHttp2Error)
            var _timeoutMsg = '[HTTP2] No response from '+ options[':authority'] +' after '+ (_streamTimeout > 1000 ? (_streamTimeout / 1000) + 's' : _streamTimeout + 'ms') +' (exhausted '+ HTTP2_MAX_RETRIES +' retries)';
            var _timeoutErr = new GinaHttp2Error(_timeoutMsg, { code: 'TIMEOUT', retryable: false, status: 503, retryCount: retryCount });
            // #B52 — release the settled stream (covers both the swallow-return and the callback below)
            _finalizeStream();
            // H3: if non-critical, swallow and return
            if (_swallowIfNonCritical(_timeoutErr)) return;
            try {
                _ownAsyncCbRejection(callback(_timeoutErr));
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
        });

        req.on('data', function onQueryDataChunk(chunk) {
            chunks.push(chunk);
        });

        req.on('error', function onQueryError(error) {
            // 1. Multiplexing Safety: prevent double callback/emit if stream ends & errors simultaneously
            if (isFinished) return;

             // --- CRITICAL FIXES FOR PRODUCTION ---
            // A. Error object name: using 'error' (from function arg) instead of 'err'
            const errorCode = error.code || (error.cause ? error.cause.code : null);


            // If the session closed exactly when we sent the request (Race Condition)
            // Retry with a fresh connection (up to HTTP2_MAX_RETRIES, with backoff)
            if (retryCount < HTTP2_MAX_RETRIES && (errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ECONNRESET') && isRetryableMethod(options[':method'], options.retryUnsafe)) {
                isFinished = true; // Mark current attempt as done
                cache.delete(sessKey);
                if (!client.destroyed) client.destroy();
                options.queryData = options._body; // restore body for retry
                var _eNext = retryCount + 1;
                console.warn('[HTTP2][RETRYING] Stream failed on '+ options[':path'] +' ('+ errorCode +') — retry '+ _eNext +'/'+ HTTP2_MAX_RETRIES);
                if (_eNext > 1) {
                    return setTimeout(function() {
                        handleHTTP2ClientRequest(browser, options, callback, _eNext, isCritical);
                    }, HTTP2_RETRY_DELAY_MS);
                }
                return handleHTTP2ClientRequest(browser, options, callback, _eNext, isCritical);
            }

            isFinished = true;

            // 2. Connection error handling (ECONNREFUSED, ECONNRESET, etc.)
            const isConnError = (
                (error.cause && error.cause.code && /ECONNREFUSED|ECONNRESET/.test(error.cause.code)) ||
                (error.code && /ECONNREFUSED|ECONNRESET/.test(error.code))
            );

            if (isConnError) {
                // Attempt to find the human-readable port/access point from Gina context
                try {
                    const ginaContext = getContext('gina');
                    const schemeKey = options.scheme ? options.scheme.replace(/\:/, '') : options.protocol;
                    const portInfo = ginaContext.ports[options.protocol][schemeKey][options.port];

                    if (typeof portInfo !== 'undefined') {
                        error.accessPoint = portInfo;
                        error.message = `[HTTP2] Could not connect to [ ${error.accessPoint} ].\n${error.message}`;
                    }
                } catch (e) {
                    // Context might be missing, we just log the raw error
                    console.error(`[HTTP2] Context lookup failed during error handling: ${e.message}`);
                }
            }

            // 3. English logging
            console.error(`[HTTP2] Stream Error on ${options[':method']} ${options[':path']}:`);
            console.error(error.stack || error.message);

            // 4. Response handling (H4: wrap native error in GinaHttp2Error for typed callers)
            // you can get here if :
            //  - you are trying to query using: `enctype="multipart/form-data"`
            //  - server responded with an error
            var _nativeCode  = errorCode;
            var _ginaErrCode = _http2ErrCodeMap[_nativeCode] || (isConnError ? 'ECONNREFUSED' : 'STREAM_ERROR');
            var _ginaStatus  = isConnError ? 503 : 500;
            var _ginaErr = new GinaHttp2Error(error.message, {
                code       : _ginaErrCode,
                retryable  : retryCount < HTTP2_MAX_RETRIES,
                status     : _ginaStatus,
                retryCount : retryCount
            });
            _ginaErr.cause = error; // preserve original Node error (stack, syscall, etc.)
            if (isConnError && error.accessPoint) { _ginaErr.accessPoint = error.accessPoint; }

            // #B52 — release the settled stream (covers both the swallow-return and the callback below)
            _finalizeStream();
            // H3: if non-critical, swallow and return
            if (_swallowIfNonCritical(_ginaErr)) return;
            try {
                _ownAsyncCbRejection(callback(_ginaErr));
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }

            // Note: The 'client' session remains in the Map so other parallel requests
            // on the same session can continue unless the entire session is destroyed.
        });


        // req.on('close', function onQueryClosed() {
        //     console.warn('Request stream closed.');
        // });
        // H1 fix: stream closing before 'end' left requests hanging indefinitely
        // (no callback, no query#complete). Now retries with a fresh session on
        // premature close — covers GOAWAY race, server timeout, and network reset.
        // Retries up to HTTP2_MAX_RETRIES times with backoff.
        req.on('close', function onQueryClosed() {
            if (isFinished) return;
            isFinished = true;
            console.warn('[HTTP2] Premature stream close on '+ options[':method'] +' '+ options[':path'] +' — GOAWAY / session reset (attempt '+ (retryCount + 1) +'/'+ (HTTP2_MAX_RETRIES + 1) +')');
            // #B53 — only re-send non-idempotent methods when the caller opted in (replay-safe).
            if (retryCount < HTTP2_MAX_RETRIES && isRetryableMethod(options[':method'], options.retryUnsafe)) {
                cache.delete(sessKey);
                var _cIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_cIdx !== -1) self.serverInstance._http2Sessions.splice(_cIdx, 1);
                if (!client.destroyed) client.destroy();
                options.queryData = options._body;
                var _cNext = retryCount + 1;
                if (_cNext > 1) {
                    return setTimeout(function() {
                        handleHTTP2ClientRequest(browser, options, callback, _cNext, isCritical);
                    }, HTTP2_RETRY_DELAY_MS);
                }
                return handleHTTP2ClientRequest(browser, options, callback, _cNext, isCritical);
            }
            // H4: typed GinaHttp2Error — callers can check err.code === 'PREMATURE_CLOSE'
            var prematureCloseErr = new GinaHttp2Error('[HTTP2] Stream closed before response was complete (GOAWAY / session timeout / network reset)', {
                code       : 'PREMATURE_CLOSE',
                retryable  : false,
                status     : 503,
                retryCount : retryCount
            });
            // #B52 — release the settled stream (covers both the swallow-return and the callback below)
            _finalizeStream();
            // H3: if non-critical, swallow and return
            if (_swallowIfNonCritical(prematureCloseErr)) return;
            try {
                _ownAsyncCbRejection(callback(prematureCloseErr));
            } catch (_syncCbErr) {
                _ownSyncCbThrow(_syncCbErr);
            }
        });

        req.on('end', function onEnd() {
            // 1. Prevention: Ensure the logic only runs once per request
            if (isFinished) return;
            isFinished = true;

            // Assemble chunks into a single string — one allocation, one conversion
            data = Buffer.concat(chunks).toString();

            // 2. Guard Clause: Handle empty responses or aborted streams
            if (!data || data.trim() === "") {
                // If aborted, handle it specifically
                if (req.aborted || req.destroyed) {
                    data = { status: 500, error: new Error('Request aborted by client or server') };
                } else {
                    // Might be a 204 No Content, but usually the upstream bundle should return {}
                    console.warn('[HTTP2] Empty response received');
                    data = { status: 200, empty: true };
                }
            }

            // H2 fix: 502 from nginx means the upstream bundle was unreachable (idle TCP
            // drop between nginx and the bundle — transient on OrbStack ARM64 and in
            // production after a keepalive expiry). Retry after a short delay to give
            // nginx time to reconnect to the bundle before surfacing the error to the caller.
            if (httpStatus === 502 && retryCount < HTTP2_MAX_RETRIES && isRetryableMethod(options[':method'], options.retryUnsafe)) {
                var _502Next = retryCount + 1;
                console.warn('[HTTP2][RETRYING] 502 from '+ options[':authority'] + options[':path'] +' — retry '+ _502Next +'/'+ HTTP2_MAX_RETRIES +' in 2s');
                setTimeout(function onHttp2RetryAfter502() {
                    cache.delete(sessKey);
                    var _rIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                    if (_rIdx !== -1) self.serverInstance._http2Sessions.splice(_rIdx, 1);
                    if (!client.destroyed) client.destroy();
                    options.queryData = options._body;
                    handleHTTP2ClientRequest(browser, options, callback, _502Next, isCritical);
                }, 2000);
                return;
            } else if (httpStatus === 502) {
                // #B34 — all retries exhausted on a 502: surface it as an error instead of
                // falling through to the success path (which silently delivered the 502 body
                // to the caller as `callback(false, data)` / `query#complete(false, data)`,
                // and for a JSON-shaped body even logged "switching to 200" and forced
                // data.status = 200). Mirrors the timeout / stream-error / premature-close
                // exhaustion branches; status 502 is the truthful upstream status (the
                // GinaHttp2Error JSDoc already lists code BAD_GATEWAY / status 502).
                var _badGatewayErr = new GinaHttp2Error('[HTTP2] 502 Bad Gateway from '+ options[':authority'] + options[':path'] +' (exhausted '+ HTTP2_MAX_RETRIES +' retries)', {
                    code       : 'BAD_GATEWAY',
                    retryable  : false,
                    status     : 502,
                    retryCount : retryCount
                });
                // #B52 — release the settled stream (covers both the swallow-return and the callback below)
                _finalizeStream();
                // H3: if non-critical, swallow and return
                if (_swallowIfNonCritical(_badGatewayErr)) return;
                try {
                    _ownAsyncCbRejection(callback(_badGatewayErr));
                } catch (_syncCbErr) {
                    _ownSyncCbThrow(_syncCbErr);
                }
                return;
            }

            // #B52 — release the settled stream before the remaining onEnd terminals
            // (ALPN-mismatch, non-2xx callback, throwError, success callback)
            _finalizeStream();

            // 3. Exception filter for ALPN or protocol mismatches
            if (typeof data === 'string' && /^Unknown ALPN Protocol/.test(data)) {
                const err = { status: 500, error: new Error(data) };
                try {
                    return _ownAsyncCbRejection(callback(err));
                } catch (_syncCbErr) {
                    return _ownSyncCbThrow(_syncCbErr);
                }
            }

            // 4. Data Parsing & Validation
            if (typeof data === 'string' && /^(\{|%7B|\[{)|\[\]/.test(data)) {
                try {
                    data = JSON.parse(data);
                    if (typeof data.status === 'undefined') {
                        const currentRule = local.options.rule || local.req.routing.rule;
                        console.warn(`[${currentRule}] Response status code is undefined: switching to 200`);
                        data.status = 200;
                    }
                } catch (err) {
                    data = { status: 500, error: err };
                    console.error('[HTTP2] JSON Parse Error:', err);
                }
            } else if (!data && req.aborted && req.destroyed) {
                data = { status: 500, error: new Error('Request aborted') };
            }

            try {
                // Intercepting fallback redirect (3xx)
                // #B33 — local.res may be null when the response lands after a terminal
                // exit released the triplet; skip the intercept and fall through to the
                // non-2xx handling (whose throwError no-ops on a released response).
                if (local.res != null && data.status && /^3/.test(data.status) && typeof data.headers !== 'undefined') {
                    local.res.writeHead(data.status, data.headers);
                    return local.res.end();
                }

                // Error code handling (non-2xx)
                const statusCodes = local.options.conf.server.coreConfiguration.statusCodes;
                if (data.status && !/^2/.test(data.status) && typeof statusCodes[data.status] !== 'undefined') {
                    // #B405 — finishing the #Q1 migration on this transport:
                    // throwError() bypasses the callback, preventing graceful
                    // degradation, and left a promisified query permanently
                    // unsettled on any non-5xx status. Every non-2xx now goes
                    // to the callback so the caller decides — the HTTP/1.1
                    // contract (see the #Q1 comment there).
                    // replaced: if (/^5/.test(data.status)) {
                    // replaced:     (the same wrapped callback(data) delivery — 5xx-only)
                    // replaced: } else {
                    // replaced:     self.throwError(data);
                    // replaced:     return;
                    // replaced: }
                    return _ownAsyncCbRejection(callback(data));
                } else {
                    // Success path
                    if (self && self.isHaltedRequest() && typeof local.onHaltedRequestResumed !== 'undefined') {
                        local.onHaltedRequestResumed(false);
                    }
                    // #QI — extract upstream query log from the response and
                    // merge into the current request's log. This surfaces
                    // upstream-bundle queries in the calling bundle's Inspector automatically.
                    // #INS10 — extract + strip the upstream query sidecar during a prod window too.
                    if (((process.gina && process.gina._inspectorWindowUntil > Date.now()) || _isDev) && data && data.__ginaQueries && local._queryLog) {
                        for (var _qi = 0; _qi < data.__ginaQueries.length; _qi++) {
                            local._queryLog.push(data.__ginaQueries[_qi]);
                        }
                        delete data.__ginaQueries;
                    }
                    // #FI — record query call duration and merge upstream timeline
                    // #INS10 — also during a prod instrumentation window.
                    if (((process.gina && process.gina._inspectorWindowUntil > Date.now()) || _isDev) && local._timeline) {
                        if (options._timelineStart) {
                            local._timeline.entries.push({
                                label: options._targetBundle ? ('query \u2192 ' + options._targetBundle) : 'query',
                                cat: 'io',
                                startMs: options._timelineStart, endMs: Date.now(),
                                durationMs: Date.now() - options._timelineStart,
                                detail: (options.hostname || '') + (options.path || '')
                            });
                        }
                        if (data && data.__ginaFlow && Array.isArray(data.__ginaFlow)) {
                            for (var _fi = 0; _fi < data.__ginaFlow.length; _fi++) {
                                data.__ginaFlow[_fi].origin = data.__ginaFlow[_fi].origin || (options.hostname || '');
                                local._timeline.entries.push(data.__ginaFlow[_fi]);
                            }
                            delete data.__ginaFlow;
                        }
                    }
                    return _ownAsyncCbRejection(callback(false, data));
                }
            } catch (e) {
                const infos = local.options;
                const controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
                const msg = `Controller Query Exception while catching back.\nBundle: ${infos.bundle}\nController: ${controllerName}\nControl: ${infos.control}\n${e.stack}`;
                const exception = new Error(msg);
                exception.status = 500;
                self.throwError(exception);
                return;
            }

            // IMPORTANT: client (session) is NOT closed here to allow multiplexing
        });

        // req.on('end', function onEnd() {
        //     // exceptions filter
        //     if ( typeof(data) == 'string' && /^Unknown ALPN Protocol/.test(data) ) {
        //         var err = {
        //             status: 500,
        //             error: new Error(data)
        //         };

        //         if ( typeof(callback) != 'undefined' ) {
        //             callback(err)
        //         } else {
        //             self.emit('query#complete', err)
        //         }

        //         return
        //     }

        //     //Only when needed.
        //     if ( typeof(callback) != 'undefined' ) {
        //         if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
        //             try {
        //                 data = JSON.parse(data);
        //                 // just in case
        //                 if ( typeof(data.status) == 'undefined' ) {
        //                     var currentRule = local.options.rule || local.req.routing.rule;
        //                     console.warn( '['+ currentRule +'] ' + 'Response status code is `undefined`: switching to `200`');
        //                     data.status = 200;
        //                 }
        //             } catch (err) {
        //                 data = {
        //                     status    : 500,
        //                     error     : err
        //                 }
        //                 console.error(err);
        //             }
        //         } else if ( !data && this.aborted && this.destroyed) {
        //             data = {
        //                 status    : 500,
        //                 error     : new Error('request aborted')
        //             }
        //         }
        //         //console.debug(options[':method']+ ' ['+ (data.status || 200) +'] '+ options[':path']);
        //         try {
        //             // intercepting fallback redirect
        //             if ( data.status && /^3/.test(data.status) && typeof(data.headers) != 'undefined' ) {
        //                 local.res.writeHead(data.status, data.headers);
        //                 return local.res.end();
        //             }

        //             if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
        //                     if ( /^5/.test(data.status)  ) {
        //                         return callback(data)
        //                     } else {
        //                         self.throwError(data);
        //                         return;
        //                     }
        //             } else {
        //                 // required when control is used in an halted state
        //                 // Ref.: resumeRequest()
        //                 if ( self && self.isHaltedRequest() && typeof(local.onHaltedRequestResumed) != 'undefined' ) {
        //                     local.onHaltedRequestResumed(false);
        //                 }
        //                 return callback( false, data )
        //             }

        //         } catch (e) {
        //             var infos = local.options, controllerName = infos.controller.substring(infos.controller.lastIndexOf('/'));
        //             var msg = 'Controller Query Exception while catching back.\nBundle: '+ infos.bundle +'\nController File: /controllers'+ controllerName +'\nControl: this.'+ infos.control +'(...)\n\r' + e.stack;
        //             var exception = new Error(msg);
        //             exception.status = 500;
        //             self.throwError(exception);
        //             return;
        //         }

        //     } else {
        //         if ( typeof(data) == 'string' && /^(\{|%7B|\[{)|\[\]/.test(data) ) {
        //             try {
        //                 data = JSON.parse(data)
        //             } catch (e) {
        //                 data = {
        //                     status    : 500,
        //                     error     : data
        //                 }
        //                 self.emit('query#complete', data)
        //             }
        //         }

        //         // intercepting fallback redirect
        //         if ( data.status && /^3/.test(data.status) && typeof(data.headers) != 'undefined' ) {
        //             self.removeAllListeners(['query#complete']);
        //             local.res.writeHead(data.status, data.headers);
        //             return local.res.end();
        //         }

        //         if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {
        //             self.emit('query#complete', data)
        //         } else {
        //             // required when control is used in an halted state
        //             // Ref.: resumeRequest()
        //             if ( self.isHaltedRequest() && typeof(local.onHaltedRequestResumed) != 'undefined' ) {
        //                 local.onHaltedRequestResumed(false);
        //             }
        //             self.emit('query#complete', false, data)
        //         }
        //     }

        //     // IMPORTANT, DO not close the client since it is being reused
        // });


        if (
            body && (/^post$/i.test(headers[':method'])
            || /^put$/i.test(headers[':method'])
            || /^patch$/i.test(headers[':method']) )
        ) {
            if (!req.destroyed && !req.closed) {
                // req.write(body, (err) => {
                //     if (err) console.error('[CONTROLLER][handleHTTP2] Write error:', err);
                //     // Closing on write success
                //     req.end();
                // });
                req.end(body);
            }
        } else {
            if (!req.destroyed && !req.closed) {
                req.end();
            }
        }

        }; // EO _sendRequest

        // Pre-flight PING: check if the cached session needs validation
        var _staleSince = Date.now() - (client._lastPongAt || 0);
        if (_staleSince > HTTP2_PREFLIGHT_STALE_MS && !client.destroyed && !client.closed) {
            var _pfDone = false;
            var _pfDeadline = setTimeout(function onPreflightDeadline() {
                if (_pfDone) return;
                _pfDone = true;
                console.warn('[HTTP2] Pre-flight PING timeout ('+ HTTP2_PREFLIGHT_DEADLINE_MS +'ms) — session stale for '+ _staleSince +'ms, evicting: '+ sessKey);
                cache.delete(sessKey);
                var _pfIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                if (_pfIdx !== -1) self.serverInstance._http2Sessions.splice(_pfIdx, 1);
                if (!client.destroyed) client.destroy();
                if (retryCount < HTTP2_MAX_RETRIES) {
                    options.queryData = options._body || body;
                    var _pfNext = retryCount + 1;
                    if (_pfNext > 1) {
                        return setTimeout(function() {
                            handleHTTP2ClientRequest(browser, options, callback, _pfNext, isCritical);
                        }, HTTP2_RETRY_DELAY_MS);
                    }
                    return handleHTTP2ClientRequest(browser, options, callback, _pfNext, isCritical);
                }
                var _pfErr = new GinaHttp2Error('[HTTP2] Pre-flight PING failed — no response from '+ authority +' after '+ HTTP2_PREFLIGHT_DEADLINE_MS +'ms', {
                    code: 'PREFLIGHT_TIMEOUT', retryable: false, status: 503, retryCount: retryCount
                });
                if (_swallowIfNonCritical(_pfErr)) return;
                try {
                    return _ownAsyncCbRejection(callback(_pfErr));
                } catch (_syncCbErr) {
                    return _ownSyncCbThrow(_syncCbErr);
                }
            }, HTTP2_PREFLIGHT_DEADLINE_MS);

            client.ping(function onPreflightPong(err) {
                if (_pfDone) return;
                _pfDone = true;
                clearTimeout(_pfDeadline);
                if (err) {
                    console.warn('[HTTP2] Pre-flight PING error — evicting session: '+ sessKey +' ('+ (err.message || err) +')');
                    cache.delete(sessKey);
                    var _pfEIdx = self.serverInstance._http2Sessions.indexOf(sessKey);
                    if (_pfEIdx !== -1) self.serverInstance._http2Sessions.splice(_pfEIdx, 1);
                    if (!client.destroyed) client.destroy();
                    if (retryCount < HTTP2_MAX_RETRIES) {
                        options.queryData = options._body || body;
                        var _pfENext = retryCount + 1;
                        if (_pfENext > 1) {
                            return setTimeout(function() {
                                handleHTTP2ClientRequest(browser, options, callback, _pfENext, isCritical);
                            }, HTTP2_RETRY_DELAY_MS);
                        }
                        return handleHTTP2ClientRequest(browser, options, callback, _pfENext, isCritical);
                    }
                    var _pfErr2 = new GinaHttp2Error('[HTTP2] Pre-flight PING failed on '+ authority +': '+ (err.message || err), {
                        code: 'PREFLIGHT_FAILED', retryable: false, status: 503, retryCount: retryCount
                    });
                    if (_swallowIfNonCritical(_pfErr2)) return;
                    try {
                        return _ownAsyncCbRejection(callback(_pfErr2));
                    } catch (_syncCbErr) {
                        return _ownSyncCbThrow(_syncCbErr);
                    }
                }
                // PONG received — session confirmed alive
                client._lastPongAt = Date.now();
                _sendRequest();
            });
        } else {
            // Session is fresh (validated within HTTP2_PREFLIGHT_STALE_MS) — proceed immediately
            _sendRequest();
        }

        // #B475 — no per-transport {onComplete} facade here any more: query()
        // mints ONE per-call channel for the fluent form and returns the handle
        // itself, so this handler always receives a callback.

    }


    /**
     * forward404Unless
     *
     * @param {boolean} condition
     * @param {object} req
     * @param {object} res
     *
     * @callback [ next ]
     * @param {string | boolean} err
     *
     * @returns {string | boolean} err
     * */
    this.forward404Unless = function(condition, req, res, next) {
        var pathname = req.url;

        if (!condition) {
            self.throwError(res, 404, 'Page not found\n' + pathname);
            var err = new Error('Page not found\n' + pathname);
            if ( typeof(next) != 'undefined')
                next(err)
            else
                return err
        } else {
            if ( typeof(next) != 'undefined' )
                next(false)
            else
                return false
        }
    }

    /**
     * Get all Params
     * @param {object} req
     *
     * @returns {object} params
     * */
    var getParams = function(req) {

        req.getParams = function() {
            // Clone
            var params = JSON.clone(req.params);
            switch( req.method.toLowerCase() ) {
                case 'get':
                    params = merge(params, req.get, true);
                    break;

                case 'post':
                    params = merge(params, req.post, true);
                    break;

                case 'put':
                    params = merge(params, req.put, true);
                    break;

                case 'delete':
                    params = merge(params, req.delete, true);
                    break;

                case 'patch':
                    params = merge(params, req.patch, true);
                    break;

                case 'head':
                    params = merge(params, req.head, true);
                    break;
            }

            return params
        }

        req.getParam = function(name) {

            var param   = null;
            switch( req.method.toLowerCase() ) {
                case 'get':
                    param = req.get[name];
                    break;

                case 'post':
                    param = req.post[name];
                    break;

                case 'put':
                    param= req.put[name];
                    break;

                case 'delete':
                    param = req.delete[name];
                    break;

                case 'patch':
                    param = req.patch[name];
                    break;

                case 'head':
                    param = req.head[name];
                    break;
            }

            return param
        }
    }

    /**
     * Forwards the current request to another route — on this bundle or on a
     * sibling bundle of the same project — and relays the answer.
     *
     * Declarative: a route names `forward` as its `control` and the target in
     * `param.url`, as `<rule>` for the current bundle or `<rule>@<bundle>` for a
     * sibling (the reference form `redirect()` and `getRoute()` accept; a
     * `/<env>` suffix is honoured). Every other non-reserved key of `param` is a
     * placeholder value for the target route, read from the captured URL
     * parameters when the incoming URL provided it and taken as a static value
     * otherwise.
     *
     * The upstream call goes through `query()`: a `<bundle>@…` hostname is
     * resolved from the environment configuration (host, port, protocol,
     * scheme), and the incoming request's data (`req[method]`) travels as the
     * body or the query string. An object answer is relayed with `renderJSON()`;
     * a string answer is relayed verbatim with `renderTEXT()`, so a non-JSON
     * upstream body is never re-encoded. A non-2xx status, a transport failure
     * or an unknown target route is answered through `throwError()`.
     *
     * `multipart/form-data` IS relayed (#B489): the parsed text fields and the
     * staged `req.files` are re-encoded into one multipart body under a fresh
     * boundary and sent verbatim, so uploads reach the target. The body is
     * buffered, hence bounded — by the source bundle's `upload.maxFieldsSize`
     * when that cap is configured, else by a 16 MB default; a breach answers
     * 413. Files need a body-carrying method: relaying them under a method that
     * carries no body answers 400. Staged files are read, never deleted — the
     * source's own cleanup timer still owns them.
     *
     * Reserved `param` keys (never forwarded as placeholders): `url`,
     * `urlIndex`, `control`, `file`, `title`, `bundle`, `project`, `hostname`,
     * `port`, `path`, `method`. `hostname`/`port`/`path` address a raw host
     * instead of a bundle; `method` overrides the forwarded HTTP method.
     *
     * @param {object}   req
     * @param {object}   res
     * @param {function} next
     * @returns {void}
     *
     * @example
     * // routing.json — GET /v1/orders on this bundle serves a sibling bundle's answer
     * "orders-facade": {
     *   "url": "/v1/orders",
     *   "method": "GET",
     *   "param": { "control": "forward", "url": "orders-list@api" }
     * }
     *
     * @example
     * // routing.json — the captured :id feeds the target route's :id
     * "invoice-relay": {
     *   "url": "/legacy/invoice/:id",
     *   "param": { "control": "forward", "url": "invoice-get@api", "id": ":id" }
     * }
     *
     * @example
     * // routing.json — an upload POSTed here is re-encoded and relayed to the
     * // sibling bundle, files included (#B489)
     * "upload-relay": {
     *   "url": "/upload",
     *   "method": "POST",
     *   "param": { "control": "forward", "url": "upload-receive@api" }
     * }
     */
    this.forward = function(req, res, next) {
        var route = req.routing;
        if ( typeof(route.param.url) == 'undefined' || /^(null|\s*)$/.test(route.param.url) ) {
            self.throwError( new Error('`route.param.url` must be defined in your route: `'+ route.rule +'`') );
            return;
        }

        // #B488 — placeholder VALUES come from the incoming request; the routing
        // declaration only says which keys exist.
        var param = {};
        for (let p in route.param) {
            if ( /^(url|urlIndex|control|file|title|bundle|project|hostname|port|path|method)$/.test(p) ) {
                continue;
            }
            param[p] = ( req.params && typeof(req.params[p]) != 'undefined' ) ? req.params[p] : route.param[p];
        }

        // #B488 — an unknown rule or bundle throws inside the routing helper;
        // answer it as a framework error instead of letting it escape the action.
        var routeObj = null;
        try {
            routeObj = ( typeof(route.param.urlIndex) != 'undefined' )
                ? lib.routing.getRoute(route.param.url, param, route.param.urlIndex)
                : lib.routing.getRoute(route.param.url, param);
        } catch (routeErr) {
            self.throwError(routeErr);
            return;
        }
        if ( !routeObj || typeof(routeObj.url) != 'string' ) {
            self.throwError( new Error('forward: no url resolved for target route `'+ route.param.url +'`') );
            return;
        }

        var project = local.options.conf.projectName;
        if ( typeof(route.param.project) != 'undefined' && !/^(null|\s*)$/.test(route.param.project) ) {
            project = route.param.project;
        }

        var opt = {};
        if ( /\@/.test(route.param.url) || typeof(route.param.hostname) == 'undefined' ) {
            // `<rule>@<bundle>[/<env>]`, or a bare `<rule>` of this bundle. query()
            // resolves a `<bundle>@…` hostname from the environment configuration,
            // port included, and the resolved route url already carries the
            // target's webroot — it IS the path (#B488: it used to be discarded).
            var targetedBundle = ( /\@/.test(route.param.url) )
                ? route.param.url.substring(route.param.url.lastIndexOf('@') + 1).replace(/\/.*$/, '')
                : local.options.conf.bundle;
            opt.hostname = targetedBundle +'@'+ project;
            opt.path     = routeObj.url;
        } else {
            // a raw host declared in the route
            opt.hostname = route.param.hostname;
            if ( typeof(route.param.port) != 'undefined' ) {
                opt.port = route.param.port;
            }
            opt.path     = route.param.path || routeObj.url;
        }

        opt.method = ( typeof(route.param.method) != 'undefined' )
            ? route.param.method.toLowerCase()
            : req.method.toLowerCase();

        var settings = self.getConfig('settings');
        if ( settings && settings.server && settings.server.credentials && settings.server.credentials.ca ) {
            opt.ca = settings.server.credentials.ca;
        }
        if ( self.isCacheless() || self.isLocalScope() ) {
            opt.rejectUnauthorized = false;
        }

        var obj = req[ req.method.toLowerCase() ];

        // #B489 — relay a parsed multipart request AS multipart. Without this, query()
        // JSON-encodes `data`, so the target received the nested text fields as JSON and
        // `req.files` never travelled at all.
        if ( Array.isArray(req.files) && req.files.length > 0 ) {
            if ( !/^(post|put|patch)$/.test(opt.method) ) {
                self.throwError(400, new Error('forward: cannot relay '+ req.files.length +' uploaded file(s) with method `'+ opt.method +'` — files need a body-carrying method (post, put or patch)'));
                return;
            }
            // The source's own cap when the parser stamped a usable one, else a hard
            // default: `upload.maxFieldsSize` is disabled when unset / 0 / invalid, and
            // even when set it compares a content-length header a chunked request never
            // sends — so it cannot be relied on to bound what we are about to buffer.
            var relayCap = ( typeof(req.uploadMaxSize) == 'number' && isFinite(req.uploadMaxSize) && req.uploadMaxSize > 0 )
                ? req.uploadMaxSize
                : (16 * 1024 * 1024);
            var enc = null;
            try {
                enc = lib.multipart.encode({ fields: obj, files: req.files }, { maxSize: relayCap });
            } catch (encErr) {
                // Over the cap is the caller's problem; a staged file we cannot read
                // (already swept, never flushed) is ours. Neither may escape the action.
                self.throwError(( encErr && encErr.code == 'MULTIPART_TOO_LARGE' ) ? 413 : 500, encErr);
                return;
            }
            opt.headers = opt.headers || {};
            opt.headers['content-type'] = enc.contentType;
            opt.body = enc.body;   // #B489 — query()'s raw-body pass-through
            obj = {};              // the fields are in the body now; a non-empty data would be refused
        }

        self.query(opt, obj, function onForward(err, result) {
            if (err) {
                self.throwError(err);
                return;
            }
            // #B488 — a string is a non-JSON upstream body: relay the bytes as
            // they are rather than re-encoding them as a JSON string.
            if ( typeof(result) == 'string' ) {
                self.renderTEXT(result);
                return;
            }
            self.renderJSON(result);
        });
    }


    /**
     * Get config
     *
     * @param {string} [name] - Conf name without extension.
     * @returns {object} config
     *
     * */
    this.getConfig = function(name) {
        var tmp = null;
        if ( typeof(name) != 'undefined' ) {
            try {
                // Needs to be read only
                tmp = JSON.clone(local.options.conf.content[name]);
            } catch (err) {
                return undefined;
            }
        } else {
            tmp = JSON.clone(local.options.conf);
        }

        // #B66 S2b — prefer THIS request's per-request proxy classification (the
        // #B65 slots on local.req) over the sticky worker-global latch, so a mixed
        // proxied+direct worker (or a concurrent request to a different public host)
        // resolves the host for the request in hand, not the last-proxied global.
        // getConfig is reachable req-less (ws-query, released-response, the async
        // health probe) AND under the Express engine (which never sets the slots),
        // so the worker-global stays the fallback whenever the slot is absent.
        var _isProxyHost   = ( local.req && typeof(local.req._ginaIsProxyHost) != 'undefined' ) ? local.req._ginaIsProxyHost : ( getContext('isProxyHost') || false );
        var _proxyHostname = ( local.req && local.req._ginaProxyHostname ) ? local.req._ginaProxyHostname : process.gina.PROXY_HOSTNAME;
        var _proxyHost     = ( local.req && local.req._ginaProxyHost )     ? local.req._ginaProxyHost     : process.gina.PROXY_HOST;
        if (
            _isProxyHost
            && typeof(tmp.hostname) != 'undefined'
            && typeof(_proxyHostname) != 'undefined'
        ) {
            tmp.hostname    = _proxyHostname;
            tmp.host        = _proxyHost;
        }
        return tmp;
    }

    /**
     * Resolve the locale-DB fallback language (#B100), shared by the setOptions
     * locale bridge and `getLocales()`. `region.isoShort` (the schema key,
     * ISO 639-1) wins; the legacy schema-invalid `region.shortCode` is still
     * honoured for hand-authored configs; `en` is the final default. Never
     * throws — every level is existence-guarded.
     *
     * @inner
     * @param {object} conf - resolved bundle conf (`local.options.conf`)
     * @returns {string} fallback language code, lowercase
     */
    var getLocaleFallbackLang = function(conf) {
        var _region = ( conf && conf.content && conf.content.settings && conf.content.settings.region ) ? conf.content.settings.region : null;
        if ( _region ) {
            if ( typeof(_region.isoShort) == 'string' && _region.isoShort.length > 0 ) {
                return _region.isoShort.toLowerCase();
            }
            if ( typeof(_region.shortCode) == 'string' && _region.shortCode.length > 0 ) {
                return _region.shortCode.toLowerCase();
            }
        }
        return 'en';
    };

    /**
     * Get locales
     * Will take only supported lang
     *
     * @param {string} [shortCountryCode] - language code of the region set to load, e.g. `fr`; defaults to the request's resolved language
     *
     * @returns {object} locales
     * */
    this.getLocales = function (shortCountryCode) {

        // `|| []` — a bundle without views never runs the setOptions locale
        // bridge, so `conf.locales` can be undefined; the projection below
        // must degrade to an empty list instead of throwing
        var userLocales = local.options.conf.locales || [];

        if ( typeof(shortCountryCode) != 'undefined' ) {
            shortCountryCode = shortCountryCode.toLowerCase();
            // #P39 — memoized language index (was: a per-call Collection deep-
            // copying every region set). The rows handed on are shared and
            // pristine; the only consumer below is the getCountries projection,
            // which builds fresh output rows and never writes into its input.
            var localesIdx = _resolveLocalesIndex();

            try {
                userLocales = localesIdx[shortCountryCode].content
            } catch (err) {
                // #B100 — same guarded fallback as the setOptions locale bridge.
                var _fallbackLang    = getLocaleFallbackLang(local.options.conf);
                console.warn('language code `'+ shortCountryCode +'` not handled to setup locales: replacing by `'+ _fallbackLang +'`');
                var _fallbackLocales = localesIdx[_fallbackLang] || localesIdx['en'];
                userLocales = ( _fallbackLocales && _fallbackLocales.content ) ? _fallbackLocales.content : [];
            }
        }


        /**
         * Get countries list
         *
         * Each row always carries `isoShort`, `isoLong`, `countryName`
         * (the localized short name for the resolved language) and
         * `officialStateName` (the long official form when the source data
         * provides one). Passing a valid extra field name adds that field
         * to every returned row.
         *
         * @param {string} [code] - extra field to project on each row, e.g.: `capital`, `continent`, `tld`
         *
         * @returns {object} countries - countries code & value list
         *
         * @example
         * // rows for the request's resolved language
         * var countries = self.getLocales().getCountries();
         * // rows extended with the capital city
         * var withCapitals = self.getLocales().getCountries('capital');
         * */
        var getCountries = function (code) {
            // was: `cde` defaulted to 'countryName', could be reassigned from
            // `code`, and was then never read — the documented projection
            // argument had no effect (gina-io/gina#50). A valid `code` now
            // extends the projection; the 4 historical fields stay untouched.
            // The `userLocales.length > 0` guard keeps an empty locale set
            // from throwing on the `userLocales[0]` probe.
            var list = [], cde = null;

            if ( typeof(code) != 'undefined' && userLocales.length > 0 && typeof(userLocales[0][code]) == 'string' ) {
                cde = code
            } else if ( typeof(code) != 'undefined' ) {
                console.warn('`'+ code +'` not supported : sticking with the default countries projection')
            }


            for ( let i = 0, len = userLocales.length; i< len; ++i ) {
                list[ i ] = {
                    isoShort: userLocales[i].isoShort,
                    isoLong: userLocales[i].isoLong,
                    countryName: userLocales[i].countryName,
                    officialStateName: userLocales[i].officialStateName
                };
                if (cde) {
                    list[ i ][ cde ] = userLocales[i][ cde ]
                }
            }

            return list
        }

        return {
            'getCountries': getCountries
            // TODO - getCurrencies()
        }
    }

    /**
     * Get forms rules
     *
     *
     * @returns {object} rules
     *
     * */
    this.getFormsRules = function () {
        // #B35 — released-response guard: no form rules to resolve on a released request
        // (reading the request's gina headers would crash the bundle).
        if ( local.req == null ) {
            return {};
        }
        var bundle  = local.options.conf.bundle; // by default
        var form    = null;
        var rule    = null;
        var isGettingRulesFromAnotherBundle = false;
        var rules   = {};
        if ( typeof(local.req.ginaHeaders) != 'undefined' && typeof(local.req.ginaHeaders.form) != 'undefined' ) {
            form = local.req.ginaHeaders.form;
            if ( typeof(form.rule) != 'undefined' ) {
                var ruleInfos = form.rule.split(/\@/);
                rule = ruleInfos[0];
                // rules might be located in another bundle
                if (ruleInfos[1] && ruleInfos[1] != '' && ruleInfos[1] != bundle) {
                    bundle = ruleInfos[1];
                    isGettingRulesFromAnotherBundle = true;
                }
            }
        }

        if ( form && typeof(form.id) != 'undefined' ) {
            try {
                if (isGettingRulesFromAnotherBundle) {
                    rules = JSON.clone(getConfig()[bundle][local.options.conf.env].content.forms.rules[form.id]) || null;
                } else {
                    rules = JSON.clone(local.options.conf.content.forms).rules[form.id] || null;
                }

                if (!rules) {
                    rules = {};
                    console.warn('[CONTROLLER]['+ local.options.conf.bundle +'][Backend validation] did not find matching rules for form.id `'+ form.id +'` for  `'+ bundle+' bundle`. Do not Panic if you did not defined any.')
                }
            } catch (ruleErr) {
                self.throwError(ruleErr);
                return;
            }
        }

        return rules;
    }

    /**
     * Push a Server-Sent Events payload to connected clients.
     *
     * The recipient is decided SERVER-side and can never be chosen by the
     * request body (#B364): an explicit `option.sessionID` wins, else the
     * payload goes to the caller's own session. With neither — and without an
     * explicit broadcast — this is a no-op that warns, because a push with no
     * resolvable recipient is a bug, and the previous fail-OPEN answer to it
     * was to send to everybody.
     *
     * Reaching every connected client requires `option.broadcast === true`,
     * supplied by your code rather than inferred from a missing value.
     *
     * The channel itself is an isaac-engine facility. On the express engine there
     * is none, so a push sends nothing, warns, and reports
     * `PUSH_CHANNEL_NOT_CONFIGURED` to a supplied callback rather than failing the
     * request (#B371) — a structural condition, identical on every call.
     *
     * @param {object|null}  payload             - Data to push; falls back to `req[method].payload` when `null`
     * @param {object}       [option]            - Push options, also forwarded to the transport (e.g. `{ compress: true }`)
     * @param {string}       [option.sessionID]  - Explicit recipient session id; defaults to the caller's own session
     * @param {boolean}      [option.broadcast]  - `true` (strictly) to reach every connected client
     * @param {string}       [option.section]    - Section stamped onto the payload; falls back to `req[method].section`
     * @param {function}     [callback]          - `callback(err, result)`; receives a
     *                                             `PUSH_CHANNEL_NOT_CONFIGURED` error when this
     *                                             server instance has no engine.io channel
     * @returns {void}
     *
     * @example
     * // to the caller's own session
     * self.push({ event: 'saved' });
     *
     * @example
     * // to a specific session your code selected
     * self.push({ event: 'invited' }, { sessionID: invitee.sessionId });
     *
     * @example
     * // to everyone — deliberate, never implicit
     * self.push({ event: 'maintenance' }, { broadcast: true });
     */
    this.push = function(payload, option, callback) {

        // #B38 — released-response guard (see #B31): push is a fire-and-forget send
        // over the SSE/engine.io clients; on a released request (per-request refs nulled by
        // a terminal exit) a no-op return is correct — the response this request would have
        // pushed to is already gone. Live requests are unaffected (guard skipped).
        if ( local.req == null ) {
            return;
        }

        var req = local.req, res = local.res;
        var method  = req.method.toLowerCase();

        // #B371 — the push channel is an isaac-engine facility: `serverInstance.eio`
        // is attached there and nowhere else, so on the express engine the client
        // lookup further down dereferenced `undefined` and surfaced as an opaque
        // TypeError-derived 500 that named neither push nor the missing channel.
        // Refuse by name instead, the way the out-of-request sibling does
        // (`lib/push` → PUSH_CHANNEL_NOT_CONFIGURED): warn, tell a caller that
        // passed a callback, and send nothing. This is a structural, process-wide
        // condition — unlike the per-call no-recipient case below — so it can
        // never resolve on a later call and is reported the same way every time.
        if ( self.serverInstance == null || self.serverInstance.eio == null ) {
            console.warn('[CONTROLLER][ push ] no engine.io channel on this server instance, so nothing was sent. The push channel needs the isaac engine with `settings.json > server.ioServer.integrationMode: "attach"`; the express engine has no `eio`.');
            if ( typeof(callback) == 'function' ) {
                var noChannelErr  = new Error('no engine.io channel on this server instance. The push channel needs the isaac engine with `settings.json > server.ioServer.integrationMode: "attach"`; the express engine has no `eio`.');
                noChannelErr.code = 'PUSH_CHANNEL_NOT_CONFIGURED';
                callback(noChannelErr);
            }
            return;
        }

        // #B364 — the recipient is NEVER read from the request body. It used to be
        // (`req[method].sessionID`), which let a caller aim a push at any session by
        // sending an id — and, when the id was absent, at EVERY connected client.
        // Order: explicit server-supplied id → the caller's own session → nothing.
        var broadcast = ( option != null && option.broadcast === true );
        var sessionId = null;
        if ( option != null && typeof(option.sessionID) == 'string' && option.sessionID !== '' ) {
            sessionId = option.sessionID;
        } else if ( typeof(req.sessionID) != 'undefined' && req.sessionID ) {
            sessionId = req.sessionID;
        } else if ( req.session != null && typeof(req.session.id) != 'undefined' && req.session.id ) {
            sessionId = req.session.id;
        }

        // Fail CLOSED: no recipient and no explicit broadcast sends nothing at all.
        if ( !broadcast && !sessionId ) {
            console.warn('[CONTROLLER][ push ] no recipient: the request has no session and no `option.sessionID` was given, so nothing was sent. Pass `{ sessionID: <id> }` to target a session, or `{ broadcast: true }` to reach every connected client.');
            return;
        }

        // retrieve section if existing — an explicit option wins over the request
        var section = null;
        if ( option != null && typeof(option.section) != 'undefined' ) {
            section = option.section;
        } else if ( typeof(req[method].section) != 'undefined' ) {
            section = req[method].section;
        }

        if (!payload) {
            payload     = null;
            if ( typeof(req[method]) != 'undefined' && typeof(req[method].payload) != 'undefined' ) {
                if ( typeof(payload) == 'string' ) {
                    payload = decodeURIComponent(req[method].payload);
                    payload = JSON.parse(payload);
                    if ( section && typeof(payload.section) == 'undefined' ) {
                      payload.section = section
                    }
                    payload = JSON.stringify(payload)
                } else {
                    if ( section && typeof(req[method].payload.section) == 'undefined' ) {
                      req[method].payload.section = section
                    }
                    payload =  JSON.stringify(req[method].payload)
                }
            }
        } else if ( typeof(payload) == 'object' ) {
            if ( section && typeof(payload.section) == 'undefined' ) {
              payload.section = section
            }
            payload = JSON.stringify(payload)
        }

        try {
            var clients = null;
            clients = self.serverInstance.eio.clients;
            if ( clients ) {
                for (let s in clients) {
                    // #B364 — was `!clients[s].constructor.name == 'Socket'`, which parses
                    // as `(!name) == 'Socket'` and is therefore always false: the guard
                    // never once skipped a non-socket entry.
                    if ( clients[s].constructor.name !== 'Socket' ) {
                        continue;
                    }

                    if (
                        // every client, only when the caller asked for it
                        broadcast
                        ||
                        // otherwise the resolved session, and nothing else
                        (
                            typeof(clients[s].sessionId) != 'undefined'
                            && clients[s].sessionId == sessionId
                        )
                    ) {
                        // #B364 — was `options`: SuperController's own constructor
                        // parameter, in scope here by closure, where the caller's
                        // `option` was meant. It resolved, so nothing threw and the
                        // packet WAS sent — carrying the controller's options in
                        // place of the caller's, which never reached the transport.
                        clients[s].sendPacket("message", payload, option, callback);
                    }
                }
            }

            // res.end();
        } catch(err) {
            self.throwError(err);
            return;
        }
    }

    var getSession = function() {
        var session = null;
        // #B33 — local.req is null after a terminal exit released the triplet; callers
        // like isHaltedRequest() run from HTTP/2 response handlers that can fire on a
        // released request (retry/late-response paths). No session on a released request.
        if ( local.req == null ) {
            return null;
        }
        if ( typeof(local.req.session) != 'undefined') {
            session = local.req.session;
        }
        // passport override
        if (!session && typeof(local.req.session) != 'undefined' && typeof(local.req.session.user) != 'undefined') {
            session = local.req.session.user;
        }

        return session;
    }

    /**
     * Returns `true` when the authenticated caller holds `role` (#COMPLY1).
     *
     * The imperative escape hatch, for an action that authorizes mid-logic — the
     * declarative `routing.json` `param.roles` gate covers the whole-route case and
     * should be preferred when it fits (it denies before the action, and before the
     * DTO pipe). Roles are opaque strings: the framework imposes no vocabulary.
     *
     * Delegates to `lib/authz-gate`'s predicate, so "holding a role" means here exactly
     * what it means at the gate — an absent or non-array `user.roles` holds none.
     *
     * The caller is the EFFECTIVE principal: the session user when present, else
     * a #MS3 machine caller the authz gate verified from `Authorization: Bearer`
     * (`req.machineCaller` — its configured `auth.machine.callers.<name>.roles`
     * answer here exactly like a session user's roles).
     *
     * @param {string} role - The role name to test for.
     * @returns {boolean} `false` for an unauthenticated request (and for a released one).
     *
     * @example
     * // Widen a response for privileged callers, inside an otherwise open action:
     * var payload = { title: doc.title };
     * if ( self.hasRole('admin') ) {
     *     payload.auditTrail = doc.auditTrail;
     * }
     * self.renderJSON(payload);
     */
    this.hasRole = function(role) {
        // #B35 — released-response guard (see getSession, #B31/#B33): a terminal exit
        // nulls local.req; a released request carries no session, hence no role. Reading
        // through it would crash the bundle (uncaughtException -> SIGTERM).
        if ( local.req == null ) {
            return false;
        }
        var session = getSession();
        // #MS3 — the effective principal: the session user when present (session
        // wins, mirroring the authz gate's own precedence), else the machine
        // caller the gate stamped on `req.machineCaller` from a verified
        // `Authorization: Bearer` key — so a machine caller's configured roles
        // answer `self.hasRole()` exactly like a signed-in user's.
        var user    = ( session && session.user )
            ? session.user
            : ( ( local.req.machineCaller && typeof(local.req.machineCaller) == 'object' ) ? local.req.machineCaller : null );

        return lib.authzGate.hasAnyRole(user, [ role ]);
    }

    /**
     * #COMPLY2 — Emit one audit-trail record ("who did what to which record
     * when"). Thin pass-through to `lib.audit.write` — a no-op returning
     * `cb(null)` when `settings.json > audit.enabled` is not `true`, so
     * application code never branches on deployment config.
     *
     * Fire-and-forget by default: a write failure is counted + logged
     * server-side, never thrown into the request path. Pass `cb` only when the
     * caller must confirm the write.
     *
     * Unlike `hasRole` above, there is deliberately NO #B35 early-return on a
     * released response (`local.req` nulled at a terminal exit): every
     * request-derived read in the record builder is null-safe, so a late
     * `self.audit()` still lands a DEGRADED record (null `requestId` / `ip` /
     * `rule` / `method`, actor `{key:null, roles:[]}`) — for a compliance
     * trail, present-but-degraded beats dropped.
     *
     * The actor is snapshotted from `req.session.user` (`audit.actorKey`
     * property + a copy of `user.roles` — never the whole user object);
     * `data.actor` overrides the snapshot per call.
     *
     * @param {string}   action - App-defined verb, e.g. `"invoice.delete"`.
     * @param {object}   [data] - `{ resource, meta, actor }` — all optional; other keys are ignored.
     * @param {function(?Error)} [cb] - Optional write confirmation (`cb(null)` on success or when audit is disabled).
     * @returns {void}
     *
     * @example
     *   this.remove = function(req, res, next) {
     *       // ... delete the record ...
     *       self.audit('invoice.delete', { resource: req.params.id });
     *       self.renderJSON({ deleted: true });
     *   };
     */
    this.audit = function(action, data, cb) {
        if ( typeof(data) == 'function' ) {
            cb   = data;
            data = null;
        }
        data = ( data && typeof(data) == 'object' ) ? data : {};

        return lib.audit.write(action, {
            req      : ( local.req != null ) ? local.req : null,
            resource : data.resource,
            meta     : data.meta,
            actor    : data.actor
        }, cb);
    };

    /**
     * Returns `true` when the session (or provided storage object) holds a `haltedRequest`.
     *
     * @param {object} [session] - Defaults to the current `req.session` / `req.session.user`
     * @returns {boolean}
     *
     * @example
     * // Guard a post-login action so it only replays when something was paused:
     * if (self.isHaltedRequest()) { return self.resumeRequest(); }
     */
    this.isHaltedRequest = function(session) {
        // trying to retrieve session since it is optional
        if ( typeof(session) == 'undefined' ) {
            session = getSession();
            // if ( typeof(local.req.session) != 'undefined' && typeof(local.req.session.haltedRequest) != 'undefined' ) {
            //     session = local.req.session;
            // }
            // // passport
            // if (!session && typeof(local.req.session) != 'undefined' && typeof(local.req.session.user) != 'undefined' && typeof(local.req.session.user.haltedRequest) != 'undefined' ) {
            //     session = local.req.session.user;
            // }
            if (
                !session
                ||
                typeof(session) != 'undefined'
                && typeof(session.haltedRequest) == 'undefined'
            ) {
                return false;
            }
        }

        return (typeof(session.haltedRequest) != 'undefined' ) ? true : false;
    }


    local.haltedRequestUrlResumed = false;

    /**
     * Snapshot the current request as a `haltedRequest` and store it in `requestStorage`.
     * Typically called before redirecting to a login page so the original request can be
     * replayed after authentication via `resumeRequest()`. The snapshotted `url` is the
     * byte-exact incoming URL — `req.originalUrl` when the engine preserves it (the isaac
     * engine strips the query string from `req.url` before controllers run; express's own
     * `originalUrl` is native), falling back to `req.url` for requests without it.
     *
     * @param {object} data               - Current action data to preserve
     * @param {object} [requestStorage]   - Storage target; defaults to `req.session`
     * @returns {object} requestStorage   - The updated storage object
     *
     * @example
     * // In an auth-gate middleware, before bouncing an unauthenticated user to login:
     * if (!req.session.user) {
     *     self.pauseRequest(req.get);        // snapshot into req.session.haltedRequest
     *     return self.redirect('/login', true);
     * }
     */
    this.pauseRequest = function(data, requestStorage) {

        // #B38 — released-response guard (see #B31): pauseRequest snapshots the current
        // request before a login redirect; on a released request (per-request refs nulled
        // by a terminal exit) there is nothing to snapshot — a no-op return is correct.
        // Live requests are unaffected (guard skipped while the refs exist).
        if ( local.req == null ) {
            return;
        }

        // saving halted request
        var req             = local.req
            , res           = local.res
            , next          = local.next
            , haltedRequest = {
                // #B219 — the isaac engine strips the query string from req.url before
                // controllers run (the query is parsed into req.get); the byte-exact
                // incoming URL survives on req.originalUrl, stamped as the engine
                // listener's first statement. Express sets originalUrl natively and does
                // not strip. Snapshot the preserved URL so the #B215 byte-exact replay
                // actually carries the query; bare/harness requests without the property
                // keep the historical req.url source.
                // was: url     : req.url,
                url     : req.originalUrl || req.url,
                routing : req.routing,
                method  : req.method.toLowerCase(),
                data    : JSON.clone(data)
            }
        ;

        if (
            typeof(requestStorage) == 'undefined'
            && typeof(req.session) != 'undefined'
        ) {
            requestStorage = req.session;
        }

        if (
            typeof(requestStorage) == 'undefined'
        ) {
            var error = new ApiError('`requestStorage` is required', 424);
            self.throwError(error);
            return;
        }

        var requestParams = {}, i = 0;
        for (var p in req.params) {
            if (i > 0) {
                requestParams[p] = req.params[p];
            }
            ++i;
        }
        if (requestParams.count() > 0) {
            haltedRequest.params = requestParams;
        }

        requestStorage.haltedRequest = haltedRequest;

        return requestStorage;
    }


    /**
     * Replay a previously paused request (see `pauseRequest()`). Reads the `haltedRequest`
     * snapshot from `requestStorage` (defaulting to `req.session`), restores the original
     * url / method / data / params onto the live request, then re-dispatches it: a GET is
     * replayed by redirecting to the byte-exact halted URL — query string included —
     * whenever a live session exists (#B215; with no live session the URL is recomposed
     * from the route pattern plus the snapshotted params, or the halted data as query
     * params — the composed URL being the data's only travel channel there); a non-GET is
     * re-dispatched in-process to the original controller action (crossing namespaces via
     * `requireController()` when needed). The snapshot is cleared from storage once
     * consumed. For a GET replay, the
     * halted request's extra data rides the session flash channel (`inheritedData`,
     * consumed one-shot by the next routed GET) whenever a live session exists — a custom
     * `requestStorage` with no live session degrades to a plain replay without the data.
     *
     * Requires a `haltedRequest` to have been attached to the session (or to the passed
     * `requestStorage`) beforehand — typically by `pauseRequest()`.
     *
     * @param {object} [requestStorage] - Object holding `haltedRequest`; defaults to `req.session`
     * @returns {void}
     *
     * @example
     * // In a post-login action/middleware, replay whatever the user was reaching for:
     * if (self.isHaltedRequest()) {
     *     return self.resumeRequest();       // reads req.session.haltedRequest and replays it
     * }
     */
    this.resumeRequest = function(requestStorage) {

        if (local.haltedRequestUrlResumed)
            return;

        // #B38 — released-response guard (see #B31): resumeRequest replays a halted
        // request against the live request/response; on a released request (per-request
        // refs nulled by a terminal exit) there is nothing to replay onto — a no-op return
        // is correct. Live requests are unaffected (guard skipped while the refs exist).
        if ( local.req == null ) {
            return;
        }

        var haltedRequest   = null
            , req           = local.req
            , res           = local.res
            , next          = local.next
        ;

        if (
            typeof(requestStorage) == 'undefined'
            && typeof(req.session) != 'undefined'
        ) {
            requestStorage = req.session;
        }

        if (
            typeof(requestStorage) == 'undefined'
            ||
            typeof(requestStorage) != 'undefined'
            && typeof(requestStorage.haltedRequest) == 'undefined'
        ) {
            var error = new ApiError('`requestStorage.haltedRequest` is required', 424);
            self.throwError(error);
            return;
        }
        haltedRequest       = requestStorage.haltedRequest;
        var data            = haltedRequest.data || {};
        // request methods cleanup
        // checkout /framework/{verrsion}/core/template/conf/(settings.json).server.supportedRequestMethods
        var serverSupportedMethods = local.options.conf.server.supportedRequestMethods;
        for (let method in serverSupportedMethods) {
            if (req.method.toLowerCase() == method) {
                data = merge(data, req[method])
            }

            delete req[method];
        }


        var dataAsParams    = {};
        if (data.count() > 0) {
            dataAsParams = JSON.clone(haltedRequest.data);
        }
        // #B215 — replay the byte-exact halted URL (query string included) whenever a
        // live session exists. The recompose below only carries query keys captured
        // into `req.params` during the original match (keys declared in BOTH the
        // rule's `requirements` AND `param`): a key bound in `param` only substitutes
        // its `:key` placeholders at match-commit yet never reaches req.params, and an
        // undeclared key never does either — so the GET replay arrived query-less,
        // matched anyway, and rendered literal `:key` template paths as a 500. The
        // inheritedData flash cannot heal that: router.js merges it into req.get AFTER
        // matching. `haltedRequest.url` is stamped by every pauseRequest(), so
        // in-flight pre-#B215 snapshots replay correctly too (#B219: since the isaac
        // engine strips the query from req.url before controllers run, pauseRequest
        // snapshots req.originalUrl — pre-#B219 isaac snapshots are path-only and
        // replay exactly as captured). The session-less flow
        // keeps the recompose: with no session the flash cannot carry the halted data,
        // and the composed URL's query params are its only travel channel.
        // was: var url = lib.routing.getRoute(haltedRequest.routing.rule, haltedRequest.params||dataAsParams).url;
        var hasLiveSession  = ( typeof(req.session) != 'undefined' && req.session ) ? true : false;
        var url             = ( hasLiveSession && typeof(haltedRequest.url) != 'undefined' && haltedRequest.url )
                                ? haltedRequest.url
                                : lib.routing.getRoute(haltedRequest.routing.rule, haltedRequest.params||dataAsParams).url;
        var requiredController = self; // by default;
        if ( req.routing.namespace != haltedRequest.routing.namespace ) {
            try {
                requiredController = self.requireController(haltedRequest.routing.namespace, self._options );
            } catch (err) {
                self.throwError(err);
            }
        }
        req.routing     = haltedRequest.routing;
        req.method      = haltedRequest.method;
        req[haltedRequest.method] = data;

        local.haltedRequestUrlResumed = true;
        if ( req.method.toUpperCase() === 'GET' ) {
            if ( typeof(requestStorage.haltedRequest) != 'undefined' ) {
                delete requestStorage.haltedRequest;
            }
            delete requestStorage.haltedRequest;
            delete requestStorage.inheritedData;
            requestStorage.haltedRequestUrlResumed = url;

            // Session carry for the replay (mirrors redirect()'s XHR-branch stash):
            // without it, the plain-XHR and non-XHR replays silently DROPPED the halted
            // request's extra data (only the popin-XHR flavor, which routes through
            // redirect(), carried it). Consumed by router.js on the replayed GET
            // (one-shot merge into `req.get`). A custom `requestStorage` with no live
            // session degrades exactly as before (data dropped).
            if ( data.count() > 0 ) {
                if ( typeof(data.session) != 'undefined' ) {
                    delete data.session;
                }
                var userSession = ( typeof(req.session) != 'undefined' && req.session )
                    ? ( req.session.user || req.session )
                    : null;
                if ( userSession ) {
                    userSession.inheritedData = data;
                }
            }

            if (
                typeof(req.routing.param.isPopinContext) != 'undefined'
                && String(req.routing.param.isPopinContext).toLowerCase() === 'true'
                && self.isXMLRequest()
                ||
                self.isPopinContext()
                && self.isXMLRequest()
            ) {
                // return self.renderJSON({
                //     isXhrRedirect: true,
                //     popin: {
                //         location: url
                //     }
                // })
                self.redirect(url, true);
                return;
            }
            else if (self.isXMLRequest() ) {
                return self.renderJSON({
                    isXhrRedirect: true,
                    location: url
                })
            }

            requiredController.redirect(url, true);

        } else {
            local.onHaltedRequestResumed = function(err) {
                if (!err) {
                    delete requestStorage.haltedRequest;
                    delete requestStorage.inheritedData;
                }
            }
            if ( typeof(next) == 'function' ) {
                console.warn('About to override `next` param');
            }

            try {
                requiredController[req.routing.param.control](req, res, next);
                // consuming it
                local.onHaltedRequestResumed(false);
            } catch(err) {
                console.error('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] Could not resume haltedRequest\n' + err.stack );
                self.throwError(err);
            }


        }
    }


    /**
     * Render a custom error page defined in `routing.json` via `req.routing.param.error`.
     * Sets `local.options.isRenderingCustomError = true` so the render pipeline
     * bypasses the normal rendering-stack guard.
     * Stamps `res.statusCode` from the error's `status` — when it is a known
     * status code — before dispatching, so every render delegate serves the
     * custom page with the real HTTP status (#B190).
     * Points `errOptions.template` at the request's own template object and
     * re-seeds its per-response accumulators (`h2Links`, `externalPlugins`)
     * before dispatching, so the error page's `link` preload header and its
     * external-plugin tags are built from the object `getNodeRes()` writes
     * to, and are never doubled by a failure that struck after the failing
     * route's assets were already resolved (#B497).
     *
     * @param {object}   req  - Incoming request (reads `req.routing.param`)
     * @param {object}   res  - Server response
     * @param {function} next - Next middleware callback
     * @returns {void}
     */
    this.renderCustomError = function (req, res, next) {

        // preventing multiple call of self.renderWithoutLayout() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false;
        }
        local.options.isRenderingCustomError = true;

        //local.options.isWithoutLayout = true;

        var data = null;
        if ( typeof(req.routing.param.error) != 'undefined' ) {
            data = JSON.clone(req.routing.param.error) || {};
            delete req.routing.param.error
        }

        var session = getSession();
        if (session) {
            if (!data) {
                data = {}
            }
            data.session = ( typeof(session.user) != 'undefined' ) ? JSON.clone(session.user) : JSON.clone(session);
        }
        var displayInspector = req.routing.param.displayInspector || false;
        if (req.routing.param.displayInspector) {
            delete req.routing.param.displayInspector
        }
        var isLocalOptionResetNeeded = req.routing.param.isLocalOptionResetNeeded || false;
        var errOptions = null;
        if (isLocalOptionResetNeeded) {
            delete req.routing.param.isLocalOptionResetNeeded;
            var bundleConf = JSON.clone(local.options.conf);
            var bundle = req.routing.bundle;
            var param = req.routing.param;
            var localOptions = {
                // view namespace first
                //namespace       : null,
                control         : param.control,
                //controller      : controllerFile,
                //controller: '<span class="gina-bundle-name">' + bundle +'</span>/controllers/controller.js',
                file: param.file,
                //layout: param.file,
                //bundle          : bundle,//module
                bundlePath      : bundleConf.bundlesPath + '/' + bundle,
                renderingStack  : bundleConf.renderingStack,
                //rootPath        : self.executionPath,
                // We don't want to keep original conf untouched
                //conf            : JSON.clone(conf),
                //template: (routeHasViews) ? bundleConf.content.templates[templateName] : undefined,
                //isUsingTemplate: local.isUsingTemplate,
                //isCacheless: isCacheless,
                path: null //, // user custom path : namespace should be ignored | left blank
                //assets: {}
            };
            errOptions = merge(localOptions, local.options);


        } else if ( typeof(req.routing.param.file) != 'undefined' && req.routing.param.file ) {
            // #B191 — the resolved error template must never depend on the
            // reset flag: the server-side throwError twin (server.js) sets
            // `param.file` but not `isLocalOptionResetNeeded`, and the flag
            // used to ride a SHARED routing object overlapping errors could
            // strip. A falsy read here left errOptions null, so the render
            // delegates fell back to the FAILING route's own `file` and
            // built a bare, un-rooted template path — surfacing an upstream
            // failure as a bogus "check your routing.json" misdirection.
            // `path: null` mirrors the reset branch: custom paths ignore
            // the namespace.
            errOptions = merge({
                file: req.routing.param.file,
                path: null
            }, local.options);
        }
        // #B497 — the render delegates resolve their view config as
        // `errOptions || local.options` and build the final-200 `link` preload
        // header from `localOptions.template.h2Links`, while getNodeRes()
        // accumulates into `local.options.template.h2Links`. lib/merge grafts
        // `template` onto errOptions as a NEW shallow copy (nested arrays
        // shared, scalars copied at merge time), so on a custom-error render
        // the writer and the reader held different objects and the
        // config-declared preloads never reached the error page's header.
        // One request, one response, one template-state object: point the
        // error render at the request's own — exactly what a normal render
        // (errOptions null) already sees.
        if ( errOptions && local.options.template ) {
            errOptions.template = local.options.template;
        }
        // A custom-error render is a SECOND top-level render on the same
        // response, so re-seed the per-response accumulators the router seeds
        // per request (router.js — `h2Links = ''` under http/2,
        // `externalPlugins = []`): an error that strikes AFTER the failing
        // route's setResources() ran (a template compilation error) would
        // otherwise make getNodeRes() append a second copy of every preload
        // to the 200 header and splice every external plugin into the head
        // twice. Under http/1 h2Links is never seeded and stays undefined.
        if ( local.options.template ) {
            if ( typeof(local.options.template.h2Links) == 'string' ) {
                local.options.template.h2Links = '';
            }
            if ( Array.isArray(local.options.template.externalPlugins) ) {
                local.options.template.externalPlugins = [];
            }
        }
        // #B190 — stamp the HTTP status on the response before the render
        // dispatch. The swig and v1 delegates recompute it downstream from
        // the page data, but the nunjucks and the async delegates only read
        // the already-set `res.statusCode || 200` at their write sites — so
        // without this stamp a configured custom error page is served as
        // HTTP 200 there (live-measured 2026-08-01: nunjucks 200 vs swig 500
        // on the same fixture).
        var _eStatusCodes = local.options.conf
            && local.options.conf.server
            && local.options.conf.server.coreConfiguration
            && local.options.conf.server.coreConfiguration.statusCodes
            || null;
        if (
            data
            && data.status
            && res
            && !res.headersSent
            && _eStatusCodes
            && typeof(_eStatusCodes[ data.status ]) != 'undefined'
        ) {
            res.statusCode = data.status;
        }

        delete local.options.namespace;
        self.render(data, displayInspector, errOptions);
    }

    var getResponseProtocol = function (response) {
        // var options =  local.options;
        // var protocolVersion = ~~options.conf.server.protocol.match(/\/(.*)$/)[1].replace(/\.\d+/, '');

        var bundleConf  = options.conf;
        // local.req may be null when called from a background HTTP/2 session error
        var protocol    = (local.req)
            ? 'http/'+ local.req.httpVersion
            : bundleConf.server.protocol; // fall back to configured protocol
        // switching protocol to h2 when possible
        if ( /http\/2/.test(bundleConf.server.protocol) && response && response.stream ) {
            protocol    = bundleConf.server.protocol;
        }

        return protocol;
    }


    /**
     * Throw error — terminates the request with an error response.
     *
     * Response shape depends on the request type:
     *   - XHR / non-templated routes → JSON body `{ status, error, stack? }`
     *   - Templated routes → HTML error page or rendered error template
     *
     * The `stack` field (JSON) and the `<pre class="stack">` block (fallback
     * HTML error page) are emitted only when the active scope is local
     * (`NODE_SCOPE_IS_LOCAL=true`) so the dev toolbar can render server-side
     * stack frames in its data-xhr panel and the fallback HTML page shows the
     * trace inline. Beta, testing, production, and unset scopes strip both to
     * prevent server-internals (file paths, library versions, internal frames)
     * from leaking to API clients or page viewers. Custom error templates
     * dispatched via `renderCustomError` are consumer-owned — what the
     * template renders from `req.params.errorObject` is the consumer's call.
     *
     * #ERRREF — every JSON error body additionally carries a top-level
     * `ref`: a short incident ref minted per error (or honoured from a
     * relay-safe producer-set `ref` on the error object / msg), present in
     * ALL scopes, and paired server-side with the full error detail plus
     * the request correlation id in ONE error-level log line emitted BEFORE
     * the strip — so what the wire loses stays findable from a user-relayed
     * ref. The HTML surfaces (custom error page `eData.ref` + the inline
     * fallback page) carry the same ref.
     *
     * Polymorphic signatures:
     *   - `throwError(err)` — Error instance or errorObj `{status, error, ...}`
     *   - `throwError(code, err)` — 2-arg form: HTTP status + Error|string
     *   - `throwError(res, code, msg)` — internal 3-arg form used by the router
     *
     * Structured error payloads: an errorObj carrying `error` plus `fields`
     * (the DTO/validator field map), `flash`, or `errors` (the #FIN3
     * message-validator document-error array) is merged wholesale into the
     * wire body, so those keys ride the JSON envelope alongside
     * `status`/`error`/`ref`.
     *
     * #CE1 — transient upgrade (opt-in): when the bundle sets
     * `server.transientErrors.enabled: true` and any call argument carries
     * `isTransient === true` (a `lib/connector-error`-stamped datastore
     * error), a resolution that would render 500 renders 503 instead, with
     * a `Retry-After: <server.transientErrors.retryAfter>` header (default
     * 30s) and the user-facing `error` field set to
     * `server.transientErrors.message` (default: the standard 503 status
     * text). Explicit non-500 statuses are never upgraded; `message` and
     * `stack` keep their existing scope semantics, and the #ERRREF pairing
     * line below keeps the full pre-strip detail server-side. Deliberately
     * NOT mirrored in the server-side throwError twin (core/server.js):
     * stamped connector errors surface through controller actions only.
     *
     * Late calls: when throwError fires after a response terminal exit has
     * already released the per-request refs (`local.res` is null — e.g. an
     * entity/query callback resuming after a redirect() sent its 301), the
     * call is logged and ignored instead of crashing the bundle. This holds
     * for every call shape: the 1-arg `throwError(err)` form is caught by the
     * guard after the errorObject build (#B31), and the 2-arg/3-arg forms —
     * whose `res` is already the released `local.res` before that build — are
     * caught by an up-front guard so the HTTP/2 `res.stream` and the
     * errorObject-build `res.error` reads can't deref null first (#B44).
     *
     * @param {object} [ res ]
     * @param {number} code
     * @param {string} msg
     *
     * @returns {void|boolean} `false` when the call is ignored (nested
     *          rendering stack, or a late call on a released response)
     * */
    this.throwError = function(res, code, msg) {

        // #CE1 — capture the transient-classified error source (if any)
        // BEFORE the call-shape normalizations below reassign res/code/msg.
        // Only `lib/connector-error.stamp()`ed datastore errors carry
        // `isTransient === true`, so scanning the raw call arguments is an
        // unambiguous, total probe (guarded against hostile getters).
        var _transientSrc = null;
        var _teConf = null;            // resolved lazily, only when a 500 would upgrade
        var _transient503Applied = false;
        try {
            for (var _ti = 0; _ti < arguments.length && _ti < 3; _ti++) {
                if ( arguments[_ti] && typeof(arguments[_ti]) == 'object' && arguments[_ti].isTransient === true ) {
                    _transientSrc = arguments[_ti];
                    break;
                }
            }
        } catch (_teScanErr) {}

        /**
         * #CE1 — opt-in transient upgrade: with `server.transientErrors.enabled`,
         * a transient connector failure that would render as 500 renders as
         * 503 + `Retry-After` instead; any explicit non-500 status is
         * respected. Applied at BOTH status-resolution sites below.
         *
         * @inner
         * @param {number|string} resolvedCode - the status the resolution chain settled on
         * @returns {number|string} 503 when the upgrade applies, else `resolvedCode` unchanged
         */
        var _maybeUpgradeTransient503 = function(resolvedCode) {
            if ( _transientSrc && resolvedCode == 500 ) {
                if (_teConf === null) {
                    _teConf = _getTransientErrorsConf(local.options.conf);
                }
                if (_teConf.enabled) {
                    _transient503Applied = true;
                    return 503;
                }
            }
            return resolvedCode;
        };

        /**
         * #CE1 — an upgraded 503 advertises when to retry. A single early
         * setHeader survives every downstream egress: the JSON writeHead
         * calls merge per-key (Retry-After is never overwritten), the HTML
         * fallback writeHead does the same, and the renderCustomError →
         * render pipeline forwards res.getHeaders() into the HTTP/2 frame
         * (#H8). Idempotent — safe to call at both upgrade sites; no-ops
         * unless the upgrade fired.
         *
         * @inner
         * @param {object} targetRes - the normalized live response
         * @returns {void}
         */
        var _setTransientRetryAfterHeader = function(targetRes) {
            if ( !_transient503Applied || !targetRes || typeof(targetRes.setHeader) != 'function' ) {
                return;
            }
            try {
                targetRes.setHeader('Retry-After', String(_teConf.retryAfter));
            } catch (_teHdrErr) {}
        };

        // 2-arg form (statusCode, Error|string) — without this shift, the
        // downstream Error/string branch coerces code via /^\d{3}$/.test(String(code))
        // and falls back to 500 because `code` holds the Error or string, not
        // the number, and `res` (the number itself) has no .status property.
        // The 2-arg errorObj form (statusCode, errorObj) is intentionally NOT
        // shifted — the existing `else if (arguments.length < 3)` branch below
        // already handles it correctly.
        if ( typeof(res) == 'number' && arguments.length === 2 && (
            arguments[1] instanceof Error
            || typeof(arguments[1]) == 'string'
        )) {
            msg  = arguments[1];
            code = res;
            res  = local.res;
        }

        // #B44 — for the 2-arg `throwError(code, Error|string)` and 3-arg
        // `throwError(local.res, code, msg)` shapes, `res` is already `local.res`
        // here (set by the shift above, or passed by the caller) — which is null
        // when a terminal exit has released the response. The reads below all
        // deref `res` BEFORE the #B31 guard further down: `res.stream` in the
        // protocol branch (HTTP/2 bundles crash there) and `res.error` /
        // `res.stack` / `res.message` / `res.fallback` in the errorObject build
        // (every bundle crashes there). So a released response would crash
        // (uncaughtException → SIGTERM) instead of being ignored. Bail up-front
        // with the same no-op contract as the #B31 guard. The 1-arg shapes keep
        // a truthy `res` (the Error/errorObj) here, so they are unaffected and
        // still reach the #B31 guard after `res` is reassigned to `local.res` at
        // the end of the errorObject build.
        if ( !res ) {
            self.isProcessingError = true;
            var _b44LateError = msg || code;
            var _b44LateErrorStr = '';
            try {
                _b44LateErrorStr = ( _b44LateError && typeof(_b44LateError) == 'object' ) ? JSON.stringify(_b44LateError) : String(_b44LateError || '');
            } catch (_b44JsonErr) {
                _b44LateErrorStr = String(_b44LateError);
            }
            console.warn('[ Controller ] throwError() called after the response was released — ignoring late error: '+ _b44LateErrorStr);
            return false;
        }

        var protocol        = getResponseProtocol(res);
        var stream          = ( /http\/2/.test(protocol) && res.stream ) ? res.stream : null;
        var header          = ( /http\/2/.test(protocol) && res.stream ) ? {} : null;

        self.isProcessingError = true;
        var errorObject = null; // to be returned

        // preventing multiple call of self.throwError() when controller is rendering from another required controller
        if (local.options.renderingStack.length > 1) {
            return false
        }
        var bundleConf = local.options.conf;
        var bundle = bundleConf.bundle;
        // handle error fallback
        // err.fallback must be a valide route object or a url string
        var fallback = null;
        var standardErrorMessage = null;
        if (
            arguments[0] instanceof Error
            || arguments.length == 1 && typeof(res) == 'object'
            || arguments[arguments.length-1] instanceof Error
            || typeof(arguments[arguments.length-1]) == 'string' && !(arguments[0] instanceof Error)
        ) {

            msg    = ( !/^\d+$/.test(code) && typeof(msg) == 'undefined' ) ?  code : msg;
            // Preserve an explicitly passed HTTP status code; fall back to res.status or 500.
            // #B466 — both candidates are validated: an unvalidated res.status
            // reached writeHead() verbatim and threw ERR_HTTP_INVALID_STATUS_CODE
            // on any non-numeric value, i.e. the error page failed exactly when
            // it was needed. Guarding the explicit arm too closes the same hole
            // for a 3-digit-but-invalid code such as "099".
            code    = _isValidHttpStatus(code) ? code : ( res && _isValidHttpStatus(res.status) ) ? res.status : 500;
            // #CE1 — a transient datastore failure resolving to 500 upgrades
            // to 503 when the bundle opted in (explicit non-500 preserved above)
            code    = _maybeUpgradeTransient503(code);

            if ( typeof(statusCodes[code]) != 'undefined' ) {
                standardErrorMessage = statusCodes[code];
            } else {
                console.warn('[ ApiValidator ] statusCode `'+ code +'` not matching any definition in `'+_( getPath('gina').core + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
            }

            errorObject = {
                status  : code,
                error   : res.error || res.message || standardErrorMessage
            };

            if ( res instanceof Error || typeof(res.stack) != 'undefined' ) {
                //errorObject.status   = code;
                //errorObject.error    = standardErrorMessage || res.error || res.message;
                errorObject.stack   = res.stack;
                if (res.message && typeof(res.message) == 'string') {
                    errorObject.message = res.message;
                } else if (res.message) {
                    console.warn('[ Controller ] Ignoring message because of the format.\n'+res.message)
                }

                // ApiError merge


            } else if ( typeof(arguments[arguments.length-1]) == 'string' ) {
                // formated error
                errorObject.message = arguments[arguments.length-1] || msg
                // errorObject = merge(arguments[arguments.length-1], errorObject)
            } else if (
                arguments[arguments.length-1] instanceof Error
                || typeof(res) == 'object' && typeof(res.stack) != 'undefined'
            ) {
                var _lastArg = arguments[arguments.length-1];
                if (_lastArg instanceof Error) {
                    // Error properties (message, stack) are non-enumerable —
                    // merge() silently drops them. Extract explicitly so they
                    // survive JSON.stringify and reach the client error dialog.
                    if (_lastArg.message) errorObject.message = _lastArg.message;
                    if (_lastArg.stack)   errorObject.stack   = _lastArg.stack;
                    if (!errorObject.error) errorObject.error  = _lastArg.message || standardErrorMessage;
                } else {
                    errorObject = merge(_lastArg, errorObject);
                }
            } else if (
                !(arguments[arguments.length-1] instanceof Error)
                && typeof(res) == 'object'
                && typeof(res.error) != 'undefined'
                && typeof(res.fields) != 'undefined'
                ||
                !(arguments[arguments.length-1] instanceof Error)
                && typeof(res) == 'object'
                && typeof(res.error) != 'undefined'
                && typeof(res.flash) != 'undefined'
                ||
                // #FIN3 — a message-validator refusal carries its document
                // errors ARRAY under the sibling top-level key
                !(arguments[arguments.length-1] instanceof Error)
                && typeof(res) == 'object'
                && typeof(res.error) != 'undefined'
                && typeof(res.errors) != 'undefined'
            ) { // ApiError merge
                errorObject = merge(arguments[arguments.length-1], errorObject)
            }

            if ( typeof(res.fallback) != 'undefined' ) {
                fallback = res.fallback
            }

            res = local.res;

        } else if (arguments.length < 3) {
            msg           = code || null;
            // #B466 — `res` holds the code in this shape, and an invalid SCALAR
            // would reach writeHead() verbatim. An OBJECT is deliberately passed
            // through untouched: the errorObj shape is unpacked at the site-2
            // resolution below (which applies the same guard), and collapsing it
            // here would break the #CE1 transient-503 upgrade that depends on it.
            code          = ( res !== null && typeof(res) == 'object' ) ? res
                          : _isValidHttpStatus(res) ? res
                          : 500;
            res           = local.res;
        }

        var responseHeaders = null;
        // #B31 — a late throwError (an entity/query callback, timer or catch
        // handler resuming after the action already responded) can fire AFTER
        // a terminal exit (redirect()/render*()/a previous throwError) released
        // local.req/res/next. Every call shape above has normalized `res` to
        // local.res by this point, so a null `res` means the response is gone:
        // reading getHeaders off it threw `Cannot read properties of null
        // (reading 'getHeaders')` — an uncaughtException that proc.js escalates
        // to SIGTERM, killing the bundle and every in-flight request with it
        // (same crash class as #B30: fix the throw site, never widen the
        // uncaughtException net). Log the swallowed error so the late failure
        // stays observable, then no-op — same return contract as the
        // renderingStack guard above.
        if ( !res ) {
            res = local.res;
        }
        if ( !res ) {
            var _lateError = errorObject || msg || code;
            var _lateErrorStr = '';
            try {
                _lateErrorStr = ( _lateError && typeof(_lateError) == 'object' ) ? JSON.stringify(_lateError) : String(_lateError || '');
            } catch (_lateJsonErr) {
                _lateErrorStr = String(_lateError);
            }
            console.warn('[ Controller ] throwError() called after the response was released — ignoring late error: '+ _lateErrorStr);
            return false;
        }
        if ( typeof(res.getHeaders) == 'undefined' && typeof(res.stream) != 'undefined' ) {
            responseHeaders = res.stream.sentHeader;
        } else {
            responseHeaders = res.getHeaders() || local.res.getHeaders();
        }
        // var responseHeaders = res.getHeaders() || local.res.getHeaders();
        // #CE1 — first upgrade site fired above: `res` is the normalized live
        // response by this point, so the Retry-After header lands here, ahead
        // of every branch (JSON writeHead trio, HTML fallback, custom pages).
        _setTransientRetryAfterHeader(res);
        var req             = local.req;
        var next            = local.next;
        if (!headersSent()) {
            // DELETE request methods don't normaly use a view,
            // but if we are calling it from a view, we should render the error back to the view
            if ( self.isXMLRequest() || !hasViews() && !/delete/i.test(req.method) || !local.options.isUsingTemplate && !hasViews() || hasViews() && !local.options.isUsingTemplate ) {
                // fallback interception
                if ( fallback ) {
                    if ( typeof(fallback) == 'string' ){ // string url: user provided
                        return self.redirect( fallback, true )
                    } else {
                        // else, using url from route object
                        // Reminder
                        // Here, we use route.toUrl() intead of
                        // route.url to support x-bundle com
                        // #B152 — re-point the route object's proxy context to THIS
                        // request's #B65 slots before toUrl() (worker-global latch
                        // fallback when slot-less), mirroring the redirect/getUrl sites.
                        if ( req && typeof(req._ginaIsProxyHost) != 'undefined' ) {
                            fallback.isProxyHost = ( req._ginaIsProxyHost === true );
                            if ( fallback.isProxyHost && req._ginaProxyHostname ) {
                                fallback.proxy_hostname = req._ginaProxyHostname;
                            }
                        }
                        return self.redirect( fallback.toUrl() );
                    }
                }

                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error || code.message;
                    // #B466 — same guard as the resolution arms above.
                    code    = _isValidHttpStatus(code.status) ? code.status : 500;
                    // #CE1 — second upgrade site: the 2-arg errorObj shape
                    // resolves its status only here, after the early header
                    // point above — so this site sets its own header too
                    // (idempotent with the first call).
                    code    = _maybeUpgradeTransient503(code);
                    _setTransientRetryAfterHeader(res);
                }
                if ( typeof(statusCodes[code]) != 'undefined' ) {
                    standardErrorMessage = statusCodes[code];
                } else {
                    console.warn('[ ApiValidator ] statusCode `'+ code +'` not matching any definition in `'+_( getPath('gina').core + '/status.codes')+'`\nPlease contact the Gina dev team to add one if required');
                }

                // if ( !local.res.getHeaders()['content-type'] /**!req.headers['content-type'] */  ) {
                //     // Internet Explorer override
                //     if ( typeof(req.headers['user-agent']) != 'undefined' && /msie/i.test(req.headers['user-agent']) ) {
                //         res.writeHead(code, "content-type", "text/plain")
                //     } else {
                //         res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime['json']} );
                //     }
                // }

                // TODO - test with internet explorer then remove this if working
                if ( typeof(req.headers['user-agent']) != 'undefined' ) {
                    if ( /msie/i.test(req.headers['user-agent']) ) {
                        // #B467 - Node's signature is writeHead(status[, statusMessage][, headers]):
                        // the 3-arg form used here put the mime STRING in the headers slot, so Node
                        // index-keyed it into junk headers ("0","1",...) and emitted NO content-type.
                        // The charset is declared because the body below is JSON.stringify(...) written
                        // via res.end(), i.e. UTF-8 - same form the text-render path already builds.
                        res.writeHead(code, { 'content-type': 'text/plain; charset='+ bundleConf.encoding } );
                    } else {
                        var contentType = ( responseHeaders && responseHeaders['content-type'])
                                         ? responseHeaders['content-type']
                                         : bundleConf.server.coreConfiguration.mime['json']+ '; charset='+ bundleConf.encoding
                        ;
                        res.writeHead(code, { 'content-type': contentType } );
                    }
                } else if ( typeof(responseHeaders['content-type']) != 'undefined' ) {
                    res.writeHead(code, { 'content-type': responseHeaders['content-type']} )
                } else {
                    // #B467 - same 3-arg misuse as the MSIE branch above; the mime expression is
                    // unchanged, only the argument shape is corrected.
                    res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime['json']+ '; charset='+ bundleConf.encoding } );
                }



                if (!errorObject) {
                    errorObject = {
                        status: code,
                        //errors: msg.error || msg.errors || msg,
                        error: standardErrorMessage || msg.error || msg,
                        message: msg.message || msg,
                        stack: msg.stack
                    }
                }

                // #CE1 — on an upgraded 503 the user-facing `error` field
                // carries the configured (or standard) service-unavailable
                // text instead of the raw datastore error; `message`/`stack`
                // keep their existing scope semantics, and the full detail
                // stays in the #ERRREF pairing line below.
                if ( _transient503Applied && errorObject ) {
                    errorObject.error = _teConf.message || standardErrorMessage || statusCodes['503'];
                }

                // #ERRREF — mint/honour the incident ref + the ONE full-detail
                // pairing line, emitted BEFORE the egress strip below: outside
                // local scope this is the only server-side capture of the full
                // error on this path (the strip used to run with no pre-strip
                // log, so a production API error's stack was lost entirely).
                // The ref rides the wire as a top-level field in ALL scopes and
                // pairs with the request correlation id (#M12b/#COMPLY2). Kept
                // in sync with the server-side throwError twin (core/server.js).
                errorObject.ref = _mintErrorRef(
                    errorObject.ref || ( ( msg && typeof(msg) == 'object' ) ? msg.ref : undefined )
                );
                var _errDetail = errorObject.stack || errorObject.message
                    || ( ( errorObject.error && typeof(errorObject.error) === 'object' ) ? JSON.stringify(errorObject.error) : errorObject.error )
                    || '';
                if ( msg && typeof(msg) == 'object' && msg.cause ) {
                    _errDetail += '\ncaused by: '+ ( msg.cause.stack || msg.cause.message || msg.cause );
                }
                console.error('[ BUNDLE ][ '+ bundleConf.bundle +' ][ Controller ][ ref '+ errorObject.ref +' ][ req '+ ( ( req && req._ginaReqId ) || '-' ) +' ] '+ req.method +' [ '+ ( errorObject.status || res.statusCode ) +' ] '+ req.url + ( _errDetail ? '\n'+ _errDetail : '' ));

                // Fail-closed: strip server-side stack from the JSON wire outside
                // local scope so file paths, library versions, and internal stack
                // frames don't leak to API clients. Local scope keeps it so the
                // dev toolbar's data-xhr panel can render it (events.js:394 →
                // ginaToolbar.update('data-xhr', XHRData)).
                if (!_isLocalScope && errorObject && errorObject.stack) {
                    delete errorObject.stack;
                }

                var errOutput = null, output = errorObject.toString();
                if ( output == '[object Object]' ) {
                    errOutput = JSON.stringify(errorObject);
                } else {
                    errOutput = JSON.stringify(
                        {
                            status  : errorObject.status,
                            error   : output,
                            stack   : errorObject.stack || null,
                            ref     : errorObject.ref
                        }
                    );
                }

                // #ERRREF — the post-strip wire-mirror log previously emitted
                // here is superseded by the full-detail pairing line above
                // (which carries strictly more: the pre-strip stack + the ref).
                // Release per-request refs — req/res are local copies so res.end() below is unaffected.
                local.req = null;
                local.res = null;
                local.next = null;
                return res.end(errOutput);
            } else {

                // #ERRREF — HTML-branch mint: one ref for the detail log line,
                // the custom error page data (eData), and the inline fallback
                // page. Same mint/honour contract as the JSON branch above.
                var _errRef = _mintErrorRef(
                    ( errorObject && errorObject.ref )
                    || ( ( msg && typeof(msg) == 'object' ) ? msg.ref : undefined )
                );
                if ( errorObject ) {
                    errorObject.ref = _errRef;
                }

                // #CE1 — custom error pages (eData) get the clean
                // service-unavailable text on an upgraded 503; the eData
                // merge below carries it. The inline fallback page keeps
                // rendering the thrown error's own fields, as before.
                if ( _transient503Applied && errorObject ) {
                    errorObject.error = _teConf.message || standardErrorMessage || statusCodes['503'];
                }

                if ( errorObject && errorObject != 'null' && /object/i.test(typeof(errorObject)) ) {
                    // replaced: (errorObject.stack||errorObject.message) — both may be undefined for plain
                    // object errors forwarded from query() (e.g. an upstream non-2xx). Fall back to serializing
                    // errorObject.error so the log always contains the failure reason. (#Q1)
                    // When no stack is present on the error object, capture the throwError callsite so the
                    // log always shows which controller method caused the error. (#Q1)
                    if ( !errorObject.stack ) {
                        try { throw new Error('[throwError] callsite'); } catch(_cs) {
                            errorObject.stack = _cs.stack;
                        }
                    }
                    var _logMsg = errorObject.stack || errorObject.message
                        || (typeof(errorObject.error) === 'object' ? JSON.stringify(errorObject.error) : errorObject.error)
                        || JSON.stringify(errorObject);
                    console.error('[ ref '+ _errRef +' ][ req '+ ( ( req && req._ginaReqId ) || '-' ) +' ] '+ req.method +' [ '+ errorObject.status +' ] '+ req.url + '\n'+ _logMsg);
                }

                 // intercept none HTML mime types
                 // #B30: controller-side error-path mirror of server.js:4936 — safeDecodeURI so a
                 // malformed-% URL cannot crash the bundle from inside the error handler.
                 // was: var url = decodeURI(local.req.url) /// avoid %20
                 var url                     = safeDecodeURI(local.req.url) /// avoid %20
                    , ext                   = null
                    , isHtmlContent         = false
                    , hasCustomErrorFile    = false
                    , eCode                 = code.toString().substring(0,1) + 'xx'
                ;
                var extArr = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/);
                if (extArr) {
                    ext = extArr[0].substring(1);
                }
                if ( !ext || /^(html|htm)$/i.test(ext) ) {
                    isHtmlContent = true;
                    if (!ext) {
                        ext = 'html'
                    }
                }

                if (
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined'
                    ||
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[eCode]) != 'undefined'
                ) {
                    hasCustomErrorFile = true;
                    var eFilename               = null
                        , eData                 = null
                    ;
                    eData = {
                        isRenderingCustomError  : true,
                        bundle                  : bundle,
                        status                  : code || null,
                        //message                 : errorObject.message || msg || null,
                        pathname                : url
                    };

                    if ( errorObject ) {
                        eData = merge(errorObject, eData);
                    }
                    // #ERRREF — the custom error template renders the same ref
                    // the JSON wire carries (idempotent when the merge above
                    // already brought errorObject.ref in).
                    eData.ref = _errRef;

                    if ( typeof(msg) == 'object' ) {
                        if ( typeof(msg.stack) != 'undefined' ) {
                            eData.stack = msg.stack
                        }
                        if ( !eData.message && typeof(msg.message) != 'undefined' ) {
                            eData.message = msg.message
                        }
                    }
                    if (
                        code
                        // See: framework/${version}/core/status.code
                        && typeof(bundleConf.server.coreConfiguration.statusCodes[code]) != 'undefined'
                    ) {
                        eData.title = bundleConf.server.coreConfiguration.statusCodes[code];
                    }
                    // TODO - Remove this if not used
                    // if ( typeof(local.req.routing) != 'undefined' ) {
                    //     eData.routing = local.req.routing;
                    // }

                    if (typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined') {
                        eFilename = bundleConf.content.templates._common.errorFiles[code];
                    } else {
                        eFilename = bundleConf.content.templates._common.errorFiles[eCode];
                    }

                    if (!local.options.isRenderingCustomError) {
                        var eRule = 'custom-error-page@'+ bundle;
                        // #B191 — dispatch on a CLONE: the shared routing
                        // entry must not carry per-error state. The stamps
                        // below (and renderCustomError's own param deletes)
                        // used to mutate `bundleConf.content.routing[eRule]`
                        // directly, racing overlapping errors on the shared
                        // object; lib/routing getRoute() already clones for
                        // the server-side twin's dispatch.
                        var routeObj = JSON.clone(bundleConf.content.routing[eRule]);
                        routeObj.rule = eRule;
                        //routeObj.url = decodeURI(local.req.url);/// avoid %20
                        routeObj.param.title = ( typeof(eData.title) != 'undefined' ) ? eData.title : 'Error ' + eData.status;
                        routeObj.param.file = eFilename;
                        routeObj.param.error = eData;
                        routeObj.param.displayInspector = self.isCacheless();
                        routeObj.param.isLocalOptionResetNeeded = true;


                        local.req.routing = routeObj;
                        local.req.params.errorObject = errorObject;
                        return self.renderCustomError(local.req, res, local.next);
                    }

                }

                // if (!errorObject) {
                //     errorObject = {
                //         status: code,
                //         //errors: msg.error || msg.errors || msg,
                //         error: standardErrorMessage || msg.error || msg,
                //         message: msg.message || msg,
                //         stack: msg.stack
                //     }
                // }
                var msgString = '<h1 class="status">Error '+ code +'.</h1>';
                // #ERRREF — the inline fallback page shows the same ref the
                // log line carries, so a viewer can relay it to support.
                msgString += '<pre class="'+ eCode +' ref">ref '+ _errRef +'</pre>';

                console.error('[ BUNDLE ][ '+ local.options.conf.bundle +' ][ Controller ] `this.'+ req.routing.param.control +'(...)` ['+res.statusCode +'] '+ req.url);
                if ( typeof(msg) == 'object' ) {

                    if (msg.title) {
                        msgString += '<pre class="'+ eCode +' title">'+ msg.title +'</pre>';
                    }

                    if (msg.error) {
                        msgString += '<pre class="'+ eCode +' message">'+ msg.error +'</pre>';
                    }

                    if (msg.message) {
                        msgString += '<pre class="'+ eCode +' message">'+ msg.message +'</pre>';
                    }

                    // Fail-closed: render the stack frame only in local scope
                    // so file paths, library versions, and internal frames don't
                    // leak via the fallback HTML error page. Symmetric to the
                    // JSON wire gate (~L5147). Custom error templates dispatched
                    // via renderCustomError at L5266-5281 are consumer-owned.
                    if (msg.stack && _isLocalScope) {

                        if (msg.error) {
                            msg.stack = msg.stack.replace(msg.error, '')
                        }

                        if (msg.message) {
                            msg.stack = msg.stack.replace(msg.message, '')
                        }

                        msg.stack = msg.stack.replace('Error:', '').replace(' ', '');
                        msgString += '<pre class="'+ eCode +' stack">'+ msg.stack +'</pre>';
                    }

                } else {
                    // Generic error
                    var title = null, message = null, stack = null;;
                    if ( errorObject && typeof(errorObject) != 'undefined' && errorObject && typeof(errorObject.error) != 'undefined' ) {
                        title = errorObject.error;
                        // replaced: direct use — errorObject.error may be a plain object forwarded
                        // from a failed query() call, causing '[object Object]' in the HTML output. (#Q1)
                        if ( title !== null && typeof(title) === 'object' ) {
                            title = title.message || title.error || JSON.stringify(title);
                        }
                    }
                    if (errorObject && typeof(errorObject) != 'undefined' && errorObject  && typeof(errorObject.message) != 'undefined' ) {
                        message = errorObject.message
                    }
                    if (errorObject && typeof(errorObject) != 'undefined' && errorObject  && typeof(errorObject.stack) != 'undefined' ) {
                        stack = errorObject.stack
                    }

                    if (title) {
                        msgString += '<pre class="'+ eCode +' title">'+ title +'</pre>';
                    }
                    if (message) {
                        msgString += '<pre class="'+ eCode +' message">'+ message +'</pre>';
                    }
                    // Fail-closed: local scope only — same gate shape as the
                    // msg-shape site above.
                    if (stack && _isLocalScope) {
                        msgString += '<pre class="'+ eCode +' stack">'+ stack +'</pre>';
                    }
                }
                res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding } );
                // if ( isHtmlContent && hasCustomErrorFile ) {
                //     res.end(msgString);
                // } else {
                //if ( isHtmlContent && !hasCustomErrorFile ) {
                    // #A11Y3 — wrap the fragment in a conforming document. The wrap is
                    // deliberately here, after the msgString construction block above, so
                    // the body markup (status + incident ref + the local-scope-gated stack)
                    // is unchanged and its characterization tests keep mirroring it.
                    res.end(a11yErrorDocument(code, msgString, req));
                //}
                // Release per-request refs — HTML error path (no custom error file). (#M1)
                local.req  = null;
                local.res  = null;
                local.next = null;

                return;
            }
        } else {
            if (typeof(next) != 'undefined')
                return next();
        }

        if ( stream && /http\/2/.test(protocol) ) {
            return stream.end();
        }

        return res.end();
    }

    // converting references to objects
    // replaced: for...in (both loops) — use Object.keys() + index (#P22)
    var refToObj = function (arr){
        var tmp = null,
            curObj = {},
            obj = {},
            count = 0,
            data = {},
            last = null;
        var arrKeys = Object.keys(arr);
        for (var ri = 0; ri < arrKeys.length; ++ri) {
            var r = arrKeys[ri];
            tmp = r.split(".");
            //Creating structure - Adding sub levels
            for (var oi = 0; oi < tmp.length; ++oi) {
                count++;
                if (last && typeof(obj[last]) == "undefined") {
                    curObj[last] = {};
                    if (count >= tmp.length) {
                        // assigning.
                        // !!! if null or undefined, it will be ignored while extending.
                        curObj[last][tmp[oi]] = (arr[r]) ? arr[r] : "undefined";
                        last = null;
                        count = 0;
                        break
                    } else {
                        curObj[last][tmp[oi]] = {}
                    }
                } else if (tmp.length === 1) { //Just one root var
                    curObj[tmp[oi]] = (arr[r]) ? arr[r] : "undefined";
                    obj = curObj;
                    break
                }
                obj = curObj;
                last = tmp[oi]
            }
            //data = merge(data, obj, true);
            data = merge(obj, data);
            obj = {};
            curObj = {}
        }
        return data
    }

    init()
};

SuperController = inherits(SuperController, EventEmitter);


/**
 * Factory for isolated test instances — **test use only** (#R4).
 *
 * Creates a fresh `SuperController` instance with its own `local` closure,
 * wires it with mock `req`/`res`/`next`/`options` via `setOptions()`, and
 * marks it with `_isTestInstance = true` so it can never be confused with the
 * production singleton.
 *
 * Each call returns an **independent** instance — internal state (req, res, …)
 * is never shared with the production singleton or other test instances.
 *
 * ### Minimal deps shape (for tests that don't render HTML)
 *
 * ```javascript
 * var inst = SuperController.createTestInstance({
 *     req: { method: 'GET', params: {}, get: {}, post: {} },
 *     res: { setHeader: function(){}, end: function(){} },
 *     next: function() {},
 *     options: {
 *         conf: { bundle: 'myBundle', content: { routing: { 'my-rule': {} } } },
 *         rule: 'my-rule',
 *         control: 'myAction'
 *         // template: omit to skip the template/environment setup block
 *     }
 * });
 * inst.myAction(inst._req, inst._res, inst._next);
 * ```
 *
 * @static
 * @param {object}   [deps]          - Dependency overrides. All keys are optional.
 * @param {object}   [deps.req]      - Mock request object
 * @param {object}   [deps.res]      - Mock response object
 * @param {function} [deps.next]     - Mock next-middleware callback
 * @param {object}   [deps.options]  - Controller options (conf, rule, control, …).
 *   Must have at least `conf.content.routing[deps.options.rule]` to avoid a crash
 *   inside `setOptions()`. Omit `template` to skip the full page/environment setup.
 * @returns {SuperController} Fresh isolated instance with its own `local` closure;
 *   no production state is read or written. Each call is fully independent. (#M1)
 */
SuperController.createTestInstance = function(deps) {
    deps = deps || {};

    var _req  = deps.req  || {};
    var _res  = deps.res  || {};
    var _next = deps.next || function() {};

    // Normalise options so setOptions() doesn't crash on missing conf structure.
    // We merge over a safe skeleton; user values take priority.
    var _opts = deps.options || {};
    if (!_opts.conf) {
        _opts.conf = {};
    }
    if (!_opts.conf.content) {
        _opts.conf.content = {};
    }
    if (!_opts.conf.content.routing) {
        _opts.conf.content.routing = {};
    }
    var _rule = _opts.rule || '_test';
    if (!_opts.conf.content.routing[_rule]) {
        _opts.conf.content.routing[_rule] = {};
    }
    if (!_opts.rule) {
        _opts.rule = _rule;
    }

    // Each new SuperController() builds its own isolated local closure via
    // `inherits` (b.apply + cache.apply on a fresh `this`). No static properties
    // are written or read. (#M1)
    var inst = new SuperController(_opts);
    inst._isTestInstance = true;

    inst.setOptions(_req, _res, _next, _opts);

    return inst;
};


module.exports = SuperController