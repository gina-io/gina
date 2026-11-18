/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/message-validator
 *
 * The #FIN3 pluggable message-schema validation seam — the APPLICATION supplies
 * the validator (an XSD engine, a usage-guideline/Schematron checker, a sidecar
 * process, an in-process JSON-Schema library), the framework supplies the boot
 * registry, the async-capable router-band gate and the fail-closed refusal shape.
 *
 * A route opts in by naming a validator in `routing.json`:
 *
 *   "pain001-submit": {
 *       "method" : "POST",
 *       "url"    : "/payments/initiate",
 *       "param"  : { "control": "submitPayment", "messageValidator": "pain001" }
 *   }
 *
 * The name resolves to `<bundle>/message-validators/<name>.js` — a FACTORY module
 * (the `dtos/` convention; a factory rather than a bare validator so boot-time
 * setup has a home and the two cannot be confused, both being functions):
 *
 *   // <bundle>/message-validators/pain001.js
 *   module.exports = function setup(ctx) {
 *       // ctx = { bundle, env } — compile schemas / open a sidecar pool HERE;
 *       // a throw refuses the BOOT (deploy-time failure, never first-request).
 *       // The factory itself is SYNCHRONOUS (boot is); the returned validate
 *       // function may be async.
 *       return function validate(document, req) {
 *           // `document` is the VERBATIM request body string (`request.rawBody`
 *           // — for an XML body this is the exact bytes the client sent; for a
 *           // JSON body the raw string, with the parsed object still on
 *           // `req[method]`). `req` is the live request — read headers or
 *           // routing from it, but NEVER write the response: the gate owns
 *           // every terminal.
 *           return { valid: false, status: 422, errors: [ { message: 'cctPurpose missing', line: 12 } ] };
 *       };
 *   };
 *
 * ## The verdict contract
 *
 * `validate()` returns (or resolves to) a {@link MessageValidatorVerdict}:
 *   - `{ valid: true }`                     — proceed to the rest of the band.
 *   - `{ valid: false, status?, errors?, retryAfter? }` — refuse:
 *       - `status` 422 (default — well-formed but schema-invalid), 400 (not
 *         parseable as the expected format), or 503 (the CHECKER is unavailable
 *         — a sidecar down; optional `retryAfter` seconds sets `Retry-After`,
 *         the outage shape shared with the idempotency band). Any other status
 *         is a contract violation → 500, loud.
 *       - `errors` — an array of `{ message, line?, column?, path? }` objects
 *         forwarded verbatim on the 400/422 body under the top-level `errors`
 *         key (the `fields`-map sibling in the error envelope). The gate never
 *         truncates it — a validator expecting pathological documents should
 *         cap its own report.
 *   - a thrown error / rejected promise — 500, fail-closed (the request NEVER
 *     proceeds unvalidated), with the full stack logged server-side.
 *
 * ## Registration + lifecycle
 *
 * `core/server.js` walks `routing.json` at bundle BOOT and registers every
 * declared name through {@link register} — the factory runs there, once per
 * name, so a missing file / broken module / throwing factory refuses the boot
 * instead of silently disabling validation in production, and the request path
 * is an O(1) registry read. A validator file edit therefore needs a bundle
 * restart, exactly like DTOs, routing.json, forms and connectors.json. The
 * registry lives on `process.gina._messageValidators` (the `_dtos` /
 * `_policies` / `_authenticators` pattern) so it survives dev-mode
 * `refreshCore()` re-requires and dies on restart.
 *
 * ## Scope (slice 1, deliberate)
 *
 * - INBOUND only — the gate runs in the router dispatch band, after the 401 /
 *   429 / idempotency gates (their disclosure ordering is load-bearing) and
 *   BEFORE the DTO pipe (document-level before field-level). Emit-time
 *   (outbound) validation is a demand-gated follow-up; the registered module is
 *   a plain factory, so an application can already import and drive its own
 *   validator in tests or CI directly.
 *
 * - No `settings.json` surface — the route declaration is the entire opt-in
 *   (the `param.dto` precedent). A factory reads its own configuration however
 *   the application prefers.
 *
 * - String names only in `param.messageValidator`; a validator wanting
 *   per-route behaviour reads `req.routing.rule` off the request it is handed.
 */

var fs       = require('fs');
var nodePath = require('path');

