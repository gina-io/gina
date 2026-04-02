var exec        = require('child_process').exec;

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/project/restart
 */
/**
 * Restarts all bundles in a project.
 * Delegates to `gina bundle:restart @<project>` (bulk mode).
 *
 * Usage:
 *  gina project:restart @<project_name>
 *
 * @class Restart
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client or process.stdout for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Restart(opt, cmd) {

    var self = {};

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.cmdStr = process.argv.splice(0, 2).join(' ');

        // collect --flags to forward
        self.inheritedArgv = [];
        for (var i = 0, len = process.argv.length; i < len; i++) {
            if ( /^\-\-/.test(process.argv[i]) ) {
                self.inheritedArgv.push(process.argv[i])
            }
        }
        self.inheritedArgv = self.inheritedArgv.join(' ');

        restart(opt, cmd);
    }

    var restart = function(opt, cmd) {

        var _cmd = '$gina bundle:restart @' + self.projectName;
        if (self.inheritedArgv != '') {
            _cmd += ' ' + self.inheritedArgv;
        }
        if (opt.debugPort) {
            _cmd += ' --inspect';
            if (opt.debugBrkEnabled) {
                _cmd += '-brk'
            }
            _cmd += '=' + opt.debugPort;
        }
        _cmd = _cmd.replace(/\$(gina)/g, self.cmdStr);

        console.info('Restarting all bundles in @' + self.projectName + ' ...');
        console.debug('Executing: ' + _cmd);

        exec(_cmd, { maxBuffer: 1024 * 500 }, function(err, stdout, stderr) {
            if (stdout) {
                console.log(stdout.replace(/\n\rTrying to.*/gm, ''));
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

module.exports = Restart
