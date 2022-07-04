/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2022 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

var fs          = require('fs');
var util        = require('util');
var promisify   = util.promisify;
const { execSync } = require('child_process');

//var lib         = require('./lib');
// var console     = lib.logger;
var lib     = null;
var isWin32 = function() {
    return (process.platform === 'win32') ? true : false;
};

/**
 * Pre install constructor
 *
 * if you need to test, go to gina main folder
 * $ node --inspect-brk=5858 ./script/pre_install.js -g
 *
 * @constructor
 * */
function PreInstall() {
    var self = {}, _this = this;

    var init = function() {

        self.isGlobalInstall = false;

        var args = process.argv, i = 0, len = args.length;
        for (; i < len; ++i) {
            if (args[i] == '-g' ) {
                self.isGlobalInstall = true;
                break;
            }
        }

        if ( !self.isGlobalInstall ) { //global install
            self.root = process.cwd(); // project path
            console.error('local installation is not supported for this version at the moment.');
            console.info('please use `npm install -g gina`');
            process.exit(1);
        }

        begin(0);
        // TODO check old framework version to be archived
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
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(-1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();');// jshint ignore:line
        } else {
            process.exit(0);
        }
    }

    self.checkRequirements = async function(done) {

        // Let's install `colors` into `GINA_DIR` it will be removed by the `post_install.js` script
        var initialDir = process.cwd();
        var frameworkPath   = __dirname +'/..';
        if ( !fs.existsSync(frameworkPath +'/node_modules/colors') ) {
            process.chdir(frameworkPath);
            var cmd = ( isWin32() ) ? 'npm.cmd install colors@1.4.0' : 'npm install colors@1.4.0';
            execSync(cmd);
            process.chdir(initialDir);
        }
        lib = require('./lib');
        console = lib.logger;

        self.isWin32 = isWin32();//getEnvVar('GINA_IS_WIN32');
        self.path = getEnvVar('GINA_FRAMEWORK');
        self.gina = getEnvVar('GINA_DIR');
        self.root = self.gina; // by default

        console.debug('framework path: ' + self.gina);
        console.debug('framework version path: ' + self.path);
        console.debug('cwd path: ' + self.root );
        console.debug('this is a global install ...');

        done();
    }


    /**
     * setup permissions
     * https://docs.npmjs.com/resolving-eacces-permissions-errors-when-installing-packages-globally
     */
    self.setupPermissions = async function(done) {
        // TODO - handle windows case
        if ( /true/i.test(self.isWin32) ) {
            return done();
        }
        // create a directory for global installations
        var npmGlobalPath = getUserHome() + '/.npm-global';

        console.info('Setting npm global path: '+ npmGlobalPath +' '+ new _(npmGlobalPath).existsSync() );
        var npmGlobalPathObj = new _(npmGlobalPath);
        if ( !npmGlobalPathObj.existsSync() ) {
            npmGlobalPathObj.mkdirSync()
        }
        // from `/usr/local` -> `~/.npm-global`
        var cmd = 'npm config set prefix '+ getUserHome() +'/.npm-global';
        await promisify(run)(cmd, { cwd: _(self.path), tmp: _(self.root +'/tmp'), outToProcessSTD: true })
            .catch(function onError(err){
                if (err) {
                    console.warn('try to run: sudo ' + cmd);
                    return done(err);
                }
            });

        var profilePath = getUserHome() + '/.profile';
        var profilePathObj = new _(profilePath);
        if ( !profilePathObj.existsSync() ) {
            cmd = 'touch '+ profilePath;
            await promisify(run)(cmd, { cwd: _(self.path), tmp: _(self.root +'/tmp'), outToProcessSTD: true })
                .catch(function onError(err){
                    if (err) {
                        console.warn('try to run: sudo ' + cmd);
                        return done(err);
                    }
                });
        }

        var inFile = null;
        try {
            inFile = execSync("cat ~/.profile | grep .npm-global/bin").toString();
        } catch (err) {
            // nothing to do
        }

        if (!inFile) {
            inFile = "\n# set PATH so it includes user‘s private npm bin if exists"
            inFile += '\nif [ -d "$HOME/.npm-global/bin" ]; then';
            inFile += '\n    PATH="$HOME/.npm-global/bin:$PATH"';
            inFile += '\nfi\n';
            try {
                fs.appendFileSync( getUserHome()+'/.profile', inFile );
            } catch (err) {
                return done(err);
            }
            inFile = null;

            // we need to source/update ~/.profile
            try {
                execSync("source "+ profilePath);
            } catch (err) {
                return done(err)
            }
        }

        done()
    }

    self.checkIfGinaIsAlreadyInstalled = async function(done) {

        console.debug('Checking if Gina is already installed');

        // Backup current version

        // check for ~/.gina
        var ginaHomeDir = _(getUserHome() + '/.gina', true);
        // if not found -> skip because it means that gina might not be installed or configured yet
        if ( !new _(ginaHomeDir).existsSync() ) {
            return done();
        }

        // check if framework version folder is found
        var versionsFolders = null, frameworkPath = null;
        try {
            frameworkPath = _(self.root +'/framework', true);
            console.info('frameworkPath: ', frameworkPath);
            if ( !new _(frameworkPath).existsSync() ) {
                return done();
            }
            versionsFolders = fs.readdirSync(frameworkPath);
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
                throw err;
            }
        }
        // It is not required to update `~/.gina/main.json` &&  `~/.gina/{shortVersion}/settings.json`

        self.checkRequiredFolders = function(done) {

            // check for `/usr/local/var`

            // check for `/usr/local/tmp`
            var tmpDir = getTmpDir()
            console.info('`tmp` dir -> '+ tmpDir);
            var tmpDirObj = new _(tmpDir, true);
            if ( !tmpDirObj.existsSync() ) {
                tmpDirObj.mkdirSync()
            }

            // check for `/usr/local/run`
            var runDir = getRunDir();
            console.info('`run` dir -> '+ runDir);
            var runDirObj = new _(runDir, true);
            if ( !runDirObj.existsSync() ) {
                runDirObj.mkdirSync()
            }

            // check for `/usr/local/log`
            var logDir = getLogDir();
            console.info('`log` dir -> '+ logDir);
            var logDirObj = new _(logDir, true);
            if ( !logDirObj.existsSync() ) {
                logDirObj.mkdirSync()
            }

            done()
        }


        done()
    }

    init()
}

new PreInstall()