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
// #B663 (2026-09-25) — execFileSync added: a child whose arguments carry a path is
// started from an argument vector, never from a shell command line.
// const { execSync } = require('child_process');
const { execSync, execFileSync } = require('child_process');
var runtime     = require(__dirname + '/../utils/runtime.js');


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

// `colors` dependency removed in 0.3.1 — ANSI codes are now built into the logger.
// No temporary install needed.

// Framework lib registry is intentionally not loaded here. At install time the
// framework's nested deps (psl, @rhinostone/swig) may not yet be resolvable, and
// `lib/domain` would crash on `require('psl')`. Node's built-in `console` is
// sufficient for the install scripts; `console.setLevel` (a `lib.logger`-only
// method) is gated below.

var scriptPath = __dirname;
var ginaPath = (scriptPath.replace(/\\/g, '/')).replace('/script', '');
var pack        = ginaPath + '/package.json';
pack =  (isWin32()) ? pack.replace(/\//g, '\\') : pack;

// Pre-load framework helpers BEFORE utils/helper. utils/helper.js's init()
// calls `require('framework/v*/lib/logger')`, which itself requires
// `framework/v*/helpers` (lib/logger:64). When utils/helper is the outer
// caller of lib/logger, lib/logger blocks at its helpers require and the
// iteration's `_require` reloads path.js / task.js while lib/logger is still
// mid-load — their module-local `var console = require('../lib/logger')`
// then binds to a partial module.exports (= {}), so a later `console.debug`
// in `task.js#run()` throws TypeError. Pre-loading helpers here makes
// helpers/index.js the outer caller, so lib/logger completes inside
// context.js's trigger and the subsequent `_require` reloads of path.js/
// task.js see the full Logger singleton from cache.
// Filesystem-driven version discovery so this stays correct across version
// bumps that may temporarily skew package.json `version` and the framework
// directory name (e.g. during a patch release window).
try {
    var _frameworkDir = fs.readdirSync(ginaPath + '/framework')
        .filter(function(d) { return /^v/.test(d); })
        .sort()
        .pop();
    if (_frameworkDir) {
        require(ginaPath + '/framework/' + _frameworkDir + '/helpers');
    }
} catch (_e) {
    // best-effort preload; the actual install steps will surface any real failure
}

var help        = require(ginaPath + '/utils/helper.js');
var helpers = null;


/**
 * Post install constructor
 * @constructor
 * */
function PostInstall() {

    var self = {};

    /**
     * Resolves the install context: the platform, whether the install is global or
     * local, the reset flag, npm's default prefix (the #B126-guarded probe), the
     * target prefix (`--prefix=`, `npm_config_prefix`, or INIT_CWD for a local
     * install), and the installed gina version and paths (`npm list`, or this
     * package's own `package.json` for a local install).
     *
     * Both npm probes run from argument vectors, without a shell (#B663): a prefix,
     * or npm itself, under a path containing a space reaches npm whole.
     *
     * @inner
     * @private
     * @returns {void}
     * @throws {Error} On win32, which is not supported yet
     */
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
        // #B126 — `npm config get prefix` REFUSES the read (exit 1: "The
        // prefix option is protected, and cannot be retrieved in this way")
        // whenever the RESOLVED VALUE trips npm's redactor (npm config.js
        // isPrivate(): redact(value) !== value — e.g. a path containing a
        // UUID-shaped segment). Measured on npm 10.9.8 / 11.6.2 / 11.18.0 /
        // 12.0.1 — every current generation; the option's SOURCE (flag, env,
        // npmrc) is irrelevant. Unguarded, the refusal killed the install at
        // whichever lifecycle phase ran the probe first. npm exports the
        // effective prefix to the lifecycle env, so fall back to it; last
        // resort: the node-derived default prefix.
        // #B663 (2026-09-25) — an argument vector, no shell: `$(which npm)` split an npm
        // installed under a path containing a space, so the probe failed and fell back.
        // self.defaultPrefix  = execSync('$(which npm) config get prefix --quiet').toString().replace(/\n$/g, '');
        try {
            self.defaultPrefix  = execFileSync('npm', ['config', 'get', 'prefix', '--quiet']).toString().replace(/\n$/g, '');
        } catch (probeErr) {
            self.defaultPrefix  = process.env.npm_config_prefix
                                || require('path').resolve(process.execPath, '..', '..');
            console.warn('`npm config get prefix` was refused (protected/redacted value); falling back to `'+ self.defaultPrefix +'`');
        }
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
                // setLevel is a lib.logger method; Node's built-in console doesn't expose it.
                if ( typeof(console.setLevel) === 'function' ) {
                    console.setLevel(logLevel, 'gina');
                }
                process.env.LOG_LEVEL=logLevel;
            }
        }

        if (self.prefix != self.defaultPrefix) {
            self.isCustomPrefix = true;
        }

        // Path-shape fallback for isGlobalInstall when npm doesn't propagate
        // npm_config_global to the post-install subprocess. Win32 is unreachable
        // (early throw above), so a POSIX-only regex suffices.
        if ( !self.isGlobalInstall && /\/lib\/node_modules\/gina\/script\/?$/.test(__dirname) ) {
            self.isGlobalInstall = true;
            console.debug('isGlobalInstall set true via path-shape fallback (__dirname: '+ __dirname +')');
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
                    "engines": {
                        "node": ">=" + process.version.substring(1)
                    }
                };
                console.warn('No `package.json` found for your project, creating one to avoid install exceptions');
                // Inlined to avoid loading the framework lib registry at install time.
                fs.writeFileSync(projectPackageJsonObj.toString(), JSON.stringify(defaultPackageJsonContent, null, 4));
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
            // #B663 (2026-09-25) — an argument vector, no shell: the prefix was spliced in
            // unquoted, so a prefix containing a space never found the installed gina.
            // cmd = 'npm list gina --long --json --prefix='+ self.prefix;
            // if (self.isGlobalInstall) {
            //     cmd += ' -g';
            // }
            // pkg = execSync(cmd).toString().replace(/\n$/g, '');
            cmd = ['list', 'gina', '--long', '--json', '--prefix='+ self.prefix];
            if (self.isGlobalInstall) {
                cmd.push('-g');
            }
            pkg = execFileSync('npm', cmd).toString().replace(/\n$/g, '');
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
                    // #SCS1b (2026-04-23) — hold the function reference directly instead
                    //                        of building a `'self.' + t` string for eval.
                    functName = t;
                    funct     = self[t];
                    console.debug('Running [ self.' + functName + '() ]');
                    break;
                }
                n++;
            }
        }

        // to handle sync vs async to allow execution in order of declaration
        if (funct) {
            // #SCS1b (2026-04-23) — replaced `eval('async function on<Name>...')` chain
            //                        scaffolding with a direct promisify + try/await/catch
            //                        so Socket no longer flags `Uses eval`. Semantics
            //                        unchanged: promisify → await → error ⇒ console.error
            //                        + process.exit(1) → recurse to begin(i+1). The
            //                        per-function `on<Name>` stack-label is lost; functName
            //                        is logged above instead.
            // eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
            (async function() {
                try {
                    await promisify(funct)();
                } catch (e) {
                    console.error(e && e.stack ? e.stack : e.toString());
                    process.exit(1);
                    return;
                }
                begin(i + 1);
            })();
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

            // If the link source is missing, no-op the link. npm auto-creates
            // ./node_modules/.bin/gina inside a local install's project; absence here
            // typically means a global install was mis-detected as local.
            if ( !fs.existsSync(source) ) {
                console.warn('Skipping binaries-dir link: `'+ source +'` does not exist.');
                return callback(false);
            }

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


    /**
     * Installs the framework directory's own nested dependencies — a
     * project-scoped `npm install` (`bun install` under Bun) run from
     * `self.versionPath`.
     *
     * Sanitizes inherited `npm_config_*` lifecycle exports around the child:
     * `npm_config_global` is forced to `false` (this is a project install even
     * when gina itself is installed globally), and the allow-scripts export is
     * dropped for the child's duration (#B106) — npm rejects `allow-scripts`
     * in project-scoped installs (EALLOWSCRIPTS), so an inherited value from
     * the documented `--allow-scripts=gina` remedy would kill the nested
     * install and with it the whole global install.
     *
     * @inner
     * @param {function} done - continuation callback
     * @returns {void}
     */
    var npmInstall = function(done) {

        console.info('Now installing modules. Please, wait ...');
        console.info('Prefix ('+ self.isCustomPrefix +'): '+ self.prefix);
        console.info('Default prefix: '+ self.defaultPrefix);
        var initialDir = process.cwd();


        // Bun-only images ship no npm binary — use `bun install` under Bun. Zero
        // Node delta: isBun() is false on Node, so cmd is byte-identical to before.
        // (This nested install only runs from-source — `bun add -g` blocks it.)
        var cmd = runtime.isBun()
                      ? 'bun install'
                      : ( ( isWin32() ) ? 'npm.cmd install' : 'npm install' );

        process.chdir( self.versionPath );

        console.info('Running: `'+ cmd +'` from '+ process.cwd() );
        console.info('Running using TMPDIR: '+  _(getTmpDir(), true) );
        var oldConfigGlobal = process.env.npm_config_global;
        var oldAllowScripts = process.env.npm_config_allow_scripts;
        process.env.npm_config_global = false;
        // #B106 — npm exports explicitly-set config to lifecycle children as
        // `npm_config_*`, and `allow-scripts` is rejected in project-scoped
        // installs (EALLOWSCRIPTS): an inherited `--allow-scripts=gina` (or the
        // user-level config) would kill this nested install. Drop it — the
        // framework deps carry no install scripts.
        delete process.env.npm_config_allow_scripts;
        console.info('Running using TMPDIR: '+ cmd);
        console.info(execSync(cmd).toString());
        process.chdir(initialDir);
        process.env.npm_config_global = oldConfigGlobal;
        if ( typeof(oldAllowScripts) != 'undefined' ) {
            process.env.npm_config_allow_scripts = oldAllowScripts;
        }

        done()
    }

    // `cleanupIfNeeded` removed in 0.3.1 — `colors` is no longer installed.

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
     * On a global install, creates `~/.profile` when it is missing and appends a
     * block that puts `<prefix>/bin` on PATH, unless the profile already names it.
     * Neither step starts a shell on a path (#B663): the profile is created with
     * `fs`, and it is no longer `source`d — that ran in a bash child that exited at
     * once, so it never reached the user's shell; a new shell reads the profile.
     *
     * @inner
     * @private
     * @param {function(Error=)} done - Continuation; called with an error to abort the install
     * @returns {Promise<void>}
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
            // #B663 (2026-09-25) — created with fs: helpers/task.js `run()` starts its child
            // without a shell and splits the command line on spaces, so `touch <home with a
            // space>/.profile` failed and aborted the install (exit 1).
            // cmd = 'touch '+ profilePath;
            // await promisify(run)(cmd, { cwd: _(self.versionPath), tmp: _(getTmpDir(), true), outToProcessSTD: true, shell: "/bin/bash"})
            //     .catch(function onError(err){
            //         if (err) {
            //             console.warn('Try to run: sudo ' + cmd);
            //             return done(err);
            //         }
            //     });
            try {
                fs.appendFileSync(profilePath, '');
            } catch (err) {
                console.warn('Could not create `'+ profilePath +'`');
                return done(err);
            }
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
            // #B663 (2026-09-25) — removed: the `source` ran in a bash child that exited at once,
            // so it never updated the user's shell, and the path was spliced in unquoted, so a
            // home path containing a space made it throw — exit 1. A new shell reads the profile.
            // try {
            //     cmd = "source "+ profilePath;
            //     console.info('Running: '+ cmd);
            //     execSync(cmd, {shell: "/bin/bash"});
            // } catch (err) {
            //     return done(err)
            // }
            console.info('Added `'+ patt +'` to PATH in `'+ profilePath +'`');
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


    /**
     * Last install step: restores archived framework versions as symlinks, sets the
     * git hooks path in a gina clone, runs `gina framework:set` for the global mode
     * and the npm prefix, syncs `def_framework` and `def_global_mode` in
     * `~/.gina/main.json`, and writes the MIDDLEWARE file.
     *
     * The two `framework:set` calls run the gina binary on this runtime from argument
     * vectors, without a shell (#B663).
     *
     * @inner
     * @private
     * @param {function(Error=)} done - Continuation; called with an error to abort the install
     * @returns {void}
     */
    self.end = function(done) {

        restoreSymlinks();

        // #S5 — install gina's pre-commit hook for contributor clones.
        // `.git` exists at self.gina root only in a clone/worktree of the gina
        // repo, not inside `node_modules/gina` on a consumer install. We gate on
        // its presence so end-user `npm install gina` is a no-op here.
        // `fs.existsSync(.git)` matches both main repo (.git dir) and linked
        // worktrees (.git file pointing at ../.git/worktrees/<name>).
        try {
            if ( fs.existsSync( _(self.gina + '/.git', true) ) ) {
                execSync('git -C "' + self.gina + '" config core.hooksPath .githooks');
                console.debug('Installed gina git hooks path (core.hooksPath=.githooks)');
            }
        } catch (_hooksErr) {
            console.warn('Could not install gina git hooks path: ' + (_hooksErr.message || _hooksErr));
        }

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
            // #B663 (2026-09-25) — argument vectors run on this runtime, no shell: the binary
            // path was spliced in unquoted, so under a path containing a space both calls
            // failed and were skipped without a word (the catch below).
            // cmd = ginaBinanry + ' framework:set --global-mode='+ self.isGlobalInstall;
            // console.info('Running: '+ cmd);
            // console.debug(execSync(cmd));
            cmd = [ginaBinanry, 'framework:set', '--global-mode='+ self.isGlobalInstall];
            console.info('Running: '+ cmd.join(' '));
            console.debug(execFileSync(process.execPath, cmd));
            // Always use defaultPrefix (npm config get prefix) for the global
            // settings — self.prefix gets overridden to INIT_CWD for local
            // installs (line 154), which would corrupt ~/.gina/*/settings.json
            // with the project directory instead of the npm global prefix.
            // cmd = ginaBinanry + ' framework:set --prefix='+ self.defaultPrefix;
            // console.info('Running: '+ cmd);
            // console.debug(execSync(cmd));
            cmd = [ginaBinanry, 'framework:set', '--prefix='+ self.defaultPrefix];
            console.info('Running: '+ cmd.join(' '));
            console.debug(execFileSync(process.execPath, cmd));
        } catch (err) {
            //return done(err)
        }


        // Sync main.json def_framework to the installed version.
        // post_install is the canonical moment when a new version lands on disk — keep
        // def_framework in sync here so the CLI, cmd handlers, and framework:init all
        // agree on which version is active without requiring a manual edit or a
        // bundle:start to trigger the bin/cli safety-net sync.
        //
        // "Never regress" guard: when self.version is strictly older than the
        // current def_framework (per semver), skip the def_framework write.
        // The frameworks LIST may still be updated (so historic alpha/stable
        // tarballs that landed locally for testing remain visible), but the
        // scalar pointer to the active version stays at whatever was already
        // ahead. Without this guard, `npm install -g gina@<older>` overwrote
        // def_framework with the older version (precedent: the v0.3.10
        // stable publish 2026-05-06 aborted at prepare_version.js because
        // an older-tarball reinstall had clobbered the live alpha state
        // back to 0.3.9). The defensive gate at script/check_def_framework_consistency.js
        // (added in the same release window) is the publish-time safety net;
        // this guard removes the trigger.
        var _mainJsonPath = _(getUserHome() + '/.gina/main.json', true);
        if ( fs.existsSync(_mainJsonPath) ) {
            try {
                var _mainData = JSON.parse( fs.readFileSync(_mainJsonPath, 'utf8') );
                var _versionCompare = require('./version_compare');
                var _isRegression   = _versionCompare.isStrictlyOlder(self.version, _mainData.def_framework);
                if ( _mainData.def_framework !== self.version && !_isRegression ) {
                    console.info('Updating def_framework: ' + (_mainData.def_framework || 'unset') + ' → ' + self.version);
                    _mainData.def_framework = self.version;
                    if ( !_mainData.frameworks ) { _mainData.frameworks = {}; }
                    if ( !_mainData.frameworks[self.shortVersion] ) { _mainData.frameworks[self.shortVersion] = []; }
                    if ( _mainData.frameworks[self.shortVersion].indexOf(self.version) < 0 ) {
                        _mainData.frameworks[self.shortVersion].push(self.version);
                    }
                    fs.writeFileSync(_mainJsonPath, JSON.stringify(_mainData, null, 4));
                } else if ( _isRegression ) {
                    console.info(
                        'Skipping def_framework update: installed ' + self.version +
                        ' is strictly older than current ' + _mainData.def_framework +
                        ' — preserving newer state to prevent regression. Frameworks list still updated.'
                    );
                    if ( !_mainData.frameworks ) { _mainData.frameworks = {}; }
                    if ( !_mainData.frameworks[self.shortVersion] ) { _mainData.frameworks[self.shortVersion] = []; }
                    if ( _mainData.frameworks[self.shortVersion].indexOf(self.version) < 0 ) {
                        _mainData.frameworks[self.shortVersion].push(self.version);
                        fs.writeFileSync(_mainJsonPath, JSON.stringify(_mainData, null, 4));
                    }
                }
            } catch(e) {
                console.warn('Could not sync def_framework in main.json: ' + (e.message || e));
            }
        }

        // Seed def_global_mode[shortVersion] from packObj.config.globalMode (#B12).
        // The resources/home/main.json template carries a ${global_mode} placeholder that
        // is only resolved when checkIfMain runs with GINA_GLOBAL_MODE already in the env.
        // On a fresh `npm install gina`, that env var isn't set yet — the token persists
        // into ~/.gina/main.json, and the first `gina --version` surfaces a Whisper error.
        // Reading packObj.config.globalMode here honours `npm config set gina:globalMode <v>`
        // overrides (npm rewrites package.json.config at install time when that is set).
        try {
            var _packObj = require(pack);
            var _gmRaw = ( _packObj.config && typeof(_packObj.config.globalMode) != 'undefined' )
                ? _packObj.config.globalMode
                : true;
            var _gmResolved = ( typeof(_gmRaw) == 'string' ) ? /^true$/i.test(_gmRaw) : !!_gmRaw;

            if ( fs.existsSync(_mainJsonPath) ) {
                var _rootData = JSON.parse( fs.readFileSync(_mainJsonPath, 'utf8') );
                if ( !_rootData.def_global_mode ) { _rootData.def_global_mode = {}; }
                if ( _rootData.def_global_mode[self.shortVersion] !== _gmResolved ) {
                    _rootData.def_global_mode[self.shortVersion] = _gmResolved;
                    fs.writeFileSync(_mainJsonPath, JSON.stringify(_rootData, null, 4));
                }
            }

            var _versionMainPath = _(getUserHome() + '/.gina/' + self.shortVersion + '/main.json', true);
            if ( fs.existsSync(_versionMainPath) ) {
                var _verData = JSON.parse( fs.readFileSync(_versionMainPath, 'utf8') );
                if ( !_verData.def_global_mode ) { _verData.def_global_mode = {}; }
                var _existing = _verData.def_global_mode[self.shortVersion];
                if ( typeof(_existing) != 'boolean' || _existing !== _gmResolved ) {
                    _verData.def_global_mode[self.shortVersion] = _gmResolved;
                    fs.writeFileSync(_versionMainPath, JSON.stringify(_verData, null, 4));
                }
            }
        } catch(e) {
            console.warn('Could not seed def_global_mode in main.json: ' + (e.message || e));
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
            var def = fs.readFileSync(filename).toString(); // was: .toString (missing call — def was a function ref, comparison always true)
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
            } else {
                done() // was: missing — would hang when middleware file already matches
            }
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