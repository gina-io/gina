/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/lib/dto-pipe
 *
 * The #DTO2 request-payload validation pipe — the "NestJS pipe" equivalent.
 *
 * A route opts in by declaring a DTO reference in `routing.json`:
 *
 *   "create-user": {
 *       "method" : "POST",
 *       "url"    : "/users",
 *       "param"  : { "control": "createUser", "dto": "CreateUser" }
 *   }
 *
 * `core/server.js` resolves + registers every declared DTO at bundle BOOT (fail-fast:
 * a missing / broken / `$`-bearing DTO refuses to boot). This module then runs before
 * the controller action, at both `core/router.js` dispatch sites, and:
 *
 *   1. resolves the route's DTO from the registry (an O(1) `dto.get()` — no fs, no
 *      factory re-run per request);
 *   2. NORMALISES the payload — injects `''` for every REQUIRED field the client
 *      omitted (see "the absent-key gap" below);
 *   3. validates through the LIVE form-validator engine (the same engine `routing.json`
 *      `validator::` rules and `forms/rules/*.json` use — a DTO unifies validation
 *      rather than adding a parallel validator);
 *   4. on failure, short-circuits a clean **422** carrying the engine's
 *      field -> rule -> message map (localised via `req.culture`);
 *   5. on success, hands the action the COERCED payload.
 *
 * It is a strict NO-OP for any route that declares no `param.dto`, so every existing
 * route is byte-identical.
 *
 * ## The absent-key gap (measured — the load-bearing reason this module normalises)
 * The engine iterates the DATA, not the rules, and `isRequired` only fires on a
 * PRESENT-but-empty value. A client that simply OMITS a required key therefore sails
 * through with `isValid() === true` and an empty error map — a silent-bypass, not a
 * cosmetic gap. So the pipe injects `''` for every required-and-absent field before
 * validating. It injects for REQUIRED fields ONLY: an optional absent field would come
 * back from the engine as a spurious `''` in the payload the action reads.
 *
 * ## Why the coerced payload can be assigned wholesale
 * The engine passes UNDECLARED keys through untouched into its output data, and at the
 * dispatch site `req[method]` carries the URL params merged in alongside the body
 * (`core/server.js` rebuilds it in the routing loop). URL params are, by definition,
 * undeclared by a body DTO — so `result.data` is exactly the object we want: declared
 * fields coerced, `.exclude()`d fields dropped, URL params + extra keys preserved
 * verbatim. Stripping or rejecting undeclared keys here would delete or reject the URL
 * params of every parameterised route; `additionalProperties: false` therefore remains
 * an OpenAPI statement, and the strict projection is offered non-destructively as
 * `req.dto`. (A reject-unknown mode would have to diff against `req.body` alone —
 * a labelled follow-on, not a half-built default.)
 *
 * ## Two engine shapes
 * With a non-empty rules object the engine returns `{ isValid: <function>, error, data }`.
 * With an EMPTY one it returns a bare validator instance with no `.error` / `.data` and
 * an `isValid()` that answers `true` — so a fieldless DTO is short-circuited here rather
 * than silently "passing".
 */

var dto     = require('../../dto');
// The live validator engine. Module-scope, mirroring `lib/routing/src/main.js`'s
// long-standing capture of the same plugin: this module is plain-`require`d from
// `lib/index.js` (never evicted), so it performs no per-request `require()` and can
// never grow a dead-`children` tail (#B32-residual).
var plugins   = require(__dirname + '/../../../core/plugins');
var Validator = plugins.Validator;

/**
 * Validate (and coerce) a request payload against the DTO its route declares.
 *
 * NO-OP (returns `true`) when the route declares no `param.dto`.
 *
 * @param {object} controller - the per-request controller (its `throwError` writes the 422).
 * @param {object} req        - the request. Reads `req.routing.param.dto`, `req[method]`,
 *                              `req.body` and `req.culture`.
 * @param {object} res        - the response (threaded to `throwError`).
 * @returns {boolean} `true` to continue to the action, `false` when the pipe has already
 *                    terminated the response (422 / 500).
 *
 * @example
 * // core/router.js, before the action dispatch
 * if ( !dtoPipe.validateRequestPayload(controller, request, response) ) {
 *     return; // the pipe answered (422/500) — never reach the action
 * }
 */
