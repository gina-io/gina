var fs = require('fs');
var EventEmitter = require('events').EventEmitter;
var spawn = require('child_process').spawn;
var inherits = require(require.resolve('./inherits'));
var helpers = require('./../helpers');
var console = require('./logger');

/**
 * SSH SHELL
 */
function Shell () {

    var self = this;
    var local = {
        chdir : undefined,
        console: undefined
    };

    this.setOptions = function(opt) {

        for (let name in opt) {
            if ( Object.keys(local).indexOf(name) < 0 ) {
                throw new Error('Option `'+ name +'` not supported !')
            }
            console.debug('Setting up ['+ name +'] option');
            local[name] = opt[name]
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

        var opt         = getOptions()
            , outFile   = _(GINA_TMPDIR + '/out.log')
            , errFile   = _(GINA_TMPDIR + '/err.log')
            , out       = fs.openSync(outFile, 'a')
            , err       = fs.openSync(errFile, 'a')
        ;

        //var root = opt.chdir || getPath('root');
        var root = opt.chdir;

        var result          = null
            , error         = false
            , hasCalledBack = false
        ;

        var _console = ( typeof(local.console) != 'undefined' ) ? local.console : console;

        var e = new EventEmitter();

        var cmd = null;

        if ( isWin32() ) {
            throw new Error('Windows platform not supported yet for command line forward');
        }

        if ( typeof(runLocal) != 'undefined' && runLocal == true ) {

            // cmdline must be an array !!
            if (typeof(cmdline) == 'string') {
                cmdline = cmdline.split(' ')
            }

            cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: root, stdio: [ 'ignore', out, err ] })

        } else {
            _console.debug('running: ssh ', cmdline);
            cmd = spawn('ssh', [ self.host, cmdline ], { stdio: [ 'ignore', out, err ] })
        }

        cmd.on('stdout', function(data) {

            var str     = data.toString();
            var lines   = str.split(/(\r?\n)/g);

            result = lines.join('');

            e.emit('run#data', result)
        });

        // Errors are readable in the onComplete callback
        cmd.on('stderr', function (err) {

            if (err) {
                error = err.toString();
            }

            e.emit('run#err', error)
        });

        cmd.on('close', function (code) {

            try {
                var error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : false;
                //closing
                fs.closeSync(err);
                if ( fs.existsSync(errFile) ) fs.unlinkSync(errFile);

                if (error) {
                    //cmd.emit('stderr', Buffer.from(error))
                    error = new Error(error).stack;
                    cmd.emit('stderr', error)
                }


                var data = ( fs.existsSync(outFile) ) ? fs.readFileSync(outFile).toString() : undefined;
                //closing
                fs.closeSync(out);
                if (fs.existsSync(outFile) ) fs.unlinkSync(outFile);

                if ( data ) {
                    cmd.emit('stdout', Buffer.from(data))
                }


                if ( error == '' || typeof(error) == 'undefined' || error == undefined  || error == null) {
                    error = false
                }

                if (code == 0 ) {
                    e.emit('run#complete', error, result)
                } else {
                    e.emit('run#complete', '[ shell::run ] encountered an error: ' + error, result)
                }


            } catch (err) {
                _console.error(err.stack)
            }
        });

        e.onData = function(callback) {

            e.once('run#data', function(data) {
                callback(data)
            });

            e.once('run#err', function(err, data) {
                callback(err, data)
            })
        };

        e.onComplete = function(callback) {
            e.once('run#complete', function(err, data) {
                callback(err, data)
            })
        };

        return e
    }

};

Shell = inherits(Shell, EventEmitter);
module.exports = Shell;