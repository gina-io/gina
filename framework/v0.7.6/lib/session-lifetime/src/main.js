/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

var duration = require('../../duration');

/**
 * @module lib/session-lifetime
 * @description Per-bundle login session cookie lifetimes, declared in a bundle's
 * `security.json` and applied by the framework at `req.login()`.
 *
 * Two keys are read, both optional, both unit-suffixed duration strings parsed by
 * `lib/duration` (`"15m"`, `"3h"`, `"15d"` — the unit is required):
 *
 * - `session.expires`  — the lifetime of an ordinary login.
 * - `session.remember` — the lifetime of a login that asked to be remembered.
 *
 * A login is "remembered" when the caller passes `{ remember: true }` as the
 * login options, or when the login request carries a truthy `remember` field.
 * The option wins over the field, so an application that decides server-side is
 * never overridden by the client.
 *
 * ## What this module deliberately does not do
 *
 * It sets `req.session.cookie.maxAge` and nothing else. It does not own the
 * session, does not persist a flag of its own (express-session already records
 * `originalMaxAge` and restores it on `touch()`), and it never runs unless a
 * bundle declares one of the two keys — `fromConfig()` returns `null` for every
 * bundle that does not, and the router's band is skipped entirely on `null`.
 *
 * Anything the application does afterwards still wins: a `req.session.cookie.maxAge`
 * assigned inside the login callback runs later and overwrites this, an absolute
 * session timeout still applies, and a session store's own `ttl` still governs the
 * server-side record independently of the cookie.
 *
 * ## Why a bad value is a warning, not a boot failure
 *
 * These two keys were documented but uninterpreted before this release, so a value
 * already sitting in one was never a statement about this contract — applications
 * have their own conventions there. Refusing to boot on such a value would turn an
 * upgrade into an outage for a key that did nothing yesterday. An unparseable or
 * non-positive value is therefore warned (naming bundle, environment and key) and
 * treated as undeclared, which leaves the cookie exactly as the session factory
 * made it: the behaviour that bundle already had. Same disposition as the i18n
 * catalog loader for the same reason.
 */

/**
 * Request field names accepted as the "remember me" signal.
 *
 * @inner
 * @constant
 * @type {string}
 */
var FIELD = 'remember';

/**
 * Field values that mean "remember this login". Compared lower-cased and
 * trimmed; anything else — including absent — means no.
 *
 * @inner
 * @constant
 * @type {Array.<string>}
 */
var TRUTHY = ['1', 'true', 'on', 'yes'];

/**
 * Parse one declared duration key into milliseconds.
 *
 * @inner
 * @param {*}      value  - The raw value as declared in `security.json`.
 * @param {string} key    - `'expires'` or `'remember'`, for the warning text.
 * @param {string} bundle - Bundle name, for the warning text.
 * @param {string} env    - Environment name, for the warning text.
 * @returns {number|null} Milliseconds, or `null` when absent or unusable.
 */
function readDuration(value, key, bundle, env) {
    if ( typeof(value) == 'undefined' || value === null || value === '' ) {
        return null;
    }
    var ms = duration.parse(value);
    if ( isNaN(ms) || ms <= 0 ) {
        console.warn(
            '[ ' + bundle + ' ][ ' + env + ' ] security.json > session.' + key
            + ' is not a positive duration string ("30m", "3h", "15d" — the unit is required)'
            + ' — ignoring it, this bundle keeps its existing cookie lifetime. Got: '
            + JSON.stringify(value)
        );
        return null;
    }
    return ms;
}

/**
 * Derive a bundle's login lifetime policy from its resolved `security.json`.
 *
 * Called once per bundle at boot. Returns `null` — not an empty policy — when
 * neither key is declared, so that the per-request band can be skipped with a
 * single falsy check and bundles that never opted in pay nothing.
 *
 * Never throws: an unusable value is warned and treated as undeclared.
 *
 * @memberof module:lib/session-lifetime
 * @param {object} security - The bundle's resolved `security.json` content.
 * @param {string} bundle   - Bundle name, used in warnings.
 * @param {string} env      - Environment name, used in warnings.
 * @returns {object|null} Frozen `{ expires, remember }` in milliseconds (either may
 *                        be `null`), or `null` when the bundle declares neither.
 * @example
 * fromConfig({ session: { expires: '3h', remember: '15d' } }, 'api', 'prod');
 * // => { expires: 10800000, remember: 1296000000 }
 *
 * fromConfig({ session: { expires: '15m' } }, 'api', 'prod');
 * // => { expires: 900000, remember: null }
 *
 * fromConfig({}, 'api', 'prod');                  // => null (nothing declared)
 * fromConfig({ session: { expires: '3 days' } }, 'api', 'prod');
 * // => null, after a warning naming api/prod/expires
 */
