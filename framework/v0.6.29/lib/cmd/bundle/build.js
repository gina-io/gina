var fs          = require('fs');
var execSync    = require('child_process').execSync;
var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * @module gina/lib/cmd/bundle/build
 */
/**
 * Builds a bundle's release artefacts for a given project, scope, and env.
 * Runs optional user-defined `prepare` and `postbuild` hook scripts defined
 * in `manifest.json#buildScripts`.
 *
 * Usage:
 *  gina bundle:build <bundle_name> @<project_name> --env=prod --scope=local
 *  gina bundle:build <bundle_name> @<project_name> --env=prod --scope=local --skip-unchanged
 *  gina bundle:build <bundle_name> @<project_name> --env=prod --scope=local --skip-unchanged --dry-run [--format=json]
 *
 * To debug: gina bundle:build <bundle> @<project> --env=prod --scope=local --inspect-gina
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
        }
    ;
    var globalBuildScripts = null;

    /**
     * Validates options, runs the optional prepare script, and starts the build.
     *
     * @inner
     * @private
     */
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

        // --skip-unchanged (opt-in): flag surface. `--force` keeps the
        // signature + marker machinery on but always rebuilds; `--dry-run`
        // resolves every release's decision without touching the tree, the
        // manifest or the hooks; `--format=json` prints ONE envelope.
        var p = self.params || {};
        local.skipUnchanged = !!p['skip-unchanged'];
        local.force         = !!p['force'];
        local.dryRun        = !!p['dry-run'];
        local.format        = p['format'] || null;
        local.signatures    = {};   // bundle → buildSignature() result, once per bundle
        local.decisions     = [];   // one record per (bundle, env) release this run resolved

        // #B373 — per-scope deployment. `bundles[<name>].scopes` is an optional
        // allow-list (absent = every scope). This verb targets ONE bundle by name,
        // so an excluded target is an EXPLICIT ask for something the manifest says
        // is not deployed here — refuse by name rather than silently producing no
        // artifact, which on a deploy script would read as success.
        var _buildTargets = ( self.bundles || [] ).slice();
        for (let _b = 0, _bLen = _buildTargets.length; _b < _bLen; ++_b) {
            let _target = _buildTargets[_b]
                , _entry = local.manifest.bundles[_target]
            ;
            if ( !_entry ) {
                continue;
            }
            if (
                typeof(_entry.scopes) != 'undefined' && _entry.scopes !== null
                && !Array.isArray(_entry.scopes)
            ) {
                return end( new Error('[ manifest ] `bundles.'+ _target +'.scopes` must be an array of scope names (got '+ typeof(_entry.scopes) +'). Remove the key to deploy `'+ _target +'` in every scope, or list the scopes it belongs to.') );
            }
            if ( Array.isArray(_entry.scopes) && _entry.scopes.indexOf(process.env.NODE_SCOPE) < 0 ) {
                return end( new Error('Cannot build `'+ _target +'` for scope `'+ process.env.NODE_SCOPE +'`: the bundle is not deployed there. '
                    + '`bundles.'+ _target +'.scopes` in manifest.json declares '
                    + ( _entry.scopes.length ? '`'+ _entry.scopes.join('`, `') +'`' : 'no scope at all' )
                    + '. Add `'+ process.env.NODE_SCOPE +'` to that list to build it here.') );
            }
        }

        globalBuildScripts = ( typeof(local.manifest.buildScripts) != 'undefined' ) ? local.manifest.buildScripts : null;

        // User Pre build
        if (
            !local.dryRun
            && globalBuildScripts
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


    /**
     * Iterates bundles; updates manifest and delegates to buildEnv per scope/env.
     * Runs the postbuild hook after the last bundle completes.
     *
     * @inner
     * @private
     * @param {number} b - Bundle index in self.bundles
     * @param {number} [e] - Env index (reset to 0 internally)
     */
    var buildBundle = function(b, e) {
        if ( b > self.bundles.length-1 ) {
            // --dry-run: nothing was written and no hook runs — report and leave.
            if ( local.dryRun ) {
                return report();
            }
            // User Post build
            if (
                globalBuildScripts
                && typeof(globalBuildScripts.postbuild) != 'undefined'
                && fs.existsSync( self.projectLocation +'/'+ globalBuildScripts.postbuild.split(' ').slice(-1)[0])
            ) {
                try {
                    var cmd = globalBuildScripts.postbuild +' --env='+process.env.NODE_ENV+' --scope='+ process.env.NODE_SCOPE +' --bundles='+self.bundles.toString();
                    // cloning it
                    let currentEnv = { ...process.env };
                    currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
                    // --skip-unchanged hook signal: the bundles whose EVERY built
                    // env was skipped, and whether that is all of them — so a
                    // postbuild that bakes its own outputs can skip its own work.
                    if ( local.skipUnchanged ) {
                        let skipSignal = skippedBundles();
                        currentEnv['GINA_BUILD_SKIPPED_BUNDLES'] = skipSignal.bundles.join(',');
                        currentEnv['GINA_BUILD_SKIPPED_ALL']     = skipSignal.all ? '1' : '0';
                    }
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
            if ( isJsonFormat() ) {
                return report();
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
                // #B373 — do not seed a scope the bundle opts out of. This loop walks
                // EVERY project scope (not just --scope), so without the filter it
                // re-creates the release entries the allow-list exists to remove, and
                // the opt-out silently regrows on the next build.
                if (
                    Array.isArray(local.manifest.bundles[bundle].scopes)
                    && local.manifest.bundles[bundle].scopes.indexOf(scope) < 0
                ) {
                    continue;
                }
                if ( typeof(local.manifest.bundles[bundle].releases[scope]) == 'undefined' ) {
                    local.manifest.bundles[bundle].releases[scope] = {}
                }

                for (let e = 0, eLen = local.envs.length; e<eLen; e++) {
                    let env = local.envs[e];
                    // Skipping defaut dev env
                    // if ( env === self.projects[self.projectName].dev_env ) {
                    //     continue;
                    // }

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

            // #RW1 — stamp the source-tree fingerprint on the release records this
            // run will build (defaultScope only — buildEnv() builds that scope).
            // Taken at build START: an edit racing the src → release copy makes the
            // boot-time recompute differ from the stamp, which correctly reads as
            // stale (a stamp taken after the copy would match the post-edit mtimes
            // while the release holds pre-edit bytes — a false fresh). Records that
            // do not exist are left untouched. Never fatal: a stamp failure must
            // not break the build.
            try {
                var fpResult = lib.releaseWatch.fingerprintTree( _(self.bundlesLocation +'/'+ bundle, true) );
                if ( fpResult && fpResult.hash ) {
                    var fpBuiltAt = new Date().toISOString();
                    for (let f = 0, fLen = local.envs.length; f < fLen; f++) {
                        let fpEnv = local.envs[f];
                        let fpRec = ( typeof(local.manifest.bundles[bundle].releases[self.defaultScope]) != 'undefined' )
                            ? local.manifest.bundles[bundle].releases[self.defaultScope][fpEnv]
                            : null;
                        if ( fpRec && fpRec.target ) {
                            fpRec.fingerprint   = fpResult.hash;
                            fpRec.builtAt       = fpBuiltAt;
                            fpRec.fpSpec        = fpResult.spec;
                        }
                    }
                }
            } catch (fpErr) {
                console.warn('[build] could not stamp the release fingerprint: '+ (fpErr.stack || fpErr.message || fpErr));
            }

            self.projectData.bundles[bundle] = merge(self.projectData.bundles[bundle], local.manifest.bundles[bundle], true);
            if ( !local.dryRun ) {
                lib.generator.createFileFromDataSync(
                    self.projectData,
                    self.projectManifestPath
                );
            }

        } catch(err) {
            return end(err)
        }

        // --skip-unchanged: ONE content signature per bundle (the source is the
        // same for every env). The first readable marker among this bundle's
        // release records seeds the stat fast path; none just means every file
        // is read once. Never fatal: with no signature every env rebuilds.
        local.signatures[bundle] = null;
        if ( local.skipUnchanged ) {
            try {
                local.signatures[bundle] = lib.releaseWatch.buildSignature(
                    _(self.bundlesLocation +'/'+ bundle, true),
                    { prior: findPriorMarker(bundle) }
                );
                if ( local.signatures[bundle] ) {
                    console.info('[build] --skip-unchanged: signed `'+ bundle +'` — '+ local.signatures[bundle].fileCount +' entries, '+ local.signatures[bundle].read +' read, '+ local.signatures[bundle].reused +' reused from the prior marker');
                }
            } catch (sigErr) {
                console.warn('[build] could not evaluate --skip-unchanged for `'+ bundle +'`: '+ (sigErr.stack || sigErr.message || sigErr) +' — rebuilding');
            }
        }

        console.debug('[build] Building bundle `'+ bundle + '@'+ self.projectName + '`');
        buildEnv(self.defaultScope, b, e);

    }

    /**
     * Copies bundle source to a release path for one scope/env combination.
     * Symlinks the project node_modules into the release directory.
     *
     * @inner
     * @private
     * @param {string} scope - Scope name
     * @param {number} b - Bundle index
     * @param {number} e - Env index in local.envs
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

        // --skip-unchanged: decide BEFORE the wipe. Every input but the one
        // verified match rebuilds (lib/release-watch decideBuildAction); the
        // record feeds both the dry-run report and the postbuild signal.
        var target   = manifest.bundles[bundle].releases[scope][env].target;
        var decision = decideRelease(bundle, release, releasePath);
        local.decisions.push({
            bundle    : bundle,
            env       : env,
            target    : target,
            action    : decision.action,
            reason    : decision.reason,
            changed   : decision.changed || [],
            fileCount : ( typeof(decision.fileCount) != 'undefined' ) ? decision.fileCount : null,
            builtAt   : decision.builtAt || null
        });
        if ( local.dryRun ) {
            return buildEnv(scope, b, e+1);
        }
        if ( decision.action === 'skip' ) {
            console.info('[build] release `'+ target +'` unchanged since '+ decision.builtAt +' ('+ decision.fileCount +' files) — copy skipped');
            ensureNodeModulesLink(releasePath);
            return buildEnv(scope, b, e+1);
        }

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

            // --skip-unchanged: record what was just copied — AFTER the link,
            // BEFORE the next env. A copy killed mid-way leaves NO marker (the
            // wipe removed the old one), so a partial release always rebuilds.
            if ( local.skipUnchanged && local.signatures[bundle] ) {
                try {
                    lib.releaseWatch.writeBuildMarker(destination, local.signatures[bundle], { ginaVersion: GINA_VERSION });
                } catch (markerErr) {
                    console.warn('[build] could not write the build marker for `'+ target +'`: '+ (markerErr.stack || markerErr.message || markerErr));
                }
            }

            buildEnv(scope, b, e+1);
        })
    }

    /**
     * Finds the fast-path prior for a bundle: the first readable build marker
     * among its release records under the built scope. `null` when none —
     * the signature then reads every file once.
     *
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @returns {object|null} A marker as returned by lib.releaseWatch.readBuildMarker()
     */
    var findPriorMarker = function(bundle) {
        var records = ( typeof(local.manifest.bundles[bundle].releases[self.defaultScope]) != 'undefined' )
            ? local.manifest.bundles[bundle].releases[self.defaultScope]
            : {};
        for (let f = 0, fLen = local.envs.length; f < fLen; f++) {
            let record = records[local.envs[f]];
            if ( !record || !record.target ) {
                continue;
            }
            let marker = lib.releaseWatch.readBuildMarker(self.projectLocation +'/'+ record.target);
            if ( marker ) {
                return marker;
            }
        }
        return null;
    };

    /**
     * Resolves one release's action. Without the flag every release rebuilds
     * (and nothing is logged about it). With it, the decision is the pure
     * lib.releaseWatch.decideBuildAction() over this env's marker, the
     * release's presence and the bundle's signature; any exception on the
     * way is a warn + rebuild, never a skip and never fatal.
     *
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @param {object} release - PathObject of the release directory
     * @param {string} releasePath - Absolute release path
     * @returns {{action: string, reason: string, changed: string[], builtAt: (string|null), fileCount: (number|null)}}
     */
    var decideRelease = function(bundle, release, releasePath) {
        if ( !local.skipUnchanged ) {
            return { action: 'rebuild', reason: '--skip-unchanged not given' };
        }
        try {
            return lib.releaseWatch.decideBuildAction({
                force         : local.force,
                marker        : lib.releaseWatch.readBuildMarker(releasePath),
                releaseExists : release.existsSync(),
                signature     : local.signatures[bundle]
            });
        } catch (decideErr) {
            console.warn('[build] could not evaluate --skip-unchanged for `'+ bundle +'`: '+ (decideErr.stack || decideErr.message || decideErr) +' — rebuilding');
            return { action: 'rebuild', reason: 'evaluation failed' };
        }
    };

    /**
     * Skip path: the release keeps the node_modules link from the build it
     * was copied by; re-create it only when it is absent. Never a blind
     * symlinkSync — that throws EEXIST on the link the skip preserves.
     *
     * @inner
     * @private
     * @param {string} releasePath - Absolute release path
     */
    var ensureNodeModulesLink = function(releasePath) {
        var internalNodeModulesPathObj = new _( self.projectLocation +'/node_modules', true);
        if ( !internalNodeModulesPathObj.existsSync() ) {
            return;
        }
        var linkPath = _(releasePath +'/node_modules', true);
        var present  = true;
        try {
            fs.lstatSync(linkPath);
        } catch (absentErr) {
            present = false;
        }
        if ( !present ) {
            console.debug('[build] Linking node_modules from `'+ internalNodeModulesPathObj.toString() +'` to `'+ linkPath +'`');
            internalNodeModulesPathObj.symlinkSync(linkPath);
        }
    };

    /**
     * Postbuild hook signal: the bundles whose EVERY resolved env was skipped,
     * and whether that is every bundle that had a release to resolve.
     *
     * @inner
     * @private
     * @returns {{bundles: string[], all: boolean}}
     */
    var skippedBundles = function() {
        var verdict = {};
        for (let i = 0, len = local.decisions.length; i < len; i++) {
            let d = local.decisions[i];
            if ( typeof(verdict[d.bundle]) == 'undefined' ) {
                verdict[d.bundle] = true;
            }
            if ( d.action !== 'skip' ) {
                verdict[d.bundle] = false;
            }
        }
        var resolved = Object.keys(verdict);
        var bundles  = self.bundles.filter(function(name) { return verdict[name] === true; });
        return {
            bundles : bundles,
            all     : ( resolved.length > 0 && bundles.length === resolved.length )
        };
    };

    /**
     * Whether `--format=json` was given.
     *
     * @inner
     * @private
     * @returns {boolean}
     */
    var isJsonFormat = function() {
        return /^json$/i.test(String(local.format || ''));
    };

    /**
     * Prints the per-release resolution and exits 0: ONE
     * `{ project, scope, dryRun, skipUnchanged, releases }` envelope under
     * `--format=json` (a sync write — the process exits right after), else
     * the `[ dry-run ] would skip | would rebuild …` lines. Both read the
     * same `local.decisions` the build itself acted on. The text form is
     * only reached under `--dry-run`; a real text run ends through end().
     *
     * @inner
     * @private
     */
    var report = function() {
        if ( isJsonFormat() ) {
            var envelope = {
                project       : self.projectName,
                scope         : self.defaultScope,
                dryRun        : local.dryRun,
                skipUnchanged : local.skipUnchanged,
                releases      : local.decisions
            };
            fs.writeSync(1, JSON.stringify(envelope) + '\n');
            return process.exit(0);
        }
        for (let i = 0, len = local.decisions.length; i < len; i++) {
            let d = local.decisions[i];
            if ( d.action === 'skip' ) {
                console.log('[ dry-run ] would skip '+ d.target +' (unchanged since '+ d.builtAt +', '+ d.fileCount +' files)');
                continue;
            }
            console.log('[ dry-run ] would rebuild '+ d.target +': '+ d.reason);
            for (let c = 0; c < d.changed.length && c < 10; c++) {
                console.log('    - '+ d.changed[c]);
            }
            if ( d.changed.length > 10 ) {
                console.log('    … and '+ (d.changed.length - 10) +' more');
            }
        }
        console.log('[ dry-run ] nothing written');
        return process.exit(0);
    };

    /**
     * Prints optional output and exits the process.
     *
     * @inner
     * @private
     * @param {string|Error} [output] - Message or error to display
     * @param {string} [type] - console method to call (e.g. 'error')
     * @param {boolean} [messageOnly] - When true, print only the message (not the stack)
     */
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