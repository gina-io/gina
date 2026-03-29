//"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */


//Imports.
var fs                  = require('fs')
    , lib               = require('./../lib')
    , console           = lib.logger
    , inherits          = lib.inherits
    , merge             = lib.merge
    , SuperController   = require('./controller')
    , Config            = require('./config')
;

/**
 * @class Router
 *
 *
 * @package     Gina
 * @namespace
 * @author      Rhinostone <contact@gina.io>
 * @api         Public
 */
// cached at module load — these env vars never change at runtime (#P18)
var _isDev = process.env.NODE_ENV_IS_DEV && process.env.NODE_ENV_IS_DEV.toLowerCase() === 'true';

// extracted from Router::route() — try-catch prevents V8 JIT optimization of the outer function (#P25)
function resolveRouteConfig(serverInstance, params, response, controllerFile, local) {
    try {
        var config = new Config().getInstance();
        if (!params.bundle) {
            try {
                //params.bundle = config.bundle;
                //params.param = config.routing[config.reverseRouting[params.param.url]];
                var _rule = config.reverseRouting[params.param.url];
                params = merge(params, config.routing[_rule]);
                params.rule = _rule;
            } catch(reverseRoutingError) {
                serverInstance.throwError(response, 500, reverseRoutingError);
                return null;
            }
        }
        var bundle = params.bundle;
        local.bundle = bundle;
        return {
            config  : config,
            bundle  : bundle,
            env     : config.env,
            scope   : config.scope,
            conf    : config[bundle][config.env],
            params  : params
        };
    } catch (configErr) {
        serverInstance.throwError(response, 500, new Error('syntax error(s) found in `'+ controllerFile +'` \nTrace: ') + (configErr.stack || configErr.message) );
        return null;
    }
}

