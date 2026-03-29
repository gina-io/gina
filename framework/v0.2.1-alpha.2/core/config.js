//"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
//Imports.
var fs              = require('fs');
var os              = require('os');
var dns             = require('dns');
var util            = require('util');
var Events          = require('events');
var EventEmitter    = require('events').EventEmitter;
var locales         = require('./locales');
var lib             = require('./../lib');
var Domain          = lib.Domain;
var domainLib       = new Domain();
var merge           = lib.merge;
var inherits        = lib.inherits;
var console         = lib.logger;
var Collection      = lib.Collection;
var modelUtil       = new lib.Model();


/**
 * @module gina/core/config
 */
/**
 * Loads, merges, and exposes the full project configuration for all registered
 * bundles, environments, and scopes. Acts as a singleton after first
 * initialisation (`Config.initialized`). Raises `'config#complete'` when all
 * bundle configs have been resolved.
 *
 * TODO - split Config.Env & Config.Host
 *
 * @class Config
 * @constructor
 * @param {object} opt - Configuration options
 * @param {string} opt.env - Active environment name (e.g. `'development'`)
 * @param {string} opt.scope - Active scope (e.g. `'local'`)
 * @param {string} opt.projectName - Name of the project being loaded
 * @param {string} opt.startingApp - Bundle name being started
 * @param {string} opt.ginaPath - Absolute path to the gina framework install
 * @param {string} opt.executionPath - Project root path
 * @param {boolean} [contextResetNeeded] - When `true`, resets the global context before init
 */
