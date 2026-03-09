/* Gina.utils.Proc
 *
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 *
 * { name: 'SIGABRT', action: 'A', desc: 'Process abort signal.' },
 * { name: 'SIGALRM', action: 'T', desc: 'Alarm clock.' },
 * { name: 'SIGBUS', action: 'A', desc: 'Access to an undefined portion of a memory object.' },
 * { name: 'SIGCHLD', action: 'I', desc: 'Child process terminated, stopped, or continued. ' },
 * { name: 'SIGCONT', action: 'C', desc: 'Continue executing, if stopped.' },
 * { name: 'SIGFPE', action: 'A', desc: 'Erroneous arithmetic operation.' },
 * { name: 'SIGHUP', action: 'T', desc: 'Hangup.' },
 * { name: 'SIGILL', action: 'A', desc: 'Illegal instruction.' },
 * { name: 'SIGINT', action: 'T', desc: 'Terminal interrupt signal.' },
 * { name: 'SIGKILL', action: 'T', desc: 'Kill (cannot be caught or ignored).' },
 * { name: 'SIGPIPE', action: 'T', desc: 'Write on a pipe with no one to read it.' },
 * { name: 'SIGQUIT', action: 'A', desc: 'Terminal quit signal.' },
 * { name: 'SIGSEGV', action: 'A', desc: 'Invalid memory reference.' },
 * { name: 'SIGSTOP', action: 'S', desc: 'Stop executing (cannot be caught or ignored).' },
 * { name: 'SIGTERM', action: 'T', desc: 'Termination signal.' },
 * { name: 'SIGTSTP', action: 'S', desc: 'Terminal stop signal.' },
 * { name: 'SIGTTIN', action: 'S', desc: 'Background process attempting read.' },
 * { name: 'SIGTTOU', action: 'S', desc: 'Background process attempting write.' },
 * { name: 'SIGUSR1', action: 'T', desc: 'User-defined signal 1.' },
 * { name: 'SIGUSR2', action: 'T', desc: 'User-defined signal 2.' },
 * { name: 'SIGPOLL', action: 'T', desc: 'Pollable event. ' },
 * { name: 'SIGPROF', action: 'T', desc: 'Profiling timer expired. ' },
 * { name: 'SIGSYS', action: 'A', desc: 'Bad system call.' },
 * { name: 'SIGTRAP', action: 'A', desc: 'Trace/breakpoint trap. ' },
 * { name: 'SIGURG', action: 'I', desc: 'High bandwidth data is available at a socket.' },
 * { name: 'SIGVTALRM', action: 'T', desc: 'Virtual timer expired.' },
 * { name: 'SIGXCPU', action: 'A', desc: 'CPU time limit exceeded.' },
 * { name: 'SIGXFSZ', action: 'A', desc: 'File size limit exceeded. ' }
 * */


//Imports
var fs          = require('fs');
var Emitter     = require('events').EventEmitter;
var spawn       = require('child_process').spawn;
var UtilsConfig = require( _(__dirname + '/config') );
var inherits    = require( _(__dirname + '/inherits') );
var console     = require( _(__dirname + '/logger') );
//var helpers     = require( _(__dirname + '/helpers') );

//console.log('path ? ', getPaths());

/**
 * @constructor
 *
 * @param {string} bundle
 *
 * */
