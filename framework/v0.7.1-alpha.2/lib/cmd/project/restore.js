var fs   = require('fs');
var path = require('path');
var cp   = require('child_process');

var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/project/restore
 */
/**
 * Rebuilds a project from a `project:backup` `.zip` archive.
 *
 * The inverse of `project:backup`. It extracts the archived source tree to the
 * `--to` directory (via `lib/archiver` `decompress()`, JSZip 3.x), then RE-REGISTERS
 * the project so it is immediately usable: a backup zip carries only the source
 * (no `node_modules`, no registry state, no allocated ports), so a bare extraction
 * would be unstartable (`MODULE_NOT_FOUND` with no `node_modules/gina` link; a
 * config emerg with no ports). Registration is delegated to the EXISTING,
 * tested commands rather than duplicating their logic:
 *   - `project:add @<name> --path=<to>` — writes the registry entry, recreates the
 *     `node_modules/gina` symlink, and stamps the project name into package.json;
 *   - `bundle:add <bundle> @<name> --import` per manifest bundle — registers the
 *     already-extracted bundle source and allocates its ports.
 * (`project:import` is NOT usable here — it refuses a not-yet-registered name and
 * `project:add` allocates no bundle ports on its own.)
 *
 * The target is given with `--to=`, NOT `--path=`: `--path` carries add/import
 * semantics in the shared CmdHelper bootstrap (it pre-creates the directory and
 * can hijack `projectLocation` — helper.js:345/358), whereas `--to` is opaque to
 * the bootstrap. The project NAME is the explicit `@<name>` token — there is no
 * fragile archive-filename parsing, and restoring under a different name is just a
 * different `@<name>` (so no `--as` flag is needed). The bootstrap normally rejects
 * an unregistered `@<name>` for a `project:` command; `restore` is exempted in the
 * shared guard (helper.js:505) alongside `add`/`import`/`remove` because it
 * legitimately brings a brand-new name into existence.
 *
 * Refuses to overwrite an already-registered name, or to extract into a non-empty
 * target, unless `--force` is given. `node_modules` is excluded from backups, so
 * the user must run `npm install` after a restore.
 *
 * Project-scoped, offline: `gina project:restore @<name> <archive.zip> --to=/path`.
 *
 * @class Restore
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // restore project `myproject` from a backup into /srv/apps/myproject
 *  $ gina project:restore @myproject /var/dump/myproject-20260619-124016.zip --to=/srv/apps/myproject
 *  project [ myproject ] restored to [ /srv/apps/myproject ] (1 bundle imported)
 *    run `npm install` in the project, then `gina project:start @myproject`
 */
