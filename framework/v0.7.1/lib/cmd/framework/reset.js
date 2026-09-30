var fs       = require('fs');
var nodePath = require('path');
var console  = lib.logger;
/**
 * @module gina/lib/cmd/framework/reset
 */
/**
 * Factory reset — clears the per-user Gina home (`~/.gina`: settings, project
 * registry, env config, port allocations) so the framework rebuilds it to a
 * clean default state on the next command.
 *
 * This is the runtime, package-manager-agnostic equivalent of
 * `npm install -g gina@latest --reset`. The npm install-flag form runs inside
 * the npm install lifecycle, so it does NOT fire under Bun (Bun blocks
 * dependency lifecycle scripts) — this command works the same on Node and Bun.
 *
 * Project source files are never touched — only `~/.gina`.
 *
 * `~/.gina` is intentionally left removed when the command returns; the very
 * next `gina` command re-creates it from the framework defaults via the
 * `framework:init` bootstrap chain (the same path a first-ever install takes).
 * Re-creating it in-process is avoided on purpose: `framework:init`
 * `require()`s `~/.gina` JSON, and those entries are already cached from this
 * process's own init run, so an in-process rebuild would read stale config.
 *
 * By default the command refuses when the framework daemon or any bundle is
 * still running — wiping `~/.gina` would orphan them and strip their run-dir
 * pidfiles. Pass `--force` to reset anyway (the running processes keep running
 * but become untracked). framework:init's checkRunningPids prunes only stale
 * run-dir pidfiles (via `process.kill(pid, 0)`) before this handler runs and
 * keeps the live ones, so the running-process guard is reliable on every
 * platform, including minimal images without `ps`.
 *
 * Usage:
 *  gina framework:reset
 *  gina reset
 *  gina framework:reset --force
 *
 * @class Reset
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {string} [opt.homedir] - Path to the Gina home directory (fallback for GINA_HOMEDIR)
 * @param {string[]} [opt.argv] - Full argv array
 * @param {object} [cmd] - The cmd dispatcher (lib/cmd/index.js)
 *
 * @example
 *  // clean slate
 *  $ gina reset
 *  Resetting ~/.gina ...
 *  Factory reset complete. ~/.gina cleared — it is re-created on the next gina command.
 *
 * @example
 *  // a bundle is still running
 *  $ gina framework:reset
 *  [ framework:reset ] refusing: 1 gina process still running (api@demo, pid 12345).
 *  Stop it first with `gina stop`, or re-run with --force.
 */
