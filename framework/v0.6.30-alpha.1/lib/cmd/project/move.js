var fs   = require('fs');
var path = require('path');

var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/project/move
 */
/**
 * Relocates a registered project's source tree to a new filesystem path.
 *
 * Unlike `project:rename` (which changes the project NAME and therefore rekeys
 * `ports.json` / `ports.reverse.json` by owner), `project:move` changes only the
 * filesystem location. The project name, its `~/.<project>` home directory, the
 * homedir-derived paths (`bundles_path` / `releases_path` / `logs_path` /
 * `tmp_path`), the port matrix, and the per-bundle RELATIVE manifest paths are
 * all preserved — only the registry `path` field (and any other field rooted at
 * the old source path) is rewritten.
 *
 * The target is given with `--to=`, NOT `--path=`. `--path` carries add/import
 * semantics in the shared CmdHelper bootstrap (it pre-creates the directory and
 * can even point `projectLocation` at it when the basename matches the project
 * name — helper.js:345/358), which would clobber a move target. `--to` is opaque
 * to the bootstrap, so the move owns the target's creation entirely.
 *
 * The move uses an atomic `fs.renameSync` (symlink-preserving — the absolute
 * `node_modules/gina` link survives). A cross-filesystem target (EXDEV) is
 * REFUSED with guidance to use `project:import` after a manual copy, rather than
 * silently falling back to a slow, symlink-dereferencing copy.
 *
 * Every bundle in the project must be STOPPED — moving a project whose bundles
 * are serving would strand their processes against a path that no longer exists.
 * It refuses if any bundle is running (no `--force` bypass). The stale bundle
 * mount symlinks (recreated on next start) are removed best-effort after the
 * move. On any post-move failure the rename is reversed so disk and registry
 * stay consistent.
 *
 * Project-scoped, offline: `gina project:move @<project> --to=/new/path`.
 *
 * @class Move
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // move project `myproject` to /srv/apps/myproject
 *  $ gina project:move @myproject --to=/srv/apps/myproject
 *  project [ myproject ] moved to [ /srv/apps/myproject ]
 */
function Move(opt, cmd) {

    var self  = {};
    var local = { project: null, source: null, target: null, moved: false };

    /**
     * Wires CmdHelper, parses the single project token + the required `--to`,
     * validates that the project is registered and the target is a fresh,
     * different location, then runs the move.
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

        // --to is REQUIRED (the new location). It is deliberately NOT --path:
        // the bootstrap pre-creates a --path directory (add/import semantics).
        var toArg  = process.argv.find(function(a){ return /^--to=/.test(a); }) || null;
        var newPath = toArg ? toArg.split('=').slice(1).join('=').replace(/['"]/g, '') : null;
        if ( !newPath ) {
            console.error('project:move requires a target path: gina project:move @'+ local.project +' --to=/new/path');
            process.exit(1);
            return;
        }

        local.source = self.projects[local.project].path;
        if ( !local.source || local.source === '' ) {
            console.error('Project [ '+ local.project +' ] has no source path to move.');
            process.exit(1);
            return;
        }

        // resolve the target to an absolute, normalized path
        local.target = path.resolve(newPath);

        if ( local.target === path.resolve(local.source) ) {
            console.error('Target path is the project current location ('+ local.source +'). Nothing to move.');
            process.exit(1);
            return;
        }

        if ( fs.existsSync(local.target) ) {
            console.error('Target path [ '+ local.target +' ] already exists. Choose a path that does not exist yet.');
            process.exit(1);
            return;
        }

        run();
    }

    /**
     * Refuses if any bundle in the project is running, moves the source tree
     * (atomic rename), rewrites the registry path, removes stale mount symlinks,
     * and writes projects.json. Reverses the move on any post-move failure.
     *
     * @inner
     * @private
     */
    var run = function() {

        var project = local.project;
        var bundles = self.bundles || [];

        // refuse to move a project with a RUNNING bundle (no --force bypass): a
        // live move would strand processes against a path that no longer exists.
        var runDir  = (typeof(GINA_RUNDIR) != 'undefined' && GINA_RUNDIR) ? GINA_RUNDIR : (GINA_HOMEDIR + '/run');
        var running = [];
        for ( var i = 0; i < bundles.length; ++i ) {
            var st = lib.cmdStatusFormat.readPidfile(runDir, bundles[i], project);
            if ( st && st.running ) {
                running.push(bundles[i] + ' (pid '+ st.pid +')');
            }
        }
        if ( running.length > 0 ) {
            console.error('Cannot move [ '+ project +' ]: these bundles are running — stop them first (gina project:stop @'+ project +'):\n  - '+ running.join('\n  - '));
            process.exit(1);
            return;
        }

        // ensure the target parent exists so renameSync does not ENOENT
        var parent = path.dirname(local.target);
        try {
            if ( !fs.existsSync(parent) ) {
                fs.mkdirSync(parent, { recursive: true });
            }
        } catch ( mkdirErr ) {
            console.error('Could not create the target parent directory [ '+ parent +' ]: '+ (mkdirErr.message || mkdirErr));
            process.exit(1);
            return;
        }

        // move the tree (atomic, symlink-preserving)
        try {
            new _(local.source).renameSync(local.target);
            local.moved = true;
        } catch ( mvErr ) {
            if ( mvErr && mvErr.code === 'EXDEV' ) {
                console.error('Target path [ '+ local.target +' ] is on a different filesystem. Copy the tree there manually, then re-register it: gina project:import @'+ project +' --path='+ local.target);
            } else {
                console.error('Could not move the project tree: '+ (mvErr && (mvErr.stack || mvErr.message) || mvErr));
            }
            process.exit(1);
            return;
        }

        // rewrite the registry: the `path` field (exact match) plus any other
        // string field rooted UNDER the old source path. The homedir-derived
        // fields live under ~/.<project> and never match, so they are preserved.
        try {
            var entry  = self.projects[project];
            var oldDir = local.source;
            for ( var k in entry ) {
                if ( typeof(entry[k]) === 'string' ) {
                    if ( entry[k] === oldDir ) {
                        entry[k] = local.target;
                    } else if ( entry[k].indexOf(oldDir + '/') === 0 ) {
                        entry[k] = local.target + entry[k].slice(oldDir.length);
                    }
                }
            }

            // remove stale mount symlinks — they point at the old source and are
            // recreated under the new path on the next start (mirrors bundle:rename).
            for ( var b = 0; b < bundles.length; ++b ) {
                try {
                    var coreEnv = getCoreEnv(bundles[b]);
                    if ( coreEnv && coreEnv.mountPath ) {
                        new _(coreEnv.mountPath + '/' + bundles[b], true).rmSync();
                    }
                } catch ( unmountErr ) { /* not mounted — fine */ }
            }

            lib.generator.createFileFromDataSync(self.projects, _(GINA_HOMEDIR + '/projects.json'));
        } catch ( regErr ) {
            // reverse the move so the registry and disk stay consistent
            try { new _(local.target).renameSync(local.source); } catch ( revErr ) { /* leave as-is */ }
            console.error('Could not update the project registry; reverted the move: '+ (regErr && (regErr.stack || regErr.message) || regErr));
            process.exit(1);
            return;
        }

        console.log('project [ '+ project +' ] moved to [ '+ local.target +' ]');
        console.log('  restart it to refresh bundle mounts: gina project:start @'+ project);
        process.exit(0);
    }

    init();
};

module.exports = Move
