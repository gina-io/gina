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
    // on every request under Express 5. Shadowing the getter with a writable
    // own DATA property on the per-app request prototype restores gina's
    // owns-the-query-parse contract; on Express 4 the property does not exist
    // on the prototype chain as a getter, so this is a measured no-op there.
    Object.defineProperty(app.request, 'query', {
        value: undefined,
        writable: true,
        configurable: true,
        enumerable: false
    });

    return {
        instance: app,
        middleware: express
    }
};

module.exports = ServerEngineClass;