/**
 * A message-validator verdict.
 *
 * @typedef {object} MessageValidatorVerdict
 * @property {boolean}  valid        - `true` to proceed; `false` to refuse the request.
 * @property {number}   [status]     - Refusal status: `400`, `422` (default) or `503`.
 * @property {object[]} [errors]     - Validation errors (`{ message, line?, column?, path? }`),
 *                                     forwarded verbatim on the 400/422 response body.
 * @property {number}   [retryAfter] - Seconds for the `Retry-After` header — honoured on `503` only.
 */

/**
 * Registry accessor. Parked on `process.gina` so the map survives dev-mode
 * `refreshCore()` re-requires (the `_dtos` / `_policies` / `_authenticators`
 * pattern) and resets on bundle restart.
 *
 * @inner
 * @returns {object} name -> validate function
 */
function getRegistry() {
    if ( !process.gina._messageValidators ) {
        process.gina._messageValidators = Object.create(null);
    }
    return process.gina._messageValidators;
}

/**
 * Resolve, build and register a bundle message validator at BOOT.
 *
 * Loads `<bundleSrcPath>/message-validators/<name>.js`, runs its exported
 * FACTORY synchronously with `ctx`, and registers the returned validate
 * function under `name`. Registering an already-registered name returns the
 * cached function without re-running the factory (several routes may share a
 * validator).
 *
 * Returns `null` — the caller (`core/server.js`) turns it into a boot
 * refusal naming the route — when the file is missing, the module does not
 * export a function, or the factory did not return a function. A `require()`
 * or factory throw propagates to the caller (same division of labour as
 * `lib/dto.load`).
 *
 * @function register
 * @param {string} bundleSrcPath - The bundle source dir (the `dtos/` resolver's sibling convention).
 * @param {string} name          - The validator name from `param.messageValidator`.
 * @param {object} ctx           - Factory context: `{ bundle, env }`.
 * @returns {function|null} The registered validate function, or `null` when unresolvable.
 *
 * @example
 * // core/server.js, inside the boot walk (throws are wrapped by the caller)
 * var fn = lib.messageValidator.register(srcPath, 'creditTransfer', { bundle: appName, env: env });
 */
var register = function(bundleSrcPath, name, ctx) {

    var reg = getRegistry();
    if ( typeof(reg[name]) == 'function' ) {
        return reg[name];
    }

    var file = nodePath.join(bundleSrcPath, 'message-validators', name + '.js');
    if ( !fs.existsSync(file) ) {
        return null;
    }

    var factory = require(file);        // may throw -> caller wraps into the boot refusal
    if ( typeof(factory) != 'function' ) {
        return null;
    }

    var validate = factory(ctx);        // may throw -> caller wraps (this IS the boot dry-run)
    if ( typeof(validate) != 'function' ) {
        return null;
    }

    reg[name] = validate;
    return validate;
};

/**
 * Read a registered validator.
 *
 * @function get
 * @param {string} name - The registered validator name.
 * @returns {function|null} The validate function, or `null` when not registered.
 *
 * @example
 * var validate = lib.messageValidator.get('creditTransfer');
 */
var get = function(name) {
    var fn = getRegistry()[name];
    return ( typeof(fn) == 'function' ) ? fn : null;
};

/**
 * Settle a validator verdict into a band decision.
 *
 * Owns every refusal terminal: 400/422 (with the optional `errors` array on
 * the body), 503 (+ best-effort `Retry-After`), and 500 on a contract
 * violation (non-verdict shape, unsupported status). Never writes the
 * response directly except the `Retry-After` header — `controller.throwError`
 * is the single egress (engine-agnostic, #ERRREF-paired, scope-gated).
 *
 * @inner
 * @param {MessageValidatorVerdict} verdict - What the validator returned.
 * @param {string} name       - The validator name (for loud contract-violation messages).
 * @param {object} response   - The response (the `Retry-After` write only).
 * @param {object} controller - The per-request controller (its `throwError` answers).
 * @returns {boolean} `true` to proceed, `false` when the gate has answered.
 */
