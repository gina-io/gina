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
                self.defaultPrefix = ( typeof(packObj.config) != 'undefined' && typeof(packObj.config.prefix) != 'undefined' ) ? packObj.config.prefix : execSync('$(which npm) config get prefix').toString().replace(/\n$/g, '');
                self.defaultPrefix = self.defaultPrefix.replace(/^\~/, getUserHome());
                prefix = getEnvVar('GINA_PREFIX') || self.defaultPrefix;
                self.optionalPrefix = pkg.config.optionalPrefix.replace(/^\~/, getUserHome());
            } catch(err) {
                console.warn('MainHelper::Init() Execption: '+ err.stack);
                console.debug('Trying alternative config');
                try {
                    self.defaultPrefix = execSync('$(which npm) config get prefix').toString().replace(/\n$/g, '');
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

        if ( typeof(process.env['gina']) == 'undefined') {
            process.env['gina'] = {}
        }

        var newArgv = {};
        for (let a in process.argv) {
            if ( /\-\-/.test(process.argv[a]) && process.argv[a].indexOf('=') > -1 ) {
                // special cases
                if (/\-\-(prefix|env|scope)/.test(process.argv[a])) {
                    continue;
                }


                evar = ( (process.argv[a].replace(/--/, ''))
                    .replace(/-/, '_') )
                    .split(/=/);

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

        //Cleaning the rest.
        for (let e in process.env) {
            if (
                e.substring(0, 5) === 'GINA_' || // 6?
                e.substring(0, 7) === 'VENDOR_' ||
                e.substring(0, 5) === 'USER_'
                ) {
                process['gina'][e] = process.env[e];
                delete process.env[e]
            }
        }

        setContext('envVars', process['gina']);
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

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix || self.defaultPrefix || execSync('$(which npm) config get prefix').toString().replace(/\n$/g, '');

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

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix || self.defaultPrefix || execSync('$(which npm) config get prefix').toString().replace(/\n$/g, '');

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

        var prefix = getEnvVar('GINA_PREFIX') || self.prefix  || self.defaultPrefix || execSync('$(which npm) config get prefix').toString().replace(/\n$/g, '');

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
     * getBundleStartingArgv
     * Will get the bundle starting ARGV to allow live restart
     *
     * @param {string} bundle
     * @param {string} project
     *
     * @returns {string} argv
     * */
    getBundleStartingArgv = function(bundle, project) {
        bundle = bundle.replace(/(`|\s+)/g, '');
        project = project.replace(/(`|\s+)/g, '');
        var filename = _(getTmpDir() +'/'+ bundle +'@'+ project +'.argv', true);

        var content = null;
        if ( fs.existsSync(filename) ) {
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
        delete  obj
    }// jshint ignore:line

    init(opt)

}

module.exports = MainHelper();