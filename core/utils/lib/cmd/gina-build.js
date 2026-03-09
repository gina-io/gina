var fs              = require('fs');
var EventEmitter    = require('events').EventEmitter;
var helpers         = require('../../helpers');
var inherits        = require('../inherits');
var console         = require('../logger');
var GINA_PATH      = _( getPath('gina').core );
var Config          = require( _( GINA_PATH + '/config') );

function BuildBundle(project, bundle) {

    var self = this;
    // define all default
    this.task = 'build';//important for later in config init
    this.excluded = [
        /^\./, //all but files starting with "."
        /\.dev\.json$/ //not all ending with ".dev.json"
    ];
    this.project = _(getPath('root') + '/project.json');


    this.init = this.onInitialize = function(cb) {

        if (self.initialized == undefined) {
            self.initialized = true;
            if (typeof(cb) != 'undefined' && typeof(cb) == 'function') {
                cb(init)
            } else {
                init()
            }
        }

        return self
    }

    var init = function() {
        self.root = getPath('root');
        self.env = process.env.NODE_ENV;

        if ( typeof(bundle) != 'undefined' ) {
            console.info('building', bundle, '[ '+ self.env +' ]');
            // TODO add origin of the build.
            buildBundleFromSources(project, bundle);
        } else {
            console.info('building whole project: [ '+ self.env +' ]');
            //buildProjectFromSources(project);
        }
    }

    var buildBundleFromSources = function(project, bundle) {
        var config = new Config({
            env             : self.env,
            executionPath   : self.root,
            startingApp     : bundle,
            ginaPath       : GINA_PATH,
            task            : self.task
        });

        config.onReady( function onConfigReady(err, obj) {
            self.conf = obj.conf[bundle][self.env];
            var path = '';
            // getting release path
            if (
                typeof(project.bundles[bundle].release) != 'undefined' &&
                typeof(project.bundles[bundle].release.target) != 'undefined' &&
                project.bundles[bundle].release.target.substr(0,1) != '/'
            ) {

                path = '/'+project.bundles[bundle].release.target

            } else  if (
                typeof(project.bundles[bundle].release) != 'undefined' &&
                typeof(project.bundles[bundle].release.target) != 'undefined'
            ) {
                path = project.bundles[bundle].release.target

            } else { // no target found... making one
                // by default
                var link = ( _(self.conf.releases) ).replace(self.root + '/', '');
                if ( !project.bundles[bundle].release.link ) {
                    //save it
                    project.bundles[bundle].release.link = link;
                } else {
                    link = project.bundles[bundle].release.link
                }

                // by default
                var version = '0.0.1';
                if ( !project.bundles[bundle].release.version ) {
                    //save it
                    version = project.bundles[bundle].release.version = version
                } else {
                    version = project.bundles[bundle].release.version
                }

                // by default
                var target = link + '/' + version;
                if ( !project.bundles[bundle].release.target ) {
                    //save it
                    target = project.bundles[bundle].release.target = target
                } else {
                    target = project.bundles[bundle].release.target
                }

                path = target;
                // write to file
                fs.writeFileSync(self.project, JSON.stringify(project, null, 4));
            }



            //build(bundle, releasePath, version);
            try {
                var package = project.bundles[bundle];

                getSourceInfos(package, bundle, function (err, opt) {
                    if (err) {
                        console.error(err.stack);
                        process.exit(0);
                    }

                    var source = opt.src;
                    var target = opt.target;
                    self['release_path'] = target;
                    var version = opt.version;

                    var excluded = self.excluded;

                    var targetObj = new _(target);
                    targetObj.rm(function (err) {
                        new _(source)
                            .cp(target, excluded, function (err) {
                                console.info("Build [ "+bundle+"@"+version+" ] ready.");
                                console.log('\n\r');
                                self.emit('build#complete', err, version)
                            })
                    })
                })
            } catch (err) {
                console.error(err.stack);
                process.exit(0)
            }
        })
    }

    var getSourceInfos = function( package, bundle, callback) {


        try {
            //will always build from sources by default.
            if ( typeof(package['src']) != 'undefined' && fs.existsSync( _(self.root + '/' + package['src']) )) {
                var sourcePath = _(self.conf.sources + '/' + bundle);

                if ( typeof(package.release.version) == 'undefined' && typeof(package.tag) != 'undefined') {
                    package.release.version = package.tag
                }
                var version = package.release.version;//by default.
                if ( fs.existsSync( _(sourcePath + '/config/app.json') ) ) {
                    var appConf = require( _(sourcePath + '/config/app.json'));
                    if ( typeof(appConf['version']) != 'undefined' ) {
                        version = appConf['version']
                    }
                }

                if (version == undefined) {
                    console.error('You need a version reference to build.\n\r');
                    process.exit(1);
                }

                var releasePath = _(self.conf.releases + '/'+ bundle +'/' + self.env +'/'+ version);

                var match = _(self.root +'/' +project.bundles[bundle].src);
                if ( typeof(self.conf.content.views) != 'undefined') {
                    self['views_path'] = self.conf.content.views.default.views.replace(match, releasePath);
                }
                callback(false, {
                    src     : sourcePath,
                    target  : releasePath,
                    version : version
                })
            } else if ( typeof(package['repo']) != 'undefined' ) {
                //relies on configuration.
                console.error('Build from repo is a feature in progress.\n\r');
                process.exit(0)
            } else {
                console.error('No source reference found for build. Need to add [src] or [repo]\n\r');
                process.exit(0)
            }
        } catch (err) {
            callback(err)
        }
    }

//    var buildProjectFromSources = function(project) {
//
//    };
//
//    var buildBundleFromRepo = function(project, bundle) {
//
//    };
//
//    var buildProjectFromRepo = function(project) {
//
//    };

    this.onComplete = function(callback) {
        self.once('build#complete', function(err, version) {
            //if (!err) console.info("Build "+version+" ready.\n\r");

            callback(err)
        });

        return self
    }

};

BuildBundle = inherits(BuildBundle, EventEmitter);
module.exports = BuildBundle