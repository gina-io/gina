var fs   = require('fs');
var path = require('path');

var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/project/backup
 */
/**
 * Archives a registered project's SOURCE TREE into a single `.zip`.
 *
 * The archive is produced with `lib/archiver`'s ARRAY form: the handler walks the
 * project source itself and hands `compress()` an explicit `{ input, output }`
 * file list. This is deliberate — the directory form (`compress(dir, ...)`) walks
 * with `fs.statSync`, which FOLLOWS symlinks, so it would recurse the project's
 * absolute `node_modules/gina` link into the entire framework install (and it also
 * leaks absolute paths into the entries). The self-walk skips symlinks and
 * excludes `node_modules` by name, so the archive holds only the real source tree
 * with clean relative paths.
 *
 * The artifact is a DEFLATE `.zip` (`@<project>-<YYYYMMDD-HHMMSS>.zip`), not a
 * `.tar.gz`: `lib/archiver` has no tar producer — it builds zips via JSZip. The
 * timestamp keeps repeated backups from clobbering each other.
 *
 * The output directory is given with `--out=` (default: the current working
 * directory). It is deliberately NOT `--path`: `--path` carries add/import
 * semantics in the shared CmdHelper bootstrap (it pre-creates the directory and
 * can point `projectLocation` at it when the basename matches the project name —
 * helper.js:345/358), whereas `--out` is opaque to the bootstrap.
 *
 * Backup is READ-ONLY on the project: it never mutates the source tree, never
 * writes the `~/.gina` registry, and never touches the port matrix. There is no
 * refuse-if-running guard — a source snapshot of a live project is safe (the
 * mutable runtime state lives under the `~/.<project>` home, outside the source).
 *
 * `--with-password` is advertised in help.txt but has no backing (the archiver's
 * encryption hooks are unimplemented and JSZip cannot produce encrypted zips), so
 * it is REFUSED rather than silently producing a plaintext archive when a caller
 * explicitly asked for encryption.
 *
 * Project-scoped, offline: `gina project:backup @<project> [ --out=/dump ]`.
 *
 * @class Backup
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // back up project `myproject` into /var/dump
 *  $ gina project:backup @myproject --out=/var/dump
 *  project [ myproject ] backed up to [ /var/dump/myproject-20260619-124016.zip ]
 *
 * @example
 *  // no --out: writes the archive into the current directory
 *  $ gina project:backup @myproject
 */
