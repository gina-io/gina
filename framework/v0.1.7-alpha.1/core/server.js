'use strict';
/**
 * @module gina/core/server
 */
/**
 * Orchestrates the HTTP/HTTPS/HTTP2 server lifecycle for a Gina bundle.
 * Loads routing, initialises the Swig template engine, wires the request
 * pipeline (statics, preflight, middleware, routing), and emits `'configured'`
 * once the server engine is ready.
 *
 * Supports three engine backends selected by `options.conf` server settings:
 * - `engine: 'isaac'` — built-in Gina HTTP/HTTP2 engine (`server.isaac.js`)
 * - `engine: 'express'` — Express.js adapter (`server.express.js`)
 * - default (no engine) — bare Node.js `http`/`https`/`http2`
 *
 * @class Server
 * @constructor
 * @param {object} options - Server initialisation options
 * @param {string} options.projectName - Project name
 * @param {string} options.bundle - Bundle name being started
 * @param {string} options.env - Active environment name
 * @param {string} options.scope - Active scope name
 * @param {boolean} options.isStandalone - When true, multiple bundles share one server port
 * @param {string[]} options.bundles - All bundle names in the project
 * @param {string} options.executionPath - Project root path
 * @param {object} options.conf - Merged env configuration object
 */
//Imports.
const fs            = require('fs');
var _isDebugLog = function() {
    return process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
};
var _debugLog = function(msg) {
    if (!_isDebugLog()) return;
    var d = new Date()
        , _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
        , p2 = function(n) { return (n < 10 ? '0' : '') + n; };
    fs.writeSync(2, '\u001b[90m[' + d.getFullYear() +' '+ _m[d.getMonth()] +' '+ p2(d.getDate())
        +' '+ p2(d.getHours()) +':'+ p2(d.getMinutes()) +':'+ p2(d.getSeconds())
        + '] [debug  ][gina:server] ' + msg + '\u001b[39m\n');
};
const os            = require('os');
const path          = require('path');
const EventEmitter  = require('events').EventEmitter;
const swig          = require('./deps/swig-1.4.2');
const Busboy        = require('./deps/busboy-1.6.0');
const Stream        = require('stream');
const util          = require('util');
var https           = require('https');
const sslChecker    = require('ssl-checker');


var Config          = require('./config');
var Router          = require('./router');
var lib             = require('./../lib');
var routingLib      = lib.routing;
var inherits        = lib.inherits;
var merge           = lib.merge;
var Proc            = lib.Proc;
var console         = lib.logger;
var SwigFilters     = lib.SwigFilters;
var Domain          = lib.Domain;
var domainLib       = new Domain();

