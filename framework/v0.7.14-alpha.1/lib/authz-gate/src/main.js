/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/authz-gate
 *
 * The #COMPLY1 authorization gate — the framework's request-path authorization
 * enforcement point.
 *
 * A route opts in by declaring authorization keys in `routing.json`:
 *
 *   "account": {
 *       "method" : "GET",
 *       "url"    : "/account",
 *       "param"  : { "control": "account", "requireAuth": true }
 *   }
 *
 *   "admin-panel": {
 *       "method" : "GET",
 *       "url"    : "/admin",
 *       "param"  : { "control": "panel", "roles": ["admin", "editor"] }
 *   }
 *
 *   "invoice-edit": {
 *       "method" : "PUT",
 *       "url"    : "/invoices/:id",
 *       "param"  : { "control": "edit", "id": ":id", "policy": "ownsInvoice" }
 *   }
 *
 * `core/server.js` lints every declared key at bundle BOOT (fail-fast: a
 * non-boolean `param.requireAuth`, a `param.roles` that is not a non-empty
 * array of non-empty strings, or a `param.policy` naming a missing / broken /
 * async module, refuses to boot) and resolves the login-bounce target ONCE
 * there onto `process.gina._authConf`. This module then runs before the
 * controller action, at BOTH `core/router.js` dispatch sites, and:
 *
 *   1. NO-OPs for any route that declares no authorization key;
 *   2. authenticates first — `param.roles` and `param.policy` both IMPLY
 *      `requireAuth`, since an unauthenticated caller can hold no role and no
 *      policy can meaningfully judge a caller that is not signed in. An
 *      unauthenticated request is terminated here: a browser navigation is
 *      snapshotted (`pauseRequest`) and bounced to the configured login route;
 *      everything else gets a machine-readable **401**;
 *   3. then matches roles — ANY-of: the session user's `user.roles` must
 *      intersect the declared set;
 *   4. then runs the policy — the record/attribute escape hatch RBAC cannot
 *      express (ownership and the like). AND-composed: a route declaring both
 *      needs both to pass.
 *
 * Every denial from steps 3-4 is a **403** whose body stays GENERIC — the
 * required roles and the policy name are never echoed to the wire (they name
 * the bundle's authorization model, and a 403 that lists what WOULD have been
 * enough is a disclosure to exactly the caller that failed it); the specifics
 * go to the server-side log only.
 *
 * It is a strict NO-OP for every route that declares no authorization key, so an
 * existing bundle is byte-identical.
 *
 * ## Deny-by-default (#COMPLY10 — opt-in, per bundle)
 * `settings.json > auth.requireAuthByDefault: true` INVERTS that last sentence for
 * the bundle that sets it: a route declaring no authorization key is then GATED
 * rather than open, and a route opts back out with `param.public: true`. Nothing
 * else about the gate changes — an un-annotated route carries neither `roles` nor
 * `policy`, so the mode can only ever produce the 401 or the login bounce.
 *
 * The exemption is a POSITIVE marker (`public: true`), matching #CSRF2's
 * `csrfExempt` rationale: a misread leaves the SECURE state. Reusing
 * `requireAuth: false` was rejected for the opposite reason — it would make one
 * literal mean "no-op" in a normal bundle and "audited security exemption" in a
 * deny-by-default one, so a reviewer could not tell an intentional exemption from
 * a leftover.
 *
 * The mode is keyed PER BUNDLE (`_authConf.byBundle`), not flat: merged mode runs
 * every bundle in one process, and a flat flag would let whichever bundle booted
 * last decide the posture for all of them — silently un-gating a bundle that had
 * opted in. See `requireAuthByDefault()` below.
 *
 * `core/server.js` refuses to boot on the contradictions the mode makes possible:
 * `public` alongside an explicit gate key; a login route the mode would gate (which
 * bounces to itself — an infinite redirect, i.e. total lockout); and a route the
 * mode gates that also declares `cache`, because both render-cache serve points run
 * BEFORE this gate and the cache key carries no principal, so a cached gated route
 * would replay an authenticated body to anonymous callers.
 *
 * ## The roles contract (#COMPLY1 defines it; the app populates it)
 * `req.session.user.roles` is a plain array of opaque role-name strings — the
 * framework imposes no vocabulary and no role→permission indirection (v1 names
 * roles directly; an indirection layer is a demand-gated follow-up). The app
 * populates it at login alongside `session.user`. Absent or non-array means the
 * user holds no roles, so every role-gated route answers 403 for that session.
 *
 * ## The policy contract — SYNCHRONOUS, allow iff `=== true`
 * A `param.policy` names a `<bundle>/policies/<name>.js` module exporting a plain
 * function:
 *
 *   // <bundle>/policies/ownsInvoice.js
 *   module.exports = function (user, req) {
 *       return req.params.ownerId === user.id;
 *   };
 *
 * It is registered at BOOT (`registerPolicy`) onto `process.gina._policies`, so the
 * request path is an O(1) lookup — no fs, no re-require (which would also feed the
 * dev-mode `module.children` leak class, #B32).
 *
 * The contract is synchronous because the GATE is synchronous — `authorizeRequest`
 * returns a boolean that both `core/router.js` dispatch sites branch on directly.
 * Two rules make that safe rather than merely convenient:
 *
 *   * an `async function` policy is **refused at boot**. Its constructor name reads
 *     `AsyncFunction`, which is the only boot-visible tell (`typeof` says 'function'
 *     for both), so the author learns at deploy instead of watching the route deny
 *     every request forever;
 *   * a policy that merely RETURNS a promise (the transpiled-async shape) is
 *     boot-INVISIBLE — its constructor reads `Function`. So the allow test is
 *     strictly `=== true`: a promise is truthy but not `true`, and a truthy-allow
 *     gate would ALLOW it unconditionally — the control silently OFF, inverted into
 *     fail-OPEN. Anything that is not literally `true` denies, and a non-boolean
 *     return warns ONCE naming the policy so the contract violation is visible
 *     without flooding the log.
 *
 * A throwing policy denies (403) and never 500s the wire. Async tolerance is a
 * demand-gated follow-up: `(user, req)` extends compatibly to `(user, req, cb)`.
 *
 * ## Why the gate sits before the DTO pipe
 * `core/router.js` calls this immediately BEFORE `dtoPipe.validateRequestPayload`,
 * extending the invariant that site already codifies (auth precedes validation):
 * an unauthenticated caller must never learn whether its payload WOULD have
 * validated — a 422 field map is a disclosure. Route middleware has already
 * drained by then, so a bundle's own auth middleware keeps its semantics and this
 * gate is purely additive after it.
 *
 * ## The authentication contract (#COMPLY1 defines it; the app populates it)
 * A request is authenticated **iff `req.session.user` is truthy**. That is read
 * DIRECTLY rather than through `router.js`'s Passport `request.isAuthenticated()`
 * shim, which is installed only conditionally (on a `_passport` / `session`
 * probe), has no framework caller, and itself converges onto `request.session.user`
 * — so the property IS the contract and the shim stays a userland convenience.
 * Populating it at login is the application's job (later #COMPLY3 ships helpers).
 *
 * ## The machine-caller path (#MS3 — service-to-service callers)
 * A caller that cannot hold a session — another bundle via `self.query()`, a
 * job runner, an external service — authenticates per request with
 * `Authorization: Bearer <key>` against `settings.json > auth.machine`
 * (opt-in, fail-closed; `core/server.js` lints it at boot and precomputes a
 * sha256 hash per configured caller onto `process.gina._authConf.machine`, so
 * the request path compares fixed-length digests and never retains a raw key).
 * SESSION WINS: the machine resolution runs only when no authenticated session
 * is present, and only for GATED routes — an un-gated route never pays a
 * compare, and `enabled: false` (the default) is byte-identical to the
 * pre-#MS3 gate. On a match the gate stamps
 * `req.machineCaller = { name, roles, machine: true }` — the effective
 * principal for roles matching and for policies (which can discriminate via
 * `principal.machine === true`), and the identity `lib/audit`'s `deriveActor`
 * and the controller's `self.hasRole` read. A PRESENTED but invalid Bearer
 * credential gets a clean 401 + `WWW-Authenticate: Bearer` and NEVER the
 * login bounce (a 302-to-login is meaningless to a service client); per-route
 * granularity rides `roles` — keep a route human-only by requiring a role no
 * configured caller holds, or machine-only by requiring a role only callers
 * hold. There is deliberately NO per-route opt-in key.
 *
 * ## The custom authenticator hook (#MS3 — the escape hatch)
 * `auth.machine.authenticator` names a `<bundle>/authenticators/<name>.js`
 * module — the `policies/<name>.js` shape, applied to authN — exporting a
 * SYNCHRONOUS `function (req) { return { name, roles } | null; }`. It runs
 * for gated, session-less requests AFTER the built-in caller map (map first,
 * first success wins) and REGARDLESS of whether a Bearer header is present,
 * so it can verify any sync-checkable credential: a JWT signature
 * (`jwt.verify` with a local secret/public key is synchronous), an HMAC
 * header, an `x-api-key` scheme. The gate NORMALIZES its return — the
 * principal is always `{ name, roles: [], machine: true }`-shaped regardless
 * of what the hook returns beyond `name`. Registered at BOOT
 * (`registerAuthenticator` → `process.gina._authenticators`) with the same
 * fail-fast lint as policies — an `async function` refuses to boot for the
 * same reason (the gate is synchronous; a promise is truthy but not a
 * principal), and at request time a THROW or a malformed return is
 * fail-closed unauthenticated (warn-once), never a 500. A custom-scheme
 * rejection (no Bearer presented) degrades to the ORDINARY 401/bounce — the
 * machine 401 (`WWW-Authenticate: Bearer`) stays Bearer-specific.
 *
 * ## Why the bounce is a 302 + no-store, unconditionally
 * `controller.redirect()` cannot be reused for it: it defaults to a **cacheable
 * 301** (`req.routing.param.code || 301`, read off whichever route object the
 * branch left on the request) and only applies the no-store set when the request
 * is dev-mode or proxy-classified (#B68). A cached auth bounce is a login LOOP —
 * the browser replays the redirect for the later, now-authenticated visit and
 * never reaches the page. So the bounce is emitted here, mirroring `redirect()`'s
 * proven exit shape (`writeHead` + the `{status, headers}` body the inter-bundle
 * `query()` 3xx intercept replays) with the status and the no-store set forced.
 */

/**
 * #COMPLY2 — the audit-trail primitive, for the framework authz auto-events
 * (`authz.denied` records at the deny writers below). Required by DEEP PATH
 * (the `lib/job` -> `lib/uuid` precedent) so the gate has no dependency on the
 * registry or on global-injection ordering; the dependency is strictly one-way
 * (`lib/audit` never requires this module). `emitAuthzDenied` is fully
 * contained on its side (gated on `audit.enabled` + `audit.events.authz`,
 * whole body try/caught) — an audit failure can NEVER change an authorization
 * outcome.
 *
 * @inner
 */
var audit = require('../../audit/src/main');

/**
 * #MS3 — the machine-caller token digest + compare. Node built-in, no
 * dependency edge added.
 *
 * @inner
 */
var crypto = require('crypto');

/**
 * Read the boot-resolved login-bounce target.
 *
 * `core/server.js` resolves it ONCE at boot (route-name -> url resolution and
 * webroot composition included) so the request path costs an O(1) property read
 * and never a config clone — the `process.gina._adminAllowList` / `_dtos`
 * precedent. `settings.json` is boot config (never hot-reloaded), so there is
 * nothing to re-read per request.
 *
 * @returns {string|null} the composed, root-relative login path, or `null` when
 *                        the bundle configured none.
 * @inner
 * @private
 */
var getLoginRoute = function () {
    var conf = ( typeof(process.gina) != 'undefined' && process.gina && process.gina._authConf )
        ? process.gina._authConf
        : null;

    return ( conf && typeof(conf.loginRoute) == 'string' && conf.loginRoute ) ? conf.loginRoute : null;
};

/**
 * #COMPLY10 — read the deny-by-default authorization mode for the request's
 * OWN bundle.
 *
 * `core/server.js` lints `settings.json > auth.requireAuthByDefault` at boot and
 * writes it onto `process.gina._authConf.byBundle[<bundle>]`, so the request path
 * costs an O(1) property read (the `loginRoute` / `_policies` precedent).
 *
 * The per-bundle keying is load-bearing rather than tidy. `_authConf` is written
 * once per `init()`, and MERGED mode runs every bundle of a project in ONE process
 * (`core/config.js`), so a flat flag would be overwritten by whichever bundle
 * booted last: a bundle that enabled the mode would silently un-gate every one of
 * its routes because a sibling booted after it without the key. That is a
 * fail-OPEN, and the one failure direction a deny-by-default control must never
 * have. Keying by `req.routing.bundle` — populated on BOTH dispatch paths — makes
 * each bundle's posture independent of its boot order.
 *
 * Fail-safe direction is deliberately INVERTED here relative to the rest of the
 * gate: an unidentifiable bundle returns `false` (do not gate). Every other
 * unknown in this module denies, because denying is the safe direction when the
 * question is "may this caller through". Here the question is "did an operator
 * ask for this mode at all", and answering yes on missing evidence would gate a
 * bundle whose author never opted in — turning a config gap into a total outage.
 * It is unreachable from dispatch regardless (`core/server.js` skips any route
 * carrying no `param`, and every matched route carries a `bundle`).
 *
 * @param {object} req - the request (reads `req.routing.bundle`).
 * @returns {boolean} `true` when THIS bundle opted into deny-by-default.
 * @inner
 * @private
 */
var requireAuthByDefault = function (req) {
    var conf = ( typeof(process.gina) != 'undefined' && process.gina && process.gina._authConf )
        ? process.gina._authConf
        : null;

    if ( !conf || !conf.byBundle || typeof(conf.byBundle) != 'object' ) {
        return false;
    }

    var bundle = ( req && req.routing && typeof(req.routing.bundle) == 'string' && req.routing.bundle !== '' )
        ? req.routing.bundle
        : null;
    if ( !bundle ) {
        return false;
    }

    var entry = conf.byBundle[bundle];
    return ( entry && entry.requireAuthByDefault === true ) ? true : false;
};

/**
 * The authentication predicate — the shape every #COMPLY1 surface reads.
 *
 * @param {object} req - the request.
 * @returns {boolean} `true` when the request carries an authenticated session.
 * @inner
 * @private
 */
var isAuthenticated = function (req) {
    return ( req.session && typeof(req.session) == 'object' && req.session.user ) ? true : false;
};

/**
 * #MS3 — read the boot-built machine-caller registry.
 *
 * `core/server.js` lints `settings.json > auth.machine` at boot and writes
 * `{ enabled, callers: { <name>: { keyHash, roles } } }` onto
 * `process.gina._authConf.machine` — the `_policies` / `loginRoute` precedent:
 * the request path costs an O(1) property read, never a config walk. A boot
 * that predates #MS3 (or a test fixture carrying only `loginRoute`) simply has
 * no `machine` key, which this treats as disabled.
 *
 * @returns {object|null} the machine conf, or `null` when absent/disabled.
 * @inner
 * @private
 */
var getMachineConf = function () {
    var conf = ( typeof(process.gina) != 'undefined' && process.gina && process.gina._authConf )
        ? process.gina._authConf
        : null;

    return ( conf && conf.machine && typeof(conf.machine) == 'object' ) ? conf.machine : null;
};

/**
 * #MS3 — extract the presented Bearer token, or `null` when the request
 * carries none.
 *
 * The parse mirrors `lib/mcp-http`'s `Authorization: Bearer` verifier (the
 * framework's one true Bearer precedent): case-insensitive scheme, the token
 * is everything after the whitespace, trimmed. An empty-after-trim token
 * (e.g. `Authorization: Bearer  ` — whitespace only) is treated as NOT
 * presented, so it degrades to the ordinary unauthenticated path instead of
 * the machine 401.
 *
 * @param {object} req - the request (reads `req.headers.authorization`).
 * @returns {string|null} the presented token, or `null`.
 * @inner
 * @private
 */
var getBearerToken = function (req) {
    var header = ( req && req.headers && typeof(req.headers['authorization']) == 'string' )
        ? req.headers['authorization']
        : '';
    var m = /^Bearer\s+(.+)$/i.exec(header);
    if ( !m ) {
        return null;
    }
    var token = m[1].trim();
    return ( token !== '' ) ? token : null;
};

/**
 * #MS3 — verify a presented Bearer token against every configured caller and,
 * on a match, stamp + return the machine principal.
 *
 * The presented token is sha256-hashed ONCE, then compared to each caller's
 * boot-precomputed key hash via `crypto.timingSafeEqual`. Hashing BOTH sides
 * makes every compare fixed-length (32 bytes), so neither the compare nor the
 * scan leaks key length or content — a deliberate tightening over the
 * framework's raw length-guard compare sites, whose short-circuit on unequal
 * length is a (minor) length oracle. The scan visits callers until a match;
 * an INVALID token always pays the full scan, so its timing reveals only the
 * number of configured callers — config, not secret.
 *
 * The principal is stamped on `req.machineCaller` so the downstream identity
 * readers — `lib/audit`'s `deriveActor`, the controller's `self.hasRole` —
 * see the same resolution without a second verification. `roles` is a COPY
 * (`.slice()`), mirroring `deriveActor`'s mutation-isolation discipline.
 *
 * Fail-closed at every step: no callers, malformed registry entry, hash
 * mismatch — all return `null` and stamp nothing.
 *
 * @param {object} req    - the request (stamped with `machineCaller` on success).
 * @param {object} mconf  - the boot-built machine conf (`getMachineConf()`, enabled).
 * @param {string} token  - the presented Bearer token (`getBearerToken()`, non-empty).
 * @returns {object|null} `{ name, roles, machine: true }`, or `null`.
 * @inner
 * @private
 */
var verifyMachineToken = function (req, mconf, token) {
    var callers = ( mconf.callers && typeof(mconf.callers) == 'object' ) ? mconf.callers : {};
    var names   = Object.keys(callers);
    if ( names.length === 0 ) {
        return null;
    }

    var presentedHash = crypto.createHash('sha256').update(token, 'utf8').digest();

    for (var i = 0; i < names.length; ++i) {
        var entry = callers[names[i]];
        if ( !entry || !Buffer.isBuffer(entry.keyHash) || entry.keyHash.length !== presentedHash.length ) {
            continue;   // malformed registry entry — never a match, never a throw
        }
        var matched = false;
        try {
            matched = crypto.timingSafeEqual(presentedHash, entry.keyHash);
        } catch (err) {
            matched = false;
        }
        if ( matched ) {
            var principal = {
                name    : names[i],
                roles   : Array.isArray(entry.roles) ? entry.roles.slice() : [],
                machine : true
            };
            req.machineCaller = principal;
            return principal;
        }
    }

    return null;
};

/**
 * #MS3 — the boot-built custom-authenticator registry:
 * `process.gina._authenticators`, name -> function. The `_policies` mirror.
 *
 * @returns {object|null} the registry, or `null` outside a booted process.
 * @inner
 * @private
 */
var getAuthenticatorRegistry = function () {
    if ( typeof(process.gina) == 'undefined' || !process.gina ) {
        return null;
    }
    if ( !process.gina._authenticators || typeof(process.gina._authenticators) != 'object' ) {
        process.gina._authenticators = {};
    }
    return process.gina._authenticators;
};

/**
 * Warn-once bookkeeping for custom authenticators that break the return
 * contract — the `_warnedPolicies` mirror (one line per request would bury
 * the message the author needs).
 *
 * @type {object}
 * @inner
 * @private
 */
var _warnedAuthenticators = {};

/**
 * #MS3 — run the bundle's custom authenticator, normalizing its return to the
 * machine-principal shape.
 *
 * Contract: SYNCHRONOUS `function (req) { return { name, roles } | null; }` —
 * `null` / `false` / `undefined` means "not authenticated by me" (silent, the
 * normal miss). A valid return needs a non-empty string `name`; `roles` is
 * taken only as an array (anything else normalizes to `[]`, a COPY either
 * way). The gate FORCES `machine: true` on the principal — the hook cannot
 * mint a session-user-shaped identity.
 *
 * Fail-closed, never a 500: a THROW logs server-side and resolves
 * unauthenticated; a malformed return (a string, a number, an object without
 * `name` — including a promise from a transpiled-async authenticator, which
 * the boot refusal cannot see) warns ONCE naming the authenticator and
 * resolves unauthenticated. An unregistered name (registry never built /
 * mutated) is a silent miss — the boot registrar guarantees registration for
 * every declared name, so reaching it means the process state was tampered
 * with, and an authenticator that cannot be found must never admit.
 *
 * @param {object} req  - the request (stamped with `machineCaller` on success).
 * @param {string} name - the configured `auth.machine.authenticator`.
 * @returns {object|null} the normalized principal, or `null`.
 * @inner
 * @private
 */
var runAuthenticator = function (req, name) {
    var reg = ( typeof(process.gina) != 'undefined' && process.gina && process.gina._authenticators )
        ? process.gina._authenticators
        : null;
    var fn = ( reg && typeof(reg[name]) == 'function' ) ? reg[name] : null;
    if ( !fn ) {
        return null;
    }

    var returned;
    try {
        returned = fn(req);
    } catch (err) {
        console.error('[ authz ] authenticator `'+ name +'` threw for `'+ ((req.routing && req.routing.rule) || '?') +'`: '+ (err.stack || err.message || err));
        return null;
    }

    if ( returned === null || returned === false || typeof(returned) == 'undefined' ) {
        return null;   // the normal miss — not authenticated by this hook
    }
    if ( typeof(returned) != 'object' || typeof(returned.name) != 'string' || returned.name === '' ) {
        if ( _warnedAuthenticators[name] !== true ) {
            _warnedAuthenticators[name] = true;
            var shape = ( returned && typeof(returned.then) == 'function' )
                ? 'a promise'
                : '`'+ typeof(returned) +'`';
            console.warn('[ authz ] authenticator `'+ name +'` returned '+ shape +', not `{ name, roles }` or null — treating as UNAUTHENTICATED (fail-closed). The authenticator contract is SYNCHRONOUS: `module.exports = function (req) { return { name: \'caller\', roles: [] } or null; };`.');
        }
        return null;
    }

    var principal = {
        name    : returned.name,
        roles   : Array.isArray(returned.roles) ? returned.roles.slice() : [],
        machine : true
    };
    req.machineCaller = principal;
    return principal;
};

/**
 * Warn-once bookkeeping, keyed by policy name: a policy that violates the return
 * contract does so on EVERY request, and one line per request would bury the very
 * message the author needs to act on.
 *
 * @type {object}
 * @inner
 * @private
 */
var _warnedPolicies = {};

/**
 * The boot-built policy registry — `process.gina._policies`, name -> function.
 *
 * @returns {object|null} the registry, or `null` outside a booted process.
 * @inner
 * @private
 */
var getPolicyRegistry = function () {
    if ( typeof(process.gina) == 'undefined' || !process.gina ) {
        return null;
    }
    if ( !process.gina._policies || typeof(process.gina._policies) != 'object' ) {
        process.gina._policies = {};
    }
    return process.gina._policies;
};

/**
 * Resolve + register a bundle policy module at BOOT.
 *
 * Mirrors `lib.dto.load`'s resolution contract: returns `null` when unresolved (no
 * such file, or the file exports no function) and THROWS when the file is present
 * but broken — the caller decides what an unresolved reference means (here
 * `core/server.js` refuses the boot either way, adding the route context).
 *
 * The `async function` refusal lives here rather than at the gate because it is the
 * only place the tell is visible: an async policy's promise return is truthy but
 * never `=== true`, so the strict allow test would deny the route on every request
 * — a security control that is silently, permanently broken. Refusing at boot turns
 * that into a deploy-time error.
 *
 * @param {string} bundleSrcPath - absolute path to the bundle source dir.
 * @param {string} name          - the reference (also the file base name).
 * @returns {function|null} the registered policy, or `null` when unresolved.
 * @throws {Error} when the module cannot be required, or is an `async function`.
 *
 * @example
 * // core/server.js, at boot
 * var fn = authzGate.registerPolicy(bundleSrcPath, 'ownsInvoice');
 * if ( !fn ) {
 *     throw new Error('policies/ownsInvoice.js is missing (or exports no function)');
 * }
 */
var registerPolicy = function (bundleSrcPath, name) {
    if ( typeof(name) != 'string' || !name ) {
        return null;
    }
    if ( typeof(bundleSrcPath) != 'string' || !bundleSrcPath ) {
        return null;
    }

    var file = require('path').join(bundleSrcPath, 'policies', name + '.js');
    if ( !require('fs').existsSync(file) ) {
        return null;
    }

    var fn = require(file);   // may throw -> the caller wraps it with route context
    if ( typeof(fn) != 'function' ) {
        return null;
    }
    if ( fn.constructor && fn.constructor.name === 'AsyncFunction' ) {
        throw new Error('policy `'+ name +'` is an `async function`, but the policy contract is SYNCHRONOUS: `module.exports = function (user, req) { return true; };`. The gate authorizes synchronously and allows only a literal `true`, so an async policy would deny this route on every request.');
    }

    var reg = getPolicyRegistry();
    if ( reg ) {
        reg[name] = fn;
    }
    return fn;
};

/**
 * #MS3 — resolve + register a bundle's custom authenticator module at BOOT.
 *
 * The `registerPolicy` mirror, for the authN escape hatch: resolves
 * `<bundleSrcPath>/authenticators/<name>.js`, returns `null` when unresolved
 * (no such file, or the file exports no function) and THROWS when the file is
 * present but broken — the caller (`core/server.js`) refuses the boot either
 * way, adding the config context.
 *
 * An `async function` is REFUSED at boot for the same reason as an async
 * policy: the gate authorizes synchronously, and a promise return is truthy
 * but never a valid principal — the hook would silently never authenticate.
 * The transpiled-async shape (a plain function returning a promise) is
 * boot-INVISIBLE; `runAuthenticator`'s strict shape check is what keeps it
 * fail-closed at request time.
 *
 * @param {string} bundleSrcPath - absolute path to the bundle source dir.
 * @param {string} name          - the reference (also the file base name).
 * @returns {function|null} the registered authenticator, or `null` when unresolved.
 * @throws {Error} when the module cannot be required, or is an `async function`.
 *
 * @example
 * // core/server.js, at boot
 * var fn = authzGate.registerAuthenticator(bundleSrcPath, 'verifyJwt');
 * if ( !fn ) {
 *     throw new Error('authenticators/verifyJwt.js is missing (or exports no function)');
 * }
 *
 * @example
 * // <bundle>/authenticators/verifyJwt.js — a sync JWT verifier (jwt.verify
 * // with a local secret is synchronous): the JWT-on-demand recipe.
 * var jwt = require('jsonwebtoken');
 * module.exports = function (req) {
 *     var m = /^Bearer\s+(.+)$/i.exec((req.headers && req.headers.authorization) || '');
 *     if (!m) { return null; }
 *     try {
 *         var claims = jwt.verify(m[1].trim(), process.env.JWT_PUBLIC_KEY);
 *         return { name: claims.sub, roles: claims.roles || [] };
 *     } catch (e) {
 *         return null;   // invalid signature/expiry — not authenticated by me
 *     }
 * };
 */
var registerAuthenticator = function (bundleSrcPath, name) {
    if ( typeof(name) != 'string' || !name ) {
        return null;
    }
    if ( typeof(bundleSrcPath) != 'string' || !bundleSrcPath ) {
        return null;
    }

    var file = require('path').join(bundleSrcPath, 'authenticators', name + '.js');
    if ( !require('fs').existsSync(file) ) {
        return null;
    }

    var fn = require(file);   // may throw -> the caller wraps it with config context
    if ( typeof(fn) != 'function' ) {
        return null;
    }
    if ( fn.constructor && fn.constructor.name === 'AsyncFunction' ) {
        throw new Error('authenticator `'+ name +'` is an `async function`, but the authenticator contract is SYNCHRONOUS: `module.exports = function (req) { return { name: \'caller\', roles: [] } or null; };`. The gate authorizes synchronously, so an async authenticator could never admit a caller.');
    }

    var reg = getAuthenticatorRegistry();
    if ( reg ) {
        reg[name] = fn;
    }
    return fn;
};

/**
 * Read a boot-registered policy.
 *
 * @param {string} name - the route's declared `param.policy`.
 * @returns {function|null}
 * @inner
 * @private
 */
var getPolicy = function (name) {
    var reg = ( typeof(process.gina) != 'undefined' && process.gina && process.gina._policies )
        ? process.gina._policies
        : null;

    return ( reg && typeof(reg[name]) == 'function' ) ? reg[name] : null;
};

/**
 * Warn ONCE that a policy broke the return contract.
 *
 * @param {string} name     - the policy name.
 * @param {*} returned      - whatever it returned instead of a boolean.
 * @returns {void}
 * @inner
 * @private
 */
var warnPolicyContractOnce = function (name, returned) {
    if ( _warnedPolicies[name] === true ) {
        return;
    }
    _warnedPolicies[name] = true;

    var shape = ( returned && typeof(returned.then) == 'function' )
        ? 'a promise'
        : '`'+ ( returned === null ? 'null' : typeof(returned) ) +'`';

    console.warn('[ authz ] policy `'+ name +'` returned '+ shape +', not a boolean — DENYING (fail-closed). The policy contract is SYNCHRONOUS: `module.exports = function (user, req) { return true; };`. Every request through this policy is denied until it returns a real boolean.');
};

/**
 * ANY-of role match: does the session user hold at least one of the roles the
 * route requires?
 *
 * Roles are opaque strings — no framework vocabulary, no wildcard, no
 * role→permission indirection (v1 names roles directly). A user whose `roles`
 * is absent or not an array holds NO roles, so any role-gated route denies.
 *
 * Exported so the controller's `self.hasRole(role)` escape hatch reads roles
 * through THIS definition rather than its own copy — "holding a role" must mean
 * exactly one thing framework-wide (the byte-identical-copy-paste class that
 * `lib/cmd-status-format` and `lib/json-config-header` were extracted to end).
 *
 * @param {object} user            - `req.session.user` (truthy by the time the gate calls
 *                                   this — it authenticates first; `self.hasRole` may pass
 *                                   `null` for an unauthenticated request).
 * @param {string[]} requiredRoles - the roles to test against. From the gate: the route's
 *                                   declared `param.roles` (the boot lint guarantees a
 *                                   non-empty array of non-empty strings).
 * @returns {boolean} `true` when at least one required role is held.
 *
 * @example
 * authzGate.hasAnyRole({ roles: ['editor'] }, ['admin', 'editor']);   // true
 * authzGate.hasAnyRole({ roles: 'admin' },    ['admin']);             // false — not an array
 * authzGate.hasAnyRole(null,                  ['admin']);             // false
 */
var hasAnyRole = function (user, requiredRoles) {
    var userRoles = ( user && Array.isArray(user.roles) ) ? user.roles : null;
    if ( !userRoles || userRoles.length === 0 ) {
        return false;
    }
    for (var i = 0; i < requiredRoles.length; ++i) {
        if ( userRoles.indexOf(requiredRoles[i]) > -1 ) {
            return true;
        }
    }
    return false;
};

/**
 * Emit the login bounce: a forced **302** carrying the no-store set.
 *
 * Mirrors `controller.redirect()`'s exit (`writeHead(code, headInfos)` — the same
 * call for both engines — then a `{status, headers}` JSON body, which is what the
 * inter-bundle `query()` 3xx intercept parses) with two deliberate divergences,
 * both load-bearing for an auth bounce: the status is **302**, never redirect()'s
 * cacheable 301 default; and the no-store set is UNCONDITIONAL, not gated on
 * dev-or-proxied (#B68) — a direct production deployment is exactly where a
 * cached 301 bounce would pin a login loop.
 *
 * @param {object} req        - the request (read for the access-log line only).
 * @param {object} res        - the response.
 * @param {string} loginRoute - the boot-resolved, root-relative login path.
 * @returns {boolean} always `false` — the gate has answered; the router must return.
 * @inner
 * @private
 */
var bounceToLogin = function (req, res, loginRoute) {
    if ( !res || res.headersSent ) {
        return false;   // something already answered — never double-send
    }

    var headInfos = {
        'location'      : loginRoute,
        'cache-control' : 'no-cache, no-store, must-revalidate',
        'pragma'        : 'no-cache',
        'expires'       : '0'
    };

    try {
        res.writeHead(302, headInfos);
        // The body the inter-bundle query() 3xx intercept replays (see redirect()).
        res.end(JSON.stringify({ status: 302, headers: headInfos }));
        res.headersSent = true;   // for the render() method — mirrors redirect()
        // The access log is how a redirect is verified from pod logs (it records the
        // EMITTED Location): keep the bounce as observable as a normal redirect.
        console.info(String(req.method || 'GET').toUpperCase() +' [302] '+ loginRoute);
    } catch (err) {
        console.warn('[ authz ] could not emit the login bounce for `'+ ((req.routing && req.routing.rule) || '?') +'`: '+ (err.message || err));
    }

    return false;
};

/**
 * Terminate an unauthenticated request against a gated route.
 *
 * Bounces a browser navigation to the configured login route (snapshotting the
 * request first, so the login action can `resumeRequest()` it); answers a plain
 * **401** in every other case.
 *
 * The bounce needs all three of: a configured target; a NON-XHR request (an XHR's
 * handler cannot meaningfully follow a Location — it needs a status it can read,
 * and XHR follows redirects transparently, so a 302 would hand it the login PAGE
 * as the response body); and a session to snapshot into (`pauseRequest` requires
 * one — it 424s without, which would turn an auth bounce into an error).
 *
 * @param {object} controller - the per-request controller (its `throwError` writes the 401).
 * @param {object} req        - the request.
 * @param {object} res        - the response.
 * @returns {boolean} always `false` — the gate has answered; the router must return.
 * @inner
 * @private
 */
var denyUnauthenticated = function (controller, req, res) {
    var loginRoute = getLoginRoute();

    if ( !loginRoute || req.isXMLRequest === true || !req.session ) {
        audit.emitAuthzDenied(req, '401'); // #COMPLY2 auto-event — contained, never affects the denial
        controller.throwError({
            status : 401,
            error  : 'Authentication required'
        });
        return false;
    }

    var method = String(req.method || 'GET').toLowerCase();
    try {
        controller.pauseRequest(req[method] || {});
    } catch (err) {
        // A failed snapshot must never turn an auth bounce into a 500: the user still
        // gets to log in, they just lose the replay and land on the login page's own
        // destination.
        console.warn('[ authz ] could not snapshot the halted request for `'+ ((req.routing && req.routing.rule) || '?') +'`: '+ (err.message || err));
    }

    audit.emitAuthzDenied(req, 'login-bounce'); // #COMPLY2 auto-event — contained, never affects the bounce
    return bounceToLogin(req, res, loginRoute);
};

/**
 * #MS3 — terminate a request that PRESENTED a Bearer credential the machine
 * registry rejects: a clean **401** carrying `WWW-Authenticate: Bearer`
 * (RFC 6750/7235 — a 401 to a Bearer-credentialed caller names the scheme),
 * and NEVER the login bounce — a 302-to-login is meaningless to a service
 * client, and XHR-ness is irrelevant here: the presented credential already
 * identifies the caller as a machine.
 *
 * The header is set BEFORE `throwError` so it rides the same response the
 * error writer emits — both engines' response objects expose `setHeader`,
 * and `throwError` sends via `res.writeHead`, which merges previously-set
 * headers (Node semantics). Best-effort: a response without `setHeader`
 * (bare test stubs) still gets the 401 itself.
 *
 * The body stays the generic `Authentication required` — whether the token
 * was unknown, malformed or stale is not disclosed to the caller that
 * failed it (the `denyForbidden` disclosure rationale, applied to authN).
 *
 * @param {object} controller - the per-request controller (its `throwError` writes the 401).
 * @param {object} req        - the request.
 * @param {object} res        - the response (the `WWW-Authenticate` header is set on it).
 * @returns {boolean} always `false` — the gate has answered; the router must return.
 * @inner
 * @private
 */
var denyMachineUnauthenticated = function (controller, req, res) {
    try {
        if ( res && !res.headersSent && typeof(res.setHeader) == 'function' ) {
            res.setHeader('WWW-Authenticate', 'Bearer');
        }
    } catch (err) {
        // best-effort — the 401 itself is the contract
    }

    audit.emitAuthzDenied(req, '401-machine'); // #COMPLY2 auto-event — contained, never affects the denial
    controller.throwError({
        status : 401,
        error  : 'Authentication required'
    });
    return false;
};

/**
 * Terminate an AUTHENTICATED request that fails an authorization check: a **403**
 * with a deliberately GENERIC body.
 *
 * The body never echoes the required roles (nor, later, a policy name) — those
 * name the bundle's authorization model, and a 403 that lists what WOULD have
 * been enough is a disclosure to exactly the caller that failed it. The
 * specifics land in the server-side log only.
 *
 * @param {object} controller - the per-request controller (its `throwError` writes the 403).
 * @param {object} req        - the request (read for the server-side log line only).
 * @param {string} reason     - the server-side-only denial detail.
 * @param {string} [outcome]  - the #COMPLY2 audit-event token (`'403-roles'` | `'403-policy'`), riding the record's `meta.outcome`.
 * @returns {boolean} always `false` — the gate has answered; the router must return.
 * @inner
 * @private
 */
var denyForbidden = function (controller, req, reason, outcome) {
    console.debug('[ authz ] denied `'+ ((req.routing && req.routing.rule) || '?') +'` — '+ reason);
    // #COMPLY2 auto-event — contained, never affects the denial. The outcome
    // token ('403-roles' | '403-policy') discriminates this writer's call
    // sites; `reason` stays server-side-only (console.debug above), so the
    // record leaks nothing the 403 body does not.
    audit.emitAuthzDenied(req, outcome || '403');
    controller.throwError({
        status : 403,
        error  : 'Forbidden'
    });
    return false;
};

/**
 * Run a route's declared policy — the record/attribute escape hatch RBAC cannot
 * express. Allow **iff** it returns a literal `true`; every other outcome denies.
 *
 * The three deny paths, all fail-CLOSED:
 *   * **unregistered** — the boot registrar guarantees a function for every declared
 *     `param.policy`, so reaching this means the registry was never built or was
 *     mutated. A gate that cannot find its policy must never allow;
 *   * **threw** — the caller learns only that it is Forbidden; the stack goes to the
 *     server-side log. A policy bug must not 500 the wire (nor, via the uncaught path,
 *     the bundle);
 *   * **did not return `true`** — including a promise, which is truthy. See the module
 *     header: this is the strictness that keeps a transpiled-async policy (boot-invisible)
 *     from failing OPEN.
 *
 * @param {object} controller - the per-request controller (its `throwError` writes the 403).
 * @param {object} req        - the request, handed to the policy as its 2nd argument.
 * @param {string} name       - the route's declared `param.policy`.
 * @param {object} user       - the effective principal, handed to the policy as its 1st
 *                              argument: `req.session.user`, or the #MS3 machine caller
 *                              (`{ name, roles, machine: true }` — a policy discriminates
 *                              via `user.machine === true`).
 * @returns {boolean} `true` to continue to the action, `false` when denied (403 written).
 * @inner
 * @private
 */
var runPolicy = function (controller, req, name, user) {
    var fn = getPolicy(name);
    if ( !fn ) {
        return denyForbidden(controller, req, 'policy `'+ name +'` is not registered', '403-policy');
    }

    var allowed;
    try {
        allowed = fn(user, req);
    } catch (err) {
        console.error('[ authz ] policy `'+ name +'` threw for `'+ ((req.routing && req.routing.rule) || '?') +'`: '+ (err.stack || err.message || err));
        return denyForbidden(controller, req, 'policy `'+ name +'` threw', '403-policy');
    }

    if ( allowed === true ) {
        return true;
    }
    if ( typeof(allowed) != 'boolean' ) {
        warnPolicyContractOnce(name, allowed);
    }

    return denyForbidden(controller, req, 'policy `'+ name +'` did not allow', '403-policy');
};

/**
 * Is the matched route gated by authorization at all?
 *
 * The ONE runtime answer to that question: `authorizeRequest` branches on it to
 * decide whether to authenticate, and the render delegates read it to decide
 * whether an entry may be written to the render cache (#B158). Keeping a single
 * implementation is the point — a second copy that drifted would either gate a
 * route the cache still stores (the #B158 leak, reopened) or refuse to store a
 * route nobody gates.
 *
 * Precedence is STRUCTURAL, not conditional, and deliberately so: `param.public`
 * is consulted only INSIDE the un-annotated branch, so it can never un-gate a
 * route that carries an explicit key. The boot lint refuses that contradiction
 * outright, but a hand-built or tampered config must still fail CLOSED without
 * depending on the lint having run.
 *
 * @param {object} req - the request. Reads `req.routing.param.requireAuth`,
 *                       `param.roles`, `param.policy`, `param.public` and
 *                       `req.routing.bundle` (for the #COMPLY10 per-bundle mode).
 * @returns {boolean} `true` when the route requires an authenticated principal.
 *
 * @example
 * // a render delegate, before storing a rendered body
 * if ( lib.authzGate.isRouteGated(req) ) {
 *     return; // never cache a body rendered for an authenticated principal
 * }
 */
var isRouteGated = function (req) {
    if ( !req || !req.routing || !req.routing.param ) {
        return false;
    }

    var param = req.routing.param;

    // An explicit key gates the route. `roles` and `policy` each IMPLY
    // `requireAuth` — an unauthenticated caller can hold no role, and a policy
    // is handed an authenticated user. Strict shapes only: the boot lint rejects
    // every other declared form, so an invalid key must never HALF-gate.
    if ( param.requireAuth === true ) {
        return true;
    }
    if ( Array.isArray(param.roles) && param.roles.length > 0 ) {
        return true;
    }
    if ( typeof(param.policy) == 'string' && param.policy !== '' ) {
        return true;
    }

    // Un-annotated from here — the only branch #COMPLY10 inverts. Written as a
    // `!== true` test on purpose: §15.2 locates `authorizeRequest`'s own strict
    // equality test on `param.public` by taking the FIRST match of that source
    // line in this file, to prove the exemption sits inside its un-annotated
    // branch. Spelling the same form here — in code OR in a comment quoting it —
    // steals that position and breaks the pin without changing any behaviour,
    // so do not "tidy" this into the strict-equality form.
    if ( param.public !== true ) {
        return requireAuthByDefault(req);
    }

    return false;   // explicitly exempted from the default gate
};

/**
 * Authorize a request against the route it matched.
 *
 * NO-OP (returns `true`) unless the route declares an authorization key
 * (`param.requireAuth: true`, `param.roles` and/or `param.policy`) — or unless the
 * bundle opted into #COMPLY10 deny-by-default, in which case an un-annotated route
 * is gated too, and only `param.public: true` exempts it. Evaluation order:
 * **authN → roles → policy** — an unauthenticated caller on a gated route always gets
 * the 401/bounce, never a 403 (it must not learn that the route is role- or
 * policy-restricted, only that it requires signing in). Roles and policy are
 * AND-composed: a route declaring both needs both to pass.
 *
 * AuthN resolves the EFFECTIVE principal: the session user when authenticated
 * (session wins), else — when `auth.machine` is enabled — the #MS3 machine
 * caller verified from a presented `Authorization: Bearer` key. A presented
 * but rejected Bearer credential terminates with the clean machine 401
 * (`WWW-Authenticate: Bearer`), never the login bounce.
 *
 * @param {object} controller - the per-request controller (its `throwError` / `pauseRequest`
 *                              write the response).
 * @param {object} req        - the request. Reads `req.routing.param.requireAuth`,
 *                              `req.routing.param.roles`, `req.routing.param.policy`,
 *                              `req.routing.param.public` and `req.routing.bundle`
 *                              (#COMPLY10),
 *                              `req.session.user` (and its `.roles`),
 *                              `req.headers.authorization` (#MS3, gated routes only),
 *                              `req.isXMLRequest` and `req[method]`; stamps
 *                              `req.machineCaller` on a machine match.
 * @param {object} res        - the response (the bounce writes to it directly).
 * @returns {boolean} `true` to continue to the action, `false` when the gate has already
 *                    terminated the response (401 / 302 / 403).
 *
 * @example
 * // core/router.js, before the DTO pipe and the action dispatch
 * if ( !authzGate.authorizeRequest(controller, request, response) ) {
 *     return; // the gate answered (401 / login bounce / 403) — never reach the action
 * }
 */
var authorizeRequest = function (controller, req, res) {

    if ( !req || !req.routing || !req.routing.param ) {
        return true;
    }

    var param = req.routing.param;

    // `param.roles` IMPLIES `requireAuth` — an unauthenticated caller can hold no
    // role, so a role-gated route authenticates first even without the explicit flag.
    // Strictly a NON-EMPTY ARRAY: the boot lint rejects every other declared shape,
    // so an invalid `roles` reaching this point (a string, null, an empty array)
    // must never HALF-gate the route.
    var mustMatchRoles = ( Array.isArray(param.roles) && param.roles.length > 0 );

    // `param.policy` IMPLIES `requireAuth` too — a policy judges an authenticated
    // user, and it is handed one. Strictly a NON-EMPTY STRING, for the same reason:
    // the boot lint rejects every other declared shape, so an invalid `policy`
    // reaching this point must never HALF-gate the route.
    var mustRunPolicy  = ( typeof(param.policy) == 'string' && param.policy !== '' );

    // Strictly `=== true`: the boot lint rejects any other type, so by request time the
    // flag is `true`, `false` or absent — and an absent/false flag must never gate.
    //
    // `isRouteGated` above answers the same question for callers that need the verdict
    // without the enforcement (the #B158 render-cache write guard). The two MUST move
    // together; §15 pins this structure and a truth-table test pins their agreement.
    if ( param.requireAuth !== true && !mustMatchRoles && !mustRunPolicy ) {
        // #COMPLY10 — the deny-by-default mode inverts THIS branch, and only this
        // branch: an un-annotated route becomes gated instead of open.
        //
        // `param.public` is tested INSIDE the un-annotated branch rather than
        // beside it, which is what makes the precedence STRUCTURAL rather than
        // conditional: a route carrying `public` alongside an explicit gate key
        // never reaches here at all, so `public` can never un-gate an explicitly
        // gated route. The boot lint refuses that contradiction outright — this
        // shape means a hand-built or tampered config still fails CLOSED instead
        // of depending on the lint having run.
        if ( param.public === true ) {
            return true;   // explicitly exempted from the default gate
        }
        if ( !requireAuthByDefault(req) ) {
            return true;   // mode off — the pre-#COMPLY10 no-op, byte-identical
        }
        // Mode ON, un-annotated, not exempt: fall through to the authN block below.
        // `roles` and `policy` are absent by definition on this path, so the only
        // reachable outcomes are the 401 and the login bounce — a 403 cannot occur
        // here, which preserves the shipped 401-vs-403 convention with no new code.
    }

    // The effective principal: the SESSION user when authenticated (session
    // wins — the machine path is never consulted for a signed-in caller),
    // else the #MS3 machine caller resolved from a presented Bearer key.
    var principal = null;
    if ( isAuthenticated(req) ) {
        principal = req.session.user;
    } else {
        var mconf = getMachineConf();
        if ( mconf && mconf.enabled === true ) {
            var token = getBearerToken(req);
            if ( token !== null ) {
                principal = verifyMachineToken(req, mconf, token);
            }
            // The custom hook — AFTER the built-in map (first success wins),
            // and REGARDLESS of Bearer presence: it may verify another sync
            // scheme entirely (x-api-key, an HMAC header, a JWT).
            if ( !principal && typeof(mconf.authenticator) == 'string' && mconf.authenticator !== '' ) {
                principal = runAuthenticator(req, mconf.authenticator);
            }
            if ( !principal && token !== null ) {
                // A Bearer was PRESENTED and both the map and the hook
                // rejected it: the clean machine 401 (WWW-Authenticate),
                // never the login bounce. A custom-scheme miss (no Bearer)
                // falls through to the ordinary path below instead.
                return denyMachineUnauthenticated(controller, req, res);
            }
        }
        // Machine auth disabled, or no Bearer presented: the pre-#MS3 path,
        // byte-identical (bounce or plain 401 per denyUnauthenticated).
    }

    if ( !principal ) {
        return denyUnauthenticated(controller, req, res);
    }

    // authN passed — from here every denial is a 403, never a 401.
    if ( mustMatchRoles && !hasAnyRole(principal, param.roles) ) {
        return denyForbidden(controller, req,
            ( principal.machine === true )
                ? 'the machine caller holds none of the required roles'
                : 'the session user holds none of the required roles',
            '403-roles');
    }

    // Roles AND policy: a route declaring both has already passed roles by here.
    if ( mustRunPolicy ) {
        return runPolicy(controller, req, param.policy, principal);
    }

    return true;
};

module.exports = {
    authorizeRequest      : authorizeRequest,
    isRouteGated          : isRouteGated,
    isAuthenticated       : isAuthenticated,
    hasAnyRole            : hasAnyRole,
    registerPolicy        : registerPolicy,
    registerAuthenticator : registerAuthenticator
};
