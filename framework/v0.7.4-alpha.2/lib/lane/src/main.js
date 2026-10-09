/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * @module gina/lib/lane
 *
 * #P49 — the fast lane: opt-in, controller-free dispatch for JSON routes.
 *
 * A route opts in from `routing.json` with `param.lane`, naming a module under the
 * bundle's `lanes/` directory, and keeps `param.control` for the name of the export
 * that answers it:
 *
 *   "users-list": {
 *       "url"   : "/users",
 *       "method": "GET",
 *       "param" : { "lane": "users", "control": "list" }
 *   }
 *
 *   // <bundle>/lanes/users.js
 *   module.exports.list = function (ctx) {
 *       ctx.json({ users: [] });
 *   };
 *
 * Such a route is matched exactly like any other (statics, CORS, maintenance, the
 * route match, `validator::` requirements, the HEAD alias and the render-cache read
 * all run unchanged above it), then it skips the controller: no controller file is
 * required, no `new Controller()`, no `setOptions()`, no per-request option clones.
 * On the isaac engine the bundle's own middleware chain (session, CSRF, …) still runs
 * and the lane is its terminal, so `req.session` and `csrfExempt` behave as on any
 * route; on the express engine those layers ran before gina's request handler.
 *
 * This module owns four things:
 *
 *  - **the boot registry** — `registerRoutes()` runs once per bundle from
 *    `core/server.js` `init()`, lints every `param.lane` route, requires its module
 *    and records `{ fn, module, … }` on `process.gina._lanes` under
 *    `<bundle>::<lane>#<control>`. Every author error refuses to boot, naming the
 *    route: a quietly-skipped gate or a route that silently falls back to a
 *    controller would be worse than a startup error (the `param.requireAuth` lint's
 *    reasoning). In this first slice a lane route cannot declare a gate
 *    (authorization, rate limit, idempotency, message validation, request DTO): the
 *    lane does not run them yet, so declaring one refuses the boot.
 *  - **the request context** — `LaneContext`, the single argument a handler
 *    receives. Prototype methods only, so building it is one allocation.
 *  - **the two writers** — `ctx.json()` mirrors `controller.render-json.js` (status
 *    from a `status` key, `param.responseDto` projection, one `JSON.stringify`, the
 *    idempotency record, the access line, HEAD, and the raw HTTP/2, #B562 shim and
 *    HTTP/1.x writes), and `ctx.error()` answers with the controller's JSON error
 *    envelope (`status`, `error`, `message`, `fields` / `errors`, a `stack` in local
 *    scope only, and the #ERRREF `ref`), with one pairing log line per error.
 *  - **dispatch** — `dispatch()` is called by `core/server.js` at the end of the
 *    isaac middleware chain, or directly on express. A synchronous throw or a
 *    rejected promise from the handler answers 500 through `ctx.error()`.
 *
 * In dev mode the handler modules hot-reload: `core/gna.js` watches the lane
 * directories (`watchDirs()`) and sets `__hotReload.lane`; the next dispatch
 * re-requires the registered modules and prunes this module's `children`.
 *
 * Server-side only; plain-required by the registry (`lib.lane`), never
 * hot-reloaded itself: `core/server.js` captures it at load.
 */

var nodePath    = require('path');
var fs          = require('fs');
var logger      = require('../../logger');
var errorRef    = require('../../error-ref');
var authzGate   = require('../../authz-gate');
var confView    = require('../../conf-view');
var dto         = require('../../dto');
var idempotency = require('../../idempotency');
var JSONClone   = require('./../../../../../utils/prototypes.json_clone');


/**
 * One path segment of a `param.lane` value: it must start with a letter, a digit
 * or `_` (so `.`, `..` and hidden names are out) and may then hold `.` and `-`.
 * Segments are joined with `/`. The charset also keeps the value safe where
 * `lib/routing`'s `getRoute()` compiles non-reserved `param` values into a
 * `RegExp`, and away from a leading `:`, which routing reads as a URL binding.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var LANE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;

/**
 * Action names the framework reserves; `core/router.js` refuses them per request,
 * the lane refuses them at boot.
 *
 * @constant
 * @type {string[]}
 * @private
 */
var RESERVED_CONTROLS = ['onReady', 'setup'];

/**
 * The stack-frame detector the controller and server error writers use (#B131,
 * #B670): a string holding a `\n    at ` line carries a stack.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var STACK_FRAME = /\n\s+at\s/;

/**
 * Error-body keys whose stack-bearing text is cut to its first line outside local
 * scope, and appended to the pairing line when the logged detail lacks it.
 *
 * @constant
 * @type {string[]}
 * @private
 */
var DETAIL_KEYS = ['title', 'message', 'error'];

/**
 * #B830 (2026-10-09) — render the control characters of a value as visible escapes before
 * it is written into a log or error message, so a client-supplied value cannot forge a
 * physical log line (CWE-117). The escaped set: C0 (U+0000-U+001F), DEL and C1
 * (U+007F-U+009F), and the line separators U+2028 / U+2029 — every character a terminal or
 * a line-based reader can take for a line break or a control sequence. `\n`, `\r`, `\t`
 * become the two-character sequences; any other character of the set becomes `\uXXXX`;
 * every other character is left untouched, so a value holding none comes back unchanged.
 * Deliberately duplicated — in the logger, core/server.js, core/server.isaac.js,
 * core/controller/controller.js, controller.render-swig.js, helpers/context.js, lib/lane,
 * lib/routing and the validator — the way `escapeForJsonString` is (#B600): the logger is
 * server-side only and two of those files are in the browser bundle, so no single
 * requireable home serves them all without adding a public API surface.
 * `test/lib/log-escape-parity-b830.test.js` fails when a copy drifts. The log redaction
 * reads these escapes back (`lib/logger/src/redact.js`, `decodeView`): a change of the set
 * here is a change there.
 *
 * @inner
 * @param   {*} value - Coerced with `String()`.
 * @returns {string} The value with its control characters shown as escapes.
 * @example
 * escapeLogControlChars('a\nb'); // the four characters a \ n b, on one physical line
 */
function escapeLogControlChars(value) {
    return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, function (c) {
        switch (c) {
            case '\n': return '\\n';
            case '\r': return '\\r';
            case '\t': return '\\t';
            default:   return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
        }
    });
}

/**
 * #B830 — render an error detail safe from line-forging while keeping its stack readable:
 * the control characters of every line are escaped, and a REAL line feed is kept only
 * before a line shaped like a V8 stack frame — whitespace, `at`, whitespace, then ANY
 * text — or starting with `caused by:`; any other line feed (the break of a client value)
 * becomes the visible escape. Log-only: the wire copy is shaped separately by the egress
 * gate. Residual, accepted and documented: a value crafted to look like such a line renders
 * as one, since the detail logs a caller-passed stack whole and a crafted frame line cannot
 * be told from a real one.
 *
 * @inner
 * @param   {*} detail - The composed error-detail string.
 * @returns {string} The detail with injected line breaks neutralised, frame lines kept.
 * @example
 * escapeLogDetailKeepFrames('Error: a\nb\n    at f (x.js:1:1)');
 * // 'Error: a\\nb' + a real line feed + '    at f (x.js:1:1)'
 */
