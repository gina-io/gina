/**
 * #FIN6 — Idempotency-Key request deduplication at the router band, per the
 * IETF draft (draft-ietf-httpapi-idempotency-key-header): a client-generated
 * `Idempotency-Key` header makes a retried mutation return the RECORDED first
 * response instead of executing twice.
 *
 * Participation is opt-in TWICE: `server.idempotency.enabled` arms the gate,
 * and a route joins only when routing.json declares top-level
 * `idempotency: true` (or `{ required: true }`, which answers 400 when the
 * header is missing). Everything else is byte-identical to today.
 *
 * Ordering: core/router.js runs this gate at BOTH dispatch sites AFTER the
 * rate-limit verdict (a throttled caller must never touch the reservation
 * store) and BEFORE the DTO pipe — 401 -> 429 -> 409/422/replay -> 422.
 *
 * Mechanics over the #KV1 primitive:
 *  - the first request bearing a key RESERVES the operation with `setnx` +
 *    an in-flight TTL (crash-safe by expiry: a dead process's reservation
 *    self-releases and a retry re-executes), then executes normally with a
 *    capture context stamped on the request;
 *  - `controller.render-json.js` records the response envelope at its single
 *    stringify choke point — status, ALLOWLISTED headers (`content-type`,
 *    `location`; `set-cookie` is never stored), body up to `maxBodySize`,
 *    and the request-payload fingerprint — under the retention TTL;
 *  - a retry with the same key + payload is answered with the recorded
 *    envelope plus `Idempotency-Replayed: true`;
 *  - a duplicate while the original is IN FLIGHT gets 409 + Retry-After
 *    (the draft's resource-conflict shape);
 *  - the same key with a DIFFERENT payload gets 422 (the draft's reuse rule;
 *    the fingerprint is sha256 over the verbatim `req.rawBody` when present,
 *    else over the JSON-serialized parsed body — best-effort for non-JSON
 *    content types);
 *  - responses >= 500, bodies over `maxBodySize`, and any response that never
 *    passes through renderJSON (a template render, a redirect, an error
 *    egress) RELEASE the reservation so retries re-execute — only what was
 *    recorded is ever replayed.
 *
 * A request with NO resolvable principal is SKIPPED, never reserved: the
 * reservation key carries the caller identity (`u:`/`m:`, the rate-limit
 * `deriveKey` precedence, which mirrors `authorizeRequest`), so a stored
 * response can never cross principals — the render-cache authz+cache lesson
 * (#B158) applied at design time. Anonymous dedup would let a guessed or
 * leaked key replay another user's stored response.
 *
 * Failure policy is the NAMESPACE's `failMode`, not a second knob here:
 *  - `open`   → a backend error degrades each op to its miss-shaped result
 *               inside the kv facade; the gate then proceeds WITHOUT dedup
 *               (the honest fallback is exactly no-idempotency).
 *  - `closed` → the rejection reaches the gate's own handler, which answers
 *               503 + Retry-After (the caller's operation is not safe to run
 *               without accounting — the rate-limit open-circuit shape),
 *               never a hang: the handler IS the promise's ownership.
 * Deduplication SCOPE follows the namespace's backend: in-memory dedups PER
 * PROCESS (a retry landing on another replica RE-EXECUTES — the resolver
 * warns); replica-safe dedup needs a redis- or sqlite-backed namespace.
 *
 * @module gina/lib/idempotency
 */

var crypto = require('crypto');
// #COMPLY2 — audit auto-events for dedup denials, the rate-limit import shape
// (one-way: lib/audit never requires this module; emitAuthzDenied is contained
// and can never affect the denial itself).
var audit  = require('../../audit/src/main');
// The principal resolver — the SAME precedence as the rate-limit gate
// (session wins, then the machine caller; unresolvable -> null), so the two
// router-band gates can never disagree about who a caller is.
var rateLimit = require('../../rate-limit/src/main');

/**
 * Response headers stored in an envelope and replayed. Everything else —
 * `set-cookie` above all — is deliberately dropped: a replay must never
 * re-issue another execution's session material.
 * @constant
 * @inner
 * @type {string[]}
 */
