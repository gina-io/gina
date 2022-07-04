var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var spawn           = require('child_process').spawn;

var console         = require('../lib/logger');

module.exports = function () {

	 /**
     * Run commande on local cli
     *
     * @param cmdLine {array|string}
     * @param opt {object}
     *
     *
     * */
	run = function(cmdline, opt) {
		var pathArr = (new _(__dirname).toUnixStyle().split(/\//g));
		var root =  pathArr.splice(0, pathArr.length-6).join('/');

        var opt = opt || {};
        if (!opt.cwd)
            opt.cwd = root;

        var tmp = opt.tmp || process.cwd();

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

        //console.log( opt.cwd );
        //console.log( 'running ', cmdline);

        var cmd;
        // cmdline must be an array !!
        if (typeof(cmdline) == 'string') {
            cmdline = cmdline.split(' ')
        }
        cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: opt.cwd, stdio: [ 'ignore', out, err ] });


        cmd.on('stdout', function(data) {
            var str = data.toString();
            var lines = str.split(/(\r?\n)/g);
            result = lines.join('');
            //console.info('out: ', result);
            e.emit('run#data', result)
        });

        // Errors are readable in the onComplete callback
        cmd.on('stderr', function (err) {
            var str = err.toString();
            error = str || false;
            //console.error('err: ', error);
            e.emit('run#err', error)
        });

        cmd.on('close', function (code) {

            try {
                var error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : false;
                //closing
                fs.closeSync(err);
                if ( fs.existsSync(errFile) ) fs.unlinkSync(errFile);

                if (error) {
                    cmd.emit('stderr', new Buffer(error))
                }


                var data = ( fs.existsSync(outFile) ) ? fs.readFileSync(outFile).toString() : undefined;
                //closing
                fs.closeSync(out);
                if (fs.existsSync(outFile) ) fs.unlinkSync(outFile);

                if ( data ) {
                    cmd.emit('stdout', new Buffer(data))
                }


                if (error == '') {
                    error = false
                }

                if (code == 0 ) {
                    e.emit('run#complete', error, result)
                } else {
                    e.emit('run#complete', 'task::run encountered an error: ' + error, result)
                }


            } catch (err) {
                console.error(err.stack)
            }
        });

        e.onData = function(callback) {

            e.once('run#data', function(data) {
                callback(data)
            });

            e.once('run#err', function(err, data) {
                callback(err, data)
            });

            return e

        }

        e.onComplete = function(callback) {
            e.once('run#complete', function(err, data) {
                callback(err, data)
            });

            return e
        };

        return e
	};
	return false
}