function Proc(bundle, proc, usePidFile){

    var self    = this;
    this.PID    = null;
    this.path   = null;
    this.master = false;//used only by master.
    this.bundle = bundle;
    this.proc   = proc;
    this.bundles = [];

    if ( typeof(usePidFile) == 'undefined') {
        var usePidFile = true
    }

    /**
     * Check target path
     * @param {string} path
     * @param {integer} PID Id of the PID to save
     * */

    var init = function() {
        //Default.
        var pathObj = new _( getPath('root') + '/tmp/pid/' );
        var path = pathObj.toString();

        //Create dir if needed.
        //console.debug("MKDIR  pathObj (pid:"+self.proc.pid+") - ", self.bundle);

        process.list = (process.list == undefined) ? [] : process.list;
        process.pids = (process.pids == undefined) ? {} : process.pids;

        self.register(self.bundle, self.proc.pid);

        if (usePidFile) {
            pathObj.mkdir( function(err, path){
                console.debug('path created ('+path+') now saving PID ' +  bundle);
                //logger.info('gina', 'PROC:INFO:1', 'path created ('+path+') now saving PID ' +  bundle, __stack);
                //Save file.
                if (!err) {
                    self.PID = self.proc.pid;
                    self.path = path + pathObj.sep;
                    //Add PID file.
                    setPID(self.bundle, self.PID, self.proc);
                    save(self.bundle, self.PID, self.proc)
                }
            })
        }
    };

    var isMaster = function() {
        return (self.master) ? true : false;
    };

    // var getShutdownConnectorSync = function(bundle) {
    //     var bundlesPath = getPath('bundlesPath');
    //     var connPath = _(bundlesPath +'/'+ bundle + '/config/connector.json');
    //     try {
    //         console.log('reading connPath: ', connPath);
    //         var content = fs.readFileSync(connPath);
    //         return JSON.parse(content).httpClient.shutdown
    //     } catch (err) {
    //         return undefined
    //     }
    // }
    /**
     * Going to force restart by third party (kill 9).
     *
     * @param {string} bundle
     * @param {string} env
     * @param {number} pid
     *
     * @callback callback
     * @param {boolean|string} err
     * */
    var respawn = function(bundle, env, pid, callback) {
        //var loggerInstance = getContext('logger');
        //loggerInstance["trace"]('Fatal error !');
        //console.debug("Exiting and re spawning : ", bundle, env);
        // TODO - Count the restarts and prevent unilimited loop
        // TODO - Send notification to admin or/and root to the Fatal Error Page.

        var root = getPath('root');
        try {
            var version = process.getVersion(bundle);
        } catch (err) {
            var bundle = process.argv[3];
            //var port = self.getBundlePortByBundleName(bundle);
            //console.log("Bundle ", bundle," already running or port[ "+port+" ] is taken by another process...");
            //loggerInstance["trace"]("Bundle [ "+ bundle +" ] already running or [ "+env+" ] port is use by another process...");
            console.debug("Bundle [ "+ bundle +" ] already running or [ "+env+" ] port is use by another process...");
            dismiss(process.pid);
        }


        var outPath = _(root + '/out.'+bundle+'.'+version+'.log');
        var errPath = _(root + '/out.'+bundle+'.'+version+'.log');
        var nodePath = getPath('node');
        var ginaPath = _(root + '/gina');

        // if (env == 'prod') { //won't loop forever for others env.
        //
        //     //var opt = process.getShutdownConnectorSync();
        //     var opt = getShutdownConnectorSync(bundle);
        //     //Should kill existing one..
        //     opt.path = '/' + bundle + '/restart/' + pid + '/' + env;
        //
        //     var HttpClient = require('gina.com').Http;
        //     var httpClient = new HttpClient();
        //
        //     if (httpClient) {
        //         //httpClient.query(opt);
        //         //We are not waiting for anything particular...do we ?
        //         httpClient.query(opt, function (err, msg) {
        //             //Now start new bundle.
        //             callback(err);
        //         });
        //     } else {
        //         var err = new Error('No shutdown connector found.');
        //         console.error(err);
        //         callback(err);
        //     }
        //
        // } else {
            callback(false);
        //}
    };

    var setPID = function(bundle, PID, proc) {

        if (bundle != 'gina') {
            proc.title = 'gina: '+ bundle;
        } else {
            proc.title = bundle;
        }

        //Set event.
        setDefaultEvents(bundle, PID, proc);
    };

    var setDefaultEvents = function(bundle, PID, proc) {


        if ( typeof(PID) != "undefined" && typeof(PID) == "number" ) {
            console.debug("setting listeners for ", PID, ':', bundle);

            proc.dismiss = dismiss;
            proc.isMaster = isMaster;


            proc.on('SIGTERM', function(code){
                proc.exit(code);
            });

            proc.on('SIGINT', function(code){

                if (code == undefined) var code = 0;
                console.info("\nGot exit code. Now killing: ", code);
                proc.exit(code);//tigger exit event.
            });

            //Will prevent the server from stopping.
            proc.on('uncaughtException', function(err) {

                console.error(err.stack);
                var bundle = self.bundle;
                //console.log("@=>", self.args);
                var env =  process.env.NODE_ENV || 'prod';
                var pid = self.getPidByBundleName(bundle);

                //Wake up buddy !.
                respawn(bundle, env, pid, function(err) {
                    //TODO - Send an email to the administrator/dev
                    //TODO - Have a delegate handler to allow the dev to do its stuff. Maybe it's already there if any dev can override.
                    //proc.exit(1) // don't kill !!! It will stop the server
                })
            });

            proc.on('exit', function(code){

                if ( typeof(code) == 'undefined') {
                    code = 0;
                }

                var bundle = self.bundle;
                var env =  process.env.NODE_ENV || 'prod';
                var pid = self.getPidByBundleName(bundle);

                //console.log('bundle ', bundle, ' vs ', pid, " => ", process.pid);

                //console.log("got exit code ", "("+code+")", pid, " VS ", pid, " <=> gina: ", process.pid);
                //code = code || 0;
                //var obj = logger.emerg('gina', 'UTILS:EMERG1', 'process exit code ' + code);
                //if (code == 0  && env != "debug" && env != "dev"/***/) {

                //for (var p=0; p<process.list.count(); p++) {
                //    dismiss(process.list[p].pid)
                //}

                // kill gina
                dismiss(process.list[process.list.count()-1].pid, "SIGKILL")
            });

            proc.on('SIGHUP', function(code){
                console.debug("Hanging up ! Code: "+ code+"\n"+ process.argv);

                var bundle = self.bundle;
                var env =  process.env.NODE_ENV || 'prod';
                var pid = self.getPidByBundleName(bundle);

                dismiss(process.pid, "SIGINT");
                dismiss(pid, "SIGINT");
            })
        }
    };


    var dismiss = function(pid, signal){
        if (pid == undefined) {
            var pid = self.PID;
        }

        try {

            for (var p in process.list) {
                fs.unlinkSync( _(self.path + process.list[p].pid) )
            }

        } catch (err) {
            //Means that it does not exists anymore.
        }
        try {
            console.debug('\n=> '+ JSON.stringify(process.list, null, 4));
            for (var p in process.list) {
                if ( process.list[p].name != 'gina' ) {
                    fs.unlinkSync( _(getPath('mountPath') + '/'  + process.list[p].name) )
                }
            }
        } catch (err) {
            //Means that it does not exists anymore.
        }

        process.kill(pid, signal);// soft...
        console.debug('\nsent '+ signal +' signal to end process [ '+ pid +' ]\n');
    };

    /**
     * Save PID file
     * @param {string} bundle
     * @param {integer} PID Id of the PID to save
     *
     * @private
     * */
    var save = function(){
        var bundle = self.bundle;
        var PID = self.PID;
        var proc = self.proc;
        var path = self.path
        //Get PID path.
        if (
            typeof(bundle) != "undefined" && bundle != ""
            && typeof(PID) != "undefined" && PID != "" && PID != null
            && typeof(proc) != "undefined" && proc != "" && proc != null
        ) {
            try {
                var fileStream = fs.createWriteStream(path + PID);
                fileStream.once('open', function(fd) {
                    fileStream.write(bundle);
                    console.debug('registered ', self.proc.pid);
                    fileStream.end();
                    self.emit('proc#complete', false)
                });
            } catch (err) {
                self.emit('proc#complete', err)
            }

        } else {
            self.emit('proc#complete', new Error('encountered troubles while trying to save Process file'))
        }
    };


    /**
     * Get PID
     * @param {string} bundle
     * @return {number} PID
     * */
    this.getPID = function(){

        try{
            return self.PID;
        } catch (err) {
            console.error('Could not get PID for bundle: '+ self.bundle + (err.stack||err.message));
            return null;
        }
    };

    this.getBundleNameByPid = function(pid){
        var list = process.list;

        for (var i=0; i<list.length; ++i) {
            //console.log("list ", list, ':',  list[i][pid]);
            if ( typeof(list[i][pid]) != "undefined")
                return list[i][pid]
        }
        return undefined
    };


    this.getPidByBundleName = function(bundle){
        var list = process.pids;
        //console.log("list ", list, ':',  list[bundle]);
        if ( typeof(list[bundle]) != "undefined")
            return list[bundle]
        else
            return undefined
    };

    this.setMaster = function(bool){
        if ( typeof(bool) == 'undefined' || bool == true) {
            self.master = true;
        } else {
            self.master = false;
        }
    };

    this.register = function(bundle, pid) {
        if ( bundle == 'gina' || bundle != 'gina' && self.bundles.indexOf(bundle) == -1 ) {
            if (bundle != 'gina') {
                self.bundles.push(bundle);
            }

            var list = {};
            list['pid'] = pid;
            list['name'] = bundle;
            process.list.push(list);//Running bundles.
            process.pids[bundle] = pid;

            list = null;
        }
    };

    this.onReady = function(cb) {
        self.once('proc#complete', function(err){
            cb(err)
        })
    }

    //Init.
    if ( typeof(this.bundle) == "undefined" ) {
        console.error('Invalid or undefined proc name . Proc naming Aborted')
    } else {
        init()
    }
};

Proc = inherits(Proc, Emitter);
module.exports = Proc;