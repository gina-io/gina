/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2022 Rhinostone <contact@gina.io>
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
pack =  (isWin32()) ? pack.replace(/\//g, '\\') : pack;

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
    var self    = {};

    var init = function() {
        self.isWin32 = isWin32();
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
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(-1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
        } else {
            process.exit(0);
        }
    }


    self.getSelectedVersion = async function(done) {
        var homeDir = getUserHome() || null;

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
        self.selectedVersion = selectedVersion;
        var targetedVersion = package.version.replace(/^v/, '');
        self.targetedVersion = targetedVersion;

        console.debug('selected version : ', selectedVersion);
        console.debug('targeted version : ', targetedVersion);

        // setting up requirements
        var shortVersion = selectedVersion.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        var settingsConfigPath  = ginaHomeDir+'/'+shortVersion+'/settings.json';
        var settingsConfig      = require(settingsConfigPath);
        var ginaPath            = settingsConfig.dir;
        self.ginaPath = ginaPath;

        var frameworkPath       = ginaPath +'/framework/v'+selectedVersion;
        self.frameworkPath      = frameworkPath;
        helpers     = require(frameworkPath +'/helpers');
        lib         = require(frameworkPath +'/lib');

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

        var destination = _(ginaHomeDir +'/archives/framework/v'+selectedVersion, true);
        if ( new _(destination).existsSync() ) {
            new _(destination).rmSync();
        }
        var err = false;

        // since we cannot yet promissify directly PathObject.cp()
        var f = function(destination, cb) {
            frameworkPathObj.cp(destination, cb);
        };
        await promisify(f)(destination)
            .catch( function onCopyError(_err) {
                err = _err;
            })
            .then( function onCopy(_destination) {
                console.debug('Copy to '+ _destination +': done');
            });

        if (err) {
            throw err;
        }

        // rename folder version
        destination = _(ginaPath +'/framework/v'+targetedVersion, true);
        frameworkPathObj.renameSync(destination);


        // updating requirements
        self.selectedVersion = targetedVersion;
        self.frameworkPath = frameworkPath = ginaPath +'/framework/v'+targetedVersion;
        helpers             = require(frameworkPath +'/helpers');
        lib                 = require(frameworkPath +'/lib');

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
            console.info('frameworkPath: ', frameworkPath);
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

    self.pushChangesToGit = function(done) {

        var cmd = null;
        var version = self.selectedVersion.replace(/^[a-z]+/ig, '');

        // getting current branch
        // git rev-parse --abbrev-ref HEAD
        // => 010
        var currentBranch = null;
        try {
            currentBranch = execSync("git rev-parse --abbrev-ref HEAD")
                            .toString()
                            .replace(/(\n|\r|\t)/g, '');
        } catch (err) {
            // nothing to do
            return done( new Error('[GIT] No branch selected') )
        }


        // create new branch if needed
        // e.g: 0.1.0-alpha.1 -> 010-alpha1
        var targetedBranch = version.replace(/\./g, '');
        self.targetedBranch = targetedBranch;

        console.debug('[GIT] Current branch: '+ currentBranch);
        console.debug('[GIT] Targeted branch: '+ targetedBranch);


        // check if targeted branch exists
        // git rev-parse --verify 011
        var branchExists = null;
        try {
            branchExists = execSync("git rev-parse --verify "+ targetedBranch)
                            .toString()
                            .replace(/(\n|\r|\t)/g, '');
        } catch (err) {
            // nothing to do
        }

        if (!branchExists) {
            console.debug('No existing branch found, creating a new one !');
            try {
                execSync("git checkout -b "+ targetedBranch);
                // pushing to new branch
                console.debug('setting up remote branch `'+ targetedBranch +'` to git ...');
                execSync("git push --set-upstream origin "+ targetedBranch);
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
                    cmd = execSync("git checkout "+ targetedBranch);
                } catch (err) {
                    console.error(err.stack||err.message||err);
                    return done(err);
                }
            } else {
                console.debug('Reusing branch `'+ targetedBranch +'`');
            }
        }


        // git add --all
        try {
            cmd = execSync("git add --all ");
        } catch (err) {
            //console.debug('`git add --all`failed ');
            console.error(err.stack||err.message||err);
            return done(err);
        }
        // git commit -m'Packaging version v'+ version
        try {
            var msg = (!branchExists) ? 'New version' : 'Prerelease update - '+ new Date().format("isoDateTime");
            cmd = execSync("git commit -am'"+ msg +"'");
        } catch (err) {
            console.error(err.stack||err.message||err);
            return done(err);
        }

        console.debug('Pushing changes made on branch `'+ targetedBranch +'` to git `origin/'+ targetedBranch +'`');
        // git push origin 010
        try {
            cmd = execSync("git push origin "+ targetedBranch );
        } catch (err) {
            //console.error(err.stack||err.message||err);
            //return done(err);
        }

        // check if script is on Dry Run in order to restore symlinks
        if ( typeof(process.env.npm_config_dry_run) != 'undefined' ) {

        }

        done()
    }

    // self.tagVersionIfNeeded = function(done) {


    //     // Making sure that we are on the right branch
    //     try {
    //         var msg = 'Releasing v'+ self.targetedVersion;
    //         cmd = execSync("git checkout "+ self.targetedBranch );
    //     } catch (err) {
    //         console.error(err.stack||err.message||err);
    //         return done(err);
    //     }

    //     // merge master with targeted branch
    //     // git checkout master
    //     // git merge 011-alpha1 `self.targetedBranch`

    //     console.debug('Merging master with targeted branch: '+ self.targetedBranch +' -> v'+ self.targetedVersion);

    //     // tag version from master
    //     try {
    //         var msg = 'Releasing v'+ self.targetedVersion;
    //         cmd = execSync("git commit -am'"+ msg +"'");
    //     } catch (err) {
    //         console.error(err.stack||err.message||err);
    //         return done(err);
    //     }

    //     // remove old branch

    //     // checkout back to newly created tag or master ?

    //     done()
    // }



    init()
}

new PrepareVersion()