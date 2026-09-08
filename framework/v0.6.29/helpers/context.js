/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
var fs              = require('fs');
var os              = require('os');
const {execSync}    = require('child_process');
//var merge   = require('./../lib/merge');
//var console = require('./../lib/logger');

/**
 * ContextHelper
 *
 * Singleton helper that manages the global context registry (paths, env vars,
 * user-defined key/value pairs). Injected globally as `getContext`/`setContext`
 * by `gna.js` — do not require this file directly.
 *
 * @class
 * @constructor
 * @this {ContextHelper}
 *
 * @param {object} [contexts]        - Initial context map; defaults to `{ paths: {} }`
 * @param {object} [contexts.paths]  - Named path registry
 *
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 *
 * @see gna.js
 */
function ContextHelper(contexts) {

    var merge   = require('./../lib/merge');
    var console = require('./../lib/logger');

    var self = {};


    /**
     * ContextHelper Constructor
     * */
    var init = function(contexts) {

        if ( typeof(contexts) == 'undefined' ) {
            contexts = {
                paths : {}
            }
        }

        self.contexts = contexts;

        if ( typeof(ContextHelper.initialized) != 'undefined' && ContextHelper.instance) {
            self = ContextHelper.instance;
        } else {
            // Get system environment variable
            self.contexts['sysEnvVars'] = { '~/': getUserHome() +'/' };
            var sysEnvVars = null;
            try {
                sysEnvVars = execSync('which printenv').toString().trim();
                sysEnvVars = sysEnvVars.replace(/\n$/, '').split(/\n/g);
                var len = sysEnvVars.length, i = 0;
                while ( Array.isArray(sysEnvVars) && i < len ) {
                    let arr = sysEnvVars[i].split(/\=/);
                    self.contexts['sysEnvVars']['$'+arr[0]] = arr[1];
                    i++
                }
                sysEnvVars = null;
            } catch (err) {
                return throwError(500, err, true)
            }


            ContextHelper.initialized = true;
            ContextHelper.instance = self
        }



        return self
    }

    var getUserHome = function() {
        var home = os.homedir ? os.homedir : function() {
            var homeDir = process.env[(isWin32()) ? 'USERPROFILE' : 'HOME'];

            if ( !homeDir || homeDir == '' ) {
                throw new Error('Home directory not defined or not found !');
            }

            if ( !isWritableSync(homeDir) ) {
                throw new Error('Home directory found but not writable: need permissions for `'+ homeDir +'`');
            }

            return homeDir;
        };

        return home()
    };

    self.configure = function(contexts) {
        joinContext(contexts)
    }

    joinContext = function(context) {
        // merge(self.contexts, context, true)
        self.contexts = merge(self.contexts, context, true)
    }

    var parseCtxObject = function (o, obj) {

        for (var i in o) {
            if (o[i] !== null && typeof(o[i]) == 'object') {
                parseCtxObject(o[i], obj);
            } else if (o[i] == '_content_'){
                o[i] = obj
            }
        }

        return o
    }

    setContext = function(name, obj, force) {
        // redefinition needed for none-dev env: cache issue
        var merge = require('./../lib/merge');

        if (arguments.length > 1) {
            //console.log("Globla setter active ", name, obj);
            if ( typeof(name) == 'undefined' || name == '' ) {
                name = 'global'
            }

            if (/\./.test(name) ) {
                var keys        = name.split(/\./g)
                    , newObj    = {}
                    , str       = '{'
                    , _count    = 0;

                for (var k = 0, len = keys.length; k<len; ++k) {
                    str +=  "\""+ keys.splice(0,1)[0] + "\":{";

                    ++_count;
                    if (k == len-1) {
                        str = str.substring(0, str.length-1);
                        str += "\"_content_\"";
                        for (var c = 0; c<_count; ++c) {
                            str += "}"
                        }
                    }
                }

                newObj = parseCtxObject(JSON.parse(str), obj);
                if (force) {
                    var key = name.split(/\./g);
                    self.contexts = merge(self.contexts, newObj, true);
                } else {
                    self.contexts =  merge(self.contexts, newObj)
                }

            } else {
                if (!self.contexts[name])
                    self.contexts[name] = {};

                if ( typeof(self.contexts[name]) != 'undefined' && !force) {
                    self.contexts[name] = obj
                } else {
                    self.contexts[name] = merge(self.contexts[name], obj, force)
                }
            }

        } else {
            //console.debug("setting context ", arguments[0]);
            self.contexts = arguments[0]
        }

        ContextHelper.instance = self;
    }

    getContext = function(name) {

        if ( typeof(name) != 'undefined' ) {
            try {
                //return clone(self.contexts[name])
                return self.contexts[name]
            } catch (err) {
                return undefined
            }
        } else {
            return self.contexts
        }
    }

    /**
     * resetContext
     *
     * Mostly used by logger container definitions orout of context threads (workers ?)
     *
     * TODO - Check if it can be called in `gna.js` & remove at the same time useless calls of setPath() & setContext()
     */
    resetContext = function() {
        setPath('gina.root', getEnvVar('GINA_DIR'));
        var frameworkPath = getEnvVar('GINA_FRAMEWORK_DIR');
        setPath('framework', frameworkPath);
        setPath('gina.core', getEnvVar('GINA_CORE'));
        setPath('gina.home', getEnvVar('GINA_HOMEDIR'));
        setPath('gina.lib', _(frameworkPath +'/lib'));
        setPath('gina.helpers', _(frameworkPath +'/helpers'));
        setPath( 'node', _(process.argv[0]), true);
        var projects    = require( _(getEnvVar('GINA_HOMEDIR') + '/projects.json', true) );
        var projectName = getContext('projectName');
        var root        = projects[projectName].path;
        setPath('project', root);
        var env         = getContext('env');
        var isDev       = (env === projects[projectName]['dev_env']) ? true: false;
        var bundlesPath = projects[projectName]['path'] + '/bundles'; // by default
        var isProductionScope = (projects[projectName]['production_scope'] === projects[projectName]['def_scope']) ? true: false;
        if (isDev) {
            bundlesPath = projects[projectName]['path'] + '/src'
        } else if (isProductionScope) {
            bundlesPath = projects[projectName]['path'] + '/releases'
        }
        setPath('bundles', _(bundlesPath, true));
        var bundle = getContext('bundle');
        var bundlePath = getPath('project') + '/';

        var modulesPackage = _(root + '/manifest.json');
        var project     = {}
            , bundles   = []
        ;

        if ( fs.existsSync(modulesPackage) ) {
            try {
                var dep = require(modulesPackage);
                if ( typeof(dep['bundles']) == "undefined") {
                    dep['bundles'] = {};
                }

                if (
                    typeof(dep['bundles']) != "undefined"
                    && typeof(project['bundles']) != "undefined"
                ) {

                    for (let d in dep) {
                        if (d == 'bundles') {
                            for (var p in dep[d]) {
                                project['bundles'][p] = dep['bundles'][p];
                            }
                        } else {
                            project[d] = dep[d];
                        }

                    }
                } else {
                    project = dep;
                }

                for (let b in project.bundles) {
                    bundles.push(b)
                }
            } catch (err) {
                throw err
            }
        }

        bundlePath += ( isDev ) ? project.bundles[ bundle ].src : project.bundles[ bundle ].link;
        setPath('bundle', _(bundlePath, true));
        setPath('helpers', _(bundlePath+'/helpers', true));
        setPath('lib', _(bundlePath+'/lib', true));
        setPath('models', _(bundlePath+'/models', true));
        setPath('controllers', _(bundlePath+'/controllers', true));

        setContext('envs', projects[projectName].envs);
        setContext('bundles', bundles);
        // setContext('gina.lib', lib);
        // setContext('gina.Config', Config);
        // setContext('gina.locales', locales);
        // setContext('gina.plugins', plugins);
    }


    var throwError = function(code, err, isFatal) {

        if (arguments.length < 2) {
            err     = code;
            code    = 500
        }

        var router  = getContext('router')
            , res   = ( router ) ? router.response : null
            , next  = ( router ) ? router.next : null
        ;

        // Live HTTP request we can still write an error response to.
        if ( res && !res.headersSent ) {
            var hasViews          = router.hasViews
                , isUsingTemplate = isUsingTemplate // pre-existing: resolves to `undefined` -> JSON branch
            ;

            if ( !hasViews || !isUsingTemplate ) {
                res.writeHead(code, { 'Content-Type': 'application/json'} );
                res.end(JSON.stringify({
                    status: code,
                    error: 'Error '+ code +'. '+ err.stack
                }))
            } else {
                res.writeHead(code, { 'Content-Type': 'text/html'} );
                res.end('<h1>Error '+ code +'.</h1><pre>'+ err.stack + '</pre>')
            }
            return;
        }

        // Live request whose response was already flushed: hand back to the
        // middleware chain (only when `next` is genuinely callable).
        if ( res && res.headersSent && typeof next == 'function' ) {
            next();
            return;
        }

        // No live request to respond to. The per-request `router` context
        // (core/router.js) is stored globally and never cleared, so a detached
        // caller (cron / timer / worker / bootstrap-time getLib) can observe a
        // stale routerObj whose `next` is no longer callable. Surface the error
        // instead of crashing on a dead response / `next`.
        if ( isFatal && /^true$/.test(isFatal) ) {
            console.emerg(err.stack||err.message||err);
            return;
        }

        throw err
    }

    /**
     * resolveBundlesConf
     *
     * Resolve the per-bundle/per-env configuration container. `bundlesConfiguration.conf`
     * is an alias of `envConf` (core/config.js builds it via `getInstance()` — see
     * `config.js` where `bundlesConfiguration.conf = self.getInstance()`); during a
     * module-load-time / daemon-spawned bootstrap the async Config build can populate
     * `envConf` BEFORE `bundlesConfiguration`, so the config resolvers (`getConfig`,
     * `getLib`) must accept either. Shared by both so the two siblings cannot drift.
     *
     * @inner
     * @private
     * @param {object} conf - A Config instance (or a `getInstance()` result)
     * @returns {object|null} The `[bundle][env]` config container (=== envConf), or null
     * */
    var resolveBundlesConf = function(conf) {
        if ( conf && conf.bundlesConfiguration && conf.bundlesConfiguration.conf ) {
            return conf.bundlesConfiguration.conf;
        }
        if ( conf && conf.envConf ) {
            return conf.envConf;
        }
        return null;
    };

    /**
     * getConfig
     *
     * Get bundle JSON configuration
     *
     *
     * @param {string} [ bundle ] - Bundle name
     * @param {string} confName  - Config name (bundle/config/filename without extension)
     *
     * */
    getConfig = function(bundle, confName) {
        // R2: test mock override — set via setContext('__mock__', { config: fn })
        // Checked directly on self.contexts to avoid any recursion through getContext.
        var _mock = self.contexts['__mock__'];
        if (_mock && typeof _mock.config === 'function') {
            return _mock.config(bundle, confName);
        }

        var merge = require('./../lib/merge');
        var ctx             = null
            , ctxFilename   = getContext('argvFilename') // for workers ctx
            , confPath      = null
        ;

        if ( typeof(ctxFilename) != 'undefined'  ) {
            var ctxFileObj = new _(ctxFilename, true);
            if ( ctxFileObj.existsSync() ) {
                ctx = JSON.parse(fs.readFileSync(_(ctxFilename, true)));
                if (!ctx.gina) {
                    ctx.gina = {
                        Config : require('./../core/config')
                    };

                    ctx.gina.config = merge(ctx.config, ctx.gina.Config);
                }
                for (let name in ctx) {
                    setContext(name, ctx[name], false)
                }
            } else {
                ctx = self.contexts
            }

        } else {
            ctx = self.contexts
        }

        if (arguments.length == 1 || !bundle) {

            confName = (arguments.length == 1) ? bundle : confName;
            var file = null
                , stackFileName = null;

            for (let i = 1, len = 10; i < len; ++i) {
                stackFileName = __stack[i].getFileName();
                if (stackFileName && !/node_modules/.test(stackFileName)) {
                    file = stackFileName;
                    break;
                }
            }
            var a = file.replace('.js', '').split('/')
                , i = a.length - 1;

            if (bundle == confName) {
                bundle = ctx.bundle
            } else {

                if (ctx.bundles) {
                    for (; i >= 0; --i) {
                        index = ctx.bundles.indexOf(a[i]);
                        if (index > -1) {
                            ctx.bundle = bundle = ctx.bundles[index];

                            break
                        }
                    }
                } else if (ctx.bundle) {
                    bundle = ctx.bundle
                }

            }
        }

        var env                 = ctx.env || getEnvVar('GINA_ENV');
        var envIsDev            = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
        var scope               = ctx.scope || getEnvVar('GINA_SCOPE');
        var scopeIsLocal        = ( /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL) ) ? true : false;
        var scopeIsProduction   = ( /^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION) ) ? true : false;
        var Config              = ctx.gina.Config;
        var conf                = null;

        if (Config.instance && typeof(Config.instance.env) != 'undefined') {
            conf = Config.instance
        } else {
            conf = new Config({
                env                 : env,
                scope               : scope,
                scopeIsLocal        : scopeIsLocal,
                scopeIsProduction   : scopeIsProduction,
                projectName         : getContext('projectName'),
                executionPath       : getPath('project'),
                startingApp         : bundle,
                ginaPath            : getPath('gina').core
            }).getInstance(bundle);
        }


        if ( typeof(confName) != 'undefined') {

            try {
                // bundlesConfiguration may not be built yet at module-load time; fall
                // back to the equivalent envConf slice (resolveBundlesConf).
                return resolveBundlesConf(conf)[bundle][env].content[confName]
            } catch (err) {
                // Fail clean (isFatal -> emerg-log + return): a bootstrap / detached
                // caller must not be crashed by a bare throw escalating to uncaughtException.
                throwError(500, err, true)
            }

        } else {

            try {
                // bundlesConfiguration may not be built yet at module-load time; fall back
                // to the equivalent envConf container (resolveBundlesConf) — the same object
                // bundlesConfiguration.conf aliases when it IS built.
                var confConf = resolveBundlesConf(conf);
                confConf.bundle       = bundle;
                confConf.env          = env;
                confConf.scope        = scope;
                confConf.projectName  = getContext('projectName');
                confConf.bundles      = getContext('bundles');

                if ( typeof(ctxFilename) != 'undefined' ) {
                    //process.stdout.write('TYPEOF ' + typeof( conf.getRouting ) )
                    setContext('gina.config', conf, true);
                    //process.stdout.write('TYPEOF ' + typeof( getContext('gina').config.getRouting ) )
                }

                return confConf
            } catch (err) {
                // Fail clean (isFatal) — see the with-confName branch above.
                throwError(500, err, true)
            }
        }
    }

    /**
     * Get bundle library
     *
     * Resolves the bundle's `libPath` from the active Config and returns a new
     * instance of the requested library. Robust to a PARTIAL Config: a detached
     * or daemon-spawned caller (cron / timer / worker / bootstrap) can observe a
     * Config whose async build populated `envConf` but not yet
     * `bundlesConfiguration`; `libPath` is then resolved from the equivalent
     * `envConf[bundle][env]` slice. When no usable configuration is available in
     * the calling context, the error is surfaced (emerg-log) and `undefined` is
     * returned rather than thrown — the process is never crashed.
     *
     * @param {string} [ bundle ] - Bundle name (auto-resolved from the caller
     *   stack when omitted)
     * @param {string} lib  - Library name (module or file)
     * @returns {object|undefined} A new instance of the library, or `undefined`
     *   when the library or its configuration cannot be resolved.
     *
     * @example
     * // one-arg form (bundle auto-resolved from the caller stack)
     * var reporting = getLib('reporting');
     * reporting.run();
     *
     * @example
     * // explicit bundle + lib
     * var reporting = getLib('backoffice', 'reporting');
     *
     * */
    getLib = function(bundle, lib) {
        var ctx     = self.contexts;
        var libPath = null
        if (arguments.length == 1 || !bundle) {
            //console.debug(
            //    '\n[ 0 ] = '+ __stack[0].getFileName(),
            //    '\n[ 1 ] = '+ __stack[1].getFileName(),
            //    '\n[ 2 ] = '+ __stack[2].getFileName(),
            //    '\n[ 3 ] = '+ __stack[3].getFileName(),
            //    '\n[ 4 ] = '+ __stack[4].getFileName(),
            //    '\n[ 5 ] = '+ __stack[5].getFileName(),
            //    '\n[ 6 ] = '+ __stack[6].getFileName()
            //);
             lib    = (arguments.length == 1) ? bundle : lib;
             bundle = null;
             var file          = null
                , stackFileName = null
                //, file        = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()
            ;
            for (let i = 1, len = 10; i<len; ++i) {
                stackFileName = __stack[i].getFileName();
                if ( stackFileName && !/node_modules/.test(stackFileName) ) {
                    file = stackFileName;
                    break;
                }
            }
            var a           = file.replace('.js', '').split('/')
                , i         = a.length-1;

            if (bundle == lib) {
                bundle = ctx.bundle
            } else {

                if (ctx.bundles) {
                    for (; i >= 0; --i) {
                        index = ctx.bundles.indexOf(a[i]);
                        if ( index > -1 ) {
                            ctx.bundle = bundle = ctx.bundles[index];

                            break
                        }
                    }
                } else if (ctx.bundle) {
                    bundle = ctx.bundle
                }

            }
        }

        var env                 = process.env.NODE_ENV || GINA_ENV;
        var envIsDev            = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false;
        var scope               = process.env.NODE_SCOPE || GINA_SCOPE;
        var scopeIsLocal        = ( /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL) ) ? true : false;
        var scopeIsProduction   = ( /^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION) ) ? true : false;
        var Config              = ctx.gina.Config;

        var conf = new Config({
            env                 : env,
            scope               : scope,
            scopeIsLocal        : scopeIsLocal,
            scopeIsProduction   : scopeIsProduction,
            projectName         : getContext('projectName'),
            executionPath       : getPath('project'),
            startingApp         : bundle,
            ginaPath            : getPath('gina').core
        }).getInstance(bundle);

        if ( typeof(lib) != 'undefined' ) {

            try {

                if (!libPath) {
                    // bundlesConfiguration may not be built yet at module-load time;
                    // resolveBundlesConf falls back to the equivalent envConf container —
                    // the same per-bundle/env slice getConfig reads (and this lib's own
                    // getConfig() below).
                    var confConf = resolveBundlesConf(conf);
                    var bundleEnvConf = ( confConf && confConf[bundle] && confConf[bundle][env] )
                        ? confConf[bundle][env]
                        : null;

                    if ( bundleEnvConf && typeof(bundleEnvConf.libPath) != 'undefined' ) {
                        libPath = bundleEnvConf.libPath;
                    } else {
                        // No usable configuration in this context: surface the reason and
                        // fail clean (isFatal -> emerg-log + return), never a detached throw
                        // that escalates to uncaughtException -> proc.js SIGKILL.
                        throwError(500, new Error("getLib(`"+ lib +"`): unable to resolve `libPath` for bundle `"+ bundle +"` in env `"+ env +"` — bundle configuration is unavailable in this context"), true);
                        return undefined;
                    }
                }

                var libToLoad = _(libPath +'/'+ lib, true);

                if (envIsDev) delete require.cache[require.resolve(libToLoad)];

                // init with options
                try {
                    var LibClass = require(libToLoad);
                    /**
                     * getConfig
                     *
                     * @param {string} [name]
                     *
                     * @returns {object} bundleConfiguration - By default config from the bundle where the lib is located
                     * */
                    LibClass.prototype.getConfig = function (name) {
                        if ( typeof(name) != 'undefined' && typeof( conf.envConf[bundle][env].content[name] ) != 'undefined' ) {
                            return JSON.clone(conf.envConf[bundle][env].content[name])
                        }

                        return JSON.clone(conf.envConf[bundle][env])
                    };

                    return new LibClass ({
                        bundle              : bundle,
                        env                 : env,
                        cacheless           : envIsDev,
                        scope               : scope,
                        scopeIsLocal        : scopeIsLocal,
                        scopeIsProduction   : scopeIsProduction,
                        libPath             : libPath
                    })

                } catch(err) {
                    throwError(500, err, true)
                }

            } catch (err) {
                console.error(err.stack||err.message||err);
                // Fail clean (isFatal -> emerg-log + return): a detached / daemon-spawned
                // caller must not be crashed by a bare throw escalating to uncaughtException.
                throwError(500, err, true);
                return undefined
            }
        } else {
            //console.error( new Error("no `lib` found"));
            throwError(500, new Error("`lib` [ "+name+" ] not found"))
            return undefined
        }

    }


    /**
     * Whisper
     * Convert replace constant names dictionary by its value
     *
     * @param {object} dictionary
     * @param {object} replaceable
     *
     * @returns {object} revealed
     * */
    // whisper = function(dictionary, replaceable, rule) {
    //     if ( typeof(rule) != 'undefined') {
    //         return replaceable
    //             // inline rule
    //             .replace(rule, function(s, key) {
    //                 return dictionary[key] || s;
    //             })
    //             // generic rules
    //             // .replace(/\"\{(\w+)\}\"/g, function(s, key) {
    //             //     if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
    //             //         return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] :  s
    //             //     }
    //             //     return '"'+ (dictionary[key] || s) +'"';
    //             // })
    //             // .replace(/\{(\w+)\}/g, function(s, key) {
    //             //     return dictionary[key] || s;
    //             // })
    //     }

    //     if ( typeof(replaceable) == 'object' &&  !/\[native code\]/.test(replaceable.constructor) ||  typeof(replaceable) == 'function' ) { // /Object/.test(replaceable.constructor)
    //         for (let attr in replaceable) {
    //             if ( typeof(replaceable[attr]) != 'function') {
    //                 replaceable[attr] = (typeof(replaceable[attr]) != 'string' && typeof(replaceable[attr]) != 'object') ? JSON.stringify(replaceable[attr], null, 2) : replaceable[attr];
    //                 if (replaceable[attr] && typeof(replaceable[attr]) != 'object') {
    //                     replaceable[attr] = replaceable[attr]
    //                         .replace(/\"\{(\w+)\}\"/g, function(s, key) {
    //                             if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
    //                                 return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] : s
    //                             }
    //                             return '"'+ (dictionary[key] || s) +'"';
    //                         })
    //                         .replace(/\{(\w+)\}/g, function(s, key) {
    //                             return dictionary[key] || s;
    //                         })
    //                 }
    //             }
    //         }
    //         return replaceable
    //     }
    //     // mixing with classes
    //     replaceable = JSON.stringify(replaceable, null, 2);

    //     return JSON.parse(
    //         replaceable
    //             .replace(/\"\{(\w+)\}\"/g, function(s, key) {
    //                 if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
    //                     return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] : s
    //                 }
    //                 // When "{single}" and not "{sigle}/something"
    //                 if ( /^\"\{(\w+)\}\"$/i.test(s) && !dictionary[key]) {
    //                     //return ('"'+ dictionary[key] +'"' || s);
    //                     return '"'+ (dictionary[key] || s.replace(/\"/g, '')) +'"';
    //                 }

    //                 arguments[3] = arguments[3].replace(/\"\{(\w+)\}\"/g, ('"'+ (dictionary[key] || s) +'"'));
    //                 return '"'+ (dictionary[key] || s) +'"';
    //             })
    //             .replace(/\{(\w+)\}/g, function(s, key) {
    //                 arguments[3] = arguments[3].replace(/\{(\w+)\}/g, (dictionary[key] || s));
    //                 return dictionary[key] || s;
    //             })
    //             // Fixed on 2025-03-27
    //             // special case like: ~/.{projectName}
    //             .replace(/.*\{(\w+)\}.*/g, function(s, key) {
    //                 if (!dictionary[key]) {
    //                     return s;
    //                 }
    //                 s = whisper(dictionary, s);
    //                 return s;
    //             })
    //             // OS Environment Variables
    //             .replace(/\"\~\/\"|\"\$([_A-Z0-9]+)\"/g, function(s, key) {
    //                 if ( /^(true|false|null)$/i.test(self.contexts['sysEnvVars'][s]) ) {
    //                     return (/^(true|false|null)$/i.test(self.contexts['sysEnvVars'][s])) ? self.contexts['sysEnvVars'][s] : null
    //                 }
    //                 // When "$SINGLE" and not "$SINGLE/something"
    //                 if ( /^\"\$([_A-Z0-9]+)\"$/i.test(s) && !self.contexts['sysEnvVars'][s]) {
    //                     return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
    //                 }
    //                 if ( /^\"\~\/\"$/i.test(s) && !self.contexts['sysEnvVars'][s]) {
    //                     return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
    //                 }
    //                 return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
    //             })
    //             .replace(/\~\/|\$([_A-Z0-9]+)/g, function(s, key) {
    //                 return self.contexts['sysEnvVars'][s] || null;
    //             })
    //     );
    // }

    /**
     * Interpolates `${key}` tokens in `replaceable` using values from `dictionary`.
     *
     * Handles three passes:
     *  1. Quoted boolean/null shapes: `"${key}"` → unquoted literal when the value is a boolean or null.
     *  2. Bare tokens: `${key}` → string value.
     *  3. Embedded tokens inside a larger string (e.g. `~/.${projectName}`) via a manual
     *     replace to avoid infinite recursion on the regex engine.
     *
     * Unknown keys are left untouched silently — earlier revisions logged a
     * "Whisper Error" on every first-run CLI command when a default had not yet
     * been seeded (see #B12). Callers that need strict-mode behaviour must
     * validate their dictionaries before the call.
     *
     * @global
     * @function whisper
     * @param {Object} dictionary - Map of `key → replacement` values.
     * @param {Object|string} replaceable - Object or JSON-serialisable value containing `${key}` tokens.
     * @param {RegExp} [rule] - Optional custom replace rule; when provided, short-circuits the three-pass logic.
     * @returns {Object|string} The interpolated object or string. Unknown tokens are preserved verbatim.
     */
    global.whisper = function(dictionary, replaceable, rule) {
        // 1. Inline rule
        if (typeof(rule) != 'undefined') {
            return replaceable.replace(rule, function(s, key) {
                return dictionary[key] || s;
            });
        }

        // 2. Object handling
        if (typeof(replaceable) == 'object' && replaceable !== null && (!replaceable.constructor || !/\[native code\]/.test(replaceable.constructor))) {
            for (let attr in replaceable) {
                if (typeof(replaceable[attr]) != 'function') {
                    if (typeof(replaceable[attr]) != 'string' && typeof(replaceable[attr]) != 'object') {
                        replaceable[attr] = JSON.stringify(replaceable[attr], null, 2);
                    }
                    if (replaceable[attr] && typeof(replaceable[attr]) != 'object') {
                        replaceable[attr] = whisper(dictionary, replaceable[attr]);
                    }
                }
            }
            return replaceable;
        }

        // 3. Stringification & Global Replace
        let jsonString = JSON.stringify(replaceable, null, 2);
        if (!jsonString) return replaceable;

        let processed = jsonString
            // Requires ${variable} syntax (breaking change from 0.1.8 — {variable} no longer supported).
            .replace(/\"\$\{(\w+)\}\"/g, function(s, key) {
                if (dictionary[key] !== undefined && /^(true|false|null)$/i.test(String(dictionary[key]))) {
                    return dictionary[key];
                }
                return dictionary[key] !== undefined ? '"' + dictionary[key] + '"' : s;
            })
            .replace(/\$\{(\w+)\}/g, function(s, key) {
                return dictionary[key] || s;
            })
            /**
             * Handles complex cases like: ~/.${projectName}
             */
            .replace(/.*\$\{(\w+)\}.*/g, function(s, key) {
                if (dictionary[key] !== undefined) {
                    // Manual replace to avoid infinite recursion.
                    return s.replace(new RegExp('\\$\\{' + key + '\\}'), dictionary[key]);
                }
                // Key not in dictionary — leave the token in place silently.
                // Earlier branches already handled the common shapes; reaching here
                // means no seeded default exists yet. Emitting an error on every
                // first-run CLI command was noisy and misleading (see #B12).
                return s;
            })
            // OS Environment Variables
            .replace(/\"\~\/\"|\"\$([_A-Z0-9]+)\"/g, function(s, key) {
                // Safe access to external self.contexts
                const envs = (typeof self !== 'undefined' && self.contexts) ? self.contexts['sysEnvVars'] : process.env;
                const cleanKey = s.replace(/[\"\$]/g, '');
                const val = envs[cleanKey];

                if (val !== undefined) {
                    return /^(true|false|null)$/i.test(val) ? val : '"' + val + '"';
                }
                return s;
            })
            .replace(/\~\/|\$([_A-Z0-9]+)/g, function(s, key) {
                const envs = (typeof self !== 'undefined' && self.contexts) ? self.contexts['sysEnvVars'] : process.env;
                const cleanKey = s.replace('$', '');
                return envs[cleanKey] || s;
            });

        try {
            return JSON.parse(processed);
        } catch (e) {
            return processed;
        }
    };






    /**
     * Define constants
     *
     * @param {string} name
     * @param {string} value
     * */
    define = function(name, value){
        if ( name.indexOf('GINA_') < 0 && name.indexOf('USER_') < 0 ) {
            name = 'USER_' + name;
        }
        try {
            Object.defineProperty(global, name.toUpperCase(), {
                value       : value,
                writable    : false,
                enumerable  : true,
                configurable: false
            })
        } catch (err) {
            throw new Error('Cannot redefined constant [ '+ name.toUpperCase() +' ].')
        }
    }

    /**
     * Get defiend constants
     *
     * @returns {array} constants
     * */
    getDefined = function(){
        var a = [], n = null;
        for (n in global) {
            if (n.indexOf('GINA_') > -1 || n.indexOf('USER_') > -1) {
                a[n] = global[n]
            }
        }
        n = null;
        return a
    }

    isWin32 = function() {
        return (os.platform() == 'win32') ? true : false;
    }

    return init(contexts)
};

module.exports = ContextHelper;