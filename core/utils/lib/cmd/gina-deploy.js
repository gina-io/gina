
var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var spawn           = require('child_process').spawn;
var helpers         = require('../../helpers');
var inherits        = require('../inherits');
var console         = require('../logger');

/**
 *
 * TODO - onInitialize event
 * TODO - deploy bundle only
 * */
function Deploy(opt) {

    var self =  Deploy.instance || this;
    var local = {};
    var error = false;
    var hosts = {};
    this.env = opt.env;
    this.task = 'deploy';
    this.bundle = opt.bundle;

    setPath('deploy', _(getPath('root') +'/'+ this.task));


    this.init = this.onInitialize = function(cb) {

        if (self.initialized == undefined && !Deploy.instance) {
            self.initialized = true;

            if (typeof(cb) != 'undefined' && typeof(cb) == 'function') {
                cb(init)
            } else {
                init()
            }
            return self
        } else {
            return Deploy.instance
        }
    }

    var init = function() {
        // main init code goes here...
        if ( typeof(opt['set']) != 'undefined') {

            var dic = {};
            for (var k in opt['set']) {
                //normalizing home path alias (nixes only)
                if (k == 'target' && opt['set'][k] === '~/') {
                    opt['set'][k] = '~'
                } else if (k == 'target' && opt['set'][k] === '/') {
                    opt['set'][k] = ''
                }
                // by default
                if (k == 'target') {
                    self['releases_path'] = opt['set'][k] +'/releases';
                    dic['releases_path'] = opt['set'][k] +'/releases';
                    if ( typeof(opt.set.release) != 'undefined') {
                        self.release = opt.set.release
                    } else {
                        self.release = self.makeReleaseNumber()
                    }
                    self['release_relative_path'] = './releases/' + self.release;
                    self['release_path'] = self['releases_path'] + '/' + self.release;
                    dic['release_path'] = self['releases_path'] + '/' + self.release;
                    dic['release'] = +self.release;
                }


                opt['set'][k] = whisper(dic, opt['set'][k]);
                self[k] = opt['set'][k];
                dic[k] = opt['set'][k];
            }
            //update dic
            dic = whisper(dic, dic);



            if ( typeof(self['shared_path']) == 'undefined') {
                self['shared_path'] = self.target + '/shared'
            }

            if ( typeof(self['shared']) == 'undefined') {
                self['shared'] = {}
            }

            if ( typeof(self['tasks']) == 'undefined') {
                self['tasks'] = {
                    "onInitialize" : [],
                    "onDeployed" : []
                }
            }

            if ( typeof(self['host']) == 'undefined') {
                self['host'] = self.user +'@'+ self.server
            }

            if ( typeof(self['keep_releases']) == 'undefined') {
                self['keep_releases'] = 5
            }

            if ( typeof(self['sources']) == 'undefined') {
                self['sources'] = './releases';
            }

            // link to current task added to the end
            for (var t in self.tasks.onDeployed) {
                self.tasks.onDeployed[t] = self.tasks.onDeployed[t].replace(/\/current/g, '/releases/'+self.release)
            }
            self.tasks.onDeployed.push('cd '+self.target+'/; rm ./current; ln -s ' + self.release_relative_path +' ./current');


            self.tasks = whisper(dic, self.tasks);

            self = whisper(dic, self);//closing to ensure replacement


            if (self.releases_path == '/' || self.releases_path == '/.' || self.releases_path == '~' || self.releases_path == '~/' || self.releases_path == '~/.') {
                console.log('releases path cannot be root');
                process.exit(1)
            }
        }

        //get enabled bundles
        self
            .run('ls '+ self.sources, true)
            .onComplete( function onBundle(err, data) {
                if (err) {
                    console.emerg('releases dir not found: try to build then retry to deploy');
                    process.exit(1)
                }

                if (!data) {
                    console.emerg('releases dir is empty: try to build then retry to deploy');
                    process.exit(1)
                }
                var a = data.split('\n'), list = [];

                for (var i=0; i<a.length; ++i) {
                    if (a[i] && a.indexOf(i) < 0)
                        list.push(a[i])
                }
                self.bundles = list;
                finalizeInit()
            });

        var finalizeInit = function() {
            if (self.bundles.length > 0) {
                Deploy.instance = self;

                //self.removeAllReleases( function onRemoved() {
                //    self.emit('init#complete', false)
                //})
                self.emit('init#complete', false)
            } else {
                console.error('could not deploy: no bundle found !')
            }
        }
    }

    this.getIgnoreList = function() {
        var list = [];
        var path = getPath('root') + '/deploy/' + self.env + '/.ignore';

        if ( fs.existsSync(path) ) {
            var arr = fs.readFileSync(path).toString().split(/\n/);
            var tmp =''
            for (var i=0; i<arr.length; ++i) {
                tmp = arr[i].trim();
                if ( tmp.substr(0, 1) != "#" && tmp!= '') {
                    if (tmp.indexOf('#') > -1) {
                        tmp = tmp.substr(0, tmp.indexOf('#')).trim()
                    }
                    list.push(tmp)
                }
            }
        }


        var envsList = [], bundleList = [];
        var path = '';
        try {
            var envs = require(getPath('root') +'/env.json');

            for (var b in envs) {
                bundleList.push(b);
                for (var e in envs[b]) {
                    if (list.indexOf('*/'+ e +'/*') < 0 && e != self.env ) {
                        list.push('*/'+ e +'/*')
                    }

                    path = './releases/'+ b +'/'+ e;
                    if (list.indexOf(path) < 0 && e != self.env ) {
                        list.push(path)
                    }
                }
            }
        } catch (err) {
            if (!self.bundles[0]) {
                console.error(err.stack);
                process.exit(1)
            }
        }
        return list
    }

    this.makeReleaseNumber = function() {
        return new Date().getTime()
    }

    this.removeAllReleases = function(cb) {

        var removeRelease = function(list, i, cb) {
            if ( list.length > ~~self['keep_releases'] ) {
                if (list[i] == '') { //avoid empty
                    list.splice(0, 1);
                    removeRelease(list, 0, cb)
                } else {
                    self
                        .run('rm -Rf ' + self.releases_path + '/' + list[i])
                        .onComplete( function(err, data) {
                            if (!err) {
                                list.splice(0, 1);
                                removeRelease(list, 0, cb)
                            } else {
                                console.error(err);
                                process.exit(1)
                            }
                        })
                }
            } else {
                cb(false)
            }
        };

        self
            .run('ls ' + self.releases_path + '/')
            .onComplete( function(err, data) {
                if (!err && data != undefined) {
                    var list = data.toString().split('\n');
                    removeRelease(list, 0, cb)
                } else {
                    self
                        .run('mkdir ' + self.releases_path)
                        .onComplete(cb)
                }
            })
    }


    /**
     * Run commande
     *
     * @param cmdLine {array|string}
     *
     * */
    this.run = function(cmdline, runLocal) {
        //var runLocal = runLocal||false;
        var outFile = _(getPath('globalTmpPath') + '/out.log');
        var errFile = _(getPath('globalTmpPath') + '/err.log');
        var out = fs.openSync(outFile, 'a');
        var err = fs.openSync(errFile, 'a');

        var root = getPath('root');

        var result, error = false;
        var hasCalledBack = false;
        var e = new EventEmitter();

        var cmd;
        if ( isWin32() ) {
            throw new Error('Windows platform not supported yet for command line forward');
            process.exit(1)
        }
        if ( typeof(runLocal) != 'undefined' && runLocal == true ) {

            //process.chdir(root);
            // cmdline must be an array !!
            if (typeof(cmdline) == 'string') {
                cmdline = cmdline.split(' ')
            }

            //console.info('running: ', cmdline.join(' '));

            cmd = spawn(cmdline.splice(0,1).toString(), cmdline, { cwd: root, stdio: [ 'ignore', out, err ] })

        } else {
            console.info('running: [ ssh ] ', cmdline);
            cmd = spawn('ssh', [ self.host, cmdline ], { stdio: [ 'ignore', out, err ] })
        }

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
                    e.emit('run#complete', 'project deploy encountered an error: ' + error, result)
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
    }


    var makeStartUpScript = function() {

    }

    /**
     * runOnDeployedTasks
     * @description Tasks to run after deploy is complete.
     *
     * @param {number} t - task id
     * */
    this.runOnDeployedTasks = function(t) {
        console.info('running onDeployedTasks');
        var t = t || 0;

        if ( typeof(self.tasks) != 'undefined' && typeof(self.tasks.onDeployed[t]) != 'undefined') {
            self
                .run(self.tasks.onDeployed[t])
                .onComplete( function(err, msg) {
                    if (err) console.warn(err.stack||err.message||err);
                    if (msg) console.info(msg);
                    self.runOnDeployedTasks(t+1)
                })

        } else {
            self.emit('deploy-tasks#complete', false)
        }

        this.onComplete = function(callback) {

            self.once('deploy-tasks#complete' , function(err) {
                if (!err) {
                    console.log('finalizing... ')
                }
                callback(err)
            });

            // look into bin to create complete event
            // then redirect to script when done in your local strategy
            // with: [ self.emit('deploy#complete', err) ]

            //return self
        }

        return self
    }


    this.onInitialized = function(callback) {

        self.once('init#complete' , function(err) {
            if (!err) {
                console.log('init complete')
            }
            callback(err)
        });

        return self
    }

    this.onComplete = function(callback) {

        self.once('deploy#complete' , function(err) {
            if (!err) {
                self.removeAllReleases( function onRemoved() {
                    console.info('removed old releases')
                })
                console.info('deploy complete !')
            }
            callback(err)
        });

        return self
    }

    return this
};

Deploy = inherits(Deploy, EventEmitter);
module.exports = Deploy
