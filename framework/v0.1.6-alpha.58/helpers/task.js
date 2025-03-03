var fs              = require('fs');
var os              = require("os");
var EventEmitter    = require('events').EventEmitter;
var spawn           = require('child_process').spawn;

var console         = require('../lib/logger');

module.exports = function () {

	 /**
     * Run commande on local cli
     *
     * Could also be used to open an url but need some tweaking
     * // sample of a cross platform `open` command
     *  e.g.: var openCmd = (process.platform == 'darwin'? 'open': process.platform == 'win32'? 'start': 'xdg-open');
     *
     * @param cmdLine {array|string}
     * @param opt {object}
     *
     *
     * */
	run = function(cmdline, opt, cb) {

		var pathArr = (new _(__dirname).toUnixStyle().split(/\//g));
		var root =  pathArr.splice(0, pathArr.length-6).join('/');

        opt = opt || {};
        if (!opt.cwd) {
            opt.cwd = root;
        }
        process.chdir(opt.cwd);


        var tmp = opt.tmp || os.tmpdir() || process.cwd();

        if ( !fs.existsSync(tmp) ) {
            fs.mkdirSync(tmp)
        }

		var outFile = _(tmp + '/out.log');
        var errFile = _(tmp + '/err.log');
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

            try {
                var error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : false;
                //closing
                fs.closeSync(err);
                if ( fs.existsSync(errFile) ) fs.unlinkSync(errFile);

                if (error) {
                    cmd.emit('stderr', Buffer.from(error))
                }


                var data = ( fs.existsSync(outFile) ) ? fs.readFileSync(outFile).toString() : undefined;
                //closing
                fs.closeSync(out);
                if (fs.existsSync(outFile) ) fs.unlinkSync(outFile);

                if ( data ) {
                    cmd.emit('stdout', Buffer.from(data))
                }


                if (error == '') {
                    error = false
                }

                if (code == 0 ) {
                    if (cb) {
                        cb(error, result);
                        return;
                    }
                    e.emit('run#complete', error, result)
                } else {
                    if (error) {
                        console.debug('task::run encountered an error: ' + error);
                    }
                    if (cb) {
                        cb(error, result);
                        return;
                    }
                    e.emit('run#complete', error, result)
                }


            } catch (err) {
                console.error(err.stack)
            }
        });



        return e
	};
	return false
}