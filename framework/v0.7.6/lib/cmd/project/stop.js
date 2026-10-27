// #B665 (2026-09-27) — execFile: bundle:stop runs from an argument vector, without a shell.
// var exec        = require('child_process').exec;
var execFile    = require('child_process').execFile;

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/project/stop
 */
/**
 * Stops all bundles in a project.
 * Delegates to `gina bundle:stop @<project>` (bulk mode), run as an `execFile`
 * child of the same runtime and CLI script, without a shell (#B665).
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

    /**
     * Validates the configuration, takes the runtime and CLI script paths off
     * `process.argv` as an argument pair (`self.cliArgv`), then stops the project.
     *
     * @inner
     * @private
     * @param {object} opt - Parsed command-line options
     * @param {object} cmd - The cmd dispatcher object
     * @returns {(boolean|void)} false when the CLI is not configured
     */
    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // #B665 (2026-09-27) — the runtime and CLI script paths stay an argument pair: the
        // child runs without a shell (the pair was joined into a command line, unquoted,
        // so an install path containing a space broke project:stop).
        // self.cmdStr = process.argv.splice(0, 2).join(' ');
        self.cliArgv = process.argv.splice(0, 2);

        stop(opt, cmd);
    }

    /**
     * Runs `bundle:stop @<project>`, then exits with the child's outcome.
     *
     * @inner
     * @private
     * @param {object} opt - Parsed command-line options
     * @param {object} cmd - The cmd dispatcher object
     * @returns {void}
     */
    var stop = function(opt, cmd) {

        // #B665 (2026-09-27) — an argument vector, without a shell: the command line spliced
        // the CLI path and the project name in unquoted.
        // var _cmd = '$gina bundle:stop @' + self.projectName;
        // _cmd = _cmd.replace(/\$(gina)/g, self.cmdStr);
        var argv = [self.cliArgv[1], 'bundle:stop', '@' + self.projectName];
        // for the debug line only: nothing runs this string
        var _cmd = [self.cliArgv[0]].concat(argv).join(' ');

        console.info('Stopping all bundles in @' + self.projectName + ' ...');
        console.debug('Executing: ' + _cmd);

        // Re-export the home: the bootstrap env sweep strips GINA_* from
        // process.env, so the delegated bundle command would otherwise act
        // on the default home (see linkGina in project/add.js).
        // was: exec(_cmd, { maxBuffer: … }, function(err, stdout, stderr) {
        execFile(self.cliArgv[0], argv, { maxBuffer: 1024 * 500, env: Object.assign({}, process.env, { GINA_HOMEDIR: GINA_HOMEDIR }) }, function(err, stdout, stderr) {
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
