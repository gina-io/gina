const { execSync } = require('child_process');
var fs      = require('fs');
var console = lib.logger;
var fmt     = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * Grace period (ms) between the first SIGTERM and the follow-up SIGKILL for
 * survivors.
 *
 * @constant
 * @inner
 * @type {number}
 */
var KILL_GRACE_MS = 1500;

/**
 * @module gina/lib/cmd/minion/kill
 */
/**
 * Reaps the running bundle child-processes ("minions") of a project — both the
 * ones tracked by a `<bundle>@<project>.pid` file under the run directory
 * (~/.gina/run) AND any orphaned `gina: <bundle>@<project>` processes still
 * alive without a (or with a stale) pidfile, found via a `ps` sweep. This is
 * the process-truth counterpart to `minion:list`: it terminates exactly what
 * `minion:list` shows, plus the pidfile-less orphans that `bundle:stop`
 * (manifest-driven) cannot reach.
 *
 * Termination is graceful-then-forceful: every target gets a SIGTERM, then
 * after a short grace period any survivor gets a SIGKILL. Stale pidfiles
 * (file present, process already gone) and the pidfiles of killed targets are
 * unlinked afterwards. Mount symlinks are NOT touched — that is bundle-lifecycle
 * clean-up (`bundle:stop`), not a process reaper's concern.
 *
 * `minion:kill` is project-scoped: a `@<project>` is required (there is no
 * all-projects form — reaping every minion on the host is too blunt to be a
 * default). The `ps` sweep is POSIX-only and skipped under Windows.
 *
 * Usage:
 *  gina minion:kill @<project_name>
 *  gina minion:kill @<project_name> --dry-run
 *  gina minion:kill @<project_name> --dry-run --format=json
 *
 * @class Kill
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // preview what would be reaped, without killing anything
 *  $ gina minion:kill @myproject --dry-run
 *  [ dry-run ] minion:kill @myproject would terminate 1 minion(s):
 *    [ would kill ] api              pid 12345
 *
 * @example
 *  // reap them
 *  $ gina minion:kill @myproject
 *  minion:kill @myproject terminated 1 minion(s):
 *    [ killed ] api              pid 12345  (SIGTERM)
 */
