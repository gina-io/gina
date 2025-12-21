var AddBundle;

//imports
var fs = require('fs');
var spawn = require('child_process').spawn;
var helpers = require('helpers');

AddBundle = function(conf, exports) {
    var self = this;
    var root = conf.root;
    var tmp = conf.tmp;
    var workspace = new _(conf.target);

    var addBundleDone = false;
    var testBundleStructureDone = false;
    var testJSONFilesDone = false;

    self.bundleCreated = false;
    self.bundleDefaultStructure = false;
    self.projectFilesBundleAdded = false;

    this.bundleName = 'my_bundle'; // will be shared ib others tests

    var addBundle = function(callback) {
        addBundleDone = true;

        var path = _( workspace.toString() );
        process.chdir(path);//CD command like.

        var outFile = _(__dirname+'/out.log');
        var errFile = _(__dirname+'/err.log');
        var out = fs.openSync(outFile, 'a');
        var err = fs.openSync(errFile, 'a');

        var cmd = (isWin32()) ? '.gina' : './gina.sh';
        var init = spawn('node', [ cmd, '--add', self.bundleName ], {stdio: [ 'ignore', out, err ]});

        //init.stdout.setEncoding('utf8');
        init.on('stdout', function(code, data) {
            var str = data.toString();
            var lines = str.split(/(\r?\n)/g);
            if ((new RegExp('Bundle \\[ '+self.bundleName+' \\] has been added to your project with success')).test(lines) && !code) {
                callback(false)
            } else {
                callback('bundle add process stopped with error code ' + code)
            }
        });

        init.on('stderr',function (err) {
            var str = err.toString();
            var lines = str.split(/(\r?\n)/g);
            if (!str.match("Already on") ) {
                console.log(lines.join(""))
            }
        });

        init.on('close', function (code) {
            try {
                fs.closeSync(err);
                if (fs.existsSync(errFile)) {
                    init.emit('stderr', fs.readFileSync(errFile));
                    fs.unlinkSync(errFile)
                }
                fs.closeSync(out);
                var str = '';
                if (fs.existsSync(outFile)) {
                    str = fs.readFileSync(outFile);
                    fs.unlinkSync(outFile)
                }
                init.emit('stdout', code, str);
            } catch (err) {
                callback(err.stack)
            }
        })
    }

    var testBundleStructure = function(callback) {
        testBundleStructureDone = true;
        try {
            var srcPath = conf.gina +'/core/template/samples/bundle';
            var src = new _( srcPath);
            var dstPath = workspace.toString() +'/src/'+ self.bundleName;
            var dst = new _( dstPath);

            src.exists( function(srcExists) {
                if (srcExists) {
                    dst.exists( function(dstExists) {
                        if (dstExists) {
                            var isConform = compareFilesBundle(srcPath, dstPath, '');
                            if (typeof(isConform) == 'boolean') {
                                callback(false, isConform)
                            } else {
                                callback(isConform)
                            }
                        } else {
                            callback(false, false)
                        }
                    })
                } else {
                    callback(false, false)
                }
            })
        } catch(err) {
            callback(err)
        }
    }
    var compareFilesBundle = function (srcRoot, dstRoot, element) {
        try {
            var srcPath = srcRoot;
            var dstPath = dstRoot;
            if (element != '') {
                srcPath = srcPath+'/'+element;
                dstPath = dstPath+'/'+element;
            }
            var srcStats = fs.statSync( _(srcPath));
            var dstStats = fs.statSync( _(dstPath));
            var srcData;
            var dstData;
            var isConform = true;
            var i;

            if (srcStats.isDirectory() && dstStats.isDirectory()) {
                srcData = fs.readdirSync(_(srcPath));
                dstData = fs.readdirSync(_(dstPath));
                if (srcData.length == dstData.length) {
                    i = srcData.length-1;
                    for ( ; i >= 0 && isConform; --i) {
                        if (dstData.indexOf(srcData[i]) == -1) {
                            isConform = false
                        }
                    }
                    i = dstData.length-1;
                    for ( ; i >= 0 && isConform; --i) {
                        if (srcData.indexOf(dstData[i]) == -1) {
                            isConform = false
                        }
                    }
                    i = srcData.length-1;
                    for ( ; i >= 0 && isConform; --i) {
                        isConform = isConform && compareFilesBundle(srcPath, dstPath, srcData[i])
                    }
                    return isConform
                } else {
                    return false
                }

            } else if (srcStats.isFile() && dstStats.isFile()) {
                var testIndexJs = (new RegExp(self.bundleName+'/index.js')).test(dstPath);
                var testAppJson = (new RegExp(self.bundleName+'/config/app.json')).test(dstPath);
                var testControllerJs = (new RegExp(self.bundleName+'/controllers/oontroller.js')).test(dstPath);

                if (testIndexJs || testAppJson || testControllerJs) {
                    srcData = (fs.readFileSync(_(srcPath), 'utf8')).toString();
                    dstData = (fs.readFileSync(_(dstPath), 'utf8')).toString();

                    var upperBundleName = self.bundleName.substring(0, 1).toUpperCase() + self.bundleName.substring(1);

                    srcData = srcData.replace(/\{bundle\}/g, self.bundleName);
                    srcData = srcData.replace(/\{Bundle\}/g, upperBundleName);
                    srcData = (srcData.toString()).split(/(\r?\n)/g);
                    dstData = (dstData.toString()).split(/(\r?\n)/g);

                    if (srcData.length == dstData.length) {

                        i = srcData.length - 1;
                        for (; i >= 0 && isConform; --i) {
                            if (dstData[i] != srcData[i]) {
                                isConform = false
                            }
                        }
                        return isConform
                    } else {
                        return false
                    }
                } else {
                    return true
                }
            } else {
                return false
            }
        } catch(err) {
            return err
        }
    }

    var testJSONFiles = function(callback) {
        testJSONFilesDone = true;
        try {
            delete require.cache[require.resolve(_(workspace + '/manifest.json', true))];
            var project = require(_(workspace + '/manifest.json') );
            delete require.cache[require.resolve(_(workspace + '/env.json', true))];
            var env = requireJSON(_(workspace + '/env.json') );
            var isConform = true;

            var projectDataCmp = {
                "comment": "Your comment goes here.",
                "tag": "001",
                "src": "src/" + self.bundleName,
                "release": {
                    "version": "0.0.1",
                    "link": "bundles/" + self.bundleName
                }
            };
            var envDataCmp = {
                "dev" : {
                    "host" : "localhost",
                    "port" : {
                        "http" : 3100
                    }
                },
                "stage" : {
                    "host" : "localhost",
                    "port" : {
                        "http" : 3100
                    }
                },
                "prod" : {
                    "host" : "localhost",
                    "port" : {
                        "http" : 3100
                    }
                }
            };

            if (typeof(project['bundles']) != 'undefined' && typeof(project['bundles'][self.bundleName]) != 'undefined') {
                isConform = isConform && compareObjectJson(project['bundles'][self.bundleName], projectDataCmp);
                isConform = isConform && compareObjectJson(projectDataCmp, project['bundles'][self.bundleName])
            } else {
                isConform = false
            }
            if (typeof(env[self.bundleName]) != 'undefined') {
                isConform = isConform && compareObjectJson(env[self.bundleName], envDataCmp);
                isConform = isConform && compareObjectJson(envDataCmp, env[self.bundleName])
            } else {
                isConform = false
            }

            callback(false, isConform)
        } catch(err) {
            callback(err)
        }
    }
    var compareObjectJson = function(element1, element2) {
        if (typeof(element1) == 'object' && typeof(element2) == 'object') {
            var index;
            var cmp = true;
            for (index in element1) {
                if (typeof(element2[index] != 'undefined')) {
                    cmp = cmp && compareObjectJson(element1[index], element2[index])
                } else {
                    cmp = false;
                    break
                }
            }
            return cmp
        } else {
            return (element1 == element2)
        }
    }

    exports['Bundle Add'] = {

        setUp: function (callback) {
            if (!addBundleDone) {
                addBundle(function (err) {
                    if (!err) {
                        self.bundleCreated = true
                    }
                    callback()
                })
            } else if (!testBundleStructureDone) {
                testBundleStructure(function (err, isConform) {
                    if (!err) {
                        self.bundleDefaultStructure = isConform
                    }
                    callback()
                })
            } else if (!testJSONFilesDone) {
                testJSONFiles(function (err, isConform) {
                    if (!err) {
                        self.projectFilesBundleAdded = isConform
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

        'Had created bundle file' : function(test) {
            test.equal(self.bundleCreated, true);
            test.done()
        },

        'Bundle has default structure' : function(test) {
            // forcing ??? this
            test.equal(self.bundleDefaultStructure, true);
            test.done()
        },

        'Project file has been updated' : function(test) {
            test.equal(self.projectFilesBundleAdded, true);
            test.done()
        }
    }
};

module.exports = AddBundle