function Router(env, scope) {

    this.name = 'Router';

    var self = this
        , local = {}
    ;

    /**
     * Router Constructor
     * @constructor
     * */
    var init = function() {

        if ( typeof(Router.initialized) != "undefined" ) {
            return self.getInstance()
        }

        self.initialized = true;
        self.hasCompletedControlllerSetup = false;
    }

    var isSetupRequired = function(control) {

        if (local.isXMLRequest) return false;

        return ([
            'redirect',
            'query',
            'store',
            'downloadFromLocal',
            'downloadFromURL'
        ].indexOf(control) < 0 ) ? true : false;
    }

    this.getInstance = function() {
        return self
    }

    /**
     * Core dependencies refresh for cacheless env
     *  - {core}/controller/controller.js
     */
    var refreshCoreDependencies= function() {

        var corePath    = getPath('gina').core;

        // Super controller
        delete require.cache[require.resolve(_(corePath +'/controller/controller.js', true))];
        delete require.cache[require.resolve(_(corePath +'/controller/index.js', true))];
        // removed: direct pre-load of controller.js — index.js (in dev/cacheless mode) deletes and
        // re-requires controller.js internally, so pre-loading it here caused a double instantiation
        // (Domain constructor, swig init, etc.) on every request. Let index.js own the re-require.
        require.cache[_(corePath +'/controller/index.js', true)] = require( _(corePath +'/controller/index.js', true) );

        SuperController = require.cache[_(corePath +'/controller/index.js', true)];

        corePath = null;
    }

    this.setServerInstance = function(serverInstance) {
        serverInstance._http2streamEventInitalized = false;
        self.serverInstance = serverInstance;
    }

    this.getServerInstance = function () {
        return self.serverInstance;
    }

    /**
     * Check if env is running cacheless
     * */
    // replaced: per-request process.env lookup — use cached boolean (#P18)
    this.isCacheless = function() {
        return _isDev;
    }


    /**
     * Route on the fly
     *
     * @param {object} request
     * @param {object} response
     * @param {object} params - Route params
     *
     * @callback next
     * */
    this.route = function(request, response, next, params) {

        /**
         * Sample code to detect memory leaks before Router::route()
         */
        // response.end(JSON.stringify({ status: 'ok'}));
        // request     = null;
        // response    = null;
        // params      = null;
        // if (next) {
        //     return next()
        // }
        // return ;


        var serverInstance   = self.getServerInstance();
        var isCacheless      = self.isCacheless();
        // replaced: inline try-catch — extracted to resolveRouteConfig() for V8 optimization (#P25)
        var _resolved = resolveRouteConfig(serverInstance, params, response, controllerFile, local);
        if (!_resolved) return;
        var bundle  = _resolved.bundle;
        var conf    = _resolved.conf;
        params      = _resolved.params;

        local.isCacheless   = isCacheless;
        local.request       = request;
        local.next          = next;
        local.conf          = conf;
        local.isStandalone  = conf.isStandalone;


        /**
         * Reverse proxy check
         */
        var requestPort = request.headers.port || request.headers[':port'];
        var isProxyHost = (
            typeof(request.headers.host) != 'undefined'
            && typeof(requestPort) != 'undefined'
            &&  (requestPort === '80' || requestPort === '443' || requestPort === 80 || requestPort === 443)
            && conf.server.scheme +'://'+ request.headers.host +':'+ requestPort != conf.hostname.replace(/\:\d+$/, '') +':'+ conf.server.port
            ||
            typeof(request.headers[':authority']) != 'undefined'
            && conf.server.scheme +'://'+ request.headers[':authority'] != conf.hostname
            ||
            typeof(request.headers.host) != 'undefined'
            && typeof(requestPort) != 'undefined'
            && (requestPort === '80' || requestPort === '443' || requestPort === 80 || requestPort === 443)
            && request.headers.host == conf.host
            ||
            typeof(request.headers['x-nginx-proxy']) != 'undefined'
            && String(request.headers['x-nginx-proxy']).toLowerCase() === 'true'
            ||
            typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) ? true : false;

        setContext('isProxyHost', isProxyHost);



        /**
        * ExpressJS modules + HTTP2 fix
        * Hack required until `express-<plugin>` get support for http2 `express-session`
        * or similar modules
        */
        if (!response._implicitHeader) {
            response._implicitHeader = function(){ return; }; // we need to force it
        }

        /**
        * EO Passport JS HTTP2 fix
        */

        /**
        * BO Passport JS HTTP2 fix : taken from passport/request.js
        */
       if (
            typeof(request._passport) != 'undefined'
            && typeof(request.isAuthenticated) == 'undefined'
            ||
            typeof(request.session) != 'undefined'
            && typeof(request.isAuthenticated) == 'undefined'
            ||
            typeof(request.session) != 'undefined'
            && typeof(request.session.passport) != 'undefined'
       ) {
            request.isAuthenticated = function() {
                var property = 'user';
                // by default
                var sess = this;
                if (sess._passport && sess._passport.instance) {
                    property = sess._passport.instance._userProperty || 'user';
                }
                if ( !sess._passport
                    && typeof(sess.session) != 'undefined'
                ) {
                    sess = sess.session;
                }

                var isAuthenticated = (sess[property]) ? true : false;
                if (isAuthenticated) {
                    request.session.user = sess[property]
                }
                // if (isAuthenticated && typeof(request.session.user.cached) == 'undefined' ) {
                //     request.session.user.cached = {}
                // }
                return isAuthenticated;
            };
        }

        // if (
        //     typeof(request._passport) != 'undefined'
        //     && typeof(request.isScopeAllowed) == 'undefined'
        // ) {
        //     request.isScopeAllowed = function() {
        //         var property = 'scope';
        //         if (this._passport && this._passport.instance) {
        //             property = this._passport.instance._scopeProperty || 'scope';
        //         }
        //         var isScopeAllowed = (this[property]) ? true : false;
        //         if (isScopeAllowed) {
        //             request.session.scope = this[property]
        //         }
        //         return isScopeAllowed;
        //     };
        // }

        if (
            typeof(request._passport) != 'undefined'
            && typeof(request.logIn) == 'undefined'
            ||
            typeof(request.login) == 'undefined'
        ) {
            request.login =
            request.logIn = function(user, options, done) {
                if (typeof options == 'function') {
                    done = options;
                    options = {};
                }
                options = options || {};

                var property = 'user';
                if (this._passport && this._passport.instance) {
                    property = this._passport.instance._userProperty || 'user';
                }
                var session = (options.session === undefined) ? true : options.session;

                this[property] = user;

                if (!session) {
                    done && done();
                    return;
                }


                if (!this._passport) {
                    throw new Error('passport.initialize() middleware not in use');
                }
                if (typeof done != 'function') {
                    throw new Error('req#login requires a callback function');
                }

                var self = this;
                this._passport.instance._sm.logIn(this, user, function(err) {
                    if (err) {
                        self[property] = null;
                        return done(err);
                    }
                    done();
                });
            };
        }

        if (
            typeof(request._passport) != 'undefined'
            && typeof(request.logOut) == 'undefined'
            ||
            typeof(request.session) != 'undefined'
            && typeof(request.logout) == 'undefined'
        ) {
            request.logout =
            request.logOut = function() {
                var property = 'user';

                // by default
                var sess = this;
                if (sess._passport && sess._passport.instance) {
                    property = sess._passport.instance._userProperty || 'user';
                }
                if ( !sess._passport
                    && typeof(sess.session) != 'undefined'
                ) {
                    sess = sess.session;
                }

                sess[property] = null;
                if (sess._passport) {
                    sess._passport.instance._sm.logOut(sess);
                }


                // if (this._passport && this._passport.instance) {
                //     property = this._passport.instance._userProperty || 'user';
                // }
                // this[property] = null;
                // if (this._passport) {
                //     this._passport.instance._sm.logOut(this);
                // }
            };
        }

        // for redirect with `hidden inheritedData`
        // replaced: /^get$/i.test() (#P15)
        if ( request.method.toUpperCase() === 'GET' && typeof(request.session) != 'undefined' ) {
            var userSession = request.session.user || request.session;
            if ( typeof(userSession.inheritedData) != 'undefined' ) {
                if (!request.get) {
                    request.get = {};
                }
                request.get = merge(request.get, userSession.inheritedData);

                // if not persisted ... means that if you refresh the current page, `inheritedData` will be lost
                delete userSession.inheritedData;
            }
        }

        /**
        * EO Passport JS HTTP2 fix
        */


        if (isCacheless) {
            refreshCoreDependencies();
        }


        var action          = request.control = params.param.control;
        // more can be added ... but it will always start by `on`Something.
        var reservedActions = [
            'onReady',
            'setup'
        ];


        if (reservedActions.indexOf(action) > -1) {
            serverInstance.throwError(response, 500, '[ this.'+action+' ] is reserved for the framework');
            return;
        }


        // Routing object
        var routerObj = {
            response                    : response,
            next                        : next,
            hasViews                    : ( typeof(conf.content.templates) != 'undefined' ) ? true : false,
            isUsingTemplate             : conf.template,
            isProcessingXMLRequest      : params.isXMLRequest,
            isProcessingWithcredentials : params.isWithCredentials
        };

        setContext('router', routerObj);

        var middleware      = params.middleware || [];
        var actionFile      = params.param.file || null; // matches rule name
        var namespace       = params.namespace;
        var routeHasViews   = routerObj.hasViews;
        var isUsingTemplate = conf.template;
        var hasSetup        = false;


        local.isXMLRequest      = params.isXMLRequest;
        local.isWithCredentials = params.isWithCredentials;
        local.routeHasViews     = routeHasViews;
        local.isUsingTemplate   = isUsingTemplate;


        //Getting superCleasses & extending it with super Models.
        var mainControllerFile          = conf.bundlesPath +'/'+ bundle + '/controllers/controller.js'
            , controllerFile            = null
            , MainController            = {} // controller.js
            , Controller                = {} // controller.namespace.js
            , hasControllerNamespace    = (namespace) ? true : false
        ;

        // TODO -  ?? Merge all controllers into a single file while building for other env than `dev`
        var filename        = ''
            , filenameObj   = null
        ;
        if (hasControllerNamespace) {
            filenameObj = new _(conf.bundlesPath +'/'+ bundle + '/controllers/controller.'+ namespace +'.js', true);
            filename    = filenameObj.toString();
            if ( !filenameObj.existsSync() ) {
                hasControllerNamespace = false;
                console.warn('Namespace `'+ namespace +'` found, but no related controller file found at `'+filename+'` to load: just ignore this message if this is ok with you');
                filename = conf.bundlesPath +'/'+ bundle + '/controllers/controller.js';
                console.info('Switching to default controller: '+ mainControllerFile);
            }
            filenameObj = null;
        } else {
            filename = mainControllerFile;
        }
        controllerFile = filename;

        /**
         * BO routing configuration
         * Attention: this portion of code is replicated in `form-validator.js`
         * Any modification on this part must be reflected on `form-validator.js`
         */
        // default param setting
        if ( !params.rule ) {
            params.rule = params.name;
        }
        var templateName = params.rule.replace('\@'+ bundle, '') || '_common';

        var options = {
            // view namespace first
            namespace       : (/controller\.js$/i.test(controllerFile)) ? null : params.param.namespace || namespace,
            control         : params.param.control,
            controller      : controllerFile,
            //controller: '<span class="gina-bundle-name">' + bundle +'</span>/controllers/controller.js',
            file            : actionFile,
            //bundle          : bundle,//module
            bundlePath      : conf.bundlesPath + '/' + bundle,
            rootPath        : conf.executionPath || null,
            executionPath   : conf.executionPath || null,
            //instance: self.serverInstance,
            isUsingTemplate : local.isUsingTemplate,
            isCacheless     : isCacheless,
            path            : params.param.path || null, // user custom path : namespace should be ignored or left blank
            assets          : {}
        };

        if (routeHasViews) {
            options.template = (routeHasViews) ? conf.content.templates[templateName] || conf.content.templates._common : undefined;
            options.template.externalPlugins = [];
            if ( /http\/2/.test(conf.server.protocol) ) {
                options.template.h2Links = '';
            }
        }

        // Options need to be protected by a clone to allow overrides
        options = merge(JSON.clone(options), params);
        // options = merge(options, params);

        // We want to keep original conf untouched
        options.conf = JSON.clone(conf);
        // inheriting from _common
        if (
            options.template
            && typeof(options.template.ginaLoader) == 'undefined'
        ) {
            options.template.ginaLoader = options.conf.content.templates._common.ginaLoader;
        }
        options.conf.content.routing[options.rule].param = params.param;
        delete options.middleware;
        delete options.param;
        delete options.requirements;
        delete options.cache;
        /**
         * EO routing configuration
         */
        var setupFileObj    = new _(conf.bundlesPath +'/'+ bundle + '/controllers/setup.js', true)
            , setupFile     = setupFileObj.toString()
        ;
        try {

            if ( setupFileObj.existsSync() ) {
                hasSetup = true;
            }
            setupFileObj = null;

            if (isCacheless) {
                if (hasControllerNamespace) {
                    delete require.cache[require.resolve(_(mainControllerFile, true))];
                }
                delete require.cache[require.resolve(_(controllerFile, true))];

                if ( hasSetup )
                    delete require.cache[require.resolve(_(setupFile, true))];
            }
            if (hasControllerNamespace) {
                MainController = require(_(mainControllerFile, true));
            }
            Controller = require(_(controllerFile, true));

        } catch (err) {
            // means that you have a syntax errors in you controller file
            // TODO - increase `stack-trace` from 10 (default value) to 500 or more to get the exact error --stack-trace-limit=1000
            // TODO - also check `stack-size` why not set it to at the same time => --stack-size=1024
            return serverInstance.throwError(response, 500, new Error('syntax error(s) found in `'+ controllerFile +'` \nTrace: ') + (err.stack || err.message) );
        }


        // about to contact Controller ...
        try {
            if (hasControllerNamespace) {
                MainController = inherits(MainController, SuperController);
                Controller      = inherits(Controller, MainController, SuperController);
            } else {
                Controller      = inherits(Controller, SuperController);
            }


            var controller  = new Controller(options);
            controller.name = options.control;
            // Required before setting options
            controller.serverInstance = serverInstance;
            controller.setOptions(request, response, next, options);

            /**
             * requireController
             * Allowing another controller (public methods) to be required inside the current controller
             *
             * @param {string} namespace - Controller namespace
             * @param {object} [options] - Controller options
             *
             * @returns {object} controllerInstance
             * */
            var requireController = function (namespace, options) {

                // replaced: per-request process.env lookup — use cached boolean (#P18)
                var isCacheless = _isDev;
                var corePath    = getPath('gina').core;
                var config      = getContext('gina').Config.instance;
                var bundle      = config.bundle;
                var env         = config.env;
                var scope       = config.scope;
                var bundleConf  = config.Env.getConf(bundle, env);

                var controllerFile  = ( typeof(namespace) != 'undefined' && namespace != '' && namespace != 'null' && namespace != null ) ? 'controller.'+ namespace : 'controller';
                var filename        = _(bundleConf.bundlesPath + '/' + bundle + '/controllers/' + controllerFile + '.js', true);

                if (typeof (options.controlRequired) == 'undefined') {
                    options.controlRequired = [];
                }

                var ctrlInfo = {};
                ctrlInfo[controllerFile] = filename;
                options.controlRequired.push(ctrlInfo);

                try {

                    //if (isCacheless) {
                        // Super controller
                        delete require.cache[require.resolve(_(corePath +'/controller/index.js', true))];
                        require.cache[_(corePath +'/controller/index.js', true)] = require( _(corePath +'/controller/index.js', true) );

                        delete require.cache[require.resolve(filename)];
                    //}

                    var SuperController     = require.cache[_(corePath +'/controller/index.js', true)];


                    var RequiredController  = require(filename);

                    RequiredController      = inherits(RequiredController, SuperController);

                    var controller = null;
                    if ( typeof(options) != 'undefined' ) {

                        controller = new RequiredController( options );
                        controller.name = namespace;
                        // Required before setting options
                        controller.serverInstance = serverInstance;
                        controller.setOptions(request, response, next, options);

                    } else {
                        controller = new RequiredController();
                    }

                    controller.serverInstance = serverInstance;

                    controller.requireController = requireController;

                    return controller;
                } catch (err) {
                    return serverInstance.throwError(response, 500, err );
                }
            };

            controller.requireController = requireController;

            if (hasSetup && isSetupRequired(params.param.control) || hasSetup && !self.hasCompletedControlllerSetup ) { // adding setup

                controller.setup = function(request, response, next) {
                    if (!this._setupDone) {
                        this._setupDone = true;
                        return function (request, response, next) { // getting rid of the controller context
                            var Setup = require(_(setupFile, true));


                            // Inheriting SuperController functions & objects
                            // Exporting config & common methods
                            Setup.engine                = controller.engine;
                            // TODO - loop on a defiend SuperController property like SuperController._allowedForExport
                            // for ( let f in controller) {
                            //     if ( typeof(controller[f]) != 'function' ) {
                            //         continue;
                            //     }
                            //     Setup[f] = controller[f];
                            // }
                            Setup.getConfig             = controller.getConfig;
                            Setup.checkBundleStatus     = controller.checkBundleStatus;
                            Setup.getLocales            = controller.getLocales;
                            Setup.getFormsRules         = controller.getFormsRules;
                            Setup.throwError            = serverInstance.throwError;
                            Setup.redirect              = controller.redirect;
                            Setup.render                = controller.render;
                            Setup.renderJSON            = controller.renderJSON;
                            Setup.renderWithoutLayout   = controller.renderWithoutLayout;
                            Setup.isXMLRequest          = controller.isXMLRequest;
                            Setup.isWithCredentials     = controller.isWithCredentials;
                            Setup.isPopinContext        = controller.isPopinContext;
                            Setup.isCacheless           = controller.isCacheless;
                            Setup.requireController     = controller.requireController;


                            Setup.apply(Setup, arguments);

                            return Setup;
                        }(request, response, next)
                    }
                }

                if ( !self.hasCompletedControlllerSetup )
                    self.hasCompletedControlllerSetup = true;
            } else {
                controller.setup = function() { return };
            }



            if (middleware.length > 0) {
                processMiddlewares(serverInstance, middleware, controller, action, request, response, next,
                    function onDone(action, request, response, next){
                        // handle superController events
                        for (let e=0; e<reservedActions.length; ++e) {
                            if ( typeof(controller[reservedActions[e]]) == 'function' ) {
                                controller[reservedActions[e]](request, response, next)
                            }
                        }

                        try {
                            controller[action](request, response, next)
                        } catch (err) {
                            var superController = new SuperController(options);
                            // Required before setting options
                            superController.serverInstance = serverInstance;
                            superController.setOptions(request, response, next, options);
                            if (typeof (controller) != 'undefined' && typeof (controller[action]) == 'undefined') {
                                return serverInstance.throwError(response, 500, (new Error('control not found: `' + action + '`. Please, check your routing.json ('+ options.rule +') or the related control in your `' + controllerFile + '`.')).stack);
                            }

                            return serverInstance.throwError(response, 500, err.stack);
                        }

                    });
            } else {
                // handle superController events
                // e.g.: inside your controller, you can defined: `this.onReady = function(){...}` which will always be called before the main action
                for (let e=0; e<reservedActions.length; ++e) {
                    if ( typeof(controller[reservedActions[e]]) == 'function' ) {
                        controller[reservedActions[e]](request, response, next)
                    }
                }
                try {
                    controller[action](request, response, next);
                } catch (err) {
                    if ( typeof(controller) != 'undefined' && typeof (controller[action]) == 'undefined') {
                        serverInstance.throwError(response, 500, (new Error('control not found: `' + action + '`. Please, check your routing.json or the related control in your `' + controllerFile + '`.')).stack);
                    } else {
                        serverInstance.throwError(response, 500, err.stack);
                    }
                    return;
                }
            }

            // controller = null;
            // Controller = null;
            // MainController = null;

        } catch (err) {
            if ( typeof(controller) != 'undefined' && typeof (controller[action]) == 'undefined') {
                serverInstance.throwError(response, 500, (new Error('control not found: `' + action + '`. Please, check your routing.json or the related control in your `' + controllerFile + '`.')).stack);
            } else {
                serverInstance.throwError(response, 500, err.stack);
            }

            // controller = null;
            // Controller = null;
            // MainController = null;

            return;
        }

        action = null
    };//EO route()

    var processMiddlewares = function(serverInstance, middlewares, controller, action, req, res, next, cb){


        if (!middlewares || middlewares.length == 0) {
            return cb(action, req, res, next);
        }

        var bundlePath      = _(local.conf.bundlePath, true)
            , sharedPath    = _(local.conf.sharedPath, true)
            , middleware    = null
            , constructor   = null
            // removed: unused new RegExp('^'+bundlePath) (#P15)
        ;

        for (let m=0; m<middlewares.length; ++m) {
            constructor = middlewares[m].split(/\./g);
            constructor = constructor
                .splice(constructor.length-1,1)
                .toString();
            middleware = middlewares[m].split(/\./g);
            middleware.splice(middleware.length-1);
            middleware = middleware.join('/');

            let filenameObj         = new _(bundlePath +'/'+ middleware + '/index.js', true);
            let filename            = filenameObj.toString();
            let sharedFilenameObj   = new _(sharedPath +'/'+ middleware + '/index.js', true);
            let sharedFilename      = sharedFilenameObj.toString();
            if ( !filenameObj.existsSync() ) {
                if ( !sharedFilenameObj.existsSync() ) {
                    // no middleware found with this alias
                    return serverInstance.throwError(res, 501, new Error('middleware not found '+ middleware).stack);
                }

                filename = sharedFilename;
            }

            if (local.isCacheless) delete require.cache[require.resolve(_(filename, true))];

            var MiddlewareClass = function(req, res, next) {
                // getting rid of the middleware context
                return function () {

                    var Middleware = require(_(filename, true));
                    // LOCAL vs GLOBAL
                    if (
                        sharedFilenameObj.existsSync()
                        && filename != sharedFilename
                    ) {
                        if (local.isCacheless) delete require.cache[require.resolve(_(sharedFilename, true))];
                        // sharedFilename as SuperClass
                        Middleware = inherits(require(_(filename, true)), require(_(sharedFilename, true)));
                    }

                    // TODO - loop on a defined SuperController property like SuperController._allowedForExport


                    // Exporting config & common methods
                    Middleware.prototype.checkBundleStatus      = controller.checkBundleStatus;
                    Middleware.prototype.getConfig              = controller.getConfig;
                    Middleware.prototype.getFormsRules          = controller.getFormsRules;
                    Middleware.prototype.getLocales             = controller.getLocales;
                    Middleware.prototype.isCacheless            = controller.isCacheless;
                    Middleware.prototype.isHaltedRequest        = controller.isHaltedRequest;
                    Middleware.prototype.isWithCredentials      = controller.isWithCredentials;
                    Middleware.prototype.isXMLRequest           = controller.isXMLRequest;
                    Middleware.prototype.pauseRequest           = controller.pauseRequest;
                    Middleware.prototype.query                  = controller.query;
                    Middleware.prototype.redirect               = controller.redirect;
                    Middleware.prototype.render                 = controller.render;
                    Middleware.prototype.renderJSON             = controller.renderJSON;
                    Middleware.prototype.renderWithoutLayout    = controller.renderWithoutLayout;
                    Middleware.prototype.resumeRequest          = controller.resumeRequest;
                    Middleware.prototype.requireController      = controller.requireController;
                    Middleware.prototype.throwError             = controller.throwError;

                    return Middleware;
                }(req, res, next)
            }(req, res, next);

            middleware = new MiddlewareClass();


            if ( !middleware[constructor] ) {
                return serverInstance.throwError(res, 501, new Error('contructor [ '+constructor+' ] not found @'+ middlewares[m]).stack);
            }

            if ( typeof(middleware[constructor]) != 'undefined') {

                middleware[constructor](req, res, next,
                    function onMiddlewareProcessed(req, res, next){
                        middlewares.splice(m, 1);
                        if (middlewares.length > 0) {
                            return processMiddlewares(serverInstance, middlewares, controller, action,  req, res, next, cb)
                        }
                        // else {
                            cb(action, req, res, next)
                        // }
                    }
                );

                break
            }
        }
    };

    init()
}
module.exports = Router;