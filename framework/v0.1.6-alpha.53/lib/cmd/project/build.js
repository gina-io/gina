var fs          = require('fs');

var CmdHelper   = require('./../helper');
var Shell       = lib.Shell;
var console     = lib.logger;

/**
 * Build a project.
 * */
 function Build(opt, cmd) {
    var self    = {}
    , local     = {
        // bundle index while searching or browsing
        b : 0,
        bundle : null,
        bundlePath : null
    };

    var init = function() {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if (!self.bundles.length) {
            return end( new Error('No bundle found in your project `'+ self.projectName +'`') );
        }

        console.debug('Building project `'+ self.projectName +'`');
        buildBundle(0);
    }

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
            local.manifest = JSON.clone(self.projectData);
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

        console.debug('Building bundle `'+ bundle + '@'+ self.projectName + '`');
        buildEnv(self.defaultScope, b, e);

    }

    var buildEnv = function(scope, b, e) {

        if ( e > local.envs.length-1 ) {
            return buildBundle(b+1);
        }

        var bundle          = self.bundles[b]
            , env           = local.envs[e]
        ;

        if ( env === self.projects[self.projectName].dev_env ) {
            return buildEnv(scope, b, e+1);
        }

        var manifest        = local.manifest
            , releasePath   = self.projectLocation +'/'+ manifest.bundles[bundle].releases[scope][env].target
            // , releasePath   = self.projectReleasesPath +'/'+ manifest.bundles[bundle].releases[scope][env].target
            , release       = new _(releasePath, true)
            , srcPath       = _(self.bundlesLocation +'/'+ bundle, true)
        ;

        console.debug('Building bundle env `'+ env +'` for `'+ bundle + '@'+ self.projectName + '`');

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
                console.debug('Linking node_modules to from `'+ internalNodeModulesPathObj.toString() +'` to `'+ destination +'/node_modules' +'`');
                internalNodeModulesPathObj.symlinkSync(_(destination +'/node_modules', true));
            }
            internalNodeModulesPathObj = null;

            buildEnv(scope, b, e+1);
        })
    }

    var end = function(err) {
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