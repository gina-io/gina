'use strict';
/**
 * @module gina/lib/cmd/framework/start
 */
var fs      = require('fs');
// #B665 (2026-09-27) — only the removed restartRunningBunldes() used execSync.
// const {execSync}    = require('child_process');
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
 * @class Start
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {number} [opt.pid] - PID assigned to the framework server process
 */
function Start(opt){

    //Get services list.
    var self = {};

    var console = lib.logger;

    //var self = {
    //    opt : opt,
    //    cmd : 'framework:start',
    //    servicesList : list.services[opt.release]
    //};

    /**
     * Sets up the framework runtime state and cleans stale PID files.
     * @inner
     * @private
     * @param {object} opt
     */
    var init = function(opt){


        self.pid        = opt.pid;
        setEnvVar('GINA_PID', opt.pid);// jshint ignore:line
        self.projects   = require(GINA_HOMEDIR + '/projects.json');// jshint ignore:line
        self.services   = [];
        self.bundles    = [];

        cleanPIDs();
        // #B665 (2026-09-27) — restartRunningBunldes() is removed: this call was already
        // commented out (its own TODO said it did not work with execSync), and it ran
        // `bundle:restart` from a shell command line built from pid-file names. The removed
        // code is in git history.

        console.notice('Framework ready for connections\n');

    };

    /**
     * Removes stale framework PID files from GINA_RUNDIR that do not match the current PID.
     * @inner
     * @private
     */
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

    /**
     * Logs optional output and exits the process.
     * @inner
     * @private
     * @param {string|Error} [output] - Message or error to log
     * @param {string} [type] - Logger method name (e.g. 'crit', 'error', 'log')
     * @param {boolean} [messageOnly] - When true, logs only the message rather than the full stack
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

    init(opt)
}

module.exports = Start;