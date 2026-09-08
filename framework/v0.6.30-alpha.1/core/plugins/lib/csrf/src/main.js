/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Csrf plugin (#CSRF2 / #CSRF3) — signed double-submit token middleware
 * with an Origin/Referer pre-filter.
 *
 * Stateless CSRF defense aligned with OWASP ASVS 4.0 V4.2.1. On mutating
 * methods (POST/PUT/PATCH/DELETE) the middleware now layers two checks:
 *
 *   1. #CSRF3 — Origin/Referer pre-filter. Reads `Origin` first, falls
 *      back to parsing the host out of `Referer`. Both missing → 403.
 *      Mismatch against `csrf.allowedOrigins` → 403. Belt-and-suspenders
 *      that catches edge cases tokens might miss (referrer-header log
 *      leaks, legacy browser bugs, misconfigured reverse proxies).
 *   2. #CSRF2 — signed double-submit token verify. Token shape:
 *
 *          <nonce_b64url>.<mac_b64url>
 *          mac = HMAC-SHA256(sessionId + ':' + nonce_b64url, GINA_CSRF_SECRET)
 *
 * Safe methods (GET/HEAD/OPTIONS) issue a fresh token cookie and pass
 * through. Per-route opt-out via `routing.json > "csrfExempt": true`
 * bypasses both layers (consistent across token + Origin checks).
 *
 * Bundles adopt the plugin with two lines in their bootstrap, AFTER the
 * session middleware:
 *
 *     var csrf = require('gina').plugins.Csrf();
 *     app.use(session({...}));   // must register session FIRST
 *     app.use(csrf);
 *
 * @module plugins/csrf
 */

var crypto = require('crypto');

var ALLOWED_ROTATE = ['per-session', 'per-request'];

var DEFAULT_COOKIE_NAME  = 'gina-csrf-token';
var DEFAULT_HEADER_NAME  = 'X-Gina-CSRF-Token';
var DEFAULT_FIELD_NAME   = '_csrf';
var DEFAULT_ROTATE       = 'per-session';
var DEFAULT_SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

var NONCE_BYTES = 16;
var MAC_BYTES   = 32;

/**
 * Read the active bundle's `settings.json > csrf.*` section and return
 * the merged framework defaults.
 *
 * @returns {{cookieName: string, headerName: string, fieldName: string,
 *            rotate: string, safeMethods: string[],
 *            allowedOrigins: string[]|null}}
 * @throws  {Error} when a setting has an unsupported value.
 * @inner
 * @private
 */
function resolveSettingsDefaults() {
    var defaults = {
        secret:         null,
        cookieName:     DEFAULT_COOKIE_NAME,
        headerName:     DEFAULT_HEADER_NAME,
        fieldName:      DEFAULT_FIELD_NAME,
        rotate:         DEFAULT_ROTATE,
        safeMethods:    DEFAULT_SAFE_METHODS.slice(),
        allowedOrigins: null
    };
    var csrfConf = {};

    try {
        var ctx    = getContext();
        var bundle = ctx && ctx.bundle;
        var env    = ctx && ctx.env;
        var conf   = (typeof getConfig === 'function') ? getConfig() : null;
        if (bundle && env && conf && conf[bundle] && conf[bundle][env]) {
            var content  = conf[bundle][env].content || {};
            var settings = content.settings || {};
            csrfConf     = settings.csrf || {};
        }
    } catch (ignored) {
        csrfConf = {};
    }

    // `settings.csrf.secret` flows through `lib/secrets` at config-load
    // time — a `${secret:KEY}` placeholder is already resolved by the
    // time we read it here.
    if (typeof csrfConf.secret === 'string' && csrfConf.secret) {
        defaults.secret = csrfConf.secret;
    }
    if (typeof csrfConf.cookieName === 'string' && csrfConf.cookieName) {
        defaults.cookieName = csrfConf.cookieName;
    }
    if (typeof csrfConf.headerName === 'string' && csrfConf.headerName) {
        defaults.headerName = csrfConf.headerName;
    }
    if (typeof csrfConf.fieldName === 'string' && csrfConf.fieldName) {
        defaults.fieldName = csrfConf.fieldName;
    }
    if (typeof csrfConf.rotate === 'string') {
        if (ALLOWED_ROTATE.indexOf(csrfConf.rotate) < 0) {
            throw new Error(
                '[gina csrf] settings.json > csrf.rotate must be one of '
                + ALLOWED_ROTATE.map(function (v) { return '"' + v + '"'; }).join(', ')
                + ' — got: ' + JSON.stringify(csrfConf.rotate)
            );
        }
        defaults.rotate = csrfConf.rotate;
    }
    if (Array.isArray(csrfConf.safeMethods)) {
        defaults.safeMethods = csrfConf.safeMethods.map(function (m) {
            return String(m).toUpperCase();
        });
    }
    if (Array.isArray(csrfConf.allowedOrigins)) {
        defaults.allowedOrigins = csrfConf.allowedOrigins
            .filter(function (o) { return typeof o === 'string' && o; })
            .map(function (o) { return o.toLowerCase(); });
    }

    return defaults;
}

/**
 * Extract `scheme://host[:port]` from a URL-like string. Returns `null`
 * for `"null"` (sandboxed-iframe sentinel), empty input, or anything
 * that doesn't have a parseable scheme + authority.
 *
 * @param   {string} s
 * @returns {string|null}
 * @inner
 * @private
 */
function parseOriginString(s) {
    if (typeof s !== 'string' || !s) return null;
    if (s === 'null') return null; // browsers send literal "null" for sandboxed iframes
    var m = /^([a-z][a-z0-9+.\-]*):\/\/([^\/?#]+)/i.exec(s);
    if (!m) return null;
    return (m[1] + '://' + m[2]).toLowerCase();
}

/**
 * Best-effort detection of the origin a request was issued from. Reads
 * `Origin` first; falls back to parsing the host out of `Referer` when
 * `Origin` is missing (rare — some same-origin legacy browsers strip
 * `Origin` on safe-then-mutating sequences).
 *
 * @param   {object} req
 * @returns {string|null}    `"scheme://host[:port]"` or null
 * @inner
 * @private
 */
function parseRequestOrigin(req) {
    if (!req || !req.headers) return null;
    var origin = parseOriginString(req.headers.origin);
    if (origin) return origin;
    var referer = req.headers.referer || req.headers.referrer;
    return parseOriginString(referer);
}

/**
 * Resolve the bundle's configured origin from the active runtime
 * configuration. Tries `conf[bundle][env].hostname` first (a full URL
 * the framework resolves at startup), then composes one from
 * `server.scheme + '://' + host + ':' + server.port`. Returns `null`
 * when neither shape is present (e.g. test stub without a host).
 *
 * @returns {string|null}
 * @inner
 * @private
 */
function resolveBundleHostname() {
    try {
        var ctx    = getContext();
        var bundle = ctx && ctx.bundle;
        var env    = ctx && ctx.env;
        var conf   = (typeof getConfig === 'function') ? getConfig() : null;
        if (!bundle || !env || !conf || !conf[bundle] || !conf[bundle][env]) {
            return null;
        }
        var bc = conf[bundle][env];
        if (typeof bc.hostname === 'string' && bc.hostname) {
            return parseOriginString(bc.hostname) || bc.hostname.toLowerCase();
        }
        if (bc.server
            && typeof bc.server.scheme === 'string' && bc.server.scheme
            && typeof bc.host          === 'string' && bc.host
            && (bc.server.port || bc.server.port === 0)) {
            return (bc.server.scheme + '://' + bc.host + ':' + bc.server.port).toLowerCase();
        }
    } catch (ignored) {
        return null;
    }
    return null;
}

/**
 * Compute the allowlist for the Origin pre-filter. Precedence:
 *   1. `opts.allowedOrigins` (factory override, test harness)
 *   2. `settings.json > csrf.allowedOrigins`
 *   3. `[ resolveBundleHostname() ]` — the bundle's configured origin
 *
 * Returns an array of lowercase `scheme://host[:port]` strings. Throws
 * at factory time when the resolved list ends up empty — that means
 * neither the user nor the framework could supply a hostname, and
 * letting the middleware run would 403 every mutating request.
 *
 * @param   {string[]|null} fromOpts      — `opts.allowedOrigins`
 * @param   {string[]|null} fromSettings  — `settings.csrf.allowedOrigins`
 * @returns {string[]}
 * @throws  {Error} when no origin can be resolved.
 * @inner
 * @private
 */
function resolveAllowedOrigins(fromOpts, fromSettings) {
    var list = null;
    if (Array.isArray(fromOpts) && fromOpts.length > 0) {
        list = fromOpts;
    } else if (Array.isArray(fromSettings) && fromSettings.length > 0) {
        list = fromSettings;
    } else {
        var bundleHost = resolveBundleHostname();
        list = bundleHost ? [bundleHost] : [];
    }

    list = list
        .filter(function (o) { return typeof o === 'string' && o; })
        .map(function (o) {
            var parsed = parseOriginString(o);
            return parsed || o.toLowerCase();
        });

    if (list.length === 0) {
        throw new Error(
            '[gina csrf] csrf.allowedOrigins is empty and the bundle hostname could not be'
            + ' resolved from getConfig(). Set settings.json > csrf.allowedOrigins'
            + ' (e.g. ["https://example.com"]) or pass {allowedOrigins:[...]} to Csrf().'
        );
    }
    return list;
}

/**
 * 16 cryptographically secure random bytes.
 *
 * @returns {Buffer}
 * @inner
 * @private
 */
function generateNonce() {
    var bytes = new Uint8Array(NONCE_BYTES);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes);
}

/**
 * Build a `<nonce_b64url>.<mac_b64url>` token bound to the given session
 * id. The MAC commits to the b64url-encoded nonce (not the raw bytes)
 * so the verify path doesn't need to round-trip through Buffer.
 *
 * @param   {string} sessionId — the value `req.session.id` returns
 * @param   {string} secret    — `GINA_CSRF_SECRET` (>= 32 bytes recommended)
 * @returns {string}            — e.g. `"abc...xyz.def...uvw"`
 * @inner
 * @private
 */
function generateToken(sessionId, secret) {
    var nonceBuf = generateNonce();
    var nonceB64 = nonceBuf.toString('base64url');
    var mac = crypto.createHmac('sha256', secret)
                    .update(sessionId + ':' + nonceB64)
                    .digest();
    return nonceB64 + '.' + mac.toString('base64url');
}

/**
 * Constant-time verify of a presented token. Returns `false` on any
 * structural problem (wrong shape, truncated halves, invalid base64url,
 * length mismatch) — the only `true` path is a successful HMAC equality.
 *
 * @param   {string} token     — value from cookie / header / form field
 * @param   {string} sessionId — `req.session.id`
 * @param   {string} secret    — `GINA_CSRF_SECRET`
 * @returns {boolean}
 * @inner
 * @private
 */
function verifyToken(token, sessionId, secret) {
    if (typeof token !== 'string' || !token) return false;
    if (typeof sessionId !== 'string' || !sessionId) return false;
    if (typeof secret !== 'string' || !secret) return false;

    var dot = token.indexOf('.');
    if (dot < 1 || dot !== token.lastIndexOf('.')) return false;

    var nonceB64 = token.substring(0, dot);
    var macB64   = token.substring(dot + 1);
    if (!nonceB64 || !macB64) return false;

    var nonceBuf, presentedMac;
    try {
        nonceBuf     = Buffer.from(nonceB64, 'base64url');
        presentedMac = Buffer.from(macB64,   'base64url');
    } catch (e) {
        return false;
    }
    if (nonceBuf.length !== NONCE_BYTES) return false;

    var expectedMac = crypto.createHmac('sha256', secret)
                            .update(sessionId + ':' + nonceB64)
                            .digest();
    if (presentedMac.length !== expectedMac.length) return false;

    try { return crypto.timingSafeEqual(presentedMac, expectedMac); }
    catch (e) { return false; }
}

/**
 * Read a single cookie value out of `req.headers.cookie`.
 *
 * @inner
 * @private
 */
function readCookie(req, name) {
    var raw = req && req.headers && req.headers.cookie;
    if (!raw) return null;
    var parts = String(raw).split(';');
    for (var i = 0; i < parts.length; i++) {
        var p  = parts[i].trim();
        var eq = p.indexOf('=');
        if (eq < 0) continue;
        if (p.substring(0, eq).trim() === name) {
            try { return decodeURIComponent(p.substring(eq + 1).trim()); }
            catch (e) { return p.substring(eq + 1).trim(); }
        }
    }
    return null;
}

/**
 * Append a Set-Cookie line, preserving any cookie set earlier in the
 * pipeline.
 *
 * @inner
 * @private
 */
function appendSetCookie(res, name, value, secure) {
    var parts = [
        name + '=' + encodeURIComponent(value),
        'Path=/',
        'SameSite=Lax'
    ];
    if (secure) parts.push('Secure');
    var line = parts.join('; ');

    var existing = (typeof res.getHeader === 'function') ? res.getHeader('Set-Cookie') : null;
    if (existing) {
        var arr = Array.isArray(existing) ? existing.slice() : [existing];
        arr.push(line);
        res.setHeader('Set-Cookie', arr);
    } else {
        res.setHeader('Set-Cookie', line);
    }
}

/**
 * Best-effort detection of whether the active request travelled over
 * TLS. `Secure` is auto-injected when the answer is yes.
 *
 * @inner
 * @private
 */
function isSecureRequest(req) {
    if (!req) return false;
    if (req.secure === true) return true;
    if (req.connection && req.connection.encrypted) return true;
    if (req.socket && req.socket.encrypted) return true;
    var proto = req.headers && req.headers['x-forwarded-proto'];
    if (typeof proto === 'string' && /^https$/i.test(proto.split(',')[0].trim())) return true;
    return false;
}

/**
 * Pull the presented token from request headers first, then from a
 * parsed body field (`req.body`, `req.post`, `req.put`, `req.patch`,
 * `req.delete`).
 *
 * @inner
 * @private
 */
function readPresentedToken(req, headerNameLower, fieldName) {
    if (req && req.headers && typeof req.headers[headerNameLower] === 'string') {
        return req.headers[headerNameLower];
    }
    var sources = [req.body, req.post, req.put, req.patch, req['delete']];
    for (var i = 0; i < sources.length; i++) {
        var b = sources[i];
        if (b && typeof b === 'object' && typeof b[fieldName] === 'string' && b[fieldName]) {
            return b[fieldName];
        }
    }
    return null;
}

/**
 * Reject a mutating request with 403 Forbidden and log the reason.
 *
 * @inner
 * @private
 */
function reject(req, res, reason) {
    console.error('[csrf] forbidden — ' + reason + ' on ' + (req.method || '?') + ' ' + (req.url || '?'));
    res.statusCode = 403;
    if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }
    res.end('Forbidden');
}

var SESSIONLESS_MESSAGE =
    '[csrf] no req.session.id - Csrf plugin requires the Session plugin to be registered before it.'
    + ' If your bundle uses Bearer-token auth (cookies disabled), remove the Csrf plugin'
    + ' - CSRF doesn\'t apply to non-cookie authentication.';

/**
 * Build the CSRF middleware. The factory reads the HMAC secret at call
 * time from a three-step chain and refuses to proceed if all three are
 * missing — no dev fallback. Precedence:
 *
 *   1. `opts.secret` — factory override (test harness only).
 *   2. `settings.json > csrf.secret` — resolver-compatible config slot.
 *      `${secret:KEY}` placeholders are filled by `lib/secrets` at
 *      config-load time (framework environment first, then the raw
 *      process environment), so this slot lets consumers name the env
 *      var anything they like.
 *   3. `GINA_CSRF_SECRET` — back-compat env read, through the framework
 *      env reader first, then the raw process environment (#B156 class:
 *      the CLI sweep empties process.env of GINA_* keys). Always
 *      honoured when set, regardless of (2).
 *
 * @example
 *   // settings.json — recommended shape:
 *   // { "csrf": { "secret": "${secret:MY_CSRF_KEY}" } }
 *   // then set process.env.MY_CSRF_KEY at deploy time.
 *   var csrf = require('gina').plugins.Csrf();
 *   app.use(session({ secret: self.getConfig('session').secret }));
 *   app.use(csrf);
 *
 * @example
 *   // routing.json — webhook receiver opts out:
 *   "stripe-webhook": {
 *     "url": "/webhooks/stripe",
 *     "method": "POST",
 *     "csrfExempt": true,
 *     "param": { "control": "@webhook:stripe", "file": "stripe.js" }
 *   }
 *
 * @param   {object} [opts]
 * @param   {string} [opts.secret]      — overrides settings.csrf.secret and GINA_CSRF_SECRET (test harness)
 * @param   {string} [opts.cookieName]
 * @param   {string} [opts.headerName]
 * @param   {string} [opts.fieldName]
 * @param   {string} [opts.rotate]      — `"per-session"` (default) or `"per-request"`
 * @param   {string[]} [opts.safeMethods]
 * @param   {string[]} [opts.allowedOrigins] — #CSRF3 allowlist of origins that may
 *                                             issue mutating requests. Defaults to
 *                                             `settings.json > csrf.allowedOrigins`,
 *                                             which itself defaults to the bundle's
 *                                             configured hostname.
 * @returns {function}                  — Express-compatible middleware `(req, res, next)`
 * @throws  {Error} when no secret is resolvable from any of the three sources,
 *                  or no origin can be resolved.
 */
function Csrf(opts) {
    opts = opts || {};

    var defaults = resolveSettingsDefaults();

    var secret = (typeof opts.secret === 'string' && opts.secret)
                 ? opts.secret
                 : (typeof defaults.secret === 'string' && defaults.secret)
                   ? defaults.secret
                   : ( (typeof getEnvVar === 'function' && getEnvVar('GINA_CSRF_SECRET'))
                       || process.env.GINA_CSRF_SECRET );
    if (typeof secret !== 'string' || !secret) {
        throw new Error(
            '[gina csrf] GINA_CSRF_SECRET env var is required'
            + ' (or set settings.json > csrf.secret — supports ${secret:KEY} placeholders).'
            + ' Generate once: openssl rand -base64 64.'
            + ' Place in your bundle\'s env.json or your shell profile.'
        );
    }

    var cookieName  = (typeof opts.cookieName === 'string' && opts.cookieName) ? opts.cookieName : defaults.cookieName;
    var headerName  = (typeof opts.headerName === 'string' && opts.headerName) ? opts.headerName : defaults.headerName;
    var fieldName   = (typeof opts.fieldName  === 'string' && opts.fieldName)  ? opts.fieldName  : defaults.fieldName;
    var rotate      = (typeof opts.rotate     === 'string' && opts.rotate)     ? opts.rotate     : defaults.rotate;
    if (ALLOWED_ROTATE.indexOf(rotate) < 0) {
        throw new Error(
            '[gina csrf] rotate must be one of '
            + ALLOWED_ROTATE.map(function (v) { return '"' + v + '"'; }).join(', ')
            + ' — got: ' + JSON.stringify(rotate)
        );
    }
    var safeMethods = Array.isArray(opts.safeMethods)
                      ? opts.safeMethods.map(function (m) { return String(m).toUpperCase(); })
                      : defaults.safeMethods;

    // #CSRF3 — Origin/Referer allowlist. Resolved once at factory time;
    // throws if no usable origin can be resolved.
    var allowedOrigins = resolveAllowedOrigins(opts.allowedOrigins, defaults.allowedOrigins);

    var headerNameLower = headerName.toLowerCase();

    return function ginaCsrf(req, res, next) {
        if (!req || !req.session) {
            return next(new Error(SESSIONLESS_MESSAGE));
        }

        var sessionId = req.session.id;
        var method    = (req.method || 'GET').toUpperCase();
        var isSafe    = safeMethods.indexOf(method) > -1;
        var isExempt  = !!(req.routing && req.routing.csrfExempt);

        if (typeof sessionId !== 'string' || !sessionId) {
            if (!isSafe && !isExempt) {
                return next(new Error(SESSIONLESS_MESSAGE));
            }
            return next();
        }

        if (isSafe) {
            var existing  = readCookie(req, cookieName);
            var needIssue = (rotate === 'per-request')
                            || !existing
                            || !verifyToken(existing, sessionId, secret);
            var token     = needIssue ? generateToken(sessionId, secret) : existing;
            if (needIssue) {
                appendSetCookie(res, cookieName, token, isSecureRequest(req));
            }
            req.csrfToken = token;
            return next();
        }

        if (isExempt) {
            return next();
        }

        // #CSRF3 — Origin/Referer pre-filter. Layered ON TOP of the token
        // check below: a forged token with a matching cookie still gets
        // rejected here when the request didn't come from an allowed origin.
        var requestOrigin = parseRequestOrigin(req);
        if (!requestOrigin) {
            return reject(req, res, 'missing origin/referer');
        }
        if (allowedOrigins.indexOf(requestOrigin) < 0) {
            return reject(req, res, 'origin not allowed');
        }

        var presented = readPresentedToken(req, headerNameLower, fieldName);
        var cookie    = readCookie(req, cookieName);

        if (!presented || !cookie) {
            return reject(req, res, 'missing token');
        }
        if (presented.length !== cookie.length) {
            return reject(req, res, 'token/cookie length mismatch');
        }
        var presentedBuf = Buffer.from(presented, 'utf8');
        var cookieBuf    = Buffer.from(cookie,    'utf8');
        var pairOk;
        try { pairOk = crypto.timingSafeEqual(presentedBuf, cookieBuf); }
        catch (e) { pairOk = false; }
        if (!pairOk) {
            return reject(req, res, 'token/cookie mismatch');
        }

        if (!verifyToken(presented, sessionId, secret)) {
            return reject(req, res, 'invalid token');
        }

        req.csrfToken = presented;
        return next();
    };
}

// Exposed for unit testing. Do not rely on these in application code —
// they may change without notice.
Csrf._resolveSettingsDefaults = resolveSettingsDefaults;
Csrf._generateToken           = generateToken;
Csrf._verifyToken             = verifyToken;
Csrf._readCookie              = readCookie;
Csrf._appendSetCookie         = appendSetCookie;
Csrf._isSecureRequest         = isSecureRequest;
Csrf._readPresentedToken      = readPresentedToken;
Csrf._parseOriginString       = parseOriginString;       // #CSRF3
Csrf._parseRequestOrigin      = parseRequestOrigin;      // #CSRF3
Csrf._resolveBundleHostname   = resolveBundleHostname;   // #CSRF3
Csrf._resolveAllowedOrigins   = resolveAllowedOrigins;   // #CSRF3
Csrf._ALLOWED_ROTATE          = ALLOWED_ROTATE;
Csrf._SESSIONLESS_MESSAGE     = SESSIONLESS_MESSAGE;
Csrf._NONCE_BYTES             = NONCE_BYTES;
Csrf._MAC_BYTES               = MAC_BYTES;

module.exports = Csrf;
