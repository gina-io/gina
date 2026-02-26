var fs          = require('fs');
var execSync    = require('child_process').execSync;
var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * @module gina/lib/cmd/project/build
 */
/**
 * Builds all bundles of a project for the given scope and environment.
 * Runs optional `prepare` and `postbuild` hook scripts from manifest.json#buildScripts.
 *
 * Usage:
 *  gina project:build @<project> --env=prod --scope=local
 *  gina project:build @<project> --env=prod --scope=local --inspect-gina
 *
 * @class Build
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Build(opt, cmd) {
    var self    = {}
    , local     = {
        // bundle index while searching or browsing
        b : 0,
        bundle : null,
        bundlePath : null
    };
    var globalBuildScripts = null;

    /**
     * Validates scope and env, loads the manifest, runs the optional prepare hook,
     * and starts the bundle build loop.
     *
     * @inner
     * @private
     */
    var init = function() {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if (!self.bundles.length) {
            return end( new Error('No bundle found in your project `'+ self.projectName +'`') );
        }

        process.env.NODE_SCOPE = process.env.NODE_SCOPE || self.projects[self.projectName].def_scope;
        if (!isDefined('scope', process.env.NODE_SCOPE)) {
            if ( self.envs.length == 0) {
                console.error('Missing argument <scope>');
            } else if  (!isDefined('scope', process.env.NODE_ENV) ) {
                console.error('[' + process.env.NODE_ENV +'] is not an existing scope.');
            } else {
                console.error('Missing argument: --scope=<scope>');
            }

            process.exit(1)
        }

        process.env.NODE_ENV = process.env.NODE_ENV || self.projects[self.projectName].def_env;
        if (!isDefined('env', process.env.NODE_ENV)) {
            if ( self.envs.length == 0) {
                console.error('Missing argument <env>');
            } else if  (!isDefined('env', process.env.NODE_ENV) ) {
                console.error('[' + process.env.NODE_ENV +'] is not an existing environement.');
            } else {
                console.error('Missing argument: --env=<env>');
            }

            process.exit(1)
        }

        // Getting manifest
        local.manifest = JSON.clone(self.projectData);

        globalBuildScripts = ( typeof(local.manifest.buildScripts) != 'undefined' ) ? local.manifest.buildScripts : null;

        // User Pre build
        if (
            globalBuildScripts
            && typeof(globalBuildScripts.prepare) != 'undefined'
            && fs.existsSync( self.projectLocation +'/'+ globalBuildScripts.prepare.split(' ').slice(-1)[0])
        ) {
            try {
                var cmd = globalBuildScripts.prepare +' --env='+process.env.NODE_ENV+' --scope='+ process.env.NODE_SCOPE;
                let execOptions = {
                    cwd: self.projectLocation,
                    // Inherit stdio to see the debug prompt in the console
                    stdio: 'inherit',
                    // Pass the debug options via the environment variables
                    env: {
                        NODE_OPTIONS: self.nodeParams.join(' ')
                    }
                };
                execSync( cmd , execOptions)
            } catch (buildErr) {
                delete globalBuildScripts.prepare;
            }
        }


        console.debug('[build] Building project `'+ self.projectName +'`');
        buildBundle(0);
    }

    /**
     * Builds one bundle at index `b`, updating its release targets in the manifest,
     * then calls buildEnv to copy source files per environment.
     *
     * @inner
     * @private
     * @param {number} b - Current bundle index into self.bundles
     * @param {number} [e=0] - Current env index into local.envs
     */
    var buildBundle = function(b, e) {
        if ( b > self.bundles.length-1 ) {
            return end()
        }
        if (!e) {
            e = 0;
        }


        var bundle = self.bundles[b];

        local.envs          = self.envs.slice();
        local.scopes        = self.scopes.slice();
        // var releasesPathObj = new _(self.projects[self.projectName].path +'/releases', true);
        try {
            // per scope
            for (let i = 0, len = local.scopes.length; i < len; i++) {
                let scope = local.scopes[i]
                if ( typeof(local.manifest.bundles[bundle].releases[scope]) == 'undefined' ) {
                    local.manifest.bundles[bundle].releases[scope] = {}
                }

                for (let e = 0, eLen = local.envs.length; e<eLen; e++) {
                    let env = local.envs[e];

                    if ( env === self.projects[self.projectName].dev_env ) {
                        continue;
                    }

                    if ( typeof(local.manifest.bundles[bundle].releases[scope][env]) == 'undefined' ) {
                        local.manifest.bundles[bundle].releases[scope][env] = {
                            target: null
                        }
                    }

                    if ( !local.manifest.bundles[bundle].releases[scope][env].target ) {
                        local.manifest.bundles[bundle].releases[scope][env].target = "releases/"+ bundle +"/"+ scope +"/"+ env +"/"+ local.manifest.bundles[bundle].version;
                    }
                }
            }


            self.projectData = local.manifest;
            lib.generator.createFileFromDataSync(
                self.projectData,
                self.projectManifestPath
            );

        } catch(err) {
            return end(err)
        }

        console.debug('[build] Building bundle `'+ bundle + '@'+ self.projectName + '`');
        buildEnv(self.defaultScope, b, e);

    }

    /**
     * Copies the bundle source into the release path for one environment,
     * creates a node_modules symlink, and advances to the next env.
     *
     * @inner
     * @private
     * @param {string} scope - Build scope (e.g. 'local', 'production')
     * @param {number} b - Current bundle index into self.bundles
     * @param {number} e - Current env index into local.envs
     */
    var buildEnv = function(scope, b, e) {
        // For each env
        if ( e > local.envs.length-1 ) {
            return buildBundle(b+1);
        }

        var bundle          = self.bundles[b]
            , env           = local.envs[e]
        ;

        // Skip if not defined in manifest
        if ( typeof(local.manifest.bundles[bundle].releases[scope][env]) == 'undefined' ) {
            return buildEnv(scope, b, e+1);
        }

        var manifest        = local.manifest
            , releasePath   = self.projectLocation +'/'+ manifest.bundles[bundle].releases[scope][env].target
            // , releasePath   = self.projectReleasesPath +'/'+ manifest.bundles[bundle].releases[scope][env].target
            , release       = new _(releasePath, true)
            , srcPath       = _(self.bundlesLocation +'/'+ bundle, true)
        ;

        console.debug('[build] Building bundle env `'+ env +'` for `'+ bundle + '@'+ self.projectName + '`');

        // cleanup
        if (release.existsSync()) {
            release.rmSync()
        }
        new _(srcPath).cp(releasePath, function onCopied(err, destination) {
            if (err) {
                return end(err)
            }

            // creating internal node_modules symlink
            var internalNodeModulesPathObj = new _( self.projectLocation +'/node_modules', true);
            if (internalNodeModulesPathObj.existsSync() ) {
                console.debug('[build] Linking node_modules from `'+ internalNodeModulesPathObj.toString() +'` to `'+ _(destination +'/node_modules', true) +'`');
                internalNodeModulesPathObj.symlinkSync(_(destination +'/node_modules', true));
            }
            internalNodeModulesPathObj = null;

            buildEnv(scope, b, e+1);
        })
    }

    /**
     * Runs the optional postbuild hook script and exits the process.
     * Exits with code 1 on error.
     *
     * @inner
     * @private
     * @param {Error} [err] - Build error; omit on success
     */
    var end = async function(err) {

        // User Post build
        if (
            globalBuildScripts
            && typeof(globalBuildScripts.postbuild) != 'undefined'
            && fs.existsSync( self.projectLocation +'/'+ globalBuildScripts.postbuild.split(' ').slice(-1)[0])
        ) {
            try {
                var cmd = globalBuildScripts.postbuild +' --env='+process.env.NODE_ENV+' --scope='+ process.env.NODE_SCOPE;
                // cloning it
                let currentEnv = { ...process.env };
                currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
                let execOptions = {
                    cwd: self.projectLocation,
                    // Inherit stdio to see the debug prompt in the console
                    stdio: 'inherit',
                    // Pass the debug options via the environment variables
                    env: currentEnv
                };
                execSync( cmd , execOptions);
            } catch (buildErr) {
                delete globalBuildScripts.postbuild;
                return end(buildErr);
            }
        }

        if (err) {
            if (GINA_ENV_IS_DEV) {
                console.error(err.stack);
            } else {
                console.error(err.message);
            }

            return process.exit(1);
        }

        console.log('Project [ '+ self.projectName+' ] built with success');

        return process.exit(0)
    }

    init()

}
module.exports = Build;