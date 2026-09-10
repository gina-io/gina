var fs          = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
//const { debug } = require('console');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
var fmt         = lib.cmdStatusFormat;
/**
 * @module gina/lib/cmd/framework/stop
 */
/**
 * Stops the running Gina framework server — the socket server on port 8124 and
 * the co-located MQ listener on 8125 (one process). This is **daemon-only**:
 * running bundles are detached child processes (spawned `detached: true` by
 * `bundle:start`) and are NOT stopped, so they keep running with their bound
 * ports. Before exiting, any bundle still running is surfaced as a non-fatal
 * notice pointing at `gina bundle:stop` / `gina project:stop`.
 * Optionally targets a specific version via `@{version}` argument.
 *
 * Usage:
 *  gina framework:stop
 *  gina stop
 *  gina stop @1.0.0
 *
 * @class Stop
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Stop(opt, cmd) {
    var self    = {
        // Current version of the framework by default
        // But can be overriden with argument: @{version_number}
        // eg.: gina stop @1.0.0
        version: GINA_VERSION,
        // Used to close suspended parent process if exists
        // This is required if you don't use gina (gina/bin/cli) as a daemon
        fakeDeamonPid: false
    };


    /**
     * Validates the target version and delegates to stop().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        //if (!isCmdConfigured()) return false;

        var err = null;
        var argv = opt.argv;
        for (let i = 0, len = argv.length; i < len; i++) {
            // checkcking version number
            if ( /^\@/.test(argv[i]) ) {
                let version = argv[i].replace(/\@/, '');
                let shortVersion = version.split('.').splice(0,2).join('.');
                if ( !/^\d\.\d/.test(shortVersion) ) {
                    err = new Error('Wrong version: '+ version);
                    console.log(err.message);
                    break;
                }
                let availableVersions = requireJSON(_(GINA_HOMEDIR +'/main.json', true)).frameworks[shortVersion];
                if ( !availableVersions || availableVersions.indexOf(version) < 0 ) {
                    err = new Error('Version not installed: '+ version);
                    console.log(err.message);
                    break;
                }

                self.version = version;
                continue;
            }
        }

        if ( err ) {
            // Flush + exit non-zero instead of a bare `return`: the bare return
            // bypassed end()'s process.exit, so with the CLI's MQ listener up the
            // event loop never emptied (hang on `gina stop @<garbage>`). writeSync
            // guarantees the message survives the exit on a pipe (boot-exit-flush).
            fs.writeSync(2, err.message +'\n');
            process.exit(1);
        }
        console.debug('Stopping framework v'+ self.version);

        // if (!self.name) {
        //     stop(opt, cmd, 0);
        // } else {
            stop(opt, cmd);
        // }
    }

    /**
     * Reads PID files, sends SIGTERM/SIGKILL to the matching framework process, and exits.
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var stop = function(opt, cmd) {
        // framework:stop is daemon-only: the loop below skips every non-`gina-`
        // pidfile, so running bundles survive this stop. Snapshot them now so
        // end() can surface a non-fatal notice once the daemon is stopped.
        self.survivingBundles = collectSurvivingBundles();

        var pidFiles = null, err = null;
        try {
            pidFiles = fs.readdirSync(GINA_RUNDIR);
        } catch (fileError) {
            throw fileError
        }

        var runningVersions = [];
        for (let i=0, len=pidFiles.length; i<len; i++) {
            let file = pidFiles[i];
            if ( !/^gina\-/.test(file) ) {
                continue;
            }
            let pid = fs.readFileSync(_(GINA_RUNDIR +'/'+ file, true)).toString().trim() || null;
            new _(GINA_RUNDIR +'/'+ file, true).rmSync();

            runningVersions.push({
                title   : file.replace(/\.pid$/, ''),
                pid     : ~~pid
            });
        }
        var pid = null, fakeDaemonPid = null;
        if ( runningVersions.length > 0 && new _(GINA_HOMEDIR +'/procs.json', true).existsSync() ) {
            // retrieve running pid vs running version
            var runningProcs = requireJSON(_(GINA_HOMEDIR +'/procs.json', true));
            for (let name in runningProcs) {
                if (runningProcs[name].version == self.version) {
                    pid = runningProcs[name].pid;
                    // checking for fake daemon
                    if ( typeof(runningProcs[name].fakeDaemonPid) != 'undefined' ) {
                        fakeDaemonPid = runningProcs[name].fakeDaemonPid;
                    }
                    break;
                }
            }
            // Resume halted fake daemon process
            if (fakeDaemonPid) {
                try {
                    process.kill(fakeDaemonPid, 'SIGCONT');
                } catch (fakeDaemonErr) {
                    // this only means that it does not exists or has already been killed
                }

            }
            if (pid) {
                for (let i=0, len=runningVersions.length; i<len; i++) {
                    if (runningVersions[i].pid == pid) {
                        console.debug('Sending `SIGTERM` for pid `'+ pid +'`');
                        process.kill(pid, 'SIGTERM');
                        break;
                    }
                }

                // console.log('Gina v'+ self.version + ' has been stopped');
                // return end('Gina v'+ self.version + ' has been stopped');
                return setTimeout(() => {
                    out = execSync("ps -ef | grep -v grep | grep 'gina-v"+ self.version +"' | awk '{print $2}'").toString() || null;
                    if ( out && typeof(out) == 'string' && out.trim().length > 0) {
                        pid = out.trim();
                        process.kill(pid, 'SIGKILL');
                    }

                    return setTimeout(() => {
                        end('Gina v'+ self.version + ' has been stopped')
                    }, 100);
                }, 200);
            }
        }

        // Double check in case of a bug ...
        if ( !isWin32() ) {
            var out  = null;
            try {
                // Retrive pid
                // ps -ef | grep -v grep | grep "gina-v0.1.0" | awk '{print $2}'
                out = execSync("ps -ef | grep -v grep | grep 'gina-v"+ self.version +"' | awk '{print $2}'").toString() || null;
                if ( out && typeof(out) == 'string' && out.trim().length > 0) {
                    pid = out.trim();
                    console.debug('Found unlinked process ['+ pid +']\nNow trying to kill it ...');

                    process.kill(pid, 'SIGKILL');
                    // console.log('Gina v'+ self.version + ' has been stopped');
                    return end('Gina v'+ self.version + ' has been stopped');
                }
            } catch(execErr) {
                // Silence is golden ...
                throw execErr
            }
        }

        console.log('Gina v'+ self.version + ' is not running');
        end()
    }

    /**
     * Enumerates the run directory for bundle child-processes that will SURVIVE
     * this framework stop. `framework:stop` kills only the `gina-v<version>`
     * daemon; bundles are detached processes registered as
     * `<bundle>@<project>.pid` files under the run directory (~/.gina/run, shared
     * across framework versions). Framework-daemon pidfiles (`gina-*`), hidden
     * files, non-`.pid` files, and malformed names are skipped, and each pidfile
     * is liveness-probed via lib.cmdStatusFormat.readPidfile so only processes
     * that are actually running are returned (stale pidfiles are ignored).
     *
     * @inner
     * @private
     * @returns {Array<{bundle: string, project: string, pid: number}>} live bundles
     */
    var collectSurvivingBundles = function() {
        var out    = [];
        var runDir = (typeof(GINA_RUNDIR) != 'undefined' && GINA_RUNDIR)
            ? GINA_RUNDIR
            : (GINA_HOMEDIR + '/run');
        var files  = [];
        try {
            files = fs.readdirSync(runDir);
        } catch (e) {
            // No run directory yet -> nothing running.
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

            var runState = fmt.readPidfile(runDir, bundle, project);
            if ( !runState.running ) {
                // live only — a stale pidfile is not a surviving bundle
                continue;
            }
            out.push({ bundle: bundle, project: project, pid: runState.pid });
        }
        return out;
    }

    /**
     * Prints a non-fatal notice listing the bundles still running after the
     * framework daemon was stopped, with the commands to stop them. Called from
     * end() on a successful stop when collectSurvivingBundles() found live
     * bundles; never alters the exit code.
     *
     * @inner
     * @private
     * @param {Array<{bundle: string, project: string, pid: number}>} list
     */
    var printSurvivingBundles = function(list) {
        var str = '\n\r'+ list.length +' bundle(s) still running '
                + '(framework:stop stops the framework server only, not bundles):\n\r';
        for (var i = 0, len = list.length; i < len; i++) {
            str += '    '+ fmt.pad(list[i].bundle +'@'+ list[i].project, 24) +' pid '+ list[i].pid +'\n\r';
        }
        str += 'Stop them with `gina bundle:stop <bundle> @<project>` '
             + 'or `gina project:stop @<project>`.';
        console.log(str);
    }

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

        // daemon-only stop: surface any bundles left running (success exits only).
        if ( !err && self.survivingBundles && self.survivingBundles.length > 0 ) {
            printSurvivingBundles(self.survivingBundles);
        }

        process.exit( err ? 1:0 )
    }


    init(opt, cmd)
}

module.exports = Stop;