var ALLOWLISTED_HEADERS = ['content-type', 'location'];

/**
 * Tolerant read of the `Idempotency-Key` header value. The draft types it as
 * a Structured Field String (DQUOTE-wrapped, `\`-escaped — RFC 8941 §3.3.3);
 * bare tokens are accepted too so a hand-rolled client is not rejected on
 * quoting alone. Validation only — the raw header is never rewritten.
 *
 * @param {string} [raw] - The raw header field value.
 * @returns {?string} The key, or `null` when absent/empty.
 *
 * @example
 *     parseIdempotencyKey('"8e03978e-40d5"'); // '8e03978e-40d5'
 *     parseIdempotencyKey('bare-token');      // 'bare-token'
 *     parseIdempotencyKey('""');              // null
 */
function parseIdempotencyKey(raw) {
    if ( typeof(raw) != 'string' ) {
        return null;
    }
    var s = raw.trim();
    if ( s.length > 1 && s.charAt(0) === '"' && s.charAt(s.length - 1) === '"' ) {
        s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
    }
    return ( s === '' ) ? null : s;
}

/**
 * Fingerprint the request payload for the draft's key-reuse rule. sha256 over
 * the verbatim `req.rawBody` when present (byte-exact for JSON bodies — the
 * #B28 contract), else over the JSON-serialized parsed body — deterministic
 * per content type, best-effort for non-JSON payloads.
 *
 * @param {object} req - The request.
 * @returns {string} sha256 hex digest.
 */
function fingerprint(req) {
    var src;
    if ( req && typeof(req.rawBody) == 'string' && req.rawBody.length > 0 ) {
        src = req.rawBody;
    } else {
        var parsed = ( req && typeof(req.body) != 'undefined' ) ? req.body
                   : ( req && typeof(req.post) != 'undefined' ) ? req.post
                   : null;
        src = JSON.stringify(parsed);
        if ( typeof(src) != 'string' ) { src = 'null'; }
    }
    return crypto.createHash('sha256').update(src).digest('hex');
}

/**
 * Build the reservation key: principal + method + route rule + hashed client
 * key. The principal makes cross-principal replay impossible by construction;
 * the method + rule scope the key to ONE operation (the same key on a second
 * endpoint is simply a different operation, never a 422). The client key is
 * always sha256-folded (opaque, unbounded input); a belt folds the WHOLE key
 * when principal + rule alone approach the kv 512-char key cap.
 *
 * @param {string} principal - `'u:<id>'` / `'m:<name>'` (rate-limit `deriveKey` output).
 * @param {string} method    - Upper-cased HTTP method.
 * @param {string} rule      - The route rule (`req.routing.rule`).
 * @param {string} idemKey   - The parsed client key.
 * @returns {string} The reservation key (<= 512 chars).
 */
function deriveResKey(principal, method, rule, idemKey) {
    var key = 'idem:' + principal + ':' + method + ':' + rule + ':'
        + crypto.createHash('sha256').update(idemKey).digest('hex');
    if ( key.length > 500 ) {
        key = 'idem:h:' + crypto.createHash('sha256').update(key).digest('hex');
    }
    return key;
}

/**
 * Best-effort response-header write — the verdict status itself is the
 * contract (the rate-limit/authz `WWW-Authenticate` mould: guarded on
 * `headersSent` + `setHeader` presence, try/caught so a bare test stub can
 * never turn a verdict into a throw).
 *
 * @inner
 * @param {object} res     - The response.
 * @param {object} headers - Field-name -> field-value map.
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
 * Serve a recorded envelope: the stored allowlisted headers, the marker the
 * draft does not define but debuggability demands (`Idempotency-Replayed`),
 * the recorded status, the recorded body. Cross-engine via the compat
 * response surface (`setHeader`/`statusCode`/`end`), try/caught — a replay
 * that cannot write has nothing further to do.
 *
 * @inner
 * @param {object} response - The response.
 * @param {object} rec      - The stored envelope (`state: 'done'`).
 * @returns {undefined}
 */