function settleVerdict(verdict, name, response, controller) {

    if ( !verdict || typeof(verdict) != 'object' || typeof(verdict.valid) != 'boolean' ) {
        controller.throwError({
            status : 500,
            error  : '[message-validator] `'+ name +'` returned an unsupported verdict shape — the contract is `{ valid: <boolean>, status?: 400|422|503, errors?: [], retryAfter?: <seconds> }`.'
        });
        return false;
    }

    if ( verdict.valid === true ) {
        return true;
    }

    var status = ( typeof(verdict.status) == 'undefined' ) ? 422 : verdict.status;
    if ( status !== 400 && status !== 422 && status !== 503 ) {
        controller.throwError({
            status : 500,
            error  : '[message-validator] `'+ name +'` returned an unsupported refusal status `'+ status +'` — 400, 422 and 503 are the refusal statuses.'
        });
        return false;
    }

    if ( status === 503 ) {
        // The checker (not the document) is unavailable — the outage shape the
        // idempotency band uses. Retry-After is best-effort: the 503 itself is
        // the contract.
        var retryAfter = verdict.retryAfter;
        if ( typeof(retryAfter) == 'number' && isFinite(retryAfter) && retryAfter > 0 ) {
            try {
                if ( response && !response.headersSent && typeof(response.setHeader) == 'function' ) {
                    response.setHeader('Retry-After', String(Math.ceil(retryAfter)));
                }
            } catch (headerErr) {
                // best-effort — see above
            }
        }
        controller.throwError({
            status : 503,
            error  : 'Message validation is temporarily unavailable'
        });
        return false;
    }

    var errorObject = {
        status : status,
        error  : 'Message validation failed'
    };
    if ( Array.isArray(verdict.errors) ) {
        errorObject.errors = verdict.errors;
    }
    controller.throwError(errorObject);
    return false;
}

/**
 * The router-band gate.
 *
 * Dormant — the route declares no `param.messageValidator` — it returns `null`
 * SYNCHRONOUSLY and mints ZERO promises, so the wrapped band keeps today's
 * exact synchronous dispatch (the rate-limit / idempotency dormancy rule).
 * Armed, it returns a promise settling `true` (proceed to the rest of the
 * band) or `false` (the gate has already answered — 400/422/503/500); every
 * terminal is owned inside the promise, and the router's `.catch` is the
 * last-resort belt only.
 *
 * The validator receives the VERBATIM body string (`request.rawBody`; `''`
 * when no string body was accumulated — multipart and body-less requests) and
 * the live request. A sync return value and a returned promise are both
 * accepted (`Promise.resolve` normalises); a throw or rejection is a 500,
 * fail-closed, with the stack logged server-side.
 *
 * @function gate
 * @param {object} request    - The request (reads `routing.param.messageValidator` and `rawBody`).
 * @param {object} response   - The response (threaded to the 503 `Retry-After` write).
 * @param {object} controller - The per-request controller (its `throwError` answers refusals).
 * @returns {Promise<boolean>|null} `null` when dormant; else a promise settling `true` to proceed.
 *
 * @example
 * // core/router.js — inside the dispatch band, ahead of the DTO pipe
 * var verdict = messageValidator.gate(request, response, controller);
 * if ( verdict ) { verdict.then(function(ok) { if (ok) continueBand(); }); }
 */
var gate = function(request, response, controller) {

    var name = ( request && request.routing && request.routing.param )
        ? request.routing.param.messageValidator
        : undefined;
    if ( typeof(name) != 'string' || name === '' ) {
        return null;    // not opted in — zero promises, the band stays synchronous
    }

    var validate = getRegistry()[name];
    if ( typeof(validate) != 'function' ) {
        // Boot registration makes this unreachable; if it ever happens, say so
        // loudly rather than silently skip validation (the silent-off failure
        // mode this seam exists to prevent — the dto-pipe discipline).
        return Promise.resolve().then(function onUnregistered() {
            controller.throwError({
                status : 500,
                error  : 'Route `'+ request.routing.rule +'` declares `param.messageValidator` `'+ name +'` but no such validator is registered.'
            });
            return false;
        });
    }

    var document = ( typeof(request.rawBody) == 'string' ) ? request.rawBody : '';

    return Promise.resolve()
        .then(function runValidator() {
            return validate(document, request);
        })
        .then(function onVerdict(verdict) {
            return settleVerdict(verdict, name, response, controller);
        }, function onValidatorError(err) {
            // App-code fault or unhandled backend failure: fail CLOSED — the
            // request never proceeds unvalidated. Full stack server-side (the
            // wire never carries it in `error`); a validator wanting a polished
            // outage answer catches its own failure and returns the 503 verdict.
            try {
                console.error('[message-validator] `'+ name +'` threw for `'+ ((request.routing && request.routing.rule) || '?') +'`: '+ ( (err && err.stack) || (err && err.message) || String(err) ));
            } catch (logErr) {
                // best-effort — the 500 below is the contract
            }
            controller.throwError({
                status : 500,
                error  : '[message-validator] `'+ name +'` failed: '+ ( (err && err.message) || String(err) )
            });
            return false;
        });
};

module.exports = {
    register : register,
    get      : get,
    gate     : gate
};
