'use strict';
var fs      = require('fs');
const {execSync}    = require('child_process');
var help    = require( getPath('gina').root + '/utils/helper');// jshint ignore:line
// var child   = require('child_process');
var lib     = require( getPath('gina').lib );// jshint ignore:line
//var helpers     = require( getPath('gina').helpers );
var console = lib.logger;
/**
 * Framework start command - Needs to be launched as [sudo], [admin] or [root]
 *
 * NB.: Another alternative is to set appropriate permissions for `/var/run/gina`
 * e.g. if you have a `gina` user in the `www-data` group
 *  $ sudo mkdir /var/run/gina
 *  $ sudo chown -R gina:www-data /var/run/gina
 *
 * @param {object} opt - Constructor options
 * */
function Start(opt){

    //Get services list.
    var self = {};

    var console = lib.logger;

    //var self = {
    //    opt : opt,
    //    cmd : 'framework:start',
    //    servicesList : list.services[opt.release]
    //};

    var init = function(opt){


        self.pid        = opt.pid;
        setEnvVar('GINA_PID', opt.pid);// jshint ignore:line
        self.projects   = require(GINA_HOMEDIR + '/projects.json');// jshint ignore:line
        self.services   = [];
        self.bundles    = [];

        cleanPIDs();
        // restartRunningBunldes();

        console.notice('Framework ready for connections\n');

    };

    // TODO  - not working with execSync ... should try with spawn, like or restart
    var restartRunningBunldes = function() {
        var list = fs.readdirSync(_(GINA_RUNDIR, true));// jshint ignore:line
        for (let i=0, len=list.length; i<len; i++ ) {
            let file = list[i];
            if (/^\./.test(file) || !/\.pid$/.test(file) || /^gina\-/.test(file) || /(minion)/.test(file) ) {
                continue;
            }
            // process.stdout.write('\ngina bundle:restart '+ file.replace(/\.pid$/, '').replace(/\@/, ' @') + '\n');
            execSync('gina bundle:restart '+ file.replace(/\.pid$/, '').replace(/\@/, ' @'));
        }
    }

    var cleanPIDs = function() {
        var f = 0
            , path = _(GINA_RUNDIR)// jshint ignore:line
            , files = null
        ;

        if ( fs.existsSync( path ) ) {
            try {

                files = fs.readdirSync( path );

            } catch (err) {
                return end(err, 'crit')
            }


            for (;f < files.length; ++f) {

                // skip all but framework pid files
                if ( files[f] != process.title +'.pid' ) {
                    continue;
                }

                let filePid = null;
                try {
                    filePid = fs.readFileSync(_(path +'/'+ files[f], true)).toString().trim();// jshint ignore:line
                } catch(fileErr) {
                    fs.unlinkSync(_(path +'/'+ files[f], true));// jshint ignore:line
                    continue;
                }
                // remove old framework pid files
                if (filePid && filePid != self.pid) {
                    try {
                        new _(path +'/'+ files[f]).rmSync()// jshint ignore:line
                    } catch(err) {
                        return end(err)
                    }
                }
            }
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

    init(opt)
}

module.exports = Start;