function _replay(response, rec) {
    var headers = {};
    var stored  = rec.headers || {};
    for (var h in stored) { headers[h] = stored[h]; }
    headers['Idempotency-Replayed'] = 'true';
    _setHeaders(response, headers);
    try {
        if ( response && !response.headersSent ) {
            response.statusCode = rec.status || 200;
        }
        if ( response && typeof(response.end) == 'function' ) {
            response.end(( typeof(rec.body) == 'string' ) ? rec.body : '');
        }
    } catch (err) {
        // best-effort — see above
    }
}

/**
 * The store-outage verdict (`failMode: 'closed'`): the operation is not safe
 * to run without dedup accounting, and the caller must not be told anything
 * else — 503 + Retry-After, the rate-limit open-circuit shape. This handler
 * IS the promise's ownership.
 *
 * @inner
 * @param {object} request    - The request.
 * @param {object} response   - The response.
 * @param {object} controller - The per-request controller.
 * @param {object} conf       - The resolved conf.
 * @param {Error}  err        - The backend error.
 * @returns {boolean} `false` (answered).
 */
function _storeOutage(request, response, controller, conf, err) {
    _setHeaders(response, { 'Retry-After': String(conf.retryAfterSec) });
    try {
        console.warn('[idempotency] namespace `' + conf.namespace + '` unavailable (failMode=closed): ' + (err && err.message || err));
    } catch (e) {}
    audit.emitAuthzDenied(request, '503-idempotency'); // #COMPLY2 auto-event — contained
    controller.throwError({
        status : 503,
        error  : 'Service temporarily unavailable'
    });
    return false;
}

/**
 * Resolve `server.idempotency` once at engine start (the rate-limit resolver
 * shape, stamped on the engine instance so the policy survives dev-mode hot
 * reloads and dies on restart).
 *
 * Doctrine, verbatim from the #MS5/#MS6 resolvers: structurally invalid
 * values on an ENABLED block are a boot refusal (throw), NOT a
 * warn-and-disable — silently running without the dedup the operator asked
 * for is the fail-open shape the storage/kv boot bands refuse. Dormant
 * (`{enabled:false}`) unless `enabled` is strictly `true`.
 *
 * Warn-tier findings (never refusals): a memory-backed namespace (dedup is
 * PER PROCESS — a retry landing on another replica RE-EXECUTES), a
 * redis-backed namespace missing the fail-fast trio, unrecognized keys.
 *
 * @param {object} serverConf              - The bundle's runtime `server` block (post-fold).
 * @param {object} deps                    - Injected dependencies.
 * @param {object} deps.kv                 - The kv facade (`lib.kv`) — namespace existence check.
 * @param {object} [deps.kvSettings]       - `settings.kv` (backend-honesty warns).
 * @param {object} [deps.connectors]       - `connectors.json` content (redis-tuning warn).
 * @param {object} [deps.routing]          - The bundle's routing table (per-route opt-in lint).
 * @param {function(string)} [deps.warn]   - Warn sink (default `console.warn`).
 * @returns {object} `{enabled:false}` or `{enabled:true, namespace, keyField,
 *                   ttlMs, inflightTtlMs, maxBodySize, retryAfterSec, ns}`.
 * @throws {Error} On any structurally invalid value in an enabled block, an
 *                 undeclared namespace, or a malformed per-route opt-in.
 */
