//"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * Gina Core Bootstrap
 *
 * @package    Gina
 * @author     Rhinostone <contact@gina.io>
 */

var fs              = require('fs');
const { promisify } = require('util');
var EventEmitter    = require('events').EventEmitter;
var e               = new EventEmitter();

// by default
var gna         = {
    core    : {},
    os      : {}
};
var Config      = require('./config');
var config      = null;
// helpers were previously loaded

var lib         = require('./../lib');

var console     = lib.logger;
var Proc        = lib.Proc;
var locales     = require('./locales');
var plugins     = require('./../core/plugins');
var modelUtil   = new lib.Model();



gna.initialized = process.initialized = false;
gna.routed      = process.routed = false;

gna.lib         = lib;
gna.locales     = locales;
gna.plugins     = plugins;


// BO cooking..

var isLoadedThroughCLI      = false; // with gina
var isLoadedThroughWorker   = false;

//copy & backup for lib/cmd/app.js.
var tmp         = JSON.clone(process.argv); // by default
var projectName = null;

// filter $ node.. o $ gina  with or without env
if (process.argv.length >= 3 /**&& /gina$/.test(process.argv[1])*/ ) {

    var ctxObj = null;
    // Workers case
    if ( /(child)\.js$/.test(tmp[1]) || /(child-)(.*)\.js$/.test(tmp[1]) ) {

        isLoadedThroughWorker = true;
        var ctxFilename = null;

        for (var a = 0, aLen = tmp.length; a < aLen; ++a) {

            if (/^--argv-filename=/.test(tmp[a])) {
                ctxFilename = tmp[a].split(/=/)[1];
                console.debug('[ FRAMEWORK ] Found context file `' + ctxFilename +'`' );
                break;
            }
        }


        if (ctxFilename) {

            setContext('argvFilename', _(ctxFilename, true));

            var importedContext = JSON.parse( fs.readFileSync(_(ctxFilename, true)) );

            tmp[2] = {};
            tmp[2].paths = importedContext.paths;
            tmp[2].envVars = importedContext.envVars;
            tmp[2].processList = importedContext.processList;
            tmp[2].ginaProcess = importedContext.ginaProcess;
            tmp[2].debugPort = importedContext.debugPort;

            tmp[3] = importedContext.project || importedContext.config.projectName;
            tmp[4] = importedContext.bundle;

            setContext('env', importedContext.env);
            setContext('scope', importedContext.scope);

            setContext('bundles', importedContext.bundles);
            setContext('debugPort', importedContext.debugPort);

            ctxObj = tmp[2];

        } else {
            throw new Error('[ FRAMEWORK ] No *.ctx file found to import context !')
        }
    } else {
        isLoadedThroughCLI = true;
        try {
            ctxObj = JSON.parse(tmp[2]);
        } catch (contextException) {
            console.error(new Error('[ FRAMEWORK ] Context Exception raised !\nContent (tmp[2]) should be a JSON String: '+ tmp[2] +'\n'+ contextException.stack));
        }
    }


    try {

        require(ctxObj.paths.gina.root + '/utils/helper');

        setContext('paths', ctxObj.paths);//And so on if you need to.

        setContext('processList', ctxObj.processList);
        setContext('ginaProcess', ctxObj.ginaProcess);
        setContext('debugPort', ctxObj.debugPort);

        projectName = tmp[3];
        setContext('projectName', projectName);
        setContext('bundle', tmp[4]);

        var obj = ctxObj.envVars;
        var evar = '';

        if ( typeof(obj) != 'undefined') {

            for (let a in obj) {

                if (
                    a.substr(0, 5) === 'GINA_'
                    || a.substr(0, 7) === 'VENDOR_'
                    || a.substr(0, 5) === 'USER_'
                ) {
                    evar = obj[a];

                    //Boolean values.

                    if (obj[a] === "true") {
                        evar = true
                    }
                    if (obj[a] === "false") {
                        evar = false
                    }

                    setEnvVar(a, evar, true)

                }

            }
            defineDefault(obj)
        }


        //Cleaning process argv.
        if (isLoadedThroughCLI )
            process.argv.splice(2);

    } catch (error) {
        console.error('[ FRAMEWORK ][ configurationError ] ', error.stack || error.message || error);
    }
}

