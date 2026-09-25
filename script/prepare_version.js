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
        // npm lifecycle scripts receive --tag as npm_config_tag env var, not process.argv
        var npmTag = process.env.npm_config_tag || 'latest';
        if (npmTag !== self.git.tag) {
            self.git.tag = npmTag;
            self.isGitPushNeeded = ( typeof(process.env.npm_config_dry_run) != 'undefined' ) ? false : true;
        }

        var args = process.argv, i = 0, len = args.length;
        for (; i < len; ++i) {
            if ( /^\-\-tag/.test(args[i]) ) {
                // fallback: direct script invocation with --tag
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


    /**
     * Fail-closed gate: abort the release if any local-tool configuration
     * path is present in the working tree (tracked or untracked-not-ignored).
     *
     * `git add --all` runs later in this script (pushChangesToGitIfNeeded)
     * and sweeps every non-ignored path into the release commit. Without
     * this gate, a local configuration directory or file that slips past
     * `.gitignore` (e.g. force-added, or an unignored rename) lands in the
     * release commit and — via the subsequent push — ends up on the public
     * remote.
     *
     * Runs first because it inspects filesystem state only; no dependency
     * on framework helpers or ~/.gina config.
     */
    self.checkNoLocalLeakage = function(done) {
        console.debug('[prepare] Checking for local-tool file leakage ...');

        var PATTERN = /(^|\/)(CLAUDE\.md|\.claude[a-z]*)/i;
        var matches = [];

        var scan = function(label, cmd) {
            var out;
            try {
                out = execSync(cmd).toString();
            } catch (err) {
                throw new Error('[prepare] `' + cmd + '` failed: ' + (err.message || err));
            }
            var lines = out.split('\n');
            for (var i = 0; i < lines.length; i++) {
                if (lines[i] && PATTERN.test(lines[i])) {
                    matches.push(label + ': ' + lines[i]);
                }
            }
        };

        try {
            scan('tracked',   'git ls-files');
            scan('untracked', 'git ls-files --others --exclude-standard');
        } catch (err) {
            return done(err);
        }

        if (matches.length > 0) {
            console.error('[prepare] ERROR: local-tool paths detected — aborting to prevent leak:');
            for (var i = 0; i < matches.length; i++) {
                console.error('  ' + matches[i]);
            }
            console.error('[prepare] Remove or re-ignore these paths before publishing.');
            return done(new Error('local-tool file leakage detected'));
        }

        console.debug('[prepare] OK: no local-tool paths detected.');
        done();
    };

    /**
     * Fail-closed gate: abort the release if any tracked or untracked-not-
     * ignored file contains a private-token pattern (phone, private email,
     * private address, private domain, co-author legal name).
     *
     * Runs after the local-tool path gate and before `getSelectedVersion` so
     * the `git add --all` sweep at `pushChangesToGitIfNeeded` cannot sweep
     * dirty content into a release commit.
     *
     * Mirrors `script/check_no_local_leak.js` (the prepack gate) — both
     * must stay in sync so a leak is caught at either boundary.
     */
    self.checkPrivateTokenLeakage = function(done) {
        console.debug('[prepare] Checking for private-token leakage ...');

        // Private tokens that must not appear in tracked-file contents.
        // Patterns load from `script/.private-tokens.json` (gitignored,
        // maintainer-local). If the sidecar is absent, content-level
        // scanning is a no-op for this gate. The attribution allowlist
        // (`ATTRIBUTION_PATHS`) lives in `_load_private_tokens.js`
        // alongside the loader — both shipping scanners use the default
        // so the regex stays in one place.
        var TOKENS = require('./_load_private_tokens')();

        var TEXT_EXT = /\.(md|txt|json|js|mjs|cjs|ts|tsx|jsx|html|htm|css|sass|scss|less|sh|bash|zsh|yaml|yml|xml|svg|csv|mapping|conf|ini|toml|env|template)$/i;
        var TEXT_BASENAME = /^(AUTHORS|LICENSE|COPYING|CHANGELOG|README|NOTICE|CONTRIBUTING|GOVERNANCE|Makefile|\.npmignore|\.gitignore|\.eslintrc|\.editorconfig)(\.[^.]+)?$/;
        var MAX_SCAN_BYTES = 2 * 1024 * 1024;

        // Scanner scripts contain the token patterns themselves — skip them to
        // avoid self-matches. Mirrors `SELF_EXCLUDE` in check_no_local_leak.js.
        var SELF_EXCLUDE = {
            'script/check_no_local_leak.js': true,
            'script/prepare_version.js':     true
        };

        var listFiles = function(cmd) {
            var out;
            try {
                out = execSync(cmd, { maxBuffer: 64 * 1024 * 1024 }).toString();
            } catch (err) {
                throw new Error('[prepare] `' + cmd + '` failed: ' + (err.message || err));
            }
            return out.split('\n').filter(function(line) { return line; });
        };

        var isTextPath = function(p) {
            if (TEXT_EXT.test(p)) return true;
            var base = p.split('/').pop();
            return TEXT_BASENAME.test(base);
        };

        var scanFile = function(p) {
            var stat;
            try { stat = fs.statSync(p); } catch (e) { return []; }
            if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return [];
            var content;
            try { content = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
            var hits = [];
            for (var i = 0; i < TOKENS.length; i++) {
                if (TOKENS[i].allowIn && TOKENS[i].allowIn.test(p)) continue;
                if (TOKENS[i].pattern.test(content)) {
                    hits.push(TOKENS[i].name);
                }
            }
            return hits;
        };

        var files;
        try {
            files = listFiles('git ls-files')
                .concat(listFiles('git ls-files --others --exclude-standard'));
        } catch (err) {
            return done(err);
        }

        var matches = [];
        for (var i = 0; i < files.length; i++) {
            var p = files[i];
            if (!isTextPath(p)) continue;
            if (SELF_EXCLUDE[p]) continue;
            var hits = scanFile(p);
            for (var j = 0; j < hits.length; j++) {
                matches.push(p + ' — ' + hits[j]);
            }
        }

        if (matches.length > 0) {
            console.error('[prepare] ERROR: Private tokens detected — aborting to prevent leak:');
            for (var k = 0; k < matches.length; k++) {
                console.error('  ' + matches[k]);
            }
            console.error('[prepare] Scrub these files before publishing.');
            return done(new Error('Private-token leakage detected'));
        }

        console.debug('[prepare] OK: no private tokens detected.');
        done();
    };

    /**
     * Fail-closed gate: abort a stable publish if README.md has not been
     * touched since the previous stable tag. Skips on alpha publishes
     * (intermediate cuts where the "What's in <stable>" heading is
     * allowed to be drafted ahead).
     *
     * The actual logic lives in `script/check_readme_freshness.js` so it
     * can be unit-tested with an injected git driver. This wrapper just
     * applies the alpha skip and converts the result into the
     * gate-callback shape used by `begin()`.
     *
     * Background: three consecutive stable cuts (v0.3.7 → v0.3.8 →
     * v0.3.9) shipped to npm with a stale "## What's in 0.3.7" heading
     * and outdated `@rhinostone/swig` version because the manual grep
     * step in the stable-release checklist was silently skipped each
     * time. Manual gates fail; this enforces the rule.
     */
    self.checkReadmeFreshness = function(done) {
        if (self.git.tag === 'alpha') {
            console.debug('[prepare] Skipping README freshness gate (alpha publish).');
            return done();
        }

        console.debug('[prepare] Checking README.md freshness for stable publish ...');

        var checker = require('./check_readme_freshness');
        var result;
        try {
            result = checker.check({ cwd: ginaPath });
        } catch (err) {
            return done(err);
        }

        if (result.ok) {
            if (result.reason === 'no-previous-stable-tag') {
                console.debug('[prepare] OK: no previous stable tag — first stable publish?');
            } else {
                console.debug('[prepare] OK: README.md has ' + result.commitsSinceTag +
                    ' commit(s) since ' + result.prevStableTag + '.');
            }
            return done();
        }

        var pack = {};
        try { pack = require(ginaPath + '/package.json'); } catch (e) { /* tolerated */ }

        console.error('[prepare] ERROR: README.md not touched since previous stable tag — aborting publish.');
        console.error('  Previous stable tag : ' + (result.prevStableTag || '<none>'));
        console.error('  Targeted version    : ' + (pack.version || '<unknown>'));
        console.error('  Failure reason      : ' + result.reason);
        console.error('');
        console.error('  README.md typically needs the following edits before a stable publish:');
        console.error('    - "## What\'s in <version>" heading + bullets describing what shipped');
        console.error('    - "@rhinostone/swig <X>" line in the Features table if swig was bumped');
        console.error('    - Badge versions or other surfaces that drift across releases');
        console.error('');
        console.error('  Touch README.md (even a one-line patch-release note for hotfixes),');
        console.error('  commit on develop, and re-run npm publish.');
        return done(new Error('README.md untouched since previous stable tag (' + (result.prevStableTag || 'unknown') + ')'));
    };

    /**
     * Fail-closed gate: abort a stable publish when ROADMAP.md
     * contradicts the version being released — an open (📋) row that
     * still references the exact version about to ship, or a done (✅)
     * row labelled with a version newer than it. A missing `X.Y.Z ✅`
     * timeline row is surfaced as a warning only.
     *
     * The actual logic lives in `script/check_roadmap_consistency.js`
     * (pure `check()` over injected content) so it can be unit-tested
     * without a filesystem. This wrapper resolves the live ROADMAP.md +
     * package.json version and converts the result into the
     * gate-callback shape used by `begin()`.
     *
     * Background: a roadmap-accuracy sweep (2026-06-12) found ✅ rows
     * carrying stale TARGET versions instead of actual ship versions,
     * and ten 📋 rows still targeting versions that had shipped without
     * them — both are cut-time facts that manual checklist steps kept
     * missing (same decay pattern the README-freshness gate closed).
     *
     * Runs after `checkReadmeFreshness` and before
     * `checkDefFrameworkConsistency`; skipped on alpha publishes.
     */
    self.checkRoadmapConsistency = function(done) {
        if (self.git.tag === 'alpha') {
            console.debug('[prepare] Skipping roadmap consistency gate (alpha publish).');
            return done();
        }

        console.debug('[prepare] Checking ROADMAP.md consistency against the targeted version ...');

        var checker = require('./check_roadmap_consistency');
        var result, version;
        try {
            var content = fs.readFileSync(ginaPath + '/ROADMAP.md', 'utf8');
            version = JSON.parse(fs.readFileSync(ginaPath + '/package.json', 'utf8')).version;
            result = checker.check({ roadmapContent: content, targetedVersion: version });
        } catch (err) {
            return done(err);
        }

        for (var w = 0; w < result.warnings.length; w++) {
            console.warn('[prepare] WARN: ' + result.warnings[w]);
        }

        if (result.ok) {
            console.debug('[prepare] OK: ROADMAP.md is consistent with releasing ' + version + '.');
            return done();
        }

        console.error('[prepare] ERROR: ROADMAP.md contradicts releasing ' + version + ' — aborting publish.');
        for (var f = 0; f < result.failures.length; f++) {
            console.error('  [' + result.failures[f].rule + '] line ' + result.failures[f].lineNo + ': ' + result.failures[f].excerpt);
        }
        console.error('');
        console.error('  Fix shape:');
        console.error('    - open (📋) row naming ' + version + ': re-target it (e.g. to the `X.Y.x` bucket) or reword the reference;');
        console.error('    - done (✅) row naming a version newer than ' + version + ': stamp the actual ship version.');
        console.error('  Then commit on develop and re-run npm publish.');
        return done(new Error('ROADMAP.md contradicts releasing ' + version + ' (' + result.failures.length + ' row(s))'));
    };

    /**
     * Fail-closed gate: abort the publish if `~/.gina/main.json`'s
     * `def_framework` field points to a framework directory that does
     * not exist on disk. Catches the silent state-store drift that
     * surfaces downstream as `MODULE_NOT_FOUND` from inside
     * `getSelectedVersion`.
     *
     * The actual logic lives in `script/check_def_framework_consistency.js`
     * so it can be unit-tested with an injected fs driver. This wrapper
     * just resolves the live ginaHomeDir + ginaPath and converts the
     * result into the gate-callback shape used by `begin()`.
     *
     * Background: v0.3.10 stable publish (2026-05-06) aborted with
     * `Cannot find module 'framework/v0.3.9/helpers'` because main.json's
     * scalar `def_framework` had drifted to "0.3.9" while the framework
     * dir on disk was at v0.3.10-alpha.2. ~/.gina/0.3/settings.json and
     * gina.db kv_store had the same drift. Root-cause investigation is
     * a separate follow-up; this gate ensures future drift surfaces
     * with an actionable error before npm publish proceeds.
     *
     * Runs after `checkReadmeFreshness` and before `getSelectedVersion`.
     */
    self.checkDefFrameworkConsistency = function(done) {
        console.debug('[prepare] Checking def_framework consistency against framework/v* on disk ...');

        var homeDir = getUserHome();
        if (!homeDir) {
            return done(new Error('No $HOME path found !'));
        }
        var ginaHomeDir = homeDir.replace(/\n/g, '') + '/.gina';

        var checker = require('./check_def_framework_consistency');
        var result;
        try {
            result = checker.check({ ginaHomeDir: ginaHomeDir, ginaPath: ginaPath });
        } catch (err) {
            return done(err);
        }

        if (result.ok) {
            if (result.reason === 'main-json-absent') {
                console.debug('[prepare] OK: ~/.gina/main.json absent — first install or fresh state.');
            } else {
                console.debug('[prepare] OK: def_framework "' + result.defFramework + '" matches ' + result.frameworkDir);
            }
            return done();
        }

        checker.renderFailure(result, ginaHomeDir, ginaPath);
        return done(new Error('def_framework consistency check failed (' + result.reason + ')'));
    };

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

        // #R10 phase 2 — the local state store is OPTIONAL, so a release can
        // run on a machine that never installed gina (a CI runner). The
        // decision lives in resolve_release_state.js, where it is unit-tested:
        // the version comes from the store's def_framework when main.json
        // exists, else from the single git-tracked framework/v* dir, and the
        // release root is ALWAYS this checkout. It used to be read from
        // settingsConfig.dir, which let a stale value put the rename and the
        // release commit in one tree while the build and `npm pack` used
        // another — or fail outright with MODULE_NOT_FOUND.
        var resolveReleaseState = require('./resolve_release_state');
        var trackedFrameworkLs  = '';
        try {
            trackedFrameworkLs = execSync('git ls-files -- framework/', { cwd: self.gina }).toString();
        } catch (lsErr) {
            // left empty: resolved below as "no tracked framework dir" — or,
            // with a store, as "nothing to cross-check def_framework against"
        }
        var package = require(pack);
        var resolved = resolveReleaseState.resolve({
            ginaHomeDir          : ginaHomeDir,
            repoRoot             : self.gina,
            packageVersion       : package.version,
            trackedFrameworkDirs : resolveReleaseState.parseTrackedFrameworkDirs(trackedFrameworkLs)
        });
        if (!resolved.ok) {
            resolveReleaseState.renderFailure(resolved);
            return done(new Error('release state could not be resolved (' + resolved.reason + ')'));
        }

        var selectedVersion = resolved.selectedVersion;
        var targetedVersion = resolved.targetedVersion;
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
        var ginaPath            = resolved.ginaPath;
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

        var frameworkPathObj    =  new _(frameworkPath, true);
        console.debug('source path is: '+ frameworkPath);

        if (resolved.hasStore) {
            // update selected version & requirements
            var mainConfig      = resolved.mainConfig;
            var settingsConfig  = resolved.settingsConfig;
            var shortVersion    = resolved.shortVersion;
            if ( typeof(mainConfig.frameworks[shortVersion]) == 'undefined' ) {
                mainConfig.frameworks[shortVersion] = [];
                // create settings.json for the new version

            }
            if ( mainConfig.frameworks[shortVersion].indexOf(targetedVersion) < 0 ) {
                mainConfig.frameworks[shortVersion].push(targetedVersion)
            }

            // setting def_framework on BOTH stores. Mirrors post_publish.bumpVersion,
            // which writes settings.def_framework alongside settings.version.
            // Without the settings-side assignment, the prepare run
            // leaves settings.json's def_framework at its previous value, producing
            // a `version:<new> + def_framework:<old>` split inside settings.json (and
            // in gina.db's settings/<short> blob via StateStore) that surfaces the next
            // time getSelectedVersion (or anything else reading settings.def_framework)
            // runs against the wrong framework dir.
            mainConfig.def_framework     = targetedVersion;
            settingsConfig.version       = targetedVersion;
            settingsConfig.def_framework = targetedVersion;

            // console.debug('mainConfig: ', JSON.stringify(mainConfig, null, 2));
            // console.debug('settingsConfig: ', JSON.stringify(settingsConfig, null, 2));

            // saving local config
            lib.generator.createFileFromDataSync(JSON.stringify(mainConfig, null, 2), resolved.mainConfigPath);
            lib.generator.createFileFromDataSync(JSON.stringify(settingsConfig, null, 2), resolved.settingsConfigPath);

            // backup of folder version to archives
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
        } else {
            console.info('[prepare] No gina state store at ' + ginaHomeDir + ' — resolved v' + selectedVersion
                + ' from the git-tracked framework dir; the store update and the archive copy are skipped.');
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
            // #M10 — keep the exports map's "." require condition in lockstep
            // with "main" (the ESM "import" targets are version-agnostic).
            if ( package.exports && package.exports['.'] && package.exports['.'].require ) {
                package.exports['.'].require = './framework/v'+ targetedVersion +'/core/gna.js';
            }
            new _(pack, true).rmSync();
            lib.generator.createFileFromDataSync(JSON.stringify(package, null, 2), pack);

            // keeping framework/v{targetedVersion}/package.json version in lockstep
            // with the dir name. The file is git-tracked and moved byte-for-byte by
            // the renameSync above, so its version field stays at the prior (pre-cut)
            // value — drifting away from the framework dir name and shipping a stale
            // version in the published tarball's sub-manifest. Sibling to
            // post_publish.js bumpVersion's identical rewrite; warn-don't-fail so a
            // cut never aborts on it.
            var fwPackPath = _(frameworkPath + '/package.json', true);
            try {
                if ( new _(fwPackPath).existsSync() ) {
                    var fwPackSrc = fs.readFileSync(fwPackPath, 'utf8');
                    var fwPackObj = JSON.parse(fwPackSrc);
                    if (fwPackObj.version !== targetedVersion) {
                        var oldFwVersion = fwPackObj.version;
                        fwPackObj.version = targetedVersion;
                        fs.writeFileSync(fwPackPath, JSON.stringify(fwPackObj, null, 2) + '\n');
                        console.info('[prepare] Updated framework/v' + targetedVersion + '/package.json version: ' + oldFwVersion + ' -> ' + targetedVersion);
                    }
                }
            } catch (fwErr) {
                console.warn('[prepare] Could not update framework package.json: ' + (fwErr.message || fwErr));
            }

            // keeping gna.js up to date — replace all framework version path references
            var gnaJsPath = _(ginaPath + '/gna.js', true);
            try {
                var gnaJsSrc = fs.readFileSync(gnaJsPath, 'utf8');
                var updatedGnaJs = gnaJsSrc.replace(
                    new RegExp('framework/v' + selectedVersion.replace(/\./g, '\\.'), 'g'),
                    'framework/v' + targetedVersion
                );
                if (updatedGnaJs !== gnaJsSrc) {
                    fs.writeFileSync(gnaJsPath, updatedGnaJs);
                    console.info('[prepare] Updated gna.js framework paths: v' + selectedVersion + ' -> v' + targetedVersion);
                }
            } catch (gnaErr) {
                console.warn('[prepare] Could not update gna.js: ' + (gnaErr.message || gnaErr));
            }

            // Update local-only version-anchor files declared in
            // script/.local-sync-targets.json (gitignored). Each entry is a
            // relative path under ginaPath; any occurrence of "v<selectedVersion>"
            // in the file is rewritten to "v<targetedVersion>". The declaration
            // file is gitignored, so a fresh clone or a contributor's machine
            // without it sees no action — this is a maintainer-local convenience
            // to keep plain-text documentation from drifting across version cuts.
            var localSyncConfigPath = _(ginaPath + '/script/.local-sync-targets.json', true);
            try {
                if (new _(localSyncConfigPath).existsSync()) {
                    var syncConfig = JSON.parse(fs.readFileSync(localSyncConfigPath, 'utf8'));
                    var syncFiles  = (syncConfig && syncConfig.files) || [];
                    // Matches "v<selectedVersion>" when NOT followed by another
                    // digit or dot — prevents clobbering a longer version string
                    // that happens to share the same prefix.
                    var versionPattern = new RegExp(
                        'v' + selectedVersion.replace(/\./g, '\\.') + '(?![\\d.])',
                        'g'
                    );
                    for (var i = 0; i < syncFiles.length; i++) {
                        var relPath = syncFiles[i] && syncFiles[i].path;
                        if (typeof relPath !== 'string') continue;
                        var filePath = _(ginaPath + '/' + relPath, true);
                        try {
                            if (!new _(filePath).existsSync()) continue;
                            var src = fs.readFileSync(filePath, 'utf8');
                            var updated = src.replace(versionPattern, 'v' + targetedVersion);
                            if (updated !== src) {
                                fs.writeFileSync(filePath, updated);
                                console.info('[prepare] Local sync: ' + relPath + ' -> v' + targetedVersion);
                            }
                        } catch (fileErr) {
                            console.warn('[prepare] Local sync skipped for ' + relPath + ': ' + (fileErr.message || fileErr));
                        }
                    }
                }
            } catch (syncErr) {
                // Sidecar config absent or malformed — silent no-op.
            }
        }

        done()
    };

    self.setupScriptCWD = function(done) {
        var currentWorkingDir = process.cwd();
        if ( self.ginaPath != currentWorkingDir ) {
            // Verify target is a git repo before chdir. self.ginaPath is the checkout
            // this script runs from (resolve_release_state.js), so the failure left
            // to catch is a tree that is not a git checkout at all (e.g. an extracted
            // tarball), which would otherwise wedge the publish at
            // pushChangesToGitIfNeeded with a misleading "No branch selected" error.
            if ( !fs.existsSync(self.ginaPath) ) {
                return done( new Error(
                    '[CWD] gina path `'+ self.ginaPath +'` (the checkout this release runs from) does not exist.'
                ));
            }
            if ( !fs.existsSync(self.ginaPath + '/.git') ) {
                return done( new Error(
                    '[CWD] gina path `'+ self.ginaPath +'` (the checkout this release runs from) '
                    + 'is not a git repository. Run the release from a git checkout of gina.'
                ));
            }
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
            var isAlpha = /alpha\.\d+$/.test(self.targetedVersion);
            var msg = (!branchExists) ? 'New version'
                : (isAlpha ? 'Prerelease update' : 'Release v' + self.targetedVersion);
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