function resolveConf(serverConf, deps) {
    var block = serverConf && serverConf.idempotency;
    if ( !block || block.enabled !== true ) {
        return { enabled: false };
    }
    deps = deps || {};
    var _warn = ( typeof(deps.warn) == 'function' ) ? deps.warn : function(m){ console.warn('[idempotency] ' + m); };

    if ( typeof(block.namespace) != 'string' || block.namespace === '' ) {
        throw new Error('[SERVER][#FIN6] `server.idempotency.namespace` must name a declared kv namespace — got `' + block.namespace + '`');
    }
    if ( typeof(block.keyField) != 'string' || block.keyField === '' ) {
        throw new Error('[SERVER][#FIN6] `server.idempotency.keyField` is required — name the `session.user` property that identifies a caller (machine callers key on their registered name automatically)');
    }
    var ttlMs = 86400000; // 24h — publish your retention policy, per the draft
    if ( typeof(block.ttl) != 'undefined' ) {
        ttlMs = parseTimeout(block.ttl);
        if ( typeof(ttlMs) != 'number' || ttlMs < 1 ) {
            throw new Error('[SERVER][#FIN6] `server.idempotency.ttl` must be a positive duration (e.g. "24h", "1h", 3600000) — got `' + block.ttl + '`');
        }
    }
    var inflightTtlMs = 120000; // 2m — size above your slowest opted-in request
    if ( typeof(block.inflightTtl) != 'undefined' ) {
        inflightTtlMs = parseTimeout(block.inflightTtl);
        if ( typeof(inflightTtlMs) != 'number' || inflightTtlMs < 1 ) {
            throw new Error('[SERVER][#FIN6] `server.idempotency.inflightTtl` must be a positive duration (e.g. "2m", "30s", 120000) — got `' + block.inflightTtl + '`');
        }
    }
    var maxBodySize = 262144; // 256KB — a larger response releases instead of storing
    if ( typeof(block.maxBodySize) != 'undefined' ) {
        maxBodySize = block.maxBodySize;
        if ( typeof(maxBodySize) != 'number' || maxBodySize !== ~~maxBodySize || maxBodySize < 1 ) {
            throw new Error('[SERVER][#FIN6] `server.idempotency.maxBodySize` must be an integer >= 1 (bytes) — got `' + block.maxBodySize + '`');
        }
    }
    var retryAfterSec = 5;
    if ( typeof(block.retryAfter) != 'undefined' ) {
        var _raMs = parseTimeout(block.retryAfter);
        if ( typeof(_raMs) != 'number' || _raMs < 1 ) {
            throw new Error('[SERVER][#FIN6] `server.idempotency.retryAfter` must be a positive duration (e.g. "5s", 5000) — got `' + block.retryAfter + '`');
        }
        retryAfterSec = Math.max(1, Math.round(_raMs / 1000));
    }
    var KNOWN = { enabled: 1, namespace: 1, keyField: 1, ttl: 1, inflightTtl: 1, maxBodySize: 1, retryAfter: 1 };
    for (var k in block) {
        if ( !KNOWN[k] ) {
            // the kv-namespace precedent: a silently-dropped key is a policy
            // the operator believes is set
            _warn('`server.idempotency.' + k + '` is not a recognized key — it was ignored');
        }
    }

    if ( !deps.kv || typeof(deps.kv.get) != 'function' ) {
        throw new Error('[SERVER][#FIN6] idempotency needs the kv primitive — no kv facade reached the resolver');
    }
    var ns;
    try {
        ns = deps.kv.get(block.namespace);
    } catch (kvErr) {
        // refuse, never degrade silently to a backend the operator did not ask for
        throw new Error('[SERVER][#FIN6] `server.idempotency.namespace` = `' + block.namespace + '` is not usable: ' + (kvErr.message || kvErr));
    }

    var nsConf    = deps.kvSettings && deps.kvSettings.namespaces && deps.kvSettings.namespaces[block.namespace];
    var storeName = nsConf && nsConf.store;
    if ( !storeName ) {
        _warn('namespace `' + block.namespace + '` is MEMORY-backed: deduplication is PER PROCESS — a retry landing on another replica RE-EXECUTES the operation. Replica-safe idempotency needs a redis- or sqlite-backed namespace');
    } else {
        var connEntry = deps.connectors && deps.connectors[storeName];
        if ( connEntry && connEntry.connector === 'redis'
                && ( connEntry.enableOfflineQueue !== false || typeof(connEntry.commandTimeout) == 'undefined' ) ) {
            _warn('redis-backed namespace `' + block.namespace + '`: set `enableOfflineQueue: false` and a `commandTimeout` on connectors.json entry `' + storeName + '` — with ioredis defaults an outage QUEUES every gated request (neither failMode ever fires) instead of degrading. The render-cache L2 ships this exact fail-fast trio');
        }
    }

    if ( deps.routing && typeof(deps.routing) == 'object' ) {
        for (var rule in deps.routing) {
            var ri = deps.routing[rule] && deps.routing[rule].idempotency;
            if ( typeof(ri) == 'undefined' || ri === false || ri === true ) { continue; }
            if ( !ri || typeof(ri) != 'object' || Array.isArray(ri) ) {
                throw new Error('[SERVER][#FIN6] route `' + rule + '`: `idempotency` must be `true`, `false` or `{ required: <boolean> }` — got `' + JSON.stringify(ri) + '`');
            }
            if ( typeof(ri.required) != 'undefined' && typeof(ri.required) != 'boolean' ) {
                throw new Error('[SERVER][#FIN6] route `' + rule + '`: `idempotency.required` must be a boolean — got `' + JSON.stringify(ri.required) + '`');
            }
            for (var rk in ri) {
                if ( rk !== 'required' ) {
                    _warn('route `' + rule + '`: `idempotency.' + rk + '` is not a recognized key — it was ignored');
                }
            }
        }
    }

    return { enabled: true, namespace: block.namespace, keyField: block.keyField, ttlMs: ttlMs, inflightTtlMs: inflightTtlMs, maxBodySize: maxBodySize, retryAfterSec: retryAfterSec, ns: ns };
}

