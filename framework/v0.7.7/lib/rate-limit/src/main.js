/**
 * #MS6 — identified-caller quota enforcement at the router band.
 *
 * QUOTA semantics, deliberately NOT flood control: the gate runs AFTER
 * `authzGate.authorizeRequest` (the call that resolves the principal — it is
 * the only writer of `req.machineCaller`, and session identity is its own
 * predicate) and BEFORE the DTO pipe (a throttled caller must not receive a
 * 422 field map — the same disclosure ordering that puts authz's 401 before
 * the 422). Anonymous flood control stays where it already lives: the edge
 * proxy in front of the bundle, and the #H9 HTTP/2 rapid-reset guard. A
 * request with NO resolvable principal is therefore SKIPPED, never bucketed:
 * keying unidentified callers by IP is dishonest behind a proxy (every
 * `socket.remoteAddress` is the proxy's — one bucket for the whole internet,
 * see lib/maintenance's `evaluateBypass` rationale), and the proxied
 * classification itself has a defeat on record, so an IP fallback would hand
 * an attacker an ESCAPE from limiting by spoofing the classification.
 *
 * Counters are fixed windows over the #KV1 primitive: `incr(key, 1, {ttl})`
 * — the TTL applies on CREATE only (every backend enforces this server-side:
 * redis via an EXISTS-guarded Lua script, sqlite inside BEGIN IMMEDIATE, the
 * in-memory map by keeping the existing expiry), so the first hit of a window
 * opens it and the expiry closes it with no read-modify-write race. Choosing
 * the namespace's BACKEND is choosing the quota's SCOPE: an in-memory
 * namespace counts PER PROCESS (each replica grants the full quota again);
 * replica-shared quotas need a redis- or sqlite-backed namespace. The boot
 * resolver warns about exactly this.
 *
 * Failure policy is the NAMESPACE's `failMode`, not a second knob here:
 *  - `open`   → a backend error degrades `incr` to `null` inside the facade
 *               (which warns) and the gate ALLOWS without headers. The
 *               explicit `count === null` check is load-bearing: `null <= N`
 *               is `true` by coercion, so an unguarded compare would allow
 *               WITH wrong header arithmetic instead of honestly declining
 *               to report.
 *  - `closed` → the rejection reaches the gate's own handler, which answers
 *               **503** + `Retry-After` (the caller is NOT over quota; the
 *               service cannot account — the #MS5 open-circuit shape), never
 *               a hang: this handler IS the promise's ownership.
 * Give the limiter its OWN namespace so its `failMode` is unambiguously the
 * limiter's outage policy. For a redis-backed namespace, set
 * `enableOfflineQueue: false` + a `commandTimeout` on the connectors entry
 * (the render-cache L2 fail-fast trio) — with ioredis defaults an outage
 * QUEUES every gated request instead of erroring, so neither mode ever fires
 * and requests hang until reconnect. The resolver warns when the trio is
 * missing.
 *
 * Response surface (draft-ietf-httpapi-ratelimit-headers-11, structured
 * fields): `RateLimit-Policy: "<policy>";q=<limit>;w=<windowSec>` and
 * `RateLimit: "<policy>";r=<remaining>` on ALLOWED limited requests;
 * a denial adds `;t=<secondsToReset>` and `Retry-After` (RFC 9110 — the
 * field a client MUST prefer when both are present). `t` is deliberately
 * omitted on the allow path: reporting it honestly would cost a second kv
 * round-trip per allowed request, and the parameter is OPTIONAL in the
 * draft; the deny path pays that one extra `ttl()` read instead, where it
 * prices in the reset the caller actually needs.
 *
 * Per-route `rateLimit` (routing.json, TOP-LEVEL on the route — the #CSRF2
 * trap): `false` exempts the route; `{ limit, window }` REPLACES the default
 * policy for that route — its requests count in their OWN bucket
 * (`<principal>:<rule>`), not against the global one. Partial objects
 * inherit the missing key from the default (the route-`cache` inheritance
 * shape). Shapes are linted at BOOT by the resolver (the DTO boot-registrar
 * doctrine: a typo surfaces at deploy, not at first request).
 *
 * @module gina/lib/rate-limit
 */

