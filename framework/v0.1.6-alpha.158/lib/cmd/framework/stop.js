var fs          = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
//const { debug } = require('console');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * Framework stop
 *
 * e.g.
 *  gina framework:stop
 *  or
 *  gina stop
 *  or
 *  gina stop @1.0.0
 *
 * */
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
                if ( availableVersions.indexOf(version) < 0 ) {
                    err = new Error('Version not installed: '+ version);
                    console.log(err.message);
                    break;
                }

                self.version = version;
                continue;
            }
        }

        if ( err ) {
            return;
        }
        console.debug('Stopping framework v'+ self.version);

        // if (!self.name) {
        //     stop(opt, cmd, 0);
        // } else {
            stop(opt, cmd);
        // }
    }

    var stop = function(opt, cmd) {
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

module.exports = Stop;