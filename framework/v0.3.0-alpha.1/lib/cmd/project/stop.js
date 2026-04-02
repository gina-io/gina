var exec        = require('child_process').exec;

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/project/stop
 */
/**
 * Stops all bundles in a project.
 * Delegates to `gina bundle:stop @<project>` (bulk mode).
 *
 * Usage:
 *  gina project:stop @<project_name>
 *
 * @class Stop
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client or process.stdout for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Stop(opt, cmd) {

    var self = {};

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.cmdStr = process.argv.splice(0, 2).join(' ');

        stop(opt, cmd);
    }

    var stop = function(opt, cmd) {

        var _cmd = '$gina bundle:stop @' + self.projectName;
        _cmd = _cmd.replace(/\$(gina)/g, self.cmdStr);

        console.info('Stopping all bundles in @' + self.projectName + ' ...');
        console.debug('Executing: ' + _cmd);

        exec(_cmd, { maxBuffer: 1024 * 500 }, function(err, stdout, stderr) {
            if (stdout) {
                console.log(stdout);
            }
            if (err) {
                console.error(err.toString());
                return process.exit(1);
            }
            process.exit(0);
        });
    }

    init(opt, cmd);
}

module.exports = Stop
