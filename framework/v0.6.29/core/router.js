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
    // #DTO2 — the default-on request-payload validation pipe (plain-required in
    // lib/index.js, so this gen-0 binding IS the live module).
    , dtoPipe           = lib.dtoPipe
    // #COMPLY1 — the default-on route authorization gate (plain-required in
    // lib/index.js, so this gen-0 binding IS the live module).
    , authzGate         = lib.authzGate
    // #MS6 — the identified-caller quota gate (plain-required in lib/index.js,
    // so this gen-0 binding IS the live module).
    , rateLimit         = lib.rateLimit
    , idempotency       = lib.idempotency
    // #FIN3 — message-schema validation gate (application-supplied validators),
    // run inside the dispatch band ahead of the DTO pipe. Plain lib access like
    // its band siblings above: router-bound, load-once, registry state on
    // process.gina.
    , messageValidator  = lib.messageValidator
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
        var _hotReload = getContext('__hotReload');
        // #M6 — if watcher is running and core files have not changed, skip eviction
        if (_hotReload && !_hotReload.core) return;

        var corePath    = getPath('gina').core;

        // Super controller
        delete require.cache[require.resolve(_(corePath +'/controller/controller.js', true))];
        delete require.cache[require.resolve(_(corePath +'/controller/index.js', true))];
        // removed: direct pre-load of controller.js — index.js (in dev/cacheless mode) deletes and
        // re-requires controller.js internally, so pre-loading it here caused a double instantiation
        // (Domain constructor, swig init, etc.) on every request. Let index.js own the re-require.

        // #B18 — Use the return value of require() directly instead of
        // re-poisoning the cache slot with `require.cache[path] = require(path)`.
        // The latter assigns the exports OBJECT (no `.exports` key) into the slot
        // where Node expects a Module instance; downstream plain `require()`
        // calls then read `.exports` off a bare exports object and get
        // `undefined`. router.js was the last latent occurrence of this
        // antipattern after the `refreshCore()` fix (`add6655e`).
        SuperController = require(_(corePath +'/controller/index.js', true));

        if (_hotReload) _hotReload.core = false; // #M6 — clear flag after eviction

        pruneDeadModuleChildren();
        corePath = null;
    }

    /**
     * Prunes stale `Module` references from every cached module's `children`
     * array after the eviction cycle above. Each cache-miss `require()` pushes
     * the fresh `Module` onto the requiring module's `children` (Node only
     * dedupes on cache hits), so without pruning this long-lived router module
     * accumulates one dead controller `Module` per request, each pinning its
     * whole evaluated exports graph — the dev-mode per-request memory leak.
     *
     * Local copy of the sweep in `core/server.isaac.js` — the engine-agnostic
     * router cannot depend on an engine module, and the `lib` registry is
     * itself evicted per request. Keep both copies in sync.
     *
     * @inner
     * @returns {undefined}
     */
    var pruneDeadModuleChildren = function() {
        var cacheIds = Object.keys(require.cache);
        for (var i = 0, len = cacheIds.length; i < len; i++) {
            var cached = require.cache[cacheIds[i]];
            if (cached && cached.children && cached.children.length > 0) {
                cached.children = cached.children.filter(function onPruneFilter(child) {
                    return require.cache[child.id] === child;
                });
            }
        }
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

        // #B67 — lift the reverse-proxy host derivation to this engine-agnostic
        // point so BOTH engines (isaac + express) resolve a cross-bundle
        // getRoute('<route>@<bundle>').toUrl() to the PUBLIC host. server.isaac.js
        // already stashes the per-request slots + refreshes the worker-global
        // process.gina.PROXY_HOSTNAME (host-only, public), but that block is
        // isaac-only; an Express-engine request (or a slot-less isaac request)
        // reaches getRoute with getContext('isProxyHost')=true, PROXY_HOSTNAME
        // falsy, and envConf._proxyHostname = host+webroot -> getRoute falls back
        // (main.js:1105) to the host+webroot value -> the
        // <host>/<webroot>//<webroot> blend. Gated on THIS request's proxied
        // classification (port-less inbound Host, or an X-Forwarded-Host), NOT on
        // the sticky isProxyHost latch, so it can never freeze at a `host:port`
        // (raw) value (the #B65 freeze-guard). Host-only, public; scheme prefers
        // X-Forwarded-Proto (TLS-terminating proxy) then PROXY_SCHEME then the
        // bundle scheme.
        // #B367 — SECURITY: these header values are attacker-supplied and end up
        // spliced UNESCAPED into the client loader's JS string literals via
        // page.environment.hostname / .webroot / .proxyHost / .proxyHostname
        // (whisper() is a raw token replace — helpers/context.js:798-802), so a
        // single quote in one of them closes the literal and executes arbitrary
        // script on every rendered page, unauthenticated. Sanitise at ingest and
        // fall back to the bundle's internal configured values when a value is
        // malformed. Note `proxyReqHost` is the caller's own Host/:authority
        // header and is validated for the same reason.
        // Keep in sync with the core/server.isaac.js twin.
        var _isSafeHostToken = function(v) {
            return ( typeof(v) == 'string' && v.length > 0 && v.length <= 255
                     && /^[A-Za-z0-9._:\[\]-]+$/.test(v) );
        };
        var _rawProxyReqHost = request.headers.host || request.headers[':authority'];
        var proxyReqHost     = _isSafeHostToken(_rawProxyReqHost) ? _rawProxyReqHost : null;
        var _rawXfh          = request.headers['x-forwarded-host'];
        var _xfh             = _isSafeHostToken(_rawXfh) ? _rawXfh : null;
        var _rawXfProto      = request.headers['x-forwarded-proto'];
        var _safeXfProto     = ( _rawXfProto === 'http' || _rawXfProto === 'https' ) ? _rawXfProto : null;
        // #B152 — opt-in: server.proxy.requireForwardedHeaders (boot-resolved
        // to process.gina._proxyRequireForwarded by server.js) disables the
        // port-less-Host heuristic — only an explicit X-Forwarded-Host
        // classifies as proxied. Keep in sync with the server.isaac.js twin.
        // #B502 — on isaac, request._ginaIsProxyHost is already stamped from the
        // ORIGINAL Host/:authority (the #B65 block runs before isaac's h1 port
        // strip); the heuristic below re-classified every direct h1 request as
        // proxied from the port-stripped Host and rewrote the worker-globals from
        // it, so an existing isaac stamp decides here too. A slot-less engine
        // (Express) keeps the #B152 heuristic — its Host is never stripped.
        var proxyReqIsProxied = (
            ( typeof(request._ginaIsProxyHost) != 'undefined' )
                ? ( request._ginaIsProxyHost === true )
                : (
                    ( proxyReqHost && !/\:[0-9]+$/.test(proxyReqHost)
                        && process.gina._proxyRequireForwarded !== true )
                    || _xfh
                )
        ) ? true : false;
        if ( proxyReqIsProxied ) {
            var proxyReqScheme = _safeXfProto
                || process.gina.PROXY_SCHEME
                || conf.server.scheme;
            if ( _xfh ) {
                process.gina.PROXY_HOSTNAME = proxyReqScheme +'://'+ _xfh;
                process.gina.PROXY_HOST     = _xfh;
            } else {
                process.gina.PROXY_HOSTNAME = proxyReqScheme +'://'+ proxyReqHost;
                process.gina.PROXY_HOST     = proxyReqHost;
            }
        }

        // #B152 — engine-agnostic per-request proxy slots (fill-when-absent).
        // server.isaac.js (#B65 block) stashes request._ginaIsProxyHost /
        // _ginaProxyHost / _ginaProxyHostname on EVERY isaac request (incl.
        // `false`), but the Express engine never does — so slot readers (the
        // getUrl filters, the redirect/throwError toUrl re-points, the #B66 S2b
        // sites) silently fell back to the worker-global there. Fill only when
        // absent: isaac's earlier, identical classification always wins; Express
        // (and any slot-less engine) gets per-request truth here. Keep the
        // derivation in sync with server.isaac.js — deliberate twin, like
        // pruneDeadModuleChildren.
        if ( typeof(request._ginaIsProxyHost) == 'undefined' ) {
            request._ginaIsProxyHost = proxyReqIsProxied;
            if (proxyReqIsProxied) {
                // #B367 — sanitised tokens only (see the block above).
                var _slotScheme = _safeXfProto
                    || process.gina.PROXY_SCHEME
                    || conf.server.scheme;
                if ( _xfh ) {
                    request._ginaProxyHostname = _slotScheme +'://'+ _xfh;
                    request._ginaProxyHost     = _xfh;
                } else {
                    request._ginaProxyHostname = _slotScheme +'://'+ proxyReqHost;
                    request._ginaProxyHost     = proxyReqHost;
                }
            }
        }


        // #B502 — per-request proxy truth for the req-less readers. lib/routing
        // getRoute()/toUrl() has no request in scope and resolved its proxied
        // classification from getContext('isProxyHost') + process.gina.PROXY_HOSTNAME
        // alone — worker-globals shared by every request on the worker, and the
        // latch is monotonic once any port-less-Host request has written the
        // hostname — so a DIRECT request following one built its absolute URLs
        // from that other request's host (port lost on h1; the last port-less
        // client's host on h2). server.js handle() now runs the dispatch inside
        // process.gina._reqALS on every request; fill its proxy slot from THIS
        // request's stamps (isaac's, or the fill-when-absent block above) so the
        // resolution is per request, and only a req-less caller (boot, CLI, cron)
        // still falls back to the latch + worker-global.
        var _reqStore = ( process.gina._reqALS ) ? process.gina._reqALS.getStore() : null;
        if ( _reqStore ) {
            _reqStore.proxy = {
                isProxyHost   : ( request._ginaIsProxyHost === true ),
                proxyHostname : request._ginaProxyHostname || null,
                proxyHost     : request._ginaProxyHost || null
            };
        }

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
            /**
             * Login shim — authenticates the request AND, on the gina-native
             * branch, rotates the session id before binding the user
             * (session-fixation defense, #COMPLY4).
             *
             * Passport bundles never see this shim in normal operation
             * (passport.initialize() installs its own req.login first); the
             * Passport-flavored branch serves the HTTP2 case where
             * `request._passport` exists without the request extensions.
             *
             * @param {object}   user      - authenticated principal; bound at
             *                               `request.session.user` (what the authorization gate reads)
             * @param {object}   [options] - `{session: false}` binds `request.user` only
             *                               (transient — no session work, no rotation)
             * @param {function} done      - REQUIRED callback `done(err)` on the session paths;
             *                               fires after rotation + bind + persist complete
             */
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
                    // #COMPLY4 — gina-native branch. This path previously ended
                    // in a hard passport-required throw, so the framework's own
                    // session pattern (authz reads `req.session.user`) had no
                    // working login here. Now: rotate the session id BEFORE
                    // binding the user (session-fixation defense), bind at
                    // `session.user`, stamp the absolute-timeout anchor,
                    // persist, then report. Same degrade-gracefully shape as
                    // the #B164 logout shim below — typeof-gated, the session
                    // provider's capabilities decide.
                    if (typeof done != 'function') {
                        throw new Error('req#login requires a callback function');
                    }
                    var req = this;
                    if ( !req.session || typeof(req.session) != 'object' ) {
                        req[property] = null;
                        return done(new Error('req#login requires a session — register the Session plugin (or express-session) before routing'));
                    }
                    if ( typeof(req.session.regenerate) == 'function' ) {
                        req.session.regenerate(function onLoginSessionRegenerated(err) {
                            if (err) {
                                req[property] = null;
                                return done(err);
                            }
                            req.session.user = user;
                            // absolute-timeout anchor — the clock starts at login
                            req.session._ginaCreatedAt = Date.now();
                            if ( typeof(req.session.save) == 'function' ) {
                                return req.session.save(function onLoginSessionSaved(saveErr) {
                                    done(saveErr || null);
                                });
                            }
                            done(null);
                        });
                        return;
                    }
                    // no regenerate() on this session provider — bind without
                    // rotation, and say so: the fixation defense is unavailable
                    console.warn('[ ROUTER ] login(): session provider exposes no regenerate() — user bound WITHOUT session-id rotation');
                    req.session.user = user;
                    req.session._ginaCreatedAt = Date.now();
                    if ( typeof(req.session.save) == 'function' ) {
                        return req.session.save(function onLoginSessionSavedNoRotation(saveErr) {
                            done(saveErr || null);
                        });
                    }
                    return done(null);
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
            /**
             * Logout shim — de-authenticates the request AND destroys the
             * persisted session record.
             *
             * #B164 — nulling `session.user` alone left the store record, the
             * session id and every other session key alive until TTL. The
             * gina-native branch now also calls the session's own destroy()
             * when it exposes one (express-session), degrading gracefully when
             * it does not. Clearing the session COOKIE stays the consumer's
             * job — the cookie name is not discoverable from the request.
             *
             * @param {function} [done] - Optional callback `done(err)` invoked once
             *                            record destruction (or the fallback) completes.
             */
            request.logout =
            request.logOut = function(done) {
                var property = 'user';

                // by default
                var sess = this;
                if (sess._passport && sess._passport.instance) {
                    property = sess._passport.instance._userProperty || 'user';
                }
                var isSessionScope = false;
                if ( !sess._passport
                    && typeof(sess.session) != 'undefined'
                ) {
                    sess = sess.session;
                    isSessionScope = true;
                }

                sess[property] = null;
                if (sess._passport) {
                    sess._passport.instance._sm.logOut(sess);
                    if ( typeof(done) == 'function' ) {
                        done(null);
                    }
                    return;
                }
                // #B164 — destroy the record, not just the `user` key. Gated on the
                // session scope so a call after destruction (no `request.session`
                // left) can never reach `request.destroy()` — the stream method.
                if ( isSessionScope && typeof(sess.destroy) == 'function' ) {
                    sess.destroy(function onLogoutSessionDestroyed(err) {
                        if (err) {
                            console.warn('[ ROUTER ] logout(): session.destroy() failed: ' + (err.stack || err.message || err));
                        }
                        if ( typeof(done) == 'function' ) {
                            done(err || null);
                        }
                    });
                    return;
                }
                if ( typeof(done) == 'function' ) {
                    done(null);
                }
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

        // #FI — controller setup start (file loading + inherits + new + setOptions)
        var _setupStart = (request._devTimeline) ? Date.now() : 0;

        // #B422 defence in depth — `params.param.control` is the dispatch target; a
        // params object without it means routing state was corrupted upstream (a
        // matched-but-verdict-less route). Fail LOUD with a named 500: the bare
        // deref below used to throw inside the async chain — an unhandled rejection
        // that dropped the connection with no HTTP response and no trace.
        if ( !params || !params.param || typeof(params.param.control) == 'undefined' ) {
            serverInstance.throwError(response, 500, 'Routing state error: no `param.control` resolved for `'+ request.method +' '+ request.url +'`'+ ( (params && params.rule) ? ' (rule: `'+ params.rule +'`)' : '' ) +'.\nThe route was dispatched without a complete routing description.');
            return;
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

        // We want to keep original conf untouched.
        // #B52-residual: deep-cloning the WHOLE bundle conf on every matched request is a
        // multi-MB per-request allocation (templates / server config / app assets / fonts) that
        // accumulates under concurrency into a heap high-water-mark. Only conf.content.routing is
        // mutated through this clone (the [rule].param write below) — every other subtree is
        // read-only on the per-request path (setOptions reassigns conf.routing/reverseRouting/
        // forms/locales/locale wholesale, which the shallow top-level copy already isolates; and
        // plugins/connectors/model read config via their own getConfig clone or the global
        // singleton, never through this object). So shallow-copy the top level + conf.content and
        // deep-clone only conf.content.routing; the large immutable remainder is shared by
        // reference at no per-request heap cost.
        // options.conf = JSON.clone(conf); // pre-#B52-residual: whole-conf deep clone per request
        options.conf = Object.assign({}, conf);
        options.conf.content = Object.assign({}, conf.content);
        options.conf.content.routing = JSON.clone(conf.content.routing);
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
                var _hotReload = getContext('__hotReload');
                // #M6 — only evict when watcher not running (fallback) or a controller changed
                if (!_hotReload || _hotReload.action) {
                    if (hasControllerNamespace) {
                        delete require.cache[require.resolve(_(mainControllerFile, true))];
                    }
                    delete require.cache[require.resolve(_(controllerFile, true))];

                    if ( hasSetup )
                        delete require.cache[require.resolve(_(setupFile, true))];

                    if (_hotReload) _hotReload.action = false; // #M6 — clear flag after eviction
                }
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
            // #FI — controller setup end
            if (_setupStart && request._devTimeline) {
                var _setupEnd = Date.now();
                request._devTimeline.entries.push({
                    label: 'controller-setup', cat: 'controller',
                    startMs: _setupStart, endMs: _setupEnd,
                    durationMs: _setupEnd - _setupStart,
                    detail: (options.control || null)
                });
            }

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
                        delete require.cache[require.resolve(filename)];
                    //}

                    // #B18 — Same fix as the sibling at L116-127. require() returns
                    // a freshly built Module instance; assigning the exports object
                    // back into require.cache[path] poisons the slot.
                    var SuperController     = require(_(corePath +'/controller/index.js', true));


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


                            // #B399 — return the app setup's own result instead of the
                            // function object (the wrapper's return had zero consumers):
                            // an async `setup.js`'s promise was discarded right here, so
                            // the dispatch-loop guard could never own its rejection.
                            // was: Setup.apply(Setup, arguments);
                            //      return Setup;
                            return Setup.apply(Setup, arguments);
                        }(request, response, next)
                    }
                }

                if ( !self.hasCompletedControlllerSetup )
                    self.hasCompletedControlllerSetup = true;
            } else {
                controller.setup = function() { return };
            }



            // #FI — route middleware names for timeline detail
            var _routeMwNames = (request._devTimeline && middleware.length > 0)
                ? middleware.join(', ') : null;
            var _routeMwStart = (request._devTimeline) ? Date.now() : 0;

            if (middleware.length > 0) {
                processMiddlewares(serverInstance, middleware, controller, action, request, response, next,
                    function onDone(action, request, response, next){
                        // #FI — route middleware end + action start
                        if (_routeMwStart && request._devTimeline) {
                            request._devTimeline.entries.push({
                                label: 'route-middleware', cat: 'middleware',
                                startMs: _routeMwStart, endMs: Date.now(),
                                durationMs: Date.now() - _routeMwStart,
                                detail: _routeMwNames
                            });
                        }
                        if (request._devTimeline) {
                            request._devTimeline._actionStart = Date.now();
                        }

                        // #COMPLY1 — default-on route authorization. A strict NO-OP unless
                        // the route declares `param.requireAuth`. Placed BEFORE the DTO
                        // pipe so an unauthenticated caller gets a 401 and never learns
                        // whether its payload would have validated (a 422 field map is a
                        // disclosure). Route middleware has already drained here, so a
                        // bundle's own auth middleware keeps its semantics and this gate
                        // is purely additive after it.
                        if ( !authzGate.authorizeRequest(controller, request, response) ) {
                            return;
                        }

                        // #MS6 — identified-caller quota gate. AFTER authz (authorizeRequest
                        // is the principal resolver — the only writer of req.machineCaller,
                        // and session identity is its own predicate) and BEFORE the DTO pipe
                        // (a throttled caller must not receive a 422 field map — the same
                        // disclosure ordering that puts the 401 above the 422). The band
                        // below is wrapped so the armed path can defer it behind the store
                        // read; DORMANT (`enabled` not strictly true, exempt route, or no
                        // principal) mints ZERO promises — the wrapped band runs on today's
                        // exact synchronous path (the #B383 family: async-ness in a gate is
                        // a behaviour change, so it is confined to callers who armed it).
                        var _dispatchControllerAction = function() {
                            // #FIN3 — application-supplied message-schema validation.
                            // Dormant (no `param.messageValidator` on the route) the gate
                            // returns null and mints ZERO promises — the band below runs
                            // on today's exact synchronous path. Armed, it returns a
                            // promise owning every refusal terminal (400/422/503/500);
                            // the band continues only on an allow. Document-level
                            // validation runs BEFORE the DTO pipe's field rules, and the
                            // disclosure ordering above (401 -> 429 -> idempotency) is
                            // preserved by construction. The catch is the last-resort
                            // belt — the rate-limit / idempotency spine discipline.
                            var _msvGate = messageValidator.gate(request, response, controller);
                            if ( _msvGate ) {
                                _msvGate.then(function onMessageValidatorVerdict(proceed) {
                                    if (proceed) { _msvDispatchBand(); }
                                }).catch(function onMessageValidatorError(msvErr) {
                                    serverInstance.throwError(response, 500, (msvErr && msvErr.stack) || String(msvErr));
                                });
                                return;
                            }
                            _msvDispatchBand();
                        };
                        var _msvDispatchBand = function() {
                            // #DTO2 — default-on request-payload validation. A strict NO-OP
                            // unless the route declares `param.dto`. Placed BEFORE the
                            // reservedActions loop so a 422 short-circuits the whole controller
                            // invocation (`onReady` never runs for a rejected request). Route
                            // middleware has already drained here, so auth (401) still precedes
                            // validation (422).
                            if ( !dtoPipe.validateRequestPayload(controller, request, response) ) {
                                return;
                            }

                            // handle superController events
                            try {
                                // #B399 — the reserved-action hooks (`onReady`, `setup`) were dispatched
                                // BARE here, OUTSIDE the try, while the main action below owns its
                                // promise: an async hook rejection was unowned — no response, the
                                // request hung to client/proxy timeout, and the only trace was a
                                // levelled line in the daemon-dropped stdout — and a sync hook throw
                                // escaped to process level (isaac: uncaughtException → emerg + SIGTERM,
                                // the whole bundle dies; express: its layer-catch answers its own 500 —
                                // engine-asymmetric). Inside the try, a sync throw is this catch's 500;
                                // the thenable capture gives an async rejection the SAME .catch → 500
                                // the action carries. throwError is `!headersSent`-guarded, so a
                                // rejection landing after the action responded degrades to the #ERRREF
                                // pairing line. Sync/absent hooks mint ZERO promises (the band's
                                // dormancy rule).
                                for (let e=0; e<reservedActions.length; ++e) {
                                    if ( typeof(controller[reservedActions[e]]) == 'function' ) {
                                        let _hookResult = controller[reservedActions[e]](request, response, next);
                                        if ( _hookResult && typeof _hookResult.then === 'function' ) {
                                            _hookResult.catch(function(err) {
                                                serverInstance.throwError(response, 500, 'reserved action `'+ reservedActions[e] +'` rejected: '+ ( err && (err.stack || err.message) || String(err) ));
                                            });
                                        }
                                    }
                                }

                                var _result = controller[action](request, response, next);
                                if (_result && typeof _result.then === 'function') {
                                    _result.catch(function(err) {
                                        serverInstance.throwError(response, 500, err.stack || err.message || String(err));
                                    });
                                }
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
                        };
                        var _rlConf = serverInstance._rateLimit;
                        if ( _rlConf && _rlConf.enabled === true ) {
                            var _rlGate = rateLimit.gate(request, response, controller, _rlConf);
                            if ( _rlGate ) {
                                // Every terminal of this promise is owned: allow -> the band,
                                // deny/outage -> answered inside the gate; this catch is the
                                // last-resort belt (an unowned rejection in the dispatch spine
                                // is a hung request with no visible log line).
                                _rlGate.then(function onRateLimitVerdict(proceed) {
                                    if (proceed) { _idemThenDispatch(); }
                                }).catch(function onRateLimitError(rlErr) {
                                    serverInstance.throwError(response, 500, (rlErr && rlErr.stack) || String(rlErr));
                                });
                                return;
                            }
                        }
                        // #FIN6 — Idempotency-Key dedup, strictly after the
                        // rate-limit verdict (a throttled caller must never touch
                        // the reservation store) and before the band (DTO -> hooks
                        // -> action). Hoisted declaration: the rate-limit allow
                        // path above calls it before this line is reached textually.
                        function _idemThenDispatch() {
                            var _idemConf = serverInstance._idempotency;
                            if ( _idemConf && _idemConf.enabled === true ) {
                                var _idemGate = idempotency.gate(request, response, controller, _idemConf);
                                if ( _idemGate ) {
                                    // Owned terminals — the rate-limit spine discipline:
                                    // allow -> the band, answered (replay/409/422/400/503)
                                    // -> inside the gate; the catch is the last-resort belt.
                                    _idemGate.then(function onIdempotencyVerdict(proceed) {
                                        if (proceed) { _dispatchControllerAction(); }
                                    }).catch(function onIdempotencyError(idemErr) {
                                        serverInstance.throwError(response, 500, (idemErr && idemErr.stack) || String(idemErr));
                                    });
                                    return;
                                }
                            }
                            _dispatchControllerAction();
                        }
                        _idemThenDispatch();

                    });
            } else {
                // #FI — action start (no middleware path)
                if (request._devTimeline) {
                    request._devTimeline._actionStart = Date.now();
                }

                // #COMPLY1 — default-on route authorization (see the with-middleware site
                // above). A strict NO-OP unless the route declares `param.requireAuth`.
                if ( !authzGate.authorizeRequest(controller, request, response) ) {
                    return;
                }

                // #MS6 — identified-caller quota gate (see the with-middleware site
                // above for the full rationale: after authz, before the DTO pipe;
                // dormant mints ZERO promises and runs the band synchronously).
                var _dispatchControllerAction = function() {
                    // #FIN3 — application-supplied message-schema validation (see the
                    // with-middleware site above for the full rationale: dormant mints
                    // ZERO promises; armed owns every refusal terminal and runs
                    // document-level validation before the DTO pipe's field rules).
                    var _msvGate = messageValidator.gate(request, response, controller);
                    if ( _msvGate ) {
                        _msvGate.then(function onMessageValidatorVerdict(proceed) {
                            if (proceed) { _msvDispatchBand(); }
                        }).catch(function onMessageValidatorError(msvErr) {
                            serverInstance.throwError(response, 500, (msvErr && msvErr.stack) || String(msvErr));
                        });
                        return;
                    }
                    _msvDispatchBand();
                };
                var _msvDispatchBand = function() {
                    // #DTO2 — default-on request-payload validation (see the with-middleware
                    // site above). A strict NO-OP unless the route declares `param.dto`.
                    if ( !dtoPipe.validateRequestPayload(controller, request, response) ) {
                        return;
                    }

                    // handle superController events
                    // e.g.: inside your controller, you can defined: `this.onReady = function(){...}` which will always be called before the main action
                    try {
                        // #B399 — the reserved-action hooks (`onReady`, `setup`) were dispatched
                        // BARE here, OUTSIDE the try, while the main action below owns its
                        // promise: an async hook rejection was unowned — no response, the
                        // request hung to client/proxy timeout, and the only trace was a
                        // levelled line in the daemon-dropped stdout — and a sync hook throw
                        // escaped to process level (isaac: uncaughtException → emerg + SIGTERM,
                        // the whole bundle dies; express: its layer-catch answers its own 500 —
                        // engine-asymmetric). Inside the try, a sync throw is this catch's 500;
                        // the thenable capture gives an async rejection the SAME .catch → 500
                        // the action carries. throwError is `!headersSent`-guarded, so a
                        // rejection landing after the action responded degrades to the #ERRREF
                        // pairing line. Sync/absent hooks mint ZERO promises (the band's
                        // dormancy rule).
                        for (let e=0; e<reservedActions.length; ++e) {
                            if ( typeof(controller[reservedActions[e]]) == 'function' ) {
                                let _hookResult = controller[reservedActions[e]](request, response, next);
                                if ( _hookResult && typeof _hookResult.then === 'function' ) {
                                    _hookResult.catch(function(err) {
                                        serverInstance.throwError(response, 500, 'reserved action `'+ reservedActions[e] +'` rejected: '+ ( err && (err.stack || err.message) || String(err) ));
                                    });
                                }
                            }
                        }

                        var _result = controller[action](request, response, next);
                        if (_result && typeof _result.then === 'function') {
                            _result.catch(function(err) {
                                serverInstance.throwError(response, 500, err.stack || err.message || String(err));
                            });
                        }
                    } catch (err) {
                        if ( typeof(controller) != 'undefined' && typeof (controller[action]) == 'undefined') {
                            serverInstance.throwError(response, 500, (new Error('control not found: `' + action + '`. Please, check your routing.json or the related control in your `' + controllerFile + '`.')).stack);
                        } else {
                            serverInstance.throwError(response, 500, err.stack);
                        }
                        return;
                    }
                };
                var _rlConf = serverInstance._rateLimit;
                if ( _rlConf && _rlConf.enabled === true ) {
                    var _rlGate = rateLimit.gate(request, response, controller, _rlConf);
                    if ( _rlGate ) {
                        _rlGate.then(function onRateLimitVerdict(proceed) {
                            if (proceed) { _idemThenDispatch(); }
                        }).catch(function onRateLimitError(rlErr) {
                            serverInstance.throwError(response, 500, (rlErr && rlErr.stack) || String(rlErr));
                        });
                        return;
                    }
                }
                // #FIN6 — Idempotency-Key dedup, strictly after the rate-limit
                // verdict and before the band (see the with-middleware site above).
                function _idemThenDispatch() {
                    var _idemConf = serverInstance._idempotency;
                    if ( _idemConf && _idemConf.enabled === true ) {
                        var _idemGate = idempotency.gate(request, response, controller, _idemConf);
                        if ( _idemGate ) {
                            _idemGate.then(function onIdempotencyVerdict(proceed) {
                                if (proceed) { _dispatchControllerAction(); }
                            }).catch(function onIdempotencyError(idemErr) {
                                serverInstance.throwError(response, 500, (idemErr && idemErr.stack) || String(idemErr));
                            });
                            return;
                        }
                    }
                    _dispatchControllerAction();
                }
                _idemThenDispatch();
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