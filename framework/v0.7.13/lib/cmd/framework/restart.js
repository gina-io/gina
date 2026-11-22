var fs          = require('fs');
// #B665 (2026-09-27) — only the removed start() used spawn.
// const {spawn}       = require('child_process');
// #B665 S2 (2026-09-27) — execFileSync: bin/gina start and stop run from argument vectors.
// const {execSync}    = require('child_process');
const {execFileSync}    = require('child_process');
const util = require('util');
// #B780 — the signal numbers, for the exit code of a start a signal ended.
var os          = require('os');

var CmdHelper   = require('./../helper');
// const { start } = require('repl');
var console     = lib.logger;
// Self-resolved daemon wrapper — never PATH-resolve our own binary: the PATH
// may carry no gina at all (repo checkout, non-global install) or a different
// install than the one running this command. bin/gina (not bin/cli) is required
// here so `start` keeps its detached-daemon spawn semantics.
var ginaBin     = require('path').resolve(__dirname, '../../../../..', 'bin/gina');
/**
 * @module gina/lib/cmd/framework/restart
 */
/**
 * Restarts the Gina framework server, optionally targeting a specific version.
 *
 * Usage:
 *  gina framework:restart
 *  gina restart
 *  gina restart @1.0.0
 *
 * @class Restart
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Restart(opt, cmd) {
    var self    = {
        // Current version of the framework by default
        // But can be overriden with argument: @{version_number}
        // eg.: gina stop @1.0.0
        version: GINA_VERSION
    };


    /**
     * Validates the version argument and delegates to restart().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
        var err = null;
        // check CMD configuration
        //if (!isCmdConfigured()) return false;
        // checkcking version number
        if ( typeof(opt.argv[3]) != 'undefined' && /^@/.test(opt.argv[3]) ) {
            var version = opt.argv[3].replace(/\@/, '');
            var shortVersion = version.split('.').splice(0,2).join('.');
            if ( !/^\d\.\d/.test(shortVersion) ) {
                err = new Error('Wrong version: '+ version);
                console.log(err.message);
                // Flush + exit non-zero instead of a bare `return`: the bare
                // return bypassed end()'s process.exit, so with the CLI's MQ
                // listener up the event loop never emptied (hang on
                // `gina restart @<garbage>`). writeSync guarantees the message
                // survives the exit on a pipe (boot-exit-flush).
                fs.writeSync(2, err.message +'\n');
                process.exit(1);
            }
            var availableVersions = requireJSON(_(GINA_HOMEDIR +'/main.json', true)).frameworks[shortVersion];
            if ( !availableVersions || availableVersions.indexOf(version) < 0 ) {
                err = new Error('Version not installed: '+ version);
                console.log(err.message);
                fs.writeSync(2, err.message +'\n');
                process.exit(1);
            }

            self.version = version;
        }
        console.debug('Restarting framework v'+ self.version);

        // if (!self.name) {
        //     stop(opt, cmd, 0);
        // } else {
            restart(opt, cmd);
        // }
    }

    /**
     * Runs stop(), then starts the framework through this install's `bin/gina start`
     * (execFileSync, from an argument vector). A start that fails is reported by
     * startFailed(), which exits with the start's code (#B780).
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var restart = function(opt, cmd) {
        stop();
        // if previous debug session
        setTimeout(() => {

            // METHOD #1 — a detached spawn that also restarted every running bundle. It was
            // never enabled, and was removed with its start() (#B665, see below stop()).


            // METHOD #2
            // TODO - retrieve & add `opt`
            var out = null;
            try {
                // was: out = execSync('$(which gina) start @'+self.version).toString();
                // #B665 S2 (2026-09-27) — an argument vector: the version reaches bin/gina whole.
                // was: out = execSync('"'+ process.execPath +'" "'+ ginaBin +'" start @'+self.version).toString();
                out = execFileSync(process.execPath, [ginaBin, 'start', '@' + self.version]).toString();
                console.debug('out => ', out);
                // TODO - retrieve running bundles with its options & restart
            } catch (err) {
                // #B780 — was: a non-zero `gina start` counted as a success whenever
                // gina-v<version>.pid existed, a fallback for the exit a stderr warning used to
                // cause, which #B760 removed. It only hid a start that failed after writing its pid
                // file (exit 0, nothing running); otherwise the error was rethrown here, inside a
                // timer: an uncaught dump and exit 1, the start's own code lost.
                // // gina start may exit non-zero when Node.js writes benign
                // // warnings (e.g., ExperimentalWarning) to stderr while the
                // // daemon actually started in the background.
                // // Check for the PID file before treating this as a failure.
                // var pidFile = _(GINA_RUNDIR + '/gina-v' + self.version + '.pid', true);
                // if ( fs.existsSync(pidFile) ) {
                //     console.debug('Framework v'+ self.version +' restarted successfully');
                // } else {
                //     throw err;
                // }
                startFailed(err);
            }
        }, 100);

    }

    /**
     * #B780 — reports a `gina start` that failed during a restart, then exits with its code. The
     * start's standard error already reached this process's (execFileSync passes it through);
     * its standard output, which execFileSync captured, is written out first.
     *
     * @inner
     * @private
     * @param {Error} err - What execFileSync threw: `status` is the start's exit code, `signal`
     *   the signal that ended it, `stdout` what it printed
     *
     * @example
     * startFailed(err);
     * // stderr: « gina: framework:restart could not start the framework v0.7.4 again (gina start exited 3). »
     * // then exits 3
     */
    var startFailed = function(err) {
        var code = 1;
        if ( err && typeof(err.status) == 'number' && err.status !== 0 ) {
            code = err.status;
        } else if ( err && err.signal && typeof(os.constants.signals[err.signal]) == 'number' ) {
            code = 128 + os.constants.signals[err.signal];
        }
        if ( err && err.stdout && err.stdout.length > 0 ) {
            fs.writeSync(1, err.stdout);
        }
        fs.writeSync(2, 'gina: framework:restart could not start the framework v'+ self.version +' again (gina start exited '+ code +').\n');
        process.exit(code);
    }

    /**
     * Stops the framework synchronously via `gina stop`.
     * @inner
     * @private
     */
    var stop = function() {
        var out = null;
        try {
            // was: out = execSync('$(which gina) stop @'+self.version).toString();
            // #B665 S2 (2026-09-27) — an argument vector: the version reaches bin/gina whole.
            // was: out = execSync('"'+ process.execPath +'" "'+ ginaBin +'" stop @'+self.version).toString();
            out = execFileSync(process.execPath, [ginaBin, 'stop', '@' + self.version]).toString();
            console.debug('out => ', out);
        } catch (err) {
            throw err;
        }
    }

    // #B665 (2026-09-27) — start() (METHOD #1: a detached `gina start --restart-pid=<pid>`
    // spawn whose stdout handler restarted every running bundle through
    // restartRunningBunldes()) is removed with that helper. Neither was ever called: the
    // one call, METHOD #1 in restart() above, was already commented out. The helper ran
    // `bundle:restart` from a shell command line built from pid-file names, and the design
    // could not be revived as it stood: bin/gina's `--restart-pid` handling dropped the node
    // path from its argv instead of the flag (#B689 removed that handling). Running bundles
    // survive a framework restart anyway (framework:stop leaves them running). The removed
    // code is in git history.


    /**
     * Logs optional output and exits the process.
     * @inner
     * @private
     * @param {string|Error} [output]
     * @param {string} [type] - Logger method name
     * @param {boolean} [messageOnly]
     */
    var end = function (output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
                if ( messageOnly && type != 'log') {
                    console.log(output);
                }
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }


    init(opt, cmd)
}

module.exports = Restart;