#!/usr/bin/env node

/**
 * This file is part of the gina pkg.
 * Copyright (c) 2009-2025 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs          = require('fs');
var os          = require("os");
var util        = require('util');
var promisify   = util.promisify;
var { execSync } = require('child_process');

//var lib         = require('./lib');
// var console     = lib.logger;
var lib     = null;
var helpers = null;

/**
 * Pre install constructor
 *
 * if you need to test, go to gina main folder
 * $ node --inspect-brk=5858 ./script/pre_install.js -g
 *
 * NB.: At this stage, Gina is not yet installed and no lib or helper cannot be used here
 *      excepted if Gina has been previously installed
 *
 * @constructor
 * */
function PreInstall() {
    var self = {};

    var configure = function() {

        // TODO - handle windows case
        if ( /^true$/i.test(isWin32()) ) {
            throw new Error('Windows in not yet fully supported. Thank you for your patience');
        }

        self.isWin32            = isWin32();
        self.isGlobalInstall    = ( typeof(process.env.npm_config_global) != 'undefined' && /^(true|false)$/i.test(process.env.npm_config_global) )
                                    ? (/^true$/i.test(process.env.npm_config_global) ? true: false)
                                    : false;
        self.isResetNeeded      = ( typeof(process.env.npm_config_reset) != 'undefined' && /^(true|false)$/i.test(process.env.npm_config_reset) )
                                    ? (/^true$/i.test(process.env.npm_config_reset) ? true: false)
                                    : false;
        self.defaultPrefix      = execSync('npm config get prefix').toString().replace(/\n$/g, '');


        // `process.env.npm_config_prefix` is only retrieved on `npm install gina`
        // and it should always be equal to `self.defaultPrefix`
        self.prefix             = process.env.npm_config_prefix || self.defaultPrefix;
        self.isCustomPrefix     = false;
        self.isGinaInstalled    = false;

        self.isRootUser         = false;
        self.userInfo = os.userInfo();
        // E.g.:
        // {
        //     uid: 0,
        //     gid: 0,
        //     username: 'root',
        //     homedir: '/root',
        //     shell: '/bin/bash'
        // }
        var cmd = null;
        if ( !isWin32() ) {
            var uid = self.userInfo.uid;
            var gid = self.userInfo.gid;

            if ( /^(root|nobody)$/i.test(self.userInfo.username) ) {
                if (/^(root)$/i.test(self.userInfo.username) ) {
                    self.isRootUser = true;
                }
                if (/nonexistent$/i.test(self.userInfo.homedir) || !self.userInfo.homedir ) {
                    self.userInfo.homedir = getUserHome()
                }
                console.warn('If you get errors, try to run: chown -R $(whoami) ~/.npm')
            }
            console.debug('Install user infos:\n'+ JSON.stringify(self.userInfo, null, 2));
        }
        console.debug('self.isRootUser => '+ self.isRootUser);

        // Overriding thru passed arguments
        var args = process.argv, i = 0, len = args.length;
        for (; i < len; ++i) {
            if ( /^(\-g|\-\-global)$/.test(args[i]) ) {
                self.isGlobalInstall = true;
                continue;
            }

            if ( /^\-\-reset$/.test(args[i]) ) {
                self.isResetNeeded = true;
                continue;
            }

            if ( /^\-\-prefix\=/.test(args[i] ) ) {
                self.isCustomPrefix = true;
                self.prefix = args[i].split(/\=/)[1];
                self.prefix = self.prefix.replace(/^\~/, getUserHome());
                continue;
            }
        }

        if (self.prefix != self.defaultPrefix) {
            self.isCustomPrefix = true;
        }

        // For local install
        console.debug('self.isGlobalInstall => '+ self.isGlobalInstall);
        if ( !self.isGlobalInstall ) {
            console.warn('Local installation is not fully supported at the moment.');
            console.warn('You are encouraged to use `npm install -g gina`\nor, if you are trying to link gina to your project, use `npm link gina` if Gina has already been installed globally\n');
            // Just in case someone is trying to run pre_install from the `gina` module
            console.info('process.env.INIT_CWD: ', process.env.INIT_CWD);
            if (!/node\_modules(\\\\|\/)gina$/.test(process.env.INIT_CWD)) {
                self.prefix = process.env.INIT_CWD;//process.cwd();
            }
        }

        // checking permission
        var hasPermissionsForBin = isWritableSync(self.prefix + ( isWin32() ? '\\' : '/' ) + 'bin');
        var hasPermissionsForLib = isWritableSync(self.prefix + ( isWin32() ? '\\' : '/' ) + 'lib');
        var hasPermissionsForVar = isWritableSync(self.prefix + ( isWin32() ? '\\' : '/' ) + 'var');
        if ( !hasPermissionsForBin || !hasPermissionsForLib || !hasPermissionsForVar) {
            if (!hasPermissionsForBin) {
                console.warn('Path not accessible or missing: '+ self.prefix + ( isWin32() ? '\\' : '/' ) + 'bin')
            }
            if (!hasPermissionsForLib) {
                console.warn('Path not accessible or missing: '+ self.prefix + ( isWin32() ? '\\' : '/' ) + 'lib')
            }
            if (!hasPermissionsForVar) {
                console.warn('Path not accessible or missing: '+ self.prefix + ( isWin32() ? '\\' : '/' ) + 'var')
            }

            // console.warn('You do not have sufficient permissions. Switching to `--prefix='+ self.optionalPrefix +'`');
            // process.env.npm_config_prefix = self.prefix = self.optionalPrefix;
        }

        var pkg = null, pkgObj = null, cmd = null;
        try {
            cmd = 'npm list gina --long --json --prefix='+ self.prefix;
            if (self.isGlobalInstall) {
                cmd += ' -g';
            }
            pkg = execSync(cmd).toString().replace(/\n$/g, '');
            self.optionalPrefix = JSON.parse(pkg).dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());

            pkgObj = JSON.parse(pkg);
            self.optionalPrefix     = pkgObj.dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());
        } catch(err) {
            // means that gina is not already installed
            // throw err
        }


        if ( self.prefix != self.defaultPrefix ) {
            self.isCustomPrefix = true;
        }

        self.gina = __dirname +'/..';
        // tying to figure out if gina is already install the given prefix
        // var hasFoundGina = execSync('npm list -g gina --long --json').toString().replace(/\n$/g, '');
        var hasFoundGina = pkg;
        try {
            hasFoundGina = JSON.parse(hasFoundGina);
            if ( hasFoundGina.dependencies && typeof(hasFoundGina.dependencies.gina) != 'undefined' ) {
                self.isGinaInstalled = true;
                self.versionPath = self.gina;
                self.versionPath += (isWin32()) ? '\\framework\\' : '/framework/';
                self.versionPath += 'v'+ hasFoundGina.dependencies.gina.version;

                console.debug('Install path => '+ hasFoundGina.dependencies.gina.path);

                // OK ... found installed gina but on a different prefix
                // In this case, let's assume that it is not really installed
                if ( !new RegExp('^'+ self.prefix).test(hasFoundGina.dependencies.gina.path) ) {
                    self.isGinaInstalled = false;
                }
            }
        } catch (err) {}

        console.debug('self.defaultPrefix => '+ self.defaultPrefix);
        console.debug('self.optionalPrefix  => '+ self.optionalPrefix );
        console.debug('self.prefix => '+ self.prefix);
        console.debug('self.isCustomPrefix => ', self.isCustomPrefix);
        // only available when running the script with NPM
        console.debug('process.env.npm_config_prefix => '+ process.env.npm_config_prefix);
    }

    var init = function() {

        configure();

        begin(0);
    }

    /**
     * Bebin - Will run checking tasks in order of declaration
     * */
     var begin = async function(i) {
        var n = 0, funct = null, functName = null;
        for (let t in self) {
            if ( typeof(self[t]) == 'function') {
                if (n == i){
                    //let func = 'self.' + t + '()';
                    let func = 'self.' + t;
                    console.debug('Running [ ' + func + '() ]');
                    funct       = func;
                    functName   = t;
                    break;
                }
                n++;
            }
        }

        // to handle sync vs async to allow execution in order of declaration
        if (funct) {
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();');// jshint ignore:line
        } else {
            process.exit(0);
        }
    }

    // self.checkPermissions = function(done) {
    //     // E.g.:
    //     // {
    //     //     uid: 0,
    //     //     gid: 0,
    //     //     username: 'root',
    //     //     homedir: '/root',
    //     //     shell: '/bin/bash'
    //     // }
    //     self.userInfo = os.userInfo();
    //     var cmd = null;
    //     if ( !isWin32() ) {
    //         var uid = self.userInfo.uid;
    //         var gid = self.userInfo.gid;

    //         if ( self.userInfo.username == 'root' ) {
    //             console.warn('User `root` detected, changing permissions for `~/.config`& `~/.npm` to avoid install exceptions');
    //             cmd = 'chown -R '+ uid +':'+ gid +' '+ self.userInfo.homedir +'/.config';
    //             execSync(cmd);
    //             cmd = 'chown -R nobody:'+ gid +' '+ self.userInfo.homedir +'/.npm';
    //             execSync(cmd);
    //         }
    //     }
    //     done();
    // }



    self.checkRequirements = async function(done) {

        var ginaHome = getUserHome() + ( isWin32() ? '\\.gina' : '/.gina' );
        if ( self.isResetNeeded && existsSync(ginaHome) ) {
            console.debug('`.gina` reset requested ...');
            if ( typeof(fs.rmSync) == 'function' ) {
                fs.rmSync(ginaHome, { recursive: true, force: true });
            } else {
                helpers = require(self.gina+ '/utils/helper');
                new _(ginaHome, true).rmSync()
            }
        }

        // Let's temporarily install `colors` into `GINA_DIR` it will be removed by the `post_install.js` script
        var initialDir = process.cwd();

        if ( !fs.existsSync(self.gina +'/node_modules/colors') ) {
            process.chdir(self.gina);

            var oldConfigGlobal = process.env.npm_config_global;
            process.env.npm_config_global=false;
            var cmd = ( isWin32() ) ? 'npm.cmd install colors@1.4.0' : 'npm install colors@1.4.0';
            execSync(cmd);
            process.env.npm_config_global=oldConfigGlobal;

            process.chdir(initialDir);
        }



        console.debug('framework path: ' + self.gina);
        console.debug('framework version path: ' + self.versionPath);
        console.debug('Is this a global install: '+ self.isGlobalInstall);

        done();
    }

    self.checkRequiredFolders = function(done) {

        var ginaHomeDir = getUserHome() + ((isWin32()) ? '\\.gina': '/.gina');
        if (!existsSync(ginaHomeDir) ) {
            fs.mkdirSync(ginaHomeDir);

            var cmd = 'chown -R $(whoami) '+ ginaHomeDir;
            console.debug('Running: '+ cmd);
            execSync(cmd);
        }

        // check for `/usr/local/tmp` or `/tmp`
        var tmpDir = getTmpDir(self.prefix);
        console.info('`tmp` dir -> '+ tmpDir);
        if ( !existsSync(tmpDir) ) {
            fs.mkdirSync(tmpDir)
        }


        // check for `/usr/local/run`
        var runDir = getRunDir(self.prefix);
        console.info('`run` dir -> '+ runDir);

        // check for `/usr/local/log`
        var logDir = getLogDir(self.prefix);
        console.info('`log` dir -> '+ logDir);

        // var settingsBackupPath = tmpDir +  ((isWin32()) ? '\\': '/') + 'gina-install-settings.json';
        // console.info('tmp folder backup -> '+ settingsBackupPath);
        // var data =  JSON.stringify({
        //     prefix: self.prefix,
        //     rundir: runDir,
        //     logdir: logDir,
        //     tmpdir: tmpDir
        // }, null, 4);
        // fs.writeFileSync(settingsBackupPath, data);
        // fs.chmodSync(settingsBackupPath, 0755);

        done()
    }


    /**
     * Setup global installation path
     * Eg.: npm install -g gina --prefix=~/.npm-global
     *
     * Resolving EACCES permissions errors when installing packages globally
     * https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
     */
    // self.setupPermissions = async function(done) {

    //     // create a directory for global installations
    //     var npmGlobalPath = getUserHome() + '/.npm-global';

    //     console.info('Setting npm global path: '+ npmGlobalPath +' '+ new _(npmGlobalPath).existsSync() );
    //     var npmGlobalPathObj = new _(npmGlobalPath);
    //     if ( !npmGlobalPathObj.existsSync() ) {
    //         npmGlobalPathObj.mkdirSync()
    //     }
    //     // from `/usr/local` -> `~/.npm-global`
    //     var cmd = 'npm config set prefix '+ getUserHome() +'/.npm-global';
    //     await promisify(run)(cmd, { cwd: _(self.path), tmp: getTmpDir(self.prefix);, outToProcessSTD: true })
    //         .catch(function onError(err){
    //             if (err) {
    //                 console.warn('try to run: sudo ' + cmd);
    //                 return done(err);
    //             }
    //         });

    //     var profilePath = getUserHome() + '/.profile';
    //     var profilePathObj = new _(profilePath);
    //     if ( !profilePathObj.existsSync() ) {
    //         cmd = 'touch '+ profilePath;
    //         await promisify(run)(cmd, { cwd: _(self.path), tmp: getTmpDir(self.prefix);, outToProcessSTD: true })
    //             .catch(function onError(err){
    //                 if (err) {
    //                     console.warn('try to run: sudo ' + cmd);
    //                     return done(err);
    //                 }
    //             });
    //     }

    //     var inFile = null;
    //     try {
    //         inFile = execSync("cat ~/.profile | grep .npm-global/bin").toString();
    //     } catch (err) {
    //         // nothing to do
    //     }

    //     if (!inFile) {
    //         inFile = "\n# set PATH so it includes user‘s private npm bin if exists"
    //         inFile += '\nif [ -d "$HOME/.npm-global/bin" ]; then';
    //         inFile += '\n    PATH="$HOME/.npm-global/bin:$PATH"';
    //         inFile += '\nfi\n';
    //         try {
    //             fs.appendFileSync( getUserHome()+'/.profile', inFile );
    //         } catch (err) {
    //             return done(err);
    //         }
    //         inFile = null;

    //         // we need to source/update ~/.profile
    //         try {
    //             execSync("source "+ profilePath);
    //         } catch (err) {
    //             return done(err)
    //         }
    //     }

    //     done()
    // }

    self.checkIfGinaIsAlreadyInstalled = async function(done) {

        console.debug('Checking if Gina is already installed for prefix `'+ self.prefix+'`: '+ self.isGinaInstalled);
        if (!self.isGinaInstalled) {
            return done();
        }


        // Backup current version

        // check for ~/.gina
        var ginaHomeDir = getUserHome() + ((isWin32()) ? '\\.gina': '/.gina');
        // if not found -> skip because it means that gina might not be installed or configured yet
        if (!existsSync(ginaHomeDir) ) {
            return done();
        }

        var frameworkPath   = self.versionPath;
        try {
            helpers = require(self.gina+ '/utils/helper');
            lib     = require('./lib');
            console = lib.logger;
        } catch (err) {
            return done(err)
        }



        // root
        // self.gina           = getEnvVar('GINA_DIR');
        // self.versionPath    = getEnvVar('GINA_FRAMEWORK');

        // check if framework version folder is found
        var versionsFolders = null, frameworkFolder = null;
        try {
            frameworkFolder = _(self.gina +'/framework', true);
            console.debug('frameworkFolder: ', frameworkFolder);
            if ( !existsSync(frameworkFolder) ) {
                return done();
            }
            versionsFolders = fs.readdirSync(frameworkFolder);
        } catch (err) {
            // do nothing
        }

        // if found, retrieve all versions folders
        // && compare them to  `~/.gina/main.json`
        // var mainConfigPath  = _(ginaHomeDir +'/main.json', true);
        // var mainConfig      = require(mainConfigPath);

        // if yes, && not symlink, cp to archives ... a symlink will be done back to the framework folder by `post_install` script
        for (let i = 0, len = versionsFolders.length; i < len; i++) {
            let dir = versionsFolders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // skip symlinks
            try {
                if ( fs.lstatSync( _(frameworkPath +'/'+ dir, true) ).isSymbolicLink() ) {
                    continue;
                }
            } catch (e) {
                continue;
            }

            console.info('Found old version to backup: ', dir);

            let archiveVersionPath =  _( ginaHomeDir+'/archives/framework/'+ dir, true);
            let archiveVersionPathObj = new _(archiveVersionPath);
            // remove existing
            if ( archiveVersionPathObj.existsSync() ) {
                archiveVersionPathObj.rmSync()
            }

            let frameworkPathObj = new _(frameworkPath +'/'+ dir);

            // since we cannot yet promissify directly PathObject.cp()
            let f = function(destination, cb) {// jshint ignore:line
                frameworkPathObj.cp(destination, cb);
            };
            let err = false;
            await promisify(f)(archiveVersionPath)
                .catch( function onCopyError(_err) {// jshint ignore:line
                    err = _err;
                })
                .then( function onCopy(_destination) {// jshint ignore:line
                    console.info('Backup '+ dir +' to '+ _destination +' done !');
                });

            if (err) {
                return done(err);
            }
        }
        // It is not required to update `~/.gina/main.json` &&  `~/.gina/{shortVersion}/settings.json`
        done()
    }

    var isWin32 = function() {
        return (process.platform === 'win32') ? true : false;
    };

    var existsSync = function(path) {
        if ( fs.accessSync && typeof(fs.accessSync) != 'undefined' ) {
            try {
                fs.accessSync(path, fs.constants.F_OK);
                return true;
            } catch (err) {
                return false;
            }
        } else { // support for old version of nodejs
            return fs.existsSync(path);
        }
    }

    var isWritableSync = function(path) {
        var canWrite = false;
        if ( fs.accessSync && typeof(fs.accessSync) != 'undefined' ) {
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

    /**
     * Get run\lock path
     * @returns {string} rundir
     * */
    var getRunDir = function(prefix) {
        if ( !prefix || typeof(prefix) == 'undefined' || prefix == '' ) {
            prefix = self.defaultPrefix;
        }

        // Trying to retrieve original value if already defined
        // Means `/usr/local/var/lock` or `/usr/local/var/run` by default.
        var runDir = (isWin32()) ? getUserHome() + '\\.gina\\run' : prefix+'/var/lock';

        if ( !isWin32() && new RegExp('^'+ prefix).test(runDir) && !isWritableSync(prefix) ) {
            runDir = getUserHome() +'/.gina/run';
            if ( !existsSync(runDir) ) {
                fs.mkdirSync(runDir)
            }

            return runDir
        }

        if (!self.isGlobalInstall) {
            runDir = runDir.replace(/\/var\//, '/')
        }

        if ( existsSync(runDir) ) {
            if ( !isWritableSync(runDir) ) {
                throw new Error('location `'+ runDir +'` found but not writable !' )
            }

            runDir += ( isWin32() || !self.isGlobalInstall ) ? '' : '/gina'
            if ( !existsSync(runDir) ) {
                fs.mkdirSync(runDir)
            }

            return runDir;
        }

        try {
            //by default.
            runDir = prefix;
            if (!self.isGlobalInstall) {
                runDir += '/var';
            }

            if ( !existsSync(runDir) ) {
                fs.mkdirSync(runDir)
            }
            runDir += '/run';
            if ( !existsSync(runDir) ) {
                fs.mkdirSync(runDir)
            }
        } catch (err) {
            throw new Error('location error: `'+ runDir+'`\n'+ err.stack);
        }

        if (self.optionalPrefix != prefix && self.isGlobalInstall) {
            runDir += ( isWin32() ) ? '\\gina' : '/gina'
            if ( !existsSync(runDir) ) {
                fs.mkdirSync(runDir)
            }
        }

        return runDir;
    };

    var getTmpDir = function(prefix) {
        if ( !prefix || typeof(prefix) == 'undefined' || prefix == '' ) {
            prefix = self.defaultPrefix;
        }
        // support for node 0.10.x & 0.11.x
        var tmp = (os.tmpdir) ? os.tmpdir : function() {
            var tmpDir = null;
            if ( isWin32() ) {
                tmpDir = process.env.TEMP ||
                    process.env.TMP ||
                    (process.env.SystemRoot || process.env.windir) + '\\Temp'
                ;
            } else {
                tmpDir = process.env.TMPDIR ||
                    process.env.TMP ||
                    process.env.TEMP ||
                    prefix+'/var/tmp'
                ;

                if ( new RegExp('^'+ prefix).test(tmpDir) && !isWritableSync(prefix) ) {
                    tmpDir = getUserHome() +'/.gina/tmp';
                    if ( !existsSync(tmpDir) ) {
                        fs.mkdirSync(tmpDir)
                    }
                }

                if ( new RegExp('^'+ prefix +'/var').test(tmpDir) && !existsSync(prefix+'/var') ) {
                    fs.mkdirSync(prefix+'/var');
                }
            }

            if ( !existsSync(tmpDir) ) {
                fs.mkdirSync(tmpDir);
            }

            return tmpDir
        };

        return tmp()
    };

    /**
     * Get log path - %SystemRoot%\system32\winevt\logs or /
     *
     * @returns {string} logPath
     * */
    var getLogDir = function(prefix) {
        if ( !prefix || typeof(prefix) == 'undefined' || prefix == '' ) {
            prefix = self.defaultPrefix;
        }
        // Trying to retrieve original value if already defined
        var logDir = null;

        if ( isWin32() ) {
            logDir = process.env.LOG ||
                process.env.LOGS ||
                (process.env.SystemRoot || process.env.windir) + '\\System32\\Winevt\\Logs'
            ;

            if ( !logDir || logDir == '' ) {
                throw new Error('Log directory not defined or not found !');
            }

            if ( !isWritableSync(logDir) ) {
                throw new Error('Log directory found but not writable: need permissions for `'+ logDir +'`');
            }

            if ( !/gina$/.test(logDir) ) {
                logDir += '\\gina'
            }
        } else {
            logDir = process.env.LOGDIR ||
                process.env.LOG ||
                process.env.LOGS ||
                prefix+'/var/log'
            ;

            if ( new RegExp('^'+ prefix).test(logDir) && !isWritableSync(prefix) ) {
                logDir = getUserHome() +'/.gina/log';
                if ( !existsSync(logDir) ) {
                    fs.mkdirSync(logDir)
                }

                return logDir
            }

            if ( new RegExp('^'+ prefix +'/var').test(logDir) && !existsSync(prefix+'/var') ) {
                fs.mkdirSync(prefix+'/var');
            }

            if ( !existsSync(logDir) ) {
                fs.mkdirSync(logDir);
            }

            if ( !/gina$/.test(logDir) && self.optionalPrefix != prefix ) {
                logDir += '/gina'
            }
        }

        if ( !existsSync(logDir) ) {
            fs.mkdirSync(logDir)
        }

        return logDir;
    };

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

    init()
}

new PreInstall()