tmp = null;

setPath( 'node', _(process.argv[0]) );

var ginaPath = null;
try {
    ginaPath = getPath('gina').core;
} catch(err) {
    ginaPath = _(__dirname);
    setPath('gina.core', ginaPath);
    ginaPath = getPath('gina').core;
}

if ( typeof(getEnvVar) == 'undefined') {
    console.debug('[ FRAMEWORK ][PROCESS ARGV] Process ARGV error ' + process.argv);
}

// console.debug('[ FRAMEWORK ] GINA_HOMEDIR [' + (GINA_HOMEDIR||null) +'] vs getEnvVar(GINA_HOMEDIR) [' + getEnvVar('GINA_HOMEDIR') +']' );
var projects    = require( _(GINA_HOMEDIR + '/projects.json') );
var root        = projects[projectName].path;

gna.executionPath = root;
setPath('project', root);



setContext('gina.lib', lib);
setContext('gina.Config', Config);
setContext('gina.locales', locales);
setContext('gina.plugins', plugins);



//Setting env.
var env                     = (typeof(process.env.NODE_ENV) != 'undefined' && process.env.NODE_ENV) ? process.env.NODE_ENV : projects[projectName]['def_env']
    , isDev                 = (env === projects[projectName]['dev_env']) ? true: false
    , scope                 = (typeof(process.env.NODE_SCOPE) != 'undefined' && process.env.NODE_SCOPE) ? process.env.NODE_SCOPE : projects[projectName]['def_scope']
    , isLocalScope          = (scope === projects[projectName]['local_scope']) ? true : false
    , isProductionScope     = (scope === projects[projectName]['production_scope']) ? true : false
;

