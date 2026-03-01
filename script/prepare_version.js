#!/usr/bin/env node

/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

//Imports.
var fs          = require('fs');
var util        = require('util');
var promisify   = util.promisify;
const { execSync } = require('child_process');


var scriptPath = __dirname;
var ginaPath = (scriptPath.replace(/\\/g, '/')).replace('/script', '');
var help        = require(ginaPath + '/utils/helper.js');
var pack        = ginaPath + '/package.json';
pack        =  (isWin32()) ? pack.replace(/\//g, '\\') : pack;

var helpers     = null;
var lib         = null;
/**
 * PrepareVersion constructor
 *
 * NB.:
 *  This script can only be executed on Mac OS X or on Linux distributions
 *  It will:
 *      - commit & push all modifications to the appropriate branch
 *      - create if needed a new branch for the new version & remotely push to this new branch
 *      - update local default version with the new one
 *
 * if you need to test, go to gina main folder
 * $ node --inspect-brk=5858 ./script/prepare_version.js -g
 *  or if you are calling `npm publish` or `npm publish --dry-run`
 * $ node --inspect-brk=5858 /usr/local/bin/npm publish --dry-run
 *
 * @constructor
 * */
function PrepareVersion() {
    var self    = {
        isWin32: isWin32(),
        git : {
            tag: 'latest',
            msg: null
        },
        isGitPushNeeded : false
    };

    var configure = function() {
        // TODO - handle windows case
        if ( /^true$/i.test(isWin32()) ) {
            throw new Error('Windows in not yet fully supported. Thank you for your patience');
        }

        // Overriding thru passed arguments
        var args = process.argv, i = 0, len = args.length;
        for (; i < len; ++i) {
            if ( /^\-\-tag/.test(args[i]) ) {
                var tag = args[i].split(/\=/)[1];
                if ( tag != self.git.tag) {
                    self.git.tag = tag;
                    self.isGitPushNeeded = ( typeof(process.env.npm_config_dry_run) != 'undefined' ) ? false : true
                }
                continue;
            }

            if ( /^(\-m|\-\-message)$/.test(args[i]) ) {
                var m = args[i];
                if (/^(.*)\=/.test(m)) {
                    m = m.split(/\=/)[1]
                }
                self.git.msg = m.replace(/^(\-m|\-\-message)/g, '').replace(/(\"|\')/g, '');
                continue;
            }
        }

        self.gina = __dirname +'/..';
    }

    var init = function() {
        configure();

        begin(0);
    };

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
            try {
                eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
            } catch (err) {
                console.error(err.stack||err.message||err);
            }

        } else {
            process.exit(0);
        }
    }


    self.getSelectedVersion = async function(done) {
        var homeDir = getUserHome() || null;
        var frameworkPath = null;

        if (!homeDir) {
            return done(new Error('No $HOME path found !'))
        }

        var ginaHomeDir = homeDir.replace(/\n/g, '') + '/.gina';
        setEnvVar('GINA_HOMEDIR', ginaHomeDir);

        console.debug('GINA_HOMEDIR: ', ginaHomeDir);
        console.debug('isWin32: ', isWin32());

        var mainConfigPath = ginaHomeDir +'/main.json';
        var mainConfig = require(mainConfigPath);
        var package = require(pack);
        var selectedVersion = mainConfig.def_framework.replace(/^v/, '');
        var targetedVersion = package.version.replace(/^v/, '');
        // Versions are already in sync (post_publish bumped and committed everything).
        // Just load the framework so helpers/lib are available for the steps below.
        if (selectedVersion == targetedVersion) {
            frameworkPath = './../framework/v'+selectedVersion;
            helpers       = require(frameworkPath +'/helpers');
            lib           = require(frameworkPath +'/lib');
        }

        self.selectedVersion = selectedVersion;
        self.targetedVersion = targetedVersion;

        console.debug('Selected version : ', selectedVersion);
        console.debug('Targeted version : ', targetedVersion);



        // setting up requirements
        var shortVersion = selectedVersion.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        var settingsConfigPath  = ginaHomeDir+'/'+shortVersion+'/settings.json';
        var settingsConfig      = require(settingsConfigPath);
        var ginaPath            = settingsConfig.dir;
        self.ginaPath = ginaPath;

        frameworkPath       = ginaPath +'/framework/v'+selectedVersion;
        self.frameworkPath      = frameworkPath;
        helpers     = require(frameworkPath +'/helpers');
        lib         = require(frameworkPath +'/lib');

        // In case of downdrade
        // target already exist as a symlink ?
        var versionDestination = _(ginaPath +'/framework/v'+targetedVersion, true);
        var versionDestinationObj = new _(versionDestination);
        if ( selectedVersion != targetedVersion && versionDestinationObj.existsSync() ) {
            var versionDestinationIsSymlink = fs.lstatSync( versionDestination ).isSymbolicLink();
            console.debug('versionDestination ??? ', versionDestination, versionDestinationObj.existsSync(), versionDestinationIsSymlink );
            if (versionDestinationIsSymlink) {
                // await versionDestinationObj.rmSync();
                fs.unlinkSync(versionDestination);
            }
        }

        // update selected version & requirements
        shortVersion = targetedVersion.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        if ( typeof(mainConfig.frameworks[shortVersion]) == 'undefined' ) {
            mainConfig.frameworks[shortVersion] = [];
            // create settings.json for the new version

        }
        if ( mainConfig.frameworks[shortVersion].indexOf(targetedVersion) < 0 ) {
            mainConfig.frameworks[shortVersion].push(targetedVersion)
        }


        settingsConfigPath  = ginaHomeDir+'/'+shortVersion+'/settings.json';
        settingsConfig      = require(settingsConfigPath);

        // setting def_framework
        mainConfig.def_framework    = targetedVersion;
        settingsConfig.version      = targetedVersion;
        ginaPath                    = settingsConfig.dir;
        self.ginaPath = ginaPath;
        // backup of folder version to archives



        // console.debug('mainConfig: ', JSON.stringify(mainConfig, null, 2));
        // console.debug('settingsConfig: ', JSON.stringify(settingsConfig, null, 2));

        // saving local config
        lib.generator.createFileFromDataSync(JSON.stringify(mainConfig, null, 2), mainConfigPath);
        lib.generator.createFileFromDataSync(JSON.stringify(settingsConfig, null, 2), settingsConfigPath);


        var frameworkPathObj    =  new _(frameworkPath, true);
        console.debug('source path is: '+ frameworkPath);

        var destination = _(ginaHomeDir +'/archives/framework/v'+targetedVersion, true);
        console.debug('destination path is: '+ destination.toString());
        if ( new _(destination).existsSync() ) {
            new _(destination).rmSync();
        }
        var err = false;

        // since we cannot yet promissify directly PathObject.cp()
        // var f = function(destination, cb) {
        //     frameworkPathObj.cp(destination, cb);
        // };
        // await promisify(f)(destination)
        //     .catch( function onCopyError(_err) {
        //         err = _err;
        //     })
        //     .then( function onCopy(_destination) {
        //         console.debug('Copy to '+ _destination +': done');
        //     });
        try {
            await frameworkPathObj.cp(destination)
        } catch (err) {
            if (err) {
                throw err;
            }
        }




        if (selectedVersion != targetedVersion) {
            console.debug('Stopping gina');
            // var ginaBin = execSync("which gina").toString().replace(/(\n|\r|\t)/g, '');
            // if (ginaBin) {
            //     try {
            //         cmd = execSync(ginaBin +' stop @'+selectedVersion);
            //         // cmd = execSync(ginaBin +' stop')
            //         // TODO - stop all running bundles
            //     } catch (err) {
            //         console.error(err.stack||err.message||err);
            //         return done(err);
            //     }
            // }
        }

        if (selectedVersion != targetedVersion) {
            // rename folder version
            destination = _(ginaPath +'/framework/v'+targetedVersion, true);
            frameworkPathObj.renameSync(destination);

            // updating requirements
            self.selectedVersion = targetedVersion;
            self.frameworkPath = frameworkPath = ginaPath +'/framework/v'+targetedVersion;
            helpers             = require(frameworkPath +'/helpers');
            lib                 = require(frameworkPath +'/lib');

            // keeping package.json up to date
            //"main": "./framework/v{version}/core/gna",
            package.main = './framework/v'+ targetedVersion +'/core/gna';
            new _(pack, true).rmSync();
            lib.generator.createFileFromDataSync(JSON.stringify(package, null, 2), pack);
        }

        done()
    };

    self.setupScriptCWD = function(done) {
        var currentWorkingDir = process.cwd();
        if ( self.ginaPath != currentWorkingDir ) {
            console.debug('Changing current working dir from `'+ currentWorkingDir +'` to `'+ self.ginaPath +'`');
            process.chdir(self.ginaPath);
        }

        done();
    }

    self.updateVersionIfNeeded = function(done) {

        var version = self.selectedVersion.replace(/^[a-z]+/ig, '');
        var versionFilePath = _(self.frameworkPath +'/VERSION', true);
        var versionFilePathObj = new _(versionFilePath);
        if ( versionFilePathObj.existsSync() ) {
            // read & compare version
            var inFileVersion = fs.readFileSync(versionFilePath).toString();
            if ( inFileVersion == version ) {
                // nothing to do then
                return done();
            }
            versionFilePathObj.rmSync()
        }

        console.debug('updating version ...');
        lib.generator.createFileFromDataSync(version, versionFilePath);

        done();
    }

    self.updateMiddlewareIfNeeded = function(done) {

        var version = self.selectedVersion.replace(/^[a-z]+/ig, '');
        var middleware = 'isaac@'+version; // by default
        var deps = require(_(self.frameworkPath, true) + '/package.json').dependecies;
        for (let d in deps) {
            if (d === 'express' && deps[d] != '') {
                middleware = d +'@'+ deps[d]
            }
        }
        var expressPackage = _(self.path + '/node_modules/express/package.json', true);
        if ( typeof(middleware) == 'undefined' && new _(expressPackage).existsSync() ) {
            middleware = require(expressPackage).version;
            middleware = 'express@' + middleware;
        } else if (typeof(middleware) == 'undefined') {
            throw new Error('No middleware found !!');
        }

        var middlewareFilePath = _(self.frameworkPath +'/MIDDLEWARE', true);
        var middlewareFilePathObj = new _(middlewareFilePath);
        if ( middlewareFilePathObj.existsSync() ) {
            // read & compare middleware
            var inFileMiddleware = fs.readFileSync(middlewareFilePath).toString();
            if ( inFileMiddleware == middleware ) {
                // nothing to do then
                return done();
            }
            middlewareFilePathObj.rmSync()
        }

        console.debug('updating middleware ...');
        lib.generator.createFileFromDataSync(middleware, middlewareFilePath);

        done();
    }

    self.removeAllSymlinks = function(done) {

        // remove existing symlinks
        var versionsFolders = null, frameworkPath = null;
        try {
            frameworkPath = _(self.ginaPath +'/framework', true);
            console.debug('frameworkPath: ', frameworkPath);
            if ( !new _(frameworkPath).existsSync() ) {
                return done();
            }
            versionsFolders = fs.readdirSync(frameworkPath);
        } catch (err) {
            // do nothing
        }

        for (let i = 0, len = versionsFolders.length; i < len; i++) {
            let dir = versionsFolders[i];
            // skip junk
            if ( /^\./i.test(dir) || /(\s+copy|\.old)$/i.test(dir) ) {
                continue;
            }

            // intercept & remove symlinks
            try {
                if ( fs.lstatSync( _(frameworkPath +'/'+ dir, true) ).isSymbolicLink() ) {
                    new _(frameworkPath +'/'+ dir, true).rmSync()
                }
            } catch (e) {
                continue;
            }
        }

        done();
    }

    self.buildPlugins = function(done) {

        var frameworkPath = _(self.gina +'/framework', true);
        // get current framework version
        var package = require(pack);
        var currentVersion = 'v'+ package.version.replace(/^v/, '');
        var pluginPath = _(frameworkPath +'/'+ currentVersion + '/core/asset/plugin', true);
        var buildCmd = _(pluginPath +'/build', true);

        console.debug('Building Frontend plugins ['+ self.selectedVersion +']', pluginPath);
        var initialDir = process.cwd();
        process.chdir( pluginPath );
        console.info('Please, wait ...');
        console.info('running: `'+ buildCmd +'` from '+ process.cwd() );
        execSync(buildCmd);

        process.chdir(initialDir);


        return done()
    }


    self.pushChangesToGitIfNeeded = function(done) {

        var cmd = null;
        var version = self.selectedVersion.replace(/^[a-z]+/ig, '');

        // getting current branch
        // git rev-parse --abbrev-ref HEAD
        // => 010
        var currentBranch = null;
        try {
            currentBranch = execSync("$(which git) rev-parse --abbrev-ref HEAD")
                            .toString()
                            .replace(/(\n|\r|\t)/g, '');
        } catch (err) {
            // nothing to do
            return done( new Error('[GIT] No branch selected') )
        }


        // create new branch if needed
        // e.g: 0.1.0-alpha.1 -> 010-alpha1
        var targetedBranch = version.replace(/\./g, ''); // by default
        if (!self.isGitPushNeeded) {
            targetedBranch = 'develop'; // for none production versions
        }
        self.targetedBranch = targetedBranch;

        console.debug('[GIT] Current branch: '+ currentBranch);
        console.debug('[GIT] Targeted branch: '+ targetedBranch);


        // check if targeted branch exists
        // git rev-parse --verify 011
        var branchExists = null;
        try {
            branchExists = execSync("$(which git) rev-parse --verify "+ targetedBranch)
                            .toString()
                            .replace(/(\n|\r|\t)/g, '');
        } catch (err) {
            // nothing to do
        }


        if (!branchExists) {
            console.debug('No existing branch found, creating a new one !');
            try {
                execSync("git checkout -b "+ targetedBranch);
                if (self.isGitPushNeeded) {
                    // pushing to new branch
                    console.debug('setting up remote branch `'+ targetedBranch +'` to git ...');
                    execSync("$(which git) push --set-upstream origin "+ targetedBranch);
                }
            } catch (err) {
                console.error(err.stack||err.message||err);
                return done(err);
            }
        }
        // use existing to push updates
        else {

            if (currentBranch != targetedBranch) {
                console.debug('Switching from branch `'+ currentBranch +'` to branch `'+ targetedBranch +'`');
                // git checkout 010
                try {
                    cmd = execSync("$(which git) checkout "+ targetedBranch);
                } catch (err) {
                    console.error(err.stack||err.message||err);
                    return done(err);
                }
            } else {
                console.debug('Reusing branch `'+ targetedBranch +'`');
            }
        }

        // commit changes
        try {
            cmd = execSync("$(which git) add --all ");
        } catch (err) {
            //console.debug('`git add --all`failed ');
            console.error(err.stack||err.message||err);
            return done(err);
        }
        // git commit -m'Packaging version v'+ version
        try {
            var msg = (!branchExists) ? 'New version' : 'Prerelease update'; //+ new Date().format("isoDateTime");
            if (self.git.msg) {
                msg += ' - '+ self.git.msg
            }
            cmd = execSync("$(which git) commit -am'"+ msg +"'");
        } catch (err) {
            if (!/Your branch is up to date|nothing to commit, working tree clean/i.test( err.output.toString() )) {
                console.error(err.stack||err.message||err);
                return done(err);
            }
        }

        if (self.isGitPushNeeded) {
            console.debug('Pushing changes made on branch `'+ targetedBranch +'` to git `origin/'+ targetedBranch +'`');
            // git push origin 010
            try {
                cmd = execSync("$(which git) push origin "+ targetedBranch );
                // set tag version & tag ?
            } catch (err) {
                if (!/Everything up-to-date/i.test( err.output.toString() )) {
                    console.error(err.stack||err.message||err);
                    return done(err);
                }
            }
        }

        done()
    }




    // self.tagVersionIfNeeded = function(done) {
    //     // check if script is on Dry Run !!!
    //     if ( typeof(process.env.npm_config_dry_run) != 'undefined' ) {
    //         // if on dry mode, we want to run post_install to reflect framework versions symlinks
    //         return done()
    //     }

    //     // merge master with targeted branch
    //     console.debug('Merging master with targeted branch: '+ self.targetedBranch +' -> v'+ self.targetedVersion);

    //     // tag version from master

    //     // remove old branch

    //     // checkout back to newly created tag or master ?

    //     done()
    // }


    var restoreSymlinks = function(done) {

        if ( typeof(process.env.npm_config_dry_run) == 'undefined' || !process.env.npm_config_dry_run ) {
            // ignoring for now, after publishing completion
            return
        }
        var archivesPath = _(getUserHome() + '/.gina/archives/framework', true);
        var frameworkPath = _(self.gina +'/framework', true);

        if ( !new _(archivesPath).existsSync() ) {
            return;
        }
        // get current framework version
        var package = require(pack);
        var currentVersion = 'v'+ package.version.replace(/^v/, '');

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
                return done(e)
            }
        }
    }

    self.end = function(done) {

        // restoreSymlinks(done);

        done()
    }



    init()
}

new PrepareVersion()