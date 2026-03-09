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


var scriptPath  = __dirname;
var ginaPath    = (scriptPath.replace(/\\/g, '/')).replace('/script', '');
var help        = require(ginaPath + '/utils/helper.js');
var pack        = ginaPath + '/package.json';
pack =  (isWin32()) ? pack.replace(/\//g, '\\') : pack;

var helpers     = null;
var lib         = null;
/**
 * PostPublish constructor
 *
 * NB.:
 *  This script can only be executed on Mac OS X or on Linux distributions
 *
 * @constructor
 * */
function PostPublish() {
    var self    = {
        isWin32: isWin32()
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
        if (!lib) {
            var _version = requireJSON(_(pack, true)).version;
            lib = require(ginaPath + '/framework/v' + _version + '/lib');
        }
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
            eval('async function on'+functName+'(){ await promisify('+ funct + ')().catch(function(e){ console.error(e.toString()); process.exit(1);}).then(function(){ begin('+(i+1)+')});}; on'+functName+'();'); // jshint ignore:line
        } else {
            process.exit(0);
        }
    }



    var restoreSymlinks = function(done) {

        if ( typeof(process.env.npm_config_dry_run) == 'undefined' || !process.env.npm_config_dry_run ) {
            // ignoring for --dry-run
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

    self.bumpVersion = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        var packObj = requireJSON(_(pack, true));
        var currentVersion = packObj.version;

        // Alpha: increment trailing number  "0.1.6-alpha.177" -> "0.1.6-alpha.178"
        // Stable: bump patch, start new alpha cycle "0.1.6" -> "0.1.7-alpha.1"
        var newVersion;
        if (/alpha\.\d+$/.test(currentVersion)) {
            newVersion = currentVersion.replace(/(\d+)$/, function(_match, n) {
                return String(parseInt(n, 10) + 1);
            });
        } else {
            newVersion = currentVersion.replace(/(\d+)$/, function(_match, n) {
                return String(parseInt(n, 10) + 1);
            }) + '-alpha.1';
        }

        console.info('Bumping version: ' + currentVersion + ' -> ' + newVersion);

        // Rename the framework directory
        var oldVersionDir = _(self.gina + '/framework/v' + currentVersion, true);
        var newVersionDir = _(self.gina + '/framework/v' + newVersion, true);
        var oldVersionDirObj = new _(oldVersionDir);
        if (oldVersionDirObj.existsSync()) {
            oldVersionDirObj.renameSync(newVersionDir);
        }

        // Update package.json
        packObj.version = newVersion;
        packObj.main = './framework/v' + newVersion + '/core/gna';
        new _(pack, true).rmSync();
        lib.generator.createFileFromDataSync(JSON.stringify(packObj, null, 2), pack);

        // Update ~/.gina/main.json and ~/.gina/{shortVersion}/settings.json
        var shortVersion = newVersion.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        var ginaHomeDir = getUserHome() + '/.gina';
        var mainConfigPath = _(ginaHomeDir + '/main.json', true);
        var settingsConfigPath = _(ginaHomeDir + '/' + shortVersion + '/settings.json', true);

        try {
            var mainConfig = requireJSON(mainConfigPath);
            mainConfig.def_framework = newVersion;
            if (mainConfig.frameworks[shortVersion].indexOf(newVersion) < 0) {
                mainConfig.frameworks[shortVersion].push(newVersion);
            }
            new _(mainConfigPath).rmSync();
            lib.generator.createFileFromDataSync(JSON.stringify(mainConfig, null, 2), mainConfigPath);
        } catch (e) {
            console.warn('Could not update ' + mainConfigPath + ': ' + e.message);
        }

        try {
            var settingsConfig = requireJSON(settingsConfigPath);
            settingsConfig.version = newVersion;
            settingsConfig.def_framework = newVersion;
            new _(settingsConfigPath).rmSync();
            lib.generator.createFileFromDataSync(JSON.stringify(settingsConfig, null, 2), settingsConfigPath);
        } catch (e) {
            console.warn('Could not update ' + settingsConfigPath + ': ' + e.message);
        }

        // Commit and push to develop
        var initialDir = process.cwd();
        process.chdir(self.gina);
        try {
            execSync('$(which git) add --all');
            execSync("$(which git) commit -am'Version bump to " + newVersion + "'");
            execSync('$(which git) push origin develop');
        } catch (err) {
            var errOut = err.output ? err.output.toString() : (err.message || '');
            if (!/nothing to commit/i.test(errOut)) {
                process.chdir(initialDir);
                return done(err);
            }
        }
        process.chdir(initialDir);

        done();
    }

    self.end = function(done) {

        restoreSymlinks(done);
        done()
    }



    init()
}

new PostPublish()