var fs = require('fs');
var console = lib.logger;
var fmt = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/bundle/status
 */
/**
 * Shows the running/stopped state, PID, port, and active env for a single bundle.
 *
 * Usage:
 *  gina bundle:status <bundle_name> @<project_name>
 *  gina bundle:status <bundle_name> @<project_name> --format=json
 *
 * Unlike `bundle:list` (which answers "what bundles exist" and leads each line
 * with a source-presence marker), `bundle:status` answers "is this one bundle
 * running" and leads with the run-state label.
 *
 * @class Status
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 *
 * @example
 *  // human-readable
 *  $ gina bundle:status api @myproject
 *  [ running ] api              http/2.0 dev https 4208  pid 12345
 *
 * @example
 *  // machine-readable
 *  $ gina bundle:status api @myproject --format=json
 *  {"bundle":"api","project":"myproject","framework":"0.5.5-alpha.2","gina_version":null,"running":true,"pid":12345,"env":"dev","scheme":"http/2.0","protocol":"https","port":4208,"ports":{...}}
 */
function Status(opt, cmd) {
    var self = { format: null };

    /**
     * Parses the --format flag, resolves the target bundle/project, and prints
     * the bundle's status. CmdHelper resolves the single positional bundle name
     * into `self.name` (the same slot bundle:stop reads) and the `@<project>`
     * token into `self.projectName`.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // Full pre-scan of argv for --format only. No dispatch inside the loop —
        // separating parsing from dispatch keeps flag ordering from changing
        // behaviour.
        for (let i = 3, len = process.argv.length; i < len; i++) {
            if ( /^\-\-format\=/.test(process.argv[i]) ) {
                self.format = process.argv[i].split(/\=/)[1];
            }
        }

        // A bundle status targets one specific bundle inside one project — both
        // the bundle name and `@<project>` are required. CmdHelper only sets
        // `self.name` when exactly one bundle positional is present
        // (lib/cmd/helper.js — `cmd.bundles.length == 1`), and leaves
        // `self.projectName` null (not undefined) when no `@<project>` token is
        // present, so test loosely with `== null`.
        if ( typeof(self.name) == 'undefined' || self.name == null ) {
            console.error('Usage: gina bundle:status <bundle_name> @<project_name> [--format=json]');
            process.exit(1);
        }
        if ( self.projectName == null ) {
            console.error('You need to add `@<project_name>`. Usage: gina bundle:status <bundle_name> @<project_name>');
            process.exit(1);
        }

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));
        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('[ '+ self.projectName +' ] is not a registered project.');
            process.exit(1);
        }

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

        status();
        process.exit(0);
    }


    /**
     * Resolves the target bundle's port + running state and prints it. Exits 1
     * when the bundle is not declared in the project's manifest.
     *
     * @inner
     * @private
     */
    var status = function() {
        var bundle      = self.name;
        var projectName = self.projectName;

        // Confirm the bundle is declared in the project manifest.
        var existsInManifest = false;
        try {
            var path    = self.projects[projectName].path;
            var bundles = require( _(path + '/manifest.json') ).bundles;
            existsInManifest = ( typeof(bundles[bundle]) != 'undefined' );
        } catch (err) {
            existsInManifest = false;
        }

        if ( !existsInManifest ) {
            if ( /^json?/.test(self.format) ) {
                process.stdout.write(JSON.stringify({ bundle: bundle, project: projectName, status: 'not-found' }));
            } else {
                console.error('[ '+ bundle +'@'+ projectName +' ] is not a bundle of project [ '+ projectName +' ].');
            }
            process.exit(1);
        }

        var ports     = (self.portsReverseData || {})[bundle + '@' + projectName] || null;
        var preferred = fmt.pickPreferredPort(ports);
        var runState  = fmt.readPidfile(GINA_HOMEDIR + '/run', bundle, projectName);

        // Per-project framework version: the projects.json pin (v-prefixed,
        // written by project:add) stripped of its leading `v` to match
        // main.json's bare def_framework; falls back to the global default
        // when the project is unpinned. The per-bundle gina_version is the
        // manifest override (null when not pinned via --gina-version).
        var entry     = self.projects[projectName];
        var framework = ( typeof(entry.framework) != 'undefined' )
            ? String(entry.framework).replace(/^v/, '')
            : ( (self.mainConfig && self.mainConfig.def_framework) || null );

        var json = {
            bundle       : bundle,
            project      : projectName,
            framework    : framework,
            gina_version : (bundles[bundle] && bundles[bundle].gina_version) || null,
            running      : runState.running,
            pid          : runState.pid,
            env          : preferred ? preferred.env : null,
            scheme       : preferred ? preferred.scheme : null,
            protocol     : preferred ? preferred.protocol : null,
            port         : preferred ? preferred.port : null,
            ports        : ports
        };

        if ( /^json?/.test(self.format) ) {
            return process.stdout.write(JSON.stringify(json));
        }

        var stateLabel = runState.running ? '[ running ]' : '[ stopped ]';
        var portLabel  = preferred
            ? preferred.scheme + ' ' + preferred.env + ' ' + preferred.protocol + ' ' + preferred.port
            : '(no port)';
        var line = stateLabel + ' ' + fmt.pad(bundle, 16) + ' ' + portLabel;
        if ( runState.running ) {
            line += '  pid ' + runState.pid;
        }
        console.log(line);
    }


    init()
};

module.exports = Status