function escapeLogDetailKeepFrames(detail) {
    if (detail === null || typeof detail === 'undefined') { return ''; }
    var lines = String(detail).split('\n');
    var out = escapeLogControlChars(lines[0]);
    for (var i = 1; i < lines.length; i++) {
        var keep = /^\s+at\s/.test(lines[i]) || /^caused by:/.test(lines[i]);
        out += (keep ? '\n' : '\\n') + escapeLogControlChars(lines[i]);
    }
    return out;
}

var _isDev   = null;
var _isLocal = null;

/**
 * Dev mode (`NODE_ENV_IS_DEV`), read once on first use.
 *
 * @inner
 * @private
 * @returns {boolean}
 */
function isDev() {
    if ( _isDev === null ) {
        _isDev = /^true$/i.test(process.env.NODE_ENV_IS_DEV || '');
    }
    return _isDev;
}

/**
 * Local scope (`NODE_SCOPE_IS_LOCAL`), read once on first use — the stack egress
 * gate of the error writer.
 *
 * @inner
 * @private
 * @returns {boolean}
 */
function isLocalScope() {
    if ( _isLocal === null ) {
        _isLocal = /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL || '');
    }
    return _isLocal;
}

/**
 * Own-property test that cannot be fooled by a key named `hasOwnProperty`.
 *
 * @inner
 * @private
 * @param {object} obj
 * @param {string|number} key
 * @returns {boolean}
 */
