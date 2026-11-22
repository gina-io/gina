var fs      = require('fs');
var console = lib.logger;
var fmt     = lib.cmdStatusFormat;

var CmdHelper = require('./../helper');

/**
 * @module gina/lib/cmd/service/list
 */
/**
 * Lists framework-internal services — bundles registered under the @gina
 * project. Shows name, src-existence status, the preferred dev port, and
 * whether the service is currently running (pidfile under ~/.gina/run/).
 *
 * Usage:
 *  gina service:list
 *  gina service:list @gina
 *  gina service:list --format=json
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function List(opt, cmd) {
    var self = { format: null };

    /**
     * Parse --format, load the @gina manifest, merge with ports + pidfile state,
     * emit text or JSON.
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
            } else if ( /^@/.test(arg) ) {
                // Accept `@gina` as an explicit but redundant target;
                // reject any other project — user-defined services are not
                // a surface yet.
                var name = arg.replace(/^@/, '');
                if (name !== 'gina') {
                    console.error('`service:list` only targets @gina for now. Got: '+ arg);
                    process.exit(1);
                    return;
                }
            }
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

        var services     = manifest.bundles || {};
        var portsReverse = {};
        var portsPath    = _(GINA_HOMEDIR + '/ports.reverse.json');
        if ( fs.existsSync(portsPath) ) {
            try {
                portsReverse = requireJSON(portsPath);
            } catch (e) {
                // Fall through with empty ports table — tolerant.
            }
        }

        var names = Object.keys(services).sort();
        var json  = [];
        var lines = [];

        for (var n = 0; n < names.length; ++n) {
            var name       = names[n];
            var src        = services[name].src || '';
            var srcExists  = src && fs.existsSync(_(ginaProject.path + '/' + src));
            var status     = srcExists ? 'ok' : '?!';
            var ports      = portsReverse[name + '@gina'] || null;
            var preferred  = fmt.pickPreferredPort(ports);
            var runState   = fmt.readPidfile(GINA_HOMEDIR + '/run', name, 'gina');

            json.push({
                service : name,
                path    : src,
                status  : status,
                ports   : ports,
                running : runState.running,
                pid     : runState.pid
            });

            var stateLabel = runState.running ? '[ running ]' : '[ stopped ]';
            var portLabel  = preferred
                ? preferred.scheme + ' ' + preferred.env + ' ' + preferred.protocol + ' ' + preferred.port
                : '(no port)';
            var line = stateLabel + ' ' + fmt.pad(name, 14) + ' ' + portLabel;
            if (runState.running && runState.pid) {
                line += '  pid ' + runState.pid;
            }
            if (!srcExists) {
                line += '  [?! src missing]';
            }
            lines.push(line);
        }

        if ( /^json?/.test(self.format) ) {
            process.stdout.write(JSON.stringify(json));
            process.exit(0);
            return;
        }

        if (lines.length === 0) {
            console.log('No services registered under @gina.');
        } else {
            console.log(lines.join('\n\r'));
        }
        process.exit(0);
    };

    init();
}

module.exports = List;