function Restore(opt, cmd) {

    var self  = {};
    var local = { project: null, archive: null, target: null, force: false };

    /**
     * Wires CmdHelper, parses `@<name>` + the archive positional + the required
     * `--to`, validates the archive and the (name / target) conflicts, then runs
     * the restore.
     *
     * @inner
     * @private
     */
    var init = function() {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        if ( !isCmdConfigured() ) return false;

        local.project = self.projectName;
        if ( local.project == null ) {
            console.error('project:restore requires a project name: gina project:restore @<name> <archive.zip> --to=/path');
            process.exit(1);
            return;
        }

        // The archive is a path positional — read it off argv (order-independent:
        // the first token that is neither an @<name> nor a --flag). An absolute
        // path fails isValidName(), so it never lands in self.name/self.bundles.
        var archiveArg = process.argv.slice(3).find(function(a){ return a && !/^@/.test(a) && !/^--/.test(a); }) || null;
        if ( !archiveArg ) {
            console.error('project:restore requires an archive: gina project:restore @'+ local.project +' <archive.zip> --to=/path');
            process.exit(1);
            return;
        }
        local.archive = path.resolve(archiveArg);
        if ( !fs.existsSync(local.archive) || !fs.statSync(local.archive).isFile() ) {
            console.error('Archive [ '+ local.archive +' ] does not exist or is not a file.');
            process.exit(1);
            return;
        }
        if ( !/\.zip$/i.test(local.archive) ) {
            console.error('Archive [ '+ local.archive +' ] is not a .zip (project:backup produces .zip archives).');
            process.exit(1);
            return;
        }

        // --to is REQUIRED (the project's new location). Deliberately NOT --path
        // (the bootstrap pre-creates a --path dir / can hijack projectLocation).
        var toArg  = process.argv.find(function(a){ return /^--to=/.test(a); }) || null;
        var toVal  = toArg ? toArg.split('=').slice(1).join('=').replace(/['"]/g, '') : null;
        if ( !toVal ) {
            console.error('project:restore requires a target path: gina project:restore @'+ local.project +' '+ archiveArg +' --to=/path');
            process.exit(1);
            return;
        }
        local.target = path.resolve(toVal);

        local.force = process.argv.some(function(a){ return /^--force(=|$)/.test(a); });

        // conflict: refuse to clobber an already-registered project
        if ( typeof(self.projects[local.project]) != 'undefined' && !local.force ) {
            console.error('Project [ '+ local.project +' ] is already registered. Choose another @<name>, or pass --force to overwrite its registration.');
            process.exit(1);
            return;
        }

        // conflict: refuse to extract into a non-empty target
        if ( fs.existsSync(local.target) ) {
            var entries = [];
            try { entries = fs.readdirSync(local.target); } catch (e) { entries = []; }
            if ( entries.length > 0 && !local.force ) {
                console.error('Target [ '+ local.target +' ] is not empty. Choose an empty/new path, or pass --force.');
                process.exit(1);
                return;
            }
        }

        run();
    };

    /**
     * Self-invokes the gina CLI (resolved from this install, not PATH) for a
     * sub-command, capturing output. Mirrors add.js linkGina's self-invocation.
     *
     * @inner
     * @private
     * @param {string[]} args - argv for bin/cli (e.g. ['project:add', '@x', '--path=/p'])
     * @returns {object} the spawnSync result ({ status, stdout, stderr })
     */
    var selfCli = function(args) {
        var cliPath = path.resolve(__dirname, '../../../../..', 'bin/cli');
        return cp.spawnSync(process.execPath, [cliPath].concat(args), { encoding: 'utf8' });
    };

    /**
     * Extracts the archive into the target, verifies it held a project, then
     * re-registers the project (entry + gina symlink via project:add, ports via
     * per-bundle bundle:add --import) so it is startable.
     *
     * @inner
     * @private
     */
    var run = function() {

        lib.archiver.decompress(local.archive, local.target + '/').onComplete(function onRestoreExtracted(err) {
            if ( err ) {
                console.error('project:restore failed to extract: '+ (err && (err.stack || err.message) || err));
                process.exit(1);
                return;
            }

            // positive evidence: the archive must have held a gina project
            var manifestPath = path.join(local.target, 'manifest.json');
            var pkgPath      = path.join(local.target, 'package.json');
            if ( !fs.existsSync(manifestPath) || !fs.existsSync(pkgPath) ) {
                console.error('Extracted archive is not a gina project (missing manifest.json / package.json in [ '+ local.target +' ]).');
                process.exit(1);
                return;
            }

            // register the project (writes the registry entry + recreates the
            // node_modules/gina symlink + stamps the name into package.json)
            var reg = selfCli(['project:add', '@'+ local.project, '--path='+ local.target]);
            var registered = false;
            try {
                var projectsNow = JSON.parse(fs.readFileSync(_(GINA_HOMEDIR + '/projects.json').toString(), 'utf8'));
                registered = (typeof(projectsNow[local.project]) != 'undefined');
            } catch (e) { registered = false; }
            if ( !registered ) {
                console.error('project:restore extracted the tree but failed to register the project.');
                if ( reg && reg.stderr ) { console.error(reg.stderr.toString().trim()); }
                process.exit(1);
                return;
            }

            // allocate ports for each bundle by importing its already-extracted source
            var bundles = [];
            try {
                var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                bundles = (manifest && manifest.bundles) ? Object.keys(manifest.bundles) : [];
            } catch (e) { bundles = []; }

            var imported = [];
            var failed   = [];
            for ( var i = 0; i < bundles.length; ++i ) {
                var r = selfCli(['bundle:add', bundles[i], '@'+ local.project, '--import']);
                if ( r && r.status === 0 ) { imported.push(bundles[i]); }
                else { failed.push(bundles[i]); }
            }

            console.log('project [ '+ local.project +' ] restored to [ '+ local.target +' ] ('+ imported.length +' of '+ bundles.length +' bundle(s) imported)');
            if ( failed.length > 0 ) {
                console.warn('  these bundles need a manual import: '+ failed.join(', ') +' (gina bundle:add <bundle> @'+ local.project +' --import)');
            }
            console.log('  node_modules was not in the backup — run `npm install` in the project, then `gina project:start @'+ local.project +'`');
            process.exit(0);
        });
    };

    init();
};

module.exports = Restore
