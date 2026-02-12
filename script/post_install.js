#!/usr/bin/env node
'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports
var fs          = require('fs');
var os          = require("os");
var util        = require('util');
var promisify   = util.promisify;
const { execSync } = require('child_process');


var isWin32 = function() {
    return (process.platform === 'win32') ? true : false;
};
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

// just in case `post_install` is called by hand
var initialDir = process.cwd();
var frameworkPath   = __dirname +'/..';
if ( !fs.existsSync(frameworkPath +'/node_modules/colors') ) {
    process.chdir(frameworkPath);

    var oldConfigGlobal = process.env.npm_config_global;
    process.env.npm_config_global=false;
    var cmd = ( isWin32() ) ? 'npm.cmd install colors@1.4.0' : 'npm install colors@1.4.0';
    execSync(cmd);
    process.env.npm_config_global=oldConfigGlobal;

    process.chdir(initialDir);
}

var lib         = require('./lib');
var console     = lib.logger;

var scriptPath = __dirname;
var ginaPath = (scriptPath.replace(/\\/g, '/')).replace('/script', '');
var help        = require(ginaPath + '/utils/helper.js');
var pack        = ginaPath + '/package.json';
pack =  (isWin32()) ? pack.replace(/\//g, '\\') : pack;
var helpers = null;


/**
 * Post install constructor
 * @constructor
 * */
function PostInstall() {

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
        self.defaultPrefix      = execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');
        // var pkg = null;
        // try {
        //     if (self.isGlobalInstall) {
        //         pkg = execSync('$(which npm) list -g gina --long --json').toString().replace(/\n$/g, '');
        //     } else {
        //         pkg = execSync('$(which npm) list gina --long --json').toString().replace(/\n$/g, '');
        //     }
        // } catch(err) {
        //     throw err
        // }
        // self.optionalPrefix     = JSON.parse(pkg).dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());

        // `process.env.npm_config_prefix` is only retrieved on `npm install gina`
        // and it should always be equal to `self.defaultPrefix`
        self.prefix             = process.env.npm_config_prefix || self.defaultPrefix;
        self.isCustomPrefix     = false;
        self.isGinaInstalled    = false;

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

            if ( /^\-\-log-level\=/.test(args[i]) ) {
                var logLevel = args[i].split(/\=/)[1];
                console.setLevel(logLevel, 'gina');
                process.env.LOG_LEVEL=logLevel;
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
            // Just in case someone is trying to run post_install from the `gina` module of from the project dir
            if (!/node\_modules(\\\\|\/)gina$/.test(process.env.INIT_CWD)) {
                self.prefix = process.env.INIT_CWD || process.cwd();
            }

            // No package.json ?
            var projectName = self.prefix.split('/').slice(-1)[0];
            var projectPackageJsonObj = new _(self.prefix +'/package.json', true);
            console.info('Checking for: '+ projectPackageJsonObj.toString(), '['+ projectPackageJsonObj.existsSync()  +']');
            if ( !projectPackageJsonObj.existsSync() ) {
                var defaultPackageJsonContent = {
                    "name": ""+ projectName,
                    "version": "0.0.1",
                    "description": projectName+ " is a nice project !",
                    "engine": [
                        "node >=" + process.version.substring(1)
                    ]
                };
                console.warn('No `package.json` found for your project, creating one to avoid install exceptions');
                lib.generator.createFileFromDataSync(defaultPackageJsonContent, projectPackageJsonObj.toString());
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

        self.gina = __dirname +'/..';
        var pkg = null, pkgObj = null, cmd = null;
        try {
            cmd = 'npm list gina --long --json --prefix='+ self.prefix;
            if (self.isGlobalInstall) {
                cmd += ' -g';
            }
            pkg = execSync(cmd).toString().replace(/\n$/g, '');
            self.optionalPrefix = JSON.parse(pkg).dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());
            pkgObj = JSON.parse(pkg);
            self.optionalPrefix = pkgObj.dependencies.gina.config.optionalPrefix.replace(/^\~/, getUserHome());
        } catch(err) {
            // throw err
            // ignore exception
            if ( !self.isGlobalInstall ) {
                pkgObj = requireJSON(_(pack, true));
                self.versionPath = self.gina;
                self.versionPath += (isWin32()) ? '\\framework\\' : '/framework/';
                self.version = pkgObj.version;
                self.versionPath += 'v'+ self.version;

                self.shortVersion = self.version.split('.');
                self.shortVersion.splice(2);
                self.shortVersion = self.shortVersion.join('.');
            }
        }


        if ( self.prefix != self.defaultPrefix ) {
            self.isCustomPrefix = true;
        }


        // tying to figure out if gina is already install the given prefix
        var hasFoundGina = pkg;
        try {
            hasFoundGina = JSON.parse(hasFoundGina);
            if ( hasFoundGina.dependencies && typeof(hasFoundGina.dependencies.gina) != 'undefined' ) {
                self.isGinaInstalled = true;
                self.versionPath = self.gina;
                self.versionPath += (isWin32()) ? '\\framework\\' : '/framework/';
                self.version = hasFoundGina.dependencies.gina.version;
                self.versionPath += 'v'+ self.version;

                self.shortVersion = self.version.split('.');
                self.shortVersion.splice(2);
                self.shortVersion = self.shortVersion.join('.');

                console.debug('Install path => '+ hasFoundGina.dependencies.gina.path);

                // OK ... found installed gina but on a different prefix
                // In this case, let's assume that it is not really installed
                console.info('A previous version of gina has been detected');
                if ( !new RegExp('^'+ self.prefix).test(hasFoundGina.dependencies.gina.path) ) {
                    self.isGinaInstalled = false;
                    console.info('Ignoring previous because of a mismatching install prefix');
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

    //Initialize post installation scripts.
    var init = function() {
        configure();
        helpers = require(self.versionPath+ '/helpers');

        begin(0);
    }

    /**
     * Bebin - Will run checking tasks in order of declaration
     * */
     var begin = async function(i) {
        var n = 0, funct = null, functName = null;
        for (let t in self) {
            if ( typeof(self[t]) == 'function') {
                if (n == i) {
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
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
        } else {
            process.exit(0);
        }
    }


    self.createVersionFile = function(done) {
        var version = self.version;
        console.debug('Writting version number: '+ version);

        var target = _(self.versionPath + '/VERSION');
        try {
            if ( fs.existsSync(target) ) {
                fs.unlinkSync(target)
            }
            fs.writeFileSync(target, version);
        } catch(err) {
            return done(err)
        }

        done();
    }


    //Creating framework command line file for nix.
    var createGinaFile = function(callback) {
        // local install only
        if (self.isGlobalInstall) {
            return callback(false);
        }

        console.info('Current prefix: '+ self.prefix );
        console.info('Current package.json: '+  _(self.gina + '/package.json', true) );

        console.info('Creating framework command line:');
        var appPath = process.env.INIT_CWD || process.cwd();
        console.debug('App path: '+ appPath);
        var source = _(appPath + '/node_modules/.bin/gina', true);
        var target = _(appPath +'/gina', true);
        if ( isWin32() ) {
            source = _(appPath + '/node_modules/.bin/gina.bat', true)
            target = _(appPath +'/gina.bat', true)
        }
        console.debug('Source: '+ source);
        console.debug('Target: '+ target);

        if ( callback && typeof(callback) != 'undefined') {
            console.info('Linking to binaries dir: '+ source +' -> '+ target);
            try {
                if ( fs.existsSync(target) ) {
                    fs.unlinkSync(target)
                }
                new _(source).symlinkSync(target)
            } catch (err) {
                return callback(err)
            }

            return callback(false);
        }
    }

    self.createGinaFileForPlatform = async function(done) {
        console.info('Creating platform file');
        // var name = require( _(self.versionPath + '/package.json') ).name;

        // var filename = ( (self.isWin32) ? '.' : '' ) + name;

        var keepGoing = function() {

            createGinaFile(function onFileCreated(err) {
                if (err) {
                    return done(err)
                }

                // this is done to allow multiple calls of post_install.js
                var filename = _(self.versionPath + '/SUCCESS');
                var installed = fs.existsSync( filename );
                if (installed) {
                    fs.unlinkSync( filename );
                }

                // if ( /node_modules\/gina/.test( new _(process.cwd()).toUnixStyle() ) ) {
                //     var msg = "Gina's command line tool has been installed.";
                //     console.info(msg);
                //     process.exit(0)
                // }

                console.debug('Writting '+ filename);
                fs.writeFileSync(filename, 'true' );

                // do something that can be called after the first time installation


                // Check if npm install has been done
                if ( !hasNodeModulesSync() ) {
                    return npmInstall(done)
                } else {
                    var target = new _(self.versionPath + '/node_modules');
                    console.debug('Replacing: ', target.toString() );
                    return target
                        .rm( function onRemove(err) {
                            if (err) {
                                return done(err);
                            } else {
                                return npmInstall(done)
                            }
                        })
                }

            })
        }

        // if (self.isWin32) {
        //     // var appPath = _( self.versionPath.substring(0, (self.versionPath.length - ("node_modules/" + name + '/').length)) );
        //     var appPath = process.cwd()
        //     var source = _(self.versionPath + '/core/template/command/gina.bat.tpl');
        //     var target = _(appPath +'/'+ name + '.bat');
        //     if ( fs.existsSync(target) ) {
        //         fs.unlinkSync(target);
        //         // have to wait for windows to complete this
        //         setTimeout( async function(){
        //             lib.generator.createFileFromTemplate(source, target);
        //             await keepGoing(filename)
        //         }, 1000)
        //     } else {
        //         lib.generator.createFileFromTemplate(source, target);
        //         await keepGoing(filename)
        //     }

        // } else {
            await keepGoing()
        // }
    }


    var hasNodeModulesSync = function() {
        return fs.existsSync( _(self.versionPath + '/node_modules') )
    }


    var npmInstall = function(done) {

        console.info('Now installing modules. Please, wait ...');
        console.info('Prefix ('+ self.isCustomPrefix +'): '+ self.prefix);
        console.info('Default prefix: '+ self.defaultPrefix);
        var initialDir = process.cwd();


        var cmd = ( isWin32() ) ? 'npm.cmd install' : 'npm install';

        process.chdir( self.versionPath );

        console.info('Running: `'+ cmd +'` from '+ process.cwd() );
        console.info('Running using TMPDIR: '+  _(getTmpDir(), true) );
        var oldConfigGlobal = process.env.npm_config_global;
        process.env.npm_config_global = false;
        console.info('Running using TMPDIR: '+ cmd);
        console.info(execSync(cmd).toString());
        process.chdir(initialDir);
        process.env.npm_config_global = oldConfigGlobal;

        done()
    }

    self.cleanupIfNeeded = function(done) {

        var frameworkPath = self.gina;
        console.debug('Framework path is: ' + frameworkPath);

        // Let's cleanup `colors` from `GINA_DIR`
        if ( new _(frameworkPath +'/node_modules/colors', true).existsSync() ) {
            var initialDir = process.cwd();
            process.chdir(frameworkPath);
            var oldConfigGlobal = process.env.npm_config_global;
            process.env.npm_config_global=false;

            // var cmd = self.prefix +'/bin/';
            // cmd += ( isWin32() ) ? 'npm.cmd rm colors' : 'npm rm colors';

            var cmd = ( isWin32() ) ? 'npm.cmd rm colors' : 'npm rm colors';

            try {
                execSync(cmd);
                console.debug('Removed default `colors` module from `GINA_DIR`... This is normal ;)');
            } catch (npmErr) {
                process.chdir(initialDir);
                return done(npmErr);
            }

            process.chdir(initialDir);
            process.env.npm_config_global=oldConfigGlobal;
        }

        done()
    }

    self.checkUserExtensions = async function(done) {
        var err = null;
        var versionDirObj = new _( getUserHome() +'/.gina/'+ self.shortVersion, true);
        console.debug('versionDirObj: '+ versionDirObj.toString() );
        if ( !versionDirObj.existsSync() ) {
            versionDirObj.mkdirSync()
        }
        var defaultSettingsObj = new _(versionDirObj.toString() + '/settings.json', true);
        if (!defaultSettingsObj.existsSync()) {
            promisify(new _(self.gina +'/resources/home/settings.json').cp)(defaultSettingsObj.toString())
                .catch( function onCopyError(_err) {
                    err = _err;
                })
        }
        if (err) {
            return done(err);
        }
        var defaultMainObj = new _(versionDirObj.toString() + '/main.json', true);
        if (!defaultMainObj.existsSync()) {
            promisify(new _(self.gina +'/resources/home/main.json').cp)(defaultMainObj.toString())
                .catch( function onCopyError(_err) {
                    err = _err;
                })
        }
        if (err) {
            return done(err);
        }

        var userDir = _(getUserHome() + '/.gina/user', true);
        // var userDirObj = new _(userDir);
        // if ( ! userDirObj.existsSync() ) {
        //     userDirObj.mkdirSync();
        // }
        // var extDir = _(userDir +'/extensions', true);
        // var extDirObj = new _(extDir);
        // if ( ! extDirObj.existsSync() ) {
        //     extDirObj.mkdirSync();
        // }

        // // logger
        // var extLogger = _(extDir +'/logger', true);

        // reading default extensions
        var ext = _(self.gina +'/resources/home/user/extensions', true);
        // if (!self.isCustomPrefix) {
        //     ext = _( self.defaultPrefix + '/lib/node_modules/gina/bin/gina')
        // }
        var folders = [];
        try {
            console.debug('Reading :'+ ext + ' - isDirectory ? '+ fs.lstatSync( ext ).isDirectory() );
            folders = fs.readdirSync(ext);

        } catch(readErr) {
            throw readErr
        }

        for (let i = 0, len = folders.length; i < len; i++) {
            let dir = folders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // skip symlinks
            try {
                console.debug('Checking: '+ _(ext +'/'+ dir, true) + ' - isSymbolicLink ? '+ fs.lstatSync( _(ext +'/'+ dir, true) ).isSymbolicLink() );
                if ( fs.lstatSync( _(ext +'/'+ dir, true) ).isSymbolicLink() ) {
                    continue;
                }
            } catch (e) {
                continue;
            }

            let userExtPath = _(userDir +'/extensions/'+ dir, true);
            let userExtPathObj = new _(userExtPath)
            if ( !userExtPathObj.existsSync() ) {
                userExtPathObj.mkdirSync()
            }

            let files = []
                , extDir = _(ext +'/'+ dir, true)
            ;
            try {

                console.debug('Reading extDir: '+ extDir + ' - isDirectory ? '+ fs.lstatSync( extDir ).isDirectory() );
                if ( !fs.lstatSync( extDir ).isDirectory() ) {
                    continue;
                }


                files = fs.readdirSync( extDir );

            } catch(fileReadErr) {}

            console.debug("What about files ? " + files);

            for (let n = 0, nLen = files.length; n < nLen; n++) {
                let file = files[n];
                console.debug('File --> ', file);
                let extentionPath   = _(extDir +'/'+ file, true);
                let extensionPathObj =  new _(extentionPath);
                // redefined
                let userExtPathObj = new _(userExtPath + '/'+ file, true);
                if ( !userExtPathObj.existsSync() ) {
                    let f = function(destination, cb) {// jshint ignore:line
                        extensionPathObj.cp(destination, cb);
                    };
                    let err = false;
                    await promisify(f)( _(userExtPath + '/'+ file, true) )
                        .catch( function onCopyError(_err) {// jshint ignore:line
                            err = _err;
                        })
                        .then( function onCopy(_destination) {// jshint ignore:line
                            console.debug('Copy '+ extentionPath +' to '+ _destination +' done !');
                        });

                    if (err) {
                        return done(err);
                    }
                }
            }
        }


        done()
    }

    /**
     * Updated user's profile
     * Will edit ~/.profile, check and add if needed path to Gina binary
     *
     */
    self.updateUserProfile = async function(done) {

        if ( !self.isGlobalInstall || isWin32() ) {
            return done()
        }
        // if (!self.isCustomPrefix || self.prefix == self.defaultPrefix) {
        //     return done()
        // }
        var cmd = null;
        var profilePath = getUserHome() + '/.profile';
        var profilePathObj = new _(profilePath);
        if ( !profilePathObj.existsSync() ) {
            cmd = 'touch '+ profilePath;
            await promisify(run)(cmd, { cwd: _(self.versionPath), tmp: _(getTmpDir(), true), outToProcessSTD: true, shell: "/bin/bash"})
                .catch(function onError(err){
                    if (err) {
                        console.warn('Try to run: sudo ' + cmd);
                        return done(err);
                    }
                });
        }

        var inFile = null;
        var patt = _(self.prefix.replace( new RegExp( '^' +getUserHome() ), '(.*)[$]HOME') + '/bin', true);
        try {
            inFile = execSync("cat ~/.profile | grep -Eo '" + patt +"'", {shell: "/bin/bash"}).toString();
        } catch (err) {
            // nothing to do
        }

        if (!inFile) {
            patt = patt.replace('(.*)[$]', '$');
            inFile = '\nif [ -d "'+ patt +'" ]; then';
            inFile += '\n    PATH="'+ patt +':$PATH"';
            inFile += '\nfi\n';
            try {
                fs.appendFileSync( getUserHome()+'/.profile', inFile );
            } catch (err) {
                return done(err);
            }
            inFile = null;

            // we need to source/update ~/.profile
            try {
                cmd = "source "+ profilePath;
                console.info('Running: '+ cmd);
                execSync(cmd, {shell: "/bin/bash"});
            } catch (err) {
                return done(err)
            }
        }

        done()
    }

    var restoreSymlinks = function() {
        var archivesPath = _(getUserHome() + '/.gina/archives/framework', true);
        var frameworkPath = _(self.gina +'/framework', true);

        if ( !new _(archivesPath).existsSync() ) {
            return;
        }
        // get current framework version
        var ginaPackage = require(pack);
        self.versionPath = self.gina;
        self.version = ginaPackage.version.replace(/^v/, '');
        self.shortVersion = self.version.split('.');
        self.shortVersion.splice(2);
        self.shortVersion = self.shortVersion.join('.');
        var currentVersion = 'v'+ self.version;
        // cleanup first
        var versionsFolders = fs.readdirSync(frameworkPath);
        for (let i = 0, len = versionsFolders.length; i < len; i++) {
            let dir = versionsFolders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // intercept & remove existing symlinks or old versions dir
            try {
                if ( fs.lstatSync( _(frameworkPath +'/'+ dir, true) ).isSymbolicLink() ) {
                    console.debug('Removing Symlink: '+ _(frameworkPath +'/'+ dir, true) );
                    // new _(frameworkPath +'/'+ dir, true).rmSync();
                    fs.unlinkSync(_(frameworkPath +'/'+ dir, true));
                    continue;
                }

                if (
                    dir != currentVersion
                    && fs.lstatSync( _(frameworkPath +'/'+ dir, true) ).isDirectory()
                ) {
                    console.debug('Removing old version: '+ _(frameworkPath +'/'+ dir, true));
                    new _(frameworkPath +'/'+ dir, true).rmSync()
                }
            } catch (e) {
                continue;
            }
        }

        // restoring symlinks from archives
        versionsFolders = fs.readdirSync(archivesPath);
        for (let i = 0, len = versionsFolders.length; i < len; i++) {
            let dir = versionsFolders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // skip selected - for dev team only
            if ( new _(frameworkPath +'/'+ dir, true).existsSync() ) {
                continue;
            }

            // creating symlinks
            try {
                console.debug( 'Creating symlink: '+ _(archivesPath +'/'+ dir, true) +' -> '+ _(frameworkPath +'/'+ dir, true));
                new _(archivesPath +'/'+ dir, true).symlinkSync(_(frameworkPath +'/'+ dir, true) );
            } catch (e) {
                throw e
            }
        }
    }


    self.end = function(done) {

        restoreSymlinks();

        // configuring Gina
        var ginaBinanry = _(self.gina + '/bin/gina', true);
        if (!self.isCustomPrefix && self.isGlobalInstall) {
            ginaBinanry = _( self.defaultPrefix + '/lib/node_modules/gina/bin/gina', true)
        }

        if ( !fs.existsSync(ginaBinanry) ) {
            console.error('Outch: `'+ ginaBinanry +'` not found !');
        }

        var cmd = null;
        try {
            cmd = ginaBinanry + ' framework:set --global-mode='+ self.isGlobalInstall;
            console.info('Running: '+ cmd);
            console.debug(execSync(cmd));
            cmd = ginaBinanry + ' framework:set --prefix='+ self.prefix;
            console.info('Running: '+ cmd);
            console.debug(execSync(cmd));
        } catch (err) {
            //return done(err)
        }


        // Update middleware file
        var filename = _(self.versionPath) + '/MIDDLEWARE';
        var msg = "Gina's command line tool has been installed.";

        var deps = require(_(self.versionPath) + '/package.json').dependecies;

        var version = require( _(self.gina + '/package.json') ).version;
        var middleware = 'isaac@'+version; // by default

        for (let d in deps) {
            if (d === 'express' && deps[d] != '') {
                middleware = d +'@'+ deps[d]
            }
        }

        var expressPackage = _(self.versionPath + '/node_modules/express/package.json');
        if ( typeof(middleware) == 'undefined' && fs.existsSync(expressPackage) ) {
            middleware = require(expressPackage).version;
            middleware = 'express@' + middleware;
        }
        else if (typeof(middleware) == 'undefined') {
            return done( new Error('No middleware found !!') );
        }

        if ( fs.existsSync(filename) ) { // update
            var def = fs.readFileSync(filename).toString;
            // TODO - uninstall old if installed ??
            if (def !== middleware) {
                fs.writeFile(filename, middleware, function onWrote(err){
                    if (err) {
                        return done(err)
                    }
                    console.debug('Updated: def !== middleware case');
                    // execSync(self.prefix +'/bin/gina framework:set --prefix='+ self.prefix);
                    console.info(msg);
                    done()
                })
            } // else, nothing to do
        } else { // create
            fs.writeFile(filename, middleware, function onWrote(err){
                if (err) {
                    return done(err)
                }
                console.info('File created case');

                console.info(msg);
                done()
            })
        }
    }


    init()
}
new PostInstall()