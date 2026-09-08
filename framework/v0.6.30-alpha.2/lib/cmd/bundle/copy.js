var fs      = require('fs');
var console = lib.logger;

var CmdHelper = require('./../helper');
var scan      = require('./../port/inc/scan');
var nameRewrite = require('./inc/name-rewrite');

/**
 * @module gina/lib/cmd/bundle/copy
 */
/**
 * Duplicates an existing bundle under a NEW name within the SAME project.
 *
 * Copies the source bundle's `src/<source>` tree to `src/<new_name>`, rewrites
 * the bundle-name footprint in the copied `.js`/`.json` files, allocates a fresh
 * full protocol×scheme×env port matrix for the new name, and registers it in the
 * project `manifest.json` + `env.json` + `~/.gina/ports.json` /
 * `~/.gina/ports.reverse.json`.
 *
 * The name rewrite is **word-boundary anchored** — it rewrites the PascalCase
 * identifiers the scaffolder derives from the bundle name (`<Name>Controller`,
 * the gina require-var, etc.) and the lowercase whole-word name, but never a name
 * embedded inside a larger token. It is limited to `.js`/`.json` files; user
 * content in templates / SQL / CSS is copied verbatim. The first-bundle webroot
 * collision (`"/"`) is repointed to `"/<new_name>"` (comment-preserving).
 *
 * Use `--dry-run` to preview every file the rewrite would touch (and the planned
 * port / manifest changes) before anything is written.
 *
 * Bundle-scoped, same-project: `gina bundle:copy <source> <new_name> @<project>`.
 *
 * Usage:
 *  gina bundle:copy <source> <new_name> @<project>
 *  gina bundle:copy <source> <new_name> @<project> --dry-run
 *  gina bundle:copy <source> <new_name> @<project> --dry-run --format=json
 *  gina bundle:copy <source> <new_name> @<project> --force   // overwrite an existing target
 *
 * @class Copy
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // duplicate bundle `api` as `web` inside project `myproject`
 *  $ gina bundle:copy api web @myproject
 *  Bundle [ api@myproject ] copied to [ web@myproject ].
 *
 * @example
 *  // preview only, machine-readable
 *  $ gina bundle:copy api web @myproject --dry-run --format=json
 *  {"source":"api","dest":"web","project":"myproject","dryRun":true,"overwrite":false,"filesToCopy":18,"rewriteSites":[{"file":"index.js","occurrences":9}],"portsToAllocate":8}
 */
