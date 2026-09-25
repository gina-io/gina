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
        isWin32: isWin32(),
        // written by configure() when the script is run directly with `--tag=`
        // or `-m` (npm lifecycle runs pass the tag as npm_config_tag instead);
        // without this declaration that direct run threw a TypeError
        git : {
            tag: 'latest',
            msg: null
        }
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

        // Capture the version that was just published (before bumpVersion changes it).
        var packObj = requireJSON(_(pack, true));
        self.publishedVersion = packObj.version;
        self.isAlpha = /alpha/i.test(self.publishedVersion);
        self.isBeta  = /beta/i.test(self.publishedVersion);
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

    self.syncDocs = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        // Alpha releases must not touch the docs site. publishAlpha() triggers
        // a second npm publish lifecycle — if syncDocs runs again it overwrites
        // the stable ginaVersion that was just written by the first (stable) run.
        if (self.isAlpha) {
            console.info('[syncDocs] Alpha release — skipping docs sync');
            return done();
        }

        var os = require('os');
        var docsConfigPath = _(os.homedir() + '/Sites/gina/docs/repo/docusaurus.config.js', true);

        // Skip gracefully if the docs repo is not present on this machine.
        if (!fs.existsSync(docsConfigPath)) {
            console.info('[syncDocs] gina-io/docs not found at ' + docsConfigPath + ' — skipping');
            return done();
        }

        var content = fs.readFileSync(docsConfigPath, 'utf8');
        var updated = content.replace(
            /^const ginaVersion = '.*?';/m,
            "const ginaVersion = '" + self.publishedVersion + "';"
        );

        // Write only if changed — but never short-circuit the function here.
        // The merge-to-main step below must run on every stable publish, even
        // when ginaVersion is already current (e.g. user pre-set it manually).
        if (updated !== content) {
            fs.writeFileSync(docsConfigPath, updated, 'utf8');
        }

        var docsRepoPath = _(os.homedir() + '/Sites/gina/docs/repo', true);
        var initialDir = process.cwd();
        // Fail-closed flag for the develop→main merge. Stays true unless the
        // lockfile-regen failure path below cannot guarantee a consistent
        // package.json / package-lock.json pair (see sync_docs_deps.js).
        var docsMergeSafe = true;
        process.chdir(docsRepoPath);
        try {
            execSync('$(which git) checkout develop');

            // Bump devDependencies.gina and regenerate package-lock.json so the docs
            // CI run on develop / main does not fail with "lock file does not satisfy".
            // Failures here are non-fatal — a stale lockfile can be patched manually
            // post-publish, but a thrown error would block tagAndMerge / bumpVersion /
            // publishAlpha and leave the release half-shipped.
            //
            // The `npm install --package-lock-only` line is retried with backoff to
            // absorb the npm registry's eventual-consistency window after publish.
            // Background in `llms.txt #126` (the release-pipeline entry that absorbed
            // the former §87): the lockfile-sync failed on `gina@0.3.7`
            // and `gina@0.3.9` stable publishes (registry hadn't propagated the
            // just-published version yet), shipped a mismatched `package.json` /
            // `package-lock.json` pair, and broke the next Vercel `npm ci`. The retry
            // (4 attempts; it sleeps 5 + 15 + 30 s after the first three failures and
            // never sleeps the schedule's last entry) covers a ~50 s window — registry
            // consistency typically settles inside that. A STAGED cut never resolves
            // inside it (the version is not installable until approved), so the
            // fail-closed revert below fires by design there. Final failure still
            // emits the existing `console.warn` so the rest of the publish chain
            // continues.
            try {
                execSync('$(which npm) pkg set devDependencies.gina="^' + self.publishedVersion + '"');

                var retryLockfileSync = require(scriptPath + '/retry_lockfile_sync');
                var lockResult = retryLockfileSync.retryWithBackoff({
                    cmd: '$(which npm) install --package-lock-only --ignore-scripts'
                });
                if (!lockResult.ok) {
                    // Registry lag: the just-published version stayed unresolvable
                    // past the retry window, so package-lock.json was NOT
                    // regenerated and still pins the previous version, while
                    // package.json was bumped to the new one above. Committing +
                    // merging that mismatched pair to docs main breaks Vercel
                    // `npm ci`. Fail closed: revert devDependencies.gina to match
                    // the version still locked in package-lock.json so the
                    // committed pair stays consistent and the docs CONTENT still
                    // deploys (only the version badge lags). If the locked
                    // version can't be read, skip the merge rather than ship a
                    // mismatch.
                    var syncDocsDeps = require(scriptPath + '/sync_docs_deps');
                    var lockfileContent = fs.existsSync('package-lock.json')
                        ? fs.readFileSync('package-lock.json', 'utf8')
                        : null;
                    var depState = syncDocsDeps.resolveDocsDepState({
                        lockResult      : lockResult,
                        lockfileContent : lockfileContent,
                        newVersion      : self.publishedVersion
                    });

                    console.warn('[syncDocs] lockfile regen failed after ' + lockResult.attempts + ' attempts (registry lag): ' + (lockResult.lastErr.message || lockResult.lastErr));

                    if (depState.devDep) {
                        execSync('$(which npm) pkg set devDependencies.gina="' + depState.devDep + '"');
                        // The printed recipe was run against a replica of the docs topology
                        // (test/lib/post-publish-docs-recovery.test.js pins its shape).
                        // main and develop are SHA-diverged, so it lands the ONE catch-up
                        // commit on main by cherry-pick — a merge would also ship whatever
                        // develop took since the cut — and does so from a temporary
                        // worktree, so the operator's checkout never leaves develop.
                        console.warn('[syncDocs] reverted devDependencies.gina to ' + depState.devDep + ' to match the unregenerated lockfile. The content still deploys, but the docs API reference is generated from the INSTALLED gina, so it shows the locked version until the pin is caught up. Once the registry serves gina@' + self.publishedVersion + ' (on a staged cut: after its approval), run this one line. It commits the pin on develop, then cherry-picks that single commit onto main from a temporary worktree (main and develop are SHA-diverged, so a fast-forward cannot work, and a full merge would also ship anything develop took since the cut):');
                        console.warn('[syncDocs]   cd ~/Sites/gina/docs/repo && git checkout develop && git pull --ff-only origin develop && npm pkg set devDependencies.gina="^' + self.publishedVersion + '" && npm install --package-lock-only --ignore-scripts && git commit -m "Updating the gina devDependency to ^' + self.publishedVersion + ' after the stable publish" -- package.json package-lock.json && git push origin develop && C=$(git rev-parse HEAD) && git worktree add /tmp/docs-main main && git -C /tmp/docs-main pull --ff-only origin main && git -C /tmp/docs-main cherry-pick "$C" && git -C /tmp/docs-main push origin main; s=$?; git worktree remove --force /tmp/docs-main; [ "$s" = 0 ]');
                    }

                    if (!depState.mergeToMain) {
                        docsMergeSafe = false;
                        console.warn('[syncDocs] could not read the locked gina version — skipping the develop→main merge to avoid shipping a mismatched pair. Manual recovery once the registry serves gina@' + self.publishedVersion + ', in order: the first line regenerates the lockfile and commits the pair on develop, the second merges develop into main from a temporary worktree. Run the second before develop takes the docs of the next release, since a merge ships everything develop carries:');
                        console.warn('[syncDocs]   cd ~/Sites/gina/docs/repo && git checkout develop && git pull --ff-only origin develop && npm pkg set devDependencies.gina="^' + self.publishedVersion + '" && npm install --package-lock-only --ignore-scripts && git commit -m "Updating the gina devDependency to ^' + self.publishedVersion + ' after the stable publish" -- package.json package-lock.json && git push origin develop');
                        console.warn('[syncDocs]   cd ~/Sites/gina/docs/repo && git worktree add /tmp/docs-main main && git -C /tmp/docs-main pull --ff-only origin main && git -C /tmp/docs-main merge --no-edit develop && git -C /tmp/docs-main push origin main; s=$?; git worktree remove --force /tmp/docs-main; [ "$s" = 0 ]');
                    }
                }
            } catch (lockErr) {
                // A throw here (npm pkg set, fs read, or helper require) means we
                // cannot guarantee a consistent pair — fail closed by skipping
                // the merge.
                docsMergeSafe = false;
                console.warn('[syncDocs] devDep / lockfile sync failed (non-fatal — fix manually, merge skipped): ' + (lockErr.message || lockErr));
            }

            // Commit + push develop — tolerate "nothing to commit" locally so
            // the merge-to-main step below still runs when there is no config diff.
            try {
                execSync('$(which git) add docusaurus.config.js package.json package-lock.json');
                execSync("$(which git) commit -m'Updated gina version to " + self.publishedVersion + "'");
                execSync('$(which git) push origin develop');
            } catch (commitErr) {
                var commitOut = commitErr.output ? commitErr.output.toString() : (commitErr.message || '');
                if (!/nothing to commit/i.test(commitOut)) { throw commitErr; }
            }

            if (!self.isAlpha && docsMergeSafe) {
                // Stable / beta — merge develop into main and push; GitHub Actions deploys automatically.
                // Runs whether or not this invocation wrote a new ginaVersion, so that docs content
                // commits (migration, roadmap, guides) made earlier on develop still reach main.
                execSync('$(which git) checkout main');
                execSync('$(which git) merge develop');
                execSync('$(which git) push origin main');
                execSync('$(which git) checkout develop');
                console.info('[syncDocs] Merged develop → main and pushed — deployment triggered');
            } else if (!self.isAlpha && !docsMergeSafe) {
                console.warn('[syncDocs] develop→main merge skipped — docs content committed/pushed to develop but NOT deployed. See the manual recovery recipe above.');
            } else {
                console.info('[syncDocs] Alpha release — docs committed and pushed to develop');
            }
        } catch (err) {
            process.chdir(initialDir);
            return done(err);
        }
        process.chdir(initialDir);

        done();
    }

    self.tagAndMerge = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        // Alpha releases don't tag or touch master
        if (self.isAlpha) {
            return done();
        }

        var tag = 'v' + self.publishedVersion;
        console.info('[tagAndMerge] Creating tag ' + tag + ' and merging into master');

        var initialDir = process.cwd();
        process.chdir(self.gina);
        try {
            execSync('$(which git) tag ' + tag);
            execSync('$(which git) push origin ' + tag);
            execSync('$(which git) checkout master');
            execSync('$(which git) merge ' + tag);
            execSync('$(which git) push origin master');
            execSync('$(which git) checkout develop');
            console.info('[tagAndMerge] master updated to ' + tag + ' and pushed');
        } catch (err) {
            process.chdir(initialDir);
            return done(err);
        }
        process.chdir(initialDir);

        // Create GitHub release with changelog notes
        try {
            var changelogPath = self.gina + '/.changes/' + self.publishedVersion + '.md';
            if (fs.existsSync(changelogPath)) {
                execSync(
                    '$(which gh) release create ' + tag +
                    ' --repo gina-io/gina' +
                    ' --title ' + tag +
                    ' --latest' +
                    ' --notes-file ' + changelogPath
                );
                console.info('[tagAndMerge] GitHub release ' + tag + ' created');
            } else {
                console.warn('[tagAndMerge] No changelog found at ' + changelogPath + ' — skipping GitHub release');
            }
        } catch (ghErr) {
            // Non-fatal: tag and master are already pushed; log and continue
            console.warn('[tagAndMerge] GitHub release creation failed (non-fatal): ' + ghErr.message);
        }

        done();
    }

    self.bumpVersion = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        // prepare_version.js checks out the release branch (e.g. 019-alpha2) and
        // never switches back. Switch to develop now so the version bump commit
        // and rename land on develop, not on the release branch.
        var initialBumpDir = process.cwd();
        process.chdir(self.gina);
        try {
            execSync('$(which git) checkout develop');
        } catch (checkoutErr) {
            // already on develop or checkout failed — proceed anyway
            console.warn('[bumpVersion] git checkout develop: ' + (checkoutErr.message || checkoutErr));
        }
        process.chdir(initialBumpDir);

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

        // Update ~/.gina/main.json and ~/.gina/{shortVersion}/settings.json
        // BEFORE the framework dir rename. lib.generator.createFileFromDataSync
        // routes known state paths through StateStore (atomic SQLite + JSON
        // sidecar write, #CN2v3) via `require('../state')` from the generator
        // module — a `__dirname`-relative resolution. After the rename below,
        // the generator's __dirname points at a non-existent path, the relative
        // require fails MODULE_NOT_FOUND, the catch swallows it, and the code
        // falls through to a legacy fs.writeFileSync that only writes the JSON
        // sidecar — not gina.db. Doing the writes here keeps the StateStore
        // intercept resolvable while the old framework dir is still on disk,
        // so gina.db stays in sync with main.json/settings.json on every bump.
        var shortVersion = newVersion.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');
        var ginaHomeDir = getUserHome() + '/.gina';
        var mainConfigPath = _(ginaHomeDir + '/main.json', true);
        var settingsConfigPath = _(ginaHomeDir + '/' + shortVersion + '/settings.json', true);

        // #R10 phase 2 — the state store is optional: a release can run on a
        // machine that never installed gina (a CI runner). Each file is checked
        // before it is read because requireJSON() ends the process on a missing
        // file (console.emerg + process.exit) — the catch blocks below never saw
        // that error, so a store-less run died here, after the upload.
        if ( fs.existsSync(mainConfigPath) ) {
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
        } else {
            console.info('[bumpVersion] No gina state store file at ' + mainConfigPath + ' — skipped.');
        }

        if ( fs.existsSync(settingsConfigPath) ) {
            try {
                var settingsConfig = requireJSON(settingsConfigPath);
                settingsConfig.version = newVersion;
                settingsConfig.def_framework = newVersion;
                new _(settingsConfigPath).rmSync();
                lib.generator.createFileFromDataSync(JSON.stringify(settingsConfig, null, 2), settingsConfigPath);
            } catch (e) {
                console.warn('Could not update ' + settingsConfigPath + ': ' + e.message);
            }
        } else {
            console.info('[bumpVersion] No gina state store file at ' + settingsConfigPath + ' — skipped.');
        }

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
        // #M10 — keep the exports map's "." require condition in lockstep
        // with "main" (the ESM "import" targets are version-agnostic).
        if (packObj.exports && packObj.exports['.'] && packObj.exports['.'].require) {
            packObj.exports['.'].require = './framework/v' + newVersion + '/core/gna.js';
        }
        new _(pack, true).rmSync();
        lib.generator.createFileFromDataSync(JSON.stringify(packObj, null, 2), pack);

        // Update framework/v{new}/package.json version field
        // The file is git-tracked and moves with the renameSync above, so its
        // version field stays at whatever it was last set to — drifting away
        // from the framework dir name. Rewrite it so a local dev environment
        // stays consistent with the root package.json after each bump.
        var fwPackPath = _(newVersionDir + '/package.json', true);
        try {
            if (new _(fwPackPath).existsSync()) {
                var fwPackSrc = fs.readFileSync(fwPackPath, 'utf8');
                var fwPackObj = JSON.parse(fwPackSrc);
                if (fwPackObj.version !== newVersion) {
                    var oldFwVersion = fwPackObj.version;
                    fwPackObj.version = newVersion;
                    fs.writeFileSync(fwPackPath, JSON.stringify(fwPackObj, null, 2) + '\n');
                    console.info('[bumpVersion] Updated framework/v' + newVersion + '/package.json version: ' + oldFwVersion + ' -> ' + newVersion);
                }
            }
        } catch (fwErr) {
            console.warn('[bumpVersion] Could not update framework package.json: ' + (fwErr.message || fwErr));
        }

        // Update framework/v{new}/VERSION
        // The file is gitignored and moves with the renameSync above, so its
        // content stays at whatever the prior publish's updateVersionIfNeeded
        // wrote. Without this rewrite, VERSION drifts by 1 version every
        // bumpVersion cycle until the next `npm publish` fires prepare_version.js
        // — leaves a local dev environment between alpha cuts reporting the
        // previous version. Sibling to the framework/v{new}/package.json
        // rewrite above; same "moved with rename, not auto-updated" reasoning.
        var fwVersionPath = _(newVersionDir + '/VERSION', true);
        try {
            fs.writeFileSync(fwVersionPath, newVersion);
            console.info('[bumpVersion] Updated framework/v' + newVersion + '/VERSION: ' + newVersion);
        } catch (vErr) {
            console.warn('[bumpVersion] Could not update framework VERSION: ' + (vErr.message || vErr));
        }

        // Update gna.js — replace all framework version path references
        var gnaJsPath = _(self.gina + '/gna.js', true);
        try {
            var gnaJsSrc = fs.readFileSync(gnaJsPath, 'utf8');
            var updatedGnaJs = gnaJsSrc.replace(
                new RegExp('framework/v' + currentVersion.replace(/\./g, '\\.'), 'g'),
                'framework/v' + newVersion
            );
            if (updatedGnaJs !== gnaJsSrc) {
                fs.writeFileSync(gnaJsPath, updatedGnaJs);
                console.info('[bumpVersion] Updated gna.js framework paths: v' + currentVersion + ' -> v' + newVersion);
            }
        } catch (gnaErr) {
            console.warn('[bumpVersion] Could not update gna.js: ' + (gnaErr.message || gnaErr));
        }

        // Update local-only version-anchor files declared in
        // script/.local-sync-targets.json (gitignored). Each entry is a
        // relative path under self.gina; any occurrence of "v<currentVersion>"
        // in the file is rewritten to "v<newVersion>". The declaration file
        // is gitignored, so a fresh clone or a contributor's machine without
        // it sees no action — this is a maintainer-local convenience to keep
        // plain-text documentation from drifting across alpha cycles.
        var localSyncConfigPath = _(self.gina + '/script/.local-sync-targets.json', true);
        try {
            if (new _(localSyncConfigPath).existsSync()) {
                var syncConfig = requireJSON(localSyncConfigPath);
                var syncFiles  = (syncConfig && syncConfig.files) || [];
                // Matches "v<currentVersion>" as a whole token, optionally
                // consuming a trailing "-alpha.N" suffix so a stable-cut
                // bump (currentVersion="0.3.15") cannot match the bare
                // prefix of "v0.3.15-alpha.6" and leave the suffix in
                // place — that was the #R3 corruption shape that produced
                // "v0.3.16-alpha.2-alpha.6" in CLAUDE.md after the 0.3.15
                // stable cut. The tightened lookahead (?![\w.-]) also
                // blocks word chars, dot, and dash from extending the
                // matched token (defends against any future similar
                // prefix-collision shape).
                var versionPattern = new RegExp(
                    'v' + currentVersion.replace(/\./g, '\\.') + '(?:-alpha\\.\\d+)?(?![\\w.-])',
                    'g'
                );
                for (var i = 0; i < syncFiles.length; i++) {
                    var relPath = syncFiles[i] && syncFiles[i].path;
                    if (typeof relPath !== 'string') continue;
                    var filePath = _(self.gina + '/' + relPath, true);
                    try {
                        if (!new _(filePath).existsSync()) continue;
                        var src = fs.readFileSync(filePath, 'utf8');
                        var updated = src.replace(versionPattern, 'v' + newVersion);
                        // Defense-in-depth: a concatenated alpha-suffix
                        // shape in the output indicates the regex matched
                        // a prefix it shouldn't have. Fail-closed — warn
                        // and skip the write rather than persist the
                        // corruption. This is the post-replace check the
                        // #R3 corruption would have tripped if it had
                        // existed at the time of the 0.3.15 cut.
                        if (/v\d+\.\d+\.\d+-alpha\.\d+-alpha\.\d+/.test(updated)) {
                            console.warn('[bumpVersion] Local sync produced concatenated alpha suffix in ' + relPath + ' — NOT writing. Fix regex or sidecar entry.');
                            continue;
                        }
                        if (updated !== src) {
                            fs.writeFileSync(filePath, updated);
                            console.info('[bumpVersion] Local sync: ' + relPath + ' -> v' + newVersion);
                        } else {
                            // Regex didn't match — sidecar lists this file but its embedded
                            // version isn't currentVersion. Likely stale by >1 cut; the
                            // warn surfaces it so the operator can investigate.
                            console.warn('[bumpVersion] Local sync regex did not match in ' + relPath + ' — file may be stale by more than one version');
                        }
                    } catch (fileErr) {
                        console.warn('[bumpVersion] Local sync skipped for ' + relPath + ': ' + (fileErr.message || fileErr));
                    }
                }
            }
        } catch (syncErr) {
            // Sidecar config absent or malformed — silent no-op.
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

    /**
     * publishAlpha - Publishes the freshly bumped alpha in a NESTED npm lifecycle
     *
     * Runs only on a STABLE cut (alpha cuts early-return: they already are the alpha).
     * bumpVersion has already written the next alpha version, so this re-reads
     * package.json to get it. The nested call re-enters the whole lifecycle —
     * prepare -> prepack -> PUT/stage -> postpublish -> this script again with
     * isAlpha true — which is what performs the alpha's own bump and branch cleanup.
     *
     * The publish MODE and the npm BINARY are both taken from the environment npm
     * gives a lifecycle script, rather than hard-coded or left to PATH:
     *   - `npm_command` is `stage` under `npm stage publish`, `publish` otherwise, so
     *     the nested alpha always matches the cut the operator actually started and a
     *     staged cut can never publish its alpha outright past the approval gate.
     *   - `npm_execpath` is the npm currently running this script; reusing it means a
     *     stage-capable parent cannot hand the child a stage-incapable npm.
     * Falls back to a PATH-resolved bare `npm` when `npm_execpath` is unset, so this is
     * never worse than the previous behaviour. `--tag alpha` reaches `npm_config_tag`
     * under a staged publish too, so prepare_version.js's alpha temp-branch path is
     * unaffected (measured).
     *
     * This step is fail-fast: its catch does `return done(err)`, which the chain turns
     * into process.exit(1), aborting cleanupPublishBranch and end.
     *
     * @param {function} done - Callback
     */
    self.publishAlpha = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        // Alpha releases don't re-publish — they already are the alpha
        if (self.isAlpha) {
            return done();
        }

        var packObj = requireJSON(_(pack, true));
        var alphaVersion = packObj.version;
        console.info('[publishAlpha] Publishing ' + alphaVersion + ' with tag alpha');

        // Mirror the parent's publish mode, and reuse the parent's own npm.
        var npmVerb = (process.env.npm_command === 'stage') ? 'stage publish' : 'publish';
        var npmBin  = process.env.npm_execpath;
        var publishCmd = ( npmBin )
            ? '"' + process.execPath + '" "' + npmBin + '" ' + npmVerb + ' --tag alpha'
            : 'npm ' + npmVerb + ' --tag alpha';
        // A staged alpha is NOT installable until a human approves it — say so, or the
        // log claims a release that has not happened.
        var doneVerb = ( npmVerb === 'stage publish' )
            ? 'Staged (awaiting approval \u2014 NOT yet installable)'
            : 'Published to npm';
        console.info('[publishAlpha] Mode: npm ' + npmVerb + ' (npm_command=' + (process.env.npm_command || 'unset') + ')');

        var initialDir = process.cwd();
        process.chdir(self.gina);
        try {
            execSync(publishCmd, { stdio: 'inherit' });
            console.info('[publishAlpha] ' + doneVerb + ': ' + alphaVersion + ' with tag alpha');
        } catch (err) {
            process.chdir(initialDir);
            return done(err);
        }
        process.chdir(initialDir);

        done();
    }

    /**
     * cleanupPublishBranch - Deletes the temporary branch created by prepare_version.js
     *
     * Alpha publishes create a branch like `031-alpha2` (version with dots stripped).
     * Stable publishes commit to `develop` directly and do not create a temporary branch.
     * This step prevents stale branch accumulation on the remote.
     *
     * @param {function} done - Callback
     */
    self.cleanupPublishBranch = function(done) {

        // Skip on dry-run
        if (typeof(process.env.npm_config_dry_run) != 'undefined') {
            return done();
        }

        // Stable publishes commit to develop directly — no branch to clean up.
        if (!self.isAlpha) {
            return done();
        }

        // Derive the branch name the same way prepare_version.js does:
        // version with dots stripped, e.g. "0.3.1-alpha.2" -> "031-alpha2"
        var publishBranch = self.publishedVersion.replace(/\./g, '');

        // Never delete develop or master
        if (/^(develop|master|main)$/.test(publishBranch)) {
            return done();
        }

        console.info('[cleanupPublishBranch] Deleting temporary branch ' + publishBranch);

        var initialDir = process.cwd();
        process.chdir(self.gina);
        try {
            // Delete local branch (may already be gone if bumpVersion switched away)
            try {
                execSync('$(which git) branch -d ' + publishBranch + ' 2>/dev/null');
            } catch (_e) {
                // Branch doesn't exist locally — that's fine
            }

            // Delete remote branch
            execSync('$(which git) push origin --delete ' + publishBranch);
            console.info('[cleanupPublishBranch] Deleted origin/' + publishBranch);
        } catch (err) {
            // Non-fatal: the branch may already be gone or the remote may not have it
            var errOut = err.output ? err.output.toString() : (err.message || '');
            if (!/remote ref does not exist|not found/i.test(errOut)) {
                console.warn('[cleanupPublishBranch] Could not delete ' + publishBranch + ': ' + errOut);
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