/**
 * Gate one request. Called by `core/router.js` at BOTH dispatch sites, after
 * the rate-limit verdict and only when the resolved conf is armed.
 *
 * Returns `null` — synchronously, NO promise minted — when the gate does not
 * apply: the route is not opted in, no principal resolved, or the key is
 * absent on a non-`required` route. The router then continues on today's
 * exact synchronous band.
 *
 * Otherwise returns a promise settling `true` (proceed — the first execution,
 * with a capture context stamped on the request and a finish release-belt
 * armed) or `false` (this gate has ANSWERED the request: a served replay,
 * 409 in-flight, 422 payload mismatch, 400 missing-required-key, or 503 when
 * a fail-closed namespace erred). Every terminal is owned inside this
 * function — an unowned rejection in the dispatch spine is a hung request
 * with no visible log line.
 *
 * @param {object} request    - The request (post-`authorizeRequest`).
 * @param {object} response   - The response.
 * @param {object} controller - The per-request controller (its `throwError` writes denials).
 * @param {object} conf       - The instance-stamped resolved conf (`resolveConf` output, enabled).
 * @returns {?Promise<boolean>} `null` (inapplicable — continue sync), or the verdict promise.
 */
function gate(request, response, controller, conf) {
    var routeIdem = ( request && request.routing ) ? request.routing.idempotency : undefined;
    if ( !routeIdem ) {
        return null; // not opted in (`undefined`, the warm builder's `null`, or explicit `false`)
    }
    var principal = rateLimit.deriveKey(request, conf);
    if ( principal === null ) {
        return null; // anonymous — a stored response must never cross principals (#B158's lesson)
    }
    var idemKey = parseIdempotencyKey(( request.headers ) ? request.headers['idempotency-key'] : undefined);
    if ( idemKey === null ) {
        if ( routeIdem === true || routeIdem.required !== true ) {
            return null; // key optional and absent — process normally, nothing to dedup
        }
        audit.emitAuthzDenied(request, '400-idempotency-key-required'); // #COMPLY2 auto-event — contained
        controller.throwError({
            status : 400,
            error  : 'The Idempotency-Key request header is required for this operation'
        });
        return Promise.resolve(false);
    }

    var fp     = fingerprint(request);
    var method = String(request.method || 'POST').toUpperCase();
    var rule   = ( request.routing && request.routing.rule ) ? String(request.routing.rule) : 'route';
    var resKey = deriveResKey(principal, method, rule, idemKey);

    return conf.ns.setnx(resKey, { v: 1, state: 'processing', fp: fp, at: Date.now() }, { ttl: conf.inflightTtlMs }).then(function onReservation(won) {
        if ( won ) {
            // First execution — stamp the capture context renderJSON records
            // through, and arm the release-belt: anything that finishes
            // WITHOUT recording (a template render, a redirect, an error
            // egress, a 5xx) releases the reservation so a retry re-executes.
            request._idemCapture = { resKey: resKey, fp: fp, conf: conf, recorded: false };
            if ( response && typeof(response.on) == 'function' ) {
                response.on('finish', function onIdemFinish() {
                    if ( request._idemCapture && !request._idemCapture.recorded ) {
                        request._idemCapture.recorded = true; // the belt is one-shot
                        conf.ns.del(resKey).then(null, function () {});
                    }
                });
            }
            return true;
        }
        return conf.ns.get(resKey).then(function onExisting(rec) {
            if ( rec === null || typeof(rec) != 'object' ) {
                // The reservation vanished between setnx and get (TTL expiry
                // race), or a failMode:'open' namespace degraded both ops to
                // their miss shapes: proceed WITHOUT dedup — the honest
                // fallback is exactly no-idempotency, never a denial.
                return true;
            }
            if ( rec.state === 'processing' ) {
                // The draft's resource-conflict shape for a retry while the
                // original is outstanding.
                _setHeaders(response, { 'Retry-After': String(conf.retryAfterSec) });
                audit.emitAuthzDenied(request, '409-idempotency-in-flight'); // #COMPLY2 auto-event — contained
                controller.throwError({
                    status : 409,
                    error  : 'A request with this Idempotency-Key is still being processed'
                });
                return false;
            }
            if ( rec.fp !== fp ) {
                // The draft's reuse rule: a key MUST NOT be reused with a
                // different request payload.
                audit.emitAuthzDenied(request, '422-idempotency-payload-mismatch'); // #COMPLY2 auto-event — contained
                controller.throwError({
                    status : 422,
                    error  : 'This Idempotency-Key was already used with a different request payload'
                });
                return false;
            }
            _replay(response, rec);
            return false;
        }, function onGetError(err) {
            return _storeOutage(request, response, controller, conf, err);
        });
    }, function onSetnxError(err) {
        return _storeOutage(request, response, controller, conf, err);
    });
}

