var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var spawn = require('child_process').spawn;
var inherits = require(require.resolve('./inherits'));
var helpers = require('./../helpers');
var console = require('./logger');


function Shell () {

    var self = this;
    var local = {
        chdir : undefined,
    };

    this.setOptions = function(opt) {
        local = {
            chdir : opt.chdir
        }
    }

    var getOptions = function () {
        return local
    }

    /**
     * Run command line
     *
     * @param {string|array} cmdLine
     * @param {boolean} runLocal
     * */
    this.run = function(cmdline, runLocal) {
        var opt = getOptions();
        var outFile = _(getPath('globalTmpPath') + '/out.log');
        var errFile = _(getPath('globalTmpPath') + '/err.log');
        var out = fs.openSync(outFile, 'a');
        var err = fs.openSync(errFile, 'a');

        var root = opt.chdir || getPath('root');

        var result, error = false;
        var hasCalledBack = false;

        var e = new EventEmitter();

        var cmd;
        if ( isWin32() ) {
            throw new Error('Windows platform not supported yet for command line forward');
            process.exit(1)
        }
        if ( typeof(runLocal) != 'undefined' && runLocal == true ) {

            // cmdline must be an array !!
            if (typeof(cmdline) == 'string') {
                cmdline = cmdline.split(' ')
            }

            cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: root, stdio: [ 'ignore', out, err ] })

        } else {
            console.info('running: ssh ', cmdline);
            cmd = spawn('ssh', [ self.host, cmdline ], { stdio: [ 'ignore', out, err ] })
        }

        cmd.on('stdout', function(data) {
            var str = data.toString();
            var lines = str.split(/(\r?\n)/g);
            result = lines.join('');

            e.emit('run#data', result)
        });

        // Errors are readable in the onComplete callback
        cmd.on('stderr', function (err) {
            var err = err.toString();
            //error = new Error(err).stack || false;
            error = err || false;


            e.emit('run#err', error)
        });

        cmd.on('close', function (code) {

            try {
                var error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : false;
                //closing
                fs.closeSync(err);
                if ( fs.existsSync(errFile) ) fs.unlinkSync(errFile);

                if (error) {
                    //cmd.emit('stderr', new Buffer(error))
                    error = new Error(error).stack;
                    cmd.emit('stderr', error)
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
                    e.emit('run#complete', '[ shell::run ] encountered an error: ' + error, result)
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

            //return e

        };

        e.onComplete = function(callback) {
            e.once('run#complete', function(err, data) {
                callback(err, data)
            });

            //return e
        };

        return e
    }

};

Shell = inherits(Shell, EventEmitter);
module.exports = Shell;