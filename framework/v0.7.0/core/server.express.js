"use strict";
/**
 * @module gina/core/server.express
 */
/**
 * Wraps an Express application for use inside the Gina server pipeline.
 * Patches `express.createApplication` to inject TLS credentials and selects
 * the correct Node.js transport (http, https, http2.createServer, or
 * http2.createSecureServer) based on `options.protocol` and `options.scheme`.
 *
 * Returns `{ instance: app, middleware: express }` where `instance` is the
 * configured Express app and `middleware` is the raw express module.
 *
 * **Inspector endpoints:** This file has no `/_gina/*` handlers.
 * `server.js` registers all Inspector endpoints (`/_gina/inspector/*`,
 * `/_gina/logs`, `/_gina/agent`) on the Express `app` instance returned
 * here, inside its `onRequest()` catch-all (`self.instance.all(/(.*)/, ...)`
 * — a RegExp since #B211, because Express 5's router rejects the former
 * bare-string `'*'` at mount time).
 * No fast-path is needed in this adapter because Express request handling
 * already flows through `server.js`.
 *
 * **Supported Express range: >= 4 < 6** (#B211 — both majors verified live;
 * an out-of-range major logs a loud warning at engine construction and
 * boots anyway).
 *
 * @class ServerEngineClass
 * @constructor
 * @param {object} options - Server configuration
 * @param {object} options.credentials - TLS/SSL credential paths
 * @param {string} options.credentials.privateKey - Path to the private key file
 * @param {string} options.credentials.certificate - Path to the certificate file
 * @param {string} [options.credentials.ca] - Path to the CA bundle file
 * @param {string} [options.credentials.passphrase] - PEM passphrase
 * @param {string} options.protocol - Protocol string (e.g. 'http/1.1', 'http/2')
 * @param {string} options.scheme - Scheme: 'http' or 'https'
 * @param {boolean} [options.allowHTTP1=true] - Allow HTTP/1.x fallback for HTTP/2 servers
 * @returns {{ instance: object, middleware: function }} Configured Express app and express module
 */
const fs        = require('fs');
const express   = require('express');

const lib       = require('./../lib');
const inherits  = lib.inherits;
const merge     = lib.merge;
const console   = lib.logger;