function hasOwn(obj, key) {
    return obj !== null && typeof(obj) != 'undefined' && Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Node's own rule for a status `writeHead()` accepts: an integer from 100 to 999
 * (the controller's `_isValidHttpStatus`, #B466).
 *
 * @inner
 * @private
 * @param {*} v - candidate status
 * @returns {boolean}
 */
function isValidHttpStatus(v) {
    var n = Number(v);
    return Number.isInteger(n) && n >= 100 && n <= 999;
}

/**
 * Short, log-safe rendering of an author-supplied value for a boot refusal.
 *
 * @inner
 * @private
 * @param {*} value
 * @returns {string}
 */
function describeValue(value) {
    try {
        return JSON.stringify(value);
    } catch (err) {
        return String(value);
    }
}

/**
 * The process-wide registry, created on first use.
 *
 * @inner
 * @private
 * @returns {object} `process.gina._lanes`, a prototype-less map
 */
function registry() {
    if ( !process.gina ) {
        process.gina = {};
    }
    if ( !process.gina._lanes ) {
        process.gina._lanes = Object.create(null);
    }
    return process.gina._lanes;
}

/**
 * Whether a `param.lane` value is a well-formed module name under `lanes/`.
 *
 * @memberof module:gina/lib/lane
 * @param {*} value - the declared `param.lane`
 * @returns {boolean} `true` for `"users"`, `"admin/users"`, `"v2.users"`; `false` for
 *  anything else, including `""`, `"../x"`, `"./x"`, `"/x"`, `"a//b"` and non-strings
 *
 * @example
 * lane.isLaneName('admin/users');   // true
 * lane.isLaneName('../secrets');    // false
 * lane.isLaneName(42);              // false
 */
function isLaneName(value) {
    if ( typeof(value) != 'string' || value === '' ) {
        return false;
    }
    var segments = value.split('/');
    for (var i = 0; i < segments.length; ++i) {
        if ( !LANE_SEGMENT.test(segments[i]) ) {
            return false;
        }
    }
    return true;
}

/**
 * The gate keys a route declares, which a lane route cannot carry in this slice.
 *
 * `param.requireAuth: false` and `rateLimit: false` are explicit "no" values and are
 * not gates.
 *
 * @inner
 * @private
 * @param {object} route - a `routing.json` rule
 * @returns {string[]} the declared gate keys, in the gate order
 */
function gateKeysOf(route) {
    var p    = route.param;
    var keys = [];
    if ( typeof(p.requireAuth) != 'undefined' && p.requireAuth !== false ) {
        keys.push('param.requireAuth');
    }
    if ( typeof(p.roles) != 'undefined' ) {
        keys.push('param.roles');
    }
    if ( typeof(p.policy) != 'undefined' ) {
        keys.push('param.policy');
    }
    if ( typeof(route.rateLimit) != 'undefined' && route.rateLimit !== null && route.rateLimit !== false ) {
        keys.push('rateLimit');
    }
    if ( typeof(route.idempotency) != 'undefined' && route.idempotency !== null && route.idempotency !== false ) {
        keys.push('idempotency');
    }
    if ( typeof(p.messageValidator) != 'undefined' && p.messageValidator !== null && p.messageValidator !== '' ) {
        keys.push('param.messageValidator');
    }
    if ( typeof(p.dto) != 'undefined' && p.dto !== null && p.dto !== '' ) {
        keys.push('param.dto');
    }
    return keys;
}

/**
 * Require a lane module and resolve the export a route names.
 *
 * @inner
 * @private
 * @param {string} file    - absolute path of `<bundle>/lanes/<lane>.js`
 * @param {string} rule    - the route name, for the refusal
 * @param {string} lane    - the declared `param.lane`
 * @param {string} control - the declared `param.control` (the export)
 * @param {string} bundle  - the bundle the route belongs to
 * @returns {object} the registry entry
 * @throws {Error} a `[ SERVER ] Route …` refusal when the module is missing, does not
 *  load, or lacks the export
 */
function loadEntry(file, rule, lane, control, bundle) {
    if ( !fs.existsSync(file) ) {
        throw new Error('[ SERVER ] Route `'+ rule +'` declares `param.lane` `'+ lane +'` but `'+ file +'` is missing'+ ( /\.js$/.test(lane) ? ' (name the module without its `.js` extension)' : '' ) +'.');
    }
    var resolved = require.resolve(file);
    var mod      = null;
    try {
        mod = require(resolved);
    } catch (err) {
        throw new Error('[ SERVER ] Route `'+ rule +'`: lane module `lanes/'+ lane +'.js` could not be loaded ('+ file +'):\n'+ ( err && ( err.stack || err.message ) || String(err) ));
    }
    if ( mod === null || ( typeof(mod) != 'object' && typeof(mod) != 'function' ) || !hasOwn(mod, control) || typeof(mod[control]) != 'function' ) {
        throw new Error('[ SERVER ] Route `'+ rule +'`: lane module `lanes/'+ lane +'.js` does not export a function named `'+ control +'` (the route\'s `param.control`). The contract is `module.exports.'+ control +' = function (ctx) { … };`.');
    }
    return {
        fn       : mod[control],
        module   : mod,
        file     : file,
        resolved : resolved,
        lane     : lane,
        control  : control,
        bundle   : bundle,
        rule     : rule,
        error    : null
    };
}

/**
 * @typedef {object} LaneRegisterOptions
 * @property {string} bundle        - the bundle being booted (`core/server.js` `self.appName`)
 * @property {string} bundlesPath   - the project's bundles source directory
 * @property {object} [settings]    - the bundle's `settings.json` content (reads `auth.requireAuthByDefault`)
 * @property {object} [server]      - the bundle's resolved `server` block (reads `rateLimit.enabled`)
 */

/**
 * Lint and register every `param.lane` route of one bundle (the boot walk).
 *
 * Called once per bundle from `core/server.js` `init()`, before the server listens.
 * A route opts in with a non-empty `param.lane`; every other route is skipped
 * untouched. For each lane route this refuses to boot — throwing a
 * `[ SERVER ] Route \`<rule>\`: …` error, which `init()` turns into an exit — when:
 *
 *  1. `param.lane` is not a module name under `lanes/` (see `isLaneName()`), or
 *     `param.control` is not a non-empty string, names a reserved action
 *     (`onReady`, `setup`) or is `redirect` (a redirect route);
 *  2. the route belongs to another bundle (a lane module lives in its own bundle);
 *  3. it carries middleware (route-level or from `routing.global.json`), `cache`,
 *     `negotiate`, a route-level `namespace`, or is a `method: "ws"` route —
 *     features that need a controller, or a cache write the lane does not perform;
 *  4. it declares a gate (`param.requireAuth`, `param.roles`, `param.policy`,
 *     `rateLimit`, `idempotency`, `param.messageValidator`, `param.dto`), or the
 *     bundle gates it implicitly — `auth.requireAuthByDefault` without
 *     `param.public: true`, or `server.rateLimit.enabled` without `rateLimit: false`
 *     — because this slice of the lane does not run the gates;
 *  5. `lanes/<lane>.js` is missing, fails to load, or does not export a function
 *     named after `param.control`.
 *
 * `param.responseDto` is allowed (the JSON writer projects it), as are
 * `csrfExempt` (read by the bundle's own CSRF middleware), `requirements`,
 * `scopes`, `param.public`, `param.requireAuth: false` and `rateLimit: false`.
 *
 * @memberof module:gina/lib/lane
 * @param {object} routing              - the bundle's routing table (`rule` → route)
 * @param {LaneRegisterOptions} opt
 * @returns {number} the number of lane routes registered
 * @throws {Error} a route-named refusal, see above
 *
 * @example
 * var count = lib.lane.registerRoutes(serverOpt.routing, {
 *     bundle      : 'api',
 *     bundlesPath : '/srv/project/src',
 *     settings    : conf.content.settings,
 *     server      : conf.server
 * });
 * // count === 3, and process.gina._lanes['api::users#list'] holds the handler
 */
function registerRoutes(routing, opt) {
    opt = opt || {};
    var bundle      = opt.bundle;
    var settings    = ( opt.settings && typeof(opt.settings) == 'object' ) ? opt.settings : {};
    var server      = ( opt.server && typeof(opt.server) == 'object' ) ? opt.server : {};
    var defaultDeny = !!( settings.auth && typeof(settings.auth) == 'object' && settings.auth.requireAuthByDefault === true );
    var rateLimitOn = !!( server.rateLimit && typeof(server.rateLimit) == 'object' && server.rateLimit.enabled === true );
    var reg         = registry();
    var count       = 0;

    for (var rule in routing) {
        var route = routing[rule];
        if ( typeof(route) != 'object' || route === null || typeof(route.param) != 'object' || route.param === null ) {
            continue;
        }
        var lane = route.param.lane;
        if ( typeof(lane) == 'undefined' || lane === null || lane === '' ) {
            continue;
        }
        var where = '[ SERVER ] Route `'+ rule +'`: ';

        // 1. the module name and the export
        if ( !isLaneName(lane) ) {
            throw new Error(where +'`param.lane` must name a module under `lanes/` — letters, digits and `_`, then `.` or `-`, with `/` between directories; no `..`, no leading `.` or `/` (got '+ describeValue(lane) +').');
        }
        var control = route.param.control;
        if ( typeof(control) != 'string' || control === '' ) {
            throw new Error(where +'`param.lane` routes name the module export to run in `param.control`, which must be a non-empty string (got '+ describeValue(control) +').');
        }
        if ( RESERVED_CONTROLS.indexOf(control) > -1 ) {
            throw new Error(where +'`param.control` `'+ control +'` is reserved for the framework.');
        }
        if ( /^redirect$/i.test(control) ) {
            throw new Error(where +'`param.control: "redirect"` marks a redirect route, which cannot be a lane route. Name the lane export something else.');
        }
        // 2. a lane module lives in its own bundle
        if ( typeof(route.bundle) != 'undefined' && route.bundle !== null && route.bundle !== bundle ) {
            throw new Error(where +'it belongs to bundle `'+ route.bundle +'` but is declared for bundle `'+ bundle +'`. A lane route must belong to the bundle whose `lanes/` directory holds its module.');
        }
        // 3. features that need a controller or a cache write
        if ( Array.isArray(route.middleware) && route.middleware.length > 0 ) {
            throw new Error(where +'a lane route cannot run route middleware (it declares or inherits from `routing.global.json`: '+ route.middleware.join(', ') +'). Middleware is built on the controller, which a lane route never builds. Drop `param.lane` to keep the middleware.');
        }
        if ( route.cache ) {
            throw new Error(where +'a lane route cannot declare `cache`: the lane does not write the render cache, so the entry would never warm. Drop `cache`, or drop `param.lane` to cache the route through its controller.');
        }
        if ( route.negotiate ) {
            throw new Error(where +'a lane route answers JSON only, so it cannot declare `negotiate`.');
        }
        if ( typeof(route.namespace) != 'undefined' && route.namespace !== null && route.namespace !== '' ) {
            throw new Error(where +'a lane route cannot declare `namespace`: it selects a controller file, which a lane route never loads.');
        }
        if ( /^ws$/i.test(route.method || '') ) {
            throw new Error(where +'a `method: "ws"` route is answered by the WebSocket handler, so it cannot be a lane route.');
        }
        // 4. gates, declared or implied
        var gates = gateKeysOf(route);
        if ( gates.length > 0 ) {
            throw new Error(where +'a lane route cannot declare '+ gates.map(function(k){ return '`'+ k +'`'; }).join(', ') +' yet: the fast lane does not run the authorization, rate-limit, idempotency, message-validation or DTO gates in this release, so the gate would be silently skipped. Remove the key, or drop `param.lane` to serve the route through its controller.');
        }
        if ( defaultDeny && route.param.public !== true ) {
            throw new Error(where +'`auth.requireAuthByDefault` gates every route not marked `"public": true`, and the fast lane does not run the authorization gate yet, so this route would be served unauthenticated. Mark it `"public": true` if it is meant to be open, or drop `param.lane`.');
        }
        if ( rateLimitOn && route.rateLimit !== false ) {
            throw new Error(where +'`server.rateLimit` is enabled and applies to every route that does not declare `"rateLimit": false`, and the fast lane does not run the rate-limit gate yet, so this route would escape the quota. Declare `"rateLimit": false` to exempt it explicitly, or drop `param.lane`.');
        }
        // 5. the module
        if ( typeof(opt.bundlesPath) != 'string' || opt.bundlesPath === '' || typeof(bundle) != 'string' || bundle === '' ) {
            throw new Error(where +'cannot resolve `lanes/'+ lane +'.js`: the lane registry was called without the bundle name and the bundles path.');
        }
        var file  = nodePath.join(opt.bundlesPath, bundle, 'lanes', lane + '.js');
        var entry = loadEntry(file, rule, lane, control, bundle);
        reg[ bundle +'::'+ lane +'#'+ control ] = entry;
        ++count;
    }
    return count;
}

/**
 * Find the registry entry for a matched route.
 *
 * `core/server.js` calls it only when `routing.param.lane` is set. A declared lane
 * the registry does not hold (a route added after the boot, say) yields an entry
 * marked `missing`, which `dispatch()` answers with a 500 naming it, rather than
 * letting the route fall through to a controller.
 *
 * @memberof module:gina/lib/lane
 * @param {object} routing - `req.routing` (`bundle`, `rule`, `param.lane`, `param.control`)
 * @returns {?object} `null` when the route declares no lane; else the entry, or a
 *  `{ missing: true, … }` placeholder
 *
 * @example
 * var entry = lib.lane.lookup(req.routing);   // process.gina._lanes['api::users#list']
 */
function lookup(routing) {
    var param = ( routing ) ? routing.param : null;
    if ( !param || typeof(param.lane) != 'string' || param.lane === '' ) {
        return null;
    }
    var key   = routing.bundle +'::'+ param.lane +'#'+ param.control;
    var reg   = ( process.gina ) ? process.gina._lanes : null;
    var entry = ( reg ) ? reg[key] : undefined;
    if ( entry ) {
        return entry;
    }
    return { missing: true, key: key, bundle: routing.bundle, lane: param.lane, control: param.control, rule: routing.rule };
}

/**
 * The directories to watch for dev-mode hot reload: the bundle's `lanes/` root
 * and every directory under it holding a registered module (a directory watch
 * does not descend). Empty when the bundle registered no lane route, so a bundle
 * without lanes watches nothing.
 *
 * @memberof module:gina/lib/lane
 * @param {string} lanesRoot - `<bundle>/lanes`
 * @returns {string[]} absolute directory paths, the root first
 *
 * @example
 * lib.lane.watchDirs('/srv/project/src/api/lanes');
 * // ['/srv/project/src/api/lanes', '/srv/project/src/api/lanes/admin']
 */
function watchDirs(lanesRoot) {
    var root = nodePath.resolve(lanesRoot);
    var reg  = registry();
    var out  = [];
    var seen = Object.create(null);
    for (var key in reg) {
        var dir = nodePath.dirname(nodePath.resolve(reg[key].file));
        if ( dir !== root && dir.indexOf(root + nodePath.sep) !== 0 ) {
            continue;
        }
        if ( out.length === 0 ) {
            out.push(root);
            seen[root] = true;
        }
        if ( !seen[dir] ) {
            seen[dir] = true;
            out.push(dir);
        }
    }
    return out;
}

/**
 * Drop this module's dead `children` after a re-require (the #B32 rule: a
 * cache-miss `require()` pushes the fresh `Module` onto the requiring module's
 * `children`, so an evicted handler would stay reachable from here forever).
 *
 * @inner
 * @private
 * @returns {void}
 */
function pruneChildren() {
    if ( module.children && module.children.length > 0 ) {
        module.children = module.children.filter(function onLanePruneFilter(child) {
            return require.cache[child.id] === child;
        });
    }
}

/**
 * Dev mode: re-require every registered lane module and re-resolve each entry's
 * export. A module that fails to load, or no longer exports the function, marks
 * its entries with an `error` that `dispatch()` answers as a 500 until the file is
 * fixed (the next watcher event reloads again).
 *
 * @inner
 * @private
 * @returns {void}
 */
function reloadModules() {
    var reg    = registry();
    var byFile = Object.create(null);
    var key, file;
    for (key in reg) {
        file = reg[key].resolved;
        if ( !byFile[file] ) {
            byFile[file] = [];
        }
        byFile[file].push(reg[key]);
    }
    for (file in byFile) {
        delete require.cache[file];
    }
    for (file in byFile) {
        var mod     = null;
        var loadErr = null;
        try {
            mod = require(file);
        } catch (err) {
            loadErr = err;
        }
        var entries = byFile[file];
        for (var i = 0; i < entries.length; ++i) {
            var entry = entries[i];
            if ( loadErr ) {
                entry.error = new Error('lane module `lanes/'+ entry.lane +'.js` could not be reloaded ('+ entry.file +'):\n'+ ( loadErr.stack || loadErr.message || String(loadErr) ));
                continue;
            }
            if ( mod === null || ( typeof(mod) != 'object' && typeof(mod) != 'function' ) || !hasOwn(mod, entry.control) || typeof(mod[entry.control]) != 'function' ) {
                entry.error = new Error('lane module `lanes/'+ entry.lane +'.js` no longer exports a function named `'+ entry.control +'` (route `'+ entry.rule +'`).');
                continue;
            }
            entry.fn     = mod[entry.control];
            entry.module = mod;
            entry.error  = null;
        }
    }
    pruneChildren();
}

/**
 * Dev mode: reload the lane modules when the watcher flagged a change (or on every
 * request when no watcher runs — the controllers' #M6 fallback), then clear the flag.
 *
 * @inner
 * @private
 * @returns {void}
 */
function reloadIfDirty() {
    var hot = ( typeof(getContext) == 'function' ) ? getContext('__hotReload') : null;
    if ( hot && !hot.lane ) {
        return;
    }
    reloadModules();
    if ( hot ) {
        hot.lane = false;
    }
}

/**
 * Null the context's request and response once an answer is written — the
 * released-response guard (#B31): a later `json()` / `error()` logs and no-ops.
 *
 * @inner
 * @private
 * @param {LaneContext} ctx
 * @returns {void}
 */
function release(ctx) {
    ctx.req = null;
    ctx.res = null;
}

/**
 * Whether the response can no longer be written.
 *
 * @inner
 * @private
 * @param {object} res
 * @returns {boolean}
 */
function isAnswered(res) {
    if ( res.headersSent || res.writableEnded ) {
        return true;
    }
    var stream = res.stream;
    return !!( stream && ( stream.destroyed || stream.closed ) );
}

/**
 * Log a write attempted on a released or already-answered response.
 *
 * @inner
 * @private
 * @param {string} what - `json()` or `error()`
 * @param {*} payload   - what the late call carried
 * @returns {void}
 */
function logLateCall(what, payload) {
    var text = '';
    try {
        text = ( payload instanceof Error ) ? ( payload.stack || payload.message )
            : ( payload && typeof(payload) == 'object' ) ? JSON.stringify(payload)
            : String(typeof(payload) == 'undefined' ? '' : payload);
    } catch (err) {
        text = String(payload);
    }
    // #B830 — the payload of a late call can hold a client value: frame lines kept, any other break escaped
    logger.warn('[ Lane ] '+ what +' called after the response was released — ignoring: '+ escapeLogDetailKeepFrames(text));
}

/**
 * Fold the headers already set on the compat response into a raw HTTP/2 header
 * frame, keeping the frame's own keys (the delegate's `getHeaders()` merge — what
 * carries CORS, security headers, `X-Request-Id` and anything a middleware set).
 *
 * @inner
 * @private
 * @param {object} res     - the compat response
 * @param {object} headers - the frame being built (mutated)
 * @returns {object} `headers`
 */
function foldPendingHeaders(res, headers) {
    var pending = ( typeof(res.getHeaders) == 'function' ) ? res.getHeaders() : null;
    for (var k in pending) {
        if ( !(k in headers) ) {
            headers[k] = pending[k];
        }
    }
    return headers;
}

/**
 * Push the closing Inspector Flow bars for a lane response (`response-write`,
 * `total`) when the request carries a timeline (Inspector open, or a production
 * instrumentation window).
 *
 * @inner
 * @private
 * @param {LaneContext} ctx
 * @param {object} req
 * @returns {void}
 */
function pushWriteTimeline(ctx, req) {
    var tl = req._devTimeline;
    if ( !tl || !tl.entries ) {
        return;
    }
    var now   = Date.now();
    var start = ctx._t0 || now;
    tl.entries.push({ label: 'response-write', cat: 'response', startMs: start, endMs: now, durationMs: now - start, detail: null });
    tl.entries.push({ label: 'total', cat: 'total', startMs: tl.requestStart, endMs: now, durationMs: now - tl.requestStart, detail: null });
}

/**
 * The JSON writer behind `ctx.json()` — `controller.render-json.js`'s contract
 * without a controller.
 *
 * @inner
 * @private
 * @param {LaneContext} ctx
 * @param {*} data - the payload (a string is parsed; a falsy value sends `{}`)
 * @returns {boolean} `true` when written, `false` when the call was ignored
 */
function writeJson(ctx, data) {
    var req = ctx.req;
    var res = ctx.res;
    if ( res == null ) {
        logLateCall('json()', data);
        return false;
    }
    if ( isAnswered(res) ) {
        if ( res.stream && ( res.stream.destroyed || res.stream.closed ) ) {
            logger.warn('[ Lane ] Stream already destroyed — client disconnected before the response was sent ('+ req.url +')');
        } else {
            logLateCall('json()', data);
        }
        release(ctx);
        return false;
    }

    var conf        = ctx._conf;
    var core        = conf.server.coreConfiguration;
    var contentType = core.mime['json'] + '; charset='+ conf.encoding;
    var isH2Conf    = /http\/2/.test(conf.server.protocol);
    var stream      = ( typeof(res.stream) != 'undefined' && res.stream !== null ) ? res.stream : null;

    if ( !data ) {
        data = {};
    }
    try {
        if ( typeof(data) == 'string' ) {
            data = JSON.parse(data);
        }
        res.setHeader('content-type', contentType);

        // the status: a `status` key naming a listed non-200 code (or an `errno`
        // payload whose `status` is listed); `errno` alone never sets it
        if (
            typeof(data.errno) != 'undefined' && res.statusCode == 200 && hasOwn(core.statusCodes, data.status)
            ||
            typeof(data.status) != 'undefined' && data.status != 200 && hasOwn(core.statusCodes, data.status)
        ) {
            try {
                res.statusCode = data.status;
                // HTTP/2 carries no reason phrase (RFC 9113 §8.3.2)
                if ( !isH2Conf ) {
                    res.statusMessage = core.statusCodes[data.status];
                }
            } catch (statusErr) {
                res.statusCode = 500;
                logger.error('[ Lane ] status resolution failed: ', statusErr.stack || statusErr.message || statusErr);
                if ( !isH2Conf ) {
                    res.statusMessage = 'Internal Server Error';
                }
            }
        }

        logger.info(req.method +' ['+ res.statusCode +'] '+ req.url);
        pushWriteTimeline(ctx, req);

        // #DTO2 — `param.responseDto` shapes a 2xx payload (registered at boot)
        if (
            typeof(data) == 'object' && data !== null
            && res.statusCode >= 200 && res.statusCode < 300
            && req.routing && req.routing.param
            && typeof(req.routing.param.responseDto) == 'string' && req.routing.param.responseDto !== ''
        ) {
            var respDto = dto.get(req.routing.param.responseDto);
            if ( respDto ) {
                if ( isDev() ) {
                    var respSchema  = respDto.toJsonSchema(null, { dropExcluded: true });
                    var respMissing = (respSchema.required || []).filter(function onRequiredField(f) {
                        return ( typeof(data[f]) == 'undefined' );
                    });
                    if ( respMissing.length > 0 ) {
                        logger.warn('[ Lane ] responseDto `'+ req.routing.param.responseDto +'` declares required field(s) the payload does not carry: '+ respMissing.join(', '));
                    }
                }
                data = respDto.apply(data);
            } else {
                logger.warn('[ Lane ] responseDto `'+ req.routing.param.responseDto +'` is not registered — the payload is sent unshaped.');
            }
        }

        var body = JSON.stringify(data);
        // #FIN6 — the idempotency record reads the status and content-type set above
        if ( req._idemCapture ) {
            idempotency.record(req, res, body);
        }
        var status = res.statusCode || 200;

        if ( stream && ( stream.destroyed || stream.closed ) ) {
            logger.warn('[ Lane ] Stream already destroyed — client disconnected before the response was sent ('+ req.url +')');
            release(ctx);
            return false;
        }

        // HEAD: the headers, with the length the body would have had, and no body
        if ( /^HEAD$/i.test(req.method) ) {
            var headLen = Buffer.byteLength(body, 'utf8');
            if ( stream ) {
                var sendHead = function onLaneSendHead() {
                    if ( !stream.headersSent ) {
                        stream.respond(foldPendingHeaders(res, { 'content-type': contentType, 'content-length': headLen, ':status': status }));
                    }
                    stream.end();
                };
                if ( res._ginaSendShim ) {
                    // #B562 — let a middleware wrapping writeHead/end run first
                    res._ginaRawSend = sendHead;
                    res.writeHead(status);
                    res.end();
                } else {
                    sendHead();
                }
            } else {
                res.setHeader('content-length', headLen);
                res.end();
            }
            release(ctx);
            return true;
        }

        if ( stream ) {
            var sendBody = function onLaneSendBody(chunk) {
                if ( !stream.headersSent ) {
                    stream.respond(foldPendingHeaders(res, { 'content-type': contentType, ':status': status }));
                }
                stream.end(chunk);
            };
            if ( res._ginaSendShim ) {
                // #B562 — the shim hands the buffered body to sendBody after the
                // wrapping middleware ran (a session cookie, a save-on-end)
                res._ginaRawSend = sendBody;
                res.writeHead(status);
                res.end(body);
            } else {
                sendBody(body);
            }
            release(ctx);
            return true;
        }

        // HTTP/1.x
        res.setHeader('content-length', Buffer.byteLength(body, 'utf8'));
        res.end(body);
        release(ctx);
        return true;
    } catch (err) {
        return writeError(ctx, [500, err]);
    }
}

/**
 * The status text for a code, warning when the table does not list it (the
 * controller's `[ ApiValidator ]` diagnostic).
 *
 * @inner
 * @private
 * @param {object} statusCodes
 * @param {number|string} code
 * @returns {?string}
 */
function statusText(statusCodes, code) {
    if ( hasOwn(statusCodes, code) ) {
        return statusCodes[code];
    }
    logger.warn('[ Lane ] statusCode `'+ code +'` not matching any definition in the status codes table');
    return null;
}

/**
 * Fill the keys `source` has and `target` lacks into a COPY of `target` — what
 * `lib/merge(target, source)` produces for the controller's ApiError merge
 * (target wins, key order kept, missing keys appended), without editing the
 * caller's object.
 *
 * @inner
 * @private
 * @param {object} target
 * @param {object} source
 * @returns {object} a new plain object
 */
function fillMissing(target, source) {
    var out = {};
    var k;
    for (k in target) {
        if ( hasOwn(target, k) ) {
            out[k] = target[k];
        }
    }
    for (k in source) {
        if ( typeof(out[k]) == 'undefined' ) {
            out[k] = source[k];
        }
    }
    return out;
}

/**
 * Whether a value is a response object (the controller's `(res, code, msg)` shape).
 *
 * @inner
 * @private
 * @param {*} value
 * @returns {boolean}
 */
function isResponseLike(value) {
    return !!( value && typeof(value) == 'object' && typeof(value.writeHead) == 'function' && typeof(value.setHeader) == 'function' );
}

/**
 * Build the error body from the arguments of `ctx.error()` — the controller
 * `throwError` resolution for the same call shapes (`core/controller/controller.js`),
 * so a lane route answers an error with the envelope a controller route would:
 *
 *  - `(errorObj)` — `{ status, error, fields | flash | errors, … }` keeps the
 *    object's keys (the gates' shape); any other object keeps `status` and
 *    `error`, plus its `message` and its `ref` when it has them (#B518);
 *  - `(err)` — an `Error`; its `status` when valid, else 500; `error` and `message`
 *    carry its message, `stack` its stack, and its `ref` is kept (#B518);
 *  - `(status, message)` / `(status, err)` — `error` is the status text, `message`
 *    the sentence;
 *  - `(status, { message, ref, … })` and the controller's `(res, status, msg)` —
 *    same envelope; a leading response object is ignored;
 *  - `(status)` and `()` — the status text alone (a controller throws on these).
 *
 * @inner
 * @private
 * @param {Array} args         - the call's arguments
 * @param {object} statusCodes - `coreConfiguration.statusCodes`
 * @returns {{errorObject: object, code: number|string, msg: *}}
 */
function buildErrorObject(args, statusCodes) {
    var a = Array.prototype.slice.call(args);
    if ( a.length > 0 && isResponseLike(a[0]) ) {
        a[0] = {};   // the controller reads no error, message, stack or status off a response
    } else if ( a.length > 1 && ( a[0] === null || typeof(a[0]) == 'undefined' ) ) {
        a[0] = {};   // a controller ignores this call as a late one; the lane still answers
    }
    if ( a.length === 0 ) {
        a = [{ status: 500 }];
    }
    var n    = a.length;
    var res  = a[0];
    var code = a[1];
    var msg  = a[2];
    var last = a[n - 1];
    var errorObject = null;
    var std = null;

    // the 2-arg (status, Error|string) shift
    if ( typeof(res) == 'number' && n === 2 && ( a[1] instanceof Error || typeof(a[1]) == 'string' ) ) {
        msg  = a[1];
        code = res;
        res  = {};
    }
    // #B560 — a falsy 1-arg payload is a 500, not a late call
    if ( n === 1 && !res ) {
        res = { status: 500 };
    }

    if (
        a[0] instanceof Error
        || n == 1 && typeof(res) == 'object'
        || last instanceof Error
        || typeof(last) == 'string' && !(a[0] instanceof Error)
    ) {
        msg  = ( !/^\d+$/.test(code) && typeof(msg) == 'undefined' ) ? code : msg;
        code = isValidHttpStatus(code) ? code : ( res && isValidHttpStatus(res.status) ) ? res.status : 500;
        std  = statusText(statusCodes, code);
        errorObject = {
            status : code,
            error  : res.error || res.message || std
        };
        if ( res instanceof Error || typeof(res.stack) != 'undefined' ) {
            errorObject.stack = res.stack;
            if ( res.message && typeof(res.message) == 'string' ) {
                errorObject.message = res.message;
            } else if ( res.message ) {
                logger.warn('[ Lane ] Ignoring message because of the format.\n'+ escapeLogControlChars(res.message));
            }
        } else if ( typeof(last) == 'string' ) {
            errorObject.message = last || msg;
        } else if ( last instanceof Error || typeof(res) == 'object' && typeof(res.stack) != 'undefined' ) {
            if ( last instanceof Error ) {
                if ( last.message ) { errorObject.message = last.message; }
                if ( last.stack )   { errorObject.stack   = last.stack; }
                if ( !errorObject.error ) { errorObject.error = last.message || std; }
            } else {
                errorObject = fillMissing(last, errorObject);
            }
        } else if (
            !(last instanceof Error) && typeof(res) == 'object' && typeof(res.error) != 'undefined'
            && ( typeof(res.fields) != 'undefined' || typeof(res.flash) != 'undefined' || typeof(res.errors) != 'undefined' )
        ) {
            errorObject = fillMissing(last, errorObject);
        }
        // #B518 — the controller's rule: a ONE-argument error object keeps its
        // `message` and its `ref` (the build above keeps only `status` and `error`
        // of a plain object, and only `message` and `stack` of an Error). The ref
        // is checked where it is minted, and `error` is left as built.
        if ( n == 1 && res && typeof(res) == 'object' ) {
            if ( typeof(errorObject.message) == 'undefined' && typeof(res.message) == 'string' && res.message != '' ) {
                errorObject.message = res.message;
            }
            if ( typeof(errorObject.ref) == 'undefined' && typeof(res.ref) != 'undefined' ) {
                errorObject.ref = res.ref;
            }
        }
    } else if ( n < 3 ) {
        msg  = code || null;
        code = ( res !== null && typeof(res) == 'object' ) ? res : isValidHttpStatus(res) ? res : 500;
    }

    if ( code !== null && typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
        msg  = code.error || code.message;
        code = isValidHttpStatus(code.status) ? code.status : 500;
    }
    if ( !isValidHttpStatus(code) ) {
        code = 500;
    }
    if ( !errorObject ) {
        std = statusText(statusCodes, code);
        errorObject = {
            status : code,
            error  : std || ( msg && msg.error ) || msg
        };
        if ( msg !== null && typeof(msg) != 'undefined' ) {
            errorObject.message = msg.message || msg;
            errorObject.stack   = msg.stack;
        }
    }
    return { errorObject: errorObject, code: code, msg: msg };
}

/**
 * The error writer behind `ctx.error()` / `ctx.throwError()`: the controller's
 * JSON error envelope, one #ERRREF pairing log line, the local-scope stack gate.
 *
 * Always JSON: a lane route has no HTML error page, no `fallback` redirect.
 * Headers already set on the response (`Retry-After`, `RateLimit-*`,
 * `WWW-Authenticate`, CORS, security headers, `X-Request-Id`) are kept.
 *
 * @inner
 * @private
 * @param {LaneContext} ctx
 * @param {Array} args - the call's arguments
 * @returns {boolean} `true` when written, `false` when the call was ignored
 */
function writeError(ctx, args) {
    var req = ctx.req;
    var res = ctx.res;
    if ( res == null || isAnswered(res) ) {
        logLateCall('error()', ( args.length > 1 ) ? args[args.length - 1] : args[0]);
        if ( res != null ) {
            release(ctx);
        }
        return false;
    }
    var conf        = ctx._conf;
    var core        = conf.server.coreConfiguration;
    var built       = buildErrorObject(args, core.statusCodes);
    var errorObject = built.errorObject;
    var msg         = built.msg;
    var code        = Number(built.code);

    errorObject.ref = errorRef.mint(
        errorObject.ref || ( ( msg && typeof(msg) == 'object' ) ? msg.ref : undefined )
    );
    // #ERRREF — the ONE full-detail line, before the egress strip below
    var detail = errorObject.stack || errorObject.message
        || ( ( errorObject.error && typeof(errorObject.error) === 'object' ) ? JSON.stringify(errorObject.error) : errorObject.error )
        || '';
    for (var dk = 0; dk < DETAIL_KEYS.length; ++dk) {
        var dv = errorObject[DETAIL_KEYS[dk]];
        if ( typeof(dv) == 'string' && STACK_FRAME.test(dv) && String(detail).indexOf(dv) < 0 ) {
            detail += '\n'+ dv;
        }
    }
    if ( msg && typeof(msg) == 'object' && msg.cause ) {
        detail += '\ncaused by: '+ ( msg.cause.stack || msg.cause.message || msg.cause );
    }
    var bundle = conf.bundle || ( req.routing && req.routing.bundle ) || '-';
    logger.error('[ BUNDLE ][ '+ bundle +' ][ Lane ][ ref '+ errorObject.ref +' ][ req '+ ( req._ginaReqId || '-' ) +' ] '+ req.method +' [ '+ ( errorObject.status || code ) +' ] '+ req.url + ( detail ? '\n'+ escapeLogDetailKeepFrames(detail) : '' ));

    // outside local scope: no `stack`, and a stack-bearing string keeps its first line (#B670)
    if ( !isLocalScope() ) {
        delete errorObject.stack;
        for (var wk = 0; wk < DETAIL_KEYS.length; ++wk) {
            var wv = errorObject[DETAIL_KEYS[wk]];
            if ( typeof(wv) == 'string' && STACK_FRAME.test(wv) ) {
                errorObject[DETAIL_KEYS[wk]] = wv.split('\n')[0];
            }
        }
    }

    var body = JSON.stringify(errorObject);
    try {
        res.statusCode = code;
        res.writeHead(code, {
            'content-type'   : core.mime['json'] + '; charset='+ conf.encoding,
            'content-length' : Buffer.byteLength(body, 'utf8')
        });
        res.end(body);
    } catch (writeErr) {
        logger.error('[ Lane ] could not write the error response ('+ req.url +'): '+ ( writeErr.stack || writeErr.message || writeErr ));
    }
    release(ctx);
    return true;
}

/**
 * Answer a handler's synchronous throw or rejection with a 500.
 *
 * @inner
 * @private
 * @param {LaneContext} ctx
 * @param {*} err - what was thrown or rejected
 * @returns {boolean}
 */
function handlerFailed(ctx, err) {
    if ( !(err instanceof Error) && typeof(err) != 'string' ) {
        err = new Error('lane handler failed with a non-Error value: '+ describeValue(err));
    }
    return writeError(ctx, [500, err]);
}


/**
 * The single argument a lane handler receives: the live request and response,
 * what the route resolved to, and the methods that answer.
 *
 * Methods live on the prototype, so a handler that passes one around detached
 * must bind it (`ctx.json.bind(ctx)`).
 *
 * @class LaneContext
 * @constructor
 * @memberof module:gina/lib/lane
 * @param {object} req            - the request (its `routing`, `params`, method bags and `body` are set)
 * @param {object} res            - the response
 * @param {object} entry          - the registry entry being dispatched
 * @param {object} conf           - the bundle's configuration (`conf[bundle][env]`)
 * @param {object} [serverInstance] - the engine instance
 *
 * @property {object} req       - the request; `null` once the response is written
 * @property {object} res       - the response; `null` once the response is written
 * @property {object} params    - URL parameters (`req.params`)
 * @property {object} get       - the query parameters (`req.get`)
 * @property {object} body      - the parsed body (`req.body`)
 * @property {object} routing   - the matched route (`req.routing`)
 * @property {string} requestId - the request correlation id (`X-Request-Id`)
 * @property {string} [culture] - the negotiated culture (`req.culture`)
 *
 * @example
 * // <bundle>/lanes/users.js
 * module.exports.get = async function (ctx) {
 *     var user = await users.byId(ctx.params.id);
 *     if (!user) {
 *         return ctx.error(404, 'No user ' + ctx.params.id);
 *     }
 *     ctx.json({ user: user });
 * };
 */
function LaneContext(req, res, entry, conf, serverInstance) {
    this.req       = req;
    this.res       = res;
    this.params    = req.params;
    this.get       = req.get;
    this.body      = req.body;
    this.routing   = req.routing;
    this.requestId = req._ginaReqId;
    this.culture   = req.culture;
    this._entry    = entry;
    this._conf     = conf;
    this._server   = serverInstance || null;
    this._t0       = ( req._devTimeline ) ? Date.now() : 0;
}

/**
 * The session the bundle's session middleware attached (`req.session`), or
 * `undefined` without one, or once the response is written.
 *
 * @name session
 * @memberof module:gina/lib/lane.LaneContext
 * @instance
 * @type {object|undefined}
 */
Object.defineProperty(LaneContext.prototype, 'session', {
    get: function getLaneSession() {
        return ( this.req ) ? this.req.session : undefined;
    }
});

/**
 * Send a JSON response.
 *
 * A `status` key naming a listed non-200 code sets the response status (the key
 * stays in the body); an `errno` key alone does not. On a 2xx, a route's
 * `param.responseDto` shapes the payload. A string is parsed first; a falsy value
 * sends `{}`. Writes once: a second call, or a call after `error()`, is logged and
 * ignored.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @param {object|Array|string} [data] - the payload
 * @returns {boolean} `true` when the response was written, `false` when ignored
 *
 * @example
 * ctx.json({ items: items });                         // 200
 * ctx.json({ status: 201, id: created.id });          // 201
 * ctx.json({ status: 409, error: 'Already exists' }); // 409, the body as given
 */
LaneContext.prototype.json = function(data) {
    return writeJson(this, data);
};

/**
 * Send a JSON error response — the controller `throwError()` envelope:
 * `{ status, error, message?, fields? | errors?, stack? (local scope only), ref }`,
 * where `error` is the status text and `message` the sentence you passed, plus one
 * error-level log line pairing the `ref` with the full detail and the request id.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @param {number|Error|object|string} [status] - the HTTP status, an `Error` (its
 *  `status` property, else 500), or an error object `{ status, error, … }`
 * @param {string|Error|object} [message] - the sentence, an `Error`, or `{ message, ref }`
 * @returns {boolean} `true` when the response was written, `false` when ignored
 *
 * @example
 * ctx.error(404, 'No such invoice');           // {"status":404,"error":"Not Found","message":"No such invoice","ref":"A1B2C3"}
 * ctx.error(500, err);                         // the message, and the stack in local scope only
 * ctx.error({ status: 422, error: 'Validation failed', fields: { email: { isEmail: 'Invalid' } } });
 * ctx.error(500, { ref: 'ORDER-42', message: 'payment capture failed' });   // a relay-safe ref is kept
 */
LaneContext.prototype.error = function() {
    return writeError(this, arguments);
};

/**
 * Alias of `error()`, under the name the framework's gate libraries call on the
 * object they answer through.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @function
 * @param {number|Error|object|string} [status]
 * @param {string|Error|object} [message]
 * @returns {boolean}
 *
 * @example
 * ctx.throwError({ status: 401, error: 'Unauthorized' });
 */
LaneContext.prototype.throwError = LaneContext.prototype.error;

/**
 * The bundle configuration, or one config file's content by name — the controller
 * `getConfig()` contract: a per-call copy-on-write view (a deep clone when
 * `settings.json > controller.getConfig.mode` is `"clone"`), with `hostname` /
 * `host` resolved against this request's proxy classification.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @param {string} [name] - a config name without its extension (`'app'`, `'settings'`, …)
 * @returns {object|undefined} the view — `undefined` for an unknown `name`
 *
 * @example
 * var app = ctx.getConfig('app');   // a private view of config/app.json
 */
LaneContext.prototype.getConfig = function(name) {
    var conf      = this._conf;
    var settings  = ( conf && conf.content ) ? conf.content.settings : null;
    var cloneMode = !!( settings && settings.controller && settings.controller.getConfig && settings.controller.getConfig.mode == 'clone' );
    var tmp       = null;
    if ( typeof(name) != 'undefined' ) {
        try {
            tmp = ( cloneMode ) ? JSONClone(conf.content[name]) : confView.create(conf.content[name]);
        } catch (err) {
            return undefined;
        }
    } else {
        tmp = ( cloneMode ) ? JSONClone(conf) : confView.create(conf);
    }
    // #B66 — this request's proxy classification, the worker-global latch as the fallback
    var req           = this.req;
    var isProxyHost   = ( req && typeof(req._ginaIsProxyHost) != 'undefined' ) ? req._ginaIsProxyHost : ( ( typeof(getContext) == 'function' && getContext('isProxyHost') ) || false );
    var proxyHostname = ( req && req._ginaProxyHostname ) ? req._ginaProxyHostname : ( process.gina && process.gina.PROXY_HOSTNAME );
    var proxyHost     = ( req && req._ginaProxyHost ) ? req._ginaProxyHost : ( process.gina && process.gina.PROXY_HOST );
    if (
        isProxyHost
        && tmp && typeof(tmp) == 'object'
        && typeof(tmp.hostname) != 'undefined'
        && typeof(proxyHostname) != 'undefined'
    ) {
        tmp.hostname = proxyHostname;
        tmp.host     = proxyHost;
    }
    return tmp;
};

/**
 * Whether the authenticated caller holds `role` — the session user when present,
 * else a machine caller the authorization gate verified (`req.machineCaller`),
 * read through `lib/authz-gate` like the controller's `hasRole()`.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @param {string} role
 * @returns {boolean} `false` without a principal, and once the response is written
 *
 * @example
 * if ( ctx.hasRole('admin') ) { payload.audit = doc.audit; }
 */
LaneContext.prototype.hasRole = function(role) {
    var req = this.req;
    if ( req == null ) {
        return false;
    }
    var session = req.session;
    var user    = ( session && session.user )
        ? session.user
        : ( ( req.machineCaller && typeof(req.machineCaller) == 'object' ) ? req.machineCaller : null );
    return authzGate.hasAnyRole(user, [ role ]);
};

/**
 * Whether the request is an XHR / API call (`req.isXMLRequest`).
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @returns {boolean}
 *
 * @example
 * if ( !ctx.isXMLRequest() ) { … }
 */
LaneContext.prototype.isXMLRequest = function() {
    return !!( this.req && this.req.isXMLRequest === true );
};

/**
 * Snapshot the request as `haltedRequest` in `requestStorage` (default
 * `req.session`) so it can be replayed after a login — the controller
 * `pauseRequest()` snapshot: `{ url, routing, method, data, params? }`.
 *
 * @memberof module:gina/lib/lane.LaneContext
 * @param {object} data             - the request data to keep (`req[method]`)
 * @param {object} [requestStorage] - where to store it; defaults to `req.session`
 * @returns {object|undefined} `requestStorage`; `undefined` once the response is
 *  written, or after answering 424 when there is no storage
 *
 * @example
 * ctx.pauseRequest(ctx.get);   // req.session.haltedRequest = { url, routing, method: 'get', data }
 */
LaneContext.prototype.pauseRequest = function(data, requestStorage) {
    var req = this.req;
    if ( req == null ) {
        return;
    }
    var haltedRequest = {
        url     : req.originalUrl || req.url,
        routing : req.routing,
        method  : req.method.toLowerCase(),
        data    : JSONClone(data)
    };
    if ( typeof(requestStorage) == 'undefined' && typeof(req.session) != 'undefined' ) {
        requestStorage = req.session;
    }
    if ( typeof(requestStorage) == 'undefined' ) {
        var storageErr = new Error('`requestStorage` is required');
        storageErr.status = 424;
        this.error(storageErr);
        return;
    }
    var requestParams = {};
    var i = 0;
    for (var p in req.params) {
        if ( i > 0 ) {
            requestParams[p] = req.params[p];
        }
        ++i;
    }
    if ( Object.keys(requestParams).length > 0 ) {
        haltedRequest.params = requestParams;
    }
    requestStorage.haltedRequest = haltedRequest;
    return requestStorage;
};


/**
 * Run a lane route's handler (called by `core/server.js` at the end of the isaac
 * middleware chain, or directly on express).
 *
 * In dev mode the registered modules are reloaded first when the watcher flagged
 * a change. An entry the registry does not hold, or one whose module failed to
 * reload, answers 500 naming it. The handler runs as `fn.call(module, ctx)`; a
 * synchronous throw, or a rejection of the promise it returns, answers 500 through
 * `ctx.error()` (or is logged when the handler had already answered). Never calls
 * `next`: the lane answers every request itself.
 *
 * @memberof module:gina/lib/lane
 * @param {object} entry            - from `lookup()`
 * @param {object} req              - the request
 * @param {object} res              - the response
 * @param {function} [next]         - the engine's next (express); unused
 * @param {object} [serverInstance] - the engine instance
 * @param {object} conf             - the bundle's configuration (`conf[bundle][env]`)
 * @returns {void} never the handler's promise, so a rejection cannot escape
 *
 * @example
 * lib.lane.dispatch(lib.lane.lookup(req.routing), req, res, next, instance, conf);
 */
function dispatch(entry, req, res, next, serverInstance, conf) {
    if ( isDev() ) {
        reloadIfDirty();
    }
    var ctx = new LaneContext(req, res, entry, conf, serverInstance);
    if ( entry.missing ) {
        ctx.error(500, 'lane route `'+ entry.rule +'` names `'+ entry.lane +'#'+ entry.control +'`, which is not registered for bundle `'+ entry.bundle +'` (lane routes are registered at boot; a route added since needs a restart)');
        return;
    }
    if ( entry.error ) {
        ctx.error(500, entry.error);
        return;
    }
    // the Flow bar opens before the handler so it precedes the writer's bars
    var tlEntry = null;
    if ( ctx._t0 && req._devTimeline && req._devTimeline.entries ) {
        tlEntry = { label: 'lane-dispatch', cat: 'controller', startMs: ctx._t0, endMs: ctx._t0, durationMs: 0, detail: entry.lane +'#'+ entry.control };
        req._devTimeline.entries.push(tlEntry);
    }
    var result = null;
    try {
        result = entry.fn.call(entry.module, ctx);
    } catch (err) {
        handlerFailed(ctx, err);
        result = null;
    }
    if ( tlEntry ) {
        tlEntry.endMs      = Date.now();
        tlEntry.durationMs = tlEntry.endMs - tlEntry.startMs;
    }
    if ( result && typeof(result.then) == 'function' ) {
        result.then(null, function onLaneRejected(err) {
            handlerFailed(ctx, err);
        });
    }
}

module.exports = {
    registerRoutes : registerRoutes,
    lookup         : lookup,
    dispatch       : dispatch,
    watchDirs      : watchDirs,
    isLaneName     : isLaneName,
    LaneContext    : LaneContext
};