function fromConfig(security, bundle, env) {
    if ( !security || typeof(security) != 'object' ) {
        return null;
    }
    var session = security.session;
    if ( typeof(session) == 'undefined' || session === null ) {
        return null;
    }
    if ( typeof(session) != 'object' || Array.isArray(session) ) {
        console.warn(
            '[ ' + bundle + ' ][ ' + env + ' ] security.json > session is not an object'
            + ' — no login cookie lifetime will be applied for this bundle'
        );
        return null;
    }

    var expires  = readDuration(session.expires, 'expires', bundle, env);
    var remember = readDuration(session.remember, 'remember', bundle, env);

    if ( expires === null && remember === null ) {
        return null;
    }
    return Object.freeze({ expires: expires, remember: remember });
}

/**
 * Coerce a raw request field value to a remember-me boolean.
 *
 * Accepts the shapes an HTML checkbox, a JSON body and a query string actually
 * produce. Everything else — including `"false"`, `"0"`, `0` and absent — is no.
 *
 * @memberof module:lib/session-lifetime
 * @param {*} value - The raw field value.
 * @returns {boolean} `true` when the value means "remember me".
 * @example
 * coerceField('on');     // => true  (an unstyled HTML checkbox)
 * coerceField(true);     // => true
 * coerceField('True');   // => true  (case-insensitive)
 * coerceField('false');  // => false
 * coerceField(undefined);// => false
 */
function coerceField(value) {
    if ( typeof(value) == 'boolean' ) { return value; }
    if ( typeof(value) == 'number' )  { return value === 1; }
    if ( typeof(value) != 'string' )  { return false; }
    return TRUTHY.indexOf(value.trim().toLowerCase()) > -1;
}

/**
 * Read the remember-me field off a request.
 *
 * `req.post` is consulted first because it is the framework's normalised payload
 * and already carries urlencoded form fields, JSON bodies and multipart text
 * fields alike; `req.body` is the fallback for a request that was parsed by
 * something else.
 *
 * @memberof module:lib/session-lifetime
 * @param {object} req - The request.
 * @returns {*} The raw field value, or `undefined` when the request carries none.
 * @example
 * readField({ post: { remember: 'on' } });   // => 'on'
 * readField({ body: { remember: true } });   // => true
 * readField({});                             // => undefined
 */
function readField(req) {
    if ( !req || typeof(req) != 'object' ) { return undefined; }
    if ( req.post && typeof(req.post) == 'object' && typeof(req.post[FIELD]) != 'undefined' ) {
        return req.post[FIELD];
    }
    if ( req.body && typeof(req.body) == 'object' ) {
        return req.body[FIELD];
    }
    return undefined;
}

/**
 * Decide whether this login is remembered.
 *
 * An explicit boolean in the login options wins over the request field, so an
 * application that decides server-side cannot be overridden by the client.
 *
 * @memberof module:lib/session-lifetime
 * @param {object} req       - The request.
 * @param {object} [options] - The login options, as passed to `req.login()`.
 * @returns {boolean} `true` when the remembered lifetime should be used.
 * @example
 * isRemembered({ post: { remember: 'on' } }, {});                // => true
 * isRemembered({ post: { remember: 'on' } }, { remember: false });// => false (option wins)
 * isRemembered({}, {});                                          // => false
 */
function isRemembered(req, options) {
    if ( options && typeof(options.remember) == 'boolean' ) {
        return options.remember;
    }
    return coerceField(readField(req));
}