var crypto = require('crypto');
// #COMPLY2 — audit auto-events for quota denials, the authz-gate import shape
// (one-way: lib/audit never requires this module; emitAuthzDenied is contained
// and can never affect the denial itself).
var audit  = require('../../audit/src/main');

/**
 * Serialize a Structured Field String (RFC 8941 §3.3.3): DQUOTE-wrapped with
 * `\` and `"` backslash-escaped. Policy identifiers are expected to be ASCII
 * (routing rule names are); non-ASCII would be outside the sf-string grammar
 * and is not validated here.
 *
 * @param {string} s - Raw string.
 * @returns {string} The serialized sf-string, quotes included.
 */
function sfString(s) {
    return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Build a `RateLimit-Policy` member (draft-11): `"<name>";q=<quota>;w=<windowSec>`.
 *
 * @param {string} name      - Policy identifier (sf-string-serialized).
 * @param {number} quota     - Quota units per window (`q`, REQUIRED by the draft).
 * @param {number} windowSec - Window length in seconds (`w`).
 * @returns {string} The header field value.
 */
function buildPolicyItem(name, quota, windowSec) {
    return sfString(name) + ';q=' + quota + ';w=' + windowSec;
}

/**
 * Build a `RateLimit` member (draft-11): `"<name>";r=<remaining>[;t=<sec>]`.
 * `t` (seconds until the window resets) is included on denials only — see the
 * module header for why the allow path omits it.
 *
 * @param {string} name        - Policy identifier (must match a `RateLimit-Policy` member).
 * @param {number} remaining   - Remaining quota (`r`, REQUIRED by the draft; never negative).
 * @param {number} [resetSec]  - Seconds until the window resets (`t`).
 * @returns {string} The header field value.
 */
function buildRateLimitItem(name, remaining, resetSec) {
    var item = sfString(name) + ';r=' + remaining;
    if ( typeof(resetSec) != 'undefined' ) {
        item += ';t=' + resetSec;
    }
    return item;
}

/**
 * Derive the quota key for this request's principal, or `null` when no
 * principal is resolvable (the request is then SKIPPED, never bucketed).
 *
 * Precedence mirrors `authorizeRequest` exactly — the SESSION user when
 * authenticated (session wins; the machine identity is never consulted for a
 * signed-in caller), else the #MS3 machine caller:
 *  - session: `'u:' + String(session.user[conf.keyField])`. The field is
 *    operator-NAMED (`server.rateLimit.keyField`) because `session.user` is
 *    app-owned shape — a guessed default chain would mis-key silently. A
 *    user record where the named field is absent/empty is UNIDENTIFIED.
 *  - machine: `'m:' + machineCaller.name` (shape framework-forced by the
 *    authz gate: `{ name, roles, machine: true }`).
 * Values longer than 180 chars are sha256-hexed so the final key (class
 * prefix + optional `:<rule>` suffix) always fits the kv 512-char key cap.
 *
 * @param {object} req  - The request (post-`authorizeRequest`).
 * @param {object} conf - The resolved conf (`keyField`).
 * @returns {?string} `'<class>:<value>'`, or `null` (skip).
 */
function deriveKey(req, conf) {
    var cls = null, raw = null;
    if ( req && req.session && typeof(req.session) == 'object' && req.session.user ) {
        var u = req.session.user;
        var v = ( u && typeof(u) == 'object' ) ? u[conf.keyField] : undefined;
        if ( typeof(v) != 'undefined' && v !== null && String(v) !== '' ) {
            cls = 'u';
            raw = String(v);
        }
    } else if ( req && req.machineCaller && req.machineCaller.machine === true && req.machineCaller.name ) {
        cls = 'm';
        raw = String(req.machineCaller.name);
    }
    if ( !cls ) {
        return null;
    }
    if ( raw.length > 180 ) {
        raw = crypto.createHash('sha256').update(raw).digest('hex');
    }
    return cls + ':' + raw;
}

/**
 * Best-effort response-header write — the deny status itself is the contract
 * (the authz `WWW-Authenticate` mould: guarded on `headersSent` + `setHeader`
 * presence, try/caught so a bare test stub can never turn a verdict into a
 * throw).
 *
 * @inner
 * @param {object} res     - The response.
 * @param {object} headers - Field-name → field-value map.
 * @returns {undefined}
 */
function _setHeaders(res, headers) {
    try {
        if ( res && !res.headersSent && typeof(res.setHeader) == 'function' ) {
            for (var h in headers) {
                res.setHeader(h, headers[h]);
            }
        }
    } catch (err) {
        // best-effort — the status itself is the contract
    }
}

/**
 * Resolve `server.rateLimit` once at engine start (the #MS5 resolver shape,
 * stamped on the engine instance so the policy survives dev-mode hot reloads
 * and dies on restart).
 *
 * Doctrine, verbatim from the #MS5 resolver: structurally invalid values on
 * an ENABLED block are a boot refusal (throw), NOT a warn-and-disable —
 * silently running without the protection the operator asked for is the
 * fail-open shape the storage/kv boot bands refuse. Dormant (`{enabled:false}`)
 * unless `enabled` is strictly `true`.
 *
 * Warn-tier findings (never refusals — enforcement works when the backend is
 * up; these govern outage latency and quota scope, the #CE1 discriminator):
 * a memory-backed namespace (per-process quotas), a redis-backed namespace
 * missing the fail-fast trio, unrecognized keys.
 *
 * @param {object} serverConf              - The bundle's runtime `server` block (post-fold).
 * @param {object} deps                    - Injected dependencies.
 * @param {object} deps.kv                 - The kv facade (`lib.kv`) — namespace existence check.
 * @param {object} [deps.kvSettings]       - `settings.kv` (backend-honesty warns).
 * @param {object} [deps.connectors]       - `connectors.json` content (redis-tuning warn).
 * @param {object} [deps.routing]          - The bundle's routing table (per-route override lint).
 * @param {function(string)} [deps.warn]   - Warn sink (default `console.warn`).
 * @returns {object} `{enabled:false}` or `{enabled:true, namespace, keyField, limit, windowMs, ns}`.
 * @throws {Error} On any structurally invalid value in an enabled block, an
 *                 undeclared namespace, or a malformed per-route override.
 */
function resolveConf(serverConf, deps) {
    var block = serverConf && serverConf.rateLimit;
    if ( !block || block.enabled !== true ) {
        return { enabled: false };
    }
    deps = deps || {};
    var _warn = ( typeof(deps.warn) == 'function' ) ? deps.warn : function(m){ console.warn('[rate-limit] ' + m); };

    if ( typeof(block.namespace) != 'string' || block.namespace === '' ) {
        throw new Error('[SERVER][#MS6] `server.rateLimit.namespace` must name a declared kv namespace — got `' + block.namespace + '`');
    }
    if ( typeof(block.keyField) != 'string' || block.keyField === '' ) {
        throw new Error('[SERVER][#MS6] `server.rateLimit.keyField` is required — name the `session.user` property that identifies a caller (machine callers key on their registered name automatically)');
    }
    var limit = block.limit;
    if ( typeof(limit) != 'number' || limit !== ~~limit || limit < 1 ) {
        throw new Error('[SERVER][#MS6] `server.rateLimit.limit` must be an integer >= 1 — got `' + limit + '`');
    }
    var windowMs = parseTimeout(block.window);
    if ( typeof(windowMs) != 'number' || windowMs < 1 ) {
        throw new Error('[SERVER][#MS6] `server.rateLimit.window` must be a positive duration (e.g. "1m", "30s", 60000) — got `' + block.window + '`');
    }
    var KNOWN = { enabled: 1, namespace: 1, keyField: 1, limit: 1, window: 1 };
    for (var k in block) {
        if ( !KNOWN[k] ) {
            // the kv-namespace precedent: a silently-dropped key is a policy
            // the operator believes is set
            _warn('`server.rateLimit.' + k + '` is not a recognized key — it was ignored');
        }
    }

    if ( !deps.kv || typeof(deps.kv.get) != 'function' ) {
        throw new Error('[SERVER][#MS6] rate limiting needs the kv primitive — no kv facade reached the resolver');
    }
    var ns;
    try {
        ns = deps.kv.get(block.namespace);
    } catch (kvErr) {
        // the kv `default`-naming-undeclared precedent: refuse, never degrade
        // silently to a backend the operator did not ask for
        throw new Error('[SERVER][#MS6] `server.rateLimit.namespace` = `' + block.namespace + '` is not usable: ' + (kvErr.message || kvErr));
    }

    var nsConf    = deps.kvSettings && deps.kvSettings.namespaces && deps.kvSettings.namespaces[block.namespace];
    var storeName = nsConf && nsConf.store;
    if ( !storeName ) {
        _warn('namespace `' + block.namespace + '` is MEMORY-backed: quotas count PER PROCESS — every replica grants the full quota again. Replica-shared quotas need a redis- or sqlite-backed namespace');
    } else {
        var connEntry = deps.connectors && deps.connectors[storeName];
        if ( connEntry && connEntry.connector === 'redis'
                && ( connEntry.enableOfflineQueue !== false || typeof(connEntry.commandTimeout) == 'undefined' ) ) {
            _warn('redis-backed namespace `' + block.namespace + '`: set `enableOfflineQueue: false` and a `commandTimeout` on connectors.json entry `' + storeName + '` — with ioredis defaults an outage QUEUES every gated request (neither failMode ever fires) instead of degrading. The render-cache L2 ships this exact fail-fast trio');
        }
    }

    if ( deps.routing && typeof(deps.routing) == 'object' ) {
        for (var rule in deps.routing) {
            var rl = deps.routing[rule] && deps.routing[rule].rateLimit;
            if ( typeof(rl) == 'undefined' || rl === false ) { continue; }
            if ( !rl || typeof(rl) != 'object' || Array.isArray(rl) ) {
                throw new Error('[SERVER][#MS6] route `' + rule + '`: `rateLimit` must be `false` (exempt) or an object — got `' + JSON.stringify(rl) + '`');
            }
            if ( typeof(rl.limit) != 'undefined' && ( typeof(rl.limit) != 'number' || rl.limit !== ~~rl.limit || rl.limit < 1 ) ) {
                throw new Error('[SERVER][#MS6] route `' + rule + '`: `rateLimit.limit` must be an integer >= 1 — got `' + rl.limit + '`');
            }
            if ( typeof(rl.window) != 'undefined' ) {
                var _w = parseTimeout(rl.window);
                if ( typeof(_w) != 'number' || _w < 1 ) {
                    throw new Error('[SERVER][#MS6] route `' + rule + '`: `rateLimit.window` must be a positive duration — got `' + rl.window + '`');
                }
            }
            for (var rk in rl) {
                if ( rk !== 'limit' && rk !== 'window' ) {
                    _warn('route `' + rule + '`: `rateLimit.' + rk + '` is not a recognized key — it was ignored');
                }
            }
        }
    }

    return { enabled: true, namespace: block.namespace, keyField: block.keyField, limit: limit, windowMs: windowMs, ns: ns };
}

/**
 * Gate one request. Called by `core/router.js` at BOTH dispatch sites, after
 * `authorizeRequest` returned true and only when the resolved conf is armed.
 *
 * Returns `null` — synchronously, NO promise minted — when the gate does not
 * apply: the route is exempt (`rateLimit: false`) or no principal resolved.
 * The router then continues on today's exact synchronous band.
 *
 * Otherwise returns a promise settling `true` (proceed — the router runs the
 * DTO pipe → hooks → action continuation) or `false` (this gate has ANSWERED
 * the request: 429 over quota, or 503 when a fail-closed namespace erred).
 * Every terminal is owned inside this function — an unowned rejection in the
 * dispatch spine is a hung request with no visible log line (the daemon
 * spawner filters child stderr), which is the exact shape being designed
 * against.
 *
 * @param {object} request    - The request (post-`authorizeRequest`).
 * @param {object} response   - The response.
 * @param {object} controller - The per-request controller (its `throwError` writes the denial).
 * @param {object} conf       - The instance-stamped resolved conf (`resolveConf` output, enabled).
 * @returns {?Promise<boolean>} `null` (inapplicable — continue sync), or the verdict promise.
 */
function gate(request, response, controller, conf) {
    var routeRl = ( request && request.routing ) ? request.routing.rateLimit : undefined;
    if ( routeRl === false ) {
        return null; // exempt route — sync fall-through
    }
    var key = deriveKey(request, conf);
    if ( key === null ) {
        return null; // unidentified caller — the edge proxy + #H9 own that class
    }

    var limit      = conf.limit;
    var windowMs   = conf.windowMs;
    var policyName = 'default';
    if ( routeRl && typeof(routeRl) == 'object' ) {
        // REPLACE semantics: an overridden route's requests count ONLY in its
        // own bucket. Partial objects inherit the missing key (the route-cache
        // inheritance shape). Shapes were linted at boot, so parse cannot fail
        // here — the fallback is belt.
        if ( typeof(routeRl.limit) != 'undefined' )  { limit    = routeRl.limit; }
        if ( typeof(routeRl.window) != 'undefined' ) { windowMs = parseTimeout(routeRl.window) || windowMs; }
        policyName = ( request.routing && request.routing.rule ) ? String(request.routing.rule) : 'route';
        key += ':' + policyName;
    }
    var windowSec  = Math.max(1, Math.round(windowMs / 1000));
    var policyItem = buildPolicyItem(policyName, limit, windowSec);

    return conf.ns.incr(key, 1, { ttl: windowMs }).then(function onCount(count) {
        if ( count === null ) {
            // failMode:'open' degraded — there is no reading. `null <= limit`
            // is TRUE by coercion, so an unguarded compare would allow WITH
            // wrong header arithmetic; this allows WITHOUT headers and lets
            // the facade's own per-operation degrade warn stand.
            return true;
        }
        if ( count <= limit ) {
            _setHeaders(response, {
                'RateLimit'        : buildRateLimitItem(policyName, limit - count),
                'RateLimit-Policy' : policyItem
            });
            return true;
        }
        // Deny. One extra kv read on the THROTTLED path only, for the honest
        // reset time; under either failMode a failed ttl() degrades to the
        // full window rather than blocking the verdict.
        return conf.ns.ttl(key).then(
            function (ms) { return ms; },
            function ()   { return null; }
        ).then(function onTtl(ms) {
            var tSec = ( typeof(ms) == 'number' && ms > 0 ) ? Math.ceil(ms / 1000) : windowSec;
            _setHeaders(response, {
                'Retry-After'      : String(tSec),
                'RateLimit'        : buildRateLimitItem(policyName, 0, tSec),
                'RateLimit-Policy' : policyItem
            });
            audit.emitAuthzDenied(request, '429'); // #COMPLY2 auto-event — contained, never affects the denial
            controller.throwError({
                status : 429,
                error  : 'Too many requests'
            });
            return false;
        });
    }, function onStoreError(err) {
        // failMode:'closed' — the namespace rejected. The caller is NOT over
        // quota and must not be told it is: 503 + Retry-After (the #MS5
        // open-circuit shape). This handler IS the promise's ownership — the
        // alternative is a silent hang.
        _setHeaders(response, { 'Retry-After': String(windowSec) });
        try {
            console.warn('[rate-limit] namespace `' + conf.namespace + '` unavailable (failMode=closed): ' + (err && err.message || err));
        } catch (e) {}
        audit.emitAuthzDenied(request, '503-rate-limit'); // #COMPLY2 auto-event — contained
        controller.throwError({
            status : 503,
            error  : 'Service temporarily unavailable'
        });
        return false;
    });
}

module.exports = {
    resolveConf        : resolveConf,
    gate               : gate,
    deriveKey          : deriveKey,
    sfString           : sfString,
    buildPolicyItem    : buildPolicyItem,
    buildRateLimitItem : buildRateLimitItem
};
