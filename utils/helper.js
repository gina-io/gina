var fs = require('fs');
var os = require('os');
var { execSync } = require('child_process');

var lib         = null;
var console     = null;
merge           = null;

function MainHelper(opt) {
    var self = {
        protectedVars : [],
        config : {}
    };


    var init = function(opt) {
        //Load prototypes.
        require('./prototypes');

        //Load librairies.
        var isWin32 = (process.platform === 'win32') ? true : false;
        var scriptPath = __dirname;
        var ginaPath = (scriptPath.replace(/\\/g, '/')).replace('/utils', '');
        var pack        = ginaPath + '/package.json';
        pack =  (isWin32) ? pack.replace(/\//g, '\\') : pack;
        var packObj = require(pack);
        var version =  getEnvVar('GINA_VERSION') || packObj.version;
        var frameworkPath = ginaPath + '/framework/v' + version;
        var pkg = null, cmd = null, prefix = null;
        self.isGlobalInstall = getEnvVar('GINA_GLOBAL_MODE') || ( typeof(packObj.config) != 'undefined' && typeof(packObj.config.globalMode) != 'undefined' ) ? packObj.config.globalMode : true;
        try {
            // TODO - remove this code: it is creating a circular dependency
            // lib         = require(frameworkPath + '/lib');
            // console     = lib.logger;
            // merge       = lib.merge;

            console = require(frameworkPath + '/lib/logger');
            merge   = require(frameworkPath + '/lib/merge');

            try {
                pkg = packObj;
                self.defaultPrefix = ( typeof(packObj.config) != 'undefined' && typeof(packObj.config.prefix) != 'undefined' ) ? packObj.config.prefix : execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');
                self.defaultPrefix = self.defaultPrefix.replace(/^\~/, getUserHome());
                prefix = getEnvVar('GINA_PREFIX') || self.defaultPrefix;
                self.optionalPrefix = pkg.config.optionalPrefix.replace(/^\~/, getUserHome());
            } catch(err) {
                console.warn('MainHelper::Init() Execption: '+ err.stack);
                console.debug('Trying alternative config');
                try {
                    self.defaultPrefix = execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');
                    prefix = getEnvVar('GINA_PREFIX') || self.defaultPrefix;
                    cmd = 'npm list gina --long --json --prefix='+ prefix;
                    if (self.isGlobalInstall) {
                        cmd += ' -g';
                    }
                    pkg = execSync(cmd).toString().replace(/\n$/g, '');
                    self.optionalPrefix = JSON.parse(pkg).dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());
                } catch (_err) {
                    throw new Error(_err.stack +'\n'+ err.stack)
                }
            }

        } catch (err) {
            // this can happen in certain conditions
            // like scripts running out of the framework context
            // we'll just ignore it
        }
    }


    isWin32 = function() {
        return ( os.platform() == 'win32' ) ? true : false;
    }

    filterArgs = function() {

        var setget  = ( typeof(process.argv[2]) != 'undefined'
                            && /(\:set$|\:get$|[-v]|\:version$|[--version])/.test(process.argv[2]))
                            ? true : false
            , evar  = ''
            , err   = null
        ;

        // #B40 — Treat framework-connection flags (--port, --mq-port, --host-v4,
        // --hostname, --debug-port) as framework settings ONLY for framework-scoped
        // commands (bare commands like `start`/`stop`/`restart` — prefixed to
        // `framework:*` downstream — or explicit `framework:*`). For a sub-topic
        // command (`port:set <bundle> --port=N`, `bundle:start ... --port=N`, ...)
        // `--port` is the BUNDLE's port; hoisting it into GINA_PORT made
        // framework:init overwrite the framework socket port in
        // ~/.gina/<short>/settings.json, so later online commands connected to the
        // wrong port and reported "[ gina ] not started".
        var _topic = ( typeof(process.argv[2]) != 'undefined' ) ? process.argv[2] : '';
        var _isFrameworkScopedCmd = ( _topic.indexOf(':') < 0 || /^framework:/.test(_topic) );

        // Init target fixed (#B160-sibling): this guarded process.ENV['gina']
        // — an object assigned to process.env coerces to the junk string
        // "[object Object]", exported to every child — while the
        // argv-promotion loop below writes process['gina'], a latent
        // TypeError for any embedder calling filterArgs() before the first
        // setEnvVar().
        if ( typeof(process['gina']) == 'undefined') {
            process['gina'] = {}
        }

        var newArgv = {};
        for (let a in process.argv) {
            if ( /\-\-/.test(process.argv[a]) && process.argv[a].indexOf('=') > -1 ) {
                // special cases
                if (/\-\-(prefix|env|scope|gina-version)/.test(process.argv[a])) {
                    continue;
                }

                // #B40 — don't hoist framework-connection flags for sub-topic
                // commands; keep them in argv for the sub-command's own parser
                // (e.g. port:set reads --port itself). Framework-scoped commands
                // still hoist them (so `gina start --port=N` / `framework:set
                // --port=N` persist to settings.json as intended).
                if ( !_isFrameworkScopedCmd && /^\-\-(port|mq-port|host-v4|bind-host|bind_host|hostname|debug-port|debug_port)=/.test(process.argv[a]) ) {
                    newArgv[a] = process.argv[a];
                    continue;
                }


                // Split on the first `=` only. Values with `=` (e.g.
                // `--driver-version=">=5.3.0 <6.0.0"`, base64-ish passwords,
                // api keys) would otherwise be silently truncated.
                var _raw = (process.argv[a].replace(/--/, '')).replace(/-/, '_');
                var _eq  = _raw.indexOf('=');
                evar     = (_eq > -1) ? [ _raw.substring(0, _eq), _raw.substring(_eq + 1) ] : [ _raw ];

                evar[0] = evar[0].toUpperCase();
                if (
                    evar[0].substring(0, 5) !== 'GINA_' &&
                    evar[0].substring(0, 7) !== 'VENDOR_' &&
                    evar[0].substring(0, 5) !== 'USER_'
                    ) {
                    evar[0] = 'GINA_' + evar[0]
                }
                //Boolean values.
                if (evar[1] === "true") {
                    evar[1] = true
                }
                if (evar[1] === "false") {
                    evar[1] = false
                }
                //Avoid protected.
                if (self.protectedVars.indexOf(evar[0]) == -1 ) {
                    process.gina[evar[0]] = evar[1];
                } else {
                    //throw new Error('gina won\'t override protected env var [ ' +evar[0]+ ' ] or constant.')
                    err = new Error('gina won\'t override protected env var [ ' +evar[0]+ ' ] or constant.');
                    console.error(err.stack||err.message);
                    return;
                }

            } else {
                newArgv[a] = process.argv[a]
            }
        }

        //Cleaning argv.
        if (!setget)
            process.argv = newArgv;

        // Cleaning the rest — the env sweep, extracted to importEnvVars() so
        // bin/cli can run an early keep-mode visibility pass before its
        // home/settings/host resolution block. Move semantics here: swept
        // keys leave process.env, exactly as before the extraction.
        importEnvVars();

        setContext('envVars', process['gina']);
    }

    /**
     * importEnvVars
     * Imports every `GINA_*` / `VENDOR_*` / `USER_*` key from `process.env`
     * into the framework environment (`process.gina`). With `keep` falsy —
     * the sweep, run by `filterArgs()` — each imported key is DELETED from
     * `process.env`. With `keep` truthy — the early visibility pass in
     * `bin/cli` — `process.env` is left untouched, so the later sweep still
     * runs its move semantics and the post-sweep state (shell values winning
     * over in-bootstrap `setEnvVar` writes) is unchanged. Idempotent in both
     * modes.
     *
     * @param {boolean} [keep] - Import without deleting from `process.env`
     */
    importEnvVars = function(keep) {
        if ( typeof(process['gina']) == 'undefined') {
            process['gina'] = {}
        }
        for (let e in process.env) {
            if (
                e.substring(0, 5) === 'GINA_' ||
                e.substring(0, 7) === 'VENDOR_' ||
                e.substring(0, 5) === 'USER_'
                ) {
                process['gina'][e] = process.env[e];
                if (!keep) {
                    delete process.env[e]
                }
            }
        }
    }

    /**
     * getEnvVar
     * Will read from `process.gina` which is set mostly in `cli.js`
     *
     * @param {string} key
     */
    getEnvVar = function(key) {
        if (
            typeof(process['gina']) != 'undefined' &&
            typeof(process['gina'][key]) != 'undefined' &&
            process['gina'][key] != ''
            ) {
            return process['gina'][key]
        }
        return undefined
    }

    getEnvVars = function() {
        return process.gina
    }

    getProtected = function() {
        return self.protectedVars
    }

    /**
     * Get log path - %SystemRoot%\system32\winevt\logs or /
     *
     * @returns {string} logPath
     * */
    getLogDir = function() {
        // Trying to retrieve original value if already defined
        var logDir = getEnvVar('GINA_LOGDIR') || null;
        var logDirObj = null;
        if ( logDir ) {
            logDirObj = new _(logDir, true);
            if ( !logDirObj.existsSync() ) {
                logDirObj.mkdirSync()
            }
            return logDir
        }

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix || self.defaultPrefix || execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');

        if ( isWin32() ) {
            logDir = process.env.LOG ||
                process.env.LOGS ||
                (process.env.SystemRoot || process.env.windir) + '\\System32\\Winevt\\Logs'
            ;

            if ( !logDir || logDir == '' ) {
                throw new Error('Log directory not defined or not found !');
            }

            logDirObj = new _(logDir);
            if ( !logDirObj.isWritableSync() ) {
                throw new Error('Log directory found but not writable: need permissions for `'+ logDir +'`');
            }

            if ( !/gina$/.test(logDir) ) {
                logDir += '\\gina';
                logDirObj = new _(logDir);
            }
        } else {
            logDir = process.env.LOGDIR ||
                process.env.LOG ||
                process.env.LOGS ||
                prefix+'/var/log'
            ;
            logDirObj = new _(logDir);
            if ( new RegExp('^'+ prefix).test(logDir) && !new _(prefix).isWritableSync() ) {
                logDir = getUserHome() +'/.gina/log';
                logDirObj = new _(logDir);
                if ( !logDirObj.existsSync() ) {
                    logDirObj.mkdirSync()
                }

                return logDir
            }

            if ( new RegExp('^'+ prefix +'/var').test(logDir) && !new _(prefix +'/var').existsSync() ) {
                fs.mkdirSync(prefix +'/var');
            }

            if ( !logDirObj.existsSync() ) {
                logDirObj.mkdirSync();
            }

            if ( !/gina$/.test(logDir) && self.optionalPrefix != prefix ) {
                logDir += '/gina';
                logDirObj = new _(logDir);
            }
        }

        if ( !logDirObj.existsSync() ) {
            logDirObj.mkdirSync()
        }

        return logDir;
    }


    /**
     * Get run\lock path
     * @returns {string} rundir
     * */
    getRunDir = function() {
        // Trying to retrieve original value if already defined
        var runDir = getEnvVar('GINA_RUNDIR') || null;
        var runDirObj = null;
        if ( runDir ) {
            runDirObj = new _(runDir, true);
            if ( !runDirObj.existsSync() ) {
                runDirObj.mkdirSync()
            }
            return runDir
        }

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix || self.defaultPrefix || execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');

        runDir = (isWin32()) ? getUserHome() + '\\.gina\\run' : prefix + '/var/lock';

        if ( !isWin32() && new RegExp('^'+ prefix).test(runDir) && !new _(prefix).isWritableSync() ) {
            runDir = getUserHome() +'/.gina/run';
            runDirObj = new _( runDir, true );
            if ( !runDirObj.existsSync() ) {
                runDirObj.mkdirSync()
            }

            return runDir
        }


        runDirObj = new _( runDir, true );
        if ( runDirObj.existsSync() ) {
            if ( !runDirObj.isWritableSync() ) {
                throw new Error('location `'+ runDir +'` found but not writable !' )
            }

            runDir += ( isWin32() ) ? '' : '/gina';
            runDirObj = new _( runDir, true );
            if ( !runDirObj.existsSync() ) {
                runDirObj.mkdirSync()
            }

            return runDir;
        }

        try {
            if ( new RegExp('^'+ prefix +'/var').test(runDir) && !new _(prefix + '/var').existsSync() ) {
                fs.mkdirSync(prefix +'/var');
            }

            runDir = prefix +'/var/run';//by default.
            if ( ! new _(runDir).existsSync() ) {
                fs.mkdirSync(runDir)
            }
        } catch (err) {
            throw new Error('location error: `'+ runDir+'`\n'+ err.stack);
        }

        if (self.optionalPrefix != prefix) {
            runDir += ( isWin32() ) ? '\\gina' : '/gina';
            runDirObj = new _( runDir, true );
            if ( !runDirObj.existsSync() ) {
                fs.mkdirSync(runDir)
            }
        }

        return runDir;
    }

    getTmpDir = function() {

        var dir = getEnvVar('GINA_TMPDIR') || null;
        if (dir) {
            dirObj = new _(dir, true);
            if ( !dirObj.existsSync() ) {
                dirObj.mkdirSync()
            }
            return dir
        }

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix  || self.defaultPrefix || execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');

        // support for node 0.10.x & 0.11.x
        var tmp = (os.tmpdir) ? os.tmpdir : function() {
            var tmpDir = null;
            if ( isWin32() ) {
                tmpDir = process.env.TEMP ||
                    process.env.TMP ||
                    (process.env.SystemRoot || process.env.windir) + '\\Temp'
            } else {
                tmpDir = process.env.TMPDIR ||
                    process.env.TMP ||
                    process.env.TEMP ||
                    prefix+'/var/tmp'
                ;

                if ( new RegExp('^'+ prefix).test(tmpDir) && !isWritableSync(prefix) ) {
                    tmpDir = getUserHome() +'/.gina/tmp';
                    if ( ! new _(tmpDir).existsSync() ) {
                        fs.mkdirSync(tmpDir)
                    }
                }

                if ( new RegExp('^'+ prefix +'/var').test(tmpDir) && !new _(prefix +'/var').existsSync() ) {
                    fs.mkdirSync(prefix +'/var');
                }
            }

            var tmpDirObj = new _(tmpDir);
            if ( !tmpDirObj.existsSync() ) {
                tmpDirObj.mkdirSync();
            }
        };

        return tmp()
    }

    /**
     * getArgvDir
     * Directory holding each bundle's saved start argv (`<bundle>@<project>.argv`):
     * written by the `gina` wrapper at every `bundle:start` / `bundle:restart`, read
     * back by `gina tail --follow` to restart a crashed bundle. It is
     * `<GINA_HOMEDIR>/run` — the framework home from the framework env or the shell,
     * else `$HOME/.gina`, as `bin/cli` resolves it — created `0700` when absent.
     * Never the shared tmp dir: the caller executes that file's first token, and a
     * tmp dir other users of the host can write lets them plant or pre-own it (#B676).
     *
     * @returns {string} Path of the argv dir
     * @example
     *   var file = getArgvDir() + '/api@myproject.argv';
     */
    getArgvDir = function() {
        var home = getEnvVar('GINA_HOMEDIR') || process.env.GINA_HOMEDIR || (getUserHome() + '/.gina');
        var dir  = home + '/run';
        if ( !fs.existsSync(dir) ) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        return dir
    }

    /**
     * getBundleStartingArgv
     * Reads the saved start argv for `<bundle>@<project>` from the argv dir
     * (`getArgvDir()`) so a crashed bundle can be live-restarted (see
     * `gina tail --follow`, which executes the first token of the returned argv).
     *
     * `bundle`/`project` are treated as untrusted (they may be parsed from log
     * content): values containing path separators or `..` traversal are rejected
     * and the resolved path is confined to the argv dir. The file itself is
     * trusted by OWNERSHIP, never by content (#B676): on POSIX it must be a
     * regular file owned by the current uid that group/other cannot write, or it
     * is refused with a warning. Returns `null` when the input is unsafe, no
     * saved-argv file exists, or the file fails that ownership check.
     *
     * @param {string} bundle  - Bundle name (sanitized; path separators rejected)
     * @param {string} project - Project name (sanitized; path separators rejected)
     *
     * @returns {string|null} Space-separated argv, or `null`
     * */
    getBundleStartingArgv = function(bundle, project) {
        // #SEC - `bundle`/`project` can originate from parsed log content (the
        // `gina tail --follow` auto-restart path), so treat them as untrusted: strip
        // backticks/whitespace, then reject anything that could escape the argv dir
        // (path separators or `..` traversal). The returned value is later executed
        // by the caller, so a crafted descriptor must NOT redirect the lookup to a
        // file outside the argv dir.
        bundle  = ('' + bundle).replace(/(`|\s+)/g, '');
        project = ('' + project).replace(/(`|\s+)/g, '');

        if (
            bundle === '' || project === ''
            || /[\/\\]/.test(bundle)      || /[\/\\]/.test(project)
            || bundle.indexOf('..') > -1  || project.indexOf('..') > -1
        ) {
            return null;
        }

        // #B676 — was: the lookup ran in the shared tmp dir, where another user of the host could
        // plant the file or pre-own it; the file now lives in the user-owned argv dir.
        // var tmpDir   = _(getTmpDir(), true);
        // var filename = _(tmpDir +'/'+ bundle +'@'+ project +'.argv', true);
        var argvDir  = _(getArgvDir(), true);
        var filename = _(argvDir +'/'+ bundle +'@'+ project +'.argv', true);

        // defense-in-depth: resolved path must stay under the argv dir
        if ( ('' + filename).indexOf('' + argvDir) !== 0 ) {
            return null;
        }

        var content = null;
        if ( fs.existsSync(filename) ) {
            // #B676 — the file is trusted by OWNERSHIP, never by content: the caller executes its
            // first token. Refuse, loudly, a file that is not a regular file owned by this uid, or
            // that group/other can write (POSIX only; win32 has no uid).
            if ( typeof process.getuid === 'function' ) {
                var st = null;
                try { st = fs.statSync('' + filename); } catch (statErr) { return null; }
                if ( !st.isFile() || st.uid !== process.getuid() || (st.mode & 0o022) !== 0 ) {
                    var refusal = '[getBundleStartingArgv] refusing `' + filename + '`: expected a regular file owned by uid '
                        + process.getuid() + ' and not writable by group/other (found uid ' + st.uid
                        + ', mode ' + (st.mode & 0o777).toString(8) + ')';
                    // `console` is this file's logger, null until init() loads it — fall back to stderr
                    if ( console && typeof console.warn === 'function' ) {
                        console.warn(refusal);
                    } else {
                        process.stderr.write(refusal + '\n');
                    }
                    return null;
                }
            }
            delete require.cache[require.resolve(filename)];
            content = ''+fs.readFileSync(filename);
            content = content.replace(/\,/g, ' ');
        }
        // console.debug("@filename: ", filename, content);
        return content
    }

    /**
     * isWritableSync
     * Only used for `getUserHome()`
     *
     * @param {string} path
     */
    var isWritableSync = function(path) {
        var canWrite = false;
        if ( typeof(fs.accessSync) != 'undefined' ) {
            try {
                fs.accessSync(path, fs.constants.W_OK);
                canWrite = true;
            } catch (err) {
                canWrite = false;
            }
        } else { // support for old version of nodejs

            try {
                canWrite = (fs.statSync(path).mode & (fs.constants.S_IRUSR | fs.constants.S_IRGRP | fs.constants.S_IROTH));
            } catch (err) {
                canWrite = false
            }
        }

        return canWrite
    };

    getUserHome = function() {
        var homeDir = process.env[(isWin32()) ? 'USERPROFILE' : 'HOME'];

        if ( !homeDir || homeDir == '' ) {
            throw new Error('Home directory not defined or not found !');
        }


        if ( !isWritableSync(homeDir) ) {
            throw new Error('Home directory found but not writable: need permissions for `'+ homeDir +'`');
        }

        return homeDir
    }

    getVendorsConfig = function(vendor) {
        var msg = 'Helper could not load ['+ vendor +'] config.';
        if ( typeof(vendor) != 'undefined' ) {
            try {
                return self.config[vendor]
            } catch (err) {
                //throw new Error(msg);
                console.error(err.stack||err.message);
                return;
            }
        } else {
            return self.config
        }
    }

    setVendorsConfig = function(dir) {
        if ( !fs.existsSync(dir) ) {
            console.debug('Directory [' + dir + '] is missing !')
        } else {
            var files = fs.readdirSync(dir), filename = "";
            var file = '', a = [];
            for (let f = 0; f < files.length; ++f) {
                filename = dir + '/' + files[f];
                file = ( a = files[f].split('.'), a.splice(0, a.length-1)).join('.');
                self.config[file] = require(filename)
            }
            files   = null;
            file    = null;
            a       = null;
        }
    }

    setEnvVar = function(key, val, isProtected) {
        key = key.toUpperCase();
        var err                     = null
            // related task `framework:set` & framework/v.xxx/lib/cmd/framework/init.js
            , specialCases          = ['GINA_PORT', 'GINA_DEBUG_PORT', 'GINA_CULTURE', 'GINA_TIMEZONE', 'GINA_PREFIX']
            , isOverrrideAllowed    = (specialCases.indexOf(key) > -1) ? true : false
        ;

        if (
            key.substring(0, 5) !== 'GINA_' &&
            key.substring(0, 7) !== 'VENDOR_' &&
            key.substring(0, 5) !== 'USER_'
            ) {
            key = 'USER_' + key
        }
        if (
            typeof(process['gina']) != 'undefined' &&
            typeof(process['gina'][key]) != 'undefined' &&
            process['gina'][key] !== '' &&
            // exceptions
            !isOverrrideAllowed
        ) {
            if (val !== process['gina'][key]) {
                err = new Error('Cannot override Env variable [ '+ key + ' ] with `'+ val +'`, it is already set to `'+ process['gina'][key] +'`');
                console.warn(err.message);
            }
            err                 = null;
            specialCases        = null;
            isOverrrideAllowed  = null;

            return
        }

        //Write env var.
        if ( typeof(process['gina']) == 'undefined') {
            process['gina'] = {}
        }
        process['gina'][key] = val;
        if ( typeof(isProtected) != 'undefined' && isProtected == true) {
            self.protectedVars.push(key)
        }

        err                 = null;
        specialCases        = null;
        isOverrrideAllowed  = null;
    }

    defineDefault = function(obj) {
        for (let c in obj) {
            define(c, obj[c])
        }
        obj = null;
    }// jshint ignore:line

    /**
     * parseTimeout
     * Converts a user-facing timeout value to milliseconds.
     * Accepts:
     *   - string with unit suffix: "30s", "500ms", "1m", "2h"
     *   - number: treated as milliseconds (backward compat), 0 disables the timeout
     *   - false / null / undefined / '': returns null (disabled / unset)
     *
     * @param {string|number|boolean|null|undefined} value
     * @returns {number|null} milliseconds, or null when disabled/invalid
     */
    parseTimeout = function(value) {
        if (value === false || value === null || typeof value === 'undefined' || value === '') {
            return null;
        }
        if (typeof value === 'number') {
            // 0 is a valid value — it disables the timeout in Node.js APIs
            return value;
        }
        if (typeof value === 'string') {
            var _match = value.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)$/);
            if (!_match) return null;
            var _n = parseFloat(_match[1]);
            switch (_match[2]) {
                case 'ms': return Math.round(_n);
                case 's':  return Math.round(_n * 1000);
                case 'm':  return Math.round(_n * 60000);
                case 'h':  return Math.round(_n * 3600000);
            }
        }
        return null;
    }

    init(opt)

}

module.exports = MainHelper();