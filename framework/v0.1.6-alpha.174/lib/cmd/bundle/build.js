var fs          = require('fs');
var execSync    = require('child_process').execSync;
var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * Build a bundle.
 * To debug this part: gina bundle:build <bundle> @<project> --env=prod --scope=local --inspect-gina
 * */
function Build(opt, cmd) {
    var self    = {}
        , local     = {
            // bundle index while searching or browsing
            b : 0,
            bundle : null,
            bundlePath : null
        }
    ;
    var globalBuildScripts = null;

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if ( typeof(self.projects[self.projectName].path) == 'undefined' ) {
            return end( new Error('project path not defined in ~/.gina/projects.json for [ '+ self.projectName + ' ]') );
        }

        if (!isDefined('project', self.projectName)) {
            return end( new Error('Missing argument @<project_name>'))
        }


        if (!self.bundles.length) {
            return end( new Error('No bundle found in your project `'+ self.projectName +'`') );
        }


        if (!isDefined('scope', process.env.NODE_SCOPE)) {
            if ( self.scopes.length > 0) {
                return end( 'Missing argument: --scope=<scope>');
            }
            return end( '[' + process.env.NODE_SCOPE +'] is not an existing scope.');
        }


        if (!isDefined('env', process.env.NODE_ENV)) {
            if ( self.envs.length > 0) {
                return end( 'Missing argument: --env=<env>');
            }
            return end( '[' + process.env.NODE_ENV +'] is not an existing env.');
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


        console.debug('[build] Building bundle `'+ self.projectName +'`');
        buildBundle(0);
    };


    var buildBundle = function(b, e) {
        if ( b > self.bundles.length-1 ) {
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
            return end('Bundle [ '+ self.bundles[b-1] +' ] built with success')
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
                    // Skipping defaut dev env
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

            self.projectData.bundles[bundle] = merge(self.projectData.bundles[bundle], local.manifest.bundles[bundle], true);
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

    var end = function (output, type, messageOnly) {



        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
                if ( messageOnly && type != 'log') {
                    console.log(output);
                }
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }

    init(opt)
}
module.exports = Build;