function Config(opt, contextResetNeeded) {

    var self = this;
    if (
        !Config.initialized
        && typeof(contextResetNeeded) != 'undefined'
        && /^true$/i.test(contextResetNeeded)
    ) {
        // requirements
        setContext('env', opt.env);
        setContext('scope', opt.scope);
        setContext('projectName', opt.projectName || getContext('projectName'));
        setContext('bundle', opt.startingApp);
        // reset context
        resetContext();
    }

    // framework settings from homedir
    var homedir = getEnvVar('GINA_HOMEDIR');
    var framework = {
        ports : _( homedir +'/ports.json', true),
        portsReverse : _( homedir +'/ports.reverse.json', true),
        project : _( homedir +'/projects.json', true)
    };

    this.bundles = [];
    this.allBundles = [];
    this.allEnvs    = getContext('envs');
    this.allScopes  = getContext('scopes');

    /**
     * Initialises the Config singleton: loads framework port/project files,
     * delegates to `Env.load` and `Host.setMaster`, then calls
     * `loadBundlesConfiguration` and emits `'config#complete'` on success.
     *
     * @inner
     * @private
     * @param {object} opt - Same options passed to the outer constructor
     * @param {boolean} [contextResetNeeded]
     */
    var init =  function(opt, contextResetNeeded) {


        if ( !Config.initialized) {
            var env     = opt.env;
            var scope   = opt.scope;

            self.projectName    = opt.projectName || getContext('projectName');

            self.startingApp    = opt.startingApp;
            self.executionPath  = opt.executionPath; // project path

            self.task = opt.task || 'run'; // to be aible to filter later on non run task

            self.userConf = false;
            var pathObj = new _(self.executionPath + '/env.json', true);
            var path    = pathObj.toString();

            if ( pathObj.existsSync() ) {
                self.userConf = requireJSON(path);
                console.debug('Application config file loaded [' + path + ']');
            }
            path    = null;
            pathObj = null;

            self.Env.parent = self;
            if (env != 'undefined') self.Env.set(env);

            self.Scope.parent = self;
            if (scope != 'undefined') self.Scope.set(scope);

            self.Host.parent = self;

            //Do some checking please.. like already has a PID ?.
            //if yes, join in case of standalone.. or create a new thread.
            self.Host.setMaster(opt.startingApp);


            getConf(env, scope);
        } else {
            if (!opt) {
                return Config.instance
            } else {
                return self.getInstance(opt.startingApp)
            }
        }
    }


    /**
     * Loads framework port, reverse-port, and project JSON files, then calls
     * `Env.load` to build the merged envConf object.
     *
     * @inner
     * @private
     * @param {string} env - Environment name
     * @param {string} scope - Scope name
     */
    var getConf = function(env, scope) {

        self.env    = env;
        self.scope  = scope;
        console.debug('[CONFIG][getConf] Loading conf...');

        // framework settings
        var filename = null, content = null;

        for (let file in framework) {

            filename = framework[file];

            if ( self.isCacheless() ) {
                delete require.cache[require.resolve(filename)];
            }

            if (file == 'project') {
                content = require(filename)[self.projectName] // get only related project infos
            } else {
                content = require(filename);
            }

            setContext('gina.'+ file, content)
        }


        self.Env.load( function(err, envConf) {

            if ( typeof(self.Env.loaded) == 'undefined') {
                // Need to globalize some of them.
                self.envConf = envConf;

                // getting server core config
                var statusCodes     = null
                    , mime          = null
                    , encoding      = null
                ;

                try {
                    var corePath = getPath('gina').core;
                    //statusCodes = fs.readFileSync( _( corePath + '/status.codes') ).toString();
                    //statusCodes = JSON.parse(statusCodes);
                    statusCodes = requireJSON( _( corePath + '/status.codes') );
                    if ( typeof(statusCodes['_comment']) != 'undefined' )
                        delete statusCodes['_comment'];

                    mime  = fs.readFileSync(corePath + '/mime.types').toString();
                    mime  = JSON.parse(mime);
                    if ( typeof(mime['_comment']) != 'undefined' )
                        delete mime['_comment'];

                    encoding  = fs.readFileSync(corePath + '/content.encoding').toString();
                    encoding  = JSON.parse(encoding);
                    if ( typeof(encoding['_comment']) != 'undefined' )
                        delete encoding['_comment'];

                    self.envConf.core = {
                        statusCodes : statusCodes,
                        mime        : mime,
                        locales     : locales,
                        encoding    : encoding
                    };

                } catch(err) {
                    console.error(err.stack||err.message);
                    process.exit(1)
                }

                loadBundlesConfiguration( function(err, file, routing) {

                    if (err) {
                        console.error(err.stack||err.message);
                        setTimeout(() => {
                            process.exit(1);
                        }, 0);
                        return;
                    }

                    if ( typeof(Config.initialized) == 'undefined' ) {
                        Config.initialized  = true;
                        self.isStandalone   = self.Host.isStandalone();
                        self.bundle         = self.startingApp;
                        Config.instance     = self
                    }


                    //logger.debug('gina', 'CONFIG:DEBUG:42', 'CONF LOADED 43', __stack);
                    self.bundlesConfiguration = {
                        env             : self.Env.get(),
                        scope           : self.Scope.get(),
                        version         : self.version,
                        conf            : self.getInstance(),
                        bundles         : self.getBundles(),
                        allBundles      : self.getAllBundles(),
                        isStandalone    : self.Host.isStandalone()
                    };

                    //console.error("found bundles ", self.bundlesConfiguration.bundles);

                    //TODO - Don't override if syntax is ok - no mixed paths.
                    //Set paths for lib. Override for now.
                    //To reset it, just delete the hidden folder.
                    var ginaPath    = opt.ginaPath
                        , libConfig = new lib.Config()
                    ;

                    libConfig.set('gina', 'locals.json', {
                        project : libConfig.getProjectName(),
                        paths : {
                            project : self.projectName,
                            gina    : ginaPath,
                            lib     : libConfig.__dirname,
                            root    : opt.executionPath,
                            env     : opt.executionPath + '/env.json',
                            tmp     : opt.executionPath + '/tmp'
                        },
                        //TODO - Replace property by bundle.
                        bundles : self.bundlesConfiguration.allBundles
                        //envs :
                    }, function(err) {
                        self.Env.loaded = true;
                        if (err != null && err != false)
                            console.error('Error found while settings up locals' + err);

                        self.emit('config#complete', err, self.bundlesConfiguration)
                    })

                }, self.startingApp);//by default.
            }
        });
    }


    /**
     * Returns the active Config instance or, when `bundle` is given, the
     * per-bundle/per-env configuration slice. Merges `gina.config` from
     * the global context if the singleton has not been fully set yet.
     *
     * @memberof module:gina/core/config
     * @param {string} [bundle] - Bundle name; omit to return the full envConf
     * @returns {object|undefined} Config instance, envConf slice, or undefined
     */
    this.getInstance = function(bundle) {

        if ( typeof(Config.instance) == 'undefined' && typeof(getContext('gina')) != 'undefined' ) {
            Config.instance = merge( self, getContext('gina').config, true );
            self.envConf = Config.instance.envConf
        }

        var configuration = Config.instance.envConf;

        var env = self.env || Config.instance.env;
        var scope = self.scope || Config.instance.scope;

        Config.instance.Env.parent = Config.instance;

        if (env != 'undefined')
            Config.instance.Env.set(Config.instance.env);

        if (scope != 'undefined')
            Config.instance.Scope.set(Config.instance.scope);

        Config.instance.Host.parent = Config.instance;

        //Do some checking please.. like already has a PID ?.
        //if yes, join in case of standalone.. or create a new thread.
        Config.instance.Host.setMaster(bundle);

        self = Config.instance;

        if ( typeof(bundle) != 'undefined' && typeof(configuration) != 'undefined' ) {
            try {
                //return configuration[bundle][env];
                return Config.instance || configuration[bundle][env];
            } catch (err) {
                //logger.error('gina', 'CONFIG:ERR:1', err, __stack);
                console.error(err.stack||err.message);
                return undefined
            }
        } else if ( typeof(configuration) != 'undefined' ) {
            return configuration
        } else {
            return undefined
        }
    }

    /**
     * Stores the server core configuration (status codes, MIME types, etc.)
     * for a specific bundle/env combination.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name
     * @param {string} env - Environment name
     * @param {string} scope - Scope name
     * @param {object} conf - Core server configuration object
     */
    this.setServerCoreConf = function(bundle, env, scope, conf) {
        self.env    = env;
        self.scope  = scope;
        self.envConf[bundle][env].server['coreConfiguration'] = conf;
    }

    /**
     * Retrieves the server core configuration for a bundle/env combination.
     * Calls `process.exit(1)` on read failure.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name
     * @param {string} env - Environment name
     * @returns {object} Core server configuration object
     */
    this.getServerCoreConf = function(bundle, env) {
        try {
            return self.envConf[bundle][env].server['coreConfiguration']
        } catch(err) {
            console.debug('Could not get server core configuration for <'+ bundle +'>:<'+ env +'>');
            console.error(err.stack||err.message);
            process.exit(1);
        }
    }

    /**
     * Environment sub-object.
     * Manages the active environment name and loads the merged env configuration
     * via `loadWithTemplate`.
     *
     * @memberof module:gina/core/config
     * @type {object}
     */
    this.Env = {
        template : requireJSON( getEnvVar('GINA_FRAMEWORK_DIR') +'/core/template/conf/env.json'),
        load : function(callback) {
            loadWithTemplate(this.parent.userConf, this.template, function(err, envConf) {
                self.envConf            = envConf;
                envConf.env             = self.env;
                envConf.scope           = self.scope;
                envConf.isStandalone    = self.isStandalone;

                callback(false, envConf);
            });
        },

        set : function(env) {
            this.current = env || process.env.NODE_ENV || this.template.defEnv;
        },

        /**
         * Get active env
         * @returns {String} env
         **/
        get : function() {
            return this.current
        },

        /**
         * Get env config
         *
         * @param {string} bundle
         * @param {string} env
         *
         * @returns {Object} json conf
         **/
        getConf : function(bundle, env) {

            if ( !self.isStandalone ) {
                if ( !bundle && typeof(self.bundle) != 'undefined' ) {
                    bundle = self.bundle
                }


                return ( typeof(self.envConf) != 'undefined' ) ? self.envConf[bundle][env]  : null;

            } else {

                if (!bundle) { // if getContext().bundle is lost .. eg.: worker context
                    var model       = (arguments.length == 1) ? bundle : model
                        , file      = ( !/node_modules/.test(__stack[1].getFileName()) ) ?  __stack[1].getFileName() : __stack[2].getFileName()
                        , a         = file.replace('.js', '').split('/')
                        , i         = a.length-1
                        , bundles   = getContext('gina').config.bundles
                        , index     = 0
                    ;

                    for (; i >= 0; --i) {
                        index = bundles.indexOf(a[i]);
                        if ( index > -1 ) {
                            bundle = bundles[index];
                            break
                        }
                    }
                }


                if ( typeof(self.envConf) != 'undefined' ) {

                    var protocol    = self.envConf[self.startingApp][env].content.settings.server.protocol || self.envConf[self.startingApp][env].server.protocol;
                    var scheme      = self.envConf[self.startingApp][env].content.settings.server.scheme || self.envConf[self.startingApp][env].server.scheme;

                    var hostname    = scheme + '://' + self.envConf[self.startingApp][env].host + ':' + self.envConf[self.startingApp][env].server.port;
                    // var isProxyHost = getContext('isProxyHost');

                    self.envConf[self.startingApp][env].hostname = hostname;

                    self.envConf[bundle][env].hostname = self.envConf[self.startingApp][env].hostname;
                    self.envConf[bundle][env].content.routing = self.envConf[self.startingApp][env].content.routing;

                    if ( bundle && env ) {
                        return self.envConf[bundle][env]
                    } else if ( bundle && !env ) {
                        return self.envConf[bundle]
                    } else {
                        return self.envConf
                    }
                }

                return null
            }
        },
        getDefault : function() {
            return {
                "env"               : this.template.defEnv,
                "scope"             : this.template.defScope,
                "ext"               : this.template.defExt,
                "registeredEnvs"    : this.template.registeredEnvs
            }
        }
    }
    /**
     * @class Env Sub class
     *
     *
     * @package     Gina.Config
     * @namespace   Gina.Config.Env
     * @author      Rhinostone <contact@gina.io>
     */
    this.Scope = {
        template : requireJSON( getEnvVar('GINA_FRAMEWORK_DIR') +'/core/template/conf/env.json'),
        set : function(scope) {
            this.current = scope || process.env.NODE_SCOPE || this.template.defScope;
        },

        /**
         * Get active scope
         * @returns {String} scope
         **/
        get : function() {
            return this.current
        }
    }

    /**
     * Host Class
     *
     * @package    Gina.Config
     * @author     Rhinostone <contact@gina.io>
     */
    this.Host = {
        //By default.
        standaloneMode : self.isStandalone || true,
        /**
         * Set Master instance
         * @param {String} appName Application name
         * @returns {Object} instance Instance of the master node
         * */
        setMaster : function(appName) {
            if(typeof(this.master) == "undefined" && this.master !== "") {
                this.master = appName
            }
        },
        /**
         * Get Master instance
         * @returns {Object} instance Instance of the master node
         * */
        getMaster : function() {
            return this.master
        },
        isStandalone : function() {
            return this.standaloneMode
        }
    }

    /**
     * Recursively merges `content` into `confObject` at the dotted path
     * described by `section` (e.g. `'server.options'`).
     *
     * @inner
     * @private
     * @param {object} confObject - Target configuration object to merge into
     * @param {string|string[]} section - Dot-separated path string or pre-split array
     * @param {*} content - Value to merge at the target path
     * @param {number} [i=0] - Current recursion depth (internal)
     */
    var mergeConfig = function(confObject, section, content, i) {

        if (!Array.isArray(section)) {
            if (section != '') {
                section = section.split(/\./g);
            } else {
                section = []
            }
        }

        if ( typeof(i) == 'undefined' ) {
            i = 0
        }

        if (!section.length) { // nothing to do here
            confObject = merge(content, confObject);
            return
        }
        // done
        if (i == section.length) {
            return
        }

        if ( typeof(confObject[ section[i] ]) == 'undefined' ) {
            confObject[ section[i] ] = {};
        }

        if (i == section.length-1) {
            confObject[ section[i] ] =  merge(content, confObject[ section[i] ])
        }

        mergeConfig(confObject[ section[i] ], section, content, i+1)

    }

    //  TODO - replace `bundle`@`project` in `server.response.header['access-control-allow-origin']`
    // This will allow replacement of variables before the bundle is loaded, saving some time while routing
    // var getAllProjects = function(env) {
    //     var projectConfigPath        = _(GINA_HOMEDIR + '/projects.json', true)
    //         , projectsList      = []
    //         , projects          = requireJSON(projectConfigPath)
    //         , p                 = 0
    //         , bundlesInfosPath  = _(GINA_HOMEDIR + '/ports.reverse.json', true)
    //         , bundlesInfos      = requireJSON(bundlesInfosPath)
    //     ;
    //     for (let project in projects) {
    //         projectsList[p] = {
    //             name    : project,
    //             bundles : {}
    //         }
    //         let b = 0;
    //         for (let location in bundlesInfos) {
    //             if ( new RegExp('/@'+ project +'$/').test(location) ) {
    //                 let bundle = location.split('@')[0];
    //                 projectsList[p].bundles[bundle] = {}
    //                 b++;
    //             }
    //         }

    //         p++;
    //     }
    // }

    /**
     * Merges the user's project config (`userConf`) against the framework's
     * `env.json` template, resolving port assignments, bundle paths, model
     * paths, and hostname substitutions for every bundle/env/scope combination.
     * Calls `callback(false, mergedConf)` on success.
     *
     * @inner
     * @private
     * @param {object} userConf - Raw parsed project config object
     * @param {object} template - Framework env template (from `core/template/conf/env.json`)
     * @param {function} callback - `function(err, mergedConf)`
     */
    var loadWithTemplate = function(userConf, template, callback) {

        var content     = userConf,
            //if nothing to merge.
            newContent = JSON.parse( JSON.stringify(content) )
        ;

        var isStandalone    = true,
            masterPort      = null,
            appPort         = null,
            // env             = self.Env.get(),
            env             = (typeof(process.env.NODE_ENV) != 'undefined' ) ? process.env.NODE_ENV: self.Env.get(),
            envIsDev        = ( /^true$/i.test(process.env.NODE_ENV_IS_DEV) ) ? true : false,
            // scope           = self.Scope.get(),
            scope           = (typeof(process.env.NODE_SCOPE) != 'undefined' ) ? process.env.NODE_SCOPE: self.Scope.get(),
            scopeIsLocal    = ( /^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL) ) ? true : false,
            appsPath        = '',
            modelsPath      = '',
            projectPath     = '',
            ctx             = getContext('gina'),
            projectConf     = ctx.project,
            portsReverse    = ctx.portsReverse
        ;
        console.debug('[CONFIG] Reading env: '+ env);
        console.debug('[CONFIG] Reading scope: '+ scope);

        if (!self.projectName) {
            self.projectName = ctx.config.projectName
        }

        // Pushing default app first.
        self.bundles.push(self.startingApp);//This is a JSON.push.
        var root        = new _(self.executionPath).toUnixStyle()
            , manifest  = null
            , pkg       = null
        ;
        try {
            manifest = requireJSON(_(root + '/manifest.json', true));
            pkg = manifest.bundles;
            // by default but may be overriden
            masterPort = portsReverse[self.startingApp+'@'+self.projectName][env][projectConf.def_protocol][projectConf.def_scheme]
        } catch (err) {
            console.error(err.stack);

            return callback(err);
        }


        // For each app.
        var isCacheless         = self.isCacheless()
            , bundleSettings    = null
            , bundHasSettings   = true
            , bundlesPath       = getPath('bundles') // symlink handled
            , protocol          = null
            , scheme            = null
            , p                 = null
        ;

        // Getting bundle config files
        var configFiles     = null
            , appPath       = null
            , jsonFile      = null
            , e             = null
            , tmpSettings   = null
            , filesList     = {}
            , files         = {}
        ;


        var version = null, middleware = null;
        try {
            self.version    = version = require(_(getPath('gina').root +'/package.json' )).version;
            // #B10 fix: moved before MIDDLEWARE read so ${version} substitution always works
            // even in environments where the MIDDLEWARE file is absent (e.g. containers).
            setContext('gina.version', version);

            self.middleware = middleware = fs.readFileSync(_( getEnvVar('GINA_FRAMEWORK_DIR') + '/MIDDLEWARE')).toString() || 'none';
            setContext('gina.middleware', middleware);

        } catch (err) {
            console.debug(err.stack)
        }

        for (let app in content) {
            //Checking if genuine app.
            console.debug('[CONFIG] Checking if application [ '+ app +' ] is registered ');
            if ( typeof(pkg[app]) == 'undefined' ) {
                console.debug('[CONFIG] Skipping app [ '+ app +' ]; not registered ...');
                continue;
            }

            appPath = _(root +'/'+ pkg[app].link, true);
            console.debug('[CONFIG] Checking appPath [ '+ appPath +' ] ');
            // cleanup symlinks
            let targetAppPathObj = new _(appPath, true);
            if ( targetAppPathObj.existsSync() ) {
                targetAppPathObj.rmSync()
            }
            try {
                if (envIsDev) {
                    targetAppPathObj = new _(root +'/'+ pkg[app].src, true);
                    console.debug('[CONFIG][env:'+env+'][envIsDev:'+ envIsDev +'] Linking ['+ targetAppPathObj.toString() +'] to [ '+ appPath +' ] ');
                    targetAppPathObj.symlinkSync(appPath);
                } else {
                    targetAppPathObj = new _(root +'/'+ pkg[app].releases[scope][env].target, true);
                    console.debug('[CONFIG][env'+env+'][envIsDev:'+ envIsDev +'] Linking ['+ targetAppPathObj.toString() +'] to [ '+ appPath +' ] ');
                    targetAppPathObj.symlinkSync(appPath);
                }
            } catch (releaseError) {
                console.error('[ releaseError ] ', releaseError);
                let _releaseError = new Error('[ releaseError ] path: '+ targetAppPathObj.toString() );
                return callback(_releaseError);
            }
            targetAppPathObj = null;





            // if ( self.task == 'run' && !self.isCacheless() ) {
            //     appPath = _(newContent[app][env].bundlesPath + '/' + app)
            // } else { //getting src path instead
            //     appPath = _(newContent[app][env].sources + '/' + app);
            //     newContent[app][env].bundlesPath = newContent[app][env].sources;
            // }
            tmpSettings = {};
            newContent[app][env].bundlesPath = bundlesPath;

            if ( typeof(content[app][env]) != "undefined" ) {
                try {
                    // reverted: async readdir (#P33) breaks synchronous Config init contract
                    configFiles = fs.readdirSync(_(appPath + '/config'));
                } catch (mountingError) {
                    //console.emerg('Dependency bundle config not found for `'+ app +'/'+ env +'`: trying to load on the fly from src');
                    console.warn('[CONFIG] Dependency bundle config not found for `'+ app +'/'+ env +'`: trying to load on the fly from src');
                    let appSrcPath = _(root +'/'+ pkg[app].src, true);
                    try {
                        // reverted: async readdir (#P33) breaks synchronous Config init contract
                        configFiles = fs.readdirSync(_(appSrcPath + '/config'));
                    } catch (srcReadErr) {
                        return callback(srcReadErr);
                    }
                    setPath('bundles', _(appSrcPath, true));
                    appPath = appSrcPath;
                    newContent[app][env].bundlesPath = bundlesPath = appSrcPath.replace( new RegExp('/'+ app), '' );
                    console.warn('[CONFIG] Dependency bundle config loaded from '+ appSrcPath);
                }


                appsPath    = (typeof(content[app][env]['bundlesPath']) != 'undefined')
                        ? content[app][env].bundlesPath
                        : template["${bundle}"]["${env}"].bundlesPath
                ;
                // Preprocessing settings
                for (let c = 0, cLen = configFiles.length; c < cLen; ++c) {
                    let foundEnvVersion = false;
                    let fName = configFiles[c];
                    // settings only !
                    if ( !/^settings\./.test(fName) ) {
                        continue;
                    }


                    if (
                        /^\./.test(fName)
                        // || new RegExp('\.'+ env +'\.json$').test(fName)
                        || !/\.json$/.test(fName)
                    ) {
                        continue;
                    }


                    let name            = fName.replace(new RegExp('\.'+ env +'\.json$'), '').replace(new RegExp('\.json$'), '');
                    let fNameWithNoExt  = fName.replace(/.json$/, '');
                    let section = fNameWithNoExt.replace(/(^settings\.|^settings$)/, '').replace(new RegExp('\.'+ env +'$'), '').replace(new RegExp('\.json$'), '');

                    if (/\-/.test(name)) {
                        name = name.replace(/-([a-z])/g, function(g) { return g[1].toUpperCase(); })
                    }
                    filesList[name] = fName;
                    // handle registered config files
                    let main = fName;
                    // let tmp = fName.replace(/.json/, '.' + env + '.json'); // env version
                    files[name] = ( typeof(files[name]) != 'undefined' ) ? files[name] : {};
                    let fileContent = files[name];
                    // let filename = _(appPath + '/config/' + tmp);
                    let filenameObj = new _(appPath + '/config/' + main, true);
                    let filename    = filenameObj.toString();

                    exists = filenameObj.existsSync();
                    // loading env if exists
                    if ( self.isCacheless() ) {
                        if (exists) {
                            delete require.cache[require.resolve(_(filename, true))];
                        }
                    }
                    // if (new RegExp('\.'+ env +'\.json$').test(fName)) {
                    //     foundEnvVersion = true;
                    // }
                    try {
                        if (exists) {
                            jsonFile = requireJSON(_(filename, true));
                            if (Array.isArray(jsonFile) && !Array.isArray(fileContent) && !Object.keys(fileContent).length) {
                                fileContent = []
                            }
                            // Fixed priority to env version and/or extended.description if found
                            fileContent = merge(jsonFile, fileContent);
                        }
                    } catch (_err) {
                        if (exists) {
                            return callback(new Error('[ ' + filename + ' ] is malformed !!'))
                        }
                        fileContent = undefined;
                    }
                    // loading main
                    filenameObj = new _(appPath + '/config/' + main, true);
                    filename    = filenameObj.toString();
                    exists      = filenameObj.existsSync();
                    //Can't do anything without.
                    try {

                        if (isCacheless && exists) {
                            delete require.cache[require.resolve(_(filename, true))];
                        }

                        if (exists) {
                            jsonFile = requireJSON(_(filename, true));
                            if (Array.isArray(jsonFile) && !Array.isArray(fileContent) && !Object.keys(fileContent).length) {
                                fileContent = []
                            }
                            //fileContent = merge(fileContent, jsonFile);
                            // Fixed priority to env version and/or extended.description if found
                            fileContent = merge(jsonFile, fileContent);
                        } else {
                            console.warn('[ ' + app + ' ] [ ' + env + ' ]' + new Error('[ ' + filename + ' ] not found'));
                        }
                    } catch (_err) {

                        if ( exists ) {
                            let e = '[ ' + filename + ' ] is malformed !!\n\r' + (_err.stack || _err.message);
                            console.error(e);
                            return callback(new Error(e))
                        }

                        fileContent = undefined;
                    }

                    // tmp settings - because we need it now
                    if (section != '' ) {
                        if (/\-/.test(section)) {
                            section = section.replace(/-([a-z])/g, function(g) { return g[1].toUpperCase(); })
                        }
                        mergeConfig(tmpSettings, section, fileContent );
                    } else {
                        tmpSettings = merge(tmpSettings, fileContent);
                    }


                } //EO for (let c = 0, cLen = configFiles.length; c < cLen; ++c) {

                bundleSettings = tmpSettings;
                // reused and deleted in `loadBundleConfig()`
                bundleSettings.tmpSettingFileContent = JSON.clone(bundleSettings);
                newContent[app][env] = merge(bundleSettings, newContent[app][env]);
                // completing with missing props
                var defaultSettings = JSON.clone(requireJSON( getEnvVar('GINA_FRAMEWORK_DIR') +'/core/template/conf/settings.json'));
                // Patch locale section with system-detected values set by framework init
                var _defCulture = getEnvVar('GINA_CULTURE') || 'en_CM';
                var _defLang    = _defCulture.split('_')[0];              // 'en'
                var _defCountry = (_defCulture.split('_')[1] || '').toUpperCase(); // 'CM'
                if (defaultSettings.locale) {
                    // Look up country data from the built-in locale database
                    var _countryData = null;
                    try {
                        var _regionDb = require(getEnvVar('GINA_FRAMEWORK_DIR') + '/core/locales/dist/region/' + _defLang + '.json');
                        _countryData = _regionDb.filter(function(r) { return r.isoShort === _defCountry; })[0] || null;
                    } catch(e) {
                        try {
                            var _regionDb = require(getEnvVar('GINA_FRAMEWORK_DIR') + '/core/locales/dist/region/en.json');
                            _countryData = _regionDb.filter(function(r) { return r.isoShort === _defCountry; })[0] || null;
                        } catch(e2) {}
                    }
                    // preferedLanguages: use the country's actual language list when available
                    defaultSettings.locale.preferedLanguages = (_countryData && _countryData.languages && _countryData.languages.length)
                        ? _countryData.languages
                        : [ _defCulture.replace('_', '-') ];
                    defaultSettings.locale.region = _defCountry || _defCulture;
                    // currency: from locale database
                    if (_countryData && _countryData.currency && _countryData.currency.alphacode) {
                        defaultSettings.locale.currency.code = _countryData.currency.alphacode.toLowerCase();
                    }
                    // measurementUnits + temperature: exception lists (only 3 countries use imperial)
                    var _imperialCountries   = ['US', 'LR', 'MM'];
                    var _fahrenheitCountries = ['US', 'BS', 'KY', 'PW'];
                    defaultSettings.locale.measurementUnits = _imperialCountries.indexOf(_defCountry) > -1 ? 'imperial' : 'metric';
                    defaultSettings.locale.temperature      = _fahrenheitCountries.indexOf(_defCountry) > -1 ? 'fahrenheit' : 'celsius';
                    // dateFormat.short, 24HourTimeFormat, firstDayOfWeek: from Intl
                    if (typeof Intl !== 'undefined' && typeof Intl.DateTimeFormat.prototype.formatToParts === 'function') {
                        var _refDate = new Date(2013, 3, 5);
                        var _dateParts = Intl.DateTimeFormat(_defCulture.replace('_', '-'), {
                            year: 'numeric', month: '2-digit', day: '2-digit'
                        }).formatToParts(_refDate);
                        defaultSettings.locale.dateFormat.short = _dateParts.map(function(p) {
                            if (p.type === 'year')  return 'yyyy';
                            if (p.type === 'month') return 'mm';
                            if (p.type === 'day')   return 'dd';
                            return p.value.replace(/[^\x20-\x7E]/g, '');
                        }).join('');
                        defaultSettings.locale['24HourTimeFormat'] = !Intl.DateTimeFormat(
                            _defCulture.replace('_', '-'), { hour: 'numeric' }
                        ).resolvedOptions().hour12;
                        // firstDayOfWeek: from Intl.Locale.getWeekInfo() — 1=Mon … 7=Sun
                        try {
                            var _weekInfo = new Intl.Locale(_defCulture.replace('_', '-')).getWeekInfo();
                            if (_weekInfo && typeof _weekInfo.firstDay !== 'undefined') {
                                defaultSettings.locale.firstDayOfWeek = _weekInfo.firstDay;
                            }
                        } catch(e) {}
                    }
                }
                newContent[app][env] = merge(newContent[app][env], defaultSettings);



                // setting protocol & port
                if ( typeof(portsReverse[app+'@'+self.projectName]) == 'undefined' )
                    continue;

                if (
                    pkg[app] != 'undefined' && pkg[app]['src'] != 'undefined' && self.isCacheless()
                ) {
                    p = _(pkg[app].src);
                    content[app][env]['bundlesPath'] = "{executionPath}/"+ p.replace('/' + app, '');
                } else {
                    p = ( typeof(pkg[app].link) != 'undefined' ) ? _(pkg[app].link) : _(pkg[app].releases[scope][env].target);
                    content[app][env]['bundlesPath'] = "{executionPath}/"+ p.replace('/' + app, '');
                }
                p = null;

                appsPath = (typeof(content[app][env]['bundlesPath']) != 'undefined')
                    ? content[app][env].bundlesPath
                    : template["${bundle}"]["${env}"].bundlesPath;



                modelsPath = (typeof(content[app][env]['modelsPath']) != 'undefined')
                    ?  content[app][env].modelsPath
                    :  template["${bundle}"]["${env}"].modelsPath;

                projectPath = (typeof(content[app][env]['projectPath']) != 'undefined')
                    ?  content[app][env].projectPath
                    :  template["${bundle}"]["${env}"].projectPath;




                // just in case someone removes the settings.server.json
                if ( typeof(newContent[app][env].server ) == 'undefined' ) {
                    newContent[app][env].server = {}
                }

                // getting server protocol: bundle settings first, if not available ->W project's config
                // If the users has set a different protocol in its /config/settings.json, it will override the project protocol
                // at server init (see server.js)

                // by default
                if ( typeof(newContent[app][env].server.scope) == 'undefined' ) {
                    newContent[app][env].server.scope = projectConf.def_scope; // from ~/.gina/projects.json
                }
                newContent[app][env].server.scopeIsLocal = (projectConf.def_scope == projectConf.local_scope) ? true : false; // from ~/.gina/projects.json
                newContent[app][env].server.scopeIsProduction = (projectConf.def_scope == projectConf.production_scope) ? true : false; // from ~/.gina/projects.json

                if ( typeof(newContent[app][env].server.protocol) == 'undefined' ) {
                    //newContent[app][env].server.protocol = ( bundHasSettings && typeof(bundleSettings.server) != 'undefined' && typeof(bundleSettings.server.protocol) != 'undefined' ) ? bundleSettings.server.protocol : projectConf.def_protocol; // from ~/.gina/projects.json
                    newContent[app][env].server.protocol = projectConf.def_protocol; // from ~/.gina/projects.json
                }
                newContent[app][env].server.protocolShort = newContent[app][env].server.protocol.split(/\./)[0];

                if ( typeof(newContent[app][env].server.scheme) == 'undefined' ) {
                    //newContent[app][env].server.scheme = ( bundHasSettings && typeof(bundleSettings.server) != 'undefined' && typeof(bundleSettings.server.scheme) != 'undefined' ) ? bundleSettings.server.scheme : projectConf.def_scheme; // from ~/.gina/projects.json
                    newContent[app][env].server.scheme = projectConf.def_scheme; // from ~/.gina/projects.json
                }

                // getting server port
                if ( typeof (newContent[app][env].port) == 'undefined' ) {
                    newContent[app][env].port = {}
                }

                if ( typeof (newContent[app][env].port[ newContent[app][env].server.protocol ]) == 'undefined' ) {
                    newContent[app][env].port[ newContent[app][env].server.protocol ] = {}
                }

                if ( typeof (newContent[app][env].port[ newContent[app][env].server.protocol ][ newContent[app][env].server.scheme ]) == 'undefined' ) {
                    newContent[app][env].port[ newContent[app][env].server.protocol ][ newContent[app][env].server.scheme ] = {}
                }

                newContent[app][env].server.port = portsReverse[ app +'@'+ self.projectName ][env][projectConf.def_protocol][projectConf.def_scheme];
                try {
                    appPort = portsReverse[app+'@'+self.projectName][env][ newContent[app][env].server.protocol ][ newContent[app][env].server.scheme ];
                } catch (err) {
                    console.emerg('[CONFIG][ settings.server.protocol ] Protocol or scheme settings inconsistency found in `'+ app +'/config/settings`. To fix this, try to run `gina project:import @'+ self.projectName +' --path='+  projectConf.path +'`\n\r'+ err.stack);
                    process.exit(1)
                }
                //I had to for this one...
                appsPath = appsPath.replace(/\{executionPath\}/g, root);
                let appsPathObj = new _(appsPath, true);
                //console.log("My env ", env, self.executionPath, JSON.stringify(template, null, '\t') );
                //Existing app and port sharing => != isStandalone.
                if ( !appsPathObj.existsSync() ) {
                    appsPathObj.mkdirSync()
                }
                appsPathObj = null;


                newContent[app][env].port[ newContent[app][env].server.protocol ][ newContent[app][env].server.scheme ] = appPort;



                //Check if isStandalone or shared instance
                if (appPort != masterPort) {
                    isStandalone = false;
                    self.Host.standaloneMode = isStandalone
                } else if (app != self.startingApp) {
                    self.bundles.push(app)
                }
                self.allBundles.push(app);

                //Mergin user's & template.
                newContent[app][env] = merge(
                    newContent[app][env],
                    JSON.parse( JSON.stringify(template["${bundle}"]["${env}"]))//only copy of it.
                );


                if (!newContent[app][env].executionPath) {
                    newContent[app][env].executionPath = root
                }

                // Constants to be exposed in configuration files.
                // Variables replace. Compare with gina/core/template/conf/env.json.
                // Defining root domain (TLD or SLD)
                // by default
                // var hostFQDN = await domainLib.getFQDN() || os.hostname();
                // console.debug('[CONFIG]['+ app +'][loadWithTemplate][FQDN] Setting Host FQDN from `'+ newContent[app][env].host +'` => `'+ self.hostFQDN);
                let rootDomain = domainLib.getRootDomain(os.hostname()).value;
                // if (
                //     typeof(newContent[app][env].host) != 'undefined'
                //     && self.startingApp == app
                //     && new RegExp('^'+ app + '-').test(newContent[app][env].host)
                //     && newContent[app][env].host != hostFQDN
                // ) {
                //     console.debug('[CONFIG]['+ app +'][loadWithTemplate] Auto HOST MODE ON: retrieving current host FQDN.');
                //     // Get fqdn (equivalent of `hostname --fqdn` command line)
                //     try {
                //         newContent[app][env].host = hostFQDN;
                //         console.info('[CONFIG]['+ app +'][loadWithTemplate][FQDN] Host set as `'+ self.hostFQDN +'`');
                //     } catch (fqdnErr) {
                //         console.emerg('[CONFIG]['+ app +'][loadWithTemplate][FQDN] Check you `/etc/hosts` or check your hostname by running `hostname --fqdn` \n\r'+ fqdnErr.stack);
                //         process.exit(1)
                //     }
                // }
                // if overrided by the project `manifest.json`: meaning all bundles belong to the same TLD or SLD



                if ( typeof(manifest.rootDomain) != 'undefined' ) {
                    rootDomain = manifest.rootDomain;
                }
                // if overrided by the project/env/bundle `env.json` or `bundle/config/settings.server.json`: meaning the bundles belong to a specific TLD or SLD
                if ( typeof(newContent[app][env].rootDomain) != 'undefined' && newContent[app][env].rootDomain != '' ) {
                    rootDomain = newContent[app][env].rootDomain;
                }
                // custom override: user entry in the project/env/bundle `env.json` or `bundle/config/settings.server.json`
                // replaced: /\{rootDomain\}/ — also handle ${rootDomain} format after W2 migration (#W2)
                if (!/\$?\{rootDomain\}/.test(newContent[app][env].host) ) {
                    rootDomain = domainLib.getRootDomain(newContent[app][env].host).value;
                }
                newContent[app][env].rootDomain = rootDomain;
                // if ( /^true$/i.test( getContext('isProxyHost') ) ) {
                //     newContent[app][env].rootDomain = rootDomain = domainLib.getRootDomain(process.gina.PROXY_HOST).value;
                // }

                if ( typeof(newContent[app][env].homedir) == 'undefined' ) {
                    newContent[app][env].homedir = template.homedir;
                }
                if ( typeof(newContent[app][env].projectName) == 'undefined' ) {
                    newContent[app][env].projectName = self.projectName;
                }



                // replacement for {bundle}@{project}
                let reps = {
                    "frameworkDir"          : getEnvVar('GINA_FRAMEWORK_DIR'),
                    "executionPath"         : root,
                    "projectName"           : self.projectName,
                    "projectPath"           : projectPath,
                    "projectVersion"        : manifest.version,
                    "projectVersionMajor"   : manifest.version.split(/\./g)[0],
                    "homedir"               : newContent[app][env].homedir,
                    "bundlesPath"           : appsPath,
                    "modelsPath"            : modelsPath,
                    "bundle"                : app,
                    "env"                   : env,
                    "scope"                 : scope,
                    "logsPath"              : newContent[app][env].logsPath,
                    "tmpPath"               : newContent[app][env].tmpPath,
                    "cachePath"             : newContent[app][env].cachePath,
                    "sharedPath"            : newContent[app][env].sharedPath,
                    "templatesPath"         : newContent[app][env].templatesPath,
                    "rootDomain"            : rootDomain,
                    "host"                  : newContent[app][env].host,
                    "scheme"                : newContent[app][env].server.scheme,
                    "version"               : version
                };

                for (let _contant in process.gina) {
                    reps[_contant] = process.gina[_contant];
                }

                bundleSettings = null;
                try {

                    if (
                        typeof(newContent[app][env].host) != 'undefined'
                        && newContent[app][env].host != ''
                    ) {
                        // TODO - Override for kubernetes replicas: (os.hostname() + rootDomain) != newContent[app][env].host
                        // eg.: public2-prod-v3-beta VS public-prod-v3-beta

                        newContent[app][env].host = whisper(reps, newContent[app][env].host);
                    }

                    // if ( typeof(newContent[app][env].host_if_dns_resolution) != 'undefined' ) {
                    //     newContent[app][env].host_if_dns_resolution = whisper(reps, newContent[app][env].host_if_dns_resolution);
                    //     if ( newContent[app][env].host != newContent[app][env].host_if_dns_resolution ) {
                    //         newContent[app][env].host = newContent[app][env].host_if_dns_resolution;
                    //     }
                    // }

                    if (
                        typeof(newContent[app][env].rootDomain) != 'undefined'
                        && newContent[app][env].rootDomain != ''
                    ) {
                        newContent[app][env].rootDomain = whisper(reps, newContent[app][env].rootDomain);
                    }

                    newContent = whisper(reps, newContent);
                } catch(contentErr) {
                    console.emerg(contentErr.stack);
                    return;
                }

            }
            //Else not in the scenario.

        }//EO for.


        console.debug('[ '+ self.startingApp +' ][ '+ env +' ] Env configuration loaded');

        // TRUE means that all apps sharing the same process will merge into one.
        if (!isStandalone) self.Host.standaloneMode = isStandalone;

        console.debug('Is server running as a standalone instance ? ' + isStandalone);

        callback(false, newContent)
    }

    /**
     * Tests whether a JSON config file exists at `executionPath/<file>.json`.
     *
     * @inner
     * @private
     * @param {string} file - Relative file name without the `.json` extension
     * @returns {boolean} `true` if the file can be `require()`d, `false` otherwise
     */
    var isFileInProject = function(file) {
        try {
            var usrConf = require(self.executionPath +'/'+ file +'.json');
            return true
        } catch(err) {
            console.warn('CONF:HOST:WARN:1', err.stack||err.message);
            return false
        }
    }

    /**
     * Returns the list of registered bundles sharing the same server port.
     *
     * @memberof module:gina/core/config
     * @returns {string[]} Bundle names sharing the current port
     */
    this.getBundles = function() {
        //Registered apps only.
        return self.bundles
    }

    /**
     * Returns all registered bundles for the project.
     *
     * @memberof module:gina/core/config
     * @returns {string[]} All bundle names
     */
    this.getAllBundles = function() {
        //Registered apps only.
        return self.allBundles
    }

    /**
     * Returns all registered environment names for the project.
     *
     * @memberof module:gina/core/config
     * @returns {string[]} All environment names
     */
    this.getAllEnvs = function() {
        //Registered apps only.
        return self.allEnvs
    }

    /**
     * Returns all registered scope names for the project.
     *
     * @memberof module:gina/core/config
     * @returns {string[]} All scope names
     */
    this.getAllScopes = function() {
        //Registered apps only.
        return self.allScopes
    }

    /**
     * Finds the base routing rule that a derived (parameterised) rule was
     * generated from, by matching action, bundle, and suffix pattern.
     *
     * @memberof module:gina/core/config
     * @param {string} rule - Derived rule name to look up
     * @param {object} routing - Full routing map
     * @returns {string|undefined} The original base rule name, or undefined if not found
     */
    this.getOriginalRule = function(rule, routing) {

        var currentRouting  = routing[rule];

        for (let f in routing) {
            if (
                routing[f].param.action == currentRouting.param.action
                && routing[f].bundle == currentRouting.bundle
                && f != rule
                && new RegExp(f+"$").test(rule)
            ) {
                return f
            }
        }
        return undefined
    }


    /**
     * Recursively freezes `obj` and all of its nested plain-object properties
     * using `Object.freeze`. Returns the frozen object.
     *
     * @inner
     * @private
     * @param {object} obj - Object to freeze
     * @returns {object} The deeply frozen object
     */
    var deepFreeze = function (obj) {

        // On récupère les noms des propriétés définies sur obj
        var propNames = Object.getOwnPropertyNames(obj);

        // On gèle les propriétés avant de geler l'objet
        for(let name of propNames){
            let value = obj[name];
            obj[name] = value && typeof value === "object" ?
            deepFreeze(value) : value;
        }

        // On gèle l'objet initial
        return Object.freeze(obj);
    }

    /**
     * Recursively walks a config object along a dotted-key path (`arr`) and
     * merges `content` into the leaf node. Converts kebab-case keys to
     * camelCase before traversal.
     *
     * @inner
     * @private
     * @param {object} root - Top-level config object (used for error context)
     * @param {string[]} arr - Exploded path segments (e.g. `['server','options']`)
     * @param {object} obj - Current node being traversed
     * @param {number} len - Total path depth (`arr.length`)
     * @param {number} i - Current depth index
     * @param {*} content - Value to merge at the leaf
     * @param {string} [pathname] - Accumulated dotted path string (for logging)
     */
    var parseFileConf = function(root, arr, obj, len, i, content, pathname) {


        key = arr[i];
        if (/\-/.test(key)) {
            key = key.replace(/-([a-z])/g, function(g) { return g[1].toUpperCase(); })
        }

        if ( i == 0 && Array.isArray(content)) {
            var _key = '';
            for (let _i = 0; _i < len; _i++) {
                _key += arr[_i]
                if (_i < len-1)
                    _key += '.';
            }
            pathname = _key;
        }

        if (i == len - 1) { // end
            if ( typeof(global._jsonConfig) == 'undefined' ) {
                global._jsonConfig = {}
            }
            if ( typeof(global._jsonConfig[pathname]) == 'undefined' ) {
                global._jsonConfig[pathname] = {}
            }
            // getConfig('app.key') should equal getConfig('app').key
            if (root.hasOwnProperty(pathname)) {
                //
                if (!obj.hasOwnProperty(key)) {
                    //root[pathname] = content;
                    content = deepFreeze(content);
                    //global._jsonConfig[pathname] = content;
                    //Object.freeze(global._jsonConfig[pathname]);
                    root.__defineGetter__(pathname, function(){ return content });
                } else {
                    //root[pathname] = merge(content, root[pathname]);
                    var _content = merge(content, root[pathname]);
                    _content = deepFreeze(_content);
                    //global._jsonConfig[pathname] = _content;
                    //Object.freeze(global._jsonConfig[pathname]);
                    root.__defineGetter__(pathname, function(){ return _content });
                }
                //obj[key] =  root[pathname]
                obj.__defineGetter__(key, function() {
                    return root[pathname]
                    //return global._jsonConfig[pathname]
                });
                deepFreeze(obj[key]);
            } else {
                // getConfig('app').key
                if (!obj.hasOwnProperty(key)) {
                    obj[key] = content;
                } else { // overiding exiting
                    obj[key] = merge(content, obj[key]);
                }
            }
            return root
        }

        if (typeof (obj[key]) == 'undefined') {

            obj[key] = (Array.isArray(content)) ? [] : {};
            ++i;

            return parseFileConf(root, arr, obj[key], len, i, content, pathname);
        }


        for (let k in obj) {
            if (k == key) {
                ++i;
                return parseFileConf(root, arr, obj[key], len, i, content, pathname);
            }
        }
    }

    /**
     * Replaces `{bundle@project[/env]}` placeholders in a hostname string
     * with the resolved scheme+host+port (or pre-computed `hostname`) of the
     * referenced bundle.
     *
     * @inner
     * @private
     * @param {string} name - Hostname string potentially containing placeholders
     * @returns {string} Hostname with all placeholders substituted
     */
    var originHostReplacement = function(name) {
        var matched = name.match(/\{\s*(.*)\s*\}/g);
        if (!matched || !Array.isArray(matched) || Array.isArray(matched) && matched.length == 0 ) {
            return name
        }
        var env     = self.envConf.env;
        var scope   = self.envConf.scope;

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
            scheme  = self.envConf[bundle][env].server.scheme;
            hostname  = ( !self.envConf[bundle][env].hostname ) ? self.envConf[bundle][env].server.scheme + '://' + self.envConf[bundle][env].host + ':' + self.envConf[bundle][env].server.port : self.envConf[bundle][env].hostname;
            name    = name.replace(oldHost, hostname);
        }
        matched = null;
        env = null;
        scope = null;

        return name;
    }

    /**
     * Loads the full configuration for a single bundle at index `b` from the
     * `bundles` array. Handles routing, models, forms, views, plugins, and
     * host/origin resolution. Recursively calls itself for the next bundle.
     * Calls `callback(err, files, collectedRules)` when all bundles are done.
     *
     * @inner
     * @private
     * @param {string[]} bundles - Ordered list of bundle names to process
     * @param {number} b - Current bundle index
     * @param {function} callback - `function(err, files, collectedRules)`
     * @param {boolean} [reload=false] - When true, bypasses require cache (cacheless mode)
     * @param {object} [collectedRules] - Accumulated routing rules across all bundles
     */
    var loadBundleConfig = function(bundles, b, callback, reload, collectedRules) {

        // current bundle
        var bundle = null;
        if ( typeof(bundles[b]) == 'undefined' ) {
            bundle = self.startingApp
        } else {
            bundle = bundles[b]
        }

        // environment
        var isCacheless     = self.isCacheless()
            , isStandalone  = self.Host.isStandalone()
            , env           = process.env.NODE_ENV || self.env || self.Env.get() // env
            , scope         = process.env.NODE_SCOPE || self.scope || self.Scope.get() // scope
            , conf          = self.envConf // env conf
        ;
        console.debug('[CONFIG][loadBundleConfig] Loading `'+ bundle +'/'+ env +':'+ scope +'` configuration, please wait ...');


        self.setServerCoreConf(bundle, env, scope, conf.core);

        // bundle paths, ports, protocols
        var appPath         = ''
            , appPort       = null
            , masterPort    = null
            , portsReverse  = getContext('gina').portsReverse
            , exists        = false
            , protocol      = null
            , scheme        = null
        ;


        conf[bundle][env].projectName   = getContext('projectName');
        conf[bundle][env].allBundles    = bundles;
        conf[bundle][env].isCacheless   = isCacheless;
        conf[bundle][env].isStandalone  = isStandalone;
        conf[bundle][env].executionPath = getContext('paths').root;

        // By default
        appPath = _(conf[bundle][env].bundlesPath + '/' + bundle);

        // var appPathObj = new _(conf[bundle][env].releases +'/'+ bundle +'/'+ scope +'/'+ env +'/'+ conf[bundle][env].projectVersion, true);
        // if (!appPathObj.existsSync() || self.isCacheless() ) {
        //     //getting src path instead
        //     appPath = _(conf[bundle][env].sources + '/' + bundle);
        //     conf[bundle][env].bundlesPath = conf[bundle][env].sources;
        // }

        // if ( self.task == 'run' && !self.isCacheless() ) {
        //     appPath = _(conf[bundle][env].bundlesPath + '/' + bundle)
        // } else {
        //     appPath = _(conf[bundle][env].sources + '/' + bundle);
        //     conf[bundle][env].bundlesPath = conf[bundle][env].sources;
        // }


        // bundle web root
        var wroot                   = ( !conf[bundle][env].server.webroot || conf[bundle][env].server.webroot == '' ) ? '/' : conf[bundle][env].server.webroot
            // default `webrootAutoredirect` is true
            , webrootAutoredirect   = conf[bundle][env].server.webrootAutoredirect
            , localWroot            = null
            , localHasWebRoot       = null
        ;
        // formating wroot to have /mywebroot/
        wroot = ( !/^\//.test(wroot) ) ? '/' + wroot : wroot;
        wroot = ( !/\/$/.test(wroot) ) ? wroot + '/' : wroot;
        if (wroot == '/' || wroot == '' ) {
            // disable webrootAutoredirect
            webrootAutoredirect = conf[bundle][env].server.webrootAutoredirect = false
        }
        // standalone setup
        if ( isStandalone && bundle != self.startingApp && wroot == '/') {
            wroot += bundle + '/';
        }
        conf[bundle][env].server.webroot = wroot;
        var hasWebRoot = (wroot.length >1) ? true : false;

        // bundle routing
        if ( !collectedRules || typeof(collectedRules) == 'undefined' ) {
            collectedRules = {}
        }
        var standaloneRouting   = {}
            , originalRules     = []
            , oRuleCount        = 0
            , routing           = {}
            , reverseRouting    = {}
            , allowPreflight
        ;


        var tmp                     = ''
            , err                   = false
            // template file
            , file                  = null
            , filename              = null
            // files to be ignored while parsing config dir
            , defaultConfigFiles    = (conf[bundle][env].files.join(".json,") + '.json').split(',')
        ;


        var fName       = null, fNameWithNoExt = null;
        var files       = { "routing": {} }, filesList = {};
        var main        = '';
        var name        = null;

        var fileContent         = null
            , allEnvs           = self.getAllEnvs()
        ;

        // getting bundle config files
        var configFiles             = null
            , e                     = null
            , sharedConfigPathObj   = new _(conf[bundle][env].sharedPath + '/config', true)
            , sharedconfigPath      = null
            , sharedConfigFiles     = []
        ;
        // reverted: async readdir (#P33) breaks synchronous Config init contract
        try {
            configFiles = fs.readdirSync(_(appPath + '/config', true));
        } catch (configReadErr) {
            return callback(configReadErr);
        }

        if ( sharedConfigPathObj.existsSync() ) {
            sharedconfigPath = sharedConfigPathObj.toString();
            // reverted: async readdir (#P33) breaks synchronous Config init contract
            try {
                sharedConfigFiles = fs.readdirSync(sharedconfigPath);
            } catch (sharedReadErr) {
                return callback(sharedReadErr);
            }
            for (let i=0, len = sharedConfigFiles.length; i<len; i++) {
                let file = sharedConfigFiles[i];

                if (
                    /^\./.test(file)
                    || /\s+copy$/i.test(file)
                ) {
                    sharedConfigFiles.splice(i,1);
                    i --;
                    len--;
                    continue;
                }
                // sharedConfigFiles[i] = _(sharedconfigPath +'/'+ file, true);
                // completing `configFiles` when file is listed in `sharedConfigFiles` but not in `configFiles`
                if ( configFiles.indexOf(file) < 0 ) {
                    configFiles.push(file);
                }
            }
        }
        sharedConfigPathObj = null;

        var c       = 0
            , cLen  = configFiles.length
        ;
        for (; c < cLen; ++c) {
            let jsonFile = null;

            fName = configFiles[c];
            fNameWithNoExt  = fName.replace(/.json/, '');

            // do we need it ?
            // if (conf[bundle][env].files.indexOf(fNameWithNoExt) < 0) {
            //     conf[bundle][env].files.push(fNameWithNoExt)
            // }

            // e.g: if env == `dev` and we have app.prod.json, we should skip it
            let skipIt = false;
            let foundEnvVersion = false;
            for (let e = 0, eLen = allEnvs.length; e < eLen; e++) {
                // *.dev.json or *.global.json
                let re = new RegExp('\.('+ allEnvs[e] +'|global)\.json$');
                if (
                    re.test(fName)
                    // 2023-07-28 - Fixed this by commenting the rest of the test to avoid routing.global.json to be included in list
                    //&& allEnvs[e] != env
                ) {
                    // we should skip it
                    skipIt = true;
                    break;
                }
            }
            if (skipIt) continue;

            if ( /^settings\./.test(fName) ) {
                // already defined before by `loadWithTemplate()`
                continue;
            }

            if (/^\./.test(fName) || new RegExp('\.'+ env +'\.json$').test(fName) || !/\.json$/.test(fName)  )
                continue;

            // e.g: if env == `dev` and we have app.dev.json
            if ( new RegExp('\.'+ env +'\.json$').test(fName)  ) {
                foundEnvVersion = true;
            }
            //name            = fName.replace(/\.json$/, '');
            // we just want the main name .. not the extended description fullname
            name            = fName.replace(/\..*/g, '');
            let section     = fNameWithNoExt
                            .replace(/^\w+\./g, '')
                            .replace(new RegExp('\.'+ env +'\.json$'), '');
            if (section == fNameWithNoExt) {
                section = '';
            }

            if (/\-/.test(name)) {
                name = name.replace(/-([a-z])/g, function(g) { return g[1].toUpperCase(); })
            }

            filesList[name] = fName;
            // handle registered config files
            // Loading dev version
            main = fName;
            tmp = fName.replace(/.json/, '.' + env + '.json'); // dev

            files[name] = ( typeof(files[name]) != 'undefined' ) ? files[name] : {};
            fileContent = files[name];
            let filenameObj = new _(appPath + '/config/' + tmp, true);
            filename    = filenameObj.toString();
            exists      = filenameObj.existsSync();

            // In case the config is not found in the bundle, but exists in shared config
            let sharedFilesIndex = sharedConfigFiles.indexOf(tmp);
            if (!exists && sharedFilesIndex > -1) {
                filenameObj = new _( sharedconfigPath +'/'+ tmp, true);
                filename    = filenameObj.toString();
                exists      = filenameObj.existsSync();
                // remove entry from `sharedConfigFiles` list
                sharedConfigFiles.splice(sharedFilesIndex,1);
            }
            filenameObj = null;
            // loading dev if exists
            if ( self.isCacheless() ) {
                if (exists) {
                    delete require.cache[require.resolve(_(filename, true))];
                }
            }

            try {

                if (!exists) {
                    jsonFile = null;
                } else {
                    jsonFile = requireJSON(_(filename, true));

                    if (Array.isArray(jsonFile) && !Array.isArray(fileContent) && !Object.keys(fileContent).length) {
                        fileContent = []
                    }
                    // Fixed priority to env version and/or extended.description if found
                    fileContent = merge(jsonFile, fileContent);
                }

            } catch (_err) {
                if (exists) {
                    return callback(new Error('[ ' + filename + ' ] is malformed !!'))
                }
                fileContent = undefined
            }
            // loading main
            filenameObj = new _(appPath + '/config/' + main, true);
            filename    = filenameObj.toString();
            exists      = filenameObj.existsSync();

            // In case the config is not found in the bundle, but exists in shared config
            sharedFilesIndex = sharedConfigFiles.indexOf(main);
            if (!exists && sharedFilesIndex > -1) {
                filenameObj = new _( sharedconfigPath +'/'+ main, true);
                filename    = filenameObj.toString();
                exists      = filenameObj.existsSync();
                // remove entry from `sharedConfigFiles` list
                // sharedConfigFiles.splice(sharedFilesIndex,1);
            }
            filenameObj = null;


            //Can't do anything without.
            try {
                if (isCacheless && exists) {
                    delete require.cache[require.resolve(_(filename, true))];
                }

                if (!exists) {
                    console.warn('[ ' + app + ' ] [ ' + env + ' ]' + new Error('[ ' + filename + ' ] not found'));
                } else {
                    jsonFile = requireJSON(_(filename, true));
                }

                // sharedFilesIndex = sharedConfigFiles.indexOf(main);
                if ( sharedFilesIndex > -1) {
                    let sharedMain = requireJSON(_( sharedconfigPath +'/'+ main, true));
                    jsonFile = merge(sharedMain, jsonFile, true);
                    sharedMain = null;
                    sharedConfigFiles.splice(sharedFilesIndex, 1);
                }
                sharedFilesIndex = null;

                if (Array.isArray(jsonFile) && !Array.isArray(fileContent) && !Object.keys(fileContent).length) {
                    fileContent = []
                }
                //fileContent = merge(fileContent, jsonFile);
                // Fixed priority to env version and/or extended.description if found
                fileContent = merge(jsonFile, fileContent);


            } catch (_err) {

                if (exists) {
                    e = '[ ' + filename + ' ] is malformed !!\n\r' + (_err.stack || _err.message);
                    console.error(e);
                    return callback(new Error(e))
                }

                fileContent = undefined
            }

            if (section != '' ) {
                if (/\-/.test(section)) {
                    section = section.replace(/-([a-z])/g, function(g) { return g[1].toUpperCase(); })
                }
                mergeConfig(files[name], section, fileContent );
            } else {
                files[name] = merge(files[name], fileContent);
            }


        } // EO for (var c = 0, cLen = configFiles.length; c < cLen; ++c)
        conf[bundle][env] = merge(files, conf[bundle][env]);

        // building file list
        conf[bundle][env].configFiles = filesList;

        var hasViews = (typeof(files['templates']) != 'undefined' && typeof(files['templates']['_common']) != 'undefined') ? true : false;

        // e.g.: 404 rendering for JSON APIs by checking `env.template`: JSON response can be forced even if the bundle has views
        if ( hasViews && typeof(self.userConf[bundle][env].template) != 'undefined' && self.userConf[bundle][env].template == false) {
            conf[bundle][env].template = false
        } else if (hasViews) {
            conf[bundle][env].template = true;
        }

        // routing.global.json
        let globalMiddlewares = [];
        let globalMiddlewaresPathObj = new _(appPath + '/config/routing.global.json', true);
        if ( globalMiddlewaresPathObj.existsSync() ) {
            globalMiddlewares = requireJSON(globalMiddlewaresPathObj.toUnixStyle()).middleware;
        }
        sharedFilesIndex = sharedConfigFiles.indexOf('routing.global.json');
        if ( sharedFilesIndex > -1) {
            let sharedGlobalMiddlewaresPathObj = new _(sharedconfigPath + '/routing.global.json', true);
            let sharedGlobalMiddlewares = null;
            try {
                sharedGlobalMiddlewares = requireJSON(sharedGlobalMiddlewaresPathObj.toUnixStyle());
                globalMiddlewares = merge(globalMiddlewares, sharedGlobalMiddlewares.middleware);
                sharedConfigFiles.splice(sharedFilesIndex, 1);
                sharedGlobalMiddlewaresPathObj = null;
                sharedGlobalMiddlewares = null;
            } catch (_err) {

                if ( sharedGlobalMiddlewaresPathObj.existsSync() ) {
                    e = '[ ' + sharedGlobalMiddlewaresPathObj.toUnixStyle() + ' ] is malformed !!\n\r' + (_err.stack || _err.message);
                    console.error(e);
                    return callback(new Error(e))
                }
            }
        }
        sharedFilesIndex = null;


        name = 'routing';
        routing = files[name];
        var r       = null
            , rLen  = null
            , urls  = null
        ;

        // Setting app param
        // bundle status
        routing['bundle-status'] = {
            url: '/_status',
            method: 'GET',
            param: {
                control: 'getBundleStatus'
            },
            scopes: [ ''+ scope ]
        };

        // custom error page
        routing['custom-error-page'] = {
            // url will be modified on error
            url: '/custom-error',
            method: 'GET',
            middleware: [],
            middlewareIgnored: [],
            param: {
                control: 'renderCustomError',
                // default data : will be fed on error
                error: {}
            },
            scopes: [ ''+ scope ]
        };

        // creating default rule for auto redirect: / => /webroot
        if (
            hasWebRoot
            && wroot != '/'
            && typeof(routing['webroot@'+ bundle]) == 'undefined'
        ) {
            routing['webroot@'+ bundle] = {
                method: 'GET, POST, PUT, DELETE, HEAD',
                // by default
                url:  wroot.substring(0, wroot.length-1),
                middleware: [],
                param: {
                    control: "redirect",
                    ignoreWebRoot: true,
                    path: wroot,
                    code: 302
                },
                scopes: [ ''+ scope ],
                bundle: bundle,
                host: conf[bundle][env].host,
                hostname: conf[bundle][env].server.scheme +'://'+ conf[bundle][env].host +':'+ conf[bundle][env].port[conf[bundle][env].server.protocol][conf[bundle][env].server.scheme],
                webroot: wroot
            };
            // default hostname
            if ( /^true$/i.test(webrootAutoredirect) ) {
                routing['webroot@'+ bundle].url = '/,'+ wroot.substring(0, wroot.length-1);
            }
        }

        // upload routes
        if (
            typeof(conf[bundle][env].upload) != 'undefined'
            && typeof(conf[bundle][env].upload.groups) != 'undefined'
            && conf[bundle][env].upload.groups.count() > 0
        ) {
            if ( typeof(routing['upload-to-tmp-xml@'+ bundle]) == 'undefined' ) {
                routing['upload-to-tmp-xml'] = {
                    "_comment": "Will store file to the project tmp dir",
                    "url": "/upload",
                    "method": "POST",
                    "param": {
                        "control": "uploadToTmp",
                        "title": "Upload file"
                    },
                    "scopes": [ ""+ scope ]
                }
            }

            if ( typeof(routing['upload-delete-from-tmp-xml@'+ bundle]) == 'undefined' ) {
                routing['upload-delete-from-tmp-xml'] = {
                    "_comment": "Will remove file from the project tmp dir",
                    "url": "/upload/delete",
                    "method": "POST",
                    "param": {
                        "control": "deleteFromTmp",
                        "title": "Delete uploaded file"
                    },
                    "scopes": [ ""+ scope ]
                }
            }
        }


        for (let rule in routing) {

            // skip non-object entries (e.g. $schema annotations in routing.json)
            if (typeof(routing[rule]) != 'object' || routing[rule] === null) continue;

            // checking requirements syntax
            if ( typeof(routing[rule].requirements) != 'undefined' && routing[rule].requirements.count() > 0 ) {
                for ( let r in routing[rule].requirements) {
                    if (
                        !/^\//.test(routing[rule].requirements[r])
                        && !/^validator\:\:/.test(routing[rule].requirements[r])
                    ) {
                        let ruleName = ( !/\@/.test(rule) ) ? rule +'@'+ bundle : rule;
                        err = new Error('['+ruleName+'] Bad routing syntax for `'+r+'` in requirements : must start with `/` or `validator::`');
                        console.emerg(err.stack||err.message);
                        process.exit(1);
                    }
                }
            }


            if (rule == 'webroot@'+ bundle) continue;

            localWroot  = wroot; // by default

            if ( typeof(routing[rule].bundle) != 'undefined' && routing[rule].bundle != bundle ) {
                localWroot  = conf[routing[rule].bundle][env].server.webroot;//conf[bundle][env].server.webroot
                // formating localWroot to have /mywebroot/
                localWroot  = ( !/^\//.test(localWroot) ) ? '/' + localWroot : localWroot;
                localWroot  = ( !/\/$/.test(localWroot) ) ? localWroot + '/' : localWroot;

                // standalone setup
                if ( isStandalone && bundle != self.startingApp && localWroot == '/') {
                    localWroot += bundle + '/';
                }

                conf[routing[rule].bundle][env].server.webroot = localWroot
            } else {
                routing[rule].bundle =  bundle;
            }
            localHasWebRoot = (localWroot.length >1) ? true : false;


            // default hostname
            if (
                typeof(routing[rule].hostname) == 'undefined'
                    && !/^redirect$/.test(routing[rule].param.control)
                ||
                !routing[rule].hostname
                    && !/^redirect$/.test(routing[rule].param.control)
            ) {
                routing[rule].host      = conf[routing[rule].bundle][env].host
                routing[rule].hostname  = conf[routing[rule].bundle][env].server.scheme +'://'+ routing[rule].host +':'+ conf[routing[rule].bundle][env].port[conf[routing[rule].bundle][env].server.protocol][conf[routing[rule].bundle][env].server.scheme];
                // if ( /^true$/i.test( getContext('isProxyHost') ) ) {
                //     routing[rule].host = process.gina.PROXY_HOST
                //     routing[rule].hostname = process.gina.PROXY_HOSTNAME
                // }
                // default webroot
                routing[rule].webroot   = localWroot;
            }

            // default scope
            if ( typeof(routing[rule].scopes) == 'undefined' || !routing[rule].scopes )
                routing[rule].scopes = [ ""+ scope ];

            // default method
            if ( typeof(routing[rule].method) == 'undefined' || !routing[rule].method )
                routing[rule].method = 'GET';

            if ( /\,/.test(routing[rule].method) )
                routing[rule].method = routing[rule].method.replace(/\s+/g, '');

            // default middleware
            if ( typeof(routing[rule].middleware) == 'undefined' || !routing[rule].middleware )
                routing[rule].middleware = [];

            if (
                globalMiddlewares
                && Array.isArray(globalMiddlewares)
                && globalMiddlewares.length > 0
            ) {
                if ( typeof(routing[rule].middleware) == 'undefined' ) {
                    routing[rule].middleware = [];
                }
                routing[rule].middleware = merge(globalMiddlewares.slice(), routing[rule].middleware);
            }

            // default url
            if ( typeof(routing[rule].url) == 'undefined' || !routing[rule].url )
                routing[rule].url = '/'+ rule;

            try {
                if ( /\,/.test(routing[rule].url) )
                    routing[rule].url = routing[rule].url.replace(/\s+/g, '');

            } catch (err) {
                throw new Error('[ ROUTING ] Error found in your route description: \nbundle: `'+ routing[rule].bundle +'`\nroute: `'+ rule +'`\nurl: `'+ routing[rule].url +'`.\nPlease check your routing configuration: `'+ routing[rule].bundle +'/config/'+ name+'.json` or `'+ routing[rule].bundle +'/config/'+ name+'.'+ env +'.json`');
            }

            // link route & template if hasViews - inly for GET methods
            if ( hasViews && /get/i.test(routing[rule].method) && typeof(files['templates'][rule.toLowerCase()]) == 'undefined' ) {
                files['templates'][rule.toLowerCase()] = {}
            }

            routing[rule.toLowerCase() +'@'+ bundle] = routing[rule];
            delete routing[rule];

            // default file name
            file        = rule.toLowerCase();
            rule        = rule.toLowerCase() +'@'+ bundle;


            routing[rule].bundle = (routing[rule].bundle) ? routing[rule].bundle : bundle; // for reverse lookup
            // route file
            if (!routing[rule].param) continue;
            //routing[rule].param.file = ( typeof(routing[rule].param) != 'undefined' && typeof(routing[rule].param.file) != 'undefined' ) ? routing[rule].param.file: file; // get template file
            if (
                typeof(routing[rule].param) != 'undefined'
                && typeof(routing[rule].param.file) != 'undefined'
                && /delete/i.test(routing[rule].method )
            ) {
                console.warn('`DELETE` method result should not be rendered into a file');
            } else if (
                typeof(routing[rule].param) != 'undefined'
                && typeof(routing[rule].param.file) == 'undefined'
                /**&& !/delete/i.test(routing[rule].method)*/
            ) {
                routing[rule].param.file = file
            }

            // by default, method is inherited from the request.method
            if (
                localHasWebRoot
                    && typeof(routing[rule].param.path) != 'undefined'
                    && typeof(routing[rule].param.ignoreWebRoot) == 'undefined'
                ||
                localHasWebRoot
                    && typeof(routing[rule].param.path) != 'undefined'
                    && !routing[rule].param.ignoreWebRoot
            ) {
                routing[rule].param.path = localWroot + ( /^\//.test(routing[rule].param.path) ) ? routing[rule].param.path.substring(1) : routing[rule].param.path
            }



            // ignoreWebRoot test to rewrite url webroot
            if ( typeof(routing[rule].param.ignoreWebRoot) == 'undefined' || !routing[rule].param.ignoreWebRoot ) {
                //routing[rule].url = (routing[rule].url.length > 1) ? localWroot + routing[rule].url : routing[rule].url;
                if ( /\,/.test(routing[rule].url) ) {
                    urls = routing[rule].url.split(/\,/g);
                    r = 0; rLen = urls.length;
                    for (; r < rLen; ++r) {
                        urls[r] = ( localHasWebRoot && urls[r].length > 1) ? localWroot + urls[r].substring(1) : ((localHasWebRoot && urls[r].length == 1) ? localWroot : urls[r]);
                    }
                    routing[rule].url = urls.join(',');
                } else {
                    routing[rule].url = ( localHasWebRoot && routing[rule].url.length > 1) ? localWroot + routing[rule].url.substring(1) : ((localHasWebRoot && routing[rule].url.length == 1) ? localWroot : routing[rule].url);
                }
            }
        }

        self.setRouting(bundle, env, scope, routing);
        // reverse routing
        for (let rule in routing) {

            if ( /\,/.test(routing[rule].url) ) {
                urls = routing[rule].url.split(/\,/g);
                r = 0; rLen = urls.length;
                for (; r < rLen; ++r) {
                    reverseRouting[ urls[r] ] = rule
                }
            } else {
                reverseRouting[ routing[rule].url ] = rule
            }
        }
        self.setReverseRouting(bundle, env, scope, reverseRouting);

        if (!conf[bundle][env].executionPath) {
            conf[bundle][env].executionPath = self.executionPath
        }

        //Constants to be exposed in configuration files.
        var reps = {
            "gina"              : getPath('gina').root,
            "frameworkDir"      : getEnvVar('GINA_FRAMEWORK_DIR'),
            // "scope"             : conf[bundle][env].server.scope,
            "scope"             : scope,
            "env"               : env,
            "host"              : conf[bundle][env].host,
            "bundle"            : bundle,
            // "server.engine"     : conf[bundle][env].engine,
            // "server.protocol"   : conf[bundle][env].protocol,
            // "server.scheme"     : conf[bundle][env].scheme,
            "project"           : getPath('project'),
            "root"              : conf[bundle][env].executionPath,
            "executionPath"     : conf[bundle][env].executionPath,
            "source"            : conf[bundle][env].sources,
            "projectPath"       : conf[bundle][env].projectPath,
            "bundlesPath"       : conf[bundle][env].bundlesPath,
            "mountPath"         : conf[bundle][env].mountPath,
            "bundlePath"        : conf[bundle][env].bundlePath,
            "templatesPath"     : conf[bundle][env].templatesPath,
            "publicPath"        : conf[bundle][env].publicPath,
            "modelsPath"        : conf[bundle][env].modelsPath,
            "libPath"           : conf[bundle][env].libPath,
            "handlersPath"      : conf[bundle][env].handlersPath,
            "sharedPath"        : conf[bundle][env].sharedPath,
            "logsPath"          : conf[bundle][env].logsPath,
            "tmpPath"           : conf[bundle][env].tmpPath,
            "cachePath"         : conf[bundle][env].cachePath,
            "version"           : getContext('gina').version,
        };

        for (let _contant in process.gina) {
            reps[_contant] = process.gina[_contant];
        }

        var corePath = getPath('gina').core;
        var settingsPath = _(corePath +'/template/conf/settings.json', true);
        var staticsPathObj  = new _(corePath +'/template/conf/statics.json', true);
        var staticsPath     = staticsPathObj.toString();
        var viewsPath = _(corePath +'/template/conf/templates.json', true);

        var defaultViews = requireJSON(viewsPath);
        if (hasViews && typeof(files['templates']._common) != 'undefined') {
            reps['templates']   = files['templates']._common.templates || defaultViews._common.templates;
            reps['html']        = files['templates']._common.html || defaultViews._common.html;
            reps['theme']       = files['templates']._common.theme || defaultViews._common.theme;
        }

        var ports = conf[bundle][env].port;
        for (let p in ports) {
            reps[p+'Port'] = ports[p]
        }

        var localEnvPathObj = new _(conf[bundle][env].executionPath + '/env.local.json', true);
        var localEnvPath    = localEnvPathObj.toString();
        if ( self.isCacheless() && localEnvPathObj.existsSync() ) {
            conf[bundle][env] = merge(conf[bundle][env], requireJSON(localEnvPath), true);
        }
        localEnvPath    = null;
        localEnvPathObj = null;
        var envKeys = conf[bundle][env];
        for (let k in envKeys) {
            if ( typeof(envKeys[k]) != 'object' && typeof(envKeys[k]) != 'array' ) {
                reps[k] = envKeys[k]
            }
        }


        try {

            // we only need to retrieve the tmpFiles (files[settings])
            files['settings'] = JSON.clone(conf[bundle][env].tmpSettingFileContent) || {};
            delete conf[bundle][env].tmpSettingFileContent;

            if ( files['settings'].count() == 0 ) {
                files['settings'] = requireJSON(settingsPath)
            } else {
                var defaultSettings = requireJSON(settingsPath);
                files['settings'] = merge(JSON.clone(files['settings']), defaultSettings)
                // files['settings'] = merge(files['settings'], defaultSettings)
            }
            // Expose files['settings'] directly on conf so that getConfig() (no-arg) callers
            // can access it as conf.settings — mirrors how conf.security is set via merge(files, conf)
            // at the top of loadBundleConfig. Previously implicit through an older conf merge path.
            conf[bundle][env].settings = files['settings'];

            if ( staticsPathObj.existsSync() ) {
                delete require.cache[require.resolve(staticsPath)];
            }


            if (hasViews && typeof(files['statics']) == 'undefined') {
                files['statics'] = requireJSON(staticsPath)
            } else if ( typeof(files['statics']) != 'undefined' ) {
                var defaultAliases = requireJSON(staticsPath);
                // files['statics'] = merge(defaultAliases, files['statics'], true)
                files['statics'] = merge(files['statics'], defaultAliases);
            }


            // public resources ref
            if ( typeof(conf[bundle][env].publicResources) == 'undefined') {
                conf[bundle][env].publicResources = []
            }
            // static resources
            if ( typeof(conf[bundle][env].staticResources) == 'undefined') {
                conf[bundle][env].staticResources = []
            }

            // templates root directories
            var d               = 0
                , dirsOrFiles   = null
                , pCount        = 0
                , sCount        = 0
                , publicPathObj = (conf[bundle][env].publicPath) ? new _(conf[bundle][env].publicPath, true) : null
                , publicPath    = (publicPathObj) ? publicPathObj.toString() : null
            ;
            if (
                publicPath
                && publicPathObj
                && publicPathObj.existsSync()
            ) {
                var publicResources = []
                    , lStat         = null
                ;

                d = 0;
                // reverted: async readdir (#P33) breaks synchronous Config init contract
                try {
                    dirsOrFiles = fs.readdirSync(publicPath);
                } catch (publicReadErr) {
                    return callback(publicReadErr);
                }
                // ignoring html (template files) directory
                //dirsOrFiles.splice(dirsOrFiles.indexOf(new _(reps.html, true).toArray().last()), 1);

                // making statics allowed directories
                while ( d < dirsOrFiles.length) {
                    if ( /^\./.test(dirsOrFiles[d]) ) {
                        ++d;
                        continue;
                    }
                    lStat = fs.lstatSync(_(publicPath +'/'+ dirsOrFiles[d], true));
                    if ( lStat.isDirectory() ) {
                        // regular path
                        publicResources[pCount] = '/'+ dirsOrFiles[d] +'/';
                        ++pCount;
                        if ( conf[bundle][env].server.webroot == "/" ) {
                            ++d;
                            continue;
                        }
                        // handle resources from public with webroot in url
                        publicResources[pCount] = conf[bundle][env].server.webroot + dirsOrFiles[d] +'/';
                        ++pCount
                    } else if ( lStat.isFile() ) {
                        // regular path
                        publicResources[pCount] = '/'+ dirsOrFiles[d];
                        ++pCount;
                        if ( conf[bundle][env].server.webroot == "/" ) {
                            ++d;
                            continue;
                        }
                        // handle resources from public with webroot in url
                        publicResources[pCount] = conf[bundle][env].server.webroot + dirsOrFiles[d];
                        ++pCount
                    }
                    ++d
                }
                d           = null;
                dirsOrFiles = null;

                if (hasWebRoot) {
                    var staticToPublicPath = null;
                    for (let p in files['statics']) {
                        staticToPublicPath =  wroot + p.replace( new RegExp('^'+ wroot), '/');

                        if ( !/\./.test(staticToPublicPath.substring(staticToPublicPath.lastIndexOf('/') )) && !/\/$/.test(staticToPublicPath) )
                            staticToPublicPath += '/';

                        if ( publicResources.indexOf(staticToPublicPath) < 0 )
                            publicResources.push( staticToPublicPath )
                    }
                    staticToPublicPath = null;
                }

                conf[bundle][env].publicResources = publicResources;
            } else if (hasViews) {
                console.warn('['+bundle+'] No public dir to scan...')
            }
            publicPathObj   = null;
            publicPath      = null;


            if (hasViews && typeof(files['templates']) == 'undefined') {
                files['templates'] = JSON.clone(defaultViews)
            }


            if ( typeof(files['templates']) != 'undefined' ) {

                var css     = {
                        name    : '',
                        media   : 'all',
                        rel     : 'stylesheet',
                        type    : 'text/css',
                        url     : '',
                        isCommon : false,
                        // when set to true, allows the framework to load it before gina.min.css
                        isExternalPlugin : false
                    },
                    js      = {
                        name    : '',
                        type    : 'text/javascript',
                        url     : '',
                        isCommon : false,
                        // when set to true, allows the framework to load it before gina.min.js
                        isExternalPlugin : false
                    }
                ;

                var excluded            = {}
                    , excludedType      = null
                    , excludedStr       = null
                    , excludedUrl       = null
                    , currentCollection = null
                    , noneDefaultJs     = null
                    , noneDefaultCss    = null
                    , reWebroot         = new RegExp('^'+conf[bundle][env].server.webroot)
                ;
                var t           = null
                    , tLen      = null
                    , tTmp      = null
                    , url       = null
                    , route     = null
                ;

                // formating _common def for javascripts & stylesheets
                for (let section in files['templates']) {
                    if (!/^_common$/.test(section) ) continue;

                    // inheriting from defaultViews - gina _common
                    files['templates'][section] = merge.setKeyComparison('name')(files['templates'][section], defaultViews[section]);
                    // updating javascripts & css order
                    noneDefaultJs   = (files['templates'][section].javascripts) ? JSON.clone(files['templates'][section].javascripts) : [];
                    noneDefaultCss  = (files['templates'][section].stylesheets) ? JSON.clone(files['templates'][section].stylesheets) : [];

                    if ( Array.isArray(noneDefaultJs) && noneDefaultJs.length > 0 /**&& typeof(noneDefaultJs[0].url) == 'undefined'*/ ) {
                        tTmp    = JSON.clone(noneDefaultJs);
                        t       = 0;
                        tLen    = tTmp.length;
                        noneDefaultJs = [];
                        for (; t < tLen; ++t) {
                            noneDefaultJs[t]            = JSON.clone(js);
                            url                         = tTmp[t];
                            if ( typeof(url) == 'string') {
                                noneDefaultJs[t].url    = url;
                                noneDefaultJs[t].name   = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                                noneDefaultJs[t].isCommon  = ( /^_common$/.test(section) ) ? true : false;
                            } else {
                                noneDefaultJs[t] = merge(url, noneDefaultJs[t]);
                            }
                        }
                    }

                    if ( Array.isArray(noneDefaultCss) && noneDefaultCss.length > 0 /**&& typeof(noneDefaultCss[0].url) == 'undefined'*/ ) {
                        tTmp    = JSON.clone(noneDefaultCss);
                        t       = 0;
                        tLen    = tTmp.length;
                        noneDefaultCss = [];
                        for (; t < tLen; ++t) {
                            noneDefaultCss[t]           = JSON.clone(css);
                            noneDefaultCss[t].route     = section +'@'+ bundle;
                            url                         = tTmp[t];
                            if ( typeof(url) == 'string') {
                                noneDefaultCss[t].url       = url;
                                noneDefaultCss[t].name      = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                            } else {
                                noneDefaultCss[t] = merge(url, noneDefaultCss[t]);
                            }
                        }
                    }

                    files['templates'][section].javascripts = JSON.clone(noneDefaultJs);
                    files['templates'][section].stylesheets = JSON.clone(noneDefaultCss);
                }
                // process other sections
                for (let section in files['templates']) {
                    // skip _common section
                    if (/^_common$/.test(section) ) continue;

                    // updating javascripts & css order
                    noneDefaultJs   = (files['templates'][section].javascripts) ? JSON.clone(files['templates'][section].javascripts) : [];
                    noneDefaultCss  = (files['templates'][section].stylesheets) ? JSON.clone(files['templates'][section].stylesheets) : [];

                    if ( Array.isArray(noneDefaultJs) && noneDefaultJs.length > 0 /**&& typeof(noneDefaultJs[0].url) == 'undefined'*/ ) {
                        tTmp    = JSON.clone(noneDefaultJs);
                        t       = 0;
                        tLen    = tTmp.length;
                        noneDefaultJs = [];
                        for (; t < tLen; ++t) {
                            noneDefaultJs[t]        = JSON.clone(js);
                            url                     = tTmp[t];
                            noneDefaultJs[t].route  = section +'@'+ bundle;
                            if ( typeof(url) == 'string') {
                                noneDefaultJs[t].url    = url;
                                noneDefaultJs[t].name   = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                                noneDefaultJs[t].isCommon  = ( /^_common$/.test(section) ) ? true : false;
                            } else {
                                noneDefaultJs[t] = merge(url, noneDefaultJs[t]);
                            }
                        }
                    }

                    if ( Array.isArray(noneDefaultCss) && noneDefaultCss.length > 0 /**&& typeof(noneDefaultCss[0].url) == 'undefined'*/ ) {
                        tTmp    = JSON.clone(noneDefaultCss);
                        t       = 0;
                        tLen    = tTmp.length;
                        noneDefaultCss = [];
                        for (; t < tLen; ++t) {
                            noneDefaultCss[t]           = JSON.clone(css);
                            url                         = tTmp[t];
                            noneDefaultCss[t].route     = section +'@'+ bundle;
                            let re = new RegExp('\{\s*(.*)\s*\}', 'g');
                            if ( typeof(url) == 'string') {
                                noneDefaultCss[t].url       = url.replace(re, originHostReplacement);
                                noneDefaultCss[t].name      = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                                noneDefaultCss[t].isCommon  = ( /^_common$/.test(section) ) ? true : false;
                            } else {
                                // url replacements
                                for (let prop in url) {
                                    if ( prop != 'url' || prop == 'url' && !url[prop] ) {
                                        continue;
                                    }
                                    // replacing url.url bundle@project -> <scheme>://<domain>:<port>/<webroot>
                                    url[prop] = url[prop].replace(re, originHostReplacement);
                                }
                                noneDefaultCss[t] = merge(url, noneDefaultCss[t]);
                            }
                            // .replace(/\s+/g, '').replace(/([a-z0-9_-]+\@[a-z0-9_-]+|[a-z0-9_-]+\@[a-z0-9_-]+\/[a-z0-9_-]+\@[a-z0-9_-]+)/ig, originHostReplacement)
                        }
                    }



                    if (!files['templates'][section].javascriptsExcluded) {
                        // merging with common javascript def
                        // noneDefaultJs = merge.setKeyComparison('url')(files['templates']._common.javascripts, noneDefaultJs, true);
                        // Fixed on 2023-07-15 - after mergeArray() fix.
                        noneDefaultJs = merge.setKeyComparison('url')(noneDefaultJs, files['templates']._common.javascripts);
                    }
                    // adding gina def
                    if ( !files['templates'][section].javascriptsExcluded || files['templates'][section].javascriptsExcluded != '**' ) {
                        noneDefaultJs   = merge.setKeyComparison('url')(defaultViews._common.javascripts, noneDefaultJs);
                    }


                    if (!files['templates'][section].stylesheetsExcluded) {
                        // merging with common stylesheets def
                        // noneDefaultCss = merge.setKeyComparison('url')(files['templates']._common.stylesheets, noneDefaultCss, true);
                        // Fixed on 2023-07-15 - after mergeArray() fix.
                        noneDefaultCss = merge.setKeyComparison('url')(noneDefaultCss, files['templates']._common.stylesheets);
                    }
                    // adding gina def
                    if ( !files['templates'][section].stylesheetsExcluded || files['templates'][section].stylesheetsExcluded != '**' ) {
                        noneDefaultCss  = merge.setKeyComparison('url')(defaultViews._common.stylesheets, noneDefaultCss);
                    }


                    // force js rechecking on `name` & `url`
                    t = 0;
                    tLen = noneDefaultJs.length;

                    for (; t < tLen; ++t) {

                        if (!noneDefaultJs[t].url) continue;

                        url = noneDefaultJs[t].url;
                        if ( typeof(noneDefaultJs[t].name) == 'undefined' || noneDefaultJs[t].name == '' ) {
                            noneDefaultJs[t].name = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                        }

                        noneDefaultJs[t].type  = ( typeof(noneDefaultJs[t].type) != 'undefined' ) ? noneDefaultJs[t].type : js.type;
                        noneDefaultJs[t].isCommon  = ( typeof(noneDefaultJs[t].isCommon) != 'undefined' ) ? noneDefaultJs[t].isCommon : ( ( /^_common$/.test(section) ) ? true : false );
                        noneDefaultJs[t].route  = ( typeof(noneDefaultJs[t].route) != 'undefined' ) ? noneDefaultJs[t].route : null;

                    }
                    // force css rechecking on `name` & `url`
                    t = 0;
                    tLen = noneDefaultCss.length;
                    for (; t < tLen; ++t) {
                        if (!noneDefaultCss[t].url) continue;

                        url = noneDefaultCss[t].url;
                        if ( typeof(noneDefaultCss[t].name) == 'undefined' || noneDefaultCss[t].name == '' ) {
                            noneDefaultCss[t].name = url.substring(url.lastIndexOf('/')+1, url.lastIndexOf('.')).replace(/\W+/g, '-');
                        }


                        noneDefaultCss[t].rel       = ( typeof(noneDefaultCss[t].rel) != 'undefined' ) ? noneDefaultCss[t].rel : css.rel;
                        noneDefaultCss[t].type      = ( typeof(noneDefaultCss[t].type) != 'undefined' ) ? noneDefaultCss[t].type : css.type;
                        noneDefaultCss[t].isCommon  = ( typeof(noneDefaultCss[t].isCommon) != 'undefined' ) ? noneDefaultCss[t].isCommon : ( ( /^_common$/.test(section) ) ? true : false );
                        noneDefaultCss[t].route     = ( typeof(noneDefaultCss[t].route) != 'undefined' ) ? noneDefaultCss[t].route : null;
                    }


                    files['templates'][section].javascripts = noneDefaultJs;
                    files['templates'][section].stylesheets = noneDefaultCss;


                    excludedType = [];
                    for (let ref in files['templates'][section]) {
                        if ( /^(javascriptsExcluded|stylesheetsExcluded)$/.test(ref) ) {
                            excludedType.push(ref);
                        }
                    }
                    // merging other common properties
                    for (let ref in files['templates']._common) {
                        if ( /^(javascripts|stylesheets)$/.test(ref) ) {
                            continue;
                        }

                        if ( typeof(files['templates'][section][ref]) == 'undefined' ) {
                            files['templates'][section][ref] = files['templates']._common[ref];
                        } else {
                            files['templates'][section][ref] = merge(files['templates'][section][ref], files['templates']._common[ref]);
                        }
                    }

                    // removes common definitions from the common definitions of the current section
                    r = 0;
                    rLen = excludedType.length;
                    if (rLen > 0) {
                        for (; r < rLen; ++r) {
                            //excludedStr = excludedType[r] +'Excluded';
                            excludedStr = excludedType[r];
                            if ( typeof(files['templates'][section][excludedStr]) != 'undefined' ) {

                                let allFilesCollection = new Collection(files['templates'][section][excludedStr.replace(/Excluded$/, '')]);
                                let currentCollectionRaw = allFilesCollection.toRaw();
                                // must be `url` list
                                excluded = ( /string/.test( typeof(files['templates'][section][excludedStr]) ) && !/^(\*|\*\*|all)$/i.test(files['templates'][section][excludedStr]) ) ? files['templates'][section][excludedStr].split(/(\,|\;)/g) : files['templates'][section][excludedStr];
                                if (!Array.isArray(excluded) && !/^(\*|\*\*|all)$/i.test(files['templates'][section][excludedStr])) {
                                    // '/path/to.file' -> ['/path/to.file']
                                    excluded = [excluded];
                                }

                                if (/^(\*|\*\*|all)$/i.test(files['templates'][section][excludedStr])) {
                                    //currentCollection = allFilesCollection.notIn({ name: 'gina'}, 'name').toRaw();
                                    currentCollection = new Collection(allFilesCollection.toRaw());

                                    excluded = [];
                                    for (let e = 0, eLen = currentCollectionRaw.length; e < eLen; e++) {
                                        if (currentCollectionRaw[e].name == 'gina' ) continue;
                                        excluded.push(currentCollectionRaw[e].url);
                                    }
                                } else {
                                    // must be `url` list
                                    currentCollection = new Collection(excluded);
                                }



                                t = 0; tLen = excluded.length;
                                for (; t < tLen; ++t) {
                                    excludedUrl = excluded[t].trim();
                                    for (let e = 0, eLen = currentCollectionRaw.length; e < eLen; e++) {
                                        if (currentCollectionRaw[e].url != excludedUrl[t]) continue;
                                        currentCollection = currentCollection.delete({ 'url': excludedUrl }, 'url');
                                    }
                                }
                                files['templates'][section][excludedStr.replace(/Excluded$/, '')] = currentCollection.toRaw();
                            }
                        }
                    }

                } // EO for section

            }

        } catch (err) {
            console.error(err.stack||err.message||err);
            callback(err);
            return;
        }




        if ( typeof(files['statics']) != 'undefined' ) {
            pCount = conf[bundle][env].publicResources.length || 0;
            sCount = conf[bundle][env].staticResources.length || 0;

            for (let i in files['statics']) {
                if (!/^\//.test(i) ) {
                    files['statics'][ '/'+ i ] = files['statics'][i];
                    delete files['statics'][i];
                    i = '/'+ i
                }

                if ( !/\.(.*)$/.test(i) && !/\/$/.test(i) ) {
                    files['statics'][ i + '/' ] = files['statics'][i];
                    delete files['statics'][i];
                    i += '/'
                }

                // adding to public resources
                if ( conf[bundle][env].publicResources.indexOf(i) < 0 ) {
                    conf[bundle][env].publicResources[pCount] = i;
                    ++pCount;
                }

                // adding to static resources
                if ( conf[bundle][env].staticResources.indexOf(i) < 0 ) {
                    conf[bundle][env].staticResources[sCount] = i;
                    ++sCount;
                }

            }

            // Sort by descending length so more-specific paths are matched before the
            // catch-all root `/` entry in server.js handleStatics prefix-regex loop.
            conf[bundle][env].staticResources.sort(function(a, b) { return b.length - a.length; });
        }

        files = whisper(reps, files);

        if (hasViews) {
            // loading forms rules
            if (typeof(files['templates']._common.forms) != 'undefined') {
                try {
                    files['forms'] = loadForms(files['templates']._common.forms);
                } catch (err) {
                    return callback(err);
                }
            }

            // get error pages
            if (typeof(files['templates']._common.html) != 'undefined') {
                var htmlErrorsFromPath = function(htmlErrorsPath) {
                    var htmlErrorsObj = new _(htmlErrorsPath);
                    if ( htmlErrorsObj.existsSync() ) {
                        var errorFiles = fs.readdirSync( htmlErrorsObj.toUnixStyle() );
                        for (let f = 0, fLen = errorFiles.length; f < fLen; f++) {
                            let errorFilename = _(htmlErrorsPath +'/'+errorFiles[f], true);
                            if (
                                /^\./.test(errorFiles[f])
                                ||
                                fs.statSync(errorFilename).isDirectory()
                            ) {
                                continue;
                            }

                            let eCode = errorFiles[f].replace(/\.(.*)$/, '');
                            if ( typeof(files['templates']._common.errorFiles) == 'undefined' ) {
                                files['templates']._common.errorFiles = {};
                            }
                            if ( typeof(files['templates']._common.errorFiles[eCode]) == 'undefined' ) {
                                files['templates']._common.errorFiles[eCode] = errorFilename;
                            }
                        }
                        errorFiles = null;
                    }
                    htmlErrorsObj = null;
                    htmlErrorsPath = null;
                };
                // first, look into bundles
                htmlErrorsFromPath(files['templates']._common.html+ '/errors');
                // Then, look into shared without overriding existing
                htmlErrorsFromPath(conf[bundle][env].sharedPath + '/errors');
            }
        }

        // plugin loader (frontend framework)
        if ( hasViews && typeof(files['templates']._common.pluginLoader) != 'undefined' ) {
            var loaderSrcPath = null, scriptTag = null;
            loaderSrcPath = files['templates']._common.pluginLoader.replace(/(\{src\:|\}$)/g, '');
            try {
                // will get a buffer
                if (isCacheless) {
                    delete require.cache[require.resolve(_(loaderSrcPath, true))]
                }
                // Attention - ginaLoader cannot be deferred !
                scriptTag = '\n\t\t<script type="text/javascript">'
                scriptTag = scriptTag
                    + '\n\t\t<!--'
                    + '\n\t\t' + fs.readFileSync( _(loaderSrcPath, true)).toString()
                    + '\n\t\t//-->'
                    + '\n\t\t</script>';

                files['templates']._common.ginaLoader = scriptTag;

            } catch (err) {
                callback(err)
            }
        }

        conf[bundle][env].content   = files;
        if ( typeof(conf[bundle][env].content) == 'undefined') {
            conf[bundle][env].content = {}
        }


        conf[bundle][env].bundle    = bundle;
        if (bundle == self.startingApp)
            conf[bundle][env].bundles   = self.getBundles();

        conf[bundle][env].env       = env;
        conf[bundle][env].scope     = scope;

        // this setting is replaced on http requests by the value extracted form the request header
        if (
            typeof(conf[bundle][env].content.settings) != 'undefined'
            && typeof(conf[bundle][env].content.settings.server) != 'undefined'
            && typeof(conf[bundle][env].content.settings.server.protocol) != 'undefined'
            && typeof(conf[bundle][env].content.settings.server.scheme) != 'undefined'
        ) {
            protocol    = conf[bundle][env].server.protocol = conf[bundle][env].content.settings.server.protocol; // from user's bundle/config/settings.json
            scheme      = conf[bundle][env].server.scheme = conf[bundle][env].content.settings.server.scheme; // from user's bundle/config/settings.json

            // getting server port
            conf[bundle][env].server.port = portsReverse[ bundle +'@'+ self.projectName ][env][protocol][scheme];
            appPort = portsReverse[bundle+'@'+self.projectName][env][protocol][scheme];
            conf[bundle][env].port[ protocol ][ scheme ] = appPort;


        } else {
            protocol    = conf[bundle][env].server.protocol;
            scheme      = conf[bundle][env].server.scheme;
        }

        conf[bundle][env].server.supportedRequestMethods = conf[bundle][env].content.settings.server.supportedRequestMethods;
        conf[bundle][env].server.preferedCompressionEncodingOrder = conf[bundle][env].content.settings.server.preferedCompressionEncodingOrder;
        conf[bundle][env].hostname = scheme + '://' + conf[bundle][env].host + ':' + conf[bundle][env].server.port;

        // if ( /^true$/i.test( getContext('isProxyHost') ) ) {
        //     conf[bundle][env].host = process.gina.PROXY_HOST
        //     conf[bundle][env].hostname = process.gina.PROXY_HOSTNAME
        // }
        self.envConf[bundle][env] = conf[bundle][env];

        ++b;
        if (b < bundles.length) {
            loadBundleConfig(bundles, b, callback, reload, collectedRules)
        } else {
            callback(err, files, collectedRules)
        }
    }


    /**
     * Recursively reads form definition JSON files from `formsDir` and returns
     * an object with a `rules` map keyed by dotted path.
     *
     * @inner
     * @private
     * @param {string} formsDir - Absolute path to the bundle's forms directory
     * @returns {object} Form rules object `{ rules: { ... } }`
     */
    var loadForms = function(formsDir) {
        var forms           = { rules: {}}
            , isCacheless   = self.isCacheless()
            , root          = ''
        ;

        if ( new _(formsDir, true).existsSync() ) {
            root = ''+formsDir;
            // browsing dir
            var readDir = function (dir, forms, key, previousKey) {
                var files       = fs.readdirSync(dir)
                    , filename  = ''
                    , k         = null
                ;

                for (let i = 0, len = files.length; i < len; ++i) {
                    if ( !/^\./.test(files[i]) ) {
                        filename = _(dir + '/' + files[i], true);

                        if ( fs.statSync(filename).isDirectory() ) {
                            key += dir.replace(root, '') +'/'+ files[i] + '/';
                            k = key.split(/\//g);
                            forms[k[k.length-2]] = {};
                            // special case for user validators/* directories
                            if ( /validators\/(.*)$/i.test(filename) ) {
                                readDir( filename, forms, key, k[k.length-2] );
                            } else {
                                readDir( filename, forms[ k[k.length-2] ], key );
                            }
                        } else {

                            key = files[i].replace('.json', '').replace(/\-/g, '.');
                            try {

                                if (isCacheless) {
                                    delete require.cache[require.resolve(_(filename, true))];
                                }

                                k = key.split(/\//g);
                                //forms[ k[k.length-1] ] = requireJSON(_(filename, true))
                                if ( /\.json$/.test(filename) && !/validators\/(.*)$/i.test(filename) ) {
                                    forms[ k[k.length-1] ] = requireJSON(_(filename, true))
                                } else if (/\main.js$/.test(filename)) { // ignore other files
                                    forms[ previousKey ] = fs.readFileSync(_(filename, true));
                                }

                            } catch(err) {
                                throw new Error('[ ' +filename + ' ] is malformed !!')
                            }
                        }
                    }
                }
            };

            readDir(formsDir, forms, '/')
        }

        return forms
    }

    /**
     * Triggers configuration loading for all registered bundles by calling
     * `loadBundleConfig` starting at index 0.
     *
     * TODO - simplify / optimize
     *
     * @inner
     * @private
     * @param {function} callback - `function(err, files, collectedRules)` forwarded to `loadBundleConfig`
     */
    var loadBundlesConfiguration = function(callback) {
        //var bundles = self.getBundles();
        var bundles = self.getAllBundles();

        loadBundleConfig(bundles, 0, callback)
    }

    /**
     * Returns `true` when running in dev mode (`NODE_ENV_IS_DEV=true`),
     * meaning module require caches should be bypassed on every request.
     *
     * @memberof module:gina/core/config
     * @returns {boolean} `true` if cacheless (dev) mode is active
     */
    this.isCacheless = function() {
        //Also defined in core/gna.
        return (/^true$/i.test(process.env.NODE_ENV_IS_DEV)) ? true : false;
    }
    /**
     * Returns `true` when the active scope is `local` (`NODE_SCOPE_IS_LOCAL=true`).
     *
     * @memberof module:gina/core/config
     * @returns {boolean}
     */
    this.isLocalScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_LOCAL)) ? true : false;
    }
    /**
     * Returns `true` when the active scope is `production` (`NODE_SCOPE_IS_PRODUCTION=true`).
     *
     * @memberof module:gina/core/config
     * @returns {boolean}
     */
    this.isProductionScope = function() {
        return (/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)) ? true : false;
    }
    /**
     * Reloads all bundle configurations from disk (used in cacheless/dev mode).
     * Calls `loadBundleConfig` over `allBundles` starting at index 0, then
     * invokes `callback` with the refreshed routing rules.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name (reserved; currently not used to filter)
     * @param {function} callback - `function(err, routing)` called on completion
     */
    this.refresh = function(bundle, callback) {
        //Reload conf. who likes repetition ?
        loadBundleConfig(
            self.allBundles,
            0,
            function doneLoadingBundleConfig(err, files, routing) {
                if (!err) {
                    callback(false, routing)
                } else {
                    callback(err)
                }
            }, true)
    }//EO refresh.

    /**
     * Reloads the model files for a bundle/env combination by calling
     * `modelUtil.reloadModels`. Only reloads when the models path exists
     * and the bundle is the currently starting bundle.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name
     * @param {string} env - Environment name
     * @param {function} callback - `function(err)` called on completion
     */
    this.refreshModels = function(bundle, env, callback) {
        var conf            = self.envConf[bundle][env]
            //Reload models.
            , modelsPath    = _(conf.modelsPath, true)
            , modelsPathObj = new _(modelsPath, true)
        ;

        if (
            modelsPathObj.existsSync()
            && self.startingApp == conf.bundle
        ) {
            modelUtil.reloadModels(
                conf,
                function doneReloadingModel(err) {
                    callback(err)
                })
        } else {
            callback(false)
        }
    }

    /**
     * Stores the routing table for a bundle/env/scope combination and merges
     * it into the global `envConf.routing` map.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name
     * @param {string} env - Environment name
     * @param {string} scope - Scope name
     * @param {object} routing - Routing rules object
     */
    this.setRouting = function(bundle, env, scope, routing) {

        if (!self.envConf.routing)
            self.envConf.routing = {};

        if (!self.envConf[bundle][env].content)
            self.envConf[bundle][env].content = {};

        // strip non-object entries (e.g. $schema annotations) before storing —
        // all routing consumers iterate this object and expect only route rule objects
        for (var _k in routing) {
            if (typeof(routing[_k]) != 'object' || routing[_k] === null) delete routing[_k];
        }

        self.envConf[bundle][env].content.routing = routing;
        self.envConf.routing = merge(self.envConf.routing, routing);
    }

    /**
     * Returns the routing table for a specific bundle/env, or the merged global
     * routing map when called without arguments.
     *
     * @memberof module:gina/core/config
     * @param {string} [bundle] - Bundle name; omit to return the global routing map
     * @param {string} [env] - Environment name; defaults to the active env
     * @returns {object} Routing rules object
     */
    this.getRouting = function(bundle, env) {

        if (typeof(env) == 'undefined') {
            env = self.env || self.Env.get()
        }

        if ( typeof(bundle) != 'undefined' ) {
            return self.envConf[bundle][env].content.routing
        }

        return self.envConf.routing;
    }

    /**
     * Stores the reverse routing table for a bundle/env/scope combination and
     * merges it into the global `envConf.reverseRouting` map.
     *
     * @memberof module:gina/core/config
     * @param {string} bundle - Bundle name
     * @param {string} env - Environment name
     * @param {string} scope - Scope name
     * @param {object} reverseRouting - Reverse routing rules object
     */
    this.setReverseRouting = function(bundle, env, scope, reverseRouting) {

        if (!self.envConf.reverseRouting)
            self.envConf.reverseRouting = {};

        if (!self.envConf[bundle][env].content)
            self.envConf[bundle][env].content = {};

        self.envConf[bundle][env].content.reverseRouting = reverseRouting;
        self.envConf.reverseRouting = merge(self.envConf.reverseRouting, reverseRouting);
    }


    if (!opt) {

        /**
         * Replaces the registered bundles list (used when Config is called
         * without `opt` to inject a pre-computed bundle array).
         *
         * @memberof module:gina/core/config
         * @param {string[]} bundles - Array of bundle names
         */
        this.setBundles = function(bundles) {
            self.bundles = bundles
        }

        if (Config.instance)
            return Config.instance;

    } else {

        //Defined before init.
        var env = opt.env, _ready = {err:'not ready', val: null};

        this.env = opt.env;


        /**
         * Registers a one-time listener for the `'config#complete'` event
         * and returns `self` for chaining.
         *
         * @memberof module:gina/core/config
         * @param {function} callback - `function(err, config)` called once config is ready
         * @returns {Config} `self` for chaining
         *
         * @example
         * var config = new Config(opt);
         * config.onReady(function(err, conf) {
         *     if (err) throw err;
         *     // conf.envConf is now populated
         * });
         */
        this.onReady = function(callback) {
            // #B10-fix: if config#complete was already emitted (e.g. because
            // lib.SessionStore(session) triggered Config loading at module-eval time
            // before gna.start() ran), call the callback immediately so the
            // startup sequence is not silently stuck waiting for an event that
            // will never fire again.
            if (Config.initialized && self.bundlesConfiguration) {
                setImmediate(function() {
                    callback(null, self.bundlesConfiguration);
                });
            } else {
                self.once('config#complete', function(err, config) {
                    callback(err, config)
                });
            }
            return self
        };

        init(opt, contextResetNeeded)
    }

    return this
};

Config = inherits(Config, EventEmitter);
module.exports = Config