function Reset(opt, cmd) {

    opt = opt || {};

    /**
     * Resolves the Gina home directory: GINA_HOMEDIR (set by framework:init) with
     * the dispatched opt.homedir as a fallback.
     * @inner
     * @private
     * @returns {string|null}
     */
    var resolveGinaHome = function() {
        var h = getEnvVar('GINA_HOMEDIR');
        if ( !h && opt.homedir ) { h = opt.homedir; }
        return h || null;
    };

    /**
     * True when --force (or --force=true) is present in argv.
     * @inner
     * @private
     * @returns {boolean}
     */
    var hasForce = function() {
        var argv = (opt.argv && opt.argv.length) ? opt.argv : process.argv;
        for (var i = 0, len = argv.length; i < len; i++) {
            if ( /^\-\-force(\=true)?$/i.test(argv[i]) ) { return true; }
        }
        return false;
    };

    /**
     * Enumerates every `*.pid` file in the run directory (bundles AND the
     * framework daemon's own `gina-*` pidfile) and returns the ones whose
     * process is still alive. Liveness is `process.kill(pid, 0)`: no throw or
     * EPERM ⇒ alive; ESRCH ⇒ stale. Mirrors the run-dir read in minion/list.js,
     * but does NOT skip `gina-*` — wiping ~/.gina would orphan the daemon too.
     * @inner
     * @private
     * @returns {Array<{name: string, pid: number}>}
     */
    var detectRunning = function() {
        var alive  = [];
        var runDir = (typeof(GINA_RUNDIR) != 'undefined' && GINA_RUNDIR)
            ? GINA_RUNDIR
            : (resolveGinaHome() + '/run');
        var files = [];
        try {
            files = fs.readdirSync(runDir);
        } catch (e) {
            return alive; // no run dir yet -> nothing running
        }
        for (var i = 0, len = files.length; i < len; i++) {
            var file = files[i];
            if ( /^\./.test(file) || !/\.pid$/.test(file) ) { continue; }
            var pid = NaN;
            try {
                pid = parseInt(String(fs.readFileSync(nodePath.join(runDir, file))).trim(), 10);
            } catch (e) {
                continue;
            }
            if ( !pid || isNaN(pid) ) { continue; }
            try {
                process.kill(pid, 0);
                alive.push({ name: file.replace(/\.pid$/, ''), pid: pid });
            } catch (e) {
                // EPERM ⇒ process exists but not ours (be conservative, count it);
                // ESRCH ⇒ stale pidfile, ignore.
                if ( e && e.code === 'EPERM' ) {
                    alive.push({ name: file.replace(/\.pid$/, ''), pid: pid });
                }
            }
        }
        return alive;
    };

    /**
     * Performs the guarded reset.
     * @inner
     * @private
     */
    var init = function() {
        var ginaHome = resolveGinaHome();
        if ( !ginaHome ) {
            return end(new Error('[ framework:reset ] could not resolve the Gina home directory (GINA_HOMEDIR).'), 'error');
        }

        // Nothing to do when ~/.gina is already absent — the next command rebuilds it.
        if ( !fs.existsSync(ginaHome) ) {
            console.log(ginaHome + ' is already absent — nothing to reset. It is re-created on the next gina command.');
            return end();
        }

        // Guard: refuse while the daemon or any bundle is running, unless --force.
        var force   = hasForce();
        var running = detectRunning();
        if ( running.length && !force ) {
            var listed = running.map(function(p) { return p.name + ', pid ' + p.pid; }).join('; ');
            console.error('[ framework:reset ] refusing: ' + running.length + ' gina process'
                + (running.length > 1 ? 'es' : '') + ' still running (' + listed + ').');
            console.error('Stop ' + (running.length > 1 ? 'them' : 'it') + ' first with `gina stop`, or re-run with --force.');
            return end(undefined, undefined, undefined, 1);
        }
        if ( running.length && force ) {
            console.warn('[ framework:reset ] --force: ' + running.length + ' gina process'
                + (running.length > 1 ? 'es are' : ' is') + ' still running and will be left orphaned (untracked).');
        }

        // Wipe ~/.gina. Node >= 22 guarantees fs.rmSync.
        console.info('Resetting ' + ginaHome + ' ...');
        try {
            fs.rmSync(ginaHome, { recursive: true, force: true });
        } catch (e) {
            return end(new Error('[ framework:reset ] could not remove ' + ginaHome + ': ' + e.message), 'error');
        }

        console.log('Factory reset complete. ' + ginaHome + ' cleared — it is re-created from defaults on the next gina command (e.g. `gina version`).');
        end();
    };

    /**
     * Logs an optional message/error and exits. Mirrors the end() pattern used
     * by the sibling framework offline commands (e.g. version.js).
     * @inner
     * @private
     * @param {(Error|string)} [output] - Message or Error to print
     * @param {string} [type] - lib.logger method to use (e.g. 'error')
     * @param {string} [messageOnly] - When 'true', print only err.message
     * @param {number} [code] - Explicit exit code (defaults: 1 on Error, else 0)
     */
    var end = function(output, type, messageOnly, code) {
        var err = false;
        if ( typeof(output) != 'undefined' && output !== undefined ) {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack || output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
            } else {
                console.log(output);
            }
        }
        process.exit( (typeof(code) != 'undefined') ? code : (err ? 1 : 0) );
    };

    init();
}

module.exports = Reset
