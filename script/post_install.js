/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2022 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports
var fs          = require('fs');
var util        = require('util');
var promisify   = util.promisify;
const { execSync } = require('child_process');

var lib         = require('./lib');
var console     = lib.logger;




/**
 * Post install constructor
 * @constructor
 * */
function PostInstall() {

    var self = {}, _this = this;

    //Initialize post installation scripts.
    var init = function() {
        self.isWin32 = isWin32();//getEnvVar('GINA_IS_WIN32');
        self.path = getEnvVar('GINA_FRAMEWORK');
        self.gina = getEnvVar('GINA_DIR');
        self.root = self.gina; // by default
        self.isGlobalInstall = false;

        var args = process.argv, i = 0, len = args.length;
        for (; i < len; ++i) {
            if (args[i] == '-g' ) {
                self.isGlobalInstall = true;
                break;
            }
        }

        console.debug('Is this for Windows ? ' +  self.isWin32);

        if ( !self.isGlobalInstall ) { //global install
            self.root = process.cwd(); // project path
            console.error('local installation is not supported for this version at the moment.');
            console.info('please use `npm install -g gina`');
            process.exit(1);
        }


        console.debug('framework path: ' + self.gina);
        console.debug('framework version path: ' + self.path);
        console.debug('cwd path: ' + self.root );
        console.debug('this is a global install ...');

        begin(0);
    }

    /**
     * Bebin - Will run checking tasks in order of declaration
     * */
     var begin = async function(i) {
        //console.debug('i is ', i);
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
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(-1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
        } else {
            process.exit(0);
        }
    }


    self.createVersionFile = function(done) {
        var version = require( _(self.gina + '/package.json') ).version;
        console.debug('writting version number: '+ version);

        var target = _(self.path + '/VERSION');
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

    var configureGina = function(callback) {
        // link to ./bin/cli to binaries dir
        if (!self.isWin32) {
            var binPath     = _('/usr/local/bin');
            var cli         = _(binPath +'/gina');
            // TODO - remove this part for the next version
            var cliDebug    = _(binPath +'/gina-debug');

            if ( fs.existsSync(cli) ) {
                fs.unlinkSync(cli)
            }
            // TODO - remove this part for the next version
            if ( fs.existsSync(cliDebug) ) {
                fs.unlinkSync(cliDebug)
            }

            var cmd = 'ln -s '+ self.gina +'/bin/gina '+ binPath +'/gina';
            console.debug('running: '+ cmd);
            run(cmd, { cwd: _(self.path), tmp: _(self.root +'/tmp'), outToProcessSTD: true })
                .onData(function(data){
                    console.info(data)
                })
                .onComplete( function onDone(err, data){
                    if (err) {
                        console.error(err);
                        console.warn('try to run : sudo ' + cmd);
                    }
                });
            // To debug, you just need to run:
            //          gina <topic>:<task> --inspect-gina
            //
            // TODO - remove this part for the next version
            // cmd = 'ln -s '+ self.gina +'/bin/cli-debug '+ binPath +'/gina-debug';
            // run(cmd, { cwd: _(self.path), tmp: _(self.root +'/tmp'), outToProcessSTD: true })
            //     .onData(function(data){
            //         console.info(data)
            //     })
            //     .onComplete( function onDone(err, data){
            //         if (err) {
            //             console.error(err);
            //             console.warn('try to run : sudo ' + cmd);
            //         }
            //     });

        } else {
            console.warn('linking gina binary is not supported yet for Windows.');
        }
    }

    //Creating framework command line file for nix.
    var createGinaFile = function(win32Name, callback) {
        var name = require( _(self.path + '/package.json') ).name;
        var appPath = _( self.path.substring(0, (self.path.length - ("node_modules/" + name + '/').length)) );
        var source = _(self.path + '/core/template/command/gina.tpl');
        var target = _(appPath +'/'+ name);
        if ( typeof(win32Name) != 'undefined') {
            target = _(appPath +'/'+ win32Name)
        }
        //Will override.
        console.info('linking to binaries dir ... ');
        if ( typeof(callback) != 'undefined') {
            if ( !self.isGlobalInstall ) { // local install only
                lib.generator.createFileFromTemplate(source, target, function onGinaFileCreated(err) {
                    callback(err)

                })
            } else {

                configureGina();
                callback(false)
            }
        } else {
            if ( !self.isGlobalInstall ) {
                lib.generator.createFileFromTemplate(source, target)
            } else {

                configureGina();
            }
        }
    }

    self.createGinaFileForPlatform = async function(done) {
        console.info('Creating platform file');
        var name = require( _(self.path + '/package.json') ).name;

        var filename = ( (self.isWin32) ? '.' : '' ) + name;

        var keepGoing = function(filename) {

            createGinaFile(filename, function onFileCreated(err) {
                if (err) {
                    return done(err)
                }

                // this is done to allow multiple calls of post_install.js
                var filename = _(self.path + '/SUCCESS');
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
                    var target = new _(self.path + '/node_modules');
                    console.debug('replacing: ', target.toString() );
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

        if (self.isWin32) {
            var appPath = _( self.path.substring(0, (self.path.length - ("node_modules/" + name + '/').length)) );
            var source = _(self.path + '/core/template/command/gina.bat.tpl');
            var target = _(appPath +'/'+ name + '.bat');
            if ( fs.existsSync(target) ) {
                fs.unlinkSync(target);
                // have to wait for windows to complete this
                setTimeout( async function(){
                    lib.generator.createFileFromTemplate(source, target);
                    await keepGoing(filename)
                }, 1000)
            } else {
                lib.generator.createFileFromTemplate(source, target);
                await keepGoing(filename)
            }

        } else {
            await keepGoing(filename)
        }
    }


    var hasNodeModulesSync = function() {
        return fs.existsSync( _(self.path + '/node_modules') )
    }


    var npmInstall = function(done) {
        console.info('now installing modules: please, wait ...');
        var cmd = ( isWin32() ) ? 'npm.cmd install' : 'npm install';

        run(cmd, { cwd: _(self.path), tmp: _(self.root +'/tmp'), outToProcessSTD: true })
            .onData(function onData(data){
                console.info(data)
            })
            .onComplete( function onDone(err, data){
                if (!err) {
                    return done()
                }
                done(err)
            })
    }

    self.cleanupIfNeeded = function(done) {

        var frameworkPath = self.gina;
        console.debug('Framework path is: ' + frameworkPath);

        // Let's cleanup `colors` from `GINA_DIR`
        if ( new _(frameworkPath +'/node_modules/colors', true).existsSync() ) {
            var initialDir = process.cwd();
            process.chdir(frameworkPath);
            var cmd = ( isWin32() ) ? 'npm.cmd rm colors' : 'npm rm colors';
            try {
                execSync(cmd);
                console.debug('Removed default `colors` module from `GINA_DIR`... This is normal ;)');
            } catch (npmErr) {
                return done(npmErr);
            }

            process.chdir(initialDir);
        }

        done()
    }

    self.checkUserExtensions = async function(done) {

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
        var folders = [];
        try {
            console.debug('Reading : '+ ext + ' - isDirectory ? '+ fs.lstatSync( ext ).isDirectory() );
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
                , extDirObj = new _(extDir)
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
                console.debug('file --> ', file);
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
                            console.info('Copy '+ extentionPath +' to '+ _destination +' done !');
                        });

                    if (err) {
                        throw err;
                    }
                }
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
        // cleanup first
        var versionsFolders = fs.readdirSync(frameworkPath);
        for (let i = 0, len = versionsFolders.length; i < len; i++) {
            let dir = versionsFolders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // intercept & remove existing symlinks
            try {
                if ( fs.lstatSync( _(frameworkPath +'/'+ dir, true) ).isSymbolicLink() ) {
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

        // Update middleware file
        var filename = _(self.path) + '/MIDDLEWARE';
        var msg = "Gina's command line tool has been installed.";

        var deps = require(_(self.path) + '/package.json').dependecies;

        var version = require( _(self.gina + '/package.json') ).version;
        var middleware = 'isaac@'+version; // by default

        for (let d in deps) {
            if (d === 'express' && deps[d] != '') {
                middleware = d +'@'+ deps[d]
            }
        }

        var expressPackage = _(self.path + '/node_modules/express/package.json');
        if ( typeof(middleware) == 'undefined' && fs.existsSync(expressPackage) ) {
            middleware = require(expressPackage).version;
            middleware = 'express@' + middleware;
        } else if (typeof(middleware) == 'undefined') {
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
                    console.info(msg);
                    done()
                })
            } // else, nothing to do
        } else { // create
            fs.writeFile(filename, middleware, function onWrote(err){
                if (err) {
                    return done(err)
                }
                console.info(msg);
                done()
            })
        }
    }

    init()
}
new PostInstall()