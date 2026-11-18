var InstallTest;

//imports
var fs = require('fs');
var spawn = require('child_process').spawn;
var helpers = require('helpers');

InstallTest = function(conf, exports) {
    var self = this;
    var root = conf.root;
    var tmp = conf.tmp;
    var workspace = new _(conf.target);


    this.hasWorkspace = false;
    this.npmInstallDone = false;
    this.postInstallDone = false;
    this.binaryFound = false;

    var makeWorkspace = function(callback) {
        workspace.rm( function(err) {
            if (err) {
                console.error(err.stack);
            }
            //cp sources
            var source = new _(conf.gina);
            var target = _(workspace.toString() + '/node_modules/gina');
            var ignore = [/^\./, 'test', 'node_modules'];
            source.cp(target, ignore, function(err) {
                if (err) {
                    console.error(err.stack);
                    process.exit(1)
                }
                console.info('workspace ready !');
                self.hasWorkspace = true;
                self.deps = require(_( workspace.toString() + '/node_modules/gina/package.json' )).dependencies;
                self.modules = [];
                for (var m in self.deps) {
                    self.modules.push(m)
                }
                callback()
            })
        })
    }

//    var runNpmInstall = function(m, callback) {
//
//        var path = _( workspace.toString() + '/node_modules/gina' );
//        process.chdir(path);//CD command like.
//
//        var npmInstall = function(callback) {
//            var npmCmd = ( isWin32() ) ? "npm.cmd" : "npm";
//            var npm = spawn(npmCmd, [ 'install', self.modules[m] ]);
//            console.log('\nNow installing: ' + self.modules[m] );
//            npm.stdout.setEncoding('utf8');
//            npm.stdout.on('data', function(data) {
//                var str = data.toString();
//                var lines = str.split(/(\r?\n)/g);
//                //console.log(lines.join(""))
//
//            });
//
//            npm.stderr.on('data',function (err) {
//
//                var str = err.toString();
//                var lines = str.split(/(\r?\n)/g);
//
////                if ( !str.match("Already on") ) {
////                    console.log(lines.join(""))
////                }
//                process.stdout.write('.');
//            });
//
//            npm.on('close', function (code) {
//                process.stdout.write('\n');
//                if (!code) {
//                    if (m < self.modules.length-1) {
//                        ++m;
//                        runNpmInstall(m, callback)
//                    } else {
//                        runPostInstall(callback)
//                    }
//
//                } else {
//                    //console.log('process exit with error code ' + code)
//                    callback('process stopped with error code ' + code)
//                }
//            })
//        }(callback);
//
//        var runPostInstall = function(callback) {
//
//            var path = _( workspace.toString() + '/node_modules/gina' );
//            process.chdir(path);//CD command like.
//            var pi = spawn('node', [ 'script/post_install.js' ]);
//
//            pi.stdout.setEncoding('utf8');
//            pi.stdout.on('data', function(data) {
//                var str = data.toString();
//                var lines = str.split(/(\r?\n)/g);
//                console.log(lines.join(""))
//            });
//
//            pi.stderr.on('data',function (err) {
//
//                var str = err.toString();
//                var lines = str.split(/(\r?\n)/g);
//
//                if ( !str.match("Already on") ) {
//                    console.log(lines.join(""))
//                }
//            });
//
//            pi.on('close', function (code) {
//                if (!code) {
//                    self.postInstallDone = true;
//                    callback(false)
//                } else {
//                    callback('post install process stopped with error code ' + code)
//                }
//            })
//        }
//    }

    var runNpmInstall = function(m, callback) {

        var path = _( workspace.toString() + '/node_modules/gina' );
        process.chdir(path);//CD command like.

        var npmInstall = function(callback) {

            var outFile = _(__dirname+'/out.log');
            var errFile = _(__dirname+'/err.log');
            var out = fs.openSync(outFile, 'a');
            var err = fs.openSync(errFile, 'a');

            var npmCmd = ( isWin32() ) ? "npm.cmd" : "npm";
            var npm = spawn(npmCmd, [ 'install', self.modules[m] ], {stdio: [ 'ignore', out, err ]});
            console.log('\nNow installing: ' + self.modules[m] );

            npm.on('stdout', function(data) {
                var str = data.toString();
                var lines = str.split(/(\r?\n)/g);
//                console.log(lines.join(""))
            });

            npm.on('stderr',function (err) {
                var str = err.toString();
                var lines = str.split(/(\r?\n)/g);
//                if ( !str.match("Already on") ) {
//                    console.log(lines.join(""))
//                }
                process.stdout.write('.');
            });

            npm.on('close', function (code) {
                try {
                    //process.stdout.write('\n');
                    fs.closeSync(err);
                    if (fs.existsSync(errFile)) {
                        npm.emit('stderr', fs.readFileSync(errFile));
                        fs.unlinkSync(errFile)
                    }
                    fs.closeSync(out);
                    var str = '';
                    if (fs.existsSync(outFile)) {
                        str = fs.readFileSync(outFile);
                        fs.unlinkSync(outFile)
                    }
                    npm.emit('stdout', code, str);

                    if (!code) {
                        if (m < self.modules.length-1) {
                            ++m;
                            runNpmInstall(m, callback)
                        } else {
                            runPostInstall(callback)
                        }

                    } else {
                        //console.log('process exit with error code ' + code)
                        callback('process stopped with error code ' + code)
                    }
                } catch (err) {
                    callback(err.stack)
                }
            })
        }(callback);

        var runPostInstall = function(callback) {

            var path = _( workspace.toString() + '/node_modules/gina' );
            process.chdir(path);//CD command like.


            var outFile = _(__dirname+'/out.log');
            var errFile = _(__dirname+'/err.log');
            var out = fs.openSync(outFile, 'a');
            var err = fs.openSync(errFile, 'a');

            var pi = spawn('node', [ 'script/post_install.js' ], {stdio: [ 'ignore', out, err ]});

            pi.on('stdout', function(data) {
                var str = data.toString();
                var lines = str.split(/(\r?\n)/g);
                console.log(lines.join(""))
            });

            pi.on('stderr',function (err) {
                var str = err.toString();
                var lines = str.split(/(\r?\n)/g);

                if ( !str.match("Already on") ) {
                    console.log(lines.join(""))
                }
            });

            pi.on('close', function (code) {
                try {
                    fs.closeSync(err);
                    if (fs.existsSync(errFile)) {
                        pi.emit('stderr', fs.readFileSync(errFile));
                        fs.unlinkSync(errFile)
                    }
                    fs.closeSync(out);
                    var str = '';
                    if (fs.existsSync(outFile)) {
                        str = fs.readFileSync(outFile);
                        fs.unlinkSync(outFile)
                    }
                    pi.emit('stdout', code, str);
                    if (!code) {
                        self.postInstallDone = true;
                        callback(false)
                    } else {
                        callback('post install process stopped with error code ' + code)
                    }
                } catch (err) {
                    callback(err.stack)
                }
            })
        }
    }

    var hasBinary = function(callback) {
        var file = ( isWin32() ) ? 'gina.bat' : 'gina.sh';
        workspace.hasFile(file , function(err, found) {
            callback(err, found)
        })
    }

    exports['Framework Install'] = {

        setUp: function (callback) {
            if (!self.hasWorkspace) {
                makeWorkspace( function(){
                    runNpmInstall(0, function(err) {
                        if (!err) {
                            self.npmInstallDone = true
                        }
                        callback()
                    })
                })
            } else if (!self.postInstallDone) {
                callback()
            } else if (!self.binaryFound) {
                hasBinary( function(err, found){
                    if ( !err && found ) {
                        self.binaryFound = true
                    }
                    callback()
                })
            } else {
                callback()
            }
        },

//        tearDown: function (callback) {
//            // clean up
//            callback();
//        },

        'Had run NPM without error' : function(test) {
            test.equal(self.npmInstallDone, true);
            test.done()
        },

        'Had run post install script' : function(test) {
            test.equal(self.postInstallDone, true);
            test.done()
        },

        'Had installed [ gina ] binary' : function(test) {
            test.equal(self.binaryFound, true);
            test.done()
        }
    }
};

module.exports = InstallTest
