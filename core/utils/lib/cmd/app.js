/*
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

/**
 * AppCommand Class
 *
 * @package    Gina.Utils.Cmd
 * @author     Rhinostone <gina@rhinostone.com>
 */
var fs          = require('fs');
var spawn       = require('child_process').spawn;
var os          = require('os');
var console     = require('../logger');
var Proc        = require('../proc');
var EventEmitter = require('events').EventEmitter;
var inherits    = require('../inherits');
//var generator   = require('../generator');

var AppCommand = {
    opt : {},
    allowedOptions : [
        '-a',
        '--add',
        '-b',
        '--build',
        '-d',
        '--delete',
        '--deploy',
        '--deploy-init',
        '-i',
        '--init',
        '-s',
        '--start',
        '-av',
        '-a -v',
        '--add-views'
        //'-k',
        //'--kill',
        //'--stop',
        //'-r',
        //'--restart',
        //'-t',
        //'--status'
    ],
    allowedArguments : [
        '-t',
        '--type',
        'dev',
        'debug',
        //'--stack',
        'stage',
        'prod'
    ],
    envs : ['dev', 'debug', 'stage', 'prod'],
    allowedTypes : [
        'blog',
        'cms',
        'app'
    ],
    checkEnv : function() {
        var envFound = false;
        var envs = this.envs;

        if (envs.indexOf(process.argv[4]) > -1 || envs.indexOf(process.argv[3]) > -1) {
            envFound = true;
            this.env = process.argv[4] || process.argv[3]
        } else {
            process.argv[4] = this.env
        }
        return envFound
    },
    /**
     * Run cmd
     *
     * @param {object} options
     * @param {object} message
     * @param {boolean} longCMD
     * */
    run : function(options, message, longCMD){

        //inherited from utils.
        var root = getPath('root');
        //Setting log paths.
//        console.getLogger({
//            name: 'gina',
//            containers: [
//                {
//                    type: 'file',
//                    //template: '',
//                    path: _(root + '/logs'),
//                    keep: 5
//                }
//            ]
//        });

        this.options = options;
        this.msg = message;
        this.opt['option'] = process.argv[2];
        this.env = 'prod'; // by default
        var envFound = this.checkEnv();

        if (process.argv[2] == '-s' || process.argv[2] == '--start') {
            //use registeredEnvs for this.....
            if (process.argv.length >= 5 && !envFound) {
                this.env = 'prod';
                process.argv.splice(4, 0, this.env);
            }

            this.PID = new Proc('gina', process);
            //herited from gna.js.

        } else {
            this.PID = new Proc('gina', process, false);
        }

        this.PID.setMaster(process.pid);

        this.opt['argument'] = process.argv[4];

        for (var a = 4, aLen = process.argv.length; a < aLen; ++a) {
            if (process.argv[a] != undefined && process.argv[a].indexOf('=')) {
                var p = process.argv[a].split(/=/);
                this.opt[p[0]] = p[1];
            }
        }

        this.bundle = process.argv[3].replace(/.js/, '');

//        logger.setEnv(this.env);
//        logger.init({
//            logs    : _(this.options.root + '/logs'),
//            core    : _(this.options.core)
//        });
        process.env.NODE_ENV = this.env;
        this.isAllowedOption(this.opt)
    },
    isAllowedOption : function(opt){
        var found = false;
        for (var i=0; i<this.allowedOptions.length; ++i) {
            if (opt['option'] == this.allowedOptions[i]) {
                found = true;
                break;
            }
        }
        if (found) {
            this.map(opt);
        } else {
            console.error(this.msg.default[0].replace(
                "%command%",
                "gina " + opt['option']
            ) +'\n'+ this.msg.app[3]);
        }
    },
    isAllowedArgument : function(opt, callback){
        var found = false;
        for (var i=0; i<this.allowedArguments.length; ++i) {
            if (this.opt['argument'] == this.allowedArguments[i]) {
                found = true;
                break
            }
        }
        if (found || this.opt['argument'] == undefined) {
            callback(true)
        } else {
            console.error(this.msg.default[2]
                        .replace("%arg%", this.opt['argument']));
            callback(false)
        }
    },
    isAllowedType : function(opt, callback){
        var found = false;
        for (var i=0; i<this.allowedTypes.length; ++i) {
            if (opt['type'] == this.allowedTypes[i]) {
                found = true;
                break
            }
        }
        callback(found)
    },

    isRealApp : function(callback){
        var self = this;
        var allClear = false;
        var p, d;
        var bundle = this.bundle;
        var env = this.env;


        try {
            //This is mostly for dev.
            var pkg = require( _(this.options.root + '/project.json') ).bundles;
            if ( typeof(pkg[bundle].release.version) == 'undefined' && typeof(pkg[bundle].tag) != 'undefined') {
                pkg[bundle].release.version = pkg[bundle].tag
            }
            if (
                pkg[bundle] != 'undefined' && pkg[bundle]['src'] != 'undefined' && env == 'dev'
                || pkg[bundle] != 'undefined' && pkg[bundle]['src'] != 'undefined' && env == 'debug'
                ) {
                var path = pkg[bundle].src;

                p = _( this.options.root +"/"+ path );//path.replace('/' + bundle, '')
                d = _( this.options.root +"/"+ path + '/index.js' );
                this.bundleDir = path.replace('/' + bundle, '');
                setContext("bundle_dir", this.bundleDir);
                this.bundlesPath =  _( this.options.root +"/"+ this.bundleDir );
                this.bundleInit = d;

            } else {
                //Others releases.
                var path = 'releases/'+ bundle +'/' + env +'/'+ pkg[bundle].release.version;
                var version = pkg[bundle].release.version;
                p = _( this.options.root +"/"+ path );//path.replace('/' + bundle, '')
                d = _( this.options.root +"/"+ path + '/index.js' );

                this.bundleDir = path;
                this.bundlesPath = _(this.options.root + '/'+ this.bundleDir);
                this.bundleInit = d;
            }

        } catch (err) {
            // default bundlesPath.
            // TODO - log warn ?
            this.bundleDir = 'bundles';
            this.bundlesPath = _(this.options.root + '/'+this.bundleDir);
            p = _(this.options.root + '/'+this.bundleDir+'/' + this.bundle);
            d = _(this.options.root + '/'+this.bundleDir+'/' + this.bundle + '/index.js');
            this.bundleInit = d;
        }



        //p = _(this.options.root + '/' + this.bundle + '.js'),
        console.info("checking... ", p, " && ", d, " => ", this.bundleDir);
        //process.exit(42);
        //Checking root.
        fs.exists(d, function(exists) {
            if (exists) {
                //checking bundle directory.
                fs.stat(p, function(err, stats) {

                    if (err) {
                        callback(err)
                    } else {

                        if ( stats.isDirectory() ) {
                            callback(false)
                        } else {
                            callback('[ '+ d +' ] is not a directory')
                        }
                    }
                });
            } else {
                callback('[ '+ d +' ] does not exists')
            }
        })
    },
    map : function(opt){
        var self = this;

        switch (opt['option']) {
            case '-a':
            case '--add':
                this.env = 'dev';
                this.isAllowedArgument(opt, function(found) {
                    if (found) {
                        self.add(opt);
                    } else {
                        var msg = self.msg.app[2]
                                .replace("%type%", opt['type'])
                                .replace("%command%", 'gina '
                                + opt['option'] +' '
                                + self.bundle
                                +' '+ opt['argument']
                                +' '+ opt['type']);
                        console.error(msg);
                    }
                });
                break;

            case '-b':
            case '--build':

                self.isAllowedArgument(opt, function(found){
                    if (found && self.env != 'dev') {
                        self.build(opt.option);
                    } else {
                        var msg = self.msg.app[5]
                            .replace("%env%", self.env)
                            .replace("%bundle%", self.bundle);

                        console.error(msg);
                    }
                });
                break;

            case '-d':
            case '--delete':
                this.env = 'dev';
                this.remove(opt);
            break;

            case '--deploy':
            case '--deploy-init':
                self.isAllowedArgument(opt, function(found){
                    if (found) {
                        self.deploy(opt.option);
                    }
                    return false;
                });
                break;

            case '-i':
            case '--init':
                self.isAllowedArgument(opt, function(found){
                    if (found) {
                        self.initProject(opt.option);
                    }
                    return false;
                });
                break;

            case '-k':
            case '--kill':
            case '--stop':
                this.kill(opt);
                break;

            case '-r':
            case '--restart':
                this.restart(opt);
                break;

            case '-s':
            case '--start':
                self.isAllowedArgument(opt, function(found){
                    if (found) {
                        self.start(opt);
                    }
                    return false;
                });
                break;

            case '-av':
            case '-a -v':
            case '--add-views':
                this.env = 'dev';
                this.addViews();
                break;

            case '-t':
            case '--status':
                this.env = 'dev';
                this.getStatus(opt);
                break;
        }
    },
    abort : function(code, err) {

    },
    add : function(opt) {
        var project = _(getPath('root') + '/project.json');
        var envDotJson = _(getPath('root') + '/env.json');
        var bundle = this.bundle;

        //is Real bundle ?.
        if ( typeof(bundle) != 'undefined' ) {
            var addCmd = require('./gina-add-bundle')(opt, project, envDotJson, bundle)
        } else {
            console.warn('bundle is undefined !')
        }
    },
    addViews : function() {
        var self = this;
        this.isRealApp( function(err) {
            var real = false;
            if (err) {
                console.error(err.stack);
                process.exit(1)
            }

            try {
                var addViews = require('./gina-add-views')(self.bundle, self.env)
            } catch (err) {
                console.error(err.stack);
                process.exit(1)
            }
        })
    },
    build : function(opt, argument) {

        console.info('Releasing build...');
        var bundle = this.bundle;
        var projectConfPath = _(getPath('root') + '/project.json');
        try {
            var project = require(projectConfPath);
        } catch (err) {
            console.warn(err.stack);
        }
        var defaultBuildScript = 'script/build.js';
        if ( typeof(project.bundles[bundle]) == 'undefined') {
            console.error('bundle [ '+bundle+' ] not found in project');
            process.exit(1)
        }
        var defaultBuildScriptPath = _(_( getPath('root') +'/'+ project.bundles[bundle].src +'/'+defaultBuildScript ));

        //Getting project infos.
        try {
            //is Real bundle ?.
            if ( typeof(bundle) != 'undefined' && typeof(project.bundles[bundle]) != 'undefined') {
                var BuildCmd = require('./gina-build');
                if (
                    typeof(project.bundles[bundle]['script']) != 'undefined' && typeof(project.bundles[bundle]['script']['build']) != 'undefined' ||
                    fs.existsSync(defaultBuildScriptPath)
                ) {
                    // found default build script but, no build description found in project.json
                    if ( typeof(project.bundles[bundle]['script']) == 'undefined' ) { // updating project.json then
                        if ( typeof(project.bundles[bundle]['script']) == 'undefined') {
                            project.bundles[bundle]['script'] = {}
                        }
                        project.bundles[bundle]['script']['build'] = defaultBuildScript;
                        fs.writeFileSync(projectConfPath, JSON.stringify(project, null, 4))
                    }
                    var CustomBuild = require(_(getPath('root') +'/'+ project.bundles[bundle].src + '/' + project.bundles[bundle].script.build));
                    CustomBuild = inherits(CustomBuild, BuildCmd);

                    var buildCmd = new CustomBuild(project, bundle);
                } else {
                    var buildCmd = new BuildCmd(project, bundle);
                    buildCmd.init()
                }

            } else if (bundle == undefined) {
                var buildCmd = require('./gina-build')(project);
                buildCmd.init()
            } else {
                console.error('Bundle [ '+ bundle +' ] not found.')
            }
        } catch (err) {
            console.error(err.stack);
            process.exit(1)
        }

    },
    initProject : function() {
        var project = process.argv[3];
        try {
            console.log('creating new project...');
            var initCmd = require('./gina-init-project')(project)
        } catch (err) {
            console.error(err.stack);
            process.exit(1)
        }
    },
    remove : function(opt) {
        try {
            var bundle = this.bundle;
            var project = _(getPath('root') + '/project.json');
            var projectData = require(project);
            var envPath = _(getPath('root') + '/env.json');
            var isWorking = false;

            if (fs.existsSync(_(getPath('root')+'/tmp/pid'))) {
                var pids = fs.readdirSync(getPath('root')+'/tmp/pid');
                var i = pids.length-1;
                var tmpContent = null;
                while ( i >= 0 && tmpContent == null) {
                    tmpContent = fs.readFileSync(getPath('root')+'/tmp/pid/'+pids[i]);
                    if (tmpContent != bundle) {
                        tmpContent = null
                    }
                    --i
                }
                if (tmpContent != null) {
                    isWorking = true
                }
            }

            if ( typeof(bundle) != 'undefined' && typeof(projectData.bundles[bundle]) != 'undefined' && !isWorking) {
                var DeleteCmd = require('./gina-delete-bundle');
                var deleteCmd = null;
                if ( typeof(projectData.bundles[bundle]['script']) != 'undefined' && typeof(projectData.bundles[bundle]['script']['delete']) != 'undefined') {
                    var CustomDelete = require(_(getPath('root') +'/'+ projectData.bundles[bundle].src + '/' + projectData.bundles[bundle].script.delete));
                    CustomDelete = inherits(CustomDelete, DeleteCmd);
                    CustomDelete = inherits(CustomDelete, EventEmitter);
                    deleteCmd = new CustomDelete(project, envPath, bundle)
                } else {
                    DeleteCmd = inherits(DeleteCmd, EventEmitter);
                    deleteCmd = new DeleteCmd(project, envPath, bundle);
                    deleteCmd.init()
                }
            } else if (typeof(bundle) == 'undefined') {
                console.log('bundle is undefined !')
            } else if (typeof(projectData.bundles[bundle]) == 'undefined') {
                console.error('Bundle [ '+bundle+' ] does not exist !')
            } else {
                console.error('Please, stop Bundle [ '+bundle+' ] before removing !')
            }
        } catch (err) {
            console.error(err.stack);
            process.exit(1)
        }
    },

    deploy : function(opt) {
        console.log('env ?? ', this.env, opt);
        opt = opt.replace(/(--deploy-|--deploy)/, '');

        // loading options
        try {
            var conf = require(getPath('root') + '/deploy/' + this.env + '/config.json');
            conf.env = this.env;
        } catch(err) {
            console.error(err.stack);
            process.exit(1);
        }

        var root = getPath('root') + '/deploy';
        var file = (opt) ? opt : 'script'; // init, or custom script

        var userScript = root +'/'+ this.env + '/' + file+'.js';
        var path = ( typeof(conf.strategy) != 'undefined' && opt == '' ) ? root +'/bin/'+ conf.strategy + '.js' : userScript;


        if ( fs.existsSync(path) && path != userScript ) {

            // user script and available strategies inherit from Deploy
            // if a strategy is applied, you can catch complete event to do something in the end
            if ( fs.existsSync(userScript) && typeof(conf.strategy) != 'undefined') {
                var UserStrategy = require( userScript );
                var deploy = new UserStrategy(conf);
            } else {
                var Strategy = require( path );
                var deploy = new Strategy(conf);
            }
        } else if (path == userScript) {
            var UserStrategy = require( userScript );
            var deploy = new UserStrategy(conf);
            //deploy.onComplete( function(err) {
            //    console.info('user\'s deploy script completed without errors');
            //})
        } else {
            console.error('no deploy strategy found')
        }
    },
    restart : function(opt) {
        console.info('restarting app now...', opt);
    },
    /**
     * Start  server
     * @param {object} opt Options
     * */
    start : function(opt) {
        var self = this;

        console.debug('starting with options ', opt);
        this.isRealApp( function(err) {
            var real = false;
            if (err) {
                console.error(err.stack)
            } else {
                real = true
            }

//            var loggerInstance = new (Winston.Logger)({
//                levels : logger.custom.levels,
//                transports : [
//                    new (Winston.transports.Console)({
//                        colorize: true
//                    })
//                ],
//                colors : logger.custom.colors
//            });

            //setContext('logger', loggerInstance);

            if (!real) {
                console.error(self.msg.app[4].replace("%app%", self.bundle))

            } else {

                var appPath = self.bundleInit;
                var isPath = (/\//).test(appPath);
                if (!isPath) {
                    appPath = _(self.bundlesPath +'/'+ appPath + '/index');
                }

                process.list = (process.list == undefined) ? [] : process.list;
                setContext('processList', process.list);
                setContext('gina.process', process.pid);
                var params = [
                    appPath,
                    opt['argument'],
                    JSON.stringify( getContext() )//Passing context to child.
                ];

                // passing V8 options
                for (var name in opt) {
                    if ( /\-\-/.test(name) ) {
                        params.unshift(name +'='+ opt[name])
                    }
                }

                for (var i=0; i<params.length; ++i) {
                    if (params[i] == '') {
                        params.splice(i,1);
                    }
                }

                self.prc = spawn('node', params,
                    {
                        detached : true
                    }
                );
                self.PID.register(self.bundle, self.prc.pid);

                //On message.
                self.prc.stdout.setEncoding('utf8');//Set encoding.
                self.prc.stdout.on('data', function(data){
                    if ( typeof(data) == "undefined" )
                        var data = "";


                    //Catching all console.log(..)
                    // TODO - Bind or prototype console.log => logger.trace(...) to have the same stack time/order
                    if ( data.substr(0, 5) != "[LOG]" ) {
                        //console.log("traces => ", data);
                        var out = data;
                        //loggerInstance["trace"](out);//Not shared with the main flow...
                        console.info(out.toString());
                        //fix it...
                        //logger.warn('gina', 'CONSOLE:LOG:1', data);
                    } else {
                        //var data = JSON.parse(data);
                        //console.log("[traces] => ", data);

                        // TODO - Few exception to take in consideration.
                        //loggerInstance.onMessage(data, function(msg){

//                        logger.onMessage(data, function(msg){
//                            loggerInstance[msg.level](msg);
//
//                            //logger[msg.level](msg);
//                        });
                        console.info(data.toString())
                    }

                });


                //On error. Might be useless.
                self.prc.stderr.setEncoding('utf8');//Set encoding.
                self.prc.stderr.on('data', function(err) {
                    console.error(err.toString());
                });

            }

        });//EO this.isRealApp.

    },
    getStatus : function(opt){
        console.info('getting status for app now...', opt);
    },
    /**
     * Stop  server
     * @param {Object} opt Options
     * */
    stop : function(opt){
        var self = this, row = "";

        this.isRealApp( function(err){
            if (err) {
                console.error(err.stack);
                console.error(self.msg.app[4].replace("%app%", self.bundle));
                process.exit(1);
            }
        });
    }
};

module.exports = AppCommand;