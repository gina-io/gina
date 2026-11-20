var fs              = require('fs');
var os              = require("os");
var path            = require('path');
var EventEmitter    = require('events').EventEmitter;
var spawn           = require('child_process').spawn;

var console         = require('../lib/logger');

module.exports = function () {

	 /**
     * Run a command on the local cli.
     *
     * Could also be used to open an url but need some tweaking
     * // sample of a cross platform `open` command
     *  e.g.: var openCmd = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
     *
     * Delivery is either the positional `cb` or the fluent `.onComplete(cb)` on
     * the returned emitter; both are type-checked at the caller's line (#B491):
     * a non-function used to be accepted, the command ran to completion, and the
     * resulting `callback is not a function` was caught by the close handler's
     * try/catch and only logged — the caller never heard back.
     *
     * The child's stdout and stderr are captured in `out.log` / `err.log` inside a
     * private per-run directory created under `opt.tmp` (the system tmp dir by
     * default), read back on exit and removed with it; a failure while reading
     * them back is delivered as the run's error (#B664).
     *
     * @param {array|string} cmdline - Command and arguments (a string is split on spaces)
     * @param {object} [opt] - `cwd` (the process chdirs to it), `tmp` (base of the private per-run log dir — see below), `verbose`
     * @param {function} [cb] - Positional completion callback `(err, output)`; `null`/`undefined` = use `.onComplete()`
     * @returns {EventEmitter} The run emitter — `.onData(cb)`, `.onComplete(cb)`, both chainable
     * @throws {TypeError} When `cb` is neither a function nor `null`/`undefined`
     *
     * @example
     * run('ls -la', { cwd: process.cwd() }).onComplete(function(err, out) {
     *     if (err) return console.error(err);
     *     console.log(out);
     * });
     * */
	run = function(cmdline, opt, cb) {
        // #B491 — fail fast at the caller's line, before the chdir, the log
        // files and the spawn: a truthy non-function reached `cb(error, result)`
        // inside the close handler's try/catch and was merely logged.
        if ( cb != null && typeof(cb) != 'function' ) {
            throw new TypeError('run — callback expects a function, got ' + typeof(cb));
        }

		var pathArr = (new _(__dirname).toUnixStyle().split(/\//g));
		var root =  pathArr.splice(0, pathArr.length-6).join('/');

        opt = opt || {};
        if (!opt.cwd) {
            opt.cwd = root;
        }
        process.chdir(opt.cwd);


        var tmp = opt.tmp || os.tmpdir() || process.cwd();

        if ( !fs.existsSync(tmp) ) {
            fs.mkdirSync(tmp, { recursive: true })
        }

        // #B664 / #B702 — a PRIVATE per-run directory under `tmp` for the two log
        // files (unpredictable name, mode 0700, removed with them at close): the
        // fixed `<tmp>/out.log` + `err.log` pair was shared by every concurrent
        // run, and in a shared /tmp another local user could create it first.
        var runDir  = fs.mkdtempSync(path.join(tmp, 'gina-run-'));
        var outFile = _(runDir + '/out.log');
        var errFile = _(runDir + '/err.log');
        var out = fs.openSync(outFile, 'a');
        var err = fs.openSync(errFile, 'a');

        var result, error = false;
        var hasCalledBack = false;
        var e = new EventEmitter();

        e.onData = function(callback) {
            e.once('run#data', callback);

            e.once('run#err', callback);

            return e
        }

        e.onComplete = function(callback) {
            // #B491 — fail fast at the caller's line, mirroring Controller::store
            // (#B480) and Controller::query (#B485): a non-function used to register
            // a listener whose call threw inside the close handler's try/catch and
            // came out as a logged `callback is not a function` — never delivered.
            if ( typeof(callback) != 'function' ) {
                throw new TypeError('run — onComplete expects a function, got ' + ( callback === null ? 'null' : typeof(callback) ));
            }
            e.once('run#complete', function(err, data) {
                callback(err, data);
            });

            return e
        };

        //console.log( opt.cwd );
        //console.log( 'running ', cmdline);

        var cmd;
        // cmdline must be an array !!
        if (typeof(cmdline) == 'string') {
            cmdline = cmdline.split(' ')
        }

        console.debug('opt.outToProcessSTD => ', opt.outToProcessSTD);
        if ( typeof(opt) != 'undefined' && typeof(opt.outToProcessSTD) != 'undefined' && /^true$/i.test(opt.outToProcessSTD) ) {
            // mainly used for task like `npm install`. This is not the default setup
            cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: opt.cwd, stdio: [ process.stdin, process.stdout, process.stderr ] });
        } else {
            cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: opt.cwd, stdio: [ 'ignore', out, err ] });
        }
        cmd.on('stdout', function(data) {
            var str = data.toString();
            var lines = str.split(/(\r?\n)/g);
            result = lines.join('');
            console.log('out: ', result);

            e.emit('run#data', result)
        });

        // Errors are readable in the onComplete callback
        cmd.on('stderr', function (err) {
            var str = err.toString();
            error = str || false;
            console.log('err: ', error);

            e.emit('run#err', error)
        });

        // cmd.on('exit', function (code){
        //     console.debug('exiting with code '+ code +' ....');
        // });

        cmd.on('close', function (code) {

            // #B664 — read both logs, then ALWAYS release the descriptors and the
            // private directory, and ALWAYS deliver the completion: a throw in here
            // used to be caught below and only logged, so the caller waited forever.
            var error = false, data;
            try {
                error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : false;
                data  = ( fs.existsSync(outFile) ) ? fs.readFileSync(outFile).toString() : undefined;
            } catch (readErr) {
                error = readErr.stack || String(readErr);
            } finally {
                try { fs.closeSync(err) } catch (closeErr) { /* already closed */ }
                try { fs.closeSync(out) } catch (closeErr) { /* already closed */ }
                try {
                    fs.rmSync(runDir, { recursive: true, force: true });
                } catch (rmErr) {
                    console.error(rmErr.stack)
                }
            }

            try {
                if (error) {
                    cmd.emit('stderr', Buffer.from(error))
                }
                if ( data ) {
                    cmd.emit('stdout', Buffer.from(data))
                }
            } catch (listenerErr) {
                // a throwing `onData` listener is logged, and the completion below still runs
                console.error(listenerErr.stack)
            }

            if (error == '') {
                error = false
            }

            try {
                if (code != 0 && error) {
                    console.debug('task::run encountered an error: ' + error);
                }
                if (cb) {
                    cb(error, result);
                    return;
                }
                e.emit('run#complete', error, result)
            } catch (err) {
                console.error(err.stack)
            }
        });



        return e
	};
	return false
}