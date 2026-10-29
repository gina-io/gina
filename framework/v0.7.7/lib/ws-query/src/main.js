'use strict';
/**
 * @module gina/lib/ws-query
 *
 * #H13 slice 3b — cross-bundle `session.query()` for WebSocket channel handlers.
 *
 * Gives a WS channel handler (`bundle/channels/<name>.js`, signature
 * `(session, request)`) the same inter-bundle HTTP capability a controller has
 * via `self.query()`: `session.query(options[, data][, callback])` → Promise.
 * Same-bundle DB access already works via `getModel` (slice 1); this adds the
 * inter-bundle HTTP leg `getModel` cannot do.
 *
 * Design (verified + approved 2026-06-22):
 *  - **Option A** — reuse the framework controller's hardened HTTP/1 + HTTP/2
 *    client (`controller.query`) per call, NOT a re-implementation of the
 *    #B31/#B33/#B34/#B35/#B52/#B53/#H5/#H9-hardened ~1700-line client. `query()`
 *    is already null-hardened for the no-request case.
 *  - **Fresh `new Controller` per query** — `query()` manages a single
 *    `query#complete` listener on `self`, so a controller shared across
 *    concurrent queries on one long-lived session would collide (cross-message
 *    data loss). Cheap; the form-validator's model.
 *  - **`controller.serverInstance = app`** — `app` IS the live server instance
 *    (`server.isaac.js` returns `{ instance: server }`; `server.js` stamps
 *    `instance._cached = new Map()` and wires it as the router's serverInstance;
 *    `gna.js` hands the same `instance` to `onInitialize` as `app`). So the
 *    controller reuses the WARM HTTP/2 session cache (`app._cached` +
 *    `app._http2Sessions`) the server already holds, rather than a cold one.
 *  - **`controllerOptions.conf = JSON.clone(<bundle config>)`** so `query()`'s
 *    unguarded `conf.server.coreConfiguration.{mime,statusCodes}` derefs resolve;
 *    the deep clone keeps the per-query controller from mutating the shared config.
 *  - **A minimal `{ headers: {} }` synthetic req** — `setOptions` needs a
 *    NON-null req: it calls `getParams(req)` (which assigns `req.getParams = …`)
 *    and reads `req.headers` (`:292`, `:3061`). A bare `{}` would crash at
 *    `controller.js:3061` (`local.req.headers['user-agent']`). The query
 *    controller has no genuine inbound request — a stub honestly represents that,
 *    and the channel handler forwards any header it wants explicitly via
 *    `options.headers` (it holds `request`). `res = null` is fine: the result
 *    returns via the callback, and the redirect-intercepts are
 *    `local.res != null`-guarded.
 *  - **Result via the callback path** (`util.promisify(controller.query)`), NOT
 *    the emitter (the WS handler is not an EventEmitter, and the emitter path
 *    shares the colliding `query#complete` listener).
 *
 * The bundle/env a server serves are captured once AT REGISTRATION (a server
 * serves one bundle) and passed to {@link build} — never resolved lazily at
 * connect/message time, where the shared `getContext('bundle')` is rewritten by
 * every `getConfig`/`getLib` stack-walk.
 *
 * @example
 *  // core/server.isaac.js dispatcher, after lib.wsSession.accept(...):
 *  session.query = lib.wsQuery.build(server, server._wsBundle, server._wsEnv);
 *
 *  // bundle/channels/feed.js:
 *  module.exports = async function (session, request) {
 *      var r = await session.query({ hostname: 'api@project/dev', path: '/x', method: 'GET' });
 *      session.send(JSON.stringify(r));
 *  };
 */

var util = require('util');

/**
 * Build a per-session `query` function bound to one server + bundle/env.
 *
 * @memberof module:gina/lib/ws-query
 * @param {object} app    - the live server instance (the `app` from
 *                          `onInitialize` / the Isaac dispatcher's `server`): the
 *                          warm HTTP/2 session-cache holder (`app._cached`,
 *                          `app._http2Sessions`).
 * @param {string} bundle - the bundle this server serves (captured at registration).
 * @param {string} env    - the environment (captured at registration).
 * @returns {function} `query(options[, data][, callback])` → `Promise`
 *
 * @example
 *  var query = build(server, 'demo', 'dev');
 *  query({ hostname: 'http://127.0.0.1:9760', path: '/api/x', method: 'GET' })
 *      .then(function (result) { ... });
 */
function build(app, bundle, env) {

    /**
     * Cross-bundle HTTP query, mirroring a controller's `self.query()`.
     *
     * @param {object} options - host/hostname, path, method, port, protocol,
     *                           headers, … (the same shape `self.query()` takes).
     * @param {object|function} [data] - request data, or the callback when called 2-arg.
     * @param {function} [callback] - optional node-style `(err, result)` callback.
     * @returns {Promise<object>} resolves with the parsed response; rejects on error.
     */
    return function query(options, data, callback) {
        if (typeof data === 'function') { callback = data; data = undefined; }
        data = data || {};

        var promise;
        try {
            if (!bundle || !env) {
                throw new Error('ws-query: no bundle/env captured for this server (registration did not run?)');
            }
            // Resolve the bundle config FRESH per query (dev hot-reload safe) — the
            // form-validator's queryFromBackend precedent. getInstance() with no
            // bundle arg returns the envConf map; [bundle][env] is the bundle config.
            var Config = require(_(GINA_FRAMEWORK_DIR + '/core/config.js', true));
            var conf   = new Config().getInstance()[bundle][env];

            var rule = '_wsQuery';
            var controllerOptions = {
                rule        : rule,
                isCacheless : conf.isCacheless,
                conf        : JSON.clone(conf)
            };
            // setOptions (:328) unconditionally derefs
            // `conf.content.routing[rule].param`. The synthetic `_wsQuery` rule is
            // not in the real routing, so provide it (an empty param map). No
            // `template`/`control` keys → setOptions skips its `page.*` promotion
            // block, so this short path needs nothing more.
            if (!controllerOptions.conf.content) { controllerOptions.conf.content = {}; }
            if (!controllerOptions.conf.content.routing) { controllerOptions.conf.content.routing = {}; }
            controllerOptions.conf.content.routing[rule] = { param: {} };

            var Controller = require(_(GINA_FRAMEWORK_DIR + '/core/controller/controller.js', true));
            var controller = new Controller(controllerOptions);
            // Warm HTTP/2 session cache: app IS the live serverInstance.
            controller.serverInstance = app;
            // Non-null synthetic req (see module doc): setOptions calls getParams(req)
            // and reads req.headers; res = null is fine (result via callback).
            controller.setOptions({ headers: {} }, null, function () {}, controllerOptions);

            promise = util.promisify(controller.query)(options, data);
        } catch (err) {
            promise = Promise.reject(err);
        }

        if (typeof callback === 'function') {
            promise.then(
                function (result) { callback(null, result); },
                function (err)    { callback(err); }
            );
        }
        return promise;
    };
}

module.exports = {
    build : build
};
