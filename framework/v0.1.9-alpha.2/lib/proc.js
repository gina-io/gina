/* Gina.lib.Proc
 *
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
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
var LibConfig   = require( _(__dirname + '/config') );
var inherits    = require( _(__dirname + '/inherits') );
var console     = require( _(__dirname + '/logger') );
var Collection  = require( _(__dirname + '/collection') );
var generator   = require( _(__dirname + '/generator') );
//var helpers     = require( _(__dirname + '/helpers') );

/**
 * @module lib/proc
 * @description Process manager — spawns, monitors, and manages child bundle
 * processes using PID files. Extends EventEmitter.
 */

/**
 * Bundle process manager.
 *
 * @class Proc
 * @constructor
 * @this {Proc}
 * @extends EventEmitter
 *
 * @param {string}  bundle       - Bundle name
 * @param {object}  [proc]       - Existing process descriptor to attach to
 * @param {boolean} [usePidFile] - Write/read PID from a file (default: true)
 */
function Proc(bundle, proc, usePidFile){

    var e       = new Emitter();

    if ( typeof(usePidFile) == 'undefined') {
        usePidFile = true
    }

    //default path to store pid files.
    var pathObj = new _( GINA_RUNDIR );

    var self    = {
        PID         : proc.pid,
        path        : null,
        master      : false, //used only by master.
        bundle      : bundle,
        bundles     : [],
        proc        : proc,
        usePidFile  : usePidFile
    };

    /**
     * Init process handler
     * */
    var init = function() {

        process.list = (process.list == undefined) ? [] : process.list;
        process.pids = (process.pids == undefined) ? {} : process.pids;

        self.register(self.bundle, self.proc.pid);
    };

    var isMaster = function() {
        return (self.master) ? true : false;
    };


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
        //console.debug('[ PROC ] Exiting and re spawning : ', bundle, env);
        // TODO - Count the restarts and prevent unilimited loop
        // TODO - Send notification to admin or/and root to the Fatal Error Page.

        try {
            var version = process.getVersion(bundle);
        } catch (err) {
            bundle = process.argv[3];
            //var port = self.getBundlePortByBundleName(bundle);
            //console.debug('[ PROC ] Bundle ', bundle,' already running or port[ '+port+' ] is taken by another process...');
            //loggerInstance["trace"]("Bundle [ "+ bundle +" ] already running or [ "+env+" ] port is use by another process...");
            console.debug('[ PROC ] Bundle [ '+ bundle +' ] already running or [ '+env+' ] port is use by another process');
            dismiss(process.pid);
        }

        callback(false);
    };

    var setPID = function(bundle, PID, proc) {

        if ( !/^gina\-/.test(bundle) ) {
            proc.title = 'gina: '+ bundle;
        } else {
            proc.title = bundle;
        }

        //Set event.
        setDefaultEvents(bundle, PID, proc);
    };

    var setDefaultEvents = function(bundle, PID, proc) {


        if ( typeof(PID) != 'undefined' && typeof(PID) == 'number' ) {

            console.debug('[ PROC ] Setting listeners for ', PID, ':', bundle);

            proc.dismiss = dismiss;
            proc.isMaster = isMaster;


            // Fixed: signal handlers receive the signal name (string), not a numeric code.
            // Node.js 25+ enforces process.exit() argument as number.
            // Using 128+signo (Unix convention) instead of passing the signal string.
            // Was: proc.on('SIGTERM', function(code){ ... proc.exit(code); });
            proc.on('SIGTERM', function(){
                // Graceful shutdown: stop accepting new connections, drain in-flight
                // requests, then exit. Hard timeout prevents lingering on stuck requests.
                // process.server is set by server.js at listen() time.
                // Tune the drain window via GINA_SHUTDOWN_TIMEOUT (ms). Default: 10s.
                // K8s terminationGracePeriodSeconds (default 30s) should be set above
                // this value to give the drain window time to complete before SIGKILL.
                var _shutdownMs = parseInt(process.env.GINA_SHUTDOWN_TIMEOUT) || 10000;
                var _httpServer = proc.server || null;
                if (_httpServer && typeof _httpServer.close === 'function') {
                    var _shutdownTimer = setTimeout(function() {
                        console.warn('[ PROC ] Graceful shutdown timed out (' + _shutdownMs + 'ms), forcing exit');
                        proc.exit(143);
                    }, _shutdownMs);
                    // unref: do not keep the event loop alive for the timer alone —
                    // if the server drains before the timeout, the process can exit cleanly.
                    if (typeof _shutdownTimer.unref === 'function') _shutdownTimer.unref();
                    // Close idle keep-alive connections immediately (Node 18.2+ http.Server).
                    // Avoids waiting for client-side keep-alive timeouts (up to 60-120s).
                    // No-op on http2.Server and older Node versions where the method is absent.
                    if (typeof _httpServer.closeIdleConnections === 'function') {
                        _httpServer.closeIdleConnections();
                    }
                    _httpServer.close(function() {
                        clearTimeout(_shutdownTimer);
                        proc.exit(143); // 128 + 15 (SIGTERM)
                    });
                } else {
                    // Server not yet up (crash during startup) — exit immediately.
                    proc.exit(143); // 128 + 15 (SIGTERM)
                }
            });

            // Was: proc.on('SIGABRT', function(code){ ... proc.exit(code); });
            proc.on('SIGABRT', function(){
                // will handle `dismiss()`
                proc.exit(134); // 128 + 6 (SIGABRT)
            });


            // Was: proc.on('SIGINT', function(code){ ... proc.exit(code); });
            proc.on('SIGINT', function(signal){

                console.warn('[ PROC ] Got signal. Now killing: ', signal);
                // will handle `dismiss()`
                proc.exit(130); // 128 + 2 (SIGINT)
            });

            // proc.on('heapOutOfMemory', function(err) {
            //     console.emerg('[ FRAMEWORK ][ caughtException ][ '+err.code+' ] ', err.stack);
            // });

            //Will prevent the server from stopping, exepted for `heap out of memory`.
            proc.on('uncaughtException', function(err) {

                if ( /ERR\_HTTP\_HEADERS\_SENT/.test(err.stack) ) {
                    console.error('[ SERVER ][ HTTP UNCAUGHT EXCEPTION ]', err.stack);
                    return false;
                }

                if ( /ERR\_HTTP2/.test(err.stack) ) {
                    console.warn('[ SERVER ][ HTTP2 UNCAUGHT EXCEPTION ]', err.stack);
                    return false;
                }

                if (
                    // Docker network issue
                    /^ENOTFOUND$/.test(err.code)
                    && new RegExp('/getaddrinfo\ ENOTFOUND '+ process.gina.PROXY_HOST +'/').test(err.stack)
                ) {
                    console.warn('[ SERVER ][ UNCAUGHT NETWORK EXCEPTION ] If you are running your project with Docker Engine, please consider checking your dns settings (~/.docker/daemon.json) by making sure the ip of your dns server is listed to avoid latencies.');
                }

                // ECONNRESET/EPIPE are normal TCP lifecycle events — a client or peer
                // dropped the connection. Treat as warnings, never kill the bundle over this.
                // Previously commented out; restored because missing session.on('error') in
                // server.isaac.js could leak these as uncaughtException in non-gina-v bundles.
                // NOTE: EPIPE must use proc.stdout.write — calling console.warn when the logger
                // pipe is broken causes an infinite loop (warn → broken pipe → EPIPE → warn...).
                if ( /ECONNRESET/.test(err.code) ) {
                    console.warn('[ SERVER ][ ECONNRESET UNCAUGHT EXCEPTION ]', err.message);
                    return false;
                }
                if ( /EPIPE/.test(err.code) ) {
                    proc.stdout.write('[ SERVER ][ EPIPE UNCAUGHT EXCEPTION ] ' + err.message + '\n');
                    return false;
                }

                //console.debug("[ PROC ] @=>", self.args);
                var bundle = self.bundle;
                var pid = self.getPidByBundleName(bundle);
                // Do not dissmis the framework
                if ( /^gina\-v/.test(bundle) ) {
                    if ( err.code == 'EPIPE' ) {
                        proc.stdout.write(err.stack);
                        return;
                    }
                    console.warn('[ FRAMEWORK ][ uncaughtException ] ', err.stack);
                    return;
                }

                console.emerg('[ FRAMEWORK ][ uncaughtException ][ '+err.code+' ] ', err.stack);


                dismiss(pid, 'SIGTERM');


                // TODO - Wake up buddy !.
                //respawn(bundle, env, pid, function(err) {
                    //TODO - Send an email to the administrator/dev
                    //TODO - Have a delegate handler to allow the dev to do its stuff. Maybe it's already there if any dev can override.
                    //proc.exit(1) // don't kill !!! It will stop the server
                //})
            });

            proc.on('exit', function(code){

                if ( typeof(code) == 'undefined') {
                    code = 0;
                }


                // var bundle = self.bundle;
                // var env =  process.env.NODE_ENV || 'prod';
                // var pid = self.getPidByBundleName(bundle);


                // var currentProcess = process.list[process.list.count()-1];
                // if ( typeof(currentProcess) != 'undefined' ) {
                //     console.debug('Removing `currentProcess.pid`: ', currentProcess.pid);
                //     dismiss(currentProcess.pid, "SIGKILL")
                // }
                console.debug('Dismissing ['+ this.pid+'] with [SIGTERM]');
                dismiss(this.pid, "SIGTERM")
            });

            proc.on('SIGHUP', function(code){
                console.debug('[ FRAMEWORK ] Hanging up ! Code: '+ code +'\n'+ process.argv);

                var bundle = self.bundle;
                var pid = self.getPidByBundleName(bundle);

                dismiss(process.pid, "SIGINT");
                dismiss(pid, "SIGINT");
            })
        }
    };


    var dismiss = function(pid, signal){
        if (pid == undefined) {
            pid = self.PID;
        }
        var index       = null
            , mountPath = null
        ;
        try {
            //console.debug('[ PROC ] => '+ JSON.stringify(process.list, null, 4));

            for (let p in process.list) {
                if ( typeof(process.list[p]) == 'undefined' || process.list[p] == null )
                    continue;


                if ( process.list[p].pid == pid &&  !/^gina\-/.test(process.list[p].name) ) {
                    index       = p;

                    try {
                        // console.debug('removePidFileSync: ['+ process.list[p].pid +']');
                        removePidFileSync(process.list[p].pid);
                        if ( typeof(process.isMinion) == 'undefined' ) {
                            mountPath   =  _(getPath('mountPath') + '/' + process.list[p].name);
                            if ( fs.existsSync(mountPath) )
                                fs.unlinkSync( mountPath );
                        }
                        // soft kill..
                        process.kill(pid, signal);
                    } catch (err) {
                        console.warn('[ PROC ] Could not unmount process file `'+process.list[p].name+'`\n'+ err.stack);
                    }


                } else if ( process.list[p].pid == pid && /^gina\-/.test(process.list[p].name) ) {
                    index       = p;
                    removePidFileSync(process.list[p].pid);
                    removeRunningProc(process.list[p].pid);
                }
            }
        } catch (err) {
            //Means that it does not exists anymore.
            console.debug('[ PROC ] ', err.stack)
        }

        if (index != null)
            delete process.list[index];

        console.debug('[ PROC ] Received '+ signal +' signal to end process [ '+ pid +' ]');



        // handles only signals that cannot be cannot be caught or ignored
        if ( /^(SIGKILL|SIGSTOP|SIGABRT)$/i.test(signal) ) {
            removePidFileSync(pid);
        }
    };

    var removePidFileSync = function(pid) {
        var files = fs.readdirSync( GINA_RUNDIR );
        var pidPath = null;
        for ( let i=0, len=files.length; i<len; i++) {
            let file = files[i];
            if (!/\.pid$/.test(file)) {
                continue;
            }
            let id = fs.readFileSync( _(GINA_RUNDIR +'/'+ files[i], true) ).toString().trim();
            if (~~id == pid) {
                pidPath = _(GINA_RUNDIR +'/'+ files[i], true);
                break;
            }
        }
        if (pidPath) {
            fs.unlinkSync( pidPath );
        }
    }

    /**
     * Save PID file
     * @param {string} bundle
     * @param {integer} PID Id of the PID to save
     *
     * @private
     * */
    var save = function(){
        var bundle  = self.bundle
            , PID   = self.PID
            , proc  = self.proc
            , path  = self.path
            , file  = null
        ;

        //Get PID path.
        if (
            typeof(bundle) != "undefined" && bundle != ''
            && typeof(PID) != "undefined" && PID != '' && PID != null
            && typeof(proc) != "undefined" && proc != '' && proc != null
        ) {
            try {
                file = proc.title.replace(/^gina\:\s+/, '');
                // if ( !/^gina-/.test(file) ) {
                //     e.emit('proc#registered', file);
                // }
                file += '.pid';

                console.debug('[ PROC ] Now saving `'+file+'`');
                var fileStream = fs.createWriteStream(path + file);
                fileStream.once('open', function(fd) {
                    //fileStream.write(bundle);
                    fileStream.write(''+PID);
                    fileStream.end();
                    e.emit('proc#complete-'+self.PID, false, PID)
                });
                fileStream.once('error', function(err) {
                });
            } catch (err) {
                e.emit('proc#complete-'+self.PID, err)
            }

        } else {
            e.emit('proc#complete-'+self.PID, new Error('encountered troubles while trying to save Process [ '+ proc.title +' ] pid file'))
        }
    };

    var saveRunningProc = function(bundle) {

        var runningProcsPath = _(GINA_HOMEDIR + '/procs.json', true)
            , runningProcsPathObj = new _(runningProcsPath)
            , runningProcs = {}
            , proc  = self.proc
            , PID   = self.PID
        ;

        if ( runningProcsPathObj.existsSync() ) {
            runningProcs = requireJSON(runningProcsPath);
        }

        if ( typeof(runningProcs[bundle]) == 'undefined' ) {
            runningProcs[bundle] = {}
        }
        runningProcs[bundle].pid        = PID;
        runningProcs[bundle].title      = proc.title;
        runningProcs[bundle].version    = GINA_VERSION;
        runningProcs[bundle].port       = ~~GINA_PORT;

        var argvStr = process.argv.join(',');
        if ( /\-\-fake\-daemon\-pid/.test(argvStr) ) {
            runningProcs[bundle].fakeDaemonPid = ~~(argvStr.match(/\-\-fake\-daemon\-pid\=\d+/)[0].split(/\=/)[1])
        }

        generator.createFileFromDataSync( JSON.stringify(runningProcs, null, 2), runningProcsPath);
    }

    var removeRunningProc = function(pid) {
        var runningProcsPath = _(GINA_HOMEDIR + '/procs.json', true)
            , runningProcsPathObj = new _(runningProcsPath)
            , runningProcs = {}
        ;
        if ( runningProcsPathObj.existsSync() ) {
            runningProcs = requireJSON(runningProcsPath);
            for (let name in runningProcs) {
                if (runningProcs[name].pid == pid) {
                    delete runningProcs[bundle];
                    generator.createFileFromDataSync( JSON.stringify(runningProcs, null, 2), runningProcsPath);
                    break;
                }
            }
        }
    }


    /**
     * Get PID
     * @param {string} bundle
     * @returns {number} PID
     * */
    self.getPID = function(){

        try{
            return self.PID;
        } catch (err) {
            console.error('[ PROC ] Could not get PID for bundle: '+ self.bundle + (err.stack||err.message));
            return null;
        }
    };

    self.getBundleNameByPid = function(pid){

        var list = process.list;

        for (var i=0; i<list.length; ++i) {
            if ( typeof(list[i][pid]) != 'undefined' )
                return list[i][pid]
        }
        return undefined
    };


    self.getPidByBundleName = function(bundle){

        var list = process.pids;

        if ( typeof(list[bundle]) != 'undefined')
            return list[bundle]
        else
            return undefined
    };

    self.setMaster = function(bool){

        if ( typeof(bool) == 'undefined' || bool == true) {
            self.master = true;
        } else {
            self.master = false;
        }
    };

    self.register = function(bundle, pid) {

        var processCollection = new Collection(process.list);
        var existingProcess = processCollection.findOne({ name: bundle, pid: pid });
        // cleanup if found;
        if (existingProcess) {
            process.list = processCollection.delete({ name: bundle, pid: pid }, 'pid').toRaw();
            dismiss(existingProcess.pid);
            console.debug('[ PROC ] Don\'t pannic ...');
            existingProcess = null;
            return;
        }



        if ( /^gina\-/.test(bundle) || !/^gina\-/.test(bundle) && self.bundles.indexOf(bundle) < 0 ) {
            console.debug('[ PROC ] Now registering `'+bundle+'` with PID `'+ pid +'`');


            var list = {};

            var processRegistration = function () {

                if (!/^gina\-/.test(bundle) && !existingProcess) {
                    self.bundles.push(bundle);
                }
                // save to ~/.gina/procs.json
                else if (/^gina\-/.test(bundle)) {
                    saveRunningProc(bundle)
                }

                list['pid']     = pid;
                list['name']    = bundle;
                process.list.push(list);//Running bundles.
                setContext('process.list', process.list);
                process.pids[bundle] = pid;

                list = null;

                //isBundleMounted(projects, bundlesPath, getContext('bundle'));
            };

            var isReplacementNeeded = false, path = _(pathObj.toUnixStyle(), true);
            if ( self.usePidFile && !pathObj.existsSync() ) {
                try {
                    pathObj.mkdirSync();
                    console.debug('[ PROC ] Path created ('+ path +')');
                    isReplacementNeeded = true;
                } catch (pathErr) {
                    throw pathErr
                }
            }

            if (self.usePidFile) {
                // save file
                if (!isReplacementNeeded) {
                    self.PID    = self.proc.pid;
                    self.path   = path + pathObj.sep;
                    //Add PID file.
                    setPID(bundle, self.PID, self.proc);
                    save(bundle, self.PID, self.proc);
                }
            }

            processRegistration()
        }
    };

    self.dismiss = dismiss;

    self.onReady = function(cb) {
        e.once('proc#complete-'+self.PID, function(err, pid){
            cb(err, pid)
        })
    }

    //init
    if ( typeof(self.bundle) == "undefined" ) {
        console.error('[ PROC ] Invalid or undefined proc name . Proc naming Aborted');
        process.exit(1)
    } else {
        init()
    }

    return self
}
module.exports = Proc;