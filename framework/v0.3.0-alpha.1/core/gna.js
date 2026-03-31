//"use strict";
/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * @module gina/core/gna
 */
/**
 * Gina core bootstrap. Initialises the framework process, mounts bundles, and
 * exposes the `gna` / `process` lifecycle API to bundle code:
 *  - gna.onInitialize / gna.onStarted / gna.onRouting / gna.onError
 *  - gna.start / gna.stop / gna.restart / gna.status
 *  - gna.mount / gna.getProjectConfiguration
 *  - gna.getMountedBundles / gna.getMountedBundlesSync / gna.getRunningBundlesSync
 *  - gna.getShutdownConnector / gna.getShutdownConnectorSync
 *  - gna.getVersion
 *
 * All `gna.X` are also aliased to `process.X` so bundle controllers can call
 * `process.onStarted(cb)` etc. without importing gna directly.
 */

var fs              = require('fs');
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
        + '] [debug  ][gina:gna] ' + msg + '\u001b[39m\n');
};
const os            = require('os');
process.env.UV_THREADPOOL_SIZE = (os.cpus().length);
// #P1 — V8 bytecode cache. Node.js >= 22.8 caches compiled modules to disk so
// subsequent starts skip parsing and recompilation (30–60% faster cold start).
// No-op on older Node versions — safe to set unconditionally.
if (!process.env.NODE_COMPILE_CACHE) {
    process.env.NODE_COMPILE_CACHE = os.homedir() + '/.gina/cache/v8';
}

// #P4 — V8 pointer compression detection.
// Node.js built with --experimental-enable-pointer-compression (e.g. node-caged,
// or a custom build like the freelancer image) caps each V8 isolate at a 4 GB heap
// in exchange for ~50% memory reduction across all pointer-heavy structures
// (objects, arrays, linked lists). Detection: heap_size_limit ≤ 4 GB is the hard
// ceiling imposed by 32-bit pointer offsets within a 4 GB memory cage.
// Sets GINA_V8_POINTER_COMPRESSED=true so connectors and bundle code can react.
// Note: --max-old-space-size above 4096 has no effect on pointer-compressed builds.
(function() {
    var _heapLimit = require('v8').getHeapStatistics().heap_size_limit;
    if (_heapLimit <= 4 * 1024 * 1024 * 1024) {
        process.env.GINA_V8_POINTER_COMPRESSED = 'true';
        process.stdout.write('[gina] V8 pointer compression active — heap limit: '
            + Math.round(_heapLimit / (1024 * 1024)) + ' MB per isolate\n');
    }
}());

const { promisify } = require('util');
var EventEmitter    = require('events').EventEmitter;
var e               = new EventEmitter();
// TODO - Get from config/security:defaultMaxListeners
e.setMaxListeners(20);

// by default
var gna         = {
    core    : {},
    os      : {}
};
var Config      = require('./config');
var config      = null;
// helpers were previously loaded

_debugLog('checkpoint A: loading lib');
var lib         = require('./../lib');
_debugLog('checkpoint B: lib loaded, setting up logger');

