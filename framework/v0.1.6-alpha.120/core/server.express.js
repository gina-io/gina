"use strict";
/**
 * Express JS Server Integration
 *
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



    return {
        instance: app,
        middleware: express
    }
};

module.exports = ServerEngineClass;