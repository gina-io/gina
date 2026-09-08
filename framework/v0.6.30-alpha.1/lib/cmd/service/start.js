var fs      = require('fs');
var path    = require('path');
var spawn   = require('child_process').spawn;
var console = lib.logger;
var fmt     = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/service/start
 */
/**
 * Starts a framework-internal service — a bundle registered under the @gina
 * project (today: `inspector`). The service is launched via the
 * daemon-free `bin/gina-container` foreground launcher spawned detached, so no
 * `gina start` socket server (port 8124) is required. The service is started in
 * the @gina project's own `dev`/`local` defaults (the current shell's
 * `NODE_ENV`/`NODE_SCOPE` are deliberately NOT propagated — these are maintainer
 * tools that only ship a `src/` form; use `bundle:start` for env/scope control).
 *
 * Guards (no-op rather than error where it is safe to):
 *  - unknown service name / @gina not registered / src missing  → error, exit 1
 *  - service already running (live pidfile)                     → no-op, exit 0
 *
 * `services/` is gitignored + npmignored, so in a fresh `npm install gina` the
 * @gina project and the service src are absent and this command reports the
 * missing src rather than starting anything — it only does real work for a
 * maintainer who scaffolded the framework `services/` project.
 *
 * Usage:
 *  gina service:start inspector
 *  gina service:start inspector @gina
 *  gina service:start inspector --dry-run
 *  gina service:start inspector --format=json
 *
 * @class Start
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // Start the Inspector standalone bundle (dev tooling):
 *  //   $ gina service:start inspector
 *  //   [ service:start ] starting inspector@gina ...
 *  //
 *  // Already running → no-op:
 *  //   $ gina service:start inspector
 *  //   [ service:start ] inspector@gina is already running (pid 12345)
 */
function Start(opt, cmd) {
    var self = { format: null, dryRun: false, service: null };

    /**
     * Parse argv, resolve the @gina manifest, guard on src-existence and
     * running-state, then spawn `gina-container <service> @gina` detached.
     *
     * @inner
     * @private
     */
    var init = function () {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        for (var i = 3, len = process.argv.length; i < len; i++) {
            var arg = process.argv[i];
            if ( /^\-\-format\=/.test(arg) ) {
                self.format = arg.split(/\=/)[1];
            } else if ( /^\-\-dry\-run$/.test(arg) ) {
                self.dryRun = true;
            } else if ( /^@/.test(arg) ) {
                // Accept `@gina` as an explicit but redundant target; reject any
                // other project — user-defined services are not a surface yet.
                var pname = arg.replace(/^@/, '');
                if (pname !== 'gina') {
                    console.error('`service:start` only targets @gina for now. Got: '+ arg);
                    process.exit(1);
                    return;
                }
            } else if ( !/^\-/.test(arg) && !self.service ) {
                self.service = arg;
            }
        }

        if ( !self.service ) {
            console.error('Usage: gina service:start <service> [@gina] [--dry-run] [--format=json]');
            process.exit(1);
            return;
        }

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));
        var ginaProject = self.projects['gina'];
        if ( typeof(ginaProject) == 'undefined' || ginaProject == null ) {
            console.error('@gina project is not registered. Run `services/configure` from the gina framework directory.');
            process.exit(1);
            return;
        }

        var manifestPath = _(ginaProject.path + '/manifest.json');
        if ( !fs.existsSync(manifestPath) ) {
            console.error('@gina manifest.json not found at '+ manifestPath);
            process.exit(1);
            return;
        }

        var manifest;
        try {
            manifest = requireJSON(manifestPath);
        } catch (err) {
            console.error('Could not parse @gina manifest.json: '+ err.message);
            process.exit(1);
            return;
        }

        var services = manifest.bundles || {};
        if ( typeof(services[self.service]) == 'undefined' ) {
            var available = Object.keys(services).sort().join(', ') || '(none)';
            console.error('Unknown @gina service: '+ self.service +'. Available: '+ available);
            process.exit(1);
            return;
        }

        var src       = services[self.service].src || '';
        var srcExists = src && fs.existsSync(_(ginaProject.path + '/' + src));
        if ( !srcExists ) {
            console.error('@gina service `'+ self.service +'` src not found at '+ _(ginaProject.path + '/' + (src || '<unset>')) +' — nothing to start.');
            process.exit(1);
            return;
        }

        // Already-running guard — a live pidfile means a no-op (success).
        var runState = fmt.readPidfile(GINA_HOMEDIR + '/run', self.service, 'gina');
        if ( runState.running ) {
            if ( /^json?/.test(self.format) ) {
                process.stdout.write(JSON.stringify({
                    service: self.service, src: src, started: false,
                    running: true, pid: runState.pid, reason: 'already-running'
                }));
            } else {
                console.log('[ service:start ] '+ self.service +'@gina is already running (pid '+ runState.pid +')');
            }
            process.exit(0);
            return;
        }

        // Resolve the daemon-free launcher. GINA_DIR is the gina root (set by
        // bin/cli / gina-container); fall back to deriving it from __dirname
        // (lib/cmd/service → up five → gina root).
        var ginaDir   = getEnvVar('GINA_DIR') || path.resolve(__dirname, '../../../../../');
        var container = ginaDir + '/bin/gina-container';
        if ( !fs.existsSync(container) ) {
            console.error('gina-container launcher not found at '+ container);
            process.exit(1);
            return;
        }

        if ( self.dryRun ) {
            var preview = process.execPath +' '+ container +' '+ self.service +' @gina';
            if ( /^json?/.test(self.format) ) {
                process.stdout.write(JSON.stringify({
                    service: self.service, src: src, started: false,
                    running: false, dryRun: true, command: preview
                }));
            } else {
                console.log('[ service:start ] (dry-run) would spawn: '+ preview);
            }
            process.exit(0);
            return;
        }

        // Spawn detached so the service outlives this short-lived CLI process.
        // Scrub the current shell's bundle-identity vars so gina-container
        // resolves inspector@gina from @gina's own def_env/def_scope (dev/local)
        // and its own port — never the caller's env/scope/port. GINA_* (homedir,
        // dir, version) are kept so it targets the same ~/.gina. Keep this spawn
        // shape in sync with the gna.js server.on('started') dev auto-start hook.
        var childEnv = Object.assign({}, process.env);
        delete childEnv.NODE_ENV;
        delete childEnv.NODE_SCOPE;
        delete childEnv.NODE_PORT;
        delete childEnv.NODE_BUNDLE;
        delete childEnv.NODE_PROJECT;

        var child;
        try {
            child = spawn(process.execPath, [container, self.service, '@gina'], {
                detached: true,
                stdio: 'ignore',
                env: childEnv
            });
            child.unref();
        } catch (spawnErr) {
            console.error('[ service:start ] failed to spawn '+ self.service +'@gina: '+ (spawnErr.message || spawnErr));
            process.exit(1);
            return;
        }

        if ( /^json?/.test(self.format) ) {
            process.stdout.write(JSON.stringify({
                service: self.service, src: src, started: true,
                running: false, pid: (child && child.pid) || null
            }));
        } else {
            console.log('[ service:start ] starting '+ self.service +'@gina ... (pid '+ ((child && child.pid) || '?') +')');
        }
        process.exit(0);
    };

    init();
}

module.exports = Start;