const env                   = process.env.NODE_ENV
    , isDev                 = (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false
    , scope                 = process.env.NODE_SCOPE
    , isLocalScope          = (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false
    , isProductionScope     = (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false
;

/**
 * Returns the engine-parsed query as a plain object (#B666).
 *
 * Express 5's default `simple` query parser is `querystring.parse`, whose result
 * has a `null` prototype. The framework's request bags are plain objects: the
 * `count()` helper installed on `Object.prototype` iterates `this.hasOwnProperty`,
 * and a controller reads `req.get.count()` / `req.delete.count()` as documented.
 * A null-prototype bag would make that count read 0 for every key it holds.
 *
 * The copy is built with `Object.defineProperty`, so a client-chosen key such as
 * `__proto__` becomes an own data property of the copy and never reaches the
 * `__proto__` setter. An `extended` (qs) parse or a custom parser already returns
 * an ordinary object and is handed back untouched; anything that is not an object
 * becomes an empty bag.
 *
 * @inner
 * @private
 * @param {*} parsed - What the engine's `query parser` returned
 * @returns {object} A plain object carrying the same own keys and values
 *
 * @example
 * toPlainQuery(require('querystring').parse('a=1&b=2'));   // { a: '1', b: '2' } — plain, count() → 2
 * toPlainQuery({ a: '1' });                                 // the same object
 * toPlainQuery(undefined);                                  // {}
 */
function toPlainQuery(parsed) {
    if ( parsed === null || typeof parsed !== 'object' ) {
        return {};
    }
    if ( Object.getPrototypeOf(parsed) !== null ) {
        return parsed;
    }
    var plain = {};
    Object.keys(parsed).forEach(function (key) {
        Object.defineProperty(plain, key, {
            value: parsed[key],
            writable: true,
            configurable: true,
            enumerable: true
        });
    });
    return plain;
}

/**
 * Builds the accessor descriptor gina installs over `query` on the per-app
 * request prototype (`app.request`) — the #B211 shadow, completed by #B666.
 *
 * Express 5 defines `req.query` as a prototype GETTER (its `lib/request.js`);
 * the framework's request pipeline (core/server.js) ASSIGNS `request.query`
 * under 'use strict', which throws through a getter-only property. #B211 shadowed
 * the getter with a writable own data property holding `undefined`, which kept
 * the assignments alive but left EVERY request's `request.query` undefined until
 * the pipeline assigned it — and it assigns it only on its GET and HEAD branches.
 * Its DELETE branch and the empty-body fallback of the POST, PUT and PATCH
 * branches read `request.query` raw through `ownCount()`, which re-raises the
 * shorthand's TypeError on `undefined` by design (#B546): on Express 5 one
 * DELETE, or one POST/PUT/PATCH without a body, threw inside the request's `end`
 * handler, took the `uncaughtException` path and killed the bundle —
 * unauthenticated, on any URL, before routing. Express 4 never hit this: its
 * auto-mounted query middleware assigns `req.query` as an own property on every
 * request before any other layer runs.
 *
 * The accessor replaces the data property. Its getter runs on the first read of a
 * request that nothing assigned yet: it calls the engine's own getter beneath the
 * shadow — so the app's `query parser` setting is honoured at read time (`simple`
 * by default on 5, `extended` or a custom function when the app sets one, an
 * empty bag when parsing is disabled) — copies the result to a plain object and
 * materialises it as a writable own property of the request. Its setter stores an
 * assigned value the same way, so every `request.query =` site in the pipeline
 * keeps working under strict mode. Where the prototype chain carries no `query`
 * getter (Express 4) the getter answers `undefined` and materialises nothing, and
 * the setter stores — byte-for-byte the #B211 data property's behaviour, so
 * Express 4's own query middleware (`if (!req.query) req.query = parse(...)`)
 * runs exactly as before. Reading `query` on the prototype itself never
 * materialises anything on it. Installing the accessor creates no Express router
 * and registers no layer, so a consumer's `app.set(...)` in `onInitialize` is
 * honoured as it always was.
 *
 * The framework's first read of `request.query` on this engine happens inside its
 * catch-all layer (core/server.js, #B668), so a `query parser` that throws is
 * answered by Express's own layer catch with a 500 — never by a process exit.
 *
 * @inner
 * @private
 * @param {object} appRequest - The per-app request prototype (`app.request`)
 * @returns {PropertyDescriptor} `{ configurable, enumerable, get, set }` for `Object.defineProperty`
 *
 * @example
 * Object.defineProperty(app.request, 'query', queryAccessorDescriptor(app.request));
 * // Express 5: GET /path?x=1  → req.query is { x: '1' } (plain, own, assignable) from the first read on
 * // Express 4: req.query reads undefined until the query middleware assigns it → as before
 */
function queryAccessorDescriptor(appRequest) {
    var nativeGetter = null;
    var proto = Object.getPrototypeOf(appRequest);
    while ( proto && proto !== Object.prototype ) {
        var descriptor = Object.getOwnPropertyDescriptor(proto, 'query');
        if ( descriptor ) {
            if ( typeof descriptor.get === 'function' ) {
                nativeGetter = descriptor.get;
            }
            break;
        }
        proto = Object.getPrototypeOf(proto);
    }
    var materialise = function (req, query) {
        Object.defineProperty(req, 'query', {
            value: query,
            writable: true,
            configurable: true,
            enumerable: true
        });
        return query;
    };
    return {
        configurable: true,
        enumerable: false,
        get: function () {
            if ( !nativeGetter || this === appRequest ) {
                return undefined;
            }
            return materialise(this, toPlainQuery(nativeGetter.call(this)));
        },
        set: function (value) {
            materialise(this, value);
        }
    };
}

function ServerEngineClass(options) {

    const credentials = {
        key: fs.readFileSync(options.credentials.privateKey),
        cert: fs.readFileSync(options.credentials.certificate)
    };

    var local = {};

    var allowHTTP1 = true; // by default
    if (typeof (options.allowHTTP1) != 'undefined' && options.allowHTTP1 != '' ) {
        allowHTTP1 = options.allowHTTP1;
    }
    credentials.allowHTTP1 = allowHTTP1;

    if (typeof (options.credentials.ca) != 'undefined' && options.credentials.ca != '' )
        credentials.ca = options.credentials.ca;

    if (typeof (options.credentials.passphrase) != 'undefined' && options.credentials.passphrase != '')
        credentials.passphrase = options.credentials.passphrase;


    /**
     * Replacement for Express's internal `createApplication` factory.
     * Creates an Express application, mixes in EventEmitter and proto,
     * and calls `app.init(credentials)` with the provided TLS credentials.
     *
     * @inner
     * @private
     * @param {object} credentials - TLS credential object (key, cert, ca, passphrase)
     * @returns {function} Configured Express application
     */
    var createApplication = function (credentials) {
        var app = function(req, res, next) {
            app.handle(req, res, next);
        };

        mixin(app, EventEmitter.prototype, false);
        mixin(app, proto, false);

        // expose the prototype that will get set on requests
        app.request = Object.create(req, {
            app: { configurable: true, enumerable: true, writable: true, value: app }
        })

        // expose the prototype that will get set on responses
        app.response = Object.create(res, {
            app: { configurable: true, enumerable: true, writable: true, value: app }
        })


        app.init(credentials);
        return app;
    }




    express.createApplication = createApplication;

    //var app = express();
    var app     = null
        , http  = null
        , https = null
        , http2 = null
    ;

    if ( /^http\/2/.test(options.protocol) ) {
        http2   = require('http2');
        switch (options.scheme) {
            case 'http':
                var app = express({ allowHTTP1: allowHTTP1 });
                app.init = function() {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.defaultConfiguration();
                };

                app.listen = function() {
                    var server = http2.createServer(this);

                    return server.listen.apply(server, arguments);
                };
                break;

            case 'https':

                var app = express(credentials);
                app.init = function(credentials) {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.credentials = credentials;

                    this.defaultConfiguration();
                };

                app.credentials = credentials;
                app.listen = function() {
                    var server = http2.createSecureServer(this.credentials, this);

                    return server.listen.apply(server, arguments);
                };

                break;

            default:

                var app = express({ allowHTTP1: allowHTTP1 });
                app.init = function() {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.defaultConfiguration();
                };

                app.listen = function() {
                    var server = http2.createServer(this);

                    return server.listen.apply(server, arguments);
                };

                break;
        }

    } else {

        switch (options.scheme) {
            case 'http':
                http    = require('http');
                app = express();

                app.init = function(credentials) {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.credentials = credentials;

                    this.defaultConfiguration();
                };

                app.listen = function() {
                    var server = http.createServer(this);

                    return server.listen.apply(server, arguments);
                };
                break;

            case 'https':
                https   = require('https');

                app = express(credentials);

                app.init = function(credentials) {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.credentials = credentials;

                    this.defaultConfiguration();
                };

                app.credentials = credentials;
                app.listen = function() {
                    var server = https.createServer(this.credentials, this);

                    //var server = http2.createSecureServer(this.credentials, this);
                    return server.listen.apply(server, arguments);
                };


                break;


            default:

                http    = require('http');
                app     = express();

                app.init = function(credentials) {
                    this.cache = {};
                    this.engines = {};
                    this.settings = {};
                    this.credentials = credentials;

                    this.defaultConfiguration();
                };

                app.listen = function() {
                    var server = http.createServer(this);

                    return server.listen.apply(server, arguments);
                };
                break;
        }
    }



    // #B211 — Express version awareness. The supported range is declared HERE
    // (express is consumer-provided by design — deliberately NOT a dependency,
    // and NEVER a peerDependency: npm >= 7 auto-installs peers, which would
    // force express onto every consumer of the framework).
    var expressVersion = 'unknown';
    try {
        expressVersion = require('express/package.json').version;
    } catch (_e) { /* best effort — version display only */ }
    var expressMajor = parseInt(expressVersion, 10);
    console.info('engine: express v' + expressVersion + ' (supported: >= 4 < 6)');
    if ( !isNaN(expressMajor) && (expressMajor < 4 || expressMajor >= 6) ) {
        // WARN, never refuse (gate decision 2026-08-15): an unverified future
        // major may work, and a wrong refusal is a total outage while a wrong
        // warning is a log line. Verified majors: 4 and 5.
        console.warn('engine: express v' + expressVersion + ' is OUTSIDE the verified range (>= 4 < 6) — the bundle will boot, but this combination is unverified; pin express@^4 or express@^5 if anything misbehaves.');
    }

    // #B211 — Express 5 defines `req.query` as a prototype GETTER (v4 assigned
    // it from its auto-mounted query middleware as an own property). Gina's
    // request pipeline (core/server.js) computes and ASSIGNS `request.query`
    // itself under 'use strict', which throws
    //   TypeError: Cannot set property query ... which has only a getter
    // on every request under Express 5. #B211 shadowed the getter with a
    // writable own DATA property holding `undefined` — which kept the
    // assignments alive but left every request's `request.query` undefined on
    // Express 5 until the pipeline assigned it (its GET/HEAD branches only), so
    // the branches that count it raw killed the bundle (#B666).
    // #B666 — the shadow is now an ACCESSOR (queryAccessorDescriptor above): the
    // getter materialises the engine's own parse as a plain, writable own
    // property on the first read, the setter keeps `request.query =` working
    // under strict mode; on Express 4 it reads undefined and stores, exactly as
    // the data property did. No layer is registered and no router is created
    // here, so a consumer's `app.set(...)` in onInitialize is honoured as before.
    // was: Object.defineProperty(app.request, 'query', { value: undefined, writable: true, configurable: true, enumerable: false });
    Object.defineProperty(app.request, 'query', queryAccessorDescriptor(app.request));

    return {
        instance: app,
        middleware: express
    }
};

module.exports = ServerEngineClass;