function Kill(opt, cmd) {
    var self = { format: null, dryRun: false };

    /**
     * Parses --format / --dry-run, resolves the run directory, validates the
     * project, then runs the reaper.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));

        // Canonical run directory. GINA_RUNDIR may be customised; fall back to
        // the default ~/.gina/run when the global is not set in this scope.
        self.runDir = (typeof(GINA_RUNDIR) != 'undefined' && GINA_RUNDIR)
            ? GINA_RUNDIR
            : (GINA_HOMEDIR + '/run');

        // Full pre-scan of argv for --format and --dry-run.
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            } else if ( /^\-\-dry-run$/.test(process.argv[i]) ) {
                self.dryRun = true;
            }
        }

        // minion:kill is project-scoped. CmdHelper's mandatory-`@<project>`
        // guard already enforces this (kill is not `:list$`-exempt), but guard
        // in-handler too so the contract is explicit and self-contained.
        if ( self.projectName == null ) {
            console.error('minion:kill requires a project: gina minion:kill @<project_name>');
            process.exit(1);
        }
        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
        }

        kill();
    }


    /**
     * Builds the kill set for the project by unioning two sources:
     *   1. run-dir pidfiles (`<bundle>@<project>.pid`) whose process is alive;
     *   2. a `ps` sweep for live `gina: <bundle>@<project>` titles (orphans).
     * Targets are keyed by PID so a process tracked by both sources is counted
     * once. Stale pidfiles (file present, process gone) are collected separately
     * for clean-up. The handler's own PID / parent PID are never targeted.
     *
     * @inner
     * @private
     * @returns {{targets: Object<string,object>, stale: Array<object>}}
     */
    var collectTargets = function() {
        var targets = {};   // pid -> { bundle, pid, sources:[], pidfile? }
        var stale   = [];   // { bundle, pidfile } for dead-but-present pidfiles

        // --- pidfile pass ---
        var files = [];
        try {
            files = fs.readdirSync(self.runDir);
        } catch (e) {
            files = [];
        }
        for (var i = 0, len = files.length; i < len; i++) {
            var file = files[i];
            if ( /^\./.test(file) || !/\.pid$/.test(file) || /^gina\-/.test(file) ) {
                continue;
            }
            var base = file.replace(/\.pid$/, '');
            var at   = base.lastIndexOf('@');
            if ( at < 1 || at === base.length - 1 ) {
                continue;
            }
            var bundle  = base.substring(0, at);
            var project = base.substring(at + 1);
            if ( project !== self.projectName ) {
                continue;
            }

            var runState    = fmt.readPidfile(self.runDir, bundle, project);
            var pidfilePath = _(self.runDir + '/' + file, true);
            if ( runState.running ) {
                if ( runState.pid === process.pid || runState.pid === process.ppid ) {
                    continue; // never target ourselves
                }
                targets[runState.pid] = targets[runState.pid] || { bundle: bundle, pid: runState.pid, sources: [] };
                targets[runState.pid].sources.push('pidfile');
                targets[runState.pid].pidfile = pidfilePath;
            } else {
                stale.push({ bundle: bundle, pidfile: pidfilePath });
            }
        }

        // --- ps pass (POSIX only) ---
        if ( !isWin32() ) {
            try {
                // Match `gina: <bundle>@<project>` precisely: the trailing
                // ([[:space:]]|$) boundary stops `@foo` matching project `foobar`.
                var psCmd = "ps -ef | grep -v grep | grep -E 'gina: [^ ]+@" + self.projectName + "([[:space:]]|$)' | awk '{print $2\"|\"$NF}'";
                var out   = execSync(psCmd).toString().replace(/\n$/, '');
                if ( out.length > 0 ) {
                    var lines = out.split(/\n/);
                    for (var j = 0; j < lines.length; j++) {
                        var parts = lines[j].split(/\|/);
                        var pid   = ~~parts[0];
                        if ( !pid || pid === process.pid || pid === process.ppid ) {
                            continue;
                        }
                        var titleTail = parts[1] || '';        // <bundle>@<project>
                        var psAt      = titleTail.lastIndexOf('@');
                        var psBundle  = (psAt > 0) ? titleTail.substring(0, psAt) : titleTail;
                        if ( targets[pid] ) {
                            targets[pid].sources.push('ps');
                        } else {
                            targets[pid] = { bundle: psBundle, pid: pid, sources: ['ps'] };
                        }
                    }
                }
            } catch (e) {
                // grep exits non-zero when nothing matches -> no orphans, fine.
            }
        }

        return { targets: targets, stale: stale };
    }


    /**
     * Unlinks the pidfiles of killed targets plus any stale pidfiles. Never
     * throws — a pidfile that has already vanished is fine.
     *
     * @inner
     * @private
     * @param {Object<string,object>} targets
     * @param {Array<object>} stale
     */
    var cleanupPidfiles = function(targets, stale) {
        for (var p in targets) {
            if ( targets[p].pidfile ) {
                try {
                    if ( new _(targets[p].pidfile).existsSync() ) {
                        fs.unlinkSync(targets[p].pidfile);
                    }
                } catch (e) { /* already gone */ }
            }
        }
        for (var i = 0; i < stale.length; i++) {
            try {
                if ( new _(stale[i].pidfile).existsSync() ) {
                    fs.unlinkSync(stale[i].pidfile);
                }
            } catch (e) { /* already gone */ }
        }
    }


    /**
     * Prints the reaper result (dry-run preview or kill report) as text or, with
     * `--format=json`, a `{ project, dryRun, killed[], staleCleaned[] }` envelope,
     * then exits.
     *
     * @inner
     * @private
     * @param {Object<string,object>} targets
     * @param {Array<object>} stale
     * @param {boolean} dryRun
     * @param {number[]} forced - PIDs that needed a SIGKILL after the SIGTERM grace
     */
    var report = function(targets, stale, dryRun, forced) {
        var killed = [];
        for (var p in targets) {
            killed.push({
                bundle  : targets[p].bundle,
                pid     : ~~p,
                sources : targets[p].sources,
                forced  : forced.indexOf(~~p) > -1
            });
        }
        var staleList = stale.map(function (s) { return { bundle: s.bundle, pidfile: s.pidfile }; });

        if ( /^json?/.test(self.format) ) {
            process.stdout.write(JSON.stringify({
                project      : self.projectName,
                dryRun       : dryRun,
                killed       : killed,
                staleCleaned : staleList
            }));
            return process.exit(0);
        }

        var str = '';
        if ( dryRun ) {
            str += '[ dry-run ] minion:kill @' + self.projectName + ' would terminate ' + killed.length + ' minion(s):\n\r';
        } else {
            str += 'minion:kill @' + self.projectName + ' terminated ' + killed.length + ' minion(s):\n\r';
        }
        for (var i = 0; i < killed.length; i++) {
            var sig = dryRun ? '' : (killed[i].forced ? '  (SIGKILL)' : '  (SIGTERM)');
            str += '  [ ' + (dryRun ? 'would kill' : 'killed') + ' ] ' + fmt.pad(killed[i].bundle, 16) + ' pid ' + killed[i].pid + sig + '\n\r';
        }
        if ( killed.length === 0 ) {
            str += '  (no running minions)\n\r';
        }
        if ( staleList.length > 0 ) {
            str += (dryRun ? '  stale pidfiles to clean: ' : '  stale pidfiles cleaned: ') + staleList.length + '\n\r';
        }
        console.log(str);
        process.exit(0);
    }


    /**
     * Collects the kill set, then either previews it (dry-run) or runs the
     * SIGTERM -> grace -> SIGKILL escalation, cleans up pidfiles, and reports.
     *
     * @inner
     * @private
     */
    var kill = function() {
        var collected = collectTargets();
        var targets   = collected.targets;
        var stale     = collected.stale;
        var pids      = Object.keys(targets).map(function (p) { return ~~p; });

        if ( self.dryRun ) {
            return report(targets, stale, true, []);
        }

        if ( pids.length === 0 ) {
            // nothing alive to reap — still clean up stale pidfiles
            cleanupPidfiles(targets, stale);
            return report(targets, stale, false, []);
        }

        // graceful first: SIGTERM every target
        for (var i = 0; i < pids.length; i++) {
            try {
                process.kill(pids[i], 'SIGTERM');
            } catch (e) { /* already gone */ }
        }

        // after the grace period, force-kill survivors, clean up, report
        setTimeout(function () {
            var forced = [];
            for (var j = 0; j < pids.length; j++) {
                try {
                    process.kill(pids[j], 0);        // still alive?
                    process.kill(pids[j], 'SIGKILL');
                    forced.push(pids[j]);
                } catch (e) { /* already dead after SIGTERM — good */ }
            }
            cleanupPidfiles(targets, stale);
            report(targets, stale, false, forced);
        }, KILL_GRACE_MS);
    }


    init()
};

module.exports = Kill
