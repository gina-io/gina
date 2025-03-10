var fs          = require('fs');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
//const { debug } = require('console');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * Framework status
 *
 * e.g.
 *  gina framework:status
 *  or
 *  gina status
 *
 * */
function Status(opt, cmd) {
    var self    = {};


    var init = function(opt, cmd) {

        console.debug('Getting framework status');

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        status(opt, cmd);
    }

    var checkUnregistered = function(pidFiles) {
        // Those not in file
        var list = execSync("ps -ef | grep -v grep | grep 'gina-v' | awk '{print $2\" \"$8\" \"$9}'").toString().replace(/\n$/, '').split(/\n/g);


        if (!list.length || list[0] == "") {
            return;
        }

        // console.debug('pids list ', list);
        for (let p=0, len=list.length; p<len; p++) {
            if ( !/^\d+\s+gina\-/.test(list[p]) ) {
                continue;
            }

            let pidArr = list[p].split(/\s/);
            let pid = pidArr[0];
            let title = pidArr[1];
            let isZombie = ( typeof(pidArr[2]) != 'undefined' && /defunct/.test(pidArr[2]) ) ? true : false;

            // remove defunct process
            if (isZombie) {
                execSync("kill -9 "+ pid);
                continue;
            }

            let file = title +'.pid';
            if ( pidFiles.indexOf( file ) < 0) {
                fs.writeFileSync( _(GINA_RUNDIR +'/'+ file, true), pid );
                pidFiles.push(title +'.pid');
            }
        }

    }

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
                try {
                    let found = execSync("ps -a "+ pid).toString().replace(/\n$/, '').split(/\n/g);
                } catch (err) {
                    console.debug('file to remove: '+ _(GINA_RUNDIR +'/'+ file));
                    fs.unlinkSync(_(GINA_RUNDIR +'/'+ file));
                    continue;
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