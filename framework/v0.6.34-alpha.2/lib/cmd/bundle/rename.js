var fs      = require('fs');
var console = lib.logger;

var CmdHelper   = require('./../helper');
var nameRewrite = require('./inc/name-rewrite');

/**
 * @module gina/lib/cmd/bundle/rename
 */
/**
 * Renames a bundle IN PLACE within the SAME project.
 *
 * Moves the source tree `src/<old>` → `src/<new>` (atomic `fs.renameSync`),
 * rewrites the bundle-name footprint in the moved `.js`/`.json` files, and
 * rekeys every registry surface to the new name **preserving the existing port
 * numbers**: the project `manifest.json` (`bundles[<old>]` → `bundles[<new>]`,
 * repointing `src`/`link`/`releases`), `env.json`, `~/.gina/ports.json` (the
 * `"<old>@<project>/<env>"` values), and `~/.gina/ports.reverse.json` (the
 * `"<old>@<project>"` key). The stale `bundles/<old>` mount symlink is removed
 * (it is recreated under the new name on next start).
 *
 * Unlike `bundle:copy`, the name rewrite does NOT touch a first-bundle webroot
 * of `"/"` (rename moves the only bundle — there is no collision), though it
 * still rewrites a name-derived `"/<old>"` webroot via the lowercase pass.
 *
 * The bundle must be STOPPED — renaming a running bundle would strand its
 * process (the pidfile + `ps` title still say `<old>` while `<old>` is gone).
 * It refuses if the source bundle is running.
 *
 * Multi-surface in-place mutation is snapshot-guarded (the `bundle:add` rollback
 * model): on any failure after the directory move, the move is reversed and the
 * `env.json` / `manifest.json` / `ports.json` / `ports.reverse.json` files are
 * restored from in-memory snapshots.
 *
 * Bundle-scoped, same-project: `gina bundle:rename <old> <new> @<project>`.
 *
 * Usage:
 *  gina bundle:rename <old> <new> @<project>
 *  gina bundle:rename <old> <new> @<project> --dry-run
 *  gina bundle:rename <old> <new> @<project> --dry-run --format=json
 *  gina bundle:rename <old> <new> @<project> --force   // overwrite an existing target
 *
 * @class Rename
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // rename bundle `api` to `web` inside project `myproject`
 *  $ gina bundle:rename api web @myproject
 *  Bundle [ api@myproject ] renamed to [ web@myproject ].
 *
 * @example
 *  // preview only, machine-readable
 *  $ gina bundle:rename api web @myproject --dry-run --format=json
 *  {"source":"api","dest":"web","project":"myproject","dryRun":true,"overwrite":false,"rewriteSites":[{"file":"index.js","occurrences":9}]}
 */
