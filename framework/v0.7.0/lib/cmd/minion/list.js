var fs      = require('fs');
var console = lib.logger;
var fmt     = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/minion/list
 */
/**
 * Lists the running gina bundle child-processes ("minions") of a project — or
 * of every registered project when no project is given.
 *
 * A minion is a live, detached Node process spawned by `bundle:start`; each one
 * registers a `<bundle>@<project>.pid` file under the run directory
 * (~/.gina/run). This command reads that directory directly (process-truth),
 * liveness-probes every pidfile via lib.cmdStatusFormat.readPidfile, and reports
 * only the processes that are still alive — including bundles that have been
 * detached from a project's manifest (the orphans that `minion:kill` reaps).
 * Framework-daemon pidfiles (`gina-*`) are skipped. Stale pidfiles (file
 * present, process gone) are NOT listed; cleaning those up is `minion:kill`'s
 * job.
 *
 * Usage:
 *  gina minion:list [@<project_name>]
 *  gina minion:list @<project_name> --format=json
 *
 * The bare form is exempt from the mandatory `@<project>` guard (the `:list$`
 * allowlist in lib/cmd/helper.js), so it reports every project that has at
 * least one running minion, mirroring the two-mode shape of `project:status`.
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // one project, human-readable
 *  $ gina minion:list @myproject
 *  [ running ] api              http/2.0 dev https 4208  pid 12345
 *
 * @example
 *  // every project with live minions, machine-readable
 *  $ gina minion:list --format=json
 *  [{"project":"myproject","minions":[{"bundle":"api","project":"myproject","running":true,"pid":12345,...}]}]
 */
function List(opt, cmd) {
    var self = { format: null };

    /**
     * Parses --format, resolves the run directory, loads the project registry
     * and ports table, then dispatches to listProjectOnly (a named
     * `@<project>`) or listAll (no project given).
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

        // Tolerant ports load — a missing/malformed ports table yields "(no port)".
        self.portsReverseData = {};
        var portsPath = _(GINA_HOMEDIR + '/ports.reverse.json');
        if ( fs.existsSync(portsPath) ) {
            try {
                self.portsReverseData = requireJSON(portsPath);
            } catch (e) {
                // Tolerant — fall through with empty ports table.
            }
        }

        // Full pre-scan of argv for --format only. No dispatch inside the loop.
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            }
        }

        // `self.projectName == null` matches both null (CmdHelper default) and
        // undefined — either signals "no project specified", report them all.
        if ( self.projectName == null ) {
            listAll();
        } else if ( typeof(self.projects[self.projectName]) != 'undefined' ) {
            listProjectOnly();
        } else {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
        }

        process.exit(0);
    }


    /**
     * Reads the run directory and returns the live minions, optionally filtered
     * to one project. Each pidfile is `<bundle>@<project>.pid`; hidden files,
     * non-`.pid` files, and framework-daemon pidfiles (`gina-*`) are skipped,
     * and only processes that pass the liveness probe are returned.
     *
     * @inner
     * @private
     * @param {string|null} projectFilter - When non-null, only minions of this project
     * @returns {Array<object>} live minion entries
     */
    var collectMinions = function(projectFilter) {
        var out   = [];
        var files = [];
        try {
            files = fs.readdirSync(self.runDir);
        } catch (e) {
            // No run directory yet -> no minions.
            return out;
        }

        for (var i = 0, len = files.length; i < len; i++) {
            var file = files[i];
            // skip hidden files, non-pid files, and framework-daemon pidfiles
            if ( /^\./.test(file) || !/\.pid$/.test(file) || /^gina\-/.test(file) ) {
                continue;
            }
            var base = file.replace(/\.pid$/, '');
            var at   = base.lastIndexOf('@');
            if ( at < 1 || at === base.length - 1 ) {
                // not a `<bundle>@<project>` pidfile — skip
                continue;
            }
            var bundle  = base.substring(0, at);
            var project = base.substring(at + 1);

            if ( projectFilter != null && project !== projectFilter ) {
                continue;
            }

            var runState = fmt.readPidfile(self.runDir, bundle, project);
            if ( !runState.running ) {
                // live only — stale pidfiles are minion:kill's concern
                continue;
            }

            var ports     = (self.portsReverseData || {})[bundle + '@' + project] || null;
            var preferred = fmt.pickPreferredPort(ports);
            out.push({
                bundle   : bundle,
                project  : project,
                running  : true,
                pid      : runState.pid,
                env      : preferred ? preferred.env : null,
                scheme   : preferred ? preferred.scheme : null,
                protocol : preferred ? preferred.protocol : null,
                port     : preferred ? preferred.port : null,
                ports    : ports
            });
        }
        return out;
    }


    /**
     * Formats one live-minion entry into a display line, mirroring
     * `project:status` (state + padded bundle + port + pid).
     *
     * @inner
     * @private
     * @param {object} entry
     * @returns {string}
     */
    var formatLine = function(entry) {
        var portLabel = (entry.port != null)
            ? entry.scheme + ' ' + entry.env + ' ' + entry.protocol + ' ' + entry.port
            : '(no port)';
        return '[ running ] ' + fmt.pad(entry.bundle, 16) + ' ' + portLabel + '  pid ' + entry.pid;
    }


    /**
     * Reports the live minions of self.projectName only.
     *
     * @inner
     * @private
     */
    var listProjectOnly = function() {
        var entries = collectMinions(self.projectName);

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(entries));
        }

        if ( entries.length === 0 ) {
            return console.log('No running minions for [ ' + self.projectName + ' ].');
        }
        var str = '';
        for (var i = 0; i < entries.length; i++) {
            str += formatLine(entries[i]) + '\n\r';
        }
        console.log(str);
    }


    /**
     * Reports the live minions of every project that has at least one, grouped
     * by project name (sorted).
     *
     * @inner
     * @private
     */
    var listAll = function() {
        var all = collectMinions(null);

        // group by project
        var byProject = {};
        for (var i = 0; i < all.length; i++) {
            var p = all[i].project;
            if ( typeof(byProject[p]) == 'undefined' ) {
                byProject[p] = [];
            }
            byProject[p].push(all[i]);
        }

        var names = [];
        for (var name in byProject) {
            names.push(name);
        }
        names.sort();

        if ( /^json?/.test(self.format) ) {
            var json = [];
            for (var k = 0; k < names.length; k++) {
                json.push({ project: names[k], minions: byProject[names[k]] });
            }
            return process.stdout.write(JSON.stringify(json));
        }

        if ( names.length === 0 ) {
            return console.log('No running minions.');
        }
        var str = '';
        for (var j = 0; j < names.length; j++) {
            var projectName = names[j];
            str += '------------------------------------\n\r';
            str += projectName + '\n\r';
            str += '------------------------------------\n\r';
            for (var m = 0; m < byProject[projectName].length; m++) {
                str += formatLine(byProject[projectName][m]) + '\n\r';
            }
            str += '\n\r';
        }
        console.log(str);
    }


    init()
};

module.exports = List
