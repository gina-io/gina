/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
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
 * @package     Gina.Lib.Helpers
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */
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
                sysEnvVars = execSync('printenv').toString();
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
                        str = str.substr(0, str.length-1);
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
        var router      = getContext('router');
        if (router) {
            var res                 = router.response
                , next              = router.next
                , hasViews          = router.hasViews
                , isUsingTemplate   = isUsingTemplate
            ;


            if (arguments.length < 2) {
                err = code;
                code = 500
            }

            if ( !hasViews || !isUsingTemplate ) {
                if (!res.headersSent) {
                    res.writeHead(code, { 'Content-Type': 'application/json'} );
                    res.end(JSON.stringify({
                        status: code,
                        error: 'Error '+ code +'. '+ err.stack
                    }))
                } else {
                    next()
                }

            } else {
                if (!res.headersSent) {
                    res.writeHead(code, { 'Content-Type': 'text/html'} );
                    res.end('<h1>Error '+ code +'.</h1><pre>'+ err.stack + '</pre>')
                } else {
                    next()
                }
            }
        } else {
            if (isFatal && /^true$/.test(isFatal) ) {
                console.emerg(err.stack||err.message||err);
                return;
            }
            throw err
        }
    }

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
        var merge = require('./../lib/merge');
        var ctx             = null
            , ctxFilename   = getContext('argvFilename') // for workers ctx
            , confPath      = null
        ;

        if ( typeof(ctxFilename) != 'undefined' ) {
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
                return conf.bundlesConfiguration.conf[bundle][env].content[confName]
            } catch (err) {
                throwError(500, err)
            }

        } else {

            try {
                conf.bundlesConfiguration.conf.bundle       = bundle;
                conf.bundlesConfiguration.conf.env          = env;
                conf.bundlesConfiguration.conf.scope        = scope;
                conf.bundlesConfiguration.conf.projectName  = getContext('projectName');
                conf.bundlesConfiguration.conf.bundles      = getContext('bundles');

                if ( typeof(ctxFilename) != 'undefined' ) {
                    //process.stdout.write('TYPEOF ' + typeof( conf.getRouting ) )
                    setContext('gina.config', conf, true);
                    //process.stdout.write('TYPEOF ' + typeof( getContext('gina').config.getRouting ) )
                }

                return conf.bundlesConfiguration.conf
            } catch (err) {
                throwError(500, err)
            }
        }
    }

    /**
     * Get bundle library
     *
     * TODO - cleanup
     *
     * @param {string} [ bundle ] - Bundle name
     * @param {string} lib  - Library name (module or file)
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

                if (!libPath)
                    libPath = conf.bundlesConfiguration.conf[bundle][env].libPath;

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
                throwError(500, err);
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
    whisper = function(dictionary, replaceable, rule) {
        if ( typeof(rule) != 'undefined') {
            return replaceable
                // inline rule
                .replace(rule, function(s, key) {
                    return dictionary[key] || s;
                })
                // generic rules
                // .replace(/\"\{(\w+)\}\"/g, function(s, key) {
                //     if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
                //         return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] :  s
                //     }
                //     return '"'+ (dictionary[key] || s) +'"';
                // })
                // .replace(/\{(\w+)\}/g, function(s, key) {
                //     return dictionary[key] || s;
                // })
        }

        if ( typeof(replaceable) == 'object' &&  !/\[native code\]/.test(replaceable.constructor) ||  typeof(replaceable) == 'function' ) { // /Object/.test(replaceable.constructor)
            for (let attr in replaceable) {
                if ( typeof(replaceable[attr]) != 'function') {
                    replaceable[attr] = (typeof(replaceable[attr]) != 'string' && typeof(replaceable[attr]) != 'object') ? JSON.stringify(replaceable[attr], null, 2) : replaceable[attr];
                    if (replaceable[attr] && typeof(replaceable[attr]) != 'object') {
                        replaceable[attr] = replaceable[attr]
                            .replace(/\"\{(\w+)\}\"/g, function(s, key) {
                                if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
                                    return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] : s
                                }
                                return '"'+ (dictionary[key] || s) +'"';
                            })
                            .replace(/\{(\w+)\}/g, function(s, key) {
                                return dictionary[key] || s;
                            })
                    }
                }
            }
            return replaceable
        }
        // mixing with classes
        replaceable = JSON.stringify(replaceable, null, 2);

        return JSON.parse(
            replaceable
                .replace(/\"\{(\w+)\}\"/g, function(s, key) {
                    if ( /^(true|false|null)$/i.test(dictionary[key]) ) {
                        return (/^(true|false|null)$/i.test(dictionary[key])) ? dictionary[key] : s
                    }
                    // When "{single}" and not "{sigle}/something"
                    if ( /^\"\{(\w+)\}\"$/i.test(s) && !dictionary[key]) {
                        //return ('"'+ dictionary[key] +'"' || s);
                        return '"'+ (dictionary[key] || s.replace(/\"/g, '')) +'"';
                    }
                    return '"'+ (dictionary[key] || s) +'"';
                })
                .replace(/\{(\w+)\}/g, function(s, key) {
                    return dictionary[key] || s;
                })
                // OS Environment Variables
                .replace(/\"\~\/\"|\"\$([_A-Z0-9]+)\"/g, function(s, key) {
                    if ( /^(true|false|null)$/i.test(self.contexts['sysEnvVars'][s]) ) {
                        return (/^(true|false|null)$/i.test(self.contexts['sysEnvVars'][s])) ? self.contexts['sysEnvVars'][s] : null
                    }
                    // When "$SINGLE" and not "$SINGLE/something"
                    if ( /^\"\$([_A-Z0-9]+)\"$/i.test(s) && !self.contexts['sysEnvVars'][s]) {
                        return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
                    }
                    if ( /^\"\~\/\"$/i.test(s) && !self.contexts['sysEnvVars'][s]) {
                        return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
                    }
                    return '"'+ (self.contexts['sysEnvVars'][s] || null) +'"';
                })
                .replace(/\~\/|\$([_A-Z0-9]+)/g, function(s, key) {
                    return self.contexts['sysEnvVars'][s] || null;
                })
        );
    }

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