function Rename(opt, cmd) {
    var self  = {};
    var local = { source: null, dest: null, srcDir: null, destDir: null, dirMoved: false, snapshot: null };

    /**
     * Wires CmdHelper, parses the two positionals (old + new name), validates
     * the project, then runs the rename.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if (!isCmdConfigured()) return false;

        // bundle:rename takes TWO positionals (old + new). CmdHelper only sets
        // self.name for a SINGLE positional, so read self.bundles directly.
        var bundles = self.bundles || [];
        if ( bundles.length !== 2 ) {
            console.error('bundle:rename requires an old AND a new name: gina bundle:rename <old> <new> @<project>');
            process.exit(1);
            return;
        }
        local.source = bundles[0];
        local.dest   = bundles[1];

        if ( self.projectName == null || typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
            return;
        }

        loadAssets();

        run();
    }


    /**
     * Recursively collects every file path under `dir`.
     *
     * @inner
     * @private
     * @param {string} dir
     * @param {string[]} [acc]
     * @returns {string[]}
     */
    var walkFiles = function(dir, acc) {
        acc = acc || [];
        var entries = [];
        try { entries = fs.readdirSync(dir); } catch (e) { return acc; }
        for (var i = 0; i < entries.length; i++) {
            var full = dir + '/' + entries[i];
            var st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if ( st.isDirectory() ) {
                walkFiles(full, acc);
            } else {
                acc.push(full);
            }
        }
        return acc;
    }


    /**
     * Applies the name rewrite to every `.js`/`.json` file in the moved tree.
     * `fixWebroot` is OFF — rename never repoints a first-bundle `"/"` webroot.
     *
     * @inner
     * @private
     * @param {string} dir - Absolute path of the moved bundle tree
     * @param {string} source
     * @param {string} dest
     * @returns {string[]} Absolute paths of the files actually rewritten
     */
    var rewriteTree = function(dir, source, dest) {
        var files   = walkFiles(dir)
            , touched = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if ( !/\.(js|json)$/i.test(f) ) continue;
            var content;
            try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
            var updated = nameRewrite.renameContent(content, source, dest, { fixWebroot: false });
            if ( updated !== content ) {
                lib.generator.createFileFromDataSync(updated, f);
                touched.push(f);
            }
        }
        return touched;
    }


    /**
     * Previews the rewrite without writing: scans the SOURCE tree's `.js`/`.json`
     * files and reports, per file, how many name occurrences would be rewritten.
     *
     * @inner
     * @private
     * @param {string} srcPath
     * @param {string} source
     * @returns {Array<{file: string, occurrences: number}>}
     */
    var previewRewrite = function(srcPath, source) {
        var files = walkFiles(srcPath)
            , sites = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if ( !/\.(js|json)$/i.test(f) ) continue;
            var content;
            try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
            var n = nameRewrite.countOccurrences(content, source);
            if ( n > 0 ) {
                sites.push({ file: f.replace(srcPath, '').replace(/^\//, ''), occurrences: n });
            }
        }
        return sites;
    }


    /**
     * Removes a pre-existing destination bundle (used on `--force`): deletes its
     * source tree + mount symlink, and its `env.json` / `manifest.json` /
     * `ports.json` / `ports.reverse.json` entries — mirrors bundle/remove.js.
     * Reloads assets afterwards so the rename sees the cleaned state.
     *
     * @inner
     * @private
     * @param {string} name
     */
    var removeDest = function(name) {
        var project = self.projectName;

        try {
            var entry = (self.projectData && self.projectData.bundles) ? self.projectData.bundles[name] : null;
            if ( entry && entry.src ) {
                var folder = new _(self.projects[project].path + '/' + entry.src, true);
                if ( folder.isValidPath() ) folder.rmSync();
            }
            var coreEnv = getCoreEnv(name);
            new _(coreEnv.mountPath + '/' + name, true).rmSync();
        } catch (e) { /* best effort */ }

        if ( self.envData && typeof(self.envData[name]) != 'undefined' ) {
            delete self.envData[name];
            lib.generator.createFileFromDataSync(self.envData, self.envPath);
        }
        if ( self.projectData && self.projectData.bundles && typeof(self.projectData.bundles[name]) != 'undefined' ) {
            delete self.projectData.bundles[name];
            lib.generator.createFileFromDataSync(self.projectData, self.projectManifestPath);
        }
        var ports        = JSON.clone(self.portsData)
            , portsReverse = JSON.clone(self.portsReverseData);
        for (var protocol in ports) {
            for (var scheme in ports[protocol]) {
                for (var port in ports[protocol][scheme]) {
                    var v = ports[protocol][scheme][port];
                    if ( typeof(v) == 'string' && v.indexOf(name + '@' + project + '/') === 0 ) {
                        delete ports[protocol][scheme][port];
                    }
                }
            }
        }
        if ( typeof(portsReverse[name + '@' + project]) != 'undefined' ) {
            delete portsReverse[name + '@' + project];
        }
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        loadAssets();
    }


    /**
     * Rebuilds an object renaming `oldKey` → `newKey` in place (preserving the
     * insertion order of every other key, for a clean config diff).
     *
     * @inner
     * @private
     * @param {object} obj
     * @param {string} oldKey
     * @param {string} newKey
     * @param {*} newValue - The value to store under newKey
     * @returns {object}
     */
    var rekeyInPlace = function(obj, oldKey, newKey, newValue) {
        var out = {};
        for (var k in obj) {
            if ( k === oldKey ) {
                out[newKey] = newValue;
            } else {
                out[k] = obj[k];
            }
        }
        return out;
    }


    /**
     * Restores the pre-rename state after a failure: reverses the directory move
     * (if it happened) and restores the four config files from snapshots.
     *
     * @inner
     * @private
     * @param {Error} err
     */
    var rollback = function(err) {
        console.error('could not complete bundle rename: ' + (err && (err.stack || err.message) || err));
        console.warn('rolling back...');
        if ( local.dirMoved ) {
            try { new _(local.destDir).renameSync(local.srcDir); } catch (e) { /* leave as-is */ }
        }
        if ( local.snapshot ) {
            try { lib.generator.createFileFromDataSync(local.snapshot.env, self.envPath); } catch (e) {}
            try { lib.generator.createFileFromDataSync(local.snapshot.manifest, self.projectManifestPath); } catch (e) {}
            try { lib.generator.createFileFromDataSync(local.snapshot.ports, self.portsPath); } catch (e) {}
            try { lib.generator.createFileFromDataSync(local.snapshot.portsReverse, self.portsReversePath); } catch (e) {}
        }
        process.exit(1);
    }


    /**
     * Prints the rename result (or dry-run preview) as text, or a
     * `{ source, dest, project, dryRun, overwrite, rewriteSites }` envelope with
     * `--format=json`, then exits.
     *
     * @inner
     * @private
     * @param {boolean} dryRun
     * @param {string|null} format
     * @param {string} source
     * @param {string} dest
     * @param {string} project
     * @param {string} srcPath
     * @param {boolean} overwrite
     * @param {Array} rewriteSites - preview {file,occurrences}[] (dry-run) or touched paths[] (success)
     */
    var report = function(dryRun, format, source, dest, project, srcPath, overwrite, rewriteSites) {

        if ( /^json?/.test(format || '') ) {
            var sites = (rewriteSites || []).map(function(s) {
                return (typeof s === 'string')
                    ? { file: s.replace(local.destDir, '').replace(/^\//, '') }
                    : s;
            });
            process.stdout.write(JSON.stringify({
                source       : source,
                dest         : dest,
                project      : project,
                dryRun       : dryRun,
                overwrite    : !!overwrite,
                rewriteSites : sites
            }));
            return process.exit(0);
        }

        if ( dryRun ) {
            console.log('[ dry-run ] would rename bundle [ '+ source +'@'+ project +' ] → [ '+ dest +'@'+ project +' ] (no changes written).');
            console.log('  source : '+ srcPath + (overwrite ? '   (target EXISTS — would be overwritten)' : ''));
            if ( rewriteSites.length > 0 ) {
                console.log('  rename : `'+ source +'`/`'+ nameRewrite.capitalize(source) +'` → `'+ dest +'`/`'+ nameRewrite.capitalize(dest) +'` in '+ rewriteSites.length +' .js/.json file(s):');
                for (var i = 0; i < rewriteSites.length; i++) {
                    var occ = rewriteSites[i].occurrences;
                    console.log('    - '+ rewriteSites[i].file +' ('+ occ +' occurrence'+ (occ === 1 ? '' : 's') +')');
                }
            } else {
                console.log('  rename : no .js/.json occurrences of `'+ source +'` found.');
            }
            console.log('  ports  : the existing port matrix is rekeyed (numbers preserved), not reallocated.');
            return process.exit(0);
        }

        console.log('Bundle [ '+ source +'@'+ project +' ] renamed to [ '+ dest +'@'+ project +' ].');
        var touched = (rewriteSites && rewriteSites.length) || 0;
        if ( touched > 0 ) {
            console.log('  rewrote the bundle name in '+ touched +' file(s).');
        }
        console.log('  rekeyed manifest.json, env.json and the ports registry (port numbers preserved).');
        console.log('You can now start it: gina bundle:start '+ dest +' @'+ project);
        process.exit(0);
    }


    /**
     * Validates the old/new names, refuses if the source bundle is running, then
     * (unless `--dry-run`) moves the directory, rewrites the name footprint, and
     * rekeys every registry surface — all snapshot-guarded for rollback.
     *
     * @inner
     * @private
     */
    var run = function() {
        var p       = self.params || {};
        var dryRun  = !!p['dry-run'];
        var force   = !!p['force'];
        var format  = p['format'] || null;

        var source  = local.source;
        var dest    = local.dest;
        var project = self.projectName;

        if ( source === dest ) {
            console.error('Old and new names are identical (`'+ source +'`). Choose a different new name.');
            process.exit(1);
            return;
        }
        if ( !isValidName(dest) ) {
            console.error('[ '+ dest +' ] is not a valid bundle name.');
            process.exit(1);
            return;
        }

        // source must exist (registered + on disk)
        var srcEntry = (self.bundlesByProject && self.bundlesByProject[project])
            ? self.bundlesByProject[project][source]
            : null;
        if ( !srcEntry ) {
            console.error('Source bundle [ '+ source +' ] is not registered inside `@'+ project +'`.');
            process.exit(1);
            return;
        }
        local.srcDir  = self.projects[project].path + '/' + srcEntry.src;
        local.destDir = self.projects[project].path + '/src/' + dest;
        var srcPath   = _(local.srcDir, true);
        if ( !fs.existsSync(srcPath) ) {
            console.error('Source bundle directory `'+ srcPath +'` does not exist.');
            process.exit(1);
            return;
        }

        // destination must not already exist (unless --force)
        var destInManifest = !!(self.projectData && self.projectData.bundles && self.projectData.bundles[dest]);
        var destHasPorts   = isDefined('bundle', dest);
        var destHasDir     = fs.existsSync(_(local.destDir, true));
        var destExists     = destInManifest || destHasPorts || destHasDir;
        if ( destExists && !force ) {
            console.error('Target bundle [ '+ dest +' ] already exists inside `@'+ project +'`. Re-run with --force to overwrite it, or choose a different name.');
            process.exit(1);
            return;
        }

        // refuse to rename a RUNNING bundle (no --force bypass): a live rename
        // strands the process — its pidfile + `ps` title still say `<old>`.
        var runDir   = (typeof(GINA_RUNDIR) != 'undefined' && GINA_RUNDIR) ? GINA_RUNDIR : (GINA_HOMEDIR + '/run');
        var runState = lib.cmdStatusFormat.readPidfile(runDir, source, project);
        if ( runState.running ) {
            console.error('Bundle [ '+ source +'@'+ project +' ] is running (pid '+ runState.pid +'). Stop it first: gina bundle:stop '+ source +' @'+ project);
            process.exit(1);
            return;
        }

        if ( dryRun ) {
            return report(true, format, source, dest, project, srcPath, destExists, previewRewrite(srcPath, source));
        }

        if ( destExists ) {
            removeDest(dest);
        }

        // snapshot the four config surfaces for rollback (post-removeDest state)
        local.snapshot = {
            env          : JSON.clone(self.envData),
            manifest     : JSON.clone(self.projectData),
            ports        : JSON.clone(self.portsData),
            portsReverse : JSON.clone(self.portsReverseData)
        };

        var rewritten = [];
        try {
            // 1) remove the stale mount symlink (best-effort; recreated on next start)
            try {
                var coreEnv = getCoreEnv(source);
                new _(coreEnv.mountPath + '/' + source, true).rmSync();
            } catch (e) { /* not mounted */ }

            // 2) move the directory FIRST (atomic; trivial to abort if it throws)
            new _(local.srcDir).renameSync(local.destDir);
            local.dirMoved = true;

            // 3) rewrite the name footprint in the moved tree
            rewritten = rewriteTree(local.destDir, source, dest);

            // 4) rekey env.json
            var envData = rekeyInPlace(JSON.clone(self.envData), source, dest, self.envData[source]);
            lib.generator.createFileFromDataSync(envData, self.envPath);

            // 5) rekey manifest.json (clone the entry, repoint src/link/releases)
            var manifest = JSON.clone(self.projectData);
            var entry    = JSON.clone(manifest.bundles[source]);
            entry.src  = 'src/' + dest;
            entry.link = 'bundles/' + dest;
            if ( entry.releases ) {
                for (var scope in entry.releases) {
                    for (var env in entry.releases[scope]) {
                        var rel = entry.releases[scope][env];
                        if ( rel && rel.target ) {
                            rel.target = rel.target.replace('releases/' + source + '/', 'releases/' + dest + '/');
                        }
                    }
                }
            }
            manifest.bundles = rekeyInPlace(manifest.bundles, source, dest, entry);
            lib.generator.createFileFromDataSync(manifest, self.projectManifestPath);
            try { delete require.cache[require.resolve(self.projectManifestPath)]; } catch (e) {}

            // 6) rekey ports.json — rewrite the "<old>@<project>/<env>" VALUES
            //    in place (port-number keys preserved)
            var ports  = JSON.clone(self.portsData)
                , oldOwner = source + '@' + project
                , newOwner = dest + '@' + project;
            for (var protocol in ports) {
                for (var scheme in ports[protocol]) {
                    for (var portKey in ports[protocol][scheme]) {
                        var val = ports[protocol][scheme][portKey];
                        if ( typeof(val) == 'string' && val.indexOf(oldOwner + '/') === 0 ) {
                            ports[protocol][scheme][portKey] = val.replace(oldOwner + '/', newOwner + '/');
                        }
                    }
                }
            }
            lib.generator.createFileFromDataSync(ports, self.portsPath);

            // 7) rekey ports.reverse.json LAST — the canonical "bundle exists"
            //    record (isDefined reads it), so flip it once everything else is done
            var portsReverse = JSON.clone(self.portsReverseData);
            if ( typeof(portsReverse[oldOwner]) != 'undefined' ) {
                portsReverse[newOwner] = portsReverse[oldOwner];
                delete portsReverse[oldOwner];
            }
            lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        } catch (err) {
            return rollback(err);
        }

        report(false, format, source, dest, project, srcPath, destExists, rewritten);
    }

    init();
};

module.exports = Rename
