var fs          = require('fs');
const {spawn}       = require('child_process');
// #B665 S2 (2026-09-27) — no shell: the daemons are listed through inc/ps-titles.js, and a pid's
// liveness is checked with process.kill(pid, 0).
// const {execSync}    = require('child_process');
//const { debug } = require('console');

var CmdHelper   = require('./../helper');
var psTitles    = require('./inc/ps-titles');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/framework/status
 */
/**
 * Displays the running status of the Gina framework and its versions.
 *
 * Usage:
 *  gina framework:status
 *  gina status
 *
 * @class Status
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Status(opt, cmd) {
    var self    = {};


    /**
     * Imports CmdHelper and delegates to status().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var init = function(opt, cmd) {

        console.debug('Getting framework status');

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        status(opt, cmd);
    }

    /**
     * Discovers the current user's framework daemons (`gina-v<version>` titles)
     * that are not tracked by PID files and writes PID files for them, or kills
     * any zombie processes. The listing comes from `inc/ps-titles.js`, which runs
     * `ps` without a shell and accepts only a daemon title (#B677).
     * @inner
     * @private
     * @param {string[]} pidFiles - Array of PID filenames already found in GINA_RUNDIR
     */
    var checkUnregistered = function(pidFiles) {
        // Those not in file
        // #B677 (2026-09-27) — the current user's processes only, and a daemon title only:
        // `ps -ef` listed every user's processes, and any `gina-`-titled process's title became
        // a pid-file name that `_()` normalises, so `gina-v/../../x` wrote outside the run
        // directory. `ps` runs from an argument vector (#B665 S2).
        // was: var list = execSync("ps -ef | grep -v grep | grep 'gina-v' | awk '{print $2\" \"$8\" \"$9}'").toString().replace(/\n$/, '').split(/\n/g);
        var list = psTitles.listOwnDaemons();

        // console.debug('pids list ', list);
        for (let p=0, len=list.length; p<len; p++) {
            let pid = list[p].pid;
            let title = list[p].title;

            // remove defunct process
            if (list[p].zombie) {
                // was: execSync("kill -9 "+ pid);
                try {
                    process.kill(pid, 'SIGKILL');
                } catch (killErr) {
                    console.debug('Could not signal defunct process '+ pid +': '+ killErr.message);
                }
                continue;
            }

            let file = title +'.pid';
            if ( pidFiles.indexOf( file ) < 0) {
                // a string: writeFileSync refuses a number
                fs.writeFileSync( _(GINA_RUNDIR +'/'+ file, true), ''+ pid );
                pidFiles.push(title +'.pid');
            }
        }

    }

    /**
     * Reads PID files and prints running framework versions to the logger. On
     * macOS and Linux a pid is running when `process.kill(pid, 0)` succeeds or
     * fails with EPERM; any other pid file is removed.
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var status = function(opt, cmd) {
        var pidFiles = null;
        try {
            pidFiles = fs.readdirSync(GINA_RUNDIR);
        } catch (fileError) {
            throw fileError
        }
        checkUnregistered(pidFiles);
        console.debug('Reading `'+ GINA_RUNDIR +'` ',pidFiles);

        var runningVersions = [], runningLog = '';
        for (let i=0, len=pidFiles.length; i<len; i++) {
            let file = pidFiles[i];
            if ( !/^gina\-/.test(file) ) {
                continue;
            }
            let pid = fs.readFileSync(_(GINA_RUNDIR +'/'+ file)).toString().trim() || null;
            if (!pid) {
                continue;
            }

            if ( !isWin32() ) {
                // #B665 S2 (2026-09-27) — liveness in-process, as framework:init's checkRunningPids:
                // the pid file's content reached `ps -a <content>` through sh, and on a host
                // without `ps` (a slim container image) every live framework pid file was
                // removed. EPERM means alive (another user's process); ESRCH, or content that is
                // not a pid, removes the file, as a failing `ps -a` did.
                // was: let found = execSync("ps -a "+ pid).toString().replace(/\n$/, '').split(/\n/g);
                var n = psTitles.parsePid(pid);
                try {
                    if (n === null) {
                        throw new Error('not a pid: '+ pid);
                    }
                    process.kill(n, 0);
                } catch (err) {
                    if ( !err || err.code !== 'EPERM' ) {
                        console.debug('file to remove: '+ _(GINA_RUNDIR +'/'+ file));
                        fs.unlinkSync(_(GINA_RUNDIR +'/'+ file));
                        continue;
                    }
                }
            }


            runningVersions.push({
                title   : file.replace(/\.pid$/, ''),
                pid     : ~~pid
            });

            let version = file.replace(/^gina\-/, '').replace(/\.pid$/, '');
            runningLog +=  '['+ ~~pid+'] Running: '+ version;
            if (version == 'v'+GINA_VERSION ) {
                runningLog += ' (default)'
            }
            runningLog += '\n';
        }


        if ( runningVersions.length > 0 ) {
            console.log(runningLog);
            return end()
        }

        console.log('Gina is not running');
        end();
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

        process.exit( err ? 1:0 )
    }


    init(opt, cmd)
}

module.exports = Status;