/**
 * Record the response envelope for an idempotency-reserved request. Called by
 * `controller.render-json.js` at its single stringify choke point (guarded on
 * `request._idemCapture`, so every other request costs one property read).
 * Fire-and-forget: the send never waits on the store and the write's
 * rejection is owned here.
 *
 * The `recorded` flag flips SYNCHRONOUSLY before any async work — the finish
 * release-belt reads it, and the belt firing after `end()` must see the flag
 * even while the store write is still in flight. A response >= 500 or a body
 * over `maxBodySize` RELEASES the reservation instead of storing: a transient
 * failure must not become sticky until the retention TTL, and an envelope
 * that cannot be replayed honestly must not exist.
 *
 * @param {object} request  - The request (carrying `_idemCapture`).
 * @param {object} response - The response (status + headers already resolved).
 * @param {string} body     - The serialized response body about to be written.
 * @returns {undefined}
 */
function record(request, response, body) {
    var cap = ( request ) ? request._idemCapture : undefined;
    if ( !cap || cap.recorded === true ) {
        return;
    }
    cap.recorded = true; // SYNC — the finish-belt reads this
    var conf    = cap.conf;
    var status  = ( response && typeof(response.statusCode) == 'number' ) ? response.statusCode : 200;
    var bodyStr = ( typeof(body) == 'string' ) ? body : '';
    if ( status >= 500 || bodyStr.length > conf.maxBodySize ) {
        conf.ns.del(cap.resKey).then(null, function () {});
        return;
    }
    var headers = {};
    var all = ( response && typeof(response.getHeaders) == 'function' ) ? (response.getHeaders() || {}) : {};
    for (var i = 0; i < ALLOWLISTED_HEADERS.length; i++) {
        var h = ALLOWLISTED_HEADERS[i];
        if ( typeof(all[h]) != 'undefined' ) { headers[h] = all[h]; }
    }
    conf.ns.set(cap.resKey, {
        v: 1, state: 'done', status: status, headers: headers, body: bodyStr, fp: cap.fp
    }, { ttl: conf.ttlMs }).then(null, function onRecordError(err) {
        try {
            console.warn('[idempotency] failed to record the response envelope for `' + cap.resKey + '`: ' + (err && err.message || err));
        } catch (e) {}
    });
}

module.exports = {
    resolveConf         : resolveConf,
    gate                : gate,
    record              : record,
    parseIdempotencyKey : parseIdempotencyKey,
    deriveResKey        : deriveResKey,
    fingerprint         : fingerprint
};