var console     = lib.logger;
_debugLog('checkpoint C: logger ready');
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
        process.env.NODE_BUNDLE = tmp[4];
        process.env.NODE_PROJECT = projectName;

        var obj = ctxObj.envVars;
        var evar = '';

        if ( typeof(obj) != 'undefined') {

            for (let a in obj) {

                if (
                    a.substring(0, 5) === 'GINA_'
                    || a.substring(0, 7) === 'VENDOR_'
                    || a.substring(0, 5) === 'USER_'
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
var reversePorts    = require( _(GINA_HOMEDIR + '/ports.reverse.json') );
var projects        = require( _(GINA_HOMEDIR + '/projects.json') );
var root            = projects[projectName].path;

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
    , port                  = reversePorts[process.env.NODE_BUNDLE +'@'+ process.env.NODE_PROJECT][env][projects[projectName]['def_protocol']][projects[projectName]['def_scheme']]
    , scheme                = projects[projectName]['def_scheme']
;

gna.env = process.env.NODE_ENV = env;
gna.scope = process.env.NODE_SCOPE = scope;
gna.os.isWin32 = process.env.isWin32 = isWin32;
gna.isAborting = false;
//Cacheless is also defined in the main config : Config::isCacheless().
process.env.NODE_ENV_IS_DEV = (/^true$/i.test(isDev)) ? true : false;
process.env.NODE_SCOPE_IS_LOCAL = (/^true$/i.test(isLocalScope)) ? true : false;
process.env.NODE_SCOPE_IS_PRODUCTION = (/^true$/i.test(isProductionScope)) ? true : false;
process.env.NODE_PORT = parseInt(port);
// Proxy check thru proxy.json [Optional]
var proxyPathObj    = new _(projects[projectName].path + '/proxy.json', true);
var proxy           = null;
var proxyPort       = null;
if ( proxyPathObj.existsSync() ) {
    try {
        var proxyColl   = requireJSON(proxyPathObj.toString());
        proxy       = new lib.Collection(proxyColl).findOne({ scope: process.env.NODE_SCOPE, env: process.env.NODE_ENV });
        proxyColl   = null;
    } catch (proxyErr) {
        console.error('[ FRAMEWORK ][ configurationError ] ', proxyErr.stack || proxyErr.message || proxyErr);
    }
} else { // default proxy
    proxy = {};
    proxy.id = scope +"_"+ env;
    proxy.scope = scope;
    proxy.env = env;
    // "https://my.domain.tld"
    proxy.hostname = null ;
    proxyPort = process.gina.PROXY_PORT = port;
}

if (proxy) {
    var foundScheme = null;
    if (proxy.hostname) {
        gna.proxyHostname   = process.gina.PROXY_HOSTNAME    = proxy.hostname;
        gna.proxyHost       = process.gina.PROXY_HOST        = proxy.hostname
                                                                    .replace(/^(https|http)\:\/\//g, '')
                                                                    .replace(/\:\d+\/$|\:\d+$/, '')
        ;
        proxyPort = gna.proxyHostname.match(/\:\d+\/$|\:\d+$/) || null;

        if (proxyPort) {
            proxyPort = parseInt(proxyPort[0].match(/\d+/));
        } else {
            foundScheme = gna.proxyHostname.match(/^(https|http)\:\/\//g)[0].replace(/\:\/\//g, '');
        }
    } else {
        foundScheme = scheme;
    }
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


    gna.proxyPort       = process.gina.PROXY_PORT        = parseInt(proxyPort);
    gna.proxyScheme     = process.gina.PROXY_SCHEME      = scheme;

    var isProxyHost = (
        typeof(process.gina.PROXY_HOSTNAME) != 'undefined'
    ) ? true : false;
    // Forcing context - also available for workers
    setContext('isProxyHost', isProxyHost);
}



var bundlesPath = (isDev) ? projects[projectName]['path'] + '/src' : projects[projectName]['path'] + '/bundles';
setPath('bundles', _(bundlesPath, true));


_debugLog('checkpoint D0: loading Router');
var Router      = require('./router');
setContext('gina.Router', Router);
//TODO require('./server').http
//TODO  - HTTP vs HTTPS
_debugLog('checkpoint D1: loading Server');
var Server  = require('./server');
_debugLog('checkpoint D2: Server loaded');


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
 * Logs a fatal error and terminates the process.
 * Formats the message differently depending on whether gina was loaded through
 * the CLI, a worker, or a manual `node` invocation.
 *
 * @memberof module:gina/core/gna
 * @param {string|Error} err - Error or message to log
 * @param {string} [bundle] - Bundle name involved in the failure
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

/**
 * Checks whether a bundle has a release entry in the project manifest and is
 * therefore considered "mounted" (ready to start). Skips the check for worker
 * processes and calls `cb(false)` immediately in that case.
 *
 * @memberof module:gina/core/gna
 * @param {object} projects - Projects registry from ~/.gina/projects.json
 * @param {string} bundlesPath - Absolute path to the project's bundles directory
 * @param {string} bundle - Bundle name to check
 * @param {function} cb - Node-style callback `function(err, isMounted)`
 */
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
            if (err.message) {
                console.error("Make sure that your "+ project.path +"/manifest.json is not corrupted and that the `target` scope `path` is defined.")
            }
            return cb(err)
        }

        gna.mount(bundlesPath, source, linkPath, cb);

    }
}







/**
 * Reads the project's manifest.json and resolves the bundle list.
 * Merges the manifest into the `project` object and calls `callback(err, project)`.
 *
 * @memberof module:gina/core/gna
 * @param {function} callback - Node-style callback `function(err, project)`
 * @param {boolean|Error} callback.err - False on success, Error on failure
 * @param {object} callback.project - Parsed project manifest
 */
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
 * Mounts a bundle release directory into the project's bundles/ directory
 * by creating required folders (bundles, tmp, cache) and symlinking the source.
 * When `type` is omitted it defaults to `'dir'`.
 *
 * Also exposed as `process.mount`.
 *
 * @memberof module:gina/core/gna
 * @param {string} bundlesPath - Absolute path to the project's bundles directory
 * @param {string} source - Source release path to mount
 * @param {string} target - Target symlink/directory path inside bundles/
 * @param {string} [type='dir'] - Mount type: 'dir' or 'junction'
 * @param {function} callback - Node-style callback `function(err)`
 */
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
    // /tmp
    var tmpPath = getPath('project') + '/tmp';
    console.debug('tmp path: ', tmpPath);
    var tmpPathObj = new _(tmpPath);
    if ( !tmpPathObj.existsSync() ) {
        tmpPathObj.mkdirSync();
    }
    tmpPathObj = null;

    // cache
    var cachePath = getPath('project') + '/cache';
    console.debug('cache path: ', cachePath);
    var cachePathObj = new _(cachePath);
    if ( !cachePathObj.existsSync() ) {
        cachePathObj.mkdirSync();
    }
    cachePathObj = null;

    var sourceObj = new _(source);
    var targetObj = new _(target);

    var isSourceFound   = sourceObj.existsSync()
        , isTargetFound = targetObj.existsSync()
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
            console.debug('[ FRAMEWORK ][ MOUNT ] Linking ['+ srcPathObj.toString() +'] to [ '+ _(source) +' ] ');
            srcPathObj.symlinkSync(_(source));
            isSourceFound = true;
        }
    }

    if ( isSourceFound ) {
        //will override existing each time you restart.
        gna.lib.generator.createPathSync(bundlesPath, function onPathCreated(err){
            if (!err) {
                try {
                    // var targetObj = new _(target);
                    if ( targetObj.existsSync() ) {
                        targetObj.rmSync();
                    }
                    console.debug('[ FRAMEWORK ][ MOUNT ] Linking ['+ source +'] to [ '+ target +' ] ');
                    if ( type != undefined) {
                        fs.symlinkSync(source, target, type)
                    } else {
                        fs.symlinkSync(source, target);
                    }
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
process.on('unhandledRejection', function(reason) {
    console.error('[ FRAMEWORK ] Unhandled promise rejection:', (reason && reason.stack) ? reason.stack : String(reason));
});
process.on('exit', function(code) {
});
_debugLog('checkpoint D: calling isBundleMounted');
isBundleMounted(projects, bundlesPath, getContext('bundle'), function onBundleMounted(err) {
    if (err) {
        return abort(err);
    }
    _debugLog('checkpoint E: isBundleMounted OK, calling getProjectConfiguration');
    // get configuration
    gna.getProjectConfiguration( async function onGettingProjectConfig(err, project) {

        if (err) {
            console.error(err.stack);
        }

        /**
         * Registers a callback to run when the framework middleware is initialised.
         * Loads all models for the project's bundles, then fires the callback with
         * `(instance, middleware, conf)` when the 'init' event is emitted.
         *
         * Also exposed as `process.onInitialize`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Called with `(instance, middleware, conf)` after models load
         */
        gna.onInitialize = process.onInitialize = function(callback) {
            console.debug('[ FRAMEWORK ] Bootstrap Initialization... ');
            gna.initialized = true;

            e.once('init', function(instance, middleware, conf) {

                var configuration = config.getInstance();

                _debugLog('checkpoint K1: calling loadAllModels bundles=' + JSON.stringify(conf.bundles));
                modelUtil.loadAllModels(
                    conf.bundles,
                    configuration,
                    env,
                    function() {
                        _debugLog('checkpoint K2: loadAllModels done');

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
                        _debugLog('checkpoint K3: conf.settings=' + (typeof(conf.settings) !== 'undefined' ? 'defined' : 'UNDEFINED') + ' conf.security=' + (typeof(conf.security) !== 'undefined' ? 'defined' : 'UNDEFINED'));
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
         * Registers a callback to run once the HTTP server is listening.
         * Fired by the 'server#started' event. Useful for starting file watchers
         * or opening a browser in dev mode.
         *
         * Also exposed as `process.onStarted`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Called with no arguments when the server is ready
         */
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

                // #R1 — start user-defined watchers declared in watchers.json via WatcherService.
                // conf.watchers is the parsed content of the bundle's watchers.json (auto-loaded
                // by config.js). conf.bundlePath is the absolute bundle source directory.
                // #M6 — in dev mode the WatcherService is always started even without a
                // watchers.json, so the router can skip require.cache eviction on requests
                // where no file has changed (file-change-triggered eviction).
                var _watchersConf = (conf && conf.watchers && typeof conf.watchers === 'object')
                    ? conf.watchers
                    : null;
                var _hasUserWatchers = _watchersConf && Object.keys(_watchersConf).some(function(k) {
                    return k.charAt(0) !== '$';
                });
                if (lib.Watcher && (isDev || _hasUserWatchers)) {
                    var _watcher   = new lib.Watcher();
                    var _configDir = conf.bundlePath + '/config';

                    if (isDev) {
                        // #M6 — register core controller files and the bundle controllers
                        // directory. The router checks __hotReload dirty flags instead of
                        // evicting require.cache on every request.
                        var _hotDirty = { core: false, action: false };
                        setContext('__hotReload', _hotDirty);

                        var _corePath = getPath('gina').core;
                        _watcher.register('__hot_core_controller__', _corePath + '/controller/controller.js');
                        _watcher.on('__hot_core_controller__', function() { _hotDirty.core = true; });

                        _watcher.register('__hot_core_swig__', _corePath + '/controller/controller.render-swig.js');
                        _watcher.on('__hot_core_swig__', function() { _hotDirty.core = true; });

                        _watcher.register('__hot_controllers__', conf.bundlePath + '/controllers');
                        _watcher.on('__hot_controllers__', function() { _hotDirty.action = true; });
                    }

                    if (_hasUserWatchers) {
                        _watcher.load(_configDir, _watchersConf);
                    }

                    _watcher.start();
                    // expose so #M6 and user bundle code can register against the same instance
                    gna.watcher = _watcher;
                }
                callback()
            })
        }

        /**
         * Registers a callback to be invoked on every routed HTTP request.
         * The callback receives `(e, request, response, next, params)`.
         * Also exposed as `process.onRouting`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Called with `(emitter, request, response, next, params)`
         */
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

        /**
         * Asynchronously reads the bundle's connector.json and returns the
         * `httpClient.shutdown` config section via callback.
         * Also exposed as `process.getShutdownConnector`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Node-style callback `function(err, shutdownConf)`
         */
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

        /**
         * Registers a persistent error handler for framework-level errors.
         * The callback receives `(err, request, response, next)`.
         * Unlike onInitialize/onStarted, this uses `e.on` (not `.once`).
         * Also exposed as `process.onError`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Called with `(err, request, response, next)` on each error
         */
        gna.onError = process.onError = function(callback) {
            gna.errorCatched = true;
            e.on('error', function(err, request, response, next) {

                callback(err, request, response, next)
            })
        }

        /**
         * Synchronously reads the bundle's connector.json and returns the
         * `httpClient.shutdown` config section. Returns `undefined` on error.
         * Also exposed as `process.getShutdownConnectorSync`.
         *
         * @memberof module:gina/core/gna
         * @returns {object|undefined} The shutdown connector config, or undefined if not found
         */
        gna.getShutdownConnectorSync = process.getShutdownConnectorSync = function() {
            var connPath = _(bundlesPath +'/'+ appName + '/config/connector.json');
            try {
                var content = fs.readFileSync(connPath);
                return JSON.parse(content).httpClient.shutdown
            } catch (err) {
                return undefined
            }
        }

        /**
         * Asynchronously lists the entries in the project's bundles directory.
         * Also exposed as `process.getMountedBundles`.
         *
         * @memberof module:gina/core/gna
         * @param {function} callback - Node-style callback `function(err, files)`
         */
        gna.getMountedBundles = process.getMountedBundles = function(callback) {
            fs.readdir(bundlesPath, function onRead(err, files) {
                callback(err, files)
            })
        }

        /**
         * Synchronously lists the entries in the project's bundles directory.
         * Returns an error stack string on failure.
         * Also exposed as `process.getMountedBundlesSync`.
         *
         * @memberof module:gina/core/gna
         * @returns {string[]|string} Array of bundle directory entries, or error stack on failure
         */
        gna.getMountedBundlesSync = process.getMountedBundlesSync = function() {
            try {
                return fs.readdirSync(bundlesPath)
            } catch (err) {
                return err.stack
            }
        }

        /**
         * Synchronously reads the global pid directory and returns two arrays:
         * running bundle pids and the gina master pid list.
         * Also exposed as `process.getRunningBundlesSync`.
         *
         * @memberof module:gina/core/gna
         * @returns {Array[]} Tuple `[bundlePids, ginaPids]` — arrays of PID objects
         */
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

        /**
         * Reads the version field from a bundle's config/app.json.
         * Defaults to the current running bundle when `bundle` is omitted.
         * Also exposed as `process.getVersion`.
         *
         * @memberof module:gina/core/gna
         * @param {string} [bundle] - Bundle name; defaults to the running bundle
         * @returns {string|Error|undefined} Version string, Error on read failure, or undefined
         */
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
         * Starts the server for the current bundle.
         * Reads the bundle name and project name from the global context,
         * inherits the parent gina context from `process.argv[3]` (JSON-serialised),
         * creates a Config instance (or reuses the existing singleton), then
         * waits for `config.onReady` before constructing the Server and calling
         * `server.start(instance)` once the engine emits `'complete'`.
         * Emits `'init'` with `(instance, middleware, conf)` so user bundles can
         * attach their own initialisation logic.
         * Also exposed as `process.start`.
         *
         * @memberof module:gina/core/gna
         * @returns {void}
         */
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
            // Fixed (#B9): in CLI mode (gina bundle:start) process.argv[3] is the project
            // name (plain string), not a JSON blob. JSON.parse("projectName") always threw
            // SyntaxError, triggering uncaughtException → process.exit(143), which the
            // start.js child watcher did not handle, causing every bundle:start to time out.
            // Guard: only parse when the value looks like a JSON object.
            if ( typeof(process.argv[3]) != 'undefined' && /^\{/.test(process.argv[3]) ) {
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
            _debugLog('checkpoint F: calling config.onReady');
            config.onReady( function(err, obj){
                _debugLog('checkpoint G: config.onReady fired err=' + (err ? (err.message||err) : 'none'));
                var isStandalone = obj.isStandalone;

                if (err) console.error(err, err.stack);

                var initialize = function(err, instance, middleware, conf) {
                    _debugLog('checkpoint I: initialize called err=' + (err ? (err.message||err) : 'none'));
                    var errMsg = null;
                    if (!err) {

                        //On user conf complete.
                        e.on('complete', function(instance){
                            _debugLog('checkpoint J: complete event fired');

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
                                        && !/^true$/i.test(isProxyHost)
                                    ) {
                                        try {
                                            await server.verifyCertificate(conf.host, conf.server.port);
                                        } catch (err) {
                                            // replaced: throw err — caused unhandled rejection + bundle crash on DNS failure inside containers (Node.js 15+)
                                            // replaced: console.emerg — emerg triggers start.js abort detection even though the error is non-fatal (server is already listening)
                                            console.warn('[verifyCertificate] ' + (err.stack || err.message));
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

                                    // H5: HTTP/2 upstream warmup — pre-establish sessions for declared upstreams
                                    // so the very first request doesn't hit a cold connection.
                                    // Triggered when `server.warmup` is a non-empty array of authority URLs
                                    // in the bundle's server config (e.g. ["https://api.internal:3100"]).
                                    // The warmup is fire-and-forget: it does not delay "Bundle started!".
                                    var _warmupTargets = conf.server.warmup;
                                    if (Array.isArray(_warmupTargets) && _warmupTargets.length > 0 && /http\/2/i.test(conf.server.protocol)) {
                                        // Defer by one tick so "Bundle started!" is logged first
                                        setImmediate(function warmupHTTP2Sessions() {
                                            var http2         = require('http2');
                                            var Cache         = lib.Cache;
                                            var warmupCache   = new Cache();
                                            warmupCache.from(instance._cached);

                                            _warmupTargets.forEach(function(authority) {
                                                var _wSessKey = 'http2session:' + authority;
                                                // Skip if a session already exists (e.g. multiple start events)
                                                if (warmupCache.get(_wSessKey)) return;

                                                var _wOpts = {
                                                    rejectUnauthorized: /^true$/i.test(process.env.NODE_SCOPE_IS_PRODUCTION),
                                                    settings: {
                                                        maxHeaderListSize: 65535,
                                                        maxConcurrentStreams: 100,
                                                        enablePush: false
                                                    }
                                                };

                                                // Load CA if available (required for TLS upstream)
                                                if (conf.server.credentials && conf.server.credentials.ca) {
                                                    try {
                                                        var _wCa = conf.server.credentials.ca;
                                                        if (!/-----BEGIN/.test(_wCa)) {
                                                            _wCa = require('fs').readFileSync(_wCa);
                                                        }
                                                        _wOpts.ca = _wCa;
                                                    } catch(caErr) {
                                                        console.warn('[warmup] Could not load CA for '+ authority +': '+ caErr.message);
                                                    }
                                                }

                                                try {
                                                    var _wClient = http2.connect(authority, _wOpts);
                                                    var _wPingInterval = null;

                                                    _wClient.setTimeout(0); // keep session alive

                                                    var _wCleanup = function() {
                                                        if (_wPingInterval) { clearInterval(_wPingInterval); _wPingInterval = null; }
                                                        warmupCache.delete(_wSessKey);
                                                        if (!instance._http2Sessions) return;
                                                        var _wi = instance._http2Sessions.indexOf(_wSessKey);
                                                        if (_wi !== -1) instance._http2Sessions.splice(_wi, 1);
                                                    };

                                                    _wClient.on('error', function(wErr) {
                                                        _wCleanup();
                                                        console.warn('[warmup] Session error for '+ authority +': '+ (wErr.message || wErr));
                                                    });
                                                    _wClient.on('close',  _wCleanup);
                                                    _wClient.on('goaway', _wCleanup);

                                                    // Cache the session BEFORE the PING completes so the first
                                                    // request can reuse it immediately (even if PING is in flight)
                                                    warmupCache.set(_wSessKey, _wClient);
                                                    if (!instance._http2Sessions) instance._http2Sessions = [];
                                                    instance._http2Sessions.push(_wSessKey);

                                                    // Send initial PING to verify the connection is alive
                                                    _wClient.ping(function(wPingErr, wDuration) {
                                                        if (wPingErr) {
                                                            console.warn('[warmup] Initial PING failed for '+ authority +': '+ wPingErr.message);
                                                            _wCleanup();
                                                            if (!_wClient.destroyed) _wClient.destroy();
                                                            return;
                                                        }
                                                        console.info('[warmup] HTTP/2 session ready for '+ authority +' (PING RTT: '+ ~~wDuration +'ms)');

                                                        // Start the 5s keepalive PING cycle (mirrors handleHTTP2ClientRequest)
                                                        _wPingInterval = setInterval(function() {
                                                            if (_wClient.destroyed || _wClient.closed) {
                                                                _wCleanup();
                                                                return;
                                                            }
                                                            var _wDeadline = setTimeout(function() {
                                                                console.warn('[warmup] PING deadline exceeded for '+ authority +' — evicting session');
                                                                _wCleanup();
                                                                if (!_wClient.destroyed) _wClient.destroy();
                                                            }, 3000);
                                                            _wClient.ping(function(keepAliveErr) {
                                                                clearTimeout(_wDeadline);
                                                                if (keepAliveErr) { _wCleanup(); }
                                                            });
                                                        }, 5000);
                                                    });

                                                } catch(wConnErr) {
                                                    console.warn('[warmup] Could not connect to '+ authority +': '+ wConnErr.message);
                                                }
                                            }); // end forEach
                                        }); // end setImmediate
                                    }

                                    // placing end:flag to allow the CLI to retrieve bundl info from here
                                    console.notice('[ FRAMEWORK ] Bundle started !');
                                }, 700); // 1000 - Wait to make sure that the bundle is mounted on the file system
                            });

                            // placing strat:flag to allow the CLI to retrieve bundl info from here
                            console.notice('[ FRAMEWORK ][ '+ process.pid +' ] '+ conf.bundle +'@'+ core.projectName +' mounted !');

                            server.start(instance);
                        });

                        // -- BO
                        _debugLog('checkpoint K: emitting init');
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

                _debugLog('checkpoint H: creating Server');
                var server = new Server(opt);
                _debugLog('checkpoint H2: server.onConfigured call');
                server.onConfigured(initialize);
            })//EO config.
        }

        /**
         * Stops the server process.
         * Logs a notice and calls `process.exit(code)` when a code is provided,
         * or `process.exit()` with no argument otherwise.
         * Also exposed as `process.stop`.
         *
         * @memberof module:gina/core/gna
         * @param {number} [pid] - PID of the process to stop (informational; not used directly)
         * @param {number} [code] - Exit code to pass to `process.exit`; defaults to 0
         * @returns {void}
         */
        gna.stop = process.stop = function(pid, code) {
            console.info('[ FRAMEWORK ] Stopped service');
            if (typeof(code) != 'undefined')
                process.exit(code);

            process.exit()
        }

        /**
         * Reports the running status of a bundle.
         * Currently a stub — logs a notice and returns.
         * Also exposed as `process.status`.
         *
         * @memberof module:gina/core/gna
         * @param {string} [bundle] - Bundle name to query; reserved for future use
         * @returns {void}
         */
        gna.status = process.status = function(bundle) {
            console.info('[ FRAMEWORK ] Getting service status')
        }
        /**
         * Restarts the server.
         * Currently a stub — logs a notice and returns.
         * Also exposed as `process.restart`.
         *
         * @memberof module:gina/core/gna
         * @returns {void}
         */
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
                        try {
                            packs[bundle].releases[scope][env].target = 'releases/' + bundle + '/' + scope + '/' + '/' + env + '/' + packs[bundle].version;
                        } catch (err) {
                            console.error("[ FRAMEWORK ][ MOUNT ] manifest issue: cannot find target for:\nBundle: "+bundle+"\nScope: "+ scope + "\nEnv: "+ env);
                            return abort(err);
                        }

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
                }

            } else {
                appName = getContext('bundle');
                projectName = getContext('projectName');
                processList = getContext('processList');
                process.list = processList;
                bundleProcess = new Proc(appName + '@' + projectName, process);
            }
        } catch (err) {
            abort(err)
        }


    });//EO onDoneGettingProjectConfiguration.
});


module.exports = gna