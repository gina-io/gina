/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
process.env.IS_SCRIPT_MODE = true;
//Imports.
var fs      = require('fs');
var spawn   = require('child_process').spawn;

// var helpers = require('./../core/utils/helpers');
// var utils   = {
//     logger      : require('./../core/utils/lib/logger'),
//     generator   : require('./../core/utils/lib/generator')
// };

var utils = require('./../core/utils');

function PrePublish() {
    var self = this;
    this.path = _( __dirname.substring(0, (__dirname.length - "script".length)) );
    //this.projectPath = _( __dirname.substring(0, (__dirname.length - "node_modules/gina/script".length)) );

    var init = function() {
        self.tasksCount = 0;
        var list = [], i = 0;
        for(var t in self) {
            if( typeof(self[t]) == 'function') {
                list[i] = {
                    func: self[t],
                    cb: hasCallback(self[t])
                }
                ++i
            }
        }
        run(list)
    },
    count = function() {
        return self.tasksCount;
    },
    /**
     * Run tasks - Will run in order of declaration
     * */
    run = function(list) {

        var i = self.tasksCount;

        if (i > list.length-1) {
            process.exit(0)
        }

        var err = false;
        var cb = ( typeof(list[i].cb) != 'undefined' ) ? list[i].cb : false;

        if (cb) {
            list[i].func( function done(err, data) {
                if (err) {
                    console.error(err.stack||err.message);
                    process.exit(1)
                } else {
                    if (data) {
                        //var str = data.toString();
                        console.info(data);
                    }
                    ++self.tasksCount;
                    run(list)
                }

            })
        } else {
            try {
                list[i].func();
                ++self.tasksCount;
                run(list)
            } catch (err) {
                console.error(err.stack);
                process.exit(1)
            }
        }
    },
    hasCallback = function(func) {
        var found = false;
        var funcString = func.toString();
        var args = funcString.match(/^\s*function\s+(?:\w*\s*)?\((.*?)\)/);
        args = args ? (args[1] ? args[1].trim().split(/\s*,\s*/) : []) : null;

        if (args.length > 0) {
//            var cb;
//            for (var a = 0; a < args.length; ++a) {
//                console.log('......checking ', args[a]);
//                cb = funcString.match(/(callback|cb)\s*\(/g);
//                if (cb) {
//                    //console.log('.......??? ', cb);
//                    return args[a]
//                }
//            }
            return args
        }

        return found
    };


    var exec = function(cmdLine, cb) {
        var outFile = _('./out.log');
        var errFile = _('./err.log');
        var out = fs.openSync(outFile, 'a');
        var err = fs.openSync(errFile, 'a');

        var result, error = false;

        var cmd;
        console.info('running: ' + cmdLine.join(' '));
        cmd = spawn(cmdLine.splice(0,1).toString(), cmdLine, { stdio: [ 'ignore', out, err ] });
        cmd.on('stdout', function(data) {
            var str = data.toString();
            var lines = str.split(/(\r?\n)/g).join('');
            result = lines;
            cb(false, lines)
        });

        cmd.on('stderr', function (err) {
            var str = err.toString();
            error = str;
            cb(str)
        });

        cmd.on('close', function (code) {

            try {
                var error = ( fs.existsSync(errFile) ) ? fs.readFileSync(errFile).toString() : undefined;
                //closing
                fs.closeSync(err);
                fs.unlinkSync(errFile);

                if (error) {
                    cmd.emit('stderr', new Buffer(error))
                }

                var data = ( fs.existsSync(outFile) ) ? fs.readFileSync(outFile).toString() : undefined;
                fs.closeSync(out);
                fs.unlinkSync(outFile);

                if ( data ) {
                    cmd.emit('stdout', new Buffer(data))
                }

            } catch (err) {
                error = err.stack || err.message;
                console.error(error)
            }

            if (code == 0 ) {
                cb(error, result)
            } else {
                cb( new Error('Prepublish encountered an error: ' + error) )
            }
        })
    }

    this.runTests = function(cb) {
        if ( fs.existsSync(self.path+'/test') ) {
            exec(['nodeunit', self.path+'/test'], function done(err, data) {
                if ( /FAILURES\:/.test(data) || !/OK\:/.test(data) ) {
                    console.info(data);
                    cb(new Error('Tests failed !! See message above.'))
                }
                cb(err, data)
            })
            //exec('npm '++'test')
            //cb(false)
        } else {
            cb(false)
        }
    }

    this.removeComments = function() { console.log('removin comments ...')};
    this.removeConsoleLog = function() {

    };
    /**
     * Write version number in the VERSION file
     * */
    this.setVersion = function() {
        console.log('setting version number ...');
        try {
            var version = require( _(self.path + 'package.json') ).version;
            var path = _(self.path + 'VERSION');
            fs.writeFileSync(path, version)
        } catch (err) {
            console.error(err.stack)
        }
    };
    /**
     //Publish to git hub when everything is done
     this.onReady(function(taskCount){
        if(this.count() == 0){
            _this.postToGitHub();
        }
    });*/

    init()
};

new PrePublish()