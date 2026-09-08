/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Session plugin (#CSRF1, #COMPLY4) — hardened wrapper around `express-session`.
 *
 * Bundles adopt it with a one-line swap in their bootstrap:
 *
 *     // before
 *     // var session = require('express-session');
 *
 *     // after
 *     var session = require('gina').plugins.Session(require('express-session'));
 *
 * The wrapper reads `settings.json > session.cookie.*` and injects defaults
 * into the `options.cookie` object before express-session sees it. Bundle
 * code that sets cookie flags explicitly always wins — intentional choices
 * are preserved.
 *
 * Browser-parity invariant: `SameSite=None` without `Secure` is rejected at
 * factory call time (matching browser behaviour).
 *
 * Absolute session timeout (#COMPLY4, opt-in): `session({ absoluteTimeout:
 * <ms> })` — or the `settings.json > session.absoluteTimeout` default, bundle
 * code winning (`false` disables) — caps an AUTHENTICATED session's total
 * lifetime, measured from the `_ginaCreatedAt` anchor `req.login()` stamps at
 * rotation (manual-bind consumers are anchored lazily, one request late). An
 * over-age session is destroyed on its next request and the request proceeds
 * with a fresh anonymous one — indistinguishable from a naturally-expired
 * record. This composes with idle expiry, which already exists: the cookie
 * `maxAge` and the store record TTL both roll with activity; this cap does
 * not. Without the option the factory returns express-session's middleware
 * untouched.
 *
 * @module plugins/session
 */

var ALLOWED_SAMESITE = ['lax', 'strict', 'none'];

/**
 * Read the active bundle's `settings.json > session.cookie.*` section and
 * return the merged framework defaults.
 *
 * Falls back to safe defaults when the bundle context is not ready yet
 * (e.g. `Session()` invoked at module-require time, before
 * `onInitialize`).
 *
 * @returns {{sameSite: string, httpOnly: boolean, secure: (boolean|string)}}
 * @throws  {Error} when a setting has an unsupported value.
 * @inner
 * @private
 */
function resolveSettingsDefaults() {
    var defaults   = { sameSite: 'lax', httpOnly: true, secure: 'auto' };
    var cookieConf = {};

    var sessionConf = {};
    try {
        var ctx    = getContext();
        var bundle = ctx && ctx.bundle;
        var env    = ctx && ctx.env;
        var conf   = (typeof getConfig === 'function') ? getConfig() : null;
        if (bundle && env && conf && conf[bundle] && conf[bundle][env]) {
            var content  = conf[bundle][env].content || {};
            var settings = content.settings || {};
            sessionConf  = settings.session || {};
            cookieConf   = sessionConf.cookie || {};
        }
    } catch (ignored) {
        sessionConf = {};
        cookieConf  = {};
    }

    if (typeof cookieConf.sameSite === 'string') {
        var s = cookieConf.sameSite.toLowerCase();
        if (ALLOWED_SAMESITE.indexOf(s) < 0) {
            throw new Error(
                '[gina session] settings.json > session.cookie.sameSite must be one of '
                + ALLOWED_SAMESITE.map(function (v) { return '"' + v + '"'; }).join(', ')
                + ' — got: ' + JSON.stringify(cookieConf.sameSite)
            );
        }
        defaults.sameSite = s;
    }

    if (typeof cookieConf.httpOnly === 'boolean') {
        defaults.httpOnly = cookieConf.httpOnly;
    }

    if (typeof cookieConf.secure !== 'undefined') {
        if (cookieConf.secure !== true
            && cookieConf.secure !== false
            && cookieConf.secure !== 'auto'
        ) {
            throw new Error(
                '[gina session] settings.json > session.cookie.secure must be true, false, or "auto"'
                + ' — got: ' + JSON.stringify(cookieConf.secure)
            );
        }
        defaults.secure = cookieConf.secure;
    }

    // #COMPLY4 — absolute-timeout default (ms). Opt-in: absent means none.
    if (typeof sessionConf.absoluteTimeout !== 'undefined') {
        if (typeof sessionConf.absoluteTimeout !== 'number'
            || !isFinite(sessionConf.absoluteTimeout)
            || sessionConf.absoluteTimeout <= 0
        ) {
            throw new Error(
                '[gina session] settings.json > session.absoluteTimeout must be a positive number of milliseconds'
                + ' — got: ' + JSON.stringify(sessionConf.absoluteTimeout)
            );
        }
        defaults.absoluteTimeout = sessionConf.absoluteTimeout;
    }

    return defaults;
}

/**
 * Resolve the effective absolute-timeout value: the bundle option wins over
 * the settings default; `false` / `null` in bundle code disables it outright.
 * The gina-only key is STRIPPED from the options so express-session never
 * sees it.
 *
 * @param   {object} options  - the (mutated) session factory options
 * @param   {object} defaults - `resolveSettingsDefaults()` output
 * @returns {(number|null)}     effective cap in ms, or null when disabled
 * @throws  {Error} when the bundle-supplied value is not a positive number
 * @inner
 * @private
 */
function resolveAbsoluteTimeout(options, defaults) {
    if (Object.prototype.hasOwnProperty.call(options, 'absoluteTimeout')) {
        var v = options.absoluteTimeout;
        delete options.absoluteTimeout;
        if (v === false || v === null) {
            return null;
        }
        if (typeof v !== 'number' || !isFinite(v) || v <= 0) {
            throw new Error(
                '[gina session] absoluteTimeout must be a positive number of milliseconds'
                + ' (or false to disable the settings default) — got: ' + JSON.stringify(v)
            );
        }
        return v;
    }
    return (typeof defaults.absoluteTimeout === 'number') ? defaults.absoluteTimeout : null;
}

/**
 * Wrap the express-session middleware with the absolute-timeout enforcement
 * (#COMPLY4).
 *
 * After the session loads: an authenticated session without a numeric
 * `_ginaCreatedAt` anchor is stamped (manual-bind consumers — `req.login()`
 * stamps it at rotation itself; anonymous sessions are never touched, so
 * `saveUninitialized: false` semantics are preserved). A session whose anchor
 * is older than the cap is destroyed via its own `regenerate()` — the request
 * proceeds with a fresh anonymous session, exactly as a naturally-expired
 * record behaves. Fail-closed: when the record cannot be destroyed
 * (regenerate error, or no regenerate on the provider) the authentication is
 * dropped locally at minimum.
 *
 * @param   {function} mw         - the middleware express-session returned
 * @param   {number}   absoluteMs - the effective cap in milliseconds
 * @returns {function}              wrapping middleware `(req, res, next)`
 * @inner
 * @private
 */
function makeAbsoluteTimeoutMiddleware(mw, absoluteMs) {
    return function ginaSessionAbsoluteTimeout(req, res, next) {
        mw(req, res, function onSessionReady(err) {
            if (err) {
                return next(err);
            }
            var sess = req.session;
            if (!sess || typeof sess !== 'object') {
                return next();
            }
            if (sess.user && typeof sess._ginaCreatedAt !== 'number') {
                // authenticated without an anchor (manual bind, or a corrupt
                // anchor) — stamp now; enforcement starts from here
                sess._ginaCreatedAt = Date.now();
                return next();
            }
            if (typeof sess._ginaCreatedAt === 'number'
                && (Date.now() - sess._ginaCreatedAt) > absoluteMs
            ) {
                if (typeof sess.regenerate === 'function') {
                    return sess.regenerate(function onAbsoluteTimeoutExpired(regenErr) {
                        if (regenErr && req.session && typeof req.session === 'object') {
                            // fail-closed: the record could not be destroyed —
                            // drop the authentication locally at minimum
                            req.session.user = null;
                            delete req.session._ginaCreatedAt;
                        }
                        next();
                    });
                }
                // no regenerate() on this provider: fail-closed locally,
                // destroying the record when the provider allows it
                sess.user = null;
                delete sess._ginaCreatedAt;
                if (typeof sess.destroy === 'function') {
                    return sess.destroy(function onAbsoluteTimeoutDestroyed() { next(); });
                }
                return next();
            }
            next();
        });
    };
}

/**
 * Merge caller-supplied cookie options on top of the resolved defaults.
 * Caller-supplied values always win — `httpOnly: false` passed by a bundle
 * stays `false` even when the default is `true`.
 *
 * @param {object|undefined} caller
 * @param {object}           defaults
 * @returns {object}
 * @inner
 * @private
 */
function mergeCookie(caller, defaults) {
    caller = caller || {};
    var merged = {};
    if (!Object.prototype.hasOwnProperty.call(caller, 'sameSite')) merged.sameSite = defaults.sameSite;
    if (!Object.prototype.hasOwnProperty.call(caller, 'httpOnly')) merged.httpOnly = defaults.httpOnly;
    if (!Object.prototype.hasOwnProperty.call(caller, 'secure'))   merged.secure   = defaults.secure;
    for (var key in caller) {
        if (Object.prototype.hasOwnProperty.call(caller, key)) merged[key] = caller[key];
    }
    return merged;
}

/**
 * Browser-parity invariant: a cookie carrying `SameSite=None` must also
 * carry `Secure`, or the browser discards it.
 *
 * @param {object} cookie — the merged options object
 * @throws {Error}
 * @inner
 * @private
 */
function assertInvariant(cookie) {
    var sameSite = (typeof cookie.sameSite === 'string')
        ? cookie.sameSite.toLowerCase()
        : cookie.sameSite;
    if (sameSite === 'none' && cookie.secure !== true) {
        throw new Error(
            '[gina session] invariant violation: SameSite=None cookies require Secure=true (browser-parity).'
            + ' Set cookie.secure=true or settings.json > session.cookie.secure=true.'
            + ' Current: sameSite=' + JSON.stringify(cookie.sameSite)
            + ', secure=' + JSON.stringify(cookie.secure)
        );
    }
}

/**
 * Wrap an `express-session` module reference and return a drop-in
 * replacement that injects cookie defaults.
 *
 * @example
 * var session = require('gina').plugins.Session(require('express-session'));
 * app.use(session({ name: 'sessionid', cookie: { maxAge: 86400000 } }));
 *
 * @param   {function} expressSession — the value returned by `require('express-session')`
 * @returns {function}                  — drop-in replacement for the session factory
 * @throws  {Error} when the first argument is not a function
 */
function Session(expressSession) {
    if (typeof expressSession !== 'function') {
        throw new Error(
            '[gina session] expected the express-session module as the first argument.'
            + ' Usage: require("gina").plugins.Session(require("express-session"))'
        );
    }

    function ginaSessionDispatch(options) {
        options = options || {};
        var defaults = resolveSettingsDefaults();
        options.cookie = mergeCookie(options.cookie, defaults);
        assertInvariant(options.cookie);
        // #COMPLY4 — resolve (and strip) the absolute-timeout cap before
        // express-session sees the options; no cap means the raw middleware
        // is returned untouched.
        var absoluteMs = resolveAbsoluteTimeout(options, defaults);
        var mw = expressSession(options);
        if (!absoluteMs) {
            return mw;
        }
        return makeAbsoluteTimeoutMiddleware(mw, absoluteMs);
    }

    var wrapped = function (options) { return ginaSessionDispatch(options); };

    // Drop-in identity: introspection (`session.name`) returns the upstream
    // identity (`'session'`), while gina stays visible in stack traces via
    // the inner `ginaSessionDispatch` frame. Without this, bundles that sniff
    // `session.name === 'session'` would see `'ginaSession'`
    // — the wrapper was clobbering the upstream identity.
    Object.defineProperty(wrapped, 'name', {
        value: expressSession.name,
        configurable: true
    });

    // Preserve express-session's static surface (.Store, .MemoryStore,
    // .Session, .Cookie). Consumers do `var MemoryStore = session.MemoryStore`
    // and similar, and those must keep working.
    for (var k in expressSession) {
        if (Object.prototype.hasOwnProperty.call(expressSession, k)) {
            wrapped[k] = expressSession[k];
        }
    }

    return wrapped;
}

// Exposed for unit testing. Do not rely on these in application code — they
// may change without notice.
Session._resolveSettingsDefaults        = resolveSettingsDefaults;
Session._mergeCookie                    = mergeCookie;
Session._assertInvariant                = assertInvariant;
Session._ALLOWED_SAMESITE               = ALLOWED_SAMESITE;
Session._resolveAbsoluteTimeout         = resolveAbsoluteTimeout;
Session._makeAbsoluteTimeoutMiddleware  = makeAbsoluteTimeoutMiddleware;

module.exports = Session;