function Backup(opt, cmd) {

    var self  = {};
    var local = { project: null, source: null, outDir: null, archive: null, count: 0 };

    /**
     * Wires CmdHelper, validates the project is registered and has an on-disk
     * source, refuses the unimplemented `--with-password`, resolves the `--out`
     * output directory (default cwd), then runs the backup.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        local.project = self.projectName;

        if ( local.project == null || typeof(self.projects[local.project]) == 'undefined' ) {
            console.error('[ '+ local.project +' ] is not a registered project.');
            process.exit(1);
            return;
        }

        // --with-password is advertised but unimplemented (no encryption backing).
        // Refuse rather than hand back a plaintext archive when a caller explicitly
        // asked for one. A bare `--with-password` stays on argv; `--with-password=x`
        // is hoisted to GINA_WITH_PASSWORD by filterArgs — check both.
        var wantsPassword = process.argv.some(function(a){ return /^--with-password(=|$)/.test(a); })
                            || typeof(process.gina.GINA_WITH_PASSWORD) != 'undefined';
        if ( wantsPassword ) {
            console.error('project:backup: --with-password is not supported yet (archives are NOT encrypted). No archive was created.');
            process.exit(1);
            return;
        }

        local.source = self.projects[local.project].path;
        if ( !local.source || local.source === '' ) {
            console.error('Project [ '+ local.project +' ] has no source path to back up.');
            process.exit(1);
            return;
        }
        if ( !fs.existsSync(local.source) ) {
            console.error('Project source path [ '+ local.source +' ] does not exist on disk.');
            process.exit(1);
            return;
        }

        // Output directory: --out (opaque to the bootstrap, unlike --path).
        // Default to the current working directory. Read off argv directly (the
        // move.js precedent) — argv survives filterArgs for project:* tasks.
        var outArg = process.argv.find(function(a){ return /^--out=/.test(a); }) || null;
        var outVal = outArg ? outArg.split('=').slice(1).join('=').replace(/['"]/g, '') : null;
        local.outDir = outVal ? path.resolve(outVal) : process.cwd();

        run();
    };

    /**
     * Recursively collects the project source files as an archiver
     * `{ input, output }` list — EXCLUDING `node_modules` (regenerable + the
     * symlink-recursion hazard) and SKIPPING symlinks (the absolute
     * `node_modules/gina` link would otherwise pull in the whole framework).
     *
     * @inner
     * @private
     * @param {string} dir - directory to scan
     * @param {number} baseLen - length of the source root prefix to strip for the relative output path
     * @param {object[]} out - accumulator of `{ input, output }` entries
     */
    var collectFiles = function(dir, baseLen, out) {
        var entries = fs.readdirSync(dir, { withFileTypes: true });
        for ( var i = 0; i < entries.length; ++i ) {
            var e = entries[i];
            if ( e.isSymbolicLink() ) {
                continue;
            }
            var abs = dir + '/' + e.name;
            if ( e.isDirectory() ) {
                if ( e.name === 'node_modules' ) {
                    continue;
                }
                collectFiles(abs, baseLen, out);
            } else if ( e.isFile() ) {
                out.push({ input: abs, output: abs.substring(baseLen) });
            }
        }
    };

    /**
     * @inner
     * @private
     * @returns {string} a `YYYYMMDD-HHMMSS` stamp for the archive name
     */
    var timestamp = function() {
        var d = new Date();
        var p = function(n) { return (n < 10 ? '0' : '') + n; };
        return '' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate())
                  + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
    };

    /**
     * Collects the source file list, then compresses it into
     * `<outDir>/<project>-<timestamp>.zip` via the archiver ARRAY form. Reports
     * the path the archiver actually wrote and asserts it exists before declaring
     * success.
     *
     * @inner
     * @private
     */
    var run = function() {

        var files = [];
        try {
            collectFiles(local.source, local.source.replace(/\/+$/, '').length + 1, files);
        } catch ( walkErr ) {
            console.error('Could not read the project source [ '+ local.source +' ]: '+ (walkErr && (walkErr.stack || walkErr.message) || walkErr));
            process.exit(1);
            return;
        }

        if ( files.length === 0 ) {
            console.error('Nothing to back up in [ '+ local.source +' ].');
            process.exit(1);
            return;
        }
        local.count = files.length;

        var base = local.project + '-' + timestamp();
        local.archive = path.join(local.outDir, base + '.zip');

        try {
            if ( !fs.existsSync(local.outDir) ) {
                fs.mkdirSync(local.outDir, { recursive: true });
            }
        } catch ( mkdirErr ) {
            console.error('Could not create the output directory [ '+ local.outDir +' ]: '+ (mkdirErr && (mkdirErr.message || mkdirErr)));
            process.exit(1);
            return;
        }

        lib.archiver.compress(files, local.outDir + '/', { method: 'gzip', name: base, level: 9 })
            .onComplete(function onBackupComplete(err, archivePath) {
                if ( err ) {
                    console.error('project:backup failed: '+ (err && (err.stack || err.message) || err));
                    process.exit(1);
                    return;
                }
                var finalPath = archivePath || local.archive;
                if ( !finalPath || !fs.existsSync(finalPath) ) {
                    console.error('project:backup: the archive was not created.');
                    process.exit(1);
                    return;
                }
                var bytes = fs.statSync(finalPath).size;
                console.log('project [ '+ local.project +' ] backed up to [ '+ finalPath +' ] ('+ local.count +' files, '+ bytes +' bytes)');
                console.log('  node_modules was excluded — run `npm install` after restoring.');
                process.exit(0);
            });
    };

    init();
};

module.exports = Backup