function Server(options) {

    // switching logger flow
    //console.switchFlow('server');

    var e       = new EventEmitter();
    var self    = this;
    var local   = {
        router : null,
        hasViews: {}
    };
    var Engine = null;

    this.conf = {
        core: {}
    };

    this.routing = {};
    //this.activeChild = 0;

    /**
     * Configures the Swig template engine for the given bundle config: sets
     * loader root, cache mode, and registers all custom Swig filters.
     *
     * @inner
     * @private
     * @param {object} conf - Bundle/env configuration object
     */
    var initSwigEngine = function(conf) {
        // swig options
        var dir = conf.content.templates._common.html;
        var swigOptions = {
            autoescape: ( typeof(conf.autoescape) != 'undefined') ? conf.autoescape: false,
            loader: swig.loaders.fs(dir),
            cache: (conf.isCacheless) ? false : 'memory'
        };

        swig.setDefaults(swigOptions);

        var filters = SwigFilters({
            options     : conf,
            isProxyHost : getContext('isProxyHost')
        });

        try {
            // Allows you to get a bundle web root
            // e.g.: swig.setFilter('getWebroot', filters.getWebroot);
            // e.g.: swig.setFilter('nl2br', filters.nl2br);
            for (let filter in filters) {
                if ( typeof(filters[filter]) == 'function' && !/^getConfig$/.test(filter) ) {
                    swig.setFilter(filter, filters[filter]);
                }
            }

        } catch (err) {
            throw err;
        }
    }

    /**
     * Applies the server configuration options, builds the Config/Router
     * instances, selects the server engine, and emits `'configured'` with
     * `(err, instance, middleware, conf)` once the engine is ready.
     *
     * @inner
     * @private
     * @param {object} options - Same options passed to the outer `Server` constructor
     */
    var init = function(options) {

        self.projectName    = options.projectName;
        //Starting app.
        self.appName        = options.bundle;
        self.env            = options.env;
        self.scope          = options.scope;
        self.version        = options.version;
        local.router        = new Router(self.env, self.scope);

        //True => multiple bundles sharing the same server (port).
        self.isStandalone   = options.isStandalone;
        self.bundles        = options.bundles;
        self.executionPath  = options.executionPath;


        if (!self.isStandalone) {
            //Only load the related conf / env.
            self.conf[self.appName] = {};
            self.conf[self.appName][self.env] = options.conf[self.appName][self.env];
            self.conf[self.appName][self.env].bundlesPath = options.conf[self.appName][self.env].bundlesPath;
            self.conf[self.appName][self.env].modelsPath =  options.conf[self.appName][self.env].modelsPath;
            self.conf[self.appName][self.env].executionPath = options.conf[self.appName][self.env].executionPath = self.executionPath;
        } else {

            //console.debug("Running mode not handled yet..", self.appName, " VS ", self.bundles);
            //Load all conf for the related apps & env.
            var apps = self.bundles;
            for (let i=0; i<apps.length; ++i) {
                self.conf[apps[i]] = {};
                self.conf[apps[i]][self.env] = options.conf[apps[i]][self.env];
                self.conf[apps[i]][self.env].bundlesPath = options.conf[apps[i]][self.env].bundlesPath;
                self.conf[apps[i]][self.env].modelsPath = options.conf[apps[i]][self.env].modelsPath;
            }
        }


        try {

            // updating server protocol
            var serverOpt = {};
            var ioServerOpt = null;
            if ( typeof(options.conf[self.appName][self.env].content.settings.ioServer) != 'undefined' ) {
                ioServerOpt = JSON.clone(options.conf[self.appName][self.env].content.settings.ioServer);
            }


            if (
                typeof(options.conf[self.appName][self.env].content.settings.server) != 'undefined'
                && options.conf[self.appName][self.env].content.settings.server != ''
                && options.conf[self.appName][self.env].content.settings.server != null
            ) {
                serverOpt = options.conf[self.appName][self.env].content.settings.server;
            }

            serverOpt = merge({
                        bundle  : self.appName,
                        env     : self.env,
                        scope   : self.scope
                    },
                    serverOpt,
                    {
                        engine              : options.conf[self.appName][self.env].server.engine,
                        protocol            : options.conf[self.appName][self.env].server.protocol,
                        scheme              : options.conf[self.appName][self.env].server.scheme,
                        coreConfiguration   : options.conf[self.appName][self.env].server.coreConfiguration,
                        isCacheless         : options.conf[self.appName][self.env].isCacheless,
                        routing             : options.conf[self.appName][self.env].routing,
                        allRoutes           : options.conf.routing,
                        cachePath           : options.conf[self.appName][self.env].cachePath
                    }
            );

            self.engine = serverOpt.engine;
            console.debug('[ BUNDLE ][ server ][ init ] Initializing [ '+ self.appName +' ] server with `'+ serverOpt.engine +'`engine');

            // controlling one last time protocol & ports
            var ctx             = getContext('gina')
                , projectConf   = ctx.project
                // TODO - check if the user prefered protocol is register in projectConf
                , protocols       = projectConf.protocols
                , portsReverse    = ctx.portsReverse
            ;

            // locking port & protocol so it can't be changed by the user's settings
            self.conf[self.appName][self.env].server.protocol   = serverOpt.protocol;
            self.conf[self.appName][self.env].server.scheme     = serverOpt.scheme;
            self.conf[self.appName][self.env].server.engine     = serverOpt.engine;
            self.conf[self.appName][self.env].server.cachePath  = serverOpt.cachePath;

            serverOpt.port      = self.conf[self.appName][self.env].server.port = portsReverse[ self.appName +'@'+ self.projectName ][self.env][serverOpt.protocol][serverOpt.scheme];
            self.conf[self.appName][self.env].server.debugPort = getContext().debugPort;

            // engine.io options
            if ( ioServerOpt ) {
                serverOpt.ioServer = ioServerOpt
            }

            _debugLog('checkpoint I1: requiring engine ' + ((typeof (serverOpt.engine) != 'undefined' && serverOpt.engine != '') ? serverOpt.engine : 'express'));
            Engine = require('./server.' + ((typeof (serverOpt.engine) != 'undefined' && serverOpt.engine != '') ? serverOpt.engine : 'express'));
            _debugLog('checkpoint I2: engine required, instantiating');
            var engine = new Engine(serverOpt);
            _debugLog('checkpoint I3: engine instantiated');

            // swigEngine to render thrown HTML errors
            if ( hasViews(self.appName) ) {
                _debugLog('checkpoint I4: initSwigEngine');
                initSwigEngine(self.conf[self.appName][self.env]);
            }


            // setting timezone
            if (
                typeof(options.conf[self.appName][self.env].content.settings.region) != 'undefined'
                && typeof(options.conf[self.appName][self.env].content.settings.region.timeZone) != 'undefined'
            ) {
                process.env.TZ = options.conf[self.appName][self.env].content.settings.region.timeZone;
            }

            _debugLog('checkpoint I5: emitting configured');
            self.emit('configured', false, engine.instance, engine.middleware, self.conf[self.appName][self.env]);

        } catch (err) {
            console.emerg('[ BUNDLE ] [ '+ self.appName +' ] ServerEngine ' + err.stack)
            process.exit(1)
        }
    }
    /**
     * Returns `true` when running in dev mode (`NODE_ENV_IS_DEV=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isCacheless = function() {
        return (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false
    }
    /**
     * Returns `true` when the active scope is `local` (`NODE_SCOPE_IS_LOCAL=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isLocalScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false;
    }
    /**
     * Returns `true` when the active scope is `production` (`NODE_SCOPE_IS_PRODUCTION=true`).
     *
     * @memberof module:gina/core/server
     * @returns {boolean}
     */
    this.isProductionScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false;
    }

    /**
     * Registers a one-time listener for the `'configured'` event, then kicks
     * off `init()`. The callback receives `(err, instance, middleware, conf)`.
     *
     * @memberof module:gina/core/server
     * @param {function} callback - `function(err, instance, middleware, conf)`
     */
    this.onConfigured = function(callback) {
        self.once('configured', function(err, instance, middleware, conf) {
            callback(err, instance, middleware, conf)
        });

        init(options);
    }

    /**
     * Checks TLS certificate validity for an HTTPS endpoint using `ssl-checker`.
     * Logs an emergency-level warning when the certificate is invalid or the
     * wildcard exception applies.
     *
     * @memberof module:gina/core/server
     * @param {string} endpoint - Hostname to verify (e.g. `'myapp.dev'`)
     * @param {number} [port=443] - HTTPS port
     * @returns {Promise<void>} Resolves when valid; throws if DNS/cert check fails
     */
    this.verifyCertificate = async function(endpoint, port) {
        let sslDetails = null;
        console.debug('Checking certificate validity...');
        try {
            console.debug('[ssl] endpoint: ', endpoint);
            sslDetails = await sslChecker(endpoint, {
                method: 'GET',
                // rejectUnauthorized: true,
                port: port || 443,
                path: "/_gina/health/check",
                timeout: 5000,
                // replaced: fs.readFileSync(credentials.ca) — credentials paths use ~/ which fs.readFileSync does not expand; _() expands $HOME via execSync('echo $HOME')
                ca: fs.readFileSync(_(self.conf[self.appName][self.env].content.settings.server.credentials.ca, true)),
                agent: new https.Agent({
                    maxCachedSessions: 0
                })
            });
        } catch (err) {
            if (!sslDetails) {
                throw new Error('DNS issue ? Did you check your `/etc/hosts` or your DNS configuration ?\n'+ err.stack);
            }
            throw new Error(sslDetails +'\n'+ err.stack);
        }


        const failed  = !sslDetails.valid;
        const humanView = JSON.stringify(sslDetails, null, '  ');

        // Wildcard exception - See https://github.com/dyaa/ssl-checker/issues/381
        // Date of the test: 2022-12-18T00:00:00.000Z
        // container-87546.dev.sample.app -> not valid when it should return true.
        // {
        //     "daysRemaining": 290,
        //     "valid": false,
        //     "validFrom": "2022-10-03T00:00:00.000Z",
        //     "validTo": "2023-10-03T23:59:59.000Z",
        //     "validFor": [
        //         "*.sample.app",
        //         "sample.app"
        //     ]
        // }

        const isHandleByWildcardCert = function(endpoint, hv) {
            var isAllowed = false;
            const start = new Date(hv.validFrom).format('longIsoDateTime');
            const end = new Date(hv.validTo).format('longIsoDateTime');
            const today = new Date().format('longIsoDateTime');
            const allowed = hv.validFor;

            for (let i=0, len=allowed.length; i<len; ++i ) {
                // skip if not a wildcard
                if ( ! /^[*]\./.test(allowed[i]) ) continue;

                let re = new RegExp( allowed[i].replace(/^[*]/, '')+'$' );
                if ( ! re.test(endpoint) ) continue;

                if ( today >= start && today < end) {
                    isAllowed = true;
                    break
                }
            }
            return isAllowed;
        }
        if ( failed && Array.isArray(sslDetails.validFor) && isHandleByWildcardCert(endpoint, sslDetails) ) {
            return;
        }


        if (failed) {
            if (sslDetails.daysRemaining > -1) {
                var isProxyHost = getContext('isProxyHost');
                if ( /^true$/i.test(isProxyHost) ) {
                    console.warn("Host is behind a reverse proxy, skipping server.verifyCertificate(...) ");
                    return;
                }
                var rootDomain = domainLib.getRootDomain(endpoint).value;
                hasMatchedEntry = false;
                for (let i in sslDetails.validFor) {
                    if ( new RegExp(sslDetails.validFor[i].replace(/^\*\./, '') + '$').test(rootDomain) ) {
                        hasMatchedEntry = true;
                        break;
                    }
                }
                if (!hasMatchedEntry) {
                    console.warn(`[Certificate] "${endpoint}" : Root domain not matching your certificate. If you plan to run your service behind a revese proxy, please do not forget to add "proxy.json" at the root of your project while going to production.${'\n'} ${humanView}`);
                    return;
                }
                // sslDetails.validFor
                console.emerg(`[Certificate] ${endpoint} : It is like there is a problem with your CA certificate${'\n'} ${humanView}`);
                return;
            }
            console.emerg(`[Certificate] ${endpoint} has no valid certificate: ${'\n'} ${humanView}`);
            return;
        }
    }

    /**
     * Attaches the server engine instance, injects helper references
     * (`throwError`, `getAssets`, `completeHeaders`) onto it, and returns
     * `onRequest()` to begin serving HTTP traffic.
     *
     * @memberof module:gina/core/server
     * @param {object} instance - Server engine instance (Express app or Isaac server)
     * @returns {*} Return value of `onRequest()`
     */
    this.start = function(instance) {
        if (instance) {
            self.instance       = instance;
            //Router configuration.
            var router = local.router;

            instance.throwError         = throwError;
            instance.getAssets          = getAssets;
            instance.completeHeaders    = completeHeaders;

            // If you change here, you will also have to refrect changes in the form-validator
            if ( typeof(instance._cached) == 'undefined' ) {
                instance._cached = new Map();
                // Tag with LRU cap so all Cache instances pointing at this Map share the same limit.
                // Reads server.cache.maxEntries from env.json; defaults to 1000. Set to 0 to disable.
                var _cacheConf = self.conf[self.appName][self.env].server.cache;
                instance._cached._maxEntries = ( _cacheConf.maxEntries > 0 ) ? ~~(_cacheConf.maxEntries) : 1000;
            }
            if ( typeof(instance._cachedPath) == 'undefined' ) {
                instance._cachePath = self.conf[self.appName][self.env].server.cache.path;
            }
            if ( typeof(instance._cacheIsEnabled) == 'undefined' ) {
                instance._cacheIsEnabled = self.conf[self.appName][self.env].server.cache.enable;
            }

            router.setServerInstance(instance);
        }

        return onRequest()
    }



    /**
     * Called once route files are loaded. Builds the merged routing and
     * reverse-routing maps across all bundles, registers them on the Config
     * singleton and the Router, and calls `callback(false)`.
     *
     * @inner
     * @private
     * @param {function} callback - `function(err)` called on completion
     */
    var onRoutesLoaded = function(callback) {

        var config                  = new Config()
            , conf                  = config.getInstance(self.appName)
            , serverCoreConf        = self.conf.core
            , routing               = {}
            , reverseRouting        = {}
            , isCacheless           = config.isCacheless()
            , env                   = self.env
            , scope                 = self.scope
            , apps                  = conf.allBundles // conf.bundles
            , filename              = ''
            , appName               = ''
            , tmp                   = {}
            , standaloneTmp         = {}
            , main                  = ''
            , tmpContent            = ''
            , i                     = 0
            , file                  = null // template file
            , wroot                 = null
            , hasWebRoot            = false
            , webrootAutoredirect   = null
            , localWroot            = null
            , originalRules         = []
            , oRuleCount            = 0
        ;

        //Standalone or shared instance mode. It doesn't matter.
        for (; i<apps.length; ++i) {
            config.setServerCoreConf(apps[i], env, scope, serverCoreConf);

            var appPath = _(conf.envConf[apps[i]][env].bundlesPath+ '/' + apps[i]);
            appName     =  apps[i];

            //Specific case.
            if (!self.isStandalone && i == 0) appName = apps[i];

            try {
                main        = _(appPath + '/config/' + conf.envConf[apps[i]][env].configFiles.routing);
                filename    = main;//by default
                filename    = conf.envConf[apps[i]][env].configFiles.routing.replace(/.json/, '.' +env + '.json');
                filename    = _(appPath + '/config/' + filename);
                //Can't do a thing without.
                if ( !fs.existsSync(filename) ) {
                    filename = main
                }

                if (isCacheless) {
                    delete require.cache[require.resolve(_(filename, true))]
                }

                if (filename != main) {
                    routing = tmpContent = merge(require(main), require(filename), true);

                } else {
                    try {
                        tmpContent = require(filename);
                    } catch (err) {
                        // do not block here because the bundle is not build for the same env
                        console.warn(err.stack);
                        continue
                    }
                }

                try {

                    wroot               = conf.envConf[apps[i]][env].server.webroot;
                    webrootAutoredirect = conf.envConf[apps[i]][env].server.webrootAutoredirect;
                    // renaming rule for standalone setup
                    if ( self.isStandalone && apps[i] != self.appName && wroot == '/') {
                        wroot = '/'+ apps[i];
                        conf.envConf[apps[i]][env].server.webroot = wroot
                    }

                    if (wroot.length >1) {
                        hasWebRoot = true
                    } else {
                        hasWebRoot = false
                    }

                    tmp = tmpContent;
                    //Adding important properties; also done in core/config.
                    for (var rule in tmp){
                        tmp[rule.toLowerCase() +'@'+ appName] = tmp[rule];
                        delete tmp[rule];
                        file = ruleShort = rule.toLowerCase();
                        rule = rule.toLowerCase() +'@'+ appName;


                        tmp[rule].bundle        = (tmp[rule].bundle) ? tmp[rule].bundle : apps[i]; // for reverse search
                        tmp[rule].param.file    = ( typeof(tmp) != 'string' && typeof(tmp[rule].param.file) != 'undefined' ) ? tmp[rule].param.file : file; // get template file
                        // by default, method is inherited from the request
                        if (
                            hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && typeof(tmp[rule].param.ignoreWebRoot) == 'undefined'
                            || hasWebRoot && typeof(tmp[rule].param.path) != 'undefined' && !tmp[rule].param.ignoreWebRoot
                        ) {
                            tmp[rule].param.path = wroot + tmp[rule].param.path
                        }

                        if (typeof(tmp[rule].url) != 'object') {
                            if (tmp[rule].url.length > 1 && tmp[rule].url.substring(0,1) != '/') {
                                tmp[rule].url = '/'+tmp[rule].url
                            }
                            /** else if (tmp[rule].url.length > 1 && conf.envConf[apps[i]][env].server.webroot.substring(conf.envConf[apps[i]][env].server.webroot.length-1,1) == '/') {
                                tmp[rule].url = tmp[rule].url.substring(1)
                            }*/
                            else {
                                if (wroot.substring(wroot.length-1,1) == '/') {
                                    wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                                }
                            }


                            if (tmp[rule].bundle != apps[i]) { // allowing to override bundle name in routing.json
                                // originalRule is used to facilitate cross bundles (hypertext)linking
                                originalRules[oRuleCount] = ( self.isStandalone && tmp[rule] && apps[i] != self.appName) ? apps[i] + '-' + rule : rule;
                                ++oRuleCount;

                                localWroot = conf.envConf[tmp[rule].bundle][env].server.webroot;
                                // standalone setup
                                if ( self.isStandalone && tmp[rule].bundle != self.appName && localWroot == '/') {
                                    localWroot = '/'+ routing[rule].bundle;
                                    conf.envConf[tmp[rule].bundle][env].server.webroot = localWroot
                                }
                                if (localWroot.substring(localWroot.length-1,1) == '/') {
                                    localWroot = localWroot.substring(localWroot.length-1,1).replace('/', '')
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = localWroot + tmp[rule].url
                            } else {
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url = wroot + tmp[rule].url
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }

                        } else {

                            for (var u=0; u<tmp[rule].url.length; ++u) {
                                if (tmp[rule].url[u].length > 1 && tmp[rule].url[u].substring(0,1) != '/') {
                                    tmp[rule].url[u] = '/'+tmp[rule].url[u]
                                } else {
                                    if (wroot.substring(wroot.length-1,1) == '/') {
                                        wroot = wroot.substring(wroot.length-1,1).replace('/', '')
                                    }
                                }
                                if ( typeof(tmp[rule].param.ignoreWebRoot) == 'undefined' || !tmp[rule].param.ignoreWebRoot )
                                    tmp[rule].url[u] = wroot + tmp[rule].url[u]
                                else if (!tmp[rule].url.length)
                                    tmp[rule].url += '/'
                            }
                        }

                        if( hasViews(apps[i]) ) {
                            // This is only an issue when it comes to the frontend dev
                            // views.routeNameAsFilenameEnabled is set to true by default
                            // IF [ false ] the action is used as filename
                            if ( !conf.envConf[apps[i]][env].content.templates['_common'].routeNameAsFilenameEnabled && tmp[rule].param.bundle != 'framework') {
                                var tmpRouting = [];
                                for (var r = 0, len = tmp[rule].param.file.length; r < len; ++r) {
                                    if (/[A-Z]/.test(tmp[rule].param.file.charAt(r))) {
                                        tmpRouting[0] = tmp[rule].param.file.substring(0, r);
                                        tmpRouting[1] = '-' + (tmp[rule].param.file.charAt(r)).toLocaleLowerCase();
                                        tmpRouting[2] = tmp[rule].param.file.substring(r + 1);
                                        tmp[rule].param.file = tmpRouting[0] + tmpRouting[1] + tmpRouting[2];
                                        ++r
                                    }
                                }
                                tmpRouting = null;
                            }
                        }

                        if ( self.isStandalone && tmp[rule]) {
                            standaloneTmp[rule] = JSON.clone(tmp[rule]);
                        }
                    }// EO for


                } catch (err) {
                    self.routing = routing = null;
                    console.error(err.stack||err.message);
                    callback(err)
                }

            } catch (err) {
                console.warn(err, err.stack||err.message);
                callback(err)
            }


            routing = merge(routing, ((self.isStandalone && apps[i] != self.appName ) ? standaloneTmp : tmp), true);
            // originalRule is used to facilitate cross bundles (hypertext)linking
            for (let r = 0, len = originalRules.length; r < len; r++) { // for each rule ( originalRules[r] )
                routing[originalRules[r]].originalRule = (routing[originalRules[r]].bundle === self.appName )
                    ?  config.getOriginalRule(originalRules[r], routing)
                    : config.getOriginalRule(routing[originalRules[r]].bundle +'-'+ originalRules[r], routing)
            }

            // reverse routing
            for (let rule in routing) {
                if ( typeof(routing[rule].url) != 'object' ) {
                    reverseRouting[routing[rule].url] = rule
                } else {
                    for (let u = 0, len = routing[rule].url.length; u < len; ++u) {
                        reverseRouting[routing[rule].url[u]] = rule
                    }
                }
            }

            config.setRouting(apps[i], env, scope, routing);
            config.setReverseRouting(apps[i], env, scope, reverseRouting);

            if (apps[i] == self.appName) {
                self.routing        = routing;
                self.reverseRouting = reverseRouting
            }

        }//EO for.


        callback(false)
    }

    /**
     * Returns `true` if the bundle has a templates directory defined in its
     * env config (result cached per bundle for the lifetime of the server).
     *
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @returns {boolean}
     */
    var hasViews = function(bundle) {
        var _hasViews   = false
            , conf      = new Config().getInstance(bundle)
        ;
        if (typeof(local.hasViews[bundle]) != 'undefined') {
            _hasViews = local.hasViews[bundle];
        } else {
            _hasViews = ( typeof(conf.envConf[bundle][self.env].content['templates']) != 'undefined' ) ? true : false;
            local.hasViews[bundle] = _hasViews;
        }

        return _hasViews
    }


    /**
     * Resolves a request URL to an absolute asset filename by consulting
     * `publicResources`, `staticResources`, reverse-routing aliases, and
     * the bundle's `content.statics` map. Returns `'404.html'` when not found.
     *
     * @inner
     * @private
     * @param {object} bundleConf - Bundle/env configuration slice
     * @param {string} url - Decoded request URL
     * @returns {string} Absolute filename path, or `'404.html'`
     */
    var getAssetFilenameFromUrl = function(bundleConf, url) {

        var staticsArr  = bundleConf.publicResources;
        url = decodeURIComponent( url );
        var staticProps = {
            firstLevel  : '/'+ url.split(/\//g)[1] + '/',
            isFile      :  /^\/[A-Za-z0-9_-]+\.(.*)$/.test(url)
        };
        var notFound = '404.html'

        var filename        = null
            , path          = null
            , altConf       = ( typeof(staticProps.firstLevel) != 'undefined' && typeof(self.conf.reverseRouting) != 'undefined' ) ? self.conf.reverseRouting[staticProps.firstLevel] : false
            , backedupPath  = null
        ;
        if (
            staticProps.isFile && staticsArr.indexOf(url) > -1
            || staticsArr.indexOf(staticProps.firstLevel) > -1
            || typeof(altConf) != 'undefined' && altConf
        ) {

            // by default
            path = url.replace(url.substring(url.lastIndexOf('/')+1), '');
            if ( typeof(altConf) != 'undefined' && altConf ) {
                bundleConf = self.conf[altConf.split(/\@/)[1]][bundleConf.env];
                backedupPath = path;
                path = path.replace(staticProps.firstLevel, '/');
            }


            // catch `statics.json` defined paths || bundleConf.staticResources.indexOf(url.replace(url.substring(url.lastIndexOf('/')+1), '')) > -1
            if (  bundleConf.staticResources.indexOf(path) > -1 || bundleConf.staticResources.indexOf(staticProps.firstLevel) > -1 ) {
                if ( typeof(altConf) != 'undefined' && altConf && backedupPath ) {
                    filename = (bundleConf.staticResources.indexOf(path) > -1) ? bundleConf.content.statics[path] + url.replace(backedupPath, '/') : bundleConf.content.statics[staticProps.firstLevel] + url.replace(staticProps.firstLevel, '/');
                } else {
                    filename = (bundleConf.staticResources.indexOf(path) > -1) ? bundleConf.content.statics[path] + url.replace(path, '/') : bundleConf.content.statics[staticProps.firstLevel] + url.replace(staticProps.firstLevel, '/');
                }
            } else {
                filename = ( bundleConf.staticResources.indexOf(url) > -1 ) ? bundleConf.content.statics[url] : bundleConf.publicPath + url;
            }


            if ( !fs.existsSync(filename) )
                return notFound;

            return filename

        } else {
            return notFound
        }
    }

    /**
     * Synchronously fetches the body of a URL via HTTP GET using `httpclient`.
     *
     * @inner
     * @private
     * @param {string} url - Fully-qualified URL to fetch
     * @param {string} [encoding] - Character encoding for decoding the body
     * @returns {string} Decoded response body
     */
    var readFromUrl = function(url, encoding) {
        return new (require('httpclient').HttpClient)({
            method: 'GET',
              url: url
            }).finish().body.read().decodeToString();
    }

    /**
     * Parses a rendered layout string for `<link>`, `<script>`, `<source>`,
     * and `<img>` tags, resolves each asset URL to an absolute file path, and
     * returns a structured assets map used by the rendering pipeline.
     * When `swig` and `data` are provided the function was called from a
     * controller action (in-request asset resolution).
     *
     * @inner
     * @private
     * @param {object} bundleConf - Bundle/env configuration slice
     * @param {string} layoutStr - Rendered HTML layout string to scan for asset tags
     * @param {object} [swig] - Swig instance when called from the controller
     * @param {object} [data] - Template data when called from the controller
     * @returns {object} Assets map keyed by URL
     */
    var getAssets = function (bundleConf, layoutStr, swig, data) {

        // layout search for <link|source|script|img>
        var layoutAssets        = layoutStr.match(/<link .*?<\/link>|<link .*?(rel\=\"(stylesheet|icon|manifest|(.*)\-icon))(.*)|<source .*?(type\=\"(image))(.*)|<script.*?<\/script>|<img .*?(.*)/g) || [];

        var assets      = {}
            , cssFiles  = []
            , aCount    = 0
            , i         = 0
            , len       = 0
            , domain    = null
            , key       = null // [ code ] url
            , ext       = null
            , url       = null
            , filename  = null
        ;

        // user's defineds assets
        var layoutClasses     = [];

        // layout assets
        i   = 0;
        len = layoutAssets.length;
        var type                    = null
            , isAvailable           = null
            , tag                   = null
            , properties            = null
            , p                     = 0
            , pArr                  = []
            , sourceTagSrcSetStr    = ''
        ;
        for (; i < len; ++i) {

            if (
                !/(\<img|\<link|\<source|\<script)/g.test(layoutAssets[i])
                // ||
                // not able to handle srcset case for now
                /**
                /\<img/.test(layoutAssets[i])
                    &&  /srcset/.test(layoutAssets[i])*/
            ) {
                continue;
            }

            // https://developer.mozilla.org/en-US/docs/Web/HTML/Attributes/rel/preload
            let asType = null;

            if ( /\<img/.test(layoutAssets[i]) ) {
                type    = 'image';
                tag     = 'img';
                asType  = type;
            }



            if ( /\<link/.test(layoutAssets[i]) ) {
                // if ( /rel\=\"stylesheet/.test(layoutAssets[i]) ) {
                //     type    = 'stylesheet';
                // } else if ( /rel\=\"(icon|(.*)\-icon)/.test(layoutAssets[i]) ) {
                //     type    = 'image';
                // } else {
                //     type = 'file';
                // }
                type = layoutAssets[i].match(/rel=\"[-a-z 0-9]+\"/)[0] || null;
                if (type) {
                    type = type.replace(/^rel\=\"|"$/g, '');
                }


                switch (type) {
                    case /stylesheet/.test(type):
                        asType  = 'style';
                        break;

                    case /javascript/.test(type):
                        asType  = 'script';
                        break;

                    default:
                        asType  = null;
                        if ( /icon/.test(type) ) {
                            asType  = 'image';
                            // ignoring all (fav)icons type: rel="*icon*" case
                            continue;
                        }
                        if ( /font/.test(type) ) {
                            asType  = 'font';
                        }
                        // if ( /manifest/.test(type) ) {
                        //     asType  = 'webmanifest';
                        // }
                        break;
                }

                tag     = 'link';
            }

            if ( /\<source/.test(layoutAssets[i]) ) {
                if ( /type\=\"image/.test(layoutAssets[i]) ) {
                    type    = 'image';
                }

                tag     = 'source';
            }

            if ( /\<script/.test(layoutAssets[i]) ) {
                type    = 'javascript';
                tag     = 'script';
            }

            domain  = null;
            let isEncodedContent = false;
            // repsonsive images
            // https://html.spec.whatwg.org/multipage/semantics.html#attr-link-imagesrcset
            let srcset  = null;
            // https://html.spec.whatwg.org/multipage/semantics.html#attr-link-imagesizes
            let sizes   = null;
            let urlArr  = null;
            try {
                urlArr  = layoutAssets[i].match(/(src|href|srcset)\=(\".*?\"|\'.*?\')/g);
                for (let u=0, uLen=urlArr.length; u<uLen; u++) {
                    if ( /data\:/.test(urlArr[u]) ) {
                        isEncodedContent = true;
                        break;
                    }
                    if ( /^srcset\=/.test(urlArr[u]) ) {
                        srcset = urlArr[u]
                                    .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
                                    .replace(/\"/g, '');
                        if ( /source/i.test(tag) ) {
                            sourceTagSrcSetStr += srcset + ','
                        }
                    }
                    if ( /^(src|href)\=/.test(urlArr[u]) ) {
                        url = urlArr[u]
                                    .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
                                    .replace(/\"/g, '');
                    }
                }
                if ( isEncodedContent ) { // ignoring "data:..."
                    continue
                }
                // url = urlArr[0];
            } catch (err) {
                console.warn('Problem with this asset ('+ i +'/'+ len +'): '+ layoutAssets[i].substring(0, 80) +'...');
                continue;
            }

            if ( /source/i.test(tag) ) {
                continue;
            }


            // if ( /data\:/.test(url) ) { // ignoring "data:..."
            //     continue
            // }
            //url = url.replace(/((src|href)\=\"|(src|href)\=\'|\"|\')/g, '');
            // url = url
            //         .replace(/((src|href|srcset)\=\"|(src|href|srcset)\=\')/g, '')
            //         .replace(/\"/g, '')
            // ;
            if ( !/^\{\{/.test(url) ) {
                url = url.replace(/(\"|\')/g, '');
            }
            if (swig && /^\{\{/.test(url) ) {
                url = swig.compile(url, swig.getOptions())(data);
            }

            if (!/(\:\/\/|^\/\/)/.test(url) ) {
                filename = getAssetFilenameFromUrl(bundleConf, url);
            } else {
                domain      = url.match(/^.*:\/\/[a-z0-9._-]+\/?/);
                //url         = ( new RegExp('/'+ bundleConf.host +'/' ).test(domain) ) ? url.replace(domain, '/') : url;

                if ( ! new RegExp('/'+ bundleConf.host +'/' ).test(domain) ) {
                    continue;
                }

                url         = url.replace(domain, '/');
                filename    = url
            }
            //key =  (( /404/.test(filename) ) ? '[404]' : '[200]') +' '+ url;
            key         = url;
            isAvailable =  ( /404/.test(filename) ) ? false : true;
            if ( isAvailable ) {
                try {
                    ext         = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/)[0];
                } catch(err) {

                    console.warn('No extension found for `'+ filename +'`\n'+ err.stack );
                    ext = null
                }
            }


            assets[key] = {
                type        : type,
                as          : asType,
                url         : url,
                ext         : ext,
                mime        : (!ext) ? 'NA' : (bundleConf.server.coreConfiguration.mime[ext.substring(1)] || 'NA'),
                filename    : ( /404/.test(filename) ) ? 'not found' : filename,
                isAvailable : isAvailable
            };

            //sourceTagSrcSetStr
            if (sourceTagSrcSetStr.length > 0) {
                assets[key]['imagesrcset'] = sourceTagSrcSetStr.substring(0, sourceTagSrcSetStr.length-1);
                // reset
                sourceTagSrcSetStr = '';
            }

            if (srcset) {
                if ( typeof(assets[key]['imagesrcset']) != 'undefined' ) {
                    assets[key]['imagesrcset'] += ', '+ srcset;
                } else {
                    assets[key]['imagesrcset'] = srcset;
                }

            }

            if (sizes) {
                if ( typeof(assets[key]['imagesizes']) != 'undefined' ) {
                    assets[key]['imagesizes'] += ', '+ sizes;
                } else {
                    assets[key]['imagesizes'] = sizes;
                }
            }

            if (domain) {
                assets[key].domain = domain;
            }

            if ( type == 'stylesheet' && !/not found/.test(assets[key].filename) ) {
                cssFiles.push(assets[key].filename)
            }

            properties = layoutAssets[i].replace( new RegExp('(\<'+ tag +'\\s+|\>|\/\>|\<\/'+ tag +'\>)', 'g'), '').replace(/[A-Za-z]+\s+/, '$&="true" ').split(/\"\s+/g);
            p = 0;

            for (; p < properties.length; ++p ) {

                pArr = properties[p].split(/\=/g);
                if ( /(src|href)/.test(pArr[0]) )
                    continue;

                assets[key][pArr[0]] = (pArr[1]) ? pArr[1].replace(/\"/g, '') : pArr[1];
            }
            //++aCount
        }

        // getting layout css classes in order to retrieve active css assets from <asset>.css
        var classesArr = layoutStr.match(/class=\"([A-Za-z0-9_-\s+]+)\"?/g);

        if ( classesArr ) {
            var cCount      = 0
                , cArr      = null
                , cArrI     = null
                , cArrLen   = null
            ;
            i = 0;
            len = classesArr.length;
            for (; i < len; ++i) {
                classesArr[i] = classesArr[i].replace(/(\"|class\=)/g, '').trim();

                if ( /\s+/g.test(classesArr[i]) ) {
                    cArrI   = 0;
                    cArr    = classesArr[i].replace(/\s+/g, ',').split(/\,/g);
                    //cArr    = classesArr[i].split(/\s+/g);
                    cArrLen = cArr.length;

                    for (; cArrI < cArrLen; ++cArrI) {

                        if ( layoutClasses.indexOf( cArr[cArrI] ) < 0) {
                            layoutClasses[cCount] = cArr[cArrI];

                            ++cCount
                        }
                    }
                    continue;
                }

                if ( layoutClasses.indexOf( classesArr[i] ) < 0) {
                    layoutClasses[cCount] = classesArr[i];
                    ++cCount
                }
            }
            assets._classes = {
                total: layoutClasses.length,
                list: layoutClasses.join(', ')
            };

            // parsing css files
            i = 0, len = cssFiles.length;
            var cssContent      = null
                , hasUrls       = null
                , definition    = null
                , defName       = null
                , d             = null
                , dLen          = null
                , cssMatched    = null
            ;
            var cssArr = null, classNames = null, assetsInClassFound = {};
            for (; i < len; ++i) {
                //if ( /^(http|https)\:/.test(cssFiles[i]) ) {
                //    cssContent = readFromUrl(cssFiles[i], bundleConf.encoding);
                //} else {
                    cssContent = fs.readFileSync(cssFiles[i], bundleConf.encoding).toString();
                //}

                hasUrls = ( /(url\(|url\s+\()/.test(cssContent) ) ? true : false;
                if (!hasUrls) continue;

                cssArr = cssContent.split(/}/g);
                for (let c = 0; c < cssArr.length; ++c) {

                    if ( /(\@media|\@font-face)/.test(cssArr[c]) ) { // one day maybe !
                        continue
                    }

                    if ( /(url\(|url\s+\()/.test(cssArr[c]) && !/data\:|\@font-face/.test(cssArr[c]) ) {

                        url = cssArr[c].match(/((background\:url|url)+\()([A-Za-z0-9->~_.,:"'%/\s+]+).*?\)+/g)[0].replace(/((background\:url|url)+\(|\))/g, '').trim();
                        if ( typeof(assetsInClassFound[url]) != 'undefined') continue; // already defined

                        //cssMatched = cssArr[c].match(/((\.[A-Za-z0-9-_.,;:"'%\s+]+)(\s+\{|{))/);
                        cssMatched = cssArr[c].match(/((\.[A-Za-z0-9->~_.,;:"'%\s+]+)(\s+\{|{))/);
                        if ( !cssMatched ) { // might be a symbol problem : not supported by the regex
                            console.warn('[ HTTP2 ][ ASSETS ][ cssMatchedException ] `'+ cssFiles[i] +'`: unable to match definition for url : '+ url +'\n'+ cssArr[c]);
                            continue;
                        }
                        definition = cssMatched[0].replace(/\{/g, '');

                        classNames = definition.replace(/\./g, '').split(/\s+/);


                        for( let clss = 0; clss < classNames.length; ++clss) {
                            // this asset is in use
                            if ( layoutClasses.indexOf(classNames[clss] < 0 && typeof(assetsInClassFound[url]) == 'undefined') ) {
                                //console.debug(' found -> (' +  url +')');
                                assetsInClassFound[url] = true;
                                // assetsInClassFound[url] = {
                                //     cssFile: cssFiles[i],
                                //     definition: definition,
                                //     url: url
                                // }
                                if (!/(\:\/\/|^\/\/)/.test(url) ) {
                                    filename = getAssetFilenameFromUrl(bundleConf, url);
                                } else {
                                    domain      = url.match(/^.*:\/\/[a-z0-9._-]+\/?/);
                                    url         = url.replace(domain, '/');
                                    filename    = url
                                }

                                //key =  (( /404/.test(filename) ) ? '[404]' : '[200]') +' '+ url;
                                key         = url;
                                isAvailable =  ( /404/.test(filename) ) ? false : true;
                                ext         = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/)[0];
                                assets[key] = {
                                    referrer    : cssFiles[i],
                                    definition  : definition,
                                    type        : type,
                                    url         : url,
                                    ext         : ext,
                                    mime        : bundleConf.server.coreConfiguration.mime[ext.substring(1)] || 'NA',
                                    filename    : ( /404/.test(filename) ) ? 'not found' : filename
                                };

                                if (domain)
                                    assets[key].domain = domain;

                                break;
                            }
                        }
                    }
                    //font-family: source-sans-pro, sans-serif;


                }

                // match all definitions .xxx {}
                //definitions = cssContent.match(/((\.[A-Za-z0-9-_.\s+]+)+(\s+\{|{))([A-Za-z0-9-@'"/._:;()\s+]+)\}/g);
                //definitions = cssContent.match(/((\.[A-Za-z0-9-_.\s+]+)+(\s+\{|{))?/g);
                // d = 0, dLen = definitions.length;
                // for (; d < dLen; ++d) {
                //     if ( definitions[d] )
                // }

                // fonts, images, background - attention required to relative paths !!
                //var inSourceAssets = cssContent.match(/((background\:url|url)+\()([A-Za-z0-9-_."']+).*?\)+/g);
            }

            assets._cssassets = assetsInClassFound.count();
        } // EO if (classesArr) {



        // TODO - report
        /**
         * assets._report = {
         *      total   : ${int: aCount}, // assets count
         *      warning : [
         *          {
         *              message: "too many requests",
         *              hint: "you should lower this"
         *          },
         *          {...}
         *      ],
         *      error: [
         *          {
         *              message: "${int: eCount} asset(s) not found",
         *              hint: "check your assets location"
         *          },
         *          {
         *
         *          }
         *      ]
         * }
         */


        if (swig) { // Deprecated
            var assetsStr = JSON.stringify(assets);
            assets = swig.compile( assetsStr.substring(1, assetsStr.length-1), swig.getOptions() )(data);

            return '{'+ assets +'}';
        } else {
            return JSON.stringify(assets)
        }
    }

    // var getHeaderFromPseudoHeader = function(header) {

    //     var htt2Headers = {
    //         ':status'   : 'status',
    //         ':method'   : 'method',
    //         ':authority': 'host',
    //         ':scheme'   : 'scheme', // not sure
    //         ':path'     : 'path', // not sure
    //         ':protocol' : 'protocol' // not sure
    //     };

    //     if ( typeof(htt2Headers[header]) != 'undefined' ) {
    //         return htt2Headers[header]
    //     }

    //     return header
    // }

    /**
     * Merges configured response headers (CORS, cache-control, etc.) into the
     * response. Resolves `Access-Control-Allow-Origin` against the bundle's
     * allowed origins list and normalises HTTP/1.1 vs HTTP/2 header names.
     *
     * @inner
     * @private
     * @param {object|null} responseHeaders - Extra headers to merge, or null to use conf defaults
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @returns {object} The merged response headers object
     */
    var completeHeaders = function(responseHeaders, request, response) {

        var resHeaders      = null
            , referer       = null
            , authority     = null
            , method        = null
            , scheme        = null
            , re            = null
            , allowedOrigin = null
            , sameOrigin    = false
            , conf          = self.conf[self.appName][self.env]
        ;

        if ( typeof(responseHeaders) == 'undefined' || !responseHeaders) {
            responseHeaders = {};
        }

        // Copy to avoid override
        resHeaders  = JSON.clone(conf.server.response.header);
        if ( typeof(request.routing) == 'undefined' ) {
            request.routing = {
                'url'   : request.url,
                'method': request.method
            }
        }
        if ( typeof(request.routing.bundle) == 'undefined' ) {
            request.routing.bundle = self.appName
        }
        // Should not override main server.response.header.methods
        resHeaders['access-control-allow-methods'] = request.routing.method.replace(/(\,\s+|\,)/g, ', ').toUpperCase();

        if ( typeof(request.headers.origin) != 'undefined' ) {
            authority = request.headers.origin;
        } else if (request.headers.referer) {
            referer = request.headers.referer.match(/^[https://|http://][a-z0-9-_.:/]+\//);
            if (Array.isArray(referer) && referer.length > 0) {
                referer = referer[0].substring(0, referer.length-1);
            }
        }

        // access-control-allow-origin settings
        if ( resHeaders.count() > 0 ) {

            // authority by default if no Access Control Allow Origin set
            if (!authority) {
                if (!referer) {
                    if ( /http\/2/.test(conf.server.protocol) ) {
                        authority   = request.headers[':authority'] || request.headers.host;
                        scheme      = request.headers[':scheme'] || request.headers['x-forwarded-proto'] || conf.server.scheme;
                    } else {
                        authority   = request.headers.host;
                        scheme      = ( new RegExp(authority).test(referer) ) ? referer.match(/^http(.*)\:\/\//)[0].replace(/\:\/\//, '') : conf.server.scheme;
                    }
                    authority = scheme +'://'+ authority;
                } else {
                    authority   = referer;
                    sameOrigin  = authority;
                }
            }

            if (!sameOrigin && conf.hostname == authority || !sameOrigin && conf.hostname.replace(/\:\d+$/, '') == authority.replace(/\:\d+$/, '') ) {
                sameOrigin = authority
            }

            re = new RegExp(authority);
            allowedOrigin = ( typeof(conf.server.response.header['access-control-allow-origin']) != 'undefined' && conf.server.response.header['access-control-allow-origin'] != '' ) ? conf.server.response.header['access-control-allow-origin'] : authority;
            // console.debug('[ server ][access-control-allow-origin] ', allowedOrigin);
            var found = null, origin = null, origins = null; // to handles multiple origins

            var originHostReplacement = function(name) {
                var matched = name.match(/{([-_A-z]+?@[-_A-z]+?)}/g);
                if (!matched || !Array.isArray(matched) || Array.isArray(matched) && matched.length == 0 ) {
                    return name
                }

                var env     = self.conf.env || self.env
                    , scope = self.conf.scope || self.scope
                ;

                for (let i=0, len=matched.length; i<len; ++i) {
                    let oldHost = matched[i];
                    let newHost = matched[i].replace(/\{|\}|\s+/g, '');
                    newHost = newHost.split(/\@/);
                    let bundle      = newHost[0]
                        , project   = newHost[1]
                        , arr       = null
                        , hostname  = null
                        , scheme    = null
                    ;
                    if ( /\//.test(newHost[1]) ) {
                        arr     = newHost[1].split(/\//);
                        project = arr[0];
                        env     = (arr[1]) ? arr[1] : env;
                    }
                    if ( typeof(self.conf[bundle]) == 'undefined' ) {
                        continue;
                    }
                    scheme  = self.conf[bundle][env].server.scheme;
                    hostname  = ( !self.conf[bundle][env].hostname ) ? self.conf[bundle][env].server.scheme + '://' + self.conf[bundle][env].host + ':' + self.conf[bundle][env].server.port : self.conf[bundle][env].hostname;
                    name    = name.replace(oldHost, hostname);
                }
                matched = null;
                env = null;

                return name;
            }

            var headerValue = null, re = new RegExp('\{\s*(.*)\s*\}', 'g');
            for (let h in resHeaders) {
                if (
                    !response.headersSent
                ) {
                    // handles multiple origins
                    if ( /access\-control\-allow\-origin/i.test(h) ) { // re.test(resHeaders[h]
                        if (sameOrigin) {
                            origin = sameOrigin
                        } else {
                            if ( /\,/.test(allowedOrigin) ) {
                                origins = allowedOrigin.replace(/\s+/g, '').replace(re, originHostReplacement).split(/\,/g);

                                found = ( origins.indexOf(authority) > -1 ) ? origins[origins.indexOf(authority)] : false;
                                if ( found != false ) {
                                    origin = found
                                }
                            } else {
                                origin = allowedOrigin.replace(/\s+/g, '').replace(re, originHostReplacement);
                            }
                        }

                        if (origin || sameOrigin) {
                            if (!origin && sameOrigin) {
                                origin = sameOrigin;
                            }

                            try {
                                response.setHeader(h, origin);
                            } catch (headerError) {
                                console.error(headerError)
                            }
                        }
                        sameOrigin = false;
                    } else {
                        headerValue = resHeaders[h];
                        try {
                            response.setHeader(h, headerValue);
                        } catch (headerError) {
                            console.error(headerError)
                        }
                    }
                }
            }
        }

        // update response
        try {
            if ( responseHeaders && Object.keys(responseHeaders).length > 0 ) {
                return merge(responseHeaders, response.getHeaders());
            }
            return response.getHeaders();
        } catch(err) {
            return responseHeaders
        }
    }

    /**
     * HTTP/2 server-push handler. Resolves asset paths for the current request
     * and pushes static files to the client over open HTTP/2 streams.
     * Attached to the server instance by the Isaac engine.
     *
     * @memberof module:gina/core/server
     * @param {object} stream - Node.js `Http2ServerRequest` stream
     * @param {object} headers - HTTP/2 request headers object
     * @param {object} response - HTTP/2 response object
     */
    this.onHttp2Stream = function(stream, headers, response) {
        var header          = null
            , isWebroot     = false
            , pathname      = null
            , asset         = null
            , assets        = this._options.template.assets
            , conf          = this._options.conf
            , isCacheless   = conf.isCacheless
        ;


        if (
            headers[':path'] == '/'
            || headers[':path'] == this._options.conf.server.webroot
        ) {

            if (
                this._options.conf.server.webroot != headers[':path']
                && this._options.conf.server.webrootAutoredirect
                || headers[':path'] == this._options.conf.server.webroot
                    && this._options.conf.server.webrootAutoredirect
            ) {
                isWebroot = true
            }
        }

        var url = (isWebroot) ? this._referrer : headers[':path'];

        var hanlersPath     = conf.handlersPath
            , isHandler     = (
                                typeof(assets[ url ]) != 'undefined'
                                && typeof(assets[ url ].filename) != 'undefined'
                                && new RegExp('^'+ hanlersPath).test(assets[ url ].filename)
                            ) ? true: false
        ;

        if (!stream.pushAllowed ) {

            // Fix added for static sites
            if (
                !assets[ url ]
                ||
                !assets[ url ].isBinary && !assets[ url ].isHandler
            ) {
                return;
            }

            asset = {
                url         : url,
                filename    : assets[ url ].filename,
                file        : null,
                isAvailable : assets[ url ].isAvailable,
                mime        : assets[ url ].mime,
                encoding    : conf.encoding,
                isBinary    : assets[ url ].isBinary,
                isHandler   : assets[ url ].isHandler
            };
            header = merge({ ':status': 200 }, response.getHeaders());
            header['content-type'] = ( !/charset/.test(asset.mime ) ) ? asset.mime + '; charset='+ asset.encoding : asset.mime;
            header = completeHeaders(header, local.request, response);
            if (asset.isBinary || asset.isHandler ) {


                if (asset.isHandler) {
                    // adding handler `gina.ready(...)` wrapper
                    var file = null;
                    if ( !fs.existsSync(asset.filename) ) {
                        throwError({stream: stream}, 404, 'Page not found: \n' + headers[':path']);
                        return;
                    }

                    if (!assets[ url ].file) {
                        file      = fs.readFileSync(asset.filename, asset.encoding).toString();
                        file      = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));';
                        this._options.template.assets[ headers[':path'] ].file = file;
                    } else {
                        file = assets[ url ].file;
                    }

                    // header['content-length'] = fs.statSync(file).size;
                    stream.respond(header);
                    stream.end(file);

                    return;
                }

                header['content-length'] = fs.statSync(asset.filename).size;
                stream.respondWithFile(
                    asset.filename
                    , header
                    //, { onError }
                );

            } else {
                stream.respond(header);
                stream.end();
            }

            return;
        }

        if (stream.headersSent) return;

        if ( !this._options.template ) {
            throwError({stream: stream}, 500, 'Internal server error\n' + headers[':path'] + '\nNo template found');
            return;
        }

        if (
            // headers[':path'] == '/'
            // || headers[':path'] == this._options.conf.server.webroot
            /^true$/i.test(isWebroot)
        ) {
            header = {
                ':status': 301
            };

            if (isCacheless) {
                header['cache-control'] = 'no-cache, no-store, must-revalidate';
                header['pragma'] = 'no-cache';
                header['expires'] = '0';
            }
            header['location'] = this._options.conf.server.webroot;

            stream.respond(header);
            stream.end();
            return;
        }

        if (
            typeof(this._options.template.assets) != 'undefined'
            && typeof(this._options.template.assets[ headers[':path'] ]) != 'undefined'
            && this._options.template.assets[ headers[':path'] ].isAvailable
            || isWebroot
        ) {
            // by default
            header = {
                ':status': 200
            };
            var responseHeaders = ( typeof(this._responseHeaders) != 'undefined') ? this._responseHeaders : null;
            asset = {
                url         : url,
                filename    : assets[ url ].filename,
                file        : null,
                isAvailable : assets[ url ].isAvailable,
                mime        : assets[ url ].mime,
                encoding    : conf.encoding,
                isHandler   : isHandler
            };

            console.debug('h2 pushing: '+ headers[':path'] + ' -> '+ asset.filename);

            // Adding handler `gina.ready(...)` wrapper
            if ( new RegExp('^'+ conf.handlersPath).test(asset.filename) ) {

                if ( !fs.existsSync(asset.filename) ) {
                    throwError({stream: stream}, 404, 'Page not found: \n' + headers[':path']);
                    return;
                }

                asset.isHandler = this._options.template.assets[ headers[':path'] ].isHandler  = true;
                asset.file      = fs.readFileSync(asset.filename, asset.encoding).toString();
                asset.file      = '(gina.ready(function onGinaReady($){\n'+ asset.file + '\n},window["originalContext"]));';

                stream.respond(header);
                stream.end(asset.file);

                return;
            }

            stream.pushStream({ ':path': headers[':path'] }, function onPushStream(err, pushStream, headers){


                if ( err ) {
                    header[':status'] = 500;
                    if (err.code === 'ENOENT' || !asset.isAvailable ) {
                        header[':status'] = 404;
                    }
                    //console.info(headers[':method'] +' ['+ header[':status'] +'] '+ headers[':path'] + '\n' + (err.stack|err.message|err));
                    var msg = ( header[':status'] == 404 ) ? 'Page not found: \n' + asset.url :  'Internal server error\n' + (err.stack|err.message|err)
                    throwError({stream: pushStream}, header[':status'], msg);
                    return;
                }


                header['content-type'] = ( !/charset/.test(asset.mime ) ) ? asset.mime + '; charset='+ asset.encoding : asset.mime;
                if (assets[ url ].isBinary) {
                    header['content-length'] = fs.statSync(assets[ url ].filename).size;
                }

                if (isCacheless) {
                    // source maps integration for javascript & css
                    if ( /(.js|.css)$/.test(asset.filename) && fs.existsSync(asset.filename +'.map') ) {
                        //pathname = asset.filename +'.map';
                        pathname = headers[':path'] +'.map';
                        // serve without cache
                        header['X-SourceMap'] = pathname;
                        header['cache-control'] = 'no-cache, no-store, must-revalidate';
                        header['pragma'] = 'no-cache';
                        header['expires'] = '0';
                    }
                }

                if (responseHeaders) {
                    header = merge(header, responseHeaders);
                }
                header = completeHeaders(header, local.request, response);
                var pushedFile = (/index.html$/.test(headers[':path']) && /\/$/.test(asset.filename) ) ? asset.filename +'index.html': asset.filename;
                pushStream.respondWithFile(
                    pushedFile
                    , header
                    //, { onError }
                );

            });
        } else {
            var status = 404;
            if ( /\/$/.test(headers[':path']) && this._options.template.assets[ headers[':path'] +'index.html' ].isAvailable   ) { // preview of directory is forbidden
                status = 403;
                headers[':status'] = status;
            }
            return throwError({stream: stream}, status, 'Page not found: \n' + headers[':path']);
        }
    }



    /**
     * Returns the negotiated response protocol string (e.g. `'http/1.1'` or
     * `'http/2'`). Upgrades to `'http/2'` when the bundle is configured for
     * HTTP/2 and the response has an open stream.
     *
     * @inner
     * @private
     * @param {object} response - Server response object
     * @returns {string} Protocol string
     */
    var getResponseProtocol = function (response) {

        var protocol    = 'http/'+ local.request.httpVersion; // inheriting request protocol version by default
        var bundleConf  = self.conf[self.appName][self.env];
        // Switching protocol to h2 when possible
        if ( /http\/2/.test(bundleConf.server.protocol) && response.stream ) {
            protocol    = bundleConf.server.protocol;
        }

        return protocol;
    }

    /**
     * Default HTTP/1.x static file handler. Resolves the filename from the URL,
     * streams the file to the response with the correct MIME type, or calls
     * `next` when the file is not found or falls through to routing.
     * For HTTP/2.x statics, see `SuperController`.
     *
     * @inner
     * @private
     * @param {object} staticProps - Object with `.isStaticFilename` and `.firstLevel` URL segment
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @param {function} next - Next middleware callback
     */
    var handleStatics = function(staticProps, request, response, next) {


        var conf            = self.conf
            , bundleConf    = conf[self.appName][self.env]
            , webroot       = bundleConf.server.webroot
            , re            = new RegExp('^'+ webroot)
            , publicPathRe  = new RegExp('^'+ bundleConf.publicPath)
            , pathname      = ( webroot.length > 1 && re.test(request.url) ) ? request.url.replace(re, '/') : request.url
            , contentType   = null
            , stream        = null
            , header        = null
            , protocol      = getResponseProtocol(response)
        ;


        // h2 protocol response option
        if ( /http\/2/.test(protocol) ) {

            stream = response.stream;

            if ( typeof(self._options) == 'undefined') {
                self._options       = {
                    template: {
                        assets: {}
                    },
                    conf: bundleConf
                }
            }

            self._options.conf = bundleConf
        }

        var isCacheless       = bundleConf.isCacheless;
        // by default
        var filename        = bundleConf.publicPath + pathname;
        var isFilenameDir   = null
            , dirname       = null
            , isBinary      = null
            , isHandler     = null
            , hanlersPath   = null
            , preferedEncoding = bundleConf.server.preferedCompressionEncodingOrder
            , acceptEncodingArr = (request.headers['accept-encoding']) ? request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/) : []
            , acceptEncoding = null
        ;

        // catch `statics.json` defined paths
        var staticIndex     = bundleConf.staticResources.indexOf(pathname);
        if ( staticProps.isStaticFilename && staticIndex > -1 ) {
            filename =  bundleConf.content.statics[ bundleConf.staticResources[staticIndex] ]
        } else {
            var s = 0, sLen = bundleConf.staticResources.length;
            for ( ; s < sLen; ++s ) {
                if ( eval('/^' + bundleConf.staticResources[s].replace(/\//g,'\\/') +'/').test(pathname) ) {
                    filename = bundleConf.content.statics[ bundleConf.staticResources[s] ] +'/'+ pathname.replace(bundleConf.staticResources[s], '');
                    break;
                }
            }

            // try local
            if ( !fs.existsSync(filename) ) {
                var key = pathname.replace(pathname.split('/').splice(-1), '');
                for ( ; s < sLen; ++s ) {
                    if ( bundleConf.staticResources[s] == key ) {
                        filename = bundleConf.content.statics[ bundleConf.staticResources[s] ] +'/'+ pathname.replace(bundleConf.staticResources[s], '');
                        break;
                    }
                }
                key = null;
            }
            s       = null;
            sLen    = null;

        }


        filename = decodeURIComponent(filename);
        let filenameObj = new _(filename, true);
        filenameObj.exists(function onStaticExists(exists) {
        // fs.exists(filename, function onStaticExists(exists) {

            if (!exists) {
                return throwError(response, 404, 'Page not found: \n' + pathname, next);
            }

            isFilenameDir = fs.statSync(filename).isDirectory();
            if ( isFilenameDir ) {
                dirname = request.url;
                filename += 'index.html';
                request.url += 'index.html';

                if ( !fs.existsSync(filename) ) {
                    throwError(response, 403, 'Forbidden: \n' + pathname, next);
                    return;
                }

                var ext = 'html';
                if ( /http\/2/.test(protocol) ) {
                    header = {
                        ':status': 301,
                        'location': request.url,
                        'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                    };

                    if (isCacheless) {
                        header['cache-control'] = 'no-cache, no-store, must-revalidate';
                        header['pragma'] = 'no-cache';
                        header['expires'] = '0';
                    }
                    request = checkPreflightRequest(request, response);
                    header  = completeHeaders(header, request, response);

                    if (!stream.destroyed) {
                        stream.respond(header);
                        stream.end();
                    }

                } else {
                    response.setHeader('location', request.url);
                    request = checkPreflightRequest(request, response);
                    completeHeaders(null, request, response);
                    if (isCacheless) {
                        response.writeHead(301, {
                            'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from using cache
                            'pragma': 'no-cache',
                            'expires': '0',
                            'content-type': bundleConf.server.coreConfiguration.mime[ext]
                        });
                    }
                    response.end()
                }

                return;
            }


            if (isCacheless) {
                delete require.cache[require.resolve(filename)];
            }

            if (response.headersSent) {
                // May be sent by http/2 push
                return
            }
            fs.readFile(filename, bundleConf.encoding, function onStaticFileRead(err, file) {
                if (err) {
                    throwError(response, 404, 'Page not found: \n' + pathname, next);
                    return;
                }

                if (!response.headersSent) {

                    isBinary    = true;
                    isHandler   = false;

                    try {
                        contentType = getContentTypeByFilename(filename);

                        // adding gina loader
                        if ( /text\/html/i.test(contentType) && self.isCacheless() ) {
                            isBinary = false;
                            // javascriptsDeferEnabled
                            if  (bundleConf.content.templates._common.javascriptsDeferEnabled ) {
                                file = file.replace(/\<\/head\>/i, '\t'+ bundleConf.content.templates._common.ginaLoader +'\n</head>');
                            } else {
                                file = file.replace(/\<\/body\>/i, '\t'+ bundleConf.content.templates._common.ginaLoader +'\n</body>');
                            }

                        } else {
                            // adding handler `gina.ready(...)` wrapper
                            hanlersPath = bundleConf.handlersPath;

                            if ( new RegExp('^'+ hanlersPath).test(filename) ) {
                                isBinary    = false;
                                isHandler   = true;
                                file = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));'

                                // acceptEncodingArr = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
                                // acceptEncoding = null;
                                for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) {
                                    if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) {
                                        acceptEncoding = bundleConf.server.coreConfiguration.encoding[ preferedEncoding[e] ] ;
                                        break;
                                    }
                                }
                                // Compressed content
                                if (
                                    !isCacheless
                                    && acceptEncoding
                                    && fs.existsSync(filename + acceptEncoding)
                                ) {
                                    isBinary = true;
                                }
                            }
                        }

                        if ( /http\/2/.test(protocol) ) {
                            self._isStatic      = true;
                            self._referrer      = request.url;
                            var ext = request.url.match(/\.([A-Za-z0-9]+)$/);
                            request.url = ( ext != null && typeof(ext[0]) != 'undefined' ) ? request.url : request.url + 'index.html';

                            self._responseHeaders         = response.getHeaders();
                            if (
                                !isBinary
                                && typeof(self._options.template.assets[request.url]) == 'undefined'
                            ) {
                                self._options.template.assets = getAssets(bundleConf, file);
                            }

                            if (
                                typeof(self._options.template.assets[request.url]) == 'undefined'
                                || isBinary
                            ) {

                                self._options.template.assets[request.url] = {
                                    ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                    isAvailable: true,
                                    mime: contentType,
                                    url: request.url,
                                    filename: filename,
                                    isBinary: isBinary,
                                    isHandler: isHandler
                                }
                            }

                            self.instance._isXMLRequest    = request.isXMLRequest;
                            self.instance._getAssetFilenameFromUrl = getAssetFilenameFromUrl;

                            var isPathMatchingUrl = null;
                            if ( !self.instance._http2streamEventInitalized ) {
                                self.instance._http2streamEventInitalized = true;
                                self.instance.on('stream', function onHttp2Strem(stream, headers) {

                                    if (!self._isStatic) return;

                                    if (!this._isXMLRequest) {
                                        isPathMatchingUrl = true;
                                        if (headers[':path'] != request.url) {
                                            request.url         = headers[':path'];
                                            isPathMatchingUrl   = false;
                                        }

                                        // for new requests
                                        if (!isPathMatchingUrl) {
                                            pathname        = ( webroot.length > 1 && re.test(request.url) ) ? request.url.replace(re, '/') : request.url;
                                            isFilenameDir   = (webroot == request.url) ? true: false;

                                            if ( !isFilenameDir && !/404\.html/.test(filename) && fs.existsSync(filename) )
                                                isFilenameDir = fs.statSync(filename).isDirectory();
                                            if (!isFilenameDir) {
                                                filename = this._getAssetFilenameFromUrl(bundleConf, pathname);
                                            }

                                            if ( !isFilenameDir && !fs.existsSync(filename) ) {
                                                throwError(response, 404, 'Page not found: \n' + pathname, next);
                                                return;
                                            }


                                            if ( isFilenameDir ) {
                                                dirname = bundleConf.publicPath + pathname;
                                                filename =  dirname + 'index.html';
                                                request.url += 'index.html';
                                                if ( !fs.existsSync(filename) ) {
                                                    throwError(response, 403, 'Forbidden: \n' + pathname, next);
                                                    return;
                                                } else {
                                                    header = {
                                                        ':status': 301,
                                                        'location': request.url
                                                    };

                                                    if (isCacheless) {
                                                        header['cache-control'] = 'no-cache, no-store, must-revalidate';
                                                        header['pragma'] = 'no-cache';
                                                        header['expires'] = '0';
                                                    }


                                                    stream.respond(header);
                                                    stream.end();
                                                }
                                            }
                                        }

                                        contentType = getContentTypeByFilename(filename);
                                        contentType = contentType +'; charset='+ bundleConf.encoding;
                                        ext = request.url.match(/\.([A-Za-z0-9]+)$/);
                                        request.url = ( ext != null && typeof(ext[0]) != 'undefined' ) ? request.url : request.url + 'index.html';
                                        if (
                                            !isPathMatchingUrl
                                            && typeof(self._options.template.assets[request.url]) == 'undefined'
                                        ) {

                                            self._options.template.assets[request.url] = {
                                                ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                                //isAvailable: true,
                                                isAvailable: (!/404\.html/.test(filename)) ? true : false,
                                                mime: contentType,
                                                url: request.url,
                                                filename: filename,
                                                isBinary: isBinary,
                                                isHandler: isHandler
                                            }
                                        }

                                        if (!fs.existsSync(filename)) return;
                                        isBinary    = ( /text\/html/i.test(contentType) ) ? false : true;
                                        isHandler   = ( new RegExp('^'+ bundleConf.handlersPath).test(filename) ) ? true : false;
                                        if ( isBinary ) {
                                            // override
                                            self._options.template.assets[request.url] = {
                                                ext: ( ext != null && typeof(ext[0]) != 'undefined' ) ? ext[0] : null,
                                                isAvailable: true,
                                                mime: contentType,
                                                url: request.url,
                                                filename: filename,
                                                isBinary: isBinary,
                                                isHandler: isHandler
                                            }
                                        }

                                        if ( isHandler ) {
                                            // adding handler `gina.ready(...)` wrapper
                                            var file = null;
                                            if (!self._options.template.assets[request.url].file) {
                                                file      = fs.readFileSync(filename, bundleConf.encoding).toString();
                                                file      = '(gina.ready(function onGinaReady($){\n'+ file + '\n},window["originalContext"]));';
                                                self._options.template.assets[request.url].file = file;
                                            }
                                        }
                                        self.onHttp2Stream(stream, headers, response);
                                    }

                                }); // EO self.instance.on('stream' ..
                            }


                            header = {
                                ':status': 200,
                                'content-type': contentType + '; charset='+ bundleConf.encoding
                            };

                            if (isCacheless) {
                                // source maps integration for javascript & css
                                if ( /(.js|.css)$/.test(filename) && fs.existsSync(filename +'.map') && !/sourceMappingURL/.test(file) ) {
                                    //pathname = pathname +'.map';
                                    pathname = webroot + pathname.substring(1) +'.map';
                                    // serve without cache
                                    header['X-SourceMap'] = pathname;
                                    header['cache-control'] = 'no-cache, no-store, must-revalidate';
                                    header['pragma'] = 'no-cache';
                                    header['expires'] = '0';
                                }
                            }

                            header  = completeHeaders(header, request, response);
                            if (isBinary) {
                                stream.respondWithFile(filename, header)
                            } else {
                                stream.respond(header);
                                stream.end(file);
                            }
                            // Fixed on march 15 2021 by removing the return
                            // Could be the cause why the push is pending
                            //return;
                        } else {

                            completeHeaders(null, request, response);
                            response.setHeader('content-type', contentType +'; charset='+ bundleConf.encoding);
                            // if (/\.(woff|woff2)$/i.test(filename) )  {
                            //     response.setHeader("transfer-encoding", 'Identity')
                            // }


                            if (isBinary) {
                                response.setHeader('content-length', fs.statSync(filename).size);

                                // acceptEncodingArr = request.headers['accept-encoding'].replace(/\s+/g, '').split(/\,/);
                                // acceptEncoding = null;
                                for (let e=0, eLen=preferedEncoding.length; e<eLen; e++) {
                                    if ( acceptEncodingArr && acceptEncodingArr.indexOf(preferedEncoding[e]) > -1 ) {
                                        acceptEncoding = bundleConf.server.coreConfiguration.encoding[ preferedEncoding[e] ] ;
                                        break;
                                    }
                                }
                                // Compressed content
                                if (
                                    !isCacheless
                                    && acceptEncoding
                                    && fs.existsSync(filename + acceptEncoding)
                                ) {
                                    filename += acceptEncoding;
                                    // https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Encoding
                                    response.setHeader('content-encoding', acceptEncoding.replace(/^\./, ''));
                                    // override content length
                                    response.setHeader('content-length', fs.statSync(filename).size);
                                }
                            }

                            if (isCacheless) {
                                // source maps integration for javascript & css
                                if ( /(.js|.css)$/.test(filename) && fs.existsSync(filename +'.map') && !/sourceMappingURL/.test(file) ) {
                                    //pathname = pathname +'.map'
                                    pathname = webroot + pathname.substring(1) +'.map';
                                    response.setHeader("X-SourceMap", pathname)
                                }

                                // serve without cache
                                response.writeHead(200, {
                                    'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from caching it
                                    'pragma': 'no-cache',
                                    'expires': '0'
                                });

                            } else {
                                response.writeHead(200)
                            }


                            if (isBinary) { // images, javascript, pdf ....

                                fs.createReadStream(filename)
                                    .on('end', function onResponse(){
                                        console.info(request.method +' [200] '+ pathname);
                                    })
                                    .pipe(response);
                            } else {
                                response.write(file, bundleConf.encoding);
                                response.end();
                                console.info(request.method +' [200] '+ pathname);
                            }

                            return;
                        }

                    } catch(err) {
                        throwError(response, 500, err.stack);
                        return;
                    }
                }

                return
            });


        });
        filenameObj = null;
    }


    /**
     * Attaches the catch-all `*` route handler to the server instance.
     * Handles statics, preflight (CORS OPTIONS), body parsing, Express
     * middleware chain, and final routing delegation to the Router.
     *
     * @inner
     * @private
     * @returns {void}
     */
    var onRequest = function() {

        var apps = self.bundles;
        var webrootLen = self.conf[self.appName][self.env].server.webroot.length;

        // catch all (request urls)
        self.instance.all('*', function onInstance(request, response, next) {

            // Caching = [...]
            // TODO - handle this through a middleware
            /**
            * var cacheIndex = ['/api/document/get/b47c4dd3-f7c4-44b2-b1fb-401948be1ca4'].indexOf(request.url)
            * if ( cacheIndex > -1) {
            *     // return caching[cacheIndex].content
            * }
            */

            // Retrieving cached route
            // var cachedUrls = ['/'];
            // if (cachedUrls.indexOf(request.url) > -1) {
            //     request.routing = JSON.parse('{"method":"GET","namespace":"home","url":"/","rule":"home@public","param":{"control":"home","file":"../home"},"middleware":["middlewares.maintenance.check"],"bundle":"public","isXMLRequest":false,"isWithCredentials":false}');
            //     var headers = JSON.parse('{"X-Powered-By":"Gina I/O - v0.1.6-alpha.94","access-control-allow-headers":"X-Requested-With, Content-Type","access-control-allow-methods":"GET","access-control-allow-credentials":true,"vary":"Origin","accept-language":"en-US,en;q=0.8,fr;q=0.6"}');
            //     for (let h in headers) {
            //         response.setHeader(h, headers[h]);
            //     }

            //     return local.router.route(request, response, next, request.routing);
            // }



            request.setEncoding(self.conf[self.appName][self.env].encoding);
            // be carfull, if you are using jQuery + cross domain, you have to set the header manually in your $.ajax query -> headers: {'X-Requested-With': 'XMLHttpRequest'}
            request.isXMLRequest       = ( request.headers['x-requested-with'] && request.headers['x-requested-with'] == 'XMLHttpRequest' ) ? true : false;

            // Passing credentials :
            //      - if you are using jQuery + cross domain, you have to set the `xhrFields` in your $.ajax query -> xhrFields: { withCredentials: true }
            //      - if you are using another solution or doing it by hand, make sure to properly set the header: headers: {'access-control-allow-credentials': true }
            /**
             * NB.: jQuery
             * The `withCredentials` property will include any cookies from the remote domain in the request,
             * and it will also set any cookies from the remote domain.
             * Note that these cookies still honor same-origin policies, so your JavaScript code can’t access the cookies
             * from document.cookie or the response headers.
             * They can only be controlled/produced by the remote domain.
             * */
            request.isWithCredentials  = ( request.headers['access-control-allow-credentials'] && request.headers['access-control-allow-credentials'] == true ) ? true : false;
            /**
             * Intercept gina headers for:
             *  - form valdiation
             *  - form security
             */
            var ginaHeaders = {
                form: {},
                popin: {}
            };
            // if (/x\-gina\-form\-id/i.test(request.headers['access-control-request-headers']) ) {
            if ( typeof(request.headers['x-gina-form-rule']) != 'undefined' ) {
                ginaHeaders.form.id = request.headers['x-gina-form-id'];
            }
            if ( typeof(request.headers['x-gina-popin-id']) != 'undefined' ) {
                ginaHeaders.popin.id = request.headers['x-gina-popin-id'];
            }
            if ( typeof(request.headers['x-gina-popin-name']) != 'undefined' ) {
                ginaHeaders.popin.name = request.headers['x-gina-popin-name'];
            }
            if ( typeof(request.headers['x-gina-form-rule']) != 'undefined' ) {
                var rule = request.headers['x-gina-form-rule'].split(/\@/);
                ginaHeaders.form.rule = rule[0];
                ginaHeaders.form.bundle = rule[1];
                rule = null;
            }
            request.ginaHeaders = ginaHeaders;

            local.request = request;

            response.setHeader('X-Powered-By', 'Gina/'+ GINA_VERSION );



            // Fixing an express js bug :(
            // express is trying to force : /path/dir => /path/dir/
            // which causes : /path/dir/path/dir/  <---- by trying to add a slash in the end
            // if (
            //     webrootLen > 1
            //     && request.url === self.conf[self.appName][self.env].server.webroot + '/' + self.conf[self.appName][self.env].server.webroot + '/'
            // ) {
            //     request.url = self.conf[self.appName][self.env].server.webroot
            // }


            // webroot filter
            var isWebrootHandledByRouting = ( self.conf[self.appName][self.env].server.webroot == request.url && !fs.existsSync( _(self.conf[self.appName][self.env].publicPath +'/index.html', true) ) ) ? true : false;
            // webrootAutoredirect case
            if (
                request.url == '/'
                && typeof(self.conf[self.appName][self.env].server.webroot) != 'undefined'
                && /^true$/i.test(self.conf[self.appName][self.env].server.webrootAutoredirect)
            ) {
                var routing = self.conf[self.appName][self.env].content.routing;
                if (
                    typeof(routing['webroot@'+self.appName]) != 'undefined'
                    && self.conf[self.appName][self.env].server.webroot == routing['webroot@'+self.appName].webroot
                ) {
                    var urls = routing['webroot@'+self.appName].url.split(',');
                    if ( urls.indexOf('/') > -1 ) {
                        isWebrootHandledByRouting = true;
                    }
                    urls = null;
                }
                routing = null;
            }

            // priority to statics - this portion of code has been duplicated to SuperController : see `isStaticRoute` method
            var staticsArr  = self.conf[self.appName][self.env].publicResources;
            var staticProps = {
                isStaticFilename: false
            };

            if (!isWebrootHandledByRouting) {

                staticProps.firstLevel          = '/' + request.url.split(/\//g)[1] + '/';

                // to be considered as a stativ content, url must content at least 2 caracters after last `.`: .js, .html are ok
                var ext = request.url.match(/(\.([A-Za-z0-9]+){2}|\/)$/);
                var isImage = false;
                if ( typeof(ext) != 'undefined' &&  ext != null) {
                    ext = ext[0];
                    // if image with `@` found
                    if ( /^image/i.test(self.conf[self.appName][self.env].server.coreConfiguration.mime[ext.substring(1)]) ) {
                        isImage = true
                    }
                }
                if (
                    ext != null
                    // and must not be an email
                    && !/^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test(request.url)
                    // and must be handled by mime.types
                    &&  typeof(self.conf[self.appName][self.env].server.coreConfiguration.mime[ext.substring(1)]) != 'undefined'
                    ||
                    ext != null
                    && isImage

                ) {
                    staticProps.isStaticFilename = true
                }

                ext = null;
                isImage = null;
            }



            // handle resources from public with webroot in url
            if ( staticProps.isStaticFilename && self.conf[self.appName][self.env].server.webroot != '/' && staticProps.firstLevel == self.conf[self.appName][self.env].server.webroot ) {
                var matchedFirstInUrl = request.url.replace(self.conf[self.appName][self.env].server.webroot, '').match(/[A-Za-z0-9_-]+\/?/);
                if ( matchedFirstInUrl && matchedFirstInUrl.length > 0 ) {
                    staticProps.firstLevel = self.conf[self.appName][self.env].server.webroot + matchedFirstInUrl[0]
                }
                matchedFirstInUrl = null;
            }

            if (
                staticProps.isStaticFilename && staticsArr.indexOf(request.url) > -1
                || staticProps.isStaticFilename && staticsArr.indexOf( request.url.replace(request.url.substring(request.url.lastIndexOf('/')+1), '') ) > -1
                || staticProps.isStaticFilename && new RegExp('^'+ staticProps.firstLevel).test(request.url)
                || /\/$/.test(request.url) && !isWebrootHandledByRouting && !/\/engine\.io\//.test(request.url)
            ) {
                self._isStatic  = true;

                self._referrer  = request.url;
                // by default - used in `composeHeadersMiddleware`: see Default Global Middlewares (gna.js)
                request.routing = {
                    'url'       : request.url,
                    'method'    : 'GET',
                    'bundle'    : self.appName
                };
                request = checkPreflightRequest(request, response);
                local.request = request; // update request
                // filtered to handle only html for now
                if ( /text\/html/.test(request.headers['accept'])
                    &&  /^isaac/.test(self.engine)
                    && self.instance._expressMiddlewares.length > 0
                    ||
                    request.isPreflightRequest
                    && /^isaac/.test(self.engine)
                    && self.instance._expressMiddlewares.length > 0
                ) {

                    nextMiddleware._index        = 0;
                    nextMiddleware._count        = self.instance._expressMiddlewares.length-1;
                    nextMiddleware._request      = request;
                    nextMiddleware._response     = response;
                    nextMiddleware._next         = next;
                    nextMiddleware._nextAction   = 'handleStatics';
                    nextMiddleware._staticProps  = staticProps;


                    nextMiddleware()
                } else {
                    handleStatics(staticProps, request, response, next);
                }

            } else { // not a static request
                self._isStatic  = false;
                // init content
                request.body    = ( typeof(request.body) != 'undefined' ) ? request.body : {};
                request.get     = {};
                request.post    = {};
                request.put     = {};
                request.delete  = {};
                request.files   = [];
                //request.patch = {}; ???
                //request.cookies = {}; // ???
                //request.copy ???



                // multipart wrapper for uploads
                // files are available from your controller or any middlewares:
                //  @param {object} req.files
                if ( /multipart\/form-data;/.test(request.headers['content-type']) ) {
                    // TODO - get options from settings.json & settings.{env}.json ...
                    // -> https://github.com/mscdex/busboy
                    var opt = self.conf[self.appName][self.env].content.settings.upload;
                    // checking size
                    var maxSize     = parseInt(opt.maxFieldsSize);
                    var fileSize    = request.headers["content-length"]/1024/1024; //MB
                    var hasAutoTmpCleanupTimeout = (
                        typeof(opt.autoTmpCleanupTimeout) != 'undefined'
                        &&  opt.autoTmpCleanupTimeout != ''
                        &&  opt.autoTmpCleanupTimeout != 0
                        &&  !/false/i.test(opt.autoTmpCleanupTimeout)
                    ) ? true : false;
                    var autoTmpCleanupTimeout = (!hasAutoTmpCleanupTimeout) ? null : parseTimeout(opt.autoTmpCleanupTimeout);

                    if (fileSize > maxSize) {
                        return throwError(response, 431, 'Attachment exceeded maximum file size [ '+ opt.maxFieldsSize +' ]');
                    }

                    var uploadDir = opt.uploadDir || os.tmpdir();

                    /**
                     * str2ab
                     * One common practical question about ArrayBuffer is how to convert a String to an ArrayBuffer and vice-versa.
                     * Since an ArrayBuffer is, in fact, a byte array, this conversion requires that both ends agree on how
                     * to represent the characters in the String as bytes.
                     * You probably have seen this "agreement" before: it is the
                     * String's character encoding (and the usual "agreement terms" are, for example, Unicode UTF-16 and iso8859-1).
                     * Thus, supposing you and the other party have agreed on the UTF-16 encoding
                     *
                     * ref.:
                     *  - https://developers.google.com/web/updates/2012/06/How-to-convert-ArrayBuffer-to-and-from-String
                     *  - https://jsperf.com/arraybuffer-string-conversion/4
                     *
                     * TODO - Test with audio content
                     *
                     * @param {string} str
                     *
                     * @returns {array} buffer
                     * */
                    var str2ab = function(str, bits) {

                        var bytesLength = str.length
                            //, bits         = 8 // default bytesLength
                            , bits      = ( typeof (bits) != 'undefined' ) ? (bits/8) : 1
                            , buffer    = new ArrayBuffer(bytesLength * bits) // `bits`  bytes for each char
                            , bufView   = null;

                        switch (bytesLength) {
                            case 8:
                                bufView = new Uint8Array(buffer);
                                break;

                            case 16:
                                bufView = new Uint16Array(buffer);
                                break;

                            case 32:
                                bufView = new Uint32Array(buffer);
                                break;

                            default:
                                bufView = new Uint8Array(buffer);
                                break;
                        }
                        //var buf = new ArrayBuffer(str.length * 2); // 2 bytes for each char when using Uint16Array(buf)
                        //var buf = new ArrayBuffer(str.length); // Uint8Array
                        //var bufView = new Uint8Array(buf);
                        for (let i = 0, strLen = str.length; i < strLen; i++) {
                            bufView[i] = str.charCodeAt(i);
                        }

                        return buffer;
                    };

                    /**
                     * str2ab
                     *
                     * With TypedArray now available, the Buffer class implements the Uint8Array API
                     * in a manner that is more optimized and suitable for Node.js.
                     * ref.:
                     *  - https://nodejs.org/api/buffer.html#buffer_buffer_from_buffer_alloc_and_buffer_allocunsafe
                     *
                     * @param {string} str
                     *
                     * @returns {array} buffer
                     */
                    // var str2ab = function(str, encoding) {

                    //     const buffer = Buffer.allocUnsafe(str.length);

                    //     for (let i = 0, len = str.len; i < len; i++) {
                    //         buffer[i] = str.charCodeAt(i);
                    //     }

                    //     return buffer;
                    // }


                    var fileObj         = null
                        , fileCount     = 0
                        , tmpFilename   = null
                        , writeStreams  = []
                        , index         = 0;

                    request.files = [];
                    request.routing = {
                        'url': request.url,
                        'method': 'POST',
                        'bundle' : self.appName
                    };
                    var busboy = Busboy({ headers: request.headers });

                    // busboy.on('field', function(fieldname, val, fieldnameTruncated, valTruncated) {
                    //     console.log('Field [' + fieldname + ']: value: ' + inspect(val));
                    // });

                    // Attention: on busboy upgrade, we needs to adapt `busboy/lib/types/multipart.js`
                    // For this, check the emit method
                    busboy.on('file', function(fieldname, file, filename, encoding, mimetype, group) {

                        file._dataLen = 0;
                        ++fileCount;

                        if (
                            typeof(group) != 'undefined'
                            && group != 'untagged'
                            && typeof(opt.groups[group]) != 'undefined'
                        ) {
                            // allowed extensions
                            if ( typeof(opt.groups[group].allowedExtensions) != 'undefined'
                                && opt.groups[group].allowedExtensions != '*'
                            ) {
                                var ext     = opt.groups[group].allowedExtensions;
                                var fileExt = filename.substring(filename.lastIndexOf('.')+1)
                                if ( !Array.isArray(ext) ) {
                                    ext = [ext]
                                }

                                if ( ext.indexOf(fileExt) < 0 ) {
                                    throwError(response, 400, '`'+ fileExt +'` is not an allowed extension. See `'+ group +'` upload group definition.');
                                    return false;
                                }
                            }

                            // multiple or single
                            if ( typeof(opt.groups[group].isMultipleAllowed) != 'undefined'
                                && !opt.groups[group].isMultipleAllowed
                                && fileCount > 1
                            ) {
                                throwError(response, 400, 'multiple uploads not allowed. See `'+ group +'` upload group definition.');
                                return false;
                            }
                        }


                        // TODO - https://github.com/TooTallNate/node-wav
                        //file._mimetype = mimetype;

                        // creating file
                        writeStreams[index] = fs.createWriteStream( _(uploadDir + '/' + filename) );
                        // https://strongloop.com/strongblog/practical-examples-of-the-new-node-js-streams-api/
                        var liner = new require('stream').Transform({objectMode: true});

                        liner._transform = function (chunk, encoding, done) {

                            var str = chunk.toString();
                            file._dataLen += str.length;

                            var ab = Buffer.from(str2ab(str));
                            this.push(ab)

                            done()
                        }

                    //     liner._flush = function (done) {
                    //         done()
                    //     }

                        file.pipe(liner).pipe(writeStreams[index]);
                        ++index;


                        file.on('end', function() {

                            //fileObj = Buffer.from(str2ab(this._dataChunk));
                            //delete this._dataChunk;

                            tmpFilename = _(uploadDir + '/' + filename);

                            request.files.push({
                                name: fieldname,
                                group: group,
                                originalFilename: filename,
                                encoding: encoding,
                                type: mimetype,
                                size: this._dataLen,
                                path: tmpFilename
                            });

                            // /tmp autoTmpCleanupTimeout
                            if (autoTmpCleanupTimeout) {
                                setTimeout((tmpFilename) => {
                                    console.debug('[ BUNDLE ][ '+self.appName+' ][ server ][ upload ] Now removing `'+ tmpFilename +'` from tmp');
                                    var tmpFilename = new _(tmpFilename);
                                    if (tmpFilename.existsSync())
                                        tmpFilename.rmSync();
                                }, autoTmpCleanupTimeout, tmpFilename);
                            }
                        });
                    });

                    busboy.on('finish', function() {
                        var total = writeStreams.length;
                        for (var ws = 0, wsLen = writeStreams.length; ws < wsLen; ++ws ) {

                            writeStreams[ws].on('error', function(err) {
                                console.error('[ busboy ] [ onWriteError ]', err);
                                throwError(response, 500, 'Internal server error\n' + err, next);
                                this.close();
                                return;
                            });

                            writeStreams[ws].on('finish', function() {
                                this.close( function onUploaded(){
                                    --total;
                                    console.debug('closing writestreams : ' + total);

                                    if (total == 0) {
                                        loadBundleConfiguration(request, response, next, function onBundleConfigurationLoaded(err, bundle, pathname, config, req, res, next) {
                                            if (!req.handled) {
                                                req.handled = true;
                                                if (err) {
                                                    if (!res.headersSent)
                                                        throwError(response, 500, 'Internal server error\n' + err.stack, next);
                                                        return;
                                                } else {
                                                    handle(req, res, next, bundle, pathname, config)
                                                }
                                            }
                                        })
                                    }
                                })
                            });
                        }
                    });

                    request.pipe(busboy);
                } else {


                    request.on('data', function(chunk){ // for this to work, don't forget the name attr for you form elements
                        if ( typeof(request.body) == 'object') {
                            request.body = '';
                        }
                        request.body += chunk.toString()
                    });

                    request.on('end', function onEnd() {
                        processRequestData(request, response, next);
                    });

                    if (request.end) request.end();


                } //EO if multipart
            }


        });//EO this.instance


        // Timeout in milliseconds - e.g.: (1000x60)x2 => 2 min
        self.instance.timeout = 0; // zero for unlimited
        // Port by default would be 3100
        // '::' as the binding address (ipv4 & ipv6)
        // To check: netstat -tuln
        // If you get "connection refused", make sure that `/proc/sys/net/ipv6/bindv6only` is set to 0
        // TODO - compare core/config.js and core/template/conf/settings.json
        // self.instance.listen(self.conf[self.appName][self.env].server.port, self.conf[self.appName][self.env].server.address, self.conf[self.appName][self.env].server.backlog);
        // Capture the raw server returned by listen() so proc.js can call
        // server.close() on SIGTERM for graceful shutdown. For the isaac engine,
        // self.instance IS the raw server and listen() returns it unchanged. For
        // the express engine, app.listen() creates the underlying http/http2 server
        // internally and returns it — without capturing here it is unreachable.
        var _rawServer = self.instance.listen(self.conf[self.appName][self.env].server.port);
        process.server = (_rawServer && typeof _rawServer.close === 'function') ? _rawServer : self.instance;

        self.emit('started', self.conf[self.appName][self.env], true);
    }

    /**
     * Parses and normalises the request body for POST/PUT/PATCH/DELETE methods.
     * Handles `application/json`, `application/x-www-form-urlencoded`, and
     * `multipart/form-data` (via Busboy). Calls `next` when done.
     *
     * @inner
     * @private
     * @param {object} request - Incoming request object
     * @param {object} response - Server response object
     * @param {function} next - Next middleware callback
     */
    var processRequestData = function(request, response, next) {

        var bodyStr = null, obj = null, exception = null;
        // to compare with /core/controller/controller.js -> getParams()
        switch( request.method.toLowerCase() ) {
            case 'post':
                var configuring = false, msg = null, isPostSet = false;
                if ( typeof(request.body) == 'string' ) {
                    // get rid of encoding issues
                    try {
                        if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                            if ( !/application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) && /\+/.test(request.body) ) {
                                request.body = request.body.replace(/\+/g, ' ');
                            }

                            if ( request.body.substring(0,1) == '?')
                                request.body = request.body.substring(1);

                            try {
                                bodyStr = decodeURIComponent(request.body); // it is already a string for sure
                            } catch (err) {
                                bodyStr = request.body;
                            }

                            // false & true case
                            if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                            if ( /(\"null\")/i.test(bodyStr) )
                                bodyStr = bodyStr.replace(/\"null\"/ig, null);

                            try {
                                // obj = parseBody(bodyStr);
                                obj = formatDataFromString(bodyStr);
                                if ( !obj) {
                                    exception = new Error('Could not convert POST::BODY_STRING to POST::OBJECT. Possible JSON error in `bodyStr`');
                                    throwError(response, 500, exception, next);
                                    return;
                                }
                                request.post = obj;
                                isPostSet = true;
                            } catch (err) {
                                // ignore this one
                                msg = '[ Could properly evaluate POST ] '+ request.url +'\n'+  err.stack;
                                console.warn(msg);
                            }
                            if (!isPostSet) {
                                try {
                                    if (obj.count() == 0 && bodyStr.length > 1) {
                                        request.post = obj;
                                    } else {
                                        request.post = JSON.parse(bodyStr)
                                    }

                                } catch (err) {
                                    msg = '[ Exception found for POST ] '+ request.url +'\n'+  err.stack;
                                    console.warn(msg);
                                }
                            }
                        }

                    } catch (err) {
                        msg = '[ Could properly evaluate POST ] '+ request.url +'\n'+  err.stack;
                        console.warn(msg);
                    }

                } else {
                    // 2016-05-19: fix to handle requests from swagger/express
                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                        request.body = request.query
                    }
                    // 2023-01-31: fixed `request.body` might not be an `object`
                    bodyStr = ( typeof(request.body) == 'object') ? JSON.stringify(request.body) : request.body;
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);

                    obj = JSON.parse(bodyStr)
                }

                try {
                    if ( typeof(obj) == 'object' && obj.count() > 0 ) {
                        // still need this to allow compatibility with express & connect middlewares
                        request.body = request.post = obj;
                    }
                } catch (err) {
                    msg = '[ Could complete POST ] '+ request.url +'\n'+ err.stack;
                    console.error(msg);
                    throwError(response, 500, err, next);
                    return;
                }


                // see.: https://www.w3.org/Protocols/rfc2616/rfc2616-sec9.html#POST
                //     Responses to this method are not cacheable,
                //     unless the response includes appropriate cache-control or expires header fields.
                //     However, the 303 (See Other) response can be used to direct the user agent to retrieve a cacheable resource.
                if ( !response.headersSent ) {
                    response.setHeader('cache-control', 'no-cache, no-store, must-revalidate');
                    response.setHeader('pragma', 'no-cache');
                    response.setHeader('expires', '0');
                }


                // cleaning
                request.query   = undefined;
                request.get     = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                break;

            case 'get':
                // if ( typeof(request.query) == 'string' && /^(\{|\[\{)/.test(request.query) ) {
                //     bodyStr = request.query.replace(/\"{/g, '{').replace(/}\"/g, '}').replace(/\\/g, '');
                //     request.query = JSON.parse(bodyStr);
                // }
                if ( typeof(request.query) != 'undefined' && request.query.count() > 0 ) {
                    var inheritedDataObj = {};
                    if ( typeof(request.query.inheritedData) != 'undefined' ) {


                        if ( typeof(request.query.inheritedData) == 'string' ) {
                            inheritedDataObj = formatDataFromString(decodeURIComponent(request.query.inheritedData));
                        } else {
                            inheritedDataObj = JSON.clone(request.query.inheritedData);
                        }

                        delete request.query.inheritedData;

                    }

                    bodyStr = JSON.stringify(request.query).replace(/\"{/g, '{').replace(/}\"/g, '}').replace(/\\/g, '');
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/ig, false).replace(/\"true\"/ig, true).replace(/\"on\"/ig, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);


                    obj = formatDataFromString(decodeURIComponent(bodyStr));

                    request.query = merge(obj, inheritedDataObj);
                    // delete obj;
                    obj = null;
                    inheritedDataObj = null;

                    request.get = request.query;
                }
                // else, will be matching route params against url context instead, once route is identified


                // cleaning
                request.query   = undefined;
                request.post    = undefined;
                request.put     = undefined;
                request.delete  = undefined;
                break;

            case 'put':
                // eg.: PUT /user/set/1
                if ( typeof(request.body) == 'string' ) {
                    // get rid of encoding issues
                    try {
                        if ( !/multipart\/form-data;/.test(request.headers['content-type']) ) {
                            if ( !/application\/x\-www\-form\-urlencoded/.test(request.headers['content-type']) ) {
                                request.body = request.body.replace(/\+/g, ' ');
                            }

                            if ( request.body.substring(0,1) == '?')
                                request.body = request.body.substring(1);

                            // false & true case
                            try {
                                bodyStr = decodeURIComponent(request.body); // it is already a string for sure
                            } catch (err) {
                                bodyStr = request.body;
                            }

                            // false & true case
                            if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                                bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                            if ( /(\"null\")/i.test(bodyStr) )
                                bodyStr = bodyStr.replace(/\"null\"/ig, null);

                            obj = formatDataFromString(bodyStr);

                            if ( typeof(obj) != 'undefined' && obj.count() == 0 && bodyStr.length > 1 ) {
                                try {
                                    request.put = merge(request.put, obj);
                                } catch (err) {
                                    console.log('Case `put` #0 [ merge error ]: ' + (err.stack||err.message))
                                }
                            }
                        }

                    } catch (err) {
                        var msg = '[ '+request.url+' ]\nCould not evaluate PUT.\n'+ err.stack;
                        throwError(response, 500, msg, next);
                        return;
                    }

                } else {
                    // 2016-05-19: fix to handle requests from swagger/express
                    if (request.body.count() == 0 && typeof(request.query) != 'string' && request.query.count() > 0 ) {
                        request.body = request.query
                    }
                    bodyStr = JSON.stringify(request.body);
                    // false & true case
                    if ( /(\"false\"|\"true\"|\"on\")/.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"false\"/g, false).replace(/\"true\"/g, true).replace(/\"on\"/g, true);
                    if ( /(\"null\")/i.test(bodyStr) )
                        bodyStr = bodyStr.replace(/\"null\"/ig, null);

                    obj = JSON.parse(bodyStr)
                }

                if ( obj && typeof(obj) != 'undefined' && obj.count() > 0 ) {
                    // still need this to allow compatibility with express & connect middlewares
                    request.body = request.put = merge(request.put, obj);
                }


                request.query   = undefined; // added on september 13 2016
                request.post    = undefined;
                request.delete  = undefined;
                request.get     = undefined;

                obj = null;
                break;


            case 'delete':
                if ( request.query.count() > 0 ) {
                    request.delete = request.query;

                }
                // else, matching route params against url context instead once, route is identified

                request.post    = undefined;
                request.put     = undefined;
                request.get     = undefined;
                break


        };

        loadBundleConfiguration(request, response, next, function onLoadBundleConfiguration (err, bundle, pathname, config, req, res, next) {
            if (!req.handled) {
                req.handled = true;
                if (err) {
                    throwError(response, 500, 'Internal server error\n' + err.stack, next);
                    return;
                } else {
                    handle(req, res, next, bundle, pathname, config)
                }
            } else {
                if (typeof(next) != 'undefined')
                    return next();
                else
                    return;
            }

            return;
        })
    }

    /**
     * Looks up the MIME type for a filename by its extension using the
     * bundle's core MIME configuration. Falls back to `'plain/text'` when
     * the extension is unknown.
     *
     * @inner
     * @private
     * @param {string} filename - File path or name with extension
     * @returns {string} MIME type string
     */
    var getContentTypeByFilename = function(filename) {
        try {
            var s       = filename.split(/\./);
            var ext     = s[s.length-1];
            var type    = null;
            var mime    = self.conf[self.appName][self.env].server.coreConfiguration.mime;

            if ( typeof(mime[ext]) != 'undefined' ) {
                type = mime[ext];
            } else {
                console.warn('[ '+filename+' ] extension: `'+s[2]+'` not supported by gina: `core/mime.types`. Pathname must be a directory. Replacing with `plain/text` ')
            }
            return type || 'plain/text';
        } catch (err) {
            console.error('Error while trying to getContentTypeByFilename('+ filename +') extention. Replacing with `plain/text` '+ err.stack);
            return 'plain/text'
        }

    }

    /**
     * Retrieves the current Config singleton and resolves which bundle owns
     * the request URL. Then calls `onBundleConfigLoaded` which invokes
     * `callback(err, bundle, pathname, config, req, res, next)`.
     *
     * @inner
     * @private
     * @param {object} req - Incoming request object
     * @param {object} res - Server response object
     * @param {function} next - Next middleware callback
     * @param {function} callback - `function(err, bundle, pathname, config, req, res, next)`
     */
    var loadBundleConfiguration = function(req, res, next, callback) {

        var config = new Config();
        config.setBundles(self.bundles);
        // for all loaded bundles
        var conf = config.getInstance();
        //for cacheless mode
        if ( typeof(conf) != 'undefined') {
            self.conf = conf;
        }

        var pathname    = req.url;
        var bundle      = self.appName; // by default

        // finding bundle
        if (self.isStandalone) {

        end:
            for (let b in conf) {
                if (self.bundles.indexOf(b) < 0) continue;
                if ( typeof(conf[b][self.env].content) != 'undefined' && typeof(conf[b][self.env].content.statics) != 'undefined' && conf[b][self.env].content.statics.count() > 0 ) {
                    for (let s in conf[b][self.env].content.statics) {
                        s = (s.substring(0,1) == '/') ? s.substring(1) : s;
                        if ( (new RegExp('^/'+s)).test(pathname) ) {
                            bundle = b;
                            break end
                        }
                    }
                } else {
                    // no statics ... use startingApp and leave it to handle()
                    self.isNotStatic = true
                    break
                }
            }
        }


        if ( /\/favicon\.ico/.test(pathname) && !hasViews(bundle)) {
            callback(false, bundle, pathname, config, req, res, next);
            return false
        }

        onBundleConfigLoaded(bundle, {
            err         : false,
            config      : config,
            pathname    : pathname,
            req         : req,
            res         : res,
            conf        : config,
            next        : next,
            callback    : callback
        });

        return;
    }

    /**
     * Invokes the routing `callback` once per request with the resolved bundle
     * and config. In cacheless mode this would also trigger a config refresh
     * (currently commented out).
     *
     * @inner
     * @private
     * @param {string} bundle - Resolved bundle name for this request
     * @param {object} options - Options bag from `loadBundleConfiguration`
     * @param {boolean|Error} options.err - Error state
     * @param {object} options.config - Config singleton
     * @param {string} options.pathname - Request URL pathname
     * @param {object} options.req - Incoming request object
     * @param {object} options.res - Server response object
     * @param {function} options.next - Next middleware callback
     * @param {function} options.callback - Final callback `function(err, bundle, pathname, config, req, res, next)`
     */
    var onBundleConfigLoaded = function(bundle, options) {
        var err             = options.err
            , isCacheless   = options.config.isCacheless()
            , pathname      = options.pathname
            , req           = options.req
            , res           = options.res
            , config        = options.conf
            , next          = options.next
            , callback      = options.callback
        ;

        //Reloading assets & files.
        // if (!isCacheless) { // all but dev & debug
            callback(err, bundle, pathname, options.config, req, res, next)
        // } else {
        //     config.refresh(bundle, function(err, routing) {
        //         if (err) {
        //             throwError(res, 500, 'Internal server error: \n' + (err.stack||err), next)
        //             return;
        //         } else {
        //             refreshing routing at the same time.
        //            self.routing = routing;
        //             callback(err, bundle, pathname, options.config, req, res, next)
        //        }
        //     })
        // }
    }

    /**
     * Iterates through the Express-compatible middleware stack attached to
     * `instance._expressMiddlewares`, calling each in sequence and routing
     * to either `router.route` or `handleStatics` when the chain is exhausted.
     * Provides Express middleware portability for non-Express engines.
     *
     * @inner
     * @private
     * @param {Error|boolean} err - Error from the previous middleware, or false
     */
    var nextMiddleware = function(err) {

        var router              = local.router;
        var expressMiddlewares  = self.instance._expressMiddlewares;

        if (err) {
            return throwError(nextMiddleware._response, 500, (err.stack|err.message|err), nextMiddleware._next, nextMiddleware._nextAction);
        }

        expressMiddlewares[nextMiddleware._index](nextMiddleware._request, nextMiddleware._response, function onNextMiddleware(err, request, response) {

            if (err) {
                return throwError(nextMiddleware._response, 500, (err.stack||err.message||err), nextMiddleware._next, nextMiddleware._nextAction);
            }

            ++nextMiddleware._index;
            if (request) {
                nextMiddleware._request  = request;
            }

            if (response) {
                nextMiddleware._response = response;
            }

            if (nextMiddleware._index > nextMiddleware._count) {

                if ( nextMiddleware._nextAction == 'route' ) {
                    router._server = self.instance;
                    router.route(nextMiddleware._request, nextMiddleware._response, nextMiddleware._next, nextMiddleware._request.routing);
                } else { // handle statics
                    self._responseHeaders = nextMiddleware._response.getHeaders();
                    handleStatics(nextMiddleware._staticProps, nextMiddleware._request, nextMiddleware._response, nextMiddleware._next);
                }
            } else {
                nextMiddleware.call(this, err, true)
            }
        });
    };

    /**
     * Detects CORS preflight (OPTIONS) requests by inspecting the method,
     * `Access-Control-Request-Method` header, and configured allowed-origin
     * lists. Sets `request.isPreflightRequest` accordingly.
     *
     * @inner
     * @private
     * @param {object} request - Incoming request object (mutated with `isPreflightRequest`)
     * @param {object} response - Server response object
     * @returns {object} The (mutated) request object
     */
    var checkPreflightRequest = function(request, response) {
        var config = self.conf[self.appName][self.env];
        // by default, if not set in `${projectPath}/env.json`
        var corsMethod = 'GET, POST, HEAD';
        // See https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS
        if (
            typeof(config.server.response.header['access-control-allow-methods']) != 'undefined'
            &&
            config.server.response.header['access-control-allow-methods'] != ''
        ) {
            // as defined in `${projectPath}/env.json`
            corsMethod = config.server.response.header['access-control-allow-methods'];
        }

        var method                          = ( /http\/2/.test(config.server.protocol) ) ? request.headers[':method'] : request.method
            //, reMethod                      = new RegExp(method, 'i')
            , reAccessAllowMethod           = new RegExp('(' + corsMethod.replace(/\,\s+|\s+\,|\,/g, '|') +')', 'i')
            // preflight support - conditions required
            , isPreflightRequest            = (
                    // must meet all the following conditions
                    /OPTIONS/i.test(method)
                    && typeof(request.headers['access-control-request-method']) != 'undefined'

                    // as defined in `${projectPath}/env.json`,
                    // request method must match: config.server.response.header['access-control-allow-methods']
                    && reAccessAllowMethod.test(request.headers['access-control-request-method'])
                    && typeof(request.headers['access-control-request-headers']) != 'undefined'
                ) ? true : false
            , accessControlRequestHeaders   = null
            , serverResponseHeaders         = config.server.response.header//config.envConf[self.appName][self.env].server.response.header
        ;

        // additional checks
        // /(application\/x\-www\-form\-urlencoded|multipart\/form\-data|text\/plain)/i.test(request.headers['accept'])

        request.isPreflightRequest  = isPreflightRequest;
        if (isPreflightRequest) { // update request/response
            method                      = request.headers['access-control-request-method'];
            // updating to avoid conflict with requested route
            if ( /http\/2/.test(config.server.protocol) ) {
                request.headers[':method'] = method;
            } else {
                request.method = method
            }
            accessControlRequestHeaders = ( typeof(request.headers['access-control-request-headers']) != 'undefined' ) ? request.headers['access-control-request-headers'].replace(/\s+/, '').split(/\,/g) : '';
            if ( typeof(request.headers['access-control-request-credentials']) != 'undefined' && typeof(serverResponseHeaders['access-control-allow-credentials']) != 'undefined' ) {
                request.isWithCredentials = true;
            }
            if (accessControlRequestHeaders.length > 0) {
                for (var h in accessControlRequestHeaders) {
                    if ( /x\-requested\-with/i.test(h) && /x\-requested\-with/i.test(serverResponseHeaders['access-control-allow-headers']) ) {
                        request.isXMLRequest = true;
                    }
                }
                response.setHeader('access-control-allow-headers', request.headers['access-control-request-headers']);
            }
        }

        return request
    }

    var handle = async function(req, res, next, bundle, pathname, config) {

        var matched             = false
            , isRoute           = null
            , withViews         = hasViews(bundle)
            , router            = local.router
            , isCacheless       = config.isCacheless()
            , wroot             = null
        ;

        //matched = routingLib.getRouteByUrl(req.url, bundle, (req.method||req[':method']), req);

        req = checkPreflightRequest(req, res);
        var params      = {}
            , _routing  = {}
            , method    = ( /http\/2/.test(self.conf[self.appName][self.env].server.protocol) ) ? req.headers[':method'] : req.method
            , reMethod  = new RegExp(method, 'i')
        ;
        try {


            var routing   = config.getRouting(bundle, self.env);

            if ( routing == null || routing.count() == 0 ) {
                console.error('Malformed routing or Null value for bundle [' + bundle + '] => ' + req.url);
                throwError(res, 500, 'Internal server error\nMalformed routing or Null value for bundle [' + bundle + '] => ' + req.url, next);
                return;
            }

        } catch (err) {
            throwError(res, 500, err.stack, next);
            return;
        }
        var isMethodAllowed = null, hostname = null;

        // Checking cached route
        var hasCachedRoute = await routingLib.getCached(req.method +':'+ pathname, req) || null;
        if ( hasCachedRoute ) {
            // Supposed to have everything we need to route
            isRoute = hasCachedRoute;
            // req = isRoute.request;
        } else {
            isRoute = {}
        }

        out:
            for (let name in routing) {
                // Ignore cached route
                if ( hasCachedRoute ) {
                    matched = true;
                    break;
                }

                // Ignoring routes out of scope
                if ( routing[name].scopes.indexOf(process.env.NODE_SCOPE) < 0 ) {
                    continue;
                }

                if ( typeof(routing[name]['param']) == 'undefined' ) {
                    break;
                }

                // Updating hostname
                // if (
                //     typeof(routing[name].hostname) == 'undefined' && !/^redirect$/.test(routing[name].param.control)
                //     || !routing[name].hostname && !/^redirect$/.test(routing[name].param.control)
                // ) {
                //     hostname = self.conf[routing[name].bundle][self.env].hostname;
                //     routing[name].hostname = self.conf.routing[name].hostname = hostname;
                // }

                // For debug only
                // if ( name == 'name-of-targeted-rule@bundle') {
                //     console.debug('checking: ', name);
                // }

                if (routing[name].bundle != bundle) continue;
                // Method filter
                method = routing[name].method;
                if ( /\,/.test( method ) && reMethod.test(method) ) {
                    method = req.method
                }

                // Preparing params to relay to the router.
                params = {
                    method              : method,
                    control             : routing[name].param.control,
                    requirements        : routing[name].requirements,
                    namespace           : routing[name].namespace || undefined,
                    url                 : decodeURI(pathname), /// avoid %20
                    rule                : routing[name].originalRule || name,
                    cache               : routing[name].cache || null,
                    // We clone because we are going to modify it while comparing urls
                    param               : JSON.clone(routing[name].param),
                    // We clone because we are going to modify it while routing (.splice(..))
                    middleware          : JSON.clone(routing[name].middleware),
                    bundle              : routing[name].bundle,
                    isXMLRequest        : req.isXMLRequest,
                    isWithCredentials   : req.isWithCredentials
                };

                // Parsing for the right url.
                try {
                    isRoute = await routingLib.compareUrls(params, routing[name].url, req, res, next);
                } catch (err) {
                    var msg = 'Internal server error.\nRule [ '+name+' ] needs your attention.\n';
                    // TODO - Refactor `ApiError`to handle the following param
                    // var e = new ApiError({ message: msg, stack: err.stack});
                    // throwError(res, e)
                    throwError(res, 500, 'Internal server error.\nRule [ '+name+' ] needs your attention.\n'+ err.stack);
                    break;
                }

                if ( pathname == routing[name].url || isRoute.past ) {

                    _routing = req.routing;

                    // Comparing routing method VS request.url method
                    isMethodAllowed = reMethod.test(_routing.method);
                    if (!isMethodAllowed) {
                        // Exception - Method override
                        if ( /get/i.test(req.method) && /delete/i.test(_routing.method) ) {
                            console.debug('ignoring case request.method[GET] on routing.method[DELETE]');
                            req.method = _routing.method;
                            isMethodAllowed = true;
                        } else {
                            throwError(res, 405, 'Method Not Allowed.\n'+ ' `'+req.url+'` is expecting `' + _routing.method.toUpperCase() +'` method but got `'+ req.method.toUpperCase() +'` instead');
                            break;
                        }
                    }

                    // Handling GET method exception - if no param found
                    var methods = ['get', 'delete'], method = req.method.toLowerCase();
                    var p = null;
                    if (
                        methods.indexOf(method) > -1 && typeof(req.query) != 'undefined' && req.query.count() == 0
                        || methods.indexOf(method) > -1 && typeof(req.query) == 'undefined' && typeof(req.params) != 'undefined' && req.params.count() > 1
                    ) {
                        //req.params = parseObject(req.params);
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req[method][parameter] = req.params[parameter]
                            }
                            ++p
                        }

                    } else if ( method == 'put' ) { // merging req.params with req.put (passed through URI)
                        p = 0;
                        for (let parameter in req.params) {
                            if (p > 0) {
                                // false & true case
                                if ( /^(false|true|on)$/.test( req.params[parameter] ) && typeof(req.params[parameter]) == 'string' )
                                    req.params[parameter] = ( /^(true|on)$/.test( req.params[parameter] ) ) ? true : false;

                                req[method][parameter] = req.params[parameter]
                            }
                            ++p
                        }
                    }


                    // onRouting Event ???
                    if (isRoute.past) {
                        matched = true;
                        // Caching route
                        routingLib.cache(req.method +':'+ pathname, name, routing[name], params, req[method]);
                        isRoute = {};

                        break;
                    }
                }
            } // EO for (let name in routing) {



        if (matched) {
            if ( /^isaac/.test(self.engine) && self.instance._expressMiddlewares.length > 0) {
                nextMiddleware._index        = 0;
                nextMiddleware._count        = self.instance._expressMiddlewares.length-1;
                nextMiddleware._request      = req;
                nextMiddleware._response     = res;
                nextMiddleware._next         = next;
                nextMiddleware._nextAction   = 'route'

                return nextMiddleware()
            }

            router._server = self.instance;

            return router.route(req, res, next, req.routing);
        }

        return throwError(res, 404, 'Page not found: \n' + pathname, next);
    }




    /**
     * Sends an HTTP error response. Renders an HTML error page when the
     * bundle has views and the request is not an XHR, or a JSON error body
     * for XHR/API requests. Also exposed on the server engine instance.
     *
     * @inner
     * @private
     * @param {object} res - Server response object
     * @param {number} code - HTTP status code (e.g. 404, 500)
     * @param {string|object} msg - Error message string or error object
     * @param {function} next - Next middleware callback
     */
    var throwError = function(res, code, msg, next) {

        var withViews       = local.hasViews[self.appName] || hasViews(self.appName);
        var isUsingTemplate = self.conf[self.appName][self.env].template;
        var isXMLRequest    = local.request.isXMLRequest;
        var protocol        = getResponseProtocol(res);
        var stream          = ( /http\/2/.test(protocol) && res.stream ) ? res.stream : null;
        var header          = ( /http\/2/.test(protocol) && res.stream ) ? {} : null;
        var err             = null;
        var bundleConf      = self.conf[self.appName][self.env];

        if ( typeof(msg) != 'object' ) {
            err = {
                code    : code,
                message : msg
            }
        } else {
            err = JSON.clone(msg);
        }

        if (!res.headersSent) {
            // res.headersSent = true;
            local.request = checkPreflightRequest(local.request, local.response);
            // updated filter on controller.js : 2020/09/25
            //if (isXMLRequest || !withViews || !isUsingTemplate ) {
            if (isXMLRequest || !withViews || !isUsingTemplate || withViews && !isUsingTemplate ) {
                // allowing this.throwError(err)
                if ( typeof(code) == 'object' && !msg && typeof(code.status) != 'undefined' && typeof(code.error) != 'undefined' ) {
                    msg     = code.error;
                    code    = code.status;
                }

                // Internet Explorer override
                if ( /msie/i.test(local.request.headers['user-agent']) ) {
                    if ( /http\/2/.test(protocol) && stream ) {
                        header = {
                            ':status': code,
                            'content-type': 'text/plain; charset='+ bundleConf.encoding
                            //'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                        };
                    } else {
                        res.writeHead(code, 'content-type', 'text/plain; charset='+ bundleConf.encoding)
                    }

                } else {
                    if ( /http\/2/.test(protocol) && stream ) {
                        header = {
                            ':status': code,
                            'content-type': 'application/json; charset='+ bundleConf.encoding
                        };
                    } else {
                        res.writeHead(code, { 'content-type': 'application/json; charset='+ bundleConf.encoding } )
                    }
                }

                console.error('[ BUNDLE ][ '+self.appName+' ] '+ local.request.method +' [ '+code+' ] '+ local.request.url);

                header = completeHeaders(header, local.request, res);
                if ( /http\/2/.test(protocol) && stream) {
                    stream.respond(header);
                    stream.end(JSON.stringify({
                        status: code,
                        error: msg
                    }));

                } else {
                    res.end(JSON.stringify({
                        status  : code,
                        error   : msg
                    }));
                }
                return;

            } else {

                //console.error('[ BUNDLE ][ '+self.appName+' ] '+ local.request.method +' [ '+code+' ] '+ local.request.url);
                // console.error(local.request.method +' [ '+code+' ] '+ local.request.url);
                console.error('[ BUNDLE ][ '+self.appName+' ] '+ local.request.method +' [ '+code+' ] \n'+ msg);
                // intercept none HTML mime types
                var url                     = decodeURI(local.request.url) /// avoid %20
                    , ext                   = null
                    , isHtmlContent         = false
                    , hasCustomErrorFile    = false
                    , eCode                 = code.toString().substring(0,1) + 'xx'
                ;
                var extArr = url.substring(url.lastIndexOf('.')).match(/(\.[A-Za-z0-9]+)/);
                if (extArr) {
                    ext = extArr[0].substring(1);
                }
                if ( !ext || /^(html|htm)$/i.test(ext) ) {
                    isHtmlContent = true;
                }

                if (
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined'
                    ||
                    isHtmlContent
                    && typeof(bundleConf.content.templates._common.errorFiles) != 'undefined'
                    && typeof(bundleConf.content.templates._common.errorFiles[eCode]) != 'undefined'
                ) {
                    hasCustomErrorFile = true;

                    var eFilename   = null
                        , eData     = {
                            isRenderingCustomError  : true,
                            bundle                  : self.appName,
                            status                  : code || null,
                            message                 : msg || null,
                            pathname                : url
                        }
                    ;

                    if ( typeof(err) == 'object' && err.count() > 0 ) {
                        if ( typeof(err.stack)  != 'undefined' ) {
                            eData.stack = err.stack
                        }
                        if ( !eData.message && typeof(err.message) != 'undefined' ) {
                            eData.message = err.message
                        }
                    }
                    if (
                        code
                        // See: framework/${version}/core/status.code
                        && typeof(bundleConf.server.coreConfiguration.statusCodes[code]) != 'undefined'
                    ) {
                        eData.title = bundleConf.server.coreConfiguration.statusCodes[code];
                    }

                    if ( typeof(local.request.routing) != 'undefined' ) {
                        eData.routing = local.request.routing;
                    }

                    if (typeof(bundleConf.content.templates._common.errorFiles[code]) != 'undefined') {
                        eFilename = bundleConf.content.templates._common.errorFiles[code];
                    } else {
                        eFilename = bundleConf.content.templates._common.errorFiles[eCode];
                    }

                    var eRule = 'custom-error-page@'+ self.appName;
                    var routeObj = routingLib.getRoute(eRule);
                    routeObj.rule = eRule;
                    routeObj.url = url;
                    routeObj.param.title = ( typeof(eData.title) != 'undefined' ) ? eData.title : 'Error ' + eData.status;
                    routeObj.param.file = eFilename;
                    routeObj.param.error = eData;
                    routeObj.param.displayToolbar = self.isCacheless();

                    local.request.routing = routeObj;

                    var hasMiddlewareException = null;
                    for (let i=0, len = __stack.length; i<len; i++) {
                        let c = __stack[i].getFunctionName() || null;
                        if ( /processMiddlewares/.test(c) ) {
                            hasMiddlewareException = true;
                            break;
                        }
                    }
                    if ( !hasMiddlewareException ) {
                        var router = local.router;
                        if ( typeof(router._server) == 'undefined' ) {
                            router._server = self.instance;
                        }
                        router.route(local.request, res, next, local.request.routing);

                        return;
                    }
                    hasMiddlewareException = null;
                    // TODO - Instead of setting `hasCustomErrorFile` to false, compile custom error page with:
                    // JSON.stringify({
                    //     status  : code,
                    //     error   : msg
                    // })
                    hasCustomErrorFile = false;
                }

                if ( /http\/2/.test(protocol) && stream ) {
                    header = {
                        ':status'       : code,
                        'content-type'  : bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding
                    };
                } else {
                    res.writeHead(code, { 'content-type': bundleConf.server.coreConfiguration.mime[ext]+'; charset='+ bundleConf.encoding });
                }

                header = completeHeaders(header, local.request, res);
                if ( /http\/2/.test(protocol) && stream ) {
                    // TODO - Check if the stream has not been closed before sending response
                    // if (stream && !stream.destroyed) {
                    stream.respond(header);
                    if ( isHtmlContent && !hasCustomErrorFile ) {
                        stream.end('<html><body><pre><h1>Error '+ code +'.</h1><pre>'+ msg + '</pre></body></html>');
                    } else {
                        stream.end(JSON.stringify({
                            status  : code,
                            error   : msg
                        }));
                    }

                    // }
                } else {
                    if ( isHtmlContent && !hasCustomErrorFile ) {
                        res.end('<html><body><pre><h1>Error '+ code +'.</h1><pre>'+ msg + '</pre></body><html>');
                    } else {
                        res.end(JSON.stringify({
                            status  : code,
                            error   : msg
                        }))
                    }
                }
                return;
            }

        } else {
            if ( typeof(next) != 'undefined' )
                next();
            return;
        }
    }
};

Server = inherits(Server, EventEmitter);
module.exports = Server