var validateRequestPayload = function (controller, req, res) {

    if ( !req || !req.routing || !req.routing.param ) {
        return true;
    }
    var name = req.routing.param.dto;
    if ( typeof(name) != 'string' || name === '' ) {
        return true;   // the route declares no DTO — nothing to do
    }

    // Boot-registration (core/server.js) makes an unresolved DTO unreachable here; if it
    // ever happens, say so loudly rather than silently skip validation (the silent-off
    // failure mode this design exists to prevent).
    var d = dto.get(name);
    if ( !d ) {
        controller.throwError({
            status : 500,
            error  : 'Route `'+ req.routing.rule +'` declares `param.dto` `'+ name +'` but no such DTO is registered.'
        });
        return false;
    }

    var rules = null;
    try {
        rules = d.toRules();   // fresh per request — cheap (a flat loop, no I/O) and never shared with the engine
    } catch (err) {
        controller.throwError({ status: 500, error: '[dto] `'+ name +'` cannot be compiled: '+ err.message });
        return false;
    }

    var declared = Object.keys(rules);
    if ( declared.length === 0 ) {
        return true;   // a fieldless DTO: the engine would return its no-rules shape (no .error/.data)
    }

    var method  = String(req.method || 'GET').toLowerCase();
    var payload = ( req[method] && typeof(req[method]) == 'object' ) ? req[method] : {};

    // Normalise: `''` for every REQUIRED field the client omitted (see the header).
    var data = {}, f, i;
    for (f in payload) {
        data[f] = payload[f];
    }
    for (i = 0; i < declared.length; ++i) {
        f = declared[i];
        if ( rules[f].isRequired === true && typeof(data[f]) == 'undefined' ) {
            data[f] = '';
        }
    }

    var result = null;
    try {
        result = Validator(
            rules,
            data,
            'dto:' + name,
            ( typeof(req.culture) == 'string' && req.culture ) ? req.culture : undefined
        );
    } catch (err) {
        controller.throwError({ status: 500, error: '[dto] `'+ name +'` failed to validate: '+ (err.message || err) });
        return false;
    }

    // Belt-and-braces against the engine's no-rules shape (`declared.length > 0` should
    // preclude it, but that shape has no `.error`/`.data` and answers `isValid() === true`).
    if ( !result || typeof(result.isValid) != 'function' || typeof(result.error) == 'undefined' ) {
        controller.throwError({ status: 500, error: '[dto] `'+ name +'` produced no validation result.' });
        return false;
    }

    if ( !result.isValid() ) {
        controller.throwError({
            status : 422,
            error  : 'Validation failed',
            fields : result.error   // field -> rule -> message (localised via req.culture)
        });
        return false;
    }

    // Hand the action the coerced payload. `result.data` already carries the undeclared
    // keys (URL params + extras) verbatim, so this is a wholesale assignment.
    var out = result.data;
    req[method] = out;

    // Keep `req.body` consistent for the DECLARED fields it already carries. It is a
    // DIFFERENT object from `req[method]` at this point (the routing loop rebuilt
    // `req[method]` and merged the URL params into it), and it must NOT gain them —
    // so only touch keys `req.body` already has.
    if ( req.body && typeof(req.body) == 'object' && !Array.isArray(req.body) ) {
        for (i = 0; i < declared.length; ++i) {
            f = declared[i];
            if ( typeof(req.body[f]) == 'undefined' ) {
                continue;
            }
            if ( rules[f].exclude === true ) {
                delete req.body[f];
            } else if ( typeof(out[f]) != 'undefined' ) {
                req.body[f] = out[f];
            }
        }
    }

    // The strict projection — declared fields only. Non-destructive; opt-in for the action.
    req.dto = d.apply(out);

    return true;
};

module.exports = {
    validateRequestPayload: validateRequestPayload
};
