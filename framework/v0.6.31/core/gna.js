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
// or a custom build like the example image) caps each V8 isolate at a 4 GB heap
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

// Lightweight debug logger — gated on LOG_LEVEL so zero cost in production.
// Format mirrors lib/logger template: [date] [debug  ][gina:gna] message
// Deliberately retained with no call sites (#B435): the producer half of the
// boot-diagnostic channel. lib/cmd/bundle/start.js's child.stderr filter
// forwards lines matching `[debug  ][gina:` raw to the CLI client — no other
// write from a daemon-spawned bundle reaches the operator (console.error does
// not match the filter; stdout is captured but not forwarded). Writing
// straight to stderr keeps it usable before lib/logger is ready and immune to
// the logger's own failure modes — which also means it bypasses log redaction
// (#B433): keep messages free of URLs and credentials. Format changes must
// preserve `] [debug  ][gina:` — test/core/debug-log.test.js pins the contract.
var _isDebugLog = function() {
    return process.env.LOG_LEVEL === 'debug' || process.env.LOG_LEVEL === 'trace';
};
var _debugLog = function(msg) {
    if (!_isDebugLog()) return;
    var _m = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var p2 = function(n) { return (n < 10 ? '0' : '') + n; };
    var d = new Date();
    var ts = d.getFullYear() + ' ' + _m[d.getMonth()] + ' ' + p2(d.getDate())
        + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
    process.stderr.write('\u001b[90m[' + ts + '] [debug  ][gina:gna] ' + msg + '\u001b[39m\n');
};

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

var lib         = require('./../lib');

var console     = lib.logger;
var Proc        = lib.Proc;
var locales     = require('./locales');
var plugins     = require('./../core/plugins');
var modelUtil   = new lib.Model();




gna.initialized = process.initialized = false;
gna.routed      = process.routed = false;