gna.env = process.env.NODE_ENV = env;
gna.scope = process.env.NODE_SCOPE = scope;
gna.os.isWin32 = process.env.isWin32 = isWin32;
gna.isAborting = false;
//Cacheless is also defined in the main config : Config::isCacheless().
process.env.NODE_ENV_IS_DEV = (/^true$/i.test(isDev)) ? true : false;
process.env.NODE_SCOPE_IS_LOCAL = (/^true$/i.test(isLocalScope)) ? true : false;
process.env.NODE_SCOPE_IS_PRODUCTION = (/^true$/i.test(isProductionScope)) ? true : false;
// Proxy check
var proxyPathObj    = new _(projects[projectName].path + '/proxy.json', true);
var proxy           = null;
if ( proxyPathObj.existsSync() ) {
    try {
        var proxyColl   = requireJSON(proxyPathObj.toString());
        proxy       = new lib.Collection(proxyColl).findOne({ scope: process.env.NODE_SCOPE, env: process.env.NODE_ENV });
        proxyColl   = null;
    } catch (proxyErr) {
        console.error('[ FRAMEWORK ][ configurationError ] ', proxyErr.stack || proxyErr.message || proxyErr);
    }

    if (proxy) {
        gna.proxyHostname   = process.gina.PROXY_HOSTNAME    = proxy.hostname;
        gna.proxyHost       = process.gina.PROXY_HOST        = proxy.hostname
                                                                    .replace(/^(https|http)\:\/\//g, '')
                                                                    .replace(/\:\d+\/$|\:\d+$/, '')
        ;
        var proxyPort = gna.proxyHostname.match(/\:\d+\/$|\:\d+$/) || null;
        if (proxyPort) {
            proxyPort = parseInt(proxyPort[0].match(/\d+/));
        } else {
            var foundScheme = gna.proxyHostname.match(/^(https|http)\:\/\//g)[0].replace(/\:\/\//g, '');
            switch (foundScheme) {
                case 'https':
                    proxyPort = 443;
                    break;
                case 'ftp':
                    proxyPort = 21;
                    break;
                case 'sftp':
                    proxyPort = 22;
                    break;
                default:
                    proxyPort = 80;
                    break;
            }
            foundScheme = null;
        }
        gna.proxyPort       = process.gina.PROXY_PORT        = parseInt(proxyPort);

        var isProxyHost = (
            typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
        ) ? true : false;
        // Forcing context - also available for workers
        setContext('isProxyHost', isProxyHost);
    }
}


var bundlesPath = (isDev) ? projects[projectName]['path'] + '/src' : projects[projectName]['path'] + '/bundles';
setPath('bundles', _(bundlesPath, true));


var Router      = require('./router');
setContext('gina.Router', Router);
//TODO require('./server').http
//TODO  - HTTP vs HTTPS
var Server  = require('./server');


var p = new _(process.argv[1]).toUnixStyle().split("/");
var isSym = false;
var path;

var isPath = (/\//).test(process.argv[1]) || (/\\/).test(process.argv[1]);
if (!isPath) {
    //lequel ?
    try {
        isSym = fs.lstatSync( _(bundlesPath +'/'+ process.argv[1]) ).isSymbolicLink();
    } catch (err) {
        //Did not find it ^^.
    }
} else {
    process.argv[1] = _(process.argv[1]);
}


// Todo - load from env.json or locals  or manifest.json ??
/**
 * abort
 *
 * @param {string|object} err
 * @param {string} [bunlde]
 */
var abort = function(err, bundle) {
    gna.isAborting = true;
    if (
        process.argv[2] == '-s' && isLoadedThroughCLI
        || process.argv[2] == '--start' && isLoadedThroughCLI
        //Avoid -h, -v  ....
        || !isLoadedThroughCLI && isPath && process.argv.length > 3

    ) {
        if (isPath && !isLoadedThroughCLI) {
            console.emerg('[ FRAMEWORK ] You are trying to load gina by hand: just make sure that your env ['+env+'] matches the given path ['+ path +']\n'+ (err.stack||err));
        } else if ( typeof(err.stack) != 'undefined' ) {
            console.emerg('[ FRAMEWORK ] Gina could not determine which bundle to load: ' + err +' ['+env+']' + '\n' + err.stack);
        } else {
            console.emerg('[ FRAMEWORK ] Gina could not determine which bundle to load: ' + err +' ['+env+']');
        }
    } else {
        console.emerg(err.stack||err);
    }

    process.exit(1);
};

gna.emit = e.emit;
gna.started = false;

var isBundleMounted = function(projects, bundlesPath, bundle, cb) {
    var isMounted       = false
        , env           = process.env.NODE_ENV
        , scope         = process.env.NODE_SCOPE
        , manisfestPath = null
        , manifest      = null
        , project       = projects[projectName]
    ;
    // supported envs
    setContext('envs', project.envs);
    setContext('scopes', project.scopes);

    // skip this step for workers
    if (isLoadedThroughWorker) {
        return cb(false)
    }
    try {
        manisfestPath   = _(project.path + '/manifest.json', true);
        manifest        = requireJSON(manisfestPath);

        if ( !new _(manisfestPath).existsSync() ) {
            throw new Error('Manifest not found in your project `'+ projectName +'`')
        }

        isMounted = new _( project.path +'/'+ manifest.bundles[bundle].link ).existsSync();


    } catch (err) {
        console.emerg(err);
        return cb(err);
    }

    console.debug('Is `'+ bundle +'` mounted ?', isMounted);
    if (!gna.started && isMounted) {
        new _( project.path +'/'+ manifest.bundles[bundle].link ).rmSync();
        isMounted = false;
    }
    if (!isMounted) {
        var source      = null
            , linkPath  = null
        ;
        try {
            source = (isDev) ? _( root +'/'+manifest.bundles[bundle].src) : _( root +'/'+ manifest.bundles[bundle].releases[scope][env].target );
            linkPath =  _( root +'/'+ manifest.bundles[bundle].link );
            console.debug('Mounting bundle `'+ bundle +'` to : ', linkPath);
        } catch (err) {
            return cb(err)
        }

        gna.mount(bundlesPath, source, linkPath, cb);

    }
}







/**
 * Get project conf from manifest.json
 *
 *
 * @param {function} callback
 * @returns {object} data - Result conf object
 * */
gna.getProjectConfiguration = function (callback){

    var modulesPackage = _(root + '/manifest.json');
    var project     = {}
        , bundles   = [];

    //console.debug('modulesPackage ', modulesPackage, fs.existsSync(modulesPackage));
    //Merging with existing;
    if ( fs.existsSync(modulesPackage) ) {
        try {

            var dep = require(modulesPackage);
            //console.log('ENV: ', env );
            //console.log('PROCESS: ', process.argv );
            //console.log(" now loading....", modulesPackage);
            //console.log('content ', dep);
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
            gna.project = project;

            var bundle = getContext('bundle');
            var bundlePath = getPath('project') + '/';
            bundlePath += ( isDev ) ? project.bundles[ bundle ].src : project.bundles[ bundle ].link;


            for (var b in project.bundles) {
                bundles.push(b)
            }

            setContext('env', env);
            setContext('scope', scope);
            setContext('bundles', bundles);
            setPath('bundle', _(bundlePath, true));
            setPath('helpers', _(bundlePath+'/helpers', true));
            setPath('lib', _(bundlePath+'/lib', true));
            setPath('models', _(bundlePath+'/models', true));
            setPath('controllers', _(bundlePath+'/controllers', true));

            callback(false, project);
        } catch (err) {
            gna.project = project;
            callback(err);
        }

    } else {
        console.warn('[ FRAMEWORK ] Missing project !');
        gna.project = project;
        callback(false, project);
    }
};

/**
 * mount release => bundle
 * @param {string} source
 * @param {string} target
 * @param {string} type
 *
 * @callback callback
 * @param {boolean|string} err
 * */
gna.mount = process.mount = function(bundlesPath, source, target, type, callback){
    if ( typeof(type) == 'function') {
        callback = type;
        type = 'dir';
    }


    //creating folders.
    //use junction when using Win XP os.release == '5.1.2600'
    var mountingPath = getPath('project') + '/bundles';
    console.debug('mounting path: ', mountingPath);
    if ( !fs.existsSync(mountingPath) ) {
        new _(mountingPath).mkdirSync();
    }
    var tmpPath = getPath('project') + '/tmp';
    console.debug('tmp path: ', tmpPath);
    if ( !fs.existsSync(tmpPath) ) {
        new _(tmpPath).mkdirSync();
    }

    var isSourceFound   = fs.existsSync(source)
        , isTargetFound = fs.existsSync(target)
    ;
    console.debug('[ FRAMEWORK ][ MOUNT ] Source: ', source);
    console.debug('[ FRAMEWORK ][ MOUNT ] Checking before mounting ', target, isTargetFound, bundlesPath);
    if ( isTargetFound ) {
        try {
            console.debug('[ FRAMEWORK ][ MOUNT ] removing old build ', target);
            fs.unlinkSync(target)
        } catch (err) {
            callback(err)
        }
    }

    // hack to test none-dev env without building: in case you did not build your bundle, but you have the src available
    if (!isSourceFound && !isDev) {
        var srcPathObj = null;
        try {
            srcPathObj = new _( root +'/'+ gna.project.bundles[gna.core.startingApp].src);
        } catch (buildError) {
            return callback( new Error('Built not found for your selected scope !'));
        }
        if ( srcPathObj.existsSync() ) {
            var d =(d = _(source).split(/\//g)).splice(0, d.length-1).join('/');
            var destinationObj = new _(d);
            if (!destinationObj.existsSync()) {
                destinationObj.mkdirSync();
            }
            srcPathObj.symlinkSync(_(source));
            isSourceFound = true;
        }
    }

    if ( isSourceFound ) {
        //will override existing each time you restart.
        gna.lib.generator.createPathSync(bundlesPath, function onPathCreated(err){
            if (!err) {
                try {
                    var targetObj = new _(target);
                    if ( targetObj.existsSync() ) {
                        targetObj.rmSync();
                    }
                    if ( type != undefined)
                        fs.symlinkSync(source, target, type)
                    else
                        fs.symlinkSync(source, target);

                    // symlink created
                    callback(false);

                } catch (err) {
                    if (err) {
                        console.emerg('[ FRAMEWORK ] '+ (err.stack||err.message));
                        process.exit(1)
                    }
                    if ( fs.existsSync(target) ) {
                        var stats = fs.lstatSync(target);
                        if ( stats.isDirectory() ) {
                            var d = new _(target).rm( function(err){
                                callback(err);
                            })
                        } else {
                            fs.unlinkSync(target);
                            callback(err)
                        }
                    }
                }
            } else {
                console.error(err);
                callback(err)
            }
        });
    } else {
        // Means that it did not find the release. Build and re mount.
        callback( new Error('[ FRAMEWORK ] Did not find a release to mount from: '+ source) )
    }
};


// mounting bundle if needed
isBundleMounted(projects, bundlesPath, getContext('bundle'), function onBundleMounted(err) {
    if (err) {
        return abort(err);
    }
    // get configuration
    gna.getProjectConfiguration( async function onGettingProjectConfig(err, project) {

        if (err) console.error(err.stack);

        /**
         * On middleware initialization
         *
         * @callback callback
         *
         * */
        gna.onInitialize = process.onInitialize = function(callback) {

            gna.initialized = true;
            e.once('init', function(instance, middleware, conf) {

                var configuration = config.getInstance();

                modelUtil.loadAllModels(
                    conf.bundles,
                    configuration,
                    env,
                    function() {

                        joinContext(conf.contexts);
                        gna.getConfig = function(name){
                            var tmp = null;
                            if ( typeof(name) != 'undefined' ) {
                                try {
                                    //Protect it.
                                    tmp = JSON.clone(conf.content[name])
                                } catch (err) {
                                    console.error('[ FRAMEWORK ] ', err.stack);
                                    return undefined
                                }
                            } else {
                                //Protect it.
                                tmp = JSON.clone(conf)
                            }
                            return tmp
                        };
                        try {
                            //configureMiddleware(instance, express); // no, no and no...
                            callback(e, instance, middleware)
                        } catch (err) {
                            // TODO Output this to the error logger.
                            console.error('[ FRAMEWORK ] Could not complete initialization: ', err.stack)
                        }

                    })// EO modelUtil

            })
        }

        /**
         * On Server started
         *
         * @callback callback
         *
         * */
        gna.onStarted = process.onStarted = function(callback) {

            gna.started = true;
            e.once('server#started', function(conf){


                // open default browser for dev env only
                // if ( isDev) {
                //     var payload = JSON.stringify({
                //         code    : 200,
                //         command  : "open"
                //     });

                //     if (self.ioClient) { // if client has already made connexion
                //         payload.command = "reload"
                //     } else {
                //         // get default home
                //         // helper/task::run() should be triggered from ioClient
                //         //run('open', [conf.hostname + conf.server.webroot])
                //     }
                // }

                // will start watchers from here
                callback()
            })
        }

        gna.onRouting = process.onRouting = function(callback) {

            gna.routed = true;
            e.once('route', function(request, response, next, params) {

                try {
                    callback(e, request, response, next, params)
                } catch (err) {
                    // TODO Output this to the error logger.
                    console.error('[ FRAMEWORK ] Could not complete routing: ', err.stack)
                }
            })
        }

        gna.getShutdownConnector = process.getShutdownConnector = function(callback) {
            var connPath = _(bundlesPath +'/'+ appName + '/config/connector.json');
            fs.readFile(connPath, function onRead(err, content) {
                try {
                    callback(err, JSON.parse(content).httpClient.shutdown)
                } catch (err) {
                    callback(err)
                }
            })
        }

        gna.onError = process.onError = function(callback) {
            gna.errorCatched = true;
            e.on('error', function(err, request, response, next) {

                callback(err, request, response, next)
            })
        }

        gna.getShutdownConnectorSync = process.getShutdownConnectorSync = function() {
            var connPath = _(bundlesPath +'/'+ appName + '/config/connector.json');
            try {
                var content = fs.readFileSync(connPath);
                return JSON.parse(content).httpClient.shutdown
            } catch (err) {
                return undefined
            }
        }

        gna.getMountedBundles = process.getMountedBundles = function(callback) {
            fs.readdir(bundlesPath, function onRead(err, files) {
                callback(err, files)
            })
        }

        gna.getMountedBundlesSync = process.getMountedBundlesSync = function() {
            try {
                return fs.readdirSync(bundlesPath)
            } catch (err) {
                return err.stack
            }
        }

        gna.getRunningBundlesSync = process.getRunningBundlesSync = function() {

            //TODO - Do that thru IPC or thru socket. ???
            var pidPath = _(getPath('globalTmpPath') +'/pid');
            var files = fs.readdirSync(pidPath);

            var name = '';
            var indexTmp = null;

            var content = [];
            var contentGina = [];
            var shutdown = [];
            var shutdownGina = [];

            var bundleGinaPid = getContext('ginaProcess');

            //Sort Bundle / Gina instance to get a array [BUNDLE,GINA,SHUTDOWN,GINASHUTDOWN].
            for (var f=0; f<files.length; ++f) {

                name = fs.readFileSync( _(pidPath +'/'+ files[f]) ).toString();

                if ( name == "shutdown" ) {
                    shutdown[0] = {};
                    shutdown[0]['pid']  = files[f];
                    shutdown[0]['name'] = name;
                    shutdown[0]['path'] = _(pidPath +'/'+ files[f]);
                } else if ( files[f] == bundleGinaPid ){
                    shutdownGina[0] = {};
                    shutdownGina[0]['pid']  = files[f];
                    shutdownGina[0]['name'] = name;
                    shutdownGina[0]['path'] = _(pidPath +'/'+ files[f]);
                } else if ( name == "gina" ) {
                    indexTmp = contentGina.length;
                    contentGina[indexTmp] = {};
                    contentGina[indexTmp]['pid']  = files[f];
                    contentGina[indexTmp]['name'] = name;
                    contentGina[indexTmp]['path'] = _(pidPath +'/'+ files[f]);
                } else {
                    indexTmp = content.length;
                    content[indexTmp] = {};
                    content[indexTmp]['pid']  = files[f];
                    content[indexTmp]['name'] = name;
                    content[indexTmp]['path'] = _(pidPath +'/'+ files[f]);
                }
            }

            //Remove GINA instance, avoid killing gina bundle before/while bundle is remove.
            //Bundle kill/remove gina instance himself.
            //content = content.concat(contentGina);
            content = content.concat(shutdown);
            content = content.concat(shutdownGina);

            return content
        }

        gna.getVersion = process.getVersion = function(bundle) {
            var name = bundle || appName;
            name = name.replace(/gina: /, '');

            if ( name != undefined) {
                try {
                    var str = fs.readFileSync( _(bundlesPath + '/' + bundle + '/config/app.json') ).toString();
                    var version = JSON.parse(str).version;
                    return version
                } catch (err) {
                    return err
                }
            } else {
                return undefined
            }
        }

        /**
         * Start server
         *
         * @param {string} [executionPath]
         * */
        gna.start = process.start = function() { //TODO - Add protocol in arguments

            var core    = gna.core;
            //Get bundle name.
            if (appName == undefined) {
            appName = getContext('bundle')
            }

            if (projectName == undefined) {
                projectName = getContext('projectName')
            }


            core.projectName        = projectName;
            core.startingApp        = appName; // bundleName
            core.executionPath      = root;
            core.ginaPath           = ginaPath;


            //Inherits parent (gina) context.
            if ( typeof(process.argv[3]) != 'undefined' ) {
                setContext( JSON.parse(process.argv[3]) )
            }

            if (!Config.instance) {
                config = new Config({
                    env             : env,
                    scope           : scope,
                    executionPath   : core.executionPath,
                    projectName     : core.projectName,
                    startingApp     : core.startingApp,
                    ginaPath        : core.ginaPath
                });
            } else {
                config = Config.instance
            }


            setContext('gina.config', config);
            config.onReady( function(err, obj){
                var isStandalone = obj.isStandalone;

                if (err) console.error(err, err.stack);

                var initialize = function(err, instance, middleware, conf) {
                    var errMsg = null;
                    if (!err) {

                        //On user conf complete.
                        e.on('complete', function(instance){

                            server.on('started', async function (conf) {

                                // setting default global middlewares
                                if ( typeof(instance.use) == 'function' ) {

                                    // catching unhandled errors
                                    instance.use( function cathUnhandledErrorMiddlewar(error, request, response, next){

                                        if (arguments.length < 4) {
                                            next        = response;
                                            response    = request;
                                            request     = error;
                                            error       = false ;
                                        }

                                        if (error) {
                                            e.emit('error', error, request, response, next)
                                        } else {
                                            next()
                                        }
                                    });


                                    instance.use( function composeHeadersMiddleware(error, request, response, next) {

                                        if (arguments.length < 4) {
                                            next        = response;
                                            response    = request;
                                            request     = error;
                                            error       = false ;
                                        }

                                        if (error) {
                                            return e.emit('error', error, request, response, next);
                                        }

                                        instance.completeHeaders(null, request, response);

                                        if (
                                            typeof(request.isPreflightRequest) != 'undefined'
                                            && request.isPreflightRequest
                                        ) {
                                            var ext = 'html';
                                            var headers = {
                                                // Responses to the OPTIONS method are not cacheable. - https://tools.ietf.org/html/rfc7231#section-4.3.7
                                                //'cache-control': 'no-cache, no-store, must-revalidate', // preventing browsers from using cache
                                                'cache-control': 'no-cache',
                                                'pragma': 'no-cache',
                                                'expires': '0',
                                                'content-type': conf.server.coreConfiguration.mime[ext]
                                            };

                                            response.writeHead(200, headers);
                                            response.end();

                                        }
                                        else {
                                            next(false, request, response)
                                        }

                                    })
                                }


                                e.emit('server#started', conf);

                                setTimeout( async function onStarted() {

                                    if (
                                        conf.server.scheme == 'https'
                                        && !/^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION)
                                    ) {
                                        try {
                                            await server.verifyCertificate(conf.host, conf.server.port);
                                        } catch (err) {
                                            // console.emerg(err.stack);
                                            throw err;
                                        }
                                    }

                                    console.info('is now online V(-.o)V',
                                    '\nbundle: [ ' + conf.bundle +' ]',
                                    '\nenv: [ '+ conf.env +' ]',
                                    '\nscope: [ '+ conf.scope +' ]',
                                    '\nengine: ' + conf.server.engine,
                                    '\nprotocol: ' + conf.server.protocol,
                                    '\nscheme: ' + conf.server.scheme,
                                    '\nport: ' + conf.server.port,
                                    '\ndebugPort: ' + conf.server.debugPort,
                                    '\npid: ' + process.pid,
                                    '\nThis way please -> '+ conf.hostname + conf.server.webroot
                                    );
                                    // placing end:flag to allow the CLI to retrieve bundl info from here
                                    console.notice('[ FRAMEWORK ] Bundle started !');
                                }, 700); // 1000 - Wait to make sure that the bundle is mounted on the file system
                            });

                            // placing strat:flag to allow the CLI to retrieve bundl info from here
                            console.notice('[ FRAMEWORK ][ '+ process.pid +' ] '+ conf.bundle +'@'+ core.projectName +' mounted !');
                            server.start(instance);

                        });

                        // -- BO
                        e.emit('init', instance, middleware, conf);
                        //In case there is no user init.
                        if (!gna.initialized) {
                            e.emit('complete', instance);
                        }
                        // -- EO

                    } else {
                        errMsg = new Error('[ FRAMEWORK ] '+ (err.stack||err.message));
                        console.error(errMsg);
                    }
                };

                var opt = {
                    projectName     : core.projectName,
                    bundle          : core.startingApp,
                    //Apps list.
                    bundles         : obj.bundles,
                    allBundles      : obj.allBundles,
                    env             : obj.env,
                    scope           : obj.scope,
                    isStandalone    : isStandalone,
                    executionPath   : core.executionPath,
                    conf            : obj.conf
                };

                var server = new Server(opt);
                server.onConfigured(initialize);
            })//EO config.
        }

        /**
         * Stop server
         * */
        gna.stop = process.stop = function(pid, code) {
            console.info('[ FRAMEWORK ] Stopped service');
            if (typeof(code) != 'undefined')
                process.exit(code);

            process.exit()
        }

        /**
         * Get Status
         * */
        gna.status = process.status = function(bundle) {
            console.info('[ FRAMEWORK ] Getting service status')
        }
        /**
         * Restart server
         * */
        gna.restart = process.restart = function() {
            console.info('[ FRAMEWORK ] Starting service')
        }



        var appName = null
            , path  = null
            , packs = project.bundles
        ;
        if (isLoadedThroughCLI) {
            appName = getContext('bundle');
            if (!isPath) {
                //appName = getContext('bundle');
                if (typeof (packs[appName].version) == 'undefined' && typeof (packs[appName].tag) != 'undefined') {
                    packs[appName].version = packs[appName].tag
                }
                packs[appName].releases[scope][env].target = 'releases/' + appName + '/' + scope + '/' + env + '/' + packs[appName].version;
                path = (isDev) ? packs[appName].src : packs[appName].releases[scope][env].target
            } else {
                path = _(process.argv[1])
            }
        } else {
            path = _(process.argv[1])
        }

        path = path.replace(root + '/', '');

        if ((/index.js/).test(path) || p[p.length - 1] == 'index') {
            var _self = null;
            path = (_self = path.split('/')).splice(0, _self.length - 1).join('/');
            _self = null;
        }

        try {
            var projectName     = null;
            var processList     = null;
            var bundleProcess   = null;
            //finding app.
            if (!isLoadedThroughWorker) {

                for (let bundle in packs) {
                    //is bundle ?
                    let tmp = '';
                    // For all but dev
                    if (
                        typeof (packs[bundle].releases) != 'undefined'
                        && !isDev
                    ) {
                        if (
                            typeof (packs[bundle].version) == 'undefined'
                            && typeof (packs[bundle].tag) != 'undefined'
                        ) {
                            packs[bundle].version = packs[bundle].tag
                        }
                        packs[bundle].releases[scope][env].target = 'releases/' + bundle + '/' + scope + '/' + '/' + env + '/' + packs[bundle].version;
                        tmp = packs[bundle].releases[scope][env].target.replace(/\//g, '').replace(/\\/g, '');

                        if (!appName && tmp == path.replace(/\//g, '').replace(/\\/g, '')) {
                            appName = bundle;
                            break
                        }
                    } else if (
                        typeof (packs[bundle].src) != 'undefined' && isDev
                    ) {

                        tmp = packs[bundle].src.replace(/\//g, '').replace(/\\/g, '');
                        if (tmp == path.replace(/\//g, '').replace(/\\/g, '')) {
                            appName = bundle;
                            break
                        }
                    } else {
                        abort('Path mismatched with env: ' + path);
                    }
                    // else, not a bundle
                } // EO for (let bundle in packs) {

                if ( /^true$/i.test(gna.isAborting) ) {
                    return;
                }

                if (appName == undefined) {
                    setContext('bundle', undefined);
                    abort('No bundle found for path: ' + path)
                } else {
                    setContext('bundle', appName);
                    //to remove after merging gina processes into a single process.
                    projectName = getContext('projectName');
                    processList = getContext('processList');
                    process.list = processList;
                    bundleProcess = new Proc(appName + '@' + projectName, process);
                    bundleProcess.register(appName + '@' + projectName, process.pid);
                }

            } else {
                appName = getContext('bundle');
                projectName = getContext('projectName');
                processList = getContext('processList');
                process.list = processList;
                bundleProcess = new Proc(appName + '@' + projectName, process);
                bundleProcess.register(appName + '@' + projectName, process.pid)
            }
        } catch (err) {
            abort(err)
        }


    });//EO onDoneGettingProjectConfiguration.
});
module.exports = gna