/**
 * Resolve the lifetime to apply, in milliseconds.
 *
 * A remembered login falls back to `expires` when no `remember` is declared, so
 * declaring only `expires` gives one lifetime to both cases. An ordinary login
 * never borrows the longer `remember` value.
 *
 * @memberof module:lib/session-lifetime
 * @param {object|null}  policy     - A policy from {@link module:lib/session-lifetime.fromConfig}.
 * @param {boolean}      remembered - Whether this login is remembered.
 * @returns {number|null} Milliseconds, or `null` to leave the cookie untouched.
 * @example
 * resolveMs({ expires: 900000, remember: 1296000000 }, true);  // => 1296000000
 * resolveMs({ expires: 900000, remember: 1296000000 }, false); // => 900000
 * resolveMs({ expires: 900000, remember: null }, true);        // => 900000 (falls back)
 * resolveMs({ expires: null, remember: 1296000000 }, false);   // => null (untouched)
 */
function resolveMs(policy, remembered) {
    if ( !policy ) { return null; }
    if ( remembered ) {
        return policy.remember || policy.expires || null;
    }
    return policy.expires || null;
}

/**
 * Apply the resolved lifetime to the request's session cookie.
 *
 * A no-op when no lifetime resolves or the request has no session cookie, so the
 * caller needs no guard of its own.
 *
 * @memberof module:lib/session-lifetime
 * @param {object}      req        - The request, after its session exists.
 * @param {boolean}     remembered - Whether this login is remembered.
 * @param {object|null} policy     - A policy from {@link module:lib/session-lifetime.fromConfig}.
 * @returns {number|null} The milliseconds applied, or `null` when nothing was applied.
 * @example
 * var req = { session: { cookie: {} } };
 * apply(req, true, { expires: 900000, remember: 1296000000 });
 * // => 1296000000, and req.session.cookie.maxAge === 1296000000
 */
function apply(req, remembered, policy) {
    var ms = resolveMs(policy, remembered);
    if ( ms === null ) { return null; }
    if ( !req || !req.session || typeof(req.session) != 'object' ) { return null; }
    if ( !req.session.cookie || typeof(req.session.cookie) != 'object' ) { return null; }
    req.session.cookie.maxAge = ms;
    return ms;
}

/**
 * Wrap an already-installed `req.logIn` so the lifetime is applied after it.
 *
 * This is the passport path: `passport.initialize()` installs its own `req.logIn`
 * before the framework's shim would, so there is no shim callback to extend. The
 * wrapper defers to the installed implementation and applies the lifetime in its
 * callback — after passport has regenerated the session, bound the user and
 * saved — so the assignment is the last write and survives `keepSessionInfo`.
 *
 * Idempotent, and a no-op when no `logIn` is installed. A transient login
 * (`{ session: false }`) and a missing callback are both passed straight through
 * untouched, so passport keeps its own behaviour for them.
 *
 * @memberof module:lib/session-lifetime
 * @param {object}      req    - The request.
 * @param {object|null} policy - A policy from {@link module:lib/session-lifetime.fromConfig}.
 * @returns {boolean} `true` when a wrapper was installed by this call.
 * @example
 * wrapLogin(req, { expires: 900000, remember: 1296000000 });
 * // req.logIn now applies the lifetime once the underlying login succeeds
 */
function wrapLogin(req, policy) {
    if ( !req || !policy ) { return false; }
    if ( typeof(req.logIn) != 'function' ) { return false; }
    if ( req._ginaLoginWrapped ) { return false; }

    var upstream = req.logIn;
    req._ginaLoginWrapped = true;

    var wrapped = function(user, options, done) {
        if ( typeof(options) == 'function' ) {
            done    = options;
            options = {};
        }
        options = options || {};

        // A transient login writes no session, and a caller that passed no
        // callback is passport's to complain about — neither is ours to reshape.
        if ( options.session === false || typeof(done) != 'function' ) {
            return upstream.call(this, user, options, done);
        }

        var self       = this;
        var remembered = isRemembered(this, options);

        return upstream.call(this, user, options, function onLoggedIn(err) {
            if ( !err ) {
                apply(self, remembered, policy);
            }
            done(err);
        });
    };

    req.logIn = req.login = wrapped;
    return true;
}

module.exports = {
    fromConfig   : fromConfig,
    coerceField  : coerceField,
    readField    : readField,
    isRemembered : isRemembered,
    resolveMs    : resolveMs,
    apply        : apply,
    wrapLogin    : wrapLogin
};