gna.lib         = lib;
gna.dto         = lib.dto;      // #DTO — native schema/DTO builder: `var dto = require('gina').dto`
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

        // Make require('lib/<name>') resolve to ${frameworkPath}/lib/<name>/
        // so bundle entities and controllers can use the same bare-module
        // convention that the frontend AMD build uses via RequireJS path aliases.
        if ( ctxObj.paths.framework ) {
            var _nodePath = process.env.NODE_PATH || '';
            var _fwPath   = ctxObj.paths.framework;
            if ( _nodePath.indexOf(_fwPath) < 0 ) {
                process.env.NODE_PATH = _nodePath
                    ? (_nodePath + require('path').delimiter + _fwPath)
                    : _fwPath;
                require('module').Module._initPaths();
            }

            // Bun reads NODE_PATH only at process start, and the Module._initPaths()
            // call above is a callable no-op under it — so bare require('lib/<name>')
            // from framework entities and controllers fails to resolve at request
            // time. Re-implement NODE_PATH fallback semantics for Bun: when the
            // default resolver cannot find a *bare* specifier, retry it against each
            // NODE_PATH dir (the list now includes the framework path). isBun-gated,
            // so Node keeps its native NODE_PATH / _initPaths resolution untouched
            // (zero Node-side change — the shim is never installed under Node).
            var _runtime = require(ctxObj.paths.gina.root + '/utils/runtime');
            var _Module  = require('module');
            if ( _runtime.isBun() && !_Module._ginaBunResolvePatched ) {
                _Module._ginaBunResolvePatched = true;
                var _resolvePath      = require('path');
                var _ginaOrigResolve  = _Module._resolveFilename;
                var _ginaFallbackDirs = (process.env.NODE_PATH || '').split(_resolvePath.delimiter).filter(Boolean);
                if ( _ginaFallbackDirs.indexOf(_fwPath) < 0 ) {
                    _ginaFallbackDirs.push(_fwPath);
                }
                _Module._resolveFilename = function (request, parent, isMain, options) {
                    try {
                        return _ginaOrigResolve.call(this, request, parent, isMain, options);
                    } catch (resolveErr) {
                        // Only bare specifiers fall back — never relative ('./' '../')
                        // or absolute ('/' '\' 'C:') requests.
                        if (
                            typeof request === 'string'
                            && request.charAt(0) !== '.'
                            && request.charAt(0) !== '/'
                            && request.charAt(0) !== '\\'
                            && !/^[A-Za-z]:/.test(request)
                        ) {
                            for (var _gi = 0; _gi < _ginaFallbackDirs.length; _gi++) {
                                try {
                                    return _ginaOrigResolve.call(this, _resolvePath.join(_ginaFallbackDirs[_gi], request), parent, isMain, options);
                                } catch (fallbackErr) { /* try the next NODE_PATH dir */ }
                            }
                        }
                        throw resolveErr;
                    }
                };
            }
        }

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

                    // FRAMEWORK PATCH: mirror ctxObj.envVars into process.env so
                    // third-party plugins (Csrf, future env-readers) see what filterArgs() stripped
                    // in the supervisor before spawn. Push upstream to gina-io/gina.
                    if ( typeof(obj[a]) != 'undefined' && obj[a] !== null ) {
                        process.env[a] = String(obj[a]);
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

// Ensure gina.home is always registered (SQLite connector, session store)
if ( !getPath('gina').home && typeof(getEnvVar) != 'undefined' ) {
    // #B277 — `getEnvVar` reads `process.gina`, which the CLI populates when it
    // starts a bundle; it deliberately does NOT consult `process.env`. Outside a
    // bundle it therefore yields nothing, and `setPath` then failed with the path
    // registry's generic empty-value error — a message naming an internal call
    // rather than the boundary that was hit. That old text is deliberately NOT
    // reproduced verbatim here: a consumer grepping to confirm it is gone would
    // otherwise match this comment and conclude the fix had not landed. It is
    // quoted where quoting it helps a reader recognise the symptom instead — the
    // changelog entry and the llms.txt record.
    //
    // Failing HERE is correct and is not what changed: this is the first point at
    // which a boot without bundle context is detectable. `GINA_HOMEDIR` is read a
    // few lines below as a bare global, so letting an empty value through only
    // defers the failure into a `ReferenceError: GINA_HOMEDIR is not defined`,
    // which is strictly less legible. This is also the sole registration site for
    // `gina.home` (the SQLite connector and the session store both read it), so
    // skipping the call would leave it unregistered. Message only — the boot still
    // throws at exactly the same point, for exactly the same reason.
    var _ginaHome = getEnvVar('GINA_HOMEDIR');
    if ( !_ginaHome ) {
        throw new Error(
            'gina must be required from within a bundle context. The framework '
            + 'bootstrap could not resolve GINA_HOMEDIR, which the CLI sets on '
            + '`process.gina` when it starts a bundle (`process.env` is not '
            + 'consulted). Requiring gina from a plain node process — a test '
            + 'runner, a one-off script, a codegen pass — is not supported. To '
            + 'exercise controller code without booting a bundle, use '
            + 'SuperController.createTestInstance() from '
            + '`gina/framework/<version>/core/controller`; see the Testing guide '
            + 'at https://gina.io/docs/guides/testing.'
        );
    }
    setPath('gina.home', _ginaHome);
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
    , scheme                = projects[projectName]['def_scheme']
;

// Guard the ports.reverse.json lookup: a desynced/corrupt manifest (a missing
// bundle@project / env / protocol / scheme key) otherwise throws a cryptic
// `TypeError: Cannot read properties of undefined` at module load (bundle exit 1,
// no actionable reason). Fail fast with a clear, pipe-flushed diagnostic instead.
var _bundleKey  = process.env.NODE_BUNDLE +'@'+ process.env.NODE_PROJECT
    , _defProto = projects[projectName]['def_protocol']
    , _byEnv    = reversePorts[_bundleKey] && reversePorts[_bundleKey][env]
    , _byProto  = _byEnv && _byEnv[_defProto]
    , port      = ( _byProto && typeof(_byProto[scheme]) != 'undefined' ) ? _byProto[scheme] : null
;
if ( port == null ) {
    var _portMsg = '[ FRAMEWORK ] could not resolve the listening port for [ '+ _bundleKey +' ] '
                 + '(env: '+ env +', protocol: '+ _defProto +', scheme: '+ scheme +') — check '
                 + GINA_HOMEDIR +'/ports.reverse.json';
    console.emerg(_portMsg);
    try { fs.writeSync(2, _portMsg + '\n'); } catch (_e) { /* best-effort */ }
    process.exit(1);
}

gna.env = process.env.NODE_ENV = env;
gna.scope = process.env.NODE_SCOPE = scope;
gna.os.isWin32 = process.env.isWin32 = isWin32;
gna.isAborting = false;
//Cacheless is also defined in the main config : Config::isCacheless().
// Stored as STRING literals, not booleans: Node coerces a non-string
// process.env assignment to a string, but Bun preserves the original type —
// so a boolean here makes the downstream readers throw under Bun
// (`process.env.NODE_ENV_IS_DEV.toLowerCase()`) or compare wrong
// (`process.env.NODE_ENV_IS_DEV == 'false'` is never true for a boolean).
// 'true'/'false' are byte-identical to Node's implicit coercion.
process.env.NODE_ENV_IS_DEV = (/^true$/i.test(isDev)) ? 'true' : 'false';
process.env.NODE_SCOPE_IS_LOCAL = (/^true$/i.test(isLocalScope)) ? 'true' : 'false';
process.env.NODE_SCOPE_IS_PRODUCTION = (/^true$/i.test(isProductionScope)) ? 'true' : 'false';
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

    // Guarantee the abort reason survives process.exit(): process.stdout/stderr
    // are async on a pipe (e.g. under bin/gina-container), so the console.emerg
    // above is truncated by the immediate exit. fs.writeSync blocks until flushed.
    try { fs.writeSync(2, '[ FRAMEWORK ] abort: ' + ((err && err.stack) || err) + '\n'); } catch (_e) { /* best-effort */ }
    process.exit(1);
};

// #B109 — was: gna.emit = e.emit;  (a DETACHED copy: `this` at call time was
// the plain module object — no `_events` — so it never dispatched; it
// returned false for every name EXCEPT 'error', which THREW its argument via
// Node's unhandled-'error' path. Zero callers existed anywhere.)
/**
 * Inert by design — the internal lifecycle emitter is not exposed and the
 * module object has no listener surface (`on`/`once` are not exported).
 * Always returns `false`, never dispatches, never throws. Application
 * events go through the controller's `self.emitEvent()` (#EVTBUS).
 *
 * @memberof module:gina/core/gna
 * @returns {boolean} Always `false`
 */
gna.emit = function () { return false; };
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
        // #B381 — no pre-unlink here: removing the mount before re-creating it
        // left a window where a sibling process booting the same project tree
        // observed a missing link. gna.mount() is idempotent now (it keeps a
        // correct link as-is and atomically replaces a wrong one), so forcing
        // the mount call is enough.
        // was: new _( project.path +'/'+ manifest.bundles[bundle].link ).rmSync();
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
 * Idempotent and concurrency-safe (#B381): a link that already resolves to the
 * source is kept untouched, a wrong or missing one is published atomically,
 * and a concurrent identical creator is treated as success — so several
 * processes may boot one shared project tree without racing each other's
 * mounts.
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
    // #B381 — create-if-missing WITHOUT the exists/mkdir two-step: two
    // processes booting the same project tree raced the check-then-create,
    // and the loser threw EEXIST out of the mount, uncaught. `recursive: true`
    // never throws on an existing directory, so the race disappears.
    var mountingPath = getPath('project') + '/bundles';
    console.debug('mounting path: ', mountingPath);
    fs.mkdirSync(mountingPath, { recursive: true });
    // /tmp
    var tmpPath = getPath('project') + '/tmp';
    console.debug('tmp path: ', tmpPath);
    fs.mkdirSync(tmpPath, { recursive: true });
    // cache
    var cachePath = getPath('project') + '/cache';
    console.debug('cache path: ', cachePath);
    fs.mkdirSync(cachePath, { recursive: true });

    var sourceObj = new _(source);
    var targetObj = new _(target);

    var isSourceFound   = sourceObj.existsSync()
        , isTargetFound = targetObj.existsSync()
    ;
    console.debug('[ FRAMEWORK ][ MOUNT ] Source: ', source);
    console.debug('[ FRAMEWORK ][ MOUNT ] Checking before mounting ', target, isTargetFound, bundlesPath);
    // #B381 — the early unlink is gone: it opened the absent-name window at
    // the TOP of the mount (spanning the whole createPathSync walk below), and
    // its catch called callback(err) WITHOUT returning, so a lost race (a
    // sibling removing the link first) aborted the boot AND fell through into
    // a second callback. ensureSymlinkSync() below replaces atomically instead.
    // was:
    // if ( isTargetFound ) {
    //     try {
    //         console.debug('[ FRAMEWORK ][ MOUNT ] removing old build ', target);
    //         fs.unlinkSync(target)
    //     } catch (err) {
    //         callback(err)
    //     }
    // }

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
        // #B381 — was: unlink-then-recreate on every restart ("will override
        // existing each time you restart"), two non-atomic steps during which
        // the mount name did not exist. Under two processes booting one shared
        // project tree that window produced collisions on the contended names
        // and killed the boot below. ensureSymlinkSync() keeps a correct link
        // untouched, publishes a new one atomically (temp sibling + rename),
        // and treats a concurrent identical creator as success.
        gna.lib.generator.createPathSync(bundlesPath, function onPathCreated(err){
            if (!err) {
                try {
                    // was:
                    // if ( targetObj.existsSync() ) {
                    //     targetObj.rmSync();
                    // }
                    console.debug('[ FRAMEWORK ][ MOUNT ] Linking ['+ source +'] to [ '+ target +' ] ');
                    new _(source).ensureSymlinkSync(target, type);
                    // symlink created (or kept / atomically replaced / adopted
                    // from a concurrent boot of the same tree)
                    callback(false);

                } catch (err) {
                    if (err) {
                        var _mountMsg = '[ FRAMEWORK ] '+ (err.stack||err.message);
                        console.emerg(_mountMsg);
                        // Guarantee the reason survives process.exit() on an async pipe (e.g. bin/gina-container).
                        try { fs.writeSync(2, _mountMsg + '\n'); } catch (_e) { /* best-effort */ }
                        process.exit(1)
                    }
                    // #B381 — the recovery below was structurally unreachable
                    // (the `if (err)` above always fires inside a catch, so the
                    // exit is unconditional); the tolerance it intended now
                    // lives in ensureSymlinkSync()'s verify-then-accept path.
                    // was:
                    // if ( fs.existsSync(target) ) {
                    //     var stats = fs.lstatSync(target);
                    //     if ( stats.isDirectory() ) {
                    //         var d = new _(target).rm( function(err){
                    //             callback(err);
                    //         })
                    //     } else {
                    //         fs.unlinkSync(target);
                    //         callback(err)
                    //     }
                    // }
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
isBundleMounted(projects, bundlesPath, getContext('bundle'), function onBundleMounted(err) {
    if (err) {
        return abort(err);
    }
    // get configuration
    gna.getProjectConfiguration( async function onGettingProjectConfig(err, project) {
    // #B406 — own the WHOLE boot frame. This callback is `async`, so a
    // synchronous throw anywhere in its direct frame surfaces as a promise
    // REJECTION, never an exception: the caller's try/catch in
    // getProjectConfiguration() can never see it, and the process-level
    // unhandledRejection net above only logs at error level — no `[ emerg`
    // marker for start.js's startup watchdog (stdout-only, startup-only), no
    // exit. Pre-fix, a boot-time crash here left the process alive but never
    // started: the daemon's 60s startup timer was the only terminal, with no
    // cause attached. The catch below routes every failure in this frame —
    // sync throws today, any awaited rejection tomorrow — into abort(), the
    // existing boot terminal (console.emerg + synchronous stderr flush +
    // exit(1)), whose emerg line is what the watchdog matches on. The body
    // keeps its original indentation.
    try {

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
            // 'globalTmpPath' was never registered via setPath() and PID files are not
            // written to a tmp/pid subdirectory. proc.js writes PID files directly into
            // GINA_RUNDIR (set from settings.json rundir field, e.g. ~/.gina/run/).
            var pidPath = _(getEnvVar('GINA_RUNDIR'));
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
            config.onReady( function(err, obj){
                var isStandalone = obj.isStandalone;

                if (err) console.error(err, err.stack);

                var initialize = function(err, instance, middleware, conf) {
                    var errMsg = null;
                    if (!err) {

                        //On user conf complete.
                        e.on('complete', function(instance){

                            server.on('started', async function (conf) {

                                // #OBS1 — initialise Prometheus metrics if app.json
                                // `metrics.enabled` is true. Wired here so getConfig('app')
                                // is available and the registry exists before any
                                // /_gina/metrics scrape can land. Idempotent — safe across
                                // server restarts within the same process.
                                try {
                                    var _metricsAppConf = (typeof gna.getConfig === 'function') ? gna.getConfig('app') : null;
                                    if (
                                        _metricsAppConf
                                        && _metricsAppConf.metrics
                                        && _metricsAppConf.metrics.enabled === true
                                    ) {
                                        lib.metrics.start({
                                            prefix:         _metricsAppConf.metrics.prefix,
                                            defaultMetrics: _metricsAppConf.metrics.defaultMetrics,
                                            allowFrom:      _metricsAppConf.metrics.allowFrom
                                        });
                                    }
                                } catch (metricsErr) {
                                    console.warn('[lib.metrics] init skipped: ' + (metricsErr.message || metricsErr));
                                }

                                // #S7 — admin /_gina/* allowlist init. Reads `admin.allowFrom`
                                // from app.json; defaults to loopback (127.0.0.1, ::1). Stored
                                // on process.gina so server.isaac.js's /_gina/info and
                                // /_gina/cache/stats handlers can gate on it. Same shape as the
                                // metrics allowlist but a separate axis — admin endpoints expose
                                // process state and warrant their own access control.
                                try {
                                    var _adminAppConf = (typeof gna.getConfig === 'function') ? gna.getConfig('app') : null;
                                    var _adminAllow   = (_adminAppConf && _adminAppConf.admin && Array.isArray(_adminAppConf.admin.allowFrom))
                                        ? _adminAppConf.admin.allowFrom.slice()
                                        : ['127.0.0.1', '::1'];
                                    if (!process.gina) process.gina = {};
                                    process.gina._adminAllowList = _adminAllow;
                                } catch (adminAclErr) {
                                    console.warn('[admin-acl] init skipped: ' + (adminAclErr.message || adminAclErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._adminAllowList = ['127.0.0.1', '::1'];
                                }

                                // #INS9b — capture the /_gina/agent auth toggle + key from
                                // settings.json `inspector.agent`. The agent SSE endpoint is
                                // dev-only by default; when `enabled` is true and a key is set,
                                // it is reachable outside dev mode behind that key (constant-time
                                // compared in server.js / server.isaac.js). Read here so
                                // getConfig('settings') is resolved (incl. ${secret:KEY}) before
                                // any /_gina/agent request can land. Stored on process.gina so
                                // both engine handlers read the same slot. Fail-closed.
                                try {
                                    var _inspSettings = (typeof gna.getConfig === 'function') ? gna.getConfig('settings') : null;
                                    var _inspAgent    = (_inspSettings && _inspSettings.inspector && _inspSettings.inspector.agent && typeof _inspSettings.inspector.agent === 'object')
                                        ? _inspSettings.inspector.agent
                                        : {};
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorAgentEnabled = (_inspAgent.enabled === true);
                                    process.gina._inspectorAgentKey     = (typeof _inspAgent.key === 'string' && _inspAgent.key) ? _inspAgent.key : null;
                                    // #INS8 — Origin allowlist for the WebSocket /_gina/agent upgrade
                                    // (empty ⇒ allow any origin; enforced only when non-empty).
                                    process.gina._inspectorAgentAllowedOrigins = Array.isArray(_inspAgent.allowedOrigins) ? _inspAgent.allowedOrigins : [];
                                } catch (inspAgentErr) {
                                    console.warn('[inspector-agent] init skipped: ' + (inspAgentErr.message || inspAgentErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorAgentEnabled = false;
                                    process.gina._inspectorAgentKey     = null;
                                    process.gina._inspectorAgentAllowedOrigins = [];
                                }

                                // #INS10 — capture the instrumentation-window opt-in + key + window
                                // bounds from settings.json `inspector.instrumentation`. The window
                                // lets Inspector query/flow capture run outside dev mode for a bounded
                                // period (POST /_gina/instrument). Read here so getConfig('settings') is
                                // resolved (incl. ${secret:KEY}) before any request lands. Stored on
                                // process.gina so both engine handlers + lib/instrument read the same
                                // slots. Fail-closed. The window deadline slot is seeded to 0 (closed).
                                try {
                                    var _instrSettings = (typeof gna.getConfig === 'function') ? gna.getConfig('settings') : null;
                                    var _instrConf     = (_instrSettings && _instrSettings.inspector && _instrSettings.inspector.instrumentation && typeof _instrSettings.inspector.instrumentation === 'object')
                                        ? _instrSettings.inspector.instrumentation
                                        : {};
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorInstrumentEnabled = (_instrConf.enabled === true);
                                    process.gina._inspectorInstrumentKey     = (typeof _instrConf.key === 'string' && _instrConf.key) ? _instrConf.key : null;
                                    var _instrDef = parseInt(_instrConf.defaultWindowSeconds, 10);
                                    var _instrMax = parseInt(_instrConf.maxWindowSeconds, 10);
                                    process.gina._inspectorWindowDefaultSec = (!isNaN(_instrDef) && _instrDef > 0) ? _instrDef : 300;
                                    // Hard ceiling 3600s — config may lower but never raise it.
                                    process.gina._inspectorWindowMaxSec = (!isNaN(_instrMax) && _instrMax > 0) ? Math.min(_instrMax, 3600) : 3600;
                                    if (typeof process.gina._inspectorWindowUntil !== 'number') {
                                        process.gina._inspectorWindowUntil = 0;
                                    }
                                } catch (instrErr) {
                                    console.warn('[inspector-instrument] init skipped: ' + (instrErr.message || instrErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorInstrumentEnabled = false;
                                    process.gina._inspectorInstrumentKey     = null;
                                    process.gina._inspectorWindowDefaultSec  = 300;
                                    process.gina._inspectorWindowMaxSec      = 3600;
                                    process.gina._inspectorWindowUntil       = 0;
                                }

                                // #AISTREAM — capture the AI token-stream chunk-text
                                // opt-in from settings.json `inspector.ai.captureText`
                                // (default false). Metadata is always captured under the
                                // dev/window gate; the raw prompt + token text rides the
                                // wire only when this is true (the authenticated channel +
                                // the dev/window gate are the protection — redaction cannot
                                // cover free text). Stored on process.gina so the AI
                                // connector reads the same slot. Fail-closed.
                                try {
                                    var _aiInspSettings = (typeof gna.getConfig === 'function') ? gna.getConfig('settings') : null;
                                    var _aiInspConf     = (_aiInspSettings && _aiInspSettings.inspector && _aiInspSettings.inspector.ai && typeof _aiInspSettings.inspector.ai === 'object')
                                        ? _aiInspSettings.inspector.ai
                                        : {};
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorAiCaptureText = (_aiInspConf.captureText === true);
                                } catch (aiInspErr) {
                                    console.warn('[inspector-ai] init skipped: ' + (aiInspErr.message || aiInspErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorAiCaptureText = false;
                                }

                                // #EVTBUS — opt-in from settings.json `inspector.events.captureArgs`
                                // (default false). The event NAME + framework stamps are always
                                // captured under the dev/window gate; the caller's metadata VALUES
                                // ride the wire only when this is true (gate + opt-in + authenticated
                                // channel are the protection — key-name redaction cannot cover
                                // arbitrary arg values). Stored on process.gina so lib/inspector-events
                                // reads a cheap slot. Fail-closed.
                                try {
                                    var _evInspSettings = (typeof gna.getConfig === 'function') ? gna.getConfig('settings') : null;
                                    var _evInspConf     = (_evInspSettings && _evInspSettings.inspector && _evInspSettings.inspector.events && typeof _evInspSettings.inspector.events === 'object')
                                        ? _evInspSettings.inspector.events
                                        : {};
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorEventsCaptureArgs = (_evInspConf.captureArgs === true);
                                    // #EVTBUS Slice 2a — allow-list of framework event topics to
                                    // bridge onto the live signal (entity triggers). Default [] →
                                    // nothing bridged (zero overhead). Fail-closed.
                                    process.gina._inspectorEventTopics = Array.isArray(_evInspConf.topics) ? _evInspConf.topics.slice() : [];
                                } catch (evInspErr) {
                                    console.warn('[inspector-events] init skipped: ' + (evInspErr.message || evInspErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorEventsCaptureArgs = false;
                                    process.gina._inspectorEventTopics = [];
                                }

                                // #B350 — opt-in from settings.json `inspector.queries.captureValues`
                                // (default false). Query statements + timing/shape metadata are always
                                // captured under the dev/window gate; bound parameter VALUES — and
                                // value-bearing statement bodies (a document database's resolved body,
                                // a bulk-insert's inlined records) — reach the console lines and the
                                // Inspector query log only when this is true. A positional bind array
                                // has no key names, so the key-based redact library structurally cannot
                                // cover it; the gate + opt-in are the protection (same contract as the
                                // AI captureText and events captureArgs opt-ins above). Stored on
                                // process.gina so connectors read a cheap slot. Fail-closed.
                                try {
                                    var _qInspSettings = (typeof gna.getConfig === 'function') ? gna.getConfig('settings') : null;
                                    var _qInspConf     = (_qInspSettings && _qInspSettings.inspector && _qInspSettings.inspector.queries && typeof _qInspSettings.inspector.queries === 'object')
                                        ? _qInspSettings.inspector.queries
                                        : {};
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorQueryCaptureValues = (_qInspConf.captureValues === true);
                                } catch (qInspErr) {
                                    console.warn('[inspector-queries] init skipped: ' + (qInspErr.message || qInspErr));
                                    if (!process.gina) process.gina = {};
                                    process.gina._inspectorQueryCaptureValues = false;
                                }

                                // #INS8 — dev-only auto-start of the standalone Inspector
                                // bundle (inspector@gina). Best-effort + fail-closed.
                                // Gated on:
                                //  - isDev: never fires outside the project's dev env.
                                //  - projectName !== 'gina': a @gina service (inspector /
                                //    proxy) must never trigger this — otherwise the
                                //    Inspector would re-spawn itself when it boots. This is
                                //    the timing-proof guard; the not-running check below is
                                //    a second line of defense.
                                //  - srcExists: the @gina project is registered AND
                                //    services/src/inspector is on disk. services/ is
                                //    gitignored + npmignored, so it is absent in any
                                //    `npm install gina` — the auto-start no-ops for everyone
                                //    but a maintainer who scaffolded the services/ project.
                                //  - not-running: a live inspector@gina pidfile skips the
                                //    spawn (no duplicate Inspector).
                                // Launches via the daemon-free bin/gina-container, so no
                                // `gina start` socket server is required. Keep the spawn
                                // shape in sync with lib/cmd/service/start.js.
                                if (isDev && projectName !== 'gina') {
                                    try {
                                        var _inspProj = projects['gina'];
                                        // 'src/inspector' mirrors @gina manifest.bundles.inspector.src
                                        var _inspSrc  = _inspProj ? _(_inspProj.path + '/src/inspector') : null;
                                        if (_inspProj && _inspSrc && require('fs').existsSync(_inspSrc)) {
                                            var _inspRun = lib.cmdStatusFormat.readPidfile(getEnvVar('GINA_HOMEDIR') + '/run', 'inspector', 'gina');
                                            if (!_inspRun.running) {
                                                var _inspContainer = getEnvVar('GINA_DIR') + '/bin/gina-container';
                                                if (require('fs').existsSync(_inspContainer)) {
                                                    var _inspEnv = Object.assign({}, process.env);
                                                    delete _inspEnv.NODE_ENV;
                                                    delete _inspEnv.NODE_SCOPE;
                                                    delete _inspEnv.NODE_PORT;
                                                    delete _inspEnv.NODE_BUNDLE;
                                                    delete _inspEnv.NODE_PROJECT;
                                                    var _inspChild = require('child_process').spawn(
                                                        process.execPath,
                                                        [_inspContainer, 'inspector', '@gina'],
                                                        { detached: true, stdio: 'ignore', env: _inspEnv }
                                                    );
                                                    _inspChild.unref();
                                                    console.debug('[inspector-autostart] started inspector@gina (pid ' + ((_inspChild && _inspChild.pid) || '?') + ')');
                                                }
                                            }
                                        }
                                    } catch (inspAutoErr) {
                                        console.warn('[inspector-autostart] skipped: ' + (inspAutoErr.message || inspAutoErr));
                                    }
                                }

                                // #AI6 — initialise the async-job primitive. Always-on (unlike
                                // metrics): self.startJob() / lib.job.create() must work out of the
                                // box, so this is NOT gated on an `enabled` flag. The app.json `jobs`
                                // block only tunes knobs (maxConcurrency, ttl, sweepInterval, idSize);
                                // an absent block means sane defaults. Idempotent across server
                                // restarts within the same process.
                                try {
                                    var _jobsAppConf = (typeof gna.getConfig === 'function') ? gna.getConfig('app') : null;
                                    var _jobsConf    = (_jobsAppConf && _jobsAppConf.jobs && typeof _jobsAppConf.jobs === 'object')
                                        ? _jobsAppConf.jobs
                                        : {};
                                    var _jobsStartOpts = {
                                        maxConcurrency: _jobsConf.maxConcurrency,
                                        ttl:            _jobsConf.ttl,
                                        sweepInterval:  _jobsConf.sweepInterval,
                                        idSize:         _jobsConf.idSize,
                                        retryBackoffMs: _jobsConf.retryBackoffMs,
                                        orphanTimeout:  _jobsConf.orphanTimeout,
                                        webhookMaxAttempts: _jobsConf.webhookMaxAttempts,
                                        webhookBackoffMs:   _jobsConf.webhookBackoffMs,
                                        webhookTimeoutMs:   _jobsConf.webhookTimeoutMs,
                                        webhookSecret:      _jobsConf.webhookSecret
                                    };
                                    // #AI6 connector-backed store — `jobs.store` names a
                                    // connectors.json entry, resolved through lib/job-store.
                                    // Fail-fast when the configured store cannot be built
                                    // (#B57 shape): the config explicitly asked for durable
                                    // records, so a silent memory fallback would hide the
                                    // misconfig and lose the durability it asked for. An
                                    // ABSENT `jobs.store` key still means the memory store.
                                    if (typeof _jobsConf.store === 'string' && _jobsConf.store.length > 0) {
                                        try {
                                            _jobsStartOpts.store = lib.JobStore(_jobsConf.store);
                                        } catch (jobsStoreErr) {
                                            var _jobsStoreMsg = '[lib.job] jobs.store `' + _jobsConf.store + '` could not be built — aborting boot: ' + (jobsStoreErr.message || jobsStoreErr);
                                            console.emerg(_jobsStoreMsg + '\n' + (jobsStoreErr.stack || ''));
                                            // process.exit() truncates async stdio on a pipe — flush synchronously first.
                                            fs.writeSync(2, _jobsStoreMsg + '\n');
                                            process.exit(1);
                                        }
                                    }
                                    lib.job.start(_jobsStartOpts);
                                } catch (jobsErr) {
                                    console.warn('[lib.job] init skipped: ' + (jobsErr.message || jobsErr));
                                }

                                // #RC4 — render/output-cache redis L2. Validate the bundle's
                                // resolved cache config and wire the shared L2 store at boot
                                // (before the first request), fail-fast (#B57 shape): a route
                                // asking for redis without a buildable store, or with an
                                // unsupported shape (sliding+redis, or no-ttl + no-events),
                                // aborts boot rather than degrading silently. A memory / fs (or
                                // cacheless) bundle is a no-op — the delegates keep serving L1.
                                try {
                                    var _rcServerCache = null;
                                    try {
                                        _rcServerCache = config.getInstance()[gna.core.startingApp][env].server.cache;
                                    } catch (rcConfErr) { _rcServerCache = null; }
                                    if (_rcServerCache) {
                                        // F4 — the whole redis path is inert unless the cache is enabled
                                        // (writeCache + the server read both hard-gate on
                                        // server.cache.enable === 'true'). So warnings ALWAYS log
                                        // (advisory), but a fatal ABORTS — and the ioredis client is
                                        // only built/connected — when the cache is actually enabled. A
                                        // disabled + would-be-fatal config downgrades to a loud warn
                                        // (naming the future abort), so the misconfig is visible without
                                        // refusing boot or opening a redis connection for config that
                                        // does nothing (e.g. an unreachable dev redis spewing reconnect
                                        // noise for an inert bundle).
                                        var _rcEnabled = String(_rcServerCache.enable).toLowerCase() === 'true';
                                        var _rcRouting = (typeof gna.getConfig === 'function') ? gna.getConfig('routing') : null;
                                        // #B238 — feed the disclosure-warn context from the RESOLVED conf
                                        // tree (the same `server.hidePoweredBy` source the engine-agnostic
                                        // X-Powered-By gate reads), guarded like `_rcServerCache` above.
                                        var _rcHidePoweredBy = false;
                                        try {
                                            _rcHidePoweredBy = ( config.getInstance()[gna.core.startingApp][env].server.hidePoweredBy === true );
                                        } catch (rcHpbErr) { _rcHidePoweredBy = false; }
                                        var _rcCheck = lib.RenderCache.validateConfig(_rcServerCache, _rcRouting || {}, gna.core.startingApp, { hidePoweredBy: _rcHidePoweredBy, cacheEnabled: _rcEnabled });
                                        for (var _rcW = 0; _rcW < _rcCheck.warnings.length; _rcW++) {
                                            console.warn('[render-cache] ' + _rcCheck.warnings[_rcW]);
                                        }
                                        if (_rcCheck.fatal) {
                                            if (_rcEnabled) {
                                                var _rcFatalMsg = '[render-cache] invalid cache configuration — aborting boot: ' + _rcCheck.fatal;
                                                console.emerg(_rcFatalMsg);
                                                // boot-exit-flush: process.exit() truncates async stdio on a pipe.
                                                try { fs.writeSync(2, _rcFatalMsg + '\n'); } catch (_e) {}
                                                process.exit(1);
                                            } else {
                                                console.warn('[render-cache] cache is disabled (server.cache.enable != "true") — the following WOULD abort boot once enabled: ' + _rcCheck.fatal);
                                            }
                                        }
                                        if (_rcCheck.redisConfigured && _rcEnabled) {
                                            if (!process.gina) { process.gina = {}; }
                                            try {
                                                process.gina._renderCacheStore = lib.RenderCacheStore(_rcServerCache.store);
                                            } catch (rcStoreErr) {
                                                var _rcStoreMsg = '[render-cache] server.cache.store `' + _rcServerCache.store + '` could not be built — aborting boot: ' + (rcStoreErr.message || rcStoreErr);
                                                console.emerg(_rcStoreMsg + '\n' + (rcStoreErr.stack || ''));
                                                try { fs.writeSync(2, _rcStoreMsg + '\n'); } catch (_e) {}
                                                process.exit(1);
                                            }
                                        }
                                    }
                                } catch (rcErr) {
                                    console.warn('[render-cache] config validation skipped: ' + (rcErr.message || rcErr));
                                }

                                // #STO1 — pluggable object storage. Validate the bundle's
                                // `storage` block, build any connector-backed metadata
                                // stores, then install the drivers before the first
                                // request. FATAL (#B57 shape) on an unbuildable config:
                                // unlike a cache, a storage layer has no safe degraded
                                // mode — a driver that cannot build would leave put()
                                // writing nowhere, and a root inside a web-served tree
                                // would publish every stored object, and the metadata
                                // database beside them, to anonymous callers.
                                //
                                // NOTE this band runs inside server.on('started'), i.e.
                                // AFTER listen() — so a refusal here exits on an
                                // already-bound port, exactly as the #AI6 and #RC4 blocks
                                // above do. A pre-listen refusal means moving the lint
                                // into core/server.js init() (where the audit trail does
                                // it); kept here for slice 0 so the feature touches one
                                // core file instead of two.
                                try {
                                    var _stoAll      = config.getInstance();
                                    var _stoSettings = null;
                                    try {
                                        _stoSettings = _stoAll[gna.core.startingApp][env].content.settings.storage;
                                    } catch (stoConfErr) { _stoSettings = null; }

                                    // #STO1 slice 1 — driver-routed upload groups: collect
                                    // every bundle's `upload.groups.<g>.driver` bindings as
                                    // NEUTRAL tuples (owner/driver/path) so the storage lint
                                    // can refuse a dangling reference. The driver set is
                                    // process-global (built from the starting app's `storage`
                                    // block), so EVERY bundle's groups validate against that
                                    // one set. Built BEFORE the `_stoSettings` gate: a
                                    // binding with NO storage block at all must fatal, not
                                    // silently no-op.
                                    var _stoBindings = [];
                                    try {
                                        for (var _stoBb in _stoAll) {
                                            var _stoBup = ( _stoAll[_stoBb] && _stoAll[_stoBb][env]
                                                && _stoAll[_stoBb][env].content
                                                && _stoAll[_stoBb][env].content.settings
                                                && _stoAll[_stoBb][env].content.settings.upload
                                            ) ? _stoAll[_stoBb][env].content.settings.upload : null;
                                            if ( !_stoBup || !_stoBup.groups || typeof(_stoBup.groups) != 'object' ) { continue; }
                                            for (var _stoBg in _stoBup.groups) {
                                                var _stoBgrp = _stoBup.groups[_stoBg];
                                                if ( _stoBgrp && typeof(_stoBgrp.driver) == 'string' && _stoBgrp.driver.length > 0 ) {
                                                    _stoBindings.push({
                                                        owner  : _stoBb + '/upload.groups/' + _stoBg,
                                                        driver : _stoBgrp.driver,
                                                        path   : ( typeof(_stoBgrp.path) == 'string' ) ? _stoBgrp.path : null
                                                    });
                                                }
                                            }
                                        }
                                    } catch (stoBindErr) {
                                        console.warn('[storage] could not enumerate upload-group driver bindings — the binding lint is degraded for this boot: ' + (stoBindErr.message || stoBindErr));
                                    }

                                    if ( _stoSettings || _stoBindings.length ) {
                                        // Web-served roots, INJECTED into the validator so
                                        // lib/storage stays free of gina core (its
                                        // import-boundary test enforces that). BOTH
                                        // surfaces count: a bundle's publicPath, and any
                                        // content.statics target — a statics mapping can
                                        // point anywhere on disk, so checking publicPath
                                        // alone would leave a hole.
                                        var _stoServed = [];
                                        try {
                                            for (var _stoB in _stoAll) {
                                                var _stoBc = _stoAll[_stoB] && _stoAll[_stoB][env];
                                                if ( !_stoBc ) { continue; }
                                                if ( typeof(_stoBc.publicPath) == 'string' && _stoBc.publicPath && !/\$\{/.test(_stoBc.publicPath) ) {
                                                    _stoServed.push(_stoBc.publicPath);
                                                }
                                                var _stoStatics = _stoBc.content && _stoBc.content.statics;
                                                for (var _stoU in _stoStatics) {
                                                    if ( typeof(_stoStatics[_stoU]) == 'string' && _stoStatics[_stoU] && !/\$\{/.test(_stoStatics[_stoU]) ) {
                                                        _stoServed.push(_stoStatics[_stoU]);
                                                    }
                                                }
                                            }
                                        } catch (stoServedErr) {
                                            console.warn('[storage] could not enumerate every web-served root — the served-root check is degraded for this boot: ' + (stoServedErr.message || stoServedErr));
                                        }

                                        var _stoCheck = lib.storage.validateConfig(_stoSettings, { servedRoots: _stoServed, groupBindings: _stoBindings });
                                        for (var _stoW = 0; _stoW < _stoCheck.warnings.length; _stoW++) {
                                            console.warn('[storage] ' + _stoCheck.warnings[_stoW]);
                                        }
                                        if (_stoCheck.fatal) {
                                            var _stoFatalMsg = '[storage] invalid storage configuration — aborting boot: ' + _stoCheck.fatal;
                                            console.emerg(_stoFatalMsg);
                                            // boot-exit-flush: process.exit() truncates async stdio on a pipe.
                                            try { fs.writeSync(2, _stoFatalMsg + '\n'); } catch (_e) {}
                                            process.exit(1);
                                        }

                                        if (_stoCheck.driverCount > 0) {
                                            var _stoDrivers = _stoSettings.drivers;
                                            var _stoStores  = {};
                                            for (var _stoN in _stoDrivers) {
                                                if ( typeof(_stoDrivers[_stoN].store) == 'string' && _stoDrivers[_stoN].store.length > 0 ) {
                                                    try {
                                                        // the driver name namespaces the store's rows, so two
                                                        // drivers may share one connectors.json entry
                                                        _stoStores[_stoN] = lib.StorageStore(_stoDrivers[_stoN].store, _stoN);
                                                    } catch (stoStoreErr) {
                                                        var _stoStoreMsg = '[storage] driver `' + _stoN + '` names store `' + _stoDrivers[_stoN].store + '`, which could not be built — aborting boot: ' + (stoStoreErr.message || stoStoreErr);
                                                        console.emerg(_stoStoreMsg + '\n' + (stoStoreErr.stack || ''));
                                                        try { fs.writeSync(2, _stoStoreMsg + '\n'); } catch (_e) {}
                                                        process.exit(1);
                                                    }
                                                }
                                            }
                                            try {
                                                // `warn` surfaces the per-root strategy-stamp checks
                                                // (§4 — a strategy flip on populated storage warns
                                                // every boot; a hash change warns once). Same sink as
                                                // the validateConfig warnings above.
                                                if ( lib.storage.start({ drivers: _stoDrivers, default: _stoSettings.default, stores: _stoStores, requireProjectModule: function(stoPkgName) {
                                                    // s3-adapter SDK resolution — built HERE because
                                                    // lib/storage is framework-independent (no `_`/
                                                    // `getPath` globals inside it, test-enforced);
                                                    // same project-path idiom as every connector.
                                                    return require( _(getPath('project') + '/node_modules/' + stoPkgName, true) );
                                                }, warn: function(stoWarnMsg) { console.warn('[storage] ' + stoWarnMsg); } }) ) {
                                                    // console.info, NOT debug — the shipped
                                                    // default log level filters debug, and an
                                                    // operator needs to see which roots went live.
                                                    console.info('[storage] ' + _stoCheck.driverCount + ' driver(s) ready' + ( _stoSettings.default ? ' (default: ' + _stoSettings.default + ')' : '' ));
                                                } else {
                                                    console.warn('[storage] drivers were already installed — this boot wiring was ignored');
                                                }
                                            } catch (stoStartErr) {
                                                var _stoStartMsg = '[storage] drivers could not be built — aborting boot: ' + (stoStartErr.message || stoStartErr);
                                                console.emerg(_stoStartMsg + '\n' + (stoStartErr.stack || ''));
                                                try { fs.writeSync(2, _stoStartMsg + '\n'); } catch (_e) {}
                                                process.exit(1);
                                            }
                                        }
                                    }
                                } catch (stoErr) {
                                    console.warn('[storage] config validation skipped: ' + (stoErr.message || stoErr));
                                }

                                // #KV1 — general-purpose KV primitive. Validate the starting
                                // bundle's `kv` block, build any connector-backed namespace stores,
                                // then install the namespaces before the first request. FATAL on an
                                // unbuildable config (the #STO1 shape above): a namespace whose
                                // declared store cannot build would leave gina.kv() handing out a
                                // backend the operator did not ask for. Dormant — zero cost — when
                                // the block is absent.
                                try {
                                    var _kvAll      = config.getInstance();
                                    var _kvSettings = null;
                                    try {
                                        _kvSettings = _kvAll[gna.core.startingApp][env].content.settings.kv;
                                    } catch (kvConfErr) { _kvSettings = null; }
                                    if ( _kvSettings ) {
                                        var _kvCheck = lib.kv.validateConfig(_kvSettings);
                                        for (var _kvW = 0; _kvW < _kvCheck.warnings.length; _kvW++) {
                                            console.warn('[kv] ' + _kvCheck.warnings[_kvW]);
                                        }
                                        if (_kvCheck.fatal) {
                                            var _kvFatalMsg = '[kv] invalid kv configuration — aborting boot: ' + _kvCheck.fatal;
                                            console.emerg(_kvFatalMsg);
                                            // boot-exit-flush: process.exit() truncates async stdio on a pipe.
                                            try { fs.writeSync(2, _kvFatalMsg + '\n'); } catch (_e) {}
                                            process.exit(1);
                                        }
                                        if (_kvCheck.namespaceCount > 0) {
                                            var _kvNamespaces = _kvSettings.namespaces;
                                            var _kvStores     = {};
                                            for (var _kvN in _kvNamespaces) {
                                                if ( typeof(_kvNamespaces[_kvN].store) == 'string' && _kvNamespaces[_kvN].store.length > 0 ) {
                                                    try {
                                                        // the namespace name is passed so an implementation
                                                        // prefixes its keys — two namespaces may share one
                                                        // connectors.json entry without colliding
                                                        _kvStores[_kvN] = lib.KvStore(_kvNamespaces[_kvN].store, _kvN);
                                                    } catch (kvStoreErr) {
                                                        var _kvStoreMsg = '[kv] namespace `' + _kvN + '` names store `' + _kvNamespaces[_kvN].store + '`, which could not be built — aborting boot: ' + (kvStoreErr.message || kvStoreErr);
                                                        console.emerg(_kvStoreMsg + '\n' + (kvStoreErr.stack || ''));
                                                        try { fs.writeSync(2, _kvStoreMsg + '\n'); } catch (_e) {}
                                                        process.exit(1);
                                                    }
                                                }
                                            }
                                            if ( lib.kv.start(_kvSettings, { stores: _kvStores, warn: function(kvWarnMsg) { console.warn('[kv] ' + kvWarnMsg); } }) ) {
                                                // console.info, NOT debug — an operator needs to see
                                                // which namespaces went live (the #STO1 precedent).
                                                console.info('[kv] ' + _kvCheck.namespaceCount + ' namespace(s) ready' + ( _kvSettings.default ? ' (default: ' + _kvSettings.default + ')' : '' ));
                                            } else {
                                                console.warn('[kv] namespaces were already installed — this boot wiring was ignored');
                                            }
                                        }
                                    }
                                } catch (kvErr) {
                                    console.warn('[kv] setup skipped: ' + (kvErr.message || kvErr));
                                }

                                // #CE1 — `server.transientErrors` boot-time shape check
                                // (warn-only, NEVER fatal: the opt-in governs how a
                                // transient datastore error RENDERS — a bad value must
                                // not refuse a boot, and the controller-side reader
                                // (`controller.js` `_getTransientErrorsConf()`, kept in
                                // sync with these rules) independently falls back to
                                // the same defaults at request time).
                                try {
                                    var _teBlock = null;
                                    try {
                                        _teBlock = config.getInstance()[gna.core.startingApp][env].server.transientErrors;
                                    } catch (teConfErr) { _teBlock = null; }
                                    if ( typeof(_teBlock) != 'undefined' && _teBlock !== null ) {
                                        if ( typeof(_teBlock) != 'object' || Array.isArray(_teBlock) ) {
                                            console.warn('[transient-errors] `server.transientErrors` must be an object — ignoring the whole block (feature off)');
                                        } else {
                                            if ( typeof(_teBlock.enabled) != 'undefined' && _teBlock.enabled !== true && _teBlock.enabled !== false ) {
                                                console.warn('[transient-errors] `server.transientErrors.enabled` must be a strict boolean — treating as disabled');
                                            }
                                            if ( typeof(_teBlock.retryAfter) != 'undefined' && !( typeof(_teBlock.retryAfter) == 'number' && isFinite(_teBlock.retryAfter) && Math.floor(_teBlock.retryAfter) === _teBlock.retryAfter && _teBlock.retryAfter >= 1 && _teBlock.retryAfter <= 86400 ) ) {
                                                console.warn('[transient-errors] `server.transientErrors.retryAfter` must be an integer between 1 and 86400 seconds — using the default (30)');
                                            }
                                            if ( typeof(_teBlock.message) != 'undefined' && ( typeof(_teBlock.message) != 'string' || _teBlock.message.length === 0 ) ) {
                                                console.warn('[transient-errors] `server.transientErrors.message` must be a non-empty string — falling back to the standard status text');
                                            }
                                        }
                                    }
                                } catch (teErr) {
                                    console.warn('[transient-errors] config validation skipped: ' + (teErr.message || teErr));
                                }

                                // #MAINT1 — `server.maintenance` boot-time shape check
                                // (warn-only, NEVER fatal, exactly as #CE1 above: the
                                // opt-in governs how a request RENDERS, so a bad value
                                // must not refuse a boot). The engine-side reader
                                // (lib.maintenance.resolveConf, boot-resolved in
                                // core/server.js) independently falls back to the same
                                // defaults per key — this lint exists so that fallback
                                // is never SILENT. Per-key, not all-or-nothing: a bad
                                // retryAfter must not disable the whole feature and
                                // leave an operator believing the site is closed.
                                try {
                                    var _mtBlock = null;
                                    try {
                                        _mtBlock = config.getInstance()[gna.core.startingApp][env].server.maintenance;
                                    } catch (mtConfErr) { _mtBlock = null; }
                                    var _mtWarnings = lib.maintenance.lintConf(_mtBlock);
                                    for (var _mtW = 0; _mtW < _mtWarnings.length; ++_mtW) {
                                        console.warn('[maintenance] ' + _mtWarnings[_mtW]);
                                    }
                                } catch (mtErr) {
                                    console.warn('[maintenance] config validation skipped: ' + (mtErr.message || mtErr));
                                }

                                // setting default global middlewares
                                if ( typeof(instance.use) == 'function' ) {

                                    // catching unhandled errors
                                    instance.use( function catchUnhandledErrorMiddlewar(error, request, response, next){

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
                        e.emit('init', instance, middleware, conf);
                        //In case there is no user init.
                        if (!gna.initialized) {
                            // No onInitialize handler — still need to load models
                            // before starting the server.
                            try {
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
                                                tmp = JSON.clone(conf.content[name])
                                            } catch (err) {
                                                console.error('[ FRAMEWORK ] ', err.stack);
                                                return undefined
                                            }
                                        } else {
                                            tmp = JSON.clone(conf)
                                        }
                                        return tmp
                                    };
                                    e.emit('complete', instance);
                                });
                            } catch(loadErr) {
                                // #B57 — fail fast on a synchronous model-init failure instead of
                                // swallowing it and booting a degraded bundle. The throw aborts the
                                // WHOLE model build (no per-model isolation), so getModel() would
                                // later hand back a bare { _connection, getConnection } and the bundle
                                // would 500 at call-time with a cryptic TypeError. Mirrors the
                                // framework's existing fail-fast convention: the onInitialize path
                                // (server.js ServerEngine catch -> process.exit(1)), async connectors
                                // (proc.js uncaughtException -> SIGTERM), and connection errors
                                // (onModelReady -> process.exit(1)).
                                // Was: console.error('[ FRAMEWORK ] Model loading failed: ' + ...) +
                                //      e.emit('complete', instance)  (swallow -> degraded boot).
                                var _loadMsg = '[ FRAMEWORK ] Model loading failed — aborting boot: ' + (loadErr.stack || loadErr.message || loadErr);
                                console.emerg(_loadMsg);
                                // boot-exit-flush: process.exit() truncates async stdout/stderr on a
                                // pipe (e.g. bin/gina-container); fs.writeSync blocks until flushed.
                                try { fs.writeSync(2, _loadMsg + '\n'); } catch (_e) { /* best-effort */ }
                                process.exit(1);
                            }
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

        /**
         * Whether a manifest bundle entry is deployed in the given scope (#B373).
         *
         * TWIN of `isBundleDeployedInScope` in `core/config.js` — this path runs
         * BEFORE Config exists and cannot reach that closure, so the predicate is
         * duplicated deliberately. Keep both in sync: `scopes` absent/null means
         * every scope (back-compat), `[]` means none, a non-array is invalid.
         *
         * @inner
         * @private
         * @param {object} bundleEntry - The bundle's manifest entry
         * @param {string} scopeName - Scope being mounted
         * @returns {boolean} `true` when deployed in `scopeName`
         */
        var isBundleDeployedInScope = function(bundleEntry, scopeName) {
            if ( !bundleEntry || typeof(bundleEntry.scopes) == 'undefined' || bundleEntry.scopes === null ) {
                return true;
            }
            if ( !Array.isArray(bundleEntry.scopes) ) {
                return false;
            }
            return bundleEntry.scopes.indexOf(scopeName) > -1;
        };

        if (isLoadedThroughCLI) {
            appName = getContext('bundle');
            if (!isPath) {
                //appName = getContext('bundle');
                if (typeof (packs[appName].version) == 'undefined' && typeof (packs[appName].tag) != 'undefined') {
                    packs[appName].version = packs[appName].tag
                }
                // #B373 — refuse by name BEFORE the release deref below. This deref sits
                // outside any try, so an opted-out bundle used to die here as an opaque
                // TypeError before Config (and its named refusal) ever ran. The type
                // check comes first: a malformed `scopes` is a manifest error, and
                // reporting it as "not deployed" would send the operator hunting the
                // wrong thing (the predicate returns false for both).
                if (
                    typeof (packs[appName].scopes) != 'undefined' && packs[appName].scopes !== null
                    && !Array.isArray(packs[appName].scopes)
                ) {
                    return abort('[ manifest ] `bundles.' + appName + '.scopes` must be an array of scope names (got '
                        + typeof (packs[appName].scopes) + '). Remove the key to deploy `' + appName + '` in every scope, '
                        + 'or list the scopes it belongs to.');
                }
                if ( !isBundleDeployedInScope(packs[appName], scope) ) {
                    return abort('[ scope ] cannot mount `'+ appName +'` in scope `'+ scope +'`: the bundle is not deployed there. '
                        + '`bundles.'+ appName +'.scopes` in manifest.json declares '
                        + ( Array.isArray(packs[appName].scopes) && packs[appName].scopes.length
                                ? '`'+ packs[appName].scopes.join('`, `') +'`'
                                : 'no scope at all' )
                        + '. Add `'+ scope +'` to that list, or start the bundle in a scope it belongs to.');
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
                    // #B373 — a bundle not deployed in this scope can never be the one
                    // being mounted here, and its release deref below sits in a try whose
                    // catch ABORTS the whole mount — so without this skip one opted-out
                    // sibling would take the process down at any non-dev scope.
                    if ( !isBundleDeployedInScope(packs[bundle], scope) ) {
                        continue;
                    }
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

    // #B406 — single owned terminal for the whole boot frame (see the header
    // comment on this callback). abort() reads err.stack through branches that
    // assume an Error-shaped value, so a non-Error rejection (throw null /
    // throw 'string') is coerced first — otherwise abort() itself would throw
    // inside this catch and the rejection would escape back to the silent net.
    } catch (bootErr) {
        if ( !(bootErr instanceof Error) ) {
            bootErr = new Error('boot frame rejected with a non-Error value: ' + String(bootErr));
        }
        abort(bootErr);
    }
    });//EO onDoneGettingProjectConfiguration.
});


// -------------------------------------------------------------------------
// #M8 / #AI3 — Explicit exports for injected globals (0.4.0).
//
// Every helper function below is also installed on the global object at
// framework boot time (via framework/v*/helpers/* and utils/helper.js,
// both loaded transitively through `require('./../lib')` on line 85).
//
// These explicit re-exports let IDEs, TypeScript, and AI assistants resolve
// `require('gina').setContext` and friends statically — no runtime magic
// required. The globals themselves are unchanged: existing call sites that
// use `setContext(...)` without importing anything keep working as before.
//
// Intentional omission — `getConfig`:
//   The bundle-aware `gna.getConfig` instance method is assigned later by
//   `onInitialize` (and by the no-onInitialize fallback). Exposing the
//   context-helper global of the same name here would be overwritten at
//   runtime and confuse users who destructure. The global `getConfig`
//   remains accessible via the package-root `gina/gna` barrel (getter),
//   which cannot collide with the instance method.
// -------------------------------------------------------------------------

// ── Context helpers (framework/v*/helpers/context.js) ────────────────────

/**
 * Store a value in the framework context registry under `name`.
 * Supports dotted keys (e.g. `gina.lib`) which create nested objects.
 *
 * @param {string|object} name  - Context key, dotted path, or full contexts object
 * @param {*}             [obj] - Value to store
 * @param {boolean}       [force] - Deep-merge instead of replace
 * @returns {void}
 * @example
 *   setContext('bundle', 'myApp');
 *   setContext('gina.lib', lib);
 */
gna.setContext = setContext;

/**
 * Read a value from the framework context registry.
 *
 * @param {string} [name] - Context key; omit to return the full context object
 * @returns {*} The stored value, or the full context map when `name` is omitted
 * @example
 *   var bundle = getContext('bundle');
 *   var all    = getContext();
 */
gna.getContext = getContext;

/**
 * Merge an additional contexts object into the current registry.
 *
 * @param {object} context - Partial contexts to merge in
 * @returns {void}
 * @example
 *   joinContext({ env: 'dev', scope: 'local' });
 */
gna.joinContext = joinContext;

/**
 * Rebuild the context registry from `GINA_*` environment variables and the
 * current project manifest. Mostly used by worker threads and the logger.
 *
 * @returns {void}
 * @example
 *   resetContext();
 */
gna.resetContext = resetContext;

/**
 * Load a bundle library by name and return an instantiated class.
 *
 * @param {string} [bundle] - Bundle name; inferred from the call site when omitted
 * @param {string} lib      - Library file name (without `.js`)
 * @returns {object} Library instance
 * @example
 *   var mailer = getLib('myBundle', 'Mailer');
 */
gna.getLib = getLib;

/**
 * Replace `${key}` tokens in a string or object using a dictionary.
 * Leaves unknown tokens untouched silently.
 *
 * @param {object}        dictionary  - Key → replacement map
 * @param {object|string} replaceable - Object or JSON-serialisable value
 * @param {RegExp}        [rule]      - Optional custom match rule
 * @returns {object|string} Interpolated value
 * @example
 *   whisper({ projectName: 'demo' }, '~/.${projectName}');
 *   // → '~/.demo'
 */
gna.whisper = whisper;

/**
 * Define a read-only constant on the global object. Auto-prefixes `USER_`
 * when the name does not already start with `GINA_` or `USER_`.
 *
 * @param {string} name  - Constant name (case-insensitive, uppercased)
 * @param {*}      value - Constant value
 * @returns {void}
 * @example
 *   define('MY_FLAG', true);
 *   // later: console.log(USER_MY_FLAG);
 */
gna.define = define;

/**
 * List all `GINA_*` and `USER_*` constants currently defined on the global
 * object.
 *
 * @returns {object} Array-like map of `name → value`
 * @example
 *   var constants = getDefined();
 */
gna.getDefined = getDefined;

/**
 * Check whether the current platform is Windows.
 *
 * @returns {boolean} `true` on win32
 * @example
 *   if (isWin32()) { /* windows-specific fallback *\/ }
 */
gna.isWin32 = isWin32;

// ── Path helpers (framework/v*/helpers/path.js) ──────────────────────────

/**
 * Normalise a path string or construct a PathObject for a directory.
 * With `force = true` returns a normalised string; otherwise a PathObject
 * exposing `existsSync()`, `mkdirSync()`, `cp()`, etc.
 *
 * @param {string}  path    - Path to convert (supports `~` expansion)
 * @param {boolean} [force] - Force plain-string normalisation
 * @returns {string|object} Normalised path or PathObject
 * @example
 *   _('~/.gina/log', true);             // string
 *   new _('~/.gina/log').existsSync();  // boolean
 */
gna._ = _;

/**
 * Register a named path in the context paths registry.
 * Supports dotted keys (e.g. `gina.core`) for nested buckets.
 *
 * @param {string} name - Path name, optionally dotted
 * @param {string} path - Absolute path value
 * @returns {void}
 * @example
 *   setPath('project', '/var/www/demo');
 *   setPath('gina.core', __dirname);
 */
gna.setPath = setPath;

/**
 * Read a named path from the context paths registry.
 *
 * @param {string} name - Path name (top-level bucket for dotted paths)
 * @returns {string|object} Stored path, or nested object for dotted roots
 * @throws {Error} When the path has not been registered
 * @example
 *   var root = getPath('project');
 *   var core = getPath('gina').core;
 */
gna.getPath = getPath;

/**
 * Replace the whole paths registry in one call.
 *
 * @param {object} paths - Map of `name → path`
 * @returns {void}
 * @example
 *   setPaths({ project: '/var/www/demo', bundles: '/var/www/demo/bundles' });
 */
gna.setPaths = setPaths;

/**
 * Read the full paths registry.
 *
 * @returns {object} The complete paths map
 * @example
 *   var all = getPaths();
 */
gna.getPaths = getPaths;

/**
 * Promisify an `.onComplete(cb)` EventEmitter, as returned by `Shell::run` or
 * the `run()` global. PathObject ops are callback-style and return `undefined`,
 * so they are promisified directly rather than passed here.
 *
 * @param {EventEmitter} emitter - Any object exposing `.onComplete(cb)`
 * @returns {Promise<*>} Resolves with the operation result
 * @example
 *   var output = await onCompleteCall( new lib.Shell().run('ls -la', true) );
 */
gna.onCompleteCall = onCompleteCall;

// ── Model helpers (framework/v*/lib/model.js) ────────────────────────────

/**
 * Load a bundle model and return its entity map.
 *
 * @param {string} [bundle] - Bundle name; inferred from the call site when omitted
 * @param {string} model    - Model name (without `.js`)
 * @returns {object} Entities keyed by name
 * @example
 *   var users = getModel('myBundle', 'User');
 */
gna.getModel = getModel;

/**
 * Instantiate a bundle model entity with an optional connection.
 *
 * @param {string} [bundle]          - Bundle name; inferred when omitted
 * @param {string} model             - Model name
 * @param {string} entityClassName   - Entity class name inside the model
 * @param {object} [conn]            - DB connector instance
 * @returns {object} Entity instance
 * @example
 *   var user = getModelEntity('myBundle', 'User', 'UserEntity');
 */
gna.getModelEntity = getModelEntity;

/**
 * Register an application busy probe for the release-watch idle gate (#RWATCH).
 * A probe reports in-flight background work (an import queue, a batch worker …)
 * so an idle-gated restart never kills it. Two shapes: zero-arg returning
 * `{busy, detail}` / boolean / a Promise of either, or callback-shaped
 * `function(cb)`. A probe that throws, rejects or times out reads as BUSY
 * (fail-safe — the operator Force override remains available).
 *
 * Direct reference to the lib/release-watch module function — safe detached
 * (it reads the module-scope probe registry, never `this`).
 *
 * @param {string} name - Probe name (unique; re-registering overwrites with a warning)
 * @param {function} fn - The probe
 * @returns {void}
 * @example
 *   gina.registerBusyProbe('imports', function() {
 *       return { busy: importQueue.size > 0, detail: importQueue.size + ' imports pending' };
 *   });
 */
gna.registerBusyProbe = lib.releaseWatch.registerBusyProbe;

/**
 * #STO1 — get a configured object-storage driver.
 *
 * The producer surface for server-GENERATED files (rendered PDFs, exports,
 * archives): anything that is not an inbound upload. The upload path keeps its
 * own `self.store()` route for now.
 *
 * Assigned UNCONDITIONALLY, so a bundle with no `storage` block gets a named
 * error naming the fix instead of `gna.storage is not a function` — and so the
 * declaration is a plain function rather than one the caller must narrow.
 *
 * @param {string} [name] - Driver name; omitted returns the `storage.default` driver.
 * @returns {object} The driver (`put` / `get` / `stat` / `release` / `resolve` / `capabilities`).
 * @throws {Error} When storage is not configured, when no default is declared and `name`
 *                 was omitted, or when `name` is not a configured driver.
 * @example
 *   gna.storage().put(pdfStream, { originalName: 'invoice.pdf' }, function (err, res) {
 *       if (err) { return next(err); }
 *       invoice.storageKey = res.key;   // opaque — store it, never parse it
 *   });
 * @example
 *   gina.storage('archives');  // a named driver
 */
gna.storage = function(name) {
    return lib.storage.get(name);
};

/**
 * #KV1 — get a configured KV namespace.
 *
 * The general-purpose key-value surface (counters, one-shot tokens,
 * fetch-or-compute caching, lease primitives) — strict-declared: a namespace
 * must exist under `settings.json > kv.namespaces` or this throws at the
 * call site, which is what surfaces a typo (the `gna.storage` stance).
 *
 * Assigned UNCONDITIONALLY, so a bundle with no `kv` block gets a named
 * error naming the fix instead of `gna.kv is not a function` — and so the
 * declaration is a plain function rather than one the caller must narrow.
 *
 * @param {string} [name] - Namespace name; omitted returns the `kv.default` namespace.
 * @returns {object} The namespace handle (`get` / `set` / `del` / `has` / `ttl` /
 *                   `expire` / `setnx` / `consume` / `incr` / `decr` /
 *                   `delIfEquals` / `clear` / `getOrSet` — all promise-returning).
 * @throws {Error} When kv is not configured, when no default is declared and `name`
 *                 was omitted, or when `name` is not a declared namespace.
 * @example
 *   gna.kv('tokens').consume('t:' + hash).then(function (record) {
 *       if (record === null) { return self.throwError(410, 'link already used'); }
 *   });
 * @example
 *   gina.kv();  // the `kv.default` namespace
 */
gna.kv = function(name) {
    return lib.kv.get(name);
};

/**
 * #B366 — push a payload to ONE named session from OUTSIDE a request.
 *
 * `self.push()` needs a live request-bound controller, so code that has none —
 * a `lib/job` handler, a cron tick, a boot hook — had no sanctioned route to a
 * user's socket. This is that route, and it is deliberately narrow:
 *
 *   - `sessionID` is REQUIRED. An absent or empty recipient is an error, never
 *     a fan-out. There is no broadcast reachable from here at all; the
 *     deliberate all-clients send stays in-request as
 *     `self.push(payload, { broadcast: true })`.
 *   - The recipient must come from server-held state — captured when the work
 *     was queued, and kept server-side. Never round-trip it (or a token naming
 *     it) through the browser: that hands the choice back to the caller and
 *     re-opens #B364 one layer up.
 *   - Delivery is reported, not assumed: `delivered` is how many sockets were
 *     written, and `0` is a normal outcome, not an error.
 *
 * Requires the isaac engine with `settings.json > server.ioServer` attached;
 * the express engine has no engine.io channel and gets a named error.
 *
 * Assigned UNCONDITIONALLY (same reasoning as `gna.storage` above), so a
 * misconfigured bundle gets an error naming the fix rather than
 * `gna.pushToSession is not a function`.
 *
 * @param {string}        sessionID          - REQUIRED recipient session id.
 * @param {object|string} payload            - Object (JSON-stringified) or a pre-serialized string.
 * @param {object}        [option]           - Forwarded to the transport (e.g. `{ compress: true }`).
 * @param {string}        [option.section]   - Stamped onto an object payload lacking one.
 * @param {function}      [callback]         - `callback(err, { delivered })`, called exactly once.
 * @returns {void}
 * @example
 *   // in a job handler — sessionID was captured when the job was created
 *   gina.pushToSession(job.sessionID, { event: 'export:ready', key: res.key }, function (err, out) {
 *       if (err) { return console.error(err.code, err.message); }
 *       if (!out.delivered) { console.debug('nobody listening — the user closed the tab'); }
 *   });
 */
gna.pushToSession = function(sessionID, payload, option, callback) {
    var instance = ( process.gina ) ? process.gina._serverInstance : null;
    if ( instance == null ) {
        var err = new Error(
            '[ push ] the server instance is not published yet, so there is no socket set to reach. '
            + 'This is normal before the bundle has served its first request.'
        );
        err.code = 'PUSH_CHANNEL_NOT_READY';
        if ( typeof(option) == 'function' ) { return option(err); }
        if ( typeof(callback) == 'function' ) { return callback(err); }
        throw err;
    }
    return lib.push.toSession(instance, sessionID, payload, option, callback);
};

// ── JSON helper (framework/v*/helpers/json/src/main.js) ──────────────────

/**
 * Read a JSON file, strip `//` and `/* ... *\/` comments, tolerate trailing
 * commas, and return the parsed object.
 *
 * @param {string} filename - Absolute path to the JSON file
 * @returns {object} Parsed content
 * @throws {Error} When the file cannot be read or the JSON is malformed
 * @example
 *   var cfg = requireJSON(_(root + '/manifest.json'));
 */
gna.requireJSON = requireJSON;

// ── Task helper (framework/v*/helpers/task.js) ───────────────────────────

/**
 * Run a shell command via `child_process.spawn` with a Promise-friendly
 * `onComplete` / `onData` EventEmitter API.
 *
 * @param {string|string[]} cmdline - Command as string or argv array
 * @param {object}          [opt]   - Options (`cwd`, `tmp`, `outToProcessSTD`)
 * @param {function}        [cb]    - Optional callback `(err, stdout)`
 * @returns {EventEmitter} Emitter with `onData(cb)` and `onComplete(cb)` helpers
 * @example
 *   run('ls -la', { cwd: process.cwd() }).onComplete(function(err, out) {
 *       console.log(out);
 *   });
 */
gna.run = run;

// ── Data helpers (framework/v*/helpers/data/src/main.js) ─────────────────

/**
 * URL-encode a string per RFC 5987 (adds `!` handling and `*` → `%2A`).
 *
 * @param {string} str - Raw string
 * @returns {string} RFC-5987-encoded value
 * @example
 *   encodeRFC5987ValueChars("O'Brien (1)"); // "O%27Brien%20%281%29"
 */
gna.encodeRFC5987ValueChars = encodeRFC5987ValueChars;

/**
 * Percent-decode a string, returning it unchanged on a malformed `%` escape
 * (`decodeURIComponent` would throw `URIError`). Crash-safe decode for the
 * server request path — see {@link safeDecodeURIComponent} in helpers/data (#B30).
 *
 * @param {string} str - Value to decode
 * @returns {string} Decoded value, or the original string on URIError
 * @example
 *   safeDecodeURIComponent('100%'); // "100%" (decodeURIComponent would throw)
 */
gna.safeDecodeURIComponent = safeDecodeURIComponent;

/**
 * Whole-URI variant of {@link safeDecodeURIComponent} — wraps `decodeURI`
 * (leaves `/ ? #` intact) and returns the input unchanged on a malformed `%`
 * escape, so the routing / error paths cannot crash on a bad URL (#B30).
 *
 * @param {string} str - Value to decode
 * @returns {string} Decoded value, or the original string on URIError
 * @example
 *   safeDecodeURI('/a%E0%A'); // "/a%E0%A" (decodeURI would throw)
 */
gna.safeDecodeURI = safeDecodeURI;

/**
 * Parse a form/body string (`application/x-www-form-urlencoded` or JSON) into
 * a nested object. Recognises PHP-style `foo[bar][0]` keys.
 *
 * @param {string|object} bodyStr - Body string; objects are `JSON.stringify`-ed first
 * @returns {object} Parsed object
 * @example
 *   formatDataFromString('user[name]=Ada&user[age]=37');
 *   // → { user: { name: 'Ada', age: '37' } }
 */
gna.formatDataFromString = formatDataFromString;

// ── Text helper (framework/v*/helpers/text.js) ───────────────────────────

/**
 * Legacy one-arg translation alias. Forwards to {@link gna.t} (no culture
 * arg → returns the key verbatim when nothing matches, matching the
 * historical no-op behaviour). Preserved for back-compat — new code should
 * call {@link gna.t} directly with explicit culture.
 *
 * @param {string} str - Source key
 * @returns {string} Translated value or `str` verbatim
 * @example
 *   __('common.welcome');
 */
gna.__ = __;

// ── i18n primitive (framework/v*/lib/i18n) ───────────────────────────────

/**
 * Translate a key. Walks the fallback chain (specific culture → base
 * language → bundle default → process default → 'en'), resolves the dotted
 * path, applies CLDR plural rules when `params.count` is present and the
 * value is a plural-form object, then runs `{name}`-style interpolation.
 *
 * Culture is required for actual lookup; omitting it returns the key
 * verbatim (back-compat with the legacy `__()` shape). Inside controller
 * actions, prefer the `self.t(key, params)` helper which auto-binds
 * `req.culture`. Inside templates, use the swig / nunjucks `t` filter.
 *
 * @param {string}        key
 * @param {Object|null}   [params]
 * @param {string}        [culture] - Required for lookup; e.g. `'en_US'`, `'fr'`.
 * @param {Object}        [options]
 * @param {string}        [options.bundleName]     - Defaults to `process.env.GINA_BUNDLE`.
 * @param {string}        [options.defaultCulture] - Bundle default culture.
 * @param {string[]}      [options.fallbackChain]  - Override of the fallback chain.
 * @param {string}        [options.devMissingKey]  - Dev-mode prefix for missing keys.
 * @returns {string}
 * @example
 *   t('common.welcome', {},                'en_US', { bundleName: 'dashboard' });
 *   t('common.greeting', { name: 'Ada' },  'fr',    { bundleName: 'dashboard' });
 *   t('common.items',    { count: 5 },     'en',    { bundleName: 'dashboard' });
 */
gna.t = function(key, params, culture, options) {
    return lib.i18n.t(key, params, culture, options);
};

/**
 * #I18N2 — ICU MessageFormat opt-in. Same signature as {@link gna.t} but
 * resolves the catalog string as ICU MessageFormat syntax (plural / select
 * / gender / nested combinators) via the `intl-messageformat` package.
 * Powered by a dynamic-import loader kicked off at bundle boot from
 * {@link loadCatalogs} — sync after the loader resolves.
 *
 * Catalog values that are NOT strings (plural-form objects, nested
 * categories) fall through to {@link gna.t} so v1 and ICU shapes coexist
 * freely in one catalog. Strings, in contrast, are interpreted as ICU MF.
 *
 * Throws if called before the loader settles, or if `intl-messageformat`
 * is not installed in the bundle's `node_modules` (the error message
 * carries the install hint).
 *
 * @param {string}      key
 * @param {Object|null} [params]
 * @param {string}      [culture]
 * @param {Object}      [options]
 * @returns {string}
 * @example
 *   gna.t.icu('items', { count: 5 }, 'en', { bundleName: 'dashboard' });
 *   // → '5 items' for "items": "{count, plural, one {# item} other {# items}}"
 * @example
 *   gna.t.icu('greeting', { gender: 'female', name: 'Ada' }, 'en', { bundleName: 'dashboard' });
 *   // → 'Hi, Ada!' for "greeting": "{gender, select, female {Hi, {name}!} other {Hello, {name}!}}"
 */
gna.t.icu = function(key, params, culture, options) {
    return lib.i18n.tIcu(key, params, culture, options);
};

// ── Console helper (framework/v*/helpers/console.js) ─────────────────────

/**
 * Write arguments to `process.stdout` followed by a newline. Objects are
 * JSON-stringified with tab indentation.
 *
 * @param {...*} args - Values to print
 * @returns {void}
 * @example
 *   log('debug', { a: 1 });
 */
gna.log = log;

// ── Env helpers (utils/helper.js) ────────────────────────────────────────

/**
 * Read a `GINA_*` / `VENDOR_*` / `USER_*` env var from `process.gina`.
 *
 * @param {string} key - Variable name
 * @returns {*|undefined} Stored value, or `undefined` when not set
 * @example
 *   var dir = getEnvVar('GINA_HOMEDIR');
 */
gna.getEnvVar = getEnvVar;

/**
 * Return the entire `process.gina` env-var map.
 *
 * @returns {object} All gina-scoped env vars
 * @example
 *   for (var k in getEnvVars()) { console.log(k, getEnvVars()[k]); }
 */
gna.getEnvVars = getEnvVars;

/**
 * Set a `GINA_*` / `VENDOR_*` / `USER_*` env var in `process.gina`.
 * Auto-prefixes `USER_` when the key is unprefixed.
 *
 * @param {string}  key           - Variable name
 * @param {*}       val           - Value
 * @param {boolean} [isProtected] - When `true`, later `setEnvVar` calls cannot override it
 * @returns {void}
 * @example
 *   setEnvVar('GINA_CULTURE', 'en-US');
 */
gna.setEnvVar = setEnvVar;

/**
 * List keys that were marked protected via `setEnvVar(..., true)`.
 *
 * @returns {string[]} Array of protected env-var names
 * @example
 *   getProtected(); // ['GINA_CULTURE', ...]
 */
gna.getProtected = getProtected;

/**
 * Scan `process.argv` for `--key=value` flags, promote them to `process.gina`
 * env vars, then strip them from `argv`. Runs once during CLI bootstrap.
 *
 * @returns {void}
 * @example
 *   filterArgs(); // after: process.gina.GINA_ENV === 'dev'
 */
gna.filterArgs = filterArgs;

/**
 * Import `GINA_*` / `VENDOR_*` / `USER_*` keys from `process.env` into the
 * framework environment (`process.gina`). Move semantics by default — the
 * `filterArgs()` sweep deletes each imported key from `process.env`. Pass
 * `keep=true` for the early visibility pass (`bin/cli` runs it before its
 * home/settings/host resolution) that leaves `process.env` intact for the
 * later sweep. Idempotent in both modes.
 *
 * @param {boolean} [keep] - Import without deleting from `process.env`
 * @returns {void}
 * @example
 *   importEnvVars(true); // process.gina.GINA_ENV === 'dev'; process.env.GINA_ENV intact
 */
gna.importEnvVars = importEnvVars;

/**
 * Resolve the log directory — `GINA_LOGDIR` / `LOGDIR` / prefix `var/log`
 * with fallback to `~/.gina/log`. Creates it if missing.
 *
 * @returns {string} Absolute log-dir path
 * @example
 *   var dir = getLogDir();
 */
gna.getLogDir = getLogDir;

/**
 * Resolve the run/lock directory — prefix `var/lock` with fallback to
 * `~/.gina/run`. Creates it if missing.
 *
 * @returns {string} Absolute run-dir path
 * @example
 *   var dir = getRunDir();
 */
gna.getRunDir = getRunDir;

/**
 * Resolve the tmp directory — `GINA_TMPDIR` / `os.tmpdir()` with fallback to
 * prefix `var/tmp`.
 *
 * @returns {string} Absolute tmp-dir path
 * @example
 *   var dir = getTmpDir();
 */
gna.getTmpDir = getTmpDir;

/**
 * Read the saved startup argv for a given bundle@project — used by
 * `gina bundle:restart` to re-issue the exact same start command.
 *
 * @param {string} bundle  - Bundle name
 * @param {string} project - Project name
 * @returns {string|null} Space-separated argv, or `null` when no file exists
 * @example
 *   var argv = getBundleStartingArgv('myApp', 'demo');
 */
gna.getBundleStartingArgv = getBundleStartingArgv;

/**
 * Resolve the user's home directory (`USERPROFILE` on win32, `HOME`
 * elsewhere). Validates writability.
 *
 * @returns {string} Home-directory path
 * @throws {Error} When the home dir is missing or not writable
 * @example
 *   var home = getUserHome();
 */
gna.getUserHome = getUserHome;

/**
 * Read a vendor config loaded via `setVendorsConfig`.
 *
 * @param {string} [vendor] - Vendor key; omit for the whole map
 * @returns {object|undefined} Vendor config, or full map
 * @example
 *   var aws = getVendorsConfig('aws');
 */
gna.getVendorsConfig = getVendorsConfig;

/**
 * Load every `*.json` file in `dir` as a vendor config keyed by filename.
 *
 * @param {string} dir - Directory containing vendor config files
 * @returns {void}
 * @example
 *   setVendorsConfig(_(getPath('project') + '/config/vendors', true));
 */
gna.setVendorsConfig = setVendorsConfig;

/**
 * Bulk-register an object of env vars as `USER_*` defaults via `define`.
 *
 * @param {object} obj - Map of `name → value`
 * @returns {void}
 * @example
 *   defineDefault({ MY_FLAG: true });
 */
gna.defineDefault = defineDefault;

/**
 * Convert a user-facing timeout ("30s", "500ms", "1m", "2h", `number`, `false`)
 * to milliseconds. Returns `null` when the timeout is disabled/invalid.
 *
 * @param {string|number|boolean|null} value - Raw value
 * @returns {number|null} Milliseconds, or `null`
 * @example
 *   parseTimeout('30s'); // 30000
 *   parseTimeout(false); // null
 */
gna.parseTimeout = parseTimeout;

/**
 * Framework's deep-merge helper — loaded via `utils/helper.js` and also
 * available as `lib.merge`.
 *
 * @param {object}  target   - Destination object (mutated)
 * @param {object}  source   - Source object
 * @param {boolean} [force]  - Overwrite primitives when both sides define them
 * @returns {object} The merged target
 * @example
 *   var out = merge({ a: 1 }, { b: 2 });
 */
gna.merge = merge;

// ── Plugin helpers (framework/v*/helpers/plugins/src/main.js) ────────────

/**
 * Validation/API-error class used by controller actions and the Validator
 * plugin. Falls back to the framework built-in even when Validator is not
 * loaded (see helpers/index.js).
 *
 * @class
 * @example
 *   throw new ApiError('Invalid payload', 400);
 */
gna.ApiError = (typeof ApiError !== 'undefined') ? ApiError : undefined;


module.exports = gna