function Copy(opt, cmd) {
    var self  = {};
    var local = { source: null, dest: null, portCount: 0 };

    /**
     * Wires CmdHelper, parses the two positionals (source + new name), validates
     * the project, then runs the copy.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // bundle:copy takes TWO positionals (source + new name). CmdHelper only
        // sets self.name for a SINGLE positional, so read self.bundles directly.
        var bundles = self.bundles || [];
        if ( bundles.length !== 2 ) {
            console.error('bundle:copy requires a source AND a new name: gina bundle:copy <source> <new_name> @<project>');
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

        // populate bundlesByProject[...] + ports/env/manifest context
        loadAssets();

        run();
    }


    // escapeRegex / capitalize / renameContent live in ./inc/name-rewrite.js
    // (the pure rewrite engine shared with bundle:rename). Consumed below as
    // `nameRewrite.*`; the fs-walking wrappers (walkFiles/rewriteTree/
    // previewRewrite) stay here because they touch fs + lib.generator.


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
     * Applies the name rewrite to every `.js`/`.json` file in the copied tree.
     *
     * @inner
     * @private
     * @param {string} destPath - Absolute path of the copied bundle tree
     * @param {string} source
     * @param {string} dest
     * @returns {string[]} Absolute paths of the files actually rewritten
     */
    var rewriteTree = function(destPath, source, dest) {
        var files   = walkFiles(destPath)
            , touched = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if ( !/\.(js|json)$/i.test(f) ) continue;
            var content;
            try { content = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
            var isServerSettings = /config\/settings\.server\.json$/.test(f);
            var updated = nameRewrite.renameContent(content, source, dest, { fixWebroot: isServerSettings });
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
     * This is the `--dry-run` safety valve — it surfaces every site the rewrite
     * would touch so a coincidental match can be eyeballed before any write.
     *
     * @inner
     * @private
     * @param {string} srcPath
     * @param {string} source
     * @param {string} dest
     * @returns {Array<{file: string, occurrences: number}>}
     */
    var previewRewrite = function(srcPath, source, dest) {
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
     * Reloads assets afterwards so the fresh copy sees the cleaned state.
     *
     * @inner
     * @private
     * @param {string} dest
     */
    var removeDest = function(dest) {
        var project = self.projectName;

        // source tree + mount symlink (best effort)
        try {
            var entry = (self.projectData && self.projectData.bundles) ? self.projectData.bundles[dest] : null;
            if ( entry && entry.src ) {
                var folder = new _(self.projects[project].path + '/' + entry.src, true);
                if ( folder.isValidPath() ) folder.rmSync();
            }
            var coreEnv = getCoreEnv(dest);
            new _(coreEnv.mountPath + '/' + dest, true).rmSync();
        } catch (e) { /* best effort */ }

        // env.json
        if ( self.envData && typeof(self.envData[dest]) != 'undefined' ) {
            delete self.envData[dest];
            lib.generator.createFileFromDataSync(self.envData, self.envPath);
        }
        // manifest.json
        if ( self.projectData && self.projectData.bundles && typeof(self.projectData.bundles[dest]) != 'undefined' ) {
            delete self.projectData.bundles[dest];
            lib.generator.createFileFromDataSync(self.projectData, self.projectManifestPath);
        }
        // ports.json / ports.reverse.json
        var ports        = JSON.clone(self.portsData)
            , portsReverse = JSON.clone(self.portsReverseData)
            , re;
        for (var protocol in ports) {
            for (var scheme in ports[protocol]) {
                for (var port in ports[protocol][scheme]) {
                    re = new RegExp('^' + nameRewrite.escapeRegex(dest) + '@' + nameRewrite.escapeRegex(project) + '/');
                    if ( re.test(ports[protocol][scheme][port]) ) {
                        delete ports[protocol][scheme][port];
                    }
                }
            }
        }
        for (var addr in portsReverse) {
            if ( addr === dest + '@' + project ) {
                delete portsReverse[addr];
            }
        }
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        // reload so setPorts / writeManifest see the cleaned files
        loadAssets();
    }


    /**
     * Registers the new bundle in the project manifest by cloning the source
     * entry and repointing its `src` / `link` / `releases` target paths to the
     * new name (preserves the source's version / tag / comment).
     *
     * @inner
     * @private
     * @param {string} source
     * @param {string} dest
     */
    var writeManifest = function(source, dest) {
        var data     = requireJSON(self.projectManifestPath)
            , srcEntry = data.bundles[source]
            , entry    = JSON.clone(srcEntry);

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
        data.bundles[dest] = entry;
        lib.generator.createFileFromDataSync(data, self.projectManifestPath);
        try { delete require.cache[require.resolve(self.projectManifestPath)]; } catch (e) { /* not cached */ }
    }


    /**
     * Prints the copy result (or dry-run preview) as text, or a
     * `{ source, dest, project, dryRun, overwrite, filesToCopy, rewriteSites, portsToAllocate }`
     * envelope with `--format=json`, then exits.
     *
     * @inner
     * @private
     * @param {boolean} dryRun
     * @param {string|null} format
     * @param {string} source
     * @param {string} dest
     * @param {string} project
     * @param {string} srcPath
     * @param {string} destPath
     * @param {boolean} overwrite
     * @param {Array} rewriteSites - preview {file,occurrences}[] (dry-run) or touched paths[] (success)
     */
    var report = function(dryRun, format, source, dest, project, srcPath, destPath, overwrite, rewriteSites) {
        var fileCount = walkFiles(srcPath).length;

        if ( /^json?/.test(format || '') ) {
            var sites = (rewriteSites || []).map(function(s) {
                return (typeof s === 'string')
                    ? { file: s.replace(destPath, '').replace(/^\//, '') }
                    : s;
            });
            process.stdout.write(JSON.stringify({
                source          : source,
                dest            : dest,
                project         : project,
                dryRun          : dryRun,
                overwrite       : !!overwrite,
                filesToCopy     : fileCount,
                rewriteSites    : sites,
                portsToAllocate : local.portCount
            }));
            return process.exit(0);
        }

        if ( dryRun ) {
            console.log('[ dry-run ] would copy bundle [ '+ source +'@'+ project +' ] → [ '+ dest +'@'+ project +' ] (no changes written).');
            console.log('  source : '+ srcPath);
            console.log('  target : '+ destPath + (overwrite ? '  (EXISTS — would be overwritten)' : ''));
            console.log('  files  : '+ fileCount + ' file(s) copied verbatim');
            if ( rewriteSites.length > 0 ) {
                console.log('  rename : `'+ source +'`/`'+ nameRewrite.capitalize(source) +'` → `'+ dest +'`/`'+ nameRewrite.capitalize(dest) +'` in '+ rewriteSites.length +' .js/.json file(s):');
                for (var i = 0; i < rewriteSites.length; i++) {
                    var occ = rewriteSites[i].occurrences;
                    console.log('    - '+ rewriteSites[i].file +' ('+ occ +' occurrence'+ (occ === 1 ? '' : 's') +')');
                }
            } else {
                console.log('  rename : no .js/.json occurrences of `'+ source +'` found.');
            }
            console.log('  ports  : would allocate a fresh full matrix (~'+ local.portCount +' port slot(s)).');
            return process.exit(0);
        }

        console.log('Bundle [ '+ source +'@'+ project +' ] copied to [ '+ dest +'@'+ project +' ].');
        var touched = (rewriteSites && rewriteSites.length) || 0;
        if ( touched > 0 ) {
            console.log('  rewrote the bundle name in '+ touched +' file(s).');
        }
        console.log('  registered ports, env.json and manifest.json for the new bundle.');
        console.log('You can now start it: gina bundle:start '+ dest +' @'+ project);
        process.exit(0);
    }


    /**
     * Validates the source/destination, then (unless `--dry-run`) scans for free
     * ports, copies the source tree, rewrites the name footprint, allocates the
     * port matrix, and registers the manifest entry.
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
            console.error('Source and new name are identical (`'+ source +'`). Choose a different new name.');
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
        var srcPath = _(self.projects[project].path + '/' + srcEntry.src, true);
        if ( !fs.existsSync(srcPath) ) {
            console.error('Source bundle directory `'+ srcPath +'` does not exist.');
            process.exit(1);
            return;
        }
        var destPath = _(self.projects[project].path + '/src/' + dest, true);

        // destination existence (manifest OR ports OR on-disk dir)
        var destInManifest = !!(self.projectData && self.projectData.bundles && self.projectData.bundles[dest]);
        var destHasPorts   = isDefined('bundle', dest);
        var destHasDir     = fs.existsSync(destPath);
        var destExists     = destInManifest || destHasPorts || destHasDir;

        if ( destExists && !force ) {
            console.error('Target bundle [ '+ dest +' ] already exists inside `@'+ project +'`. Re-run with --force to overwrite it, or choose a different name.');
            process.exit(1);
            return;
        }

        // full-matrix port count for the new name (envs × protocols × schemes)
        local.portCount = getBundleScanLimit(dest);

        if ( dryRun ) {
            return report(true, format, source, dest, project, srcPath, destPath, destExists, previewRewrite(srcPath, source, dest));
        }

        if ( destExists ) {
            removeDest(dest);
        }

        // 1) scan for free ports
        var options = {
            ignore    : getPortsList(),
            limit     : local.portCount,
            startFrom : (p['start-port-from']) ? ~~p['start-port-from'] : null
        };
        scan(options, function(err, ports) {
            if ( err ) {
                console.error('Port scan failed: '+ (err.message || err));
                process.exit(1);
                return;
            }

            // 2) copy the source tree (trailing slash → copy children into destPath)
            var srcDir = new _(self.projects[project].path + '/' + srcEntry.src + '/');
            srcDir.cp(destPath, function done(cpErr) {
                if ( cpErr ) {
                    console.error('Copy failed: '+ (cpErr.message || cpErr));
                    process.exit(1);
                    return;
                }

                // 3) rewrite the name footprint in the copied .js/.json files
                var rewritten = rewriteTree(destPath, source, dest);

                // 4) allocate the port matrix (writes ports.json / ports.reverse.json / env.json)
                setPorts(dest, ports, function onPortsSet(pErr) {
                    if ( pErr ) {
                        console.error('Port allocation failed: '+ (pErr.message || pErr));
                        process.exit(1);
                        return;
                    }

                    // 5) register the manifest entry (cloned from source, repointed)
                    writeManifest(source, dest);

                    report(false, format, source, dest, project, srcPath, destPath, destExists, rewritten);
                });
            });
        });
    }

    init();
};

module.exports = Copy
