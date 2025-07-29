var fs          = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
const util = require('util');

var CmdHelper   = require('./../helper');
// const { start } = require('repl');
var console     = lib.logger;
/**
 * Framework restart
 *
 * e.g.
 *  gina framework:restart
 *  or
 *  gina restart
 *  or
 *  gina restart @1.0.0
 *
 * */
function Restart(opt, cmd) {
    var self    = {
        // Current version of the framework by default
        // But can be overriden with argument: @{version_number}
        // eg.: gina stop @1.0.0
        version: GINA_VERSION
    };


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
                return;
            }
            var availableVersions = requireJSON(_(GINA_HOMEDIR +'/main.json', true)).frameworks[shortVersion];
            if ( availableVersions.indexOf(version) < 0 ) {
                err = new Error('Version not installed: '+ version);
                console.log(err.message);
                return;
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

    var restart = function(opt, cmd) {
        stop();
        // if previous debug session
        setTimeout(() => {

            // METHOD #1
            // start(opt);


            // METHOD #2
            // TODO - retrieve & add `opt`
            var out = null;
            try {
                out = execSync('gina start @'+self.version).toString();
                console.debug('out => ', out);
                // TODO - retrieve running bundles with its options & restart
            } catch (err) {
                throw err;
            }
        }, 100);

    }

    var stop = function() {
        var out = null;
        try {
            out = execSync('gina stop @'+self.version).toString();
            console.debug('out => ', out);
        } catch (err) {
            throw err;
        }
    }

    /**
     * start
     *
     * We need to spawn this one as detached
     * because of the `process.kill(..., 'SIGABRT')` used inside the orginal `start` script
     * or else, the restart script will be pending forever.
     */
    var start = async function(opt) {
        console.debug('continue with start now');
        try {
            // var child = spawn('gina', ['start', '@'+self.version],
            var child = spawn('gina', ['start', '@'+self.version, '--restart-pid='+ process.pid],
                {
                    detached: true
                }
            );

            var frameworkPid = null;
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', function(data) {
                //process.stdout.write(data);
                if ( new RegExp('Gina server started with PID','gi').test(data) ) {
                    restartRunningBunldes();
                    frameworkPid = data.match(/\`\d+\`/)[0];
                    process.stdout.write('Gina server started with PID '+ frameworkPid + '\r\n');
                }

                if ( /\[ quit \]/.test(data) ) {
                    // TODO - restart all running bundles
                    end()
                }
            });

            child.stderr.setEncoding('utf8');
            var error = null;
            child.stderr.on('data', function(err) {
                error = err.toString();
                console.error(error);
            });

        } catch (err) {
            throw err;
        }
    }

    var restartRunningBunldes = function() {
        var list = fs.readdirSync(_(GINA_RUNDIR, true));
        for (let i=0, len=list.length; i<len; i++ ) {
            let file = list[i];
            if (/^\./.test(file) || !/\.pid$/.test(file) || /^gina\-/.test(file) || /(minion)/.test(file) ) {
                continue;
            }
            // process.stdout.write('\ngina bundle:restart '+ file.replace(/\.pid$/, '').replace(/\@/, ' @') + '\n');
            execSync('gina bundle:restart '+ file.replace(/\.pid$/, '').replace(/\@/, ' @'));
        }
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

module.exports = Restart;