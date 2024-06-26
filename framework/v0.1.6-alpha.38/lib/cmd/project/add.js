var fs          = require('fs');
var os          = require('os');
var util        = require('util');
var promisify   = util.promisify;

var CmdHelper   = require('./../helper');
var Shell       = lib.Shell;
var console     = lib.logger;
var scan        = require('../port/inc/scan');

/**
 * Add new project or register old one to `~/.gina/projects.json`.
 * NB.: If project exists, it won't be replaced. You'll only get warnings.
 * */
function Add(opt, cmd) {

    var self        = {}
        , local     = {
            // bundle index while searching or browsing
            b : 0,
            bundle : null,
            bundlePath : null,
            ports : []
        }
    ;

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;
        for (let i=3, len=process.argv.length; i<len; i++) {
            if ( /^\-\-start\-port\-from\=/.test(process.argv[i]) ) {
                self.startFrom = process.argv[i].split(/\=/)[1]
            }
        }

        local.imported = ( /\:import/i.test(self.task) ) ? true : false;
        if ( checkImportMode() ) {
            return;
        }

        var err         = false
            , folder    = null
            , file      = null
        ;

        folder = new _(self.projectLocation);

        if ( folder.isValidPath() && isValidName(self.projectName) ) {

            err = folder.mkdirSync();

            if (err instanceof Error) {
                console.error(err.stack);
                process.exit(1)
            }
        }

        loadAssets();

        // creating package file
        file = new _(self.projectLocation + '/package.json', true);
        if ( !file.existsSync() ) {
            createPackageFile( file.toString() )
        } else {
            console.warn('[ package.json ] already exists in this location: '+ file + '\nUpdating package.json...');
            createPackageFile( file.toString(), true )
        }

        // creating project manifest
        file = new _(self.projectManifestPath, true);
        // override for `add` & `import`
        // if ( !file.existsSync() ) {
            createManifestFile( file.toString() )
        // } else {
        //     console.warn('[ manifest.json ] already exists in this location: '+ file);
        // }

        // creating env file
        file = new _(self.projectLocation + '/env.json', true);
        if ( !file.existsSync() ) {
            createEnvFile( file.toString() )
        } else {
            console.warn('[ env.json ] already exists in this location: '+ file);
        }
    }

    var checkImportMode = function() {

        if ( self.task != 'project:import')
            return;

        console.debug('Starting import mode @'+ self.projectName );
        if (!self.projects[self.projectName ]) {
            console.error('[ '+ self.projectName  +' ] is not an existing project. Instead, use gina projet:add @'+ self.projectName +' --path='+ self.projectLocation);
            process.exit(1);
        }

        if ( typeof(self.projects[self.projectName ]) != 'undefined' ) {
            // import if exists but path just changed
            if ( typeof(self.projects[self.projectName ].path) != 'undefined') {
                var old = new _(self.projects[self.projectName ].path, true).toArray().last();
                var current = new _(self.projectLocation, true).toArray().last();

                if (old === self.projectName) {
                    self.projects[self.projectName ].path = self.projectLocation;

                    var target = _(GINA_HOMEDIR + '/projects.json')
                        , projects = JSON.clone(self.projects);

                    lib.generator.createFileFromDataSync(
                        projects,
                        target
                    );


                    var ginaModule = _( self.projectLocation +'/node_modules/gina',true );

                    if ( !fs.existsSync(ginaModule) ) {
                        linkGina(
                            function onError(err) {
                                console.error(err.stack);
                                process.exit(1)
                            },
                            function onSuccess() {
                                local.imported = true;
                                end();
                                return true;
                            })

                    } else {
                        local.imported = true;
                        end();
                        return true;
                    }
                }
            } else {
                console.error('[ '+ self.projectLocation  +' ] is an existing project. Please choose another name for your project or remove this one.');
                process.exit(1)
            }
        }
    }

    var createManifestFile = function(target) {

        loadAssets();

        var conf            = _(getPath('gina').core +'/template/conf/manifest.json', true);
        var contentFile     = requireJSON(conf);
        var packageContent  = requireJSON(_(self.projectLocation + '/package.json', true));
        var version = packageContent.version || "1.0.0";
        // hostname by default
        var rootDomain = os.hostname();
        // fqdn by default
        var shortVersion = GINA_SHORT_VERSION;// jshint ignore:line
        home = GINA_HOMEDIR;// jshint ignore:line
        var homeVersionDirObj = new _( home +'/'+ shortVersion, true );
        var settingsPath = _( homeVersionDirObj.toString() +'/settings.json', true );// jshint ignore:line
        if ( new _(settingsPath).existsSync() ) {
            var settings = requireJSON(settingsPath);// jshint ignore:line
            if ( settings.hostname != 'localhost' ) {
                rootDomain = settings.hostname;
            }
        }
        var bundles = {};
        if ( new _(target).existsSync() ) {
            var existingManifest = requireJSON(target);
            if ( typeof(existingManifest.rootDomain) != 'undefined' && existingManifest.rootDomain != os.hostname() ) {
                rootDomain = existingManifest.rootDomain;
            }
            existingManifest.version = version;
            existingManifest.rootDomain = rootDomain;
            if ( typeof(existingManifest.bundles) != 'undefined' ) {
                bundles = JSON.clone(existingManifest.bundles);
                delete existingManifest.bundles;
            }

            contentFile = merge(existingManifest, contentFile);
            contentFile.bundles = bundles;
        }

        var dic = {
            "project"   : self.projectName,
            "version"   : version,
            "scope"     : self.defaultScope || self.mainConfig['def_scope'][ GINA_SHORT_VERSION ],
            "rootDomain": rootDomain
        };

        contentFile = whisper(dic, contentFile); //data
        lib.generator.createFileFromDataSync(
            contentFile,
            target
        )
    }

    var createEnvFile = function(target) {

        lib.generator.createFileFromDataSync(
            {},
            target
        )
    }


    var createPackageFile = function(target, isCreatedFromExistingPackage) {

        loadAssets();

        var conf = _(getPath('gina').core +'/template/conf/package.json', true);
        var contentFile = requireJSON(conf);


        var dic = {
            'project' : self.projectName,
            'node_version' : GINA_NODE_VERSION.match(/\d+/g).join('.'),
            'gina_version' : GINA_VERSION
        };

        contentFile = whisper(dic, contentFile);//data

        // Updating package.json if needed
        if (
            typeof(isCreatedFromExistingPackage) != 'undefined'
            && /^true$/i.test(isCreatedFromExistingPackage)
        ) {
            var existingPack = require(target);
            contentFile = merge(contentFile, existingPack);
            contentFile.version = existingPack.version || "1.0.0";
            new _(target, true).rmSync()
        }

        lib.generator.createFileFromDataSync(
            contentFile,
            target
        );

        end(true)
    }

    var end = async function(created) {

        var target      = _(GINA_HOMEDIR + '/projects.json')
            , projects  = JSON.clone(self.projects)
            , error     = false
        ;

        projects[self.projectName] = {
            "path"              : self.projectLocation,
            "homedir"           : self.projectHomedir || _(getUserHome() +'/.'+ self.projectName, true),
            "bundles_path"      : self.projectBundlesPath || _(getUserHome() +'/.'+ self.projectName +'/bunldes', true),
            "releases_path"     : self.projectReleasesPath || _(getUserHome() +'/.'+ self.projectName +'/releases', true),
            "logs_path"         : self.projectLogsPath || _(getUserHome() +'/.'+ self.projectName +'/var/logs', true),
            "tmp_path"          : self.projectTmpPath || _(getUserHome() +'/.'+ self.projectName +'/tmp', true),
            "def_prefix"        : GINA_PREFIX,
            "framework"         : "v" + GINA_VERSION,
            "envs"              : (self.envs && self.envs.length) ? self.envs : self.mainConfig['envs'][ GINA_SHORT_VERSION ],
            "def_env"           : self.defaultEnv || self.mainConfig['def_env'][ GINA_SHORT_VERSION ],
            "dev_env"           : self.devEnv || self.mainConfig['dev_env'][ GINA_SHORT_VERSION ],
            "scopes"            : (self.scopes && self.scopes.length) ? self.scopes : self.mainConfig['scopes'][ GINA_SHORT_VERSION ],
            "def_scope"         : self.defaultScope || self.mainConfig['def_scope'][ GINA_SHORT_VERSION ],
            "local_scope"       : self.localScope || self.mainConfig['local_scope'][ GINA_SHORT_VERSION ],
            "production_scope"  : self.productionScope || self.mainConfig['production_scope'][ GINA_SHORT_VERSION ],
            "protocols"         : (created) ? self.protocolsAvailable : self.protocols,
            "def_protocol"      : self.defaultProtocol,
            "schemes"           : (created) ? self.schemesAvailable : self.schemes,
            "def_scheme"        : self.defaultScheme
        };

        // On import only
        if ( /^true$/i.test(local.imported) ) {
            self.bundles.sort();
            var bundleErr = null;
            // Create/update ports, protocols & schemes
            await promisify(addBundlePorts)(0)
                .catch( function onBundlePortsError(err) {
                    bundleErr = err;
                });
            if (bundleErr) {
                console.error('Could not finalize [ addBundlePorts ] \n'+ bundleErr.stack);
                process.exit(1)
            }

            // Create/update manifest
            await promisify(addBundleToManifest)(null, 0)
                .catch( function onBundleError(err) {
                    bundleErr = err;
                });
            if (bundleErr) {
                console.error('Could not finalize [ addBundleToManifest ] \n'+ bundleErr.stack);
                process.exit(1)
            }
        }


        // writing file
        lib.generator.createFileFromDataSync(
            projects,
            target
        );



        var onSuccess = function () {
            if ( /project\:add/i.test(self.task) ) {
                console.log('Project [ '+ self.projectName +' ] has been added');
            } else {
                console.log('Project [ '+ self.projectName +' ] has been imported');
            }

            process.exit(0)
        }

        var onError = function (err) {
            console.error('Could not finalize [ '+ self.projectName +' ] install\n'+ err.stack);
            process.exit(1)
        }




        var ginaModule = new _( self.projectLocation +'/node_modules/gina',true );

        if ( !ginaModule.existsSync() ) {
            linkGina(onError, onSuccess)
        } else if ( /^true$/i.test(GINA_GLOBAL_MODE) ) {

            error = ginaModule.rmSync();

            if (error instanceof Error) {
                console.error(err.stack);
                process.exit(1);
            } else {
                linkGina(onError, onSuccess)
            }

        } else {
            onSuccess()
        }
    }

    var hasPastProtocolAndSchemeCheck = function (protocol, scheme, exitOnError) {
        loadAssets();

        // are selected protocol & scheme allowed ?
        if ( self.protocolsAvailable.indexOf(protocol) < 0 ) {
            console.error('Protocol [ '+scheme+' ] is not an allowed protocol: check your framework configuration (~/main.json)');
            if ( typeof(exitOnError) != 'undefined' && exitOnError)
                process.exit(1)
        }
        if ( self.schemesAvailable.indexOf(scheme) < 0 ) {
            console.error('Scheme [ '+scheme+' ] is not an allowed scheme: check your framework configuration (~/main.json)');
            if ( typeof(exitOnError) != 'undefined' && exitOnError)
                process.exit(1)
        }
    }

    /**
     * addBundlePorts
     * Add / update project default protocol, scheme & ports
     *
     * NB.: also used in `port:reset` task
     *
     * @param {number} b - Bundle index
     * @callback done
     *  @param {object|bool} err
     *  @param {array} ports
     */
    var addBundlePorts = async function(b, done) {
        loadAssets();

        if (b > self.bundles.length-1) { // writing to files on complete

            hasPastProtocolAndSchemeCheck(self.defaultProtocol, self.defaultScheme, true);

            //console.debug('self.protocols ...', self.protocols);
            // get user protocols list
            var protocols = JSON.clone(self.protocols);
            // get user schemes list
            var schemes = JSON.clone(self.schemes);
            var projectConfig   = JSON.clone(self.projects);

            //console.debug('about to update project ports conf\n\rBundles: '+ JSON.stringify(self.projectData, null, 4));
            var ports               = JSON.clone(self.portsData) // cloning
                , portsReverse      = JSON.clone(self.portsReverseData) // cloning
                , portsList         = local.ports
                , isPortUsed        = false
                , envs              = self.envs
                , i                 = 0
                , defaultProtocol   = self.defaultProtocol
                , defaultScheme     = self.defaultScheme
            ;

            if ( typeof(ports[defaultProtocol]) == 'undefined' ) {
                ports[defaultProtocol] = {};
            }

            if ( typeof(ports[defaultProtocol][defaultScheme]) == 'undefined' ) {
                ports[defaultProtocol][defaultScheme] = {};
            }

            // to fixe bundle settings inconsistency
            var bundleConfig    = null;
            var settingsPath    = null;
            var bundleSettingsUpdate = false;

            var portValue = null, portReverseValue = null;
            var re = null, portsListStr = JSON.stringify(self.portsData);

            for (;i < portsList.length; ++i) {

                if ( !ports.count() ) {
                    ports[defaultProtocol] = {};
                    ports[defaultProtocol][defaultScheme] = {};
                    ports[defaultProtocol][defaultScheme][ portsList[i] ] = null;
                }


                for ( let protocol in ports ) {
                    // ignore unmatched protocol : in case of the framework update
                    if ( self.protocolsAvailable.indexOf(protocol) < 0) {
                        delete ports[protocol];
                        if ( protocols.indexOf(protocol) < 0) {
                            delete self.protocols[self.protocols.indexOf(protocol)];
                        }
                        continue;
                    }

                    for (let scheme in ports[protocol]) {

                        // skipping none `https` schemes for `http/2`
                        if ( /^http\/2/.test(protocol) && scheme != 'https' ) {
                            console.debug('skipping none `https` schemes for `http/2`');
                            continue;
                        }

                        if ( !ports[protocol][scheme].count() ) {
                            ports[protocol][scheme][ portsList[i] ] = null;
                        }

                        for (let b = 0, bLen = self.bundles.length; b < bLen; ++b) {

                            local.bundle = self.bundles[b];

                            // bundle settings inconsistency check @ fix
                            bundleName              = local.bundle;
                            bundleConfig            = self.bundlesByProject[self.projectName][bundleName];
                            settingsPath            = _(bundleConfig.configPaths.settings, true);
                            bundleSettingsUpdate    = false;

                            if ( fs.existsSync(settingsPath) ) {

                                bundleSettings  = requireJSON(settingsPath);
                                //console.debug('found [ '+ bundleName +' ] settings ');
                                if ( typeof(bundleSettings.server) != 'undefined' ) {
                                    // update only if given bundle protocol setting not in project protocols list
                                    // use project def_protocol by default in that case
                                    if (
                                        typeof(bundleSettings.server.protocol) != 'undefined'
                                        && protocols.indexOf(bundleSettings.server.protocol) < 0
                                    ) {
                                        bundleSettings.server.protocol = self.defaultProtocol;
                                        bundleSettingsUpdate = true
                                    }

                                    // update only if given bundle scheme setting not in project schemes list
                                    // use project def_scheme by default in that case
                                    if (
                                        typeof(bundleSettings.server.scheme) != 'undefined'
                                        && schemes.indexOf(bundleSettings.server.scheme) < 0
                                    ) {
                                        bundleSettings.server.scheme = self.defaultScheme;
                                        bundleSettingsUpdate = true
                                    }

                                    if (bundleSettingsUpdate) {
                                        lib.generator.createFileFromDataSync(bundleSettings, settingsPath);
                                        console.debug('updated [ '+ bundleName +' ] settings');
                                    }
                                }
                            }

                            // updating ports
                            for (let port in ports[protocol][scheme]) {


                                    for (let e = 0, envsLen = envs.length; e < envsLen; ++e ) {

                                        if (!portsList[i]) break;

                                        // ports
                                        portValue = local.bundle +'@'+ self.projectName +'/'+ envs[e];
                                        re = new RegExp(portValue);


                                        if ( !re.test(portsListStr) ) {

                                            // ports - add only if not existing
                                            isPortUsed = false;

                                            for (let portNum in ports[protocol][scheme]) {
                                                if ( ports[protocol][scheme][portNum] == portValue ) {
                                                    isPortUsed = true;
                                                    break;
                                                }
                                            }
                                            //console.debug('portValue -> ', portValue+ ': '+ portsList[i] +' ? ' +isPortUsed);
                                            if (!isPortUsed) {
                                                //console.debug(local.bundle, ': ',portsList[i], ' => ', portValue);
                                                ports[protocol][scheme][ portsList[i] ] = portValue;

                                                // reverse ports
                                                portReverseValue = portsList[i];
                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ] = {};

                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ] = {};

                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ] = {};

                                                // erasing in order to keep consistency
                                                portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ][ scheme ] = ~~portsList[i];


                                                ++i;
                                            }
                                        }
                                    }

                                }
                        }
                    }
                }
            }

            // save to ~/.gina/projects.json
            lib.generator.createFileFromDataSync(projectConfig, self.projectConfigPath);

            // save to ~/.gina/ports.json
            //console.debug('data \n'+ JSON.stringify(self.portsData, null, 4) +'\n\rcurrent \n'+ JSON.stringify(ports, null, 4));
            lib.generator.createFileFromDataSync( merge(self.portsData, ports), self.portsPath);

            // save to ~/.gina/ports.reverse.json
            lib.generator.createFileFromDataSync( merge(self.portsReverseData, portsReverse), self.portsReversePath);


            return done(false);
        }

        //console.debug('Bundles list on project import [ '+ b +' ]', self.bundles.length, self.bundles);
        var options     = {}
            , bundle    = self.bundles[b]
        ;

        if ( /^[a-z0-9_.]/.test(bundle) ) {

            local.b             = b;
            local.bundle        = bundle;

            // find available port
            options = {
                // ignore  : merge(self.portsGlobalList, local.ports),
                ignore  : local.ports,
                // get for each bundle ports for available protocol, scheme & env
                limit   : ( self.protocolsAvailable.length * self.schemesAvailable.length * self.envs.length * self.bundles.length )
            };

            // defining range startFrom depending of the project index (self.projectsList - OK only)...
            if (self.startFrom) {
                options.startFrom = self.startFrom;
            } else { // Find startFrom out of projects
                options.startFrom = ~~(''+ (self.projectsList.indexOf(self.projectName)+3) + 100);
            }
            // scanning for available ports ...
            // var scanErr = null;
            // await promisify(scan)(options)
            //     .catch(function onScanErr(err) {
            //         scanErr = err;
            //     })
            //     .then( function onPortsFound(ports) {
            //         for (let p = 0; p < ports.length; ++p) {
            //             local.ports.push(ports[p])
            //         }

            //         local.ports.sort();

            //         ++local.b;
            //         addBundlePorts(local.b, done);
            //     });

            // if (scanErr) {
            //     console.error(err.stack|err.message);
            //     process.exit(1)
            // }

            await scan(options, function(err, ports){
                if (err) {
                    console.error(err.stack|err.message);
                    process.exit(1)
                }


                for (let p = 0; p < ports.length; ++p) {
                    local.ports.push(ports[p])
                }

                local.ports.sort();

                ++local.b;
                addBundlePorts(local.b, done);

            });




        } else {
            // console.error('[ '+ bundle+' ] is not a valid bundle name')
            // process.exit(1)
            return done( new Error('[ '+ bundle+' ] is not a valid bundle name'))
        }
    }

    /**
     * addBundleToManifest
     * Add / update project manifest
     *
     *
     * @param {number} b - Bundle index
     * @callback done
     *  @param {object|bool} err
     *  @param {array} ports
     */
    var addBundleToManifest = function(data, b, done) {

        loadAssets();

        if ( typeof(data) == 'undefined' || !data ) {
            data = JSON.clone(self.projectData);
        }

        if (b > self.bundles.length-1) { // writing to files on complete

            lib.generator.createFileFromDataSync(data, self.projectManifestPath);

            return done(false);
        }



        var bundle = self.bundles[b];

        if ( /^[a-z0-9_.]/.test(bundle) ) {

            local.b             = b;
            local.bundle        = bundle;


            var version = '0.0.1';
            var scopes  = self.projects[self.projectName].scopes;
            var envs    = self.projects[self.projectName].envs;
            data.bundles[local.bundle] = {
                "_comment"  : "Your comment goes here.",
                "version"   : version,
                "tag"       : ( version.split('.') ).join(''),
                "src"       : "src/" + local.bundle,
                "link"      : "bundles/"+ local.bundle,
                "releases"  : {}
            };
            //"release/"+ local.bundle +"/local/prod/" + version
            for (let s = 0, sLen = scopes.length; s < sLen; ++s) {
                let scope = scopes[s];
                if ( typeof(data.bundles[local.bundle].releases[scope]) == 'undefined' ) {
                    data.bundles[local.bundle].releases[scope] = {}
                }
                for (let i = 0, len = envs.length; i < len; ++i) {
                    let env = envs[i];
                    // ignore target for dev env
                    if ( self.projects[self.projectName]['dev_env'] == env ) {
                        continue;
                    }
                    if ( typeof(data.bundles[local.bundle].releases[scope][env]) == 'undefined' ) {
                        data.bundles[local.bundle].releases[scope][env] = {}
                    }
                    data.bundles[local.bundle].releases[scope][env].target = "releases/"+ local.bundle +"/"+ scope +"/"+ env +"/" + version;
                }
            }


            ++local.b;
            addBundleToManifest(data, local.b, done);

        } else {
            // console.error('[ '+ bundle+' ] is not a valid bundle name')
            // process.exit(1)
            return done( new Error('[ '+ bundle+' ] is not a valid bundle name'))
        }
    }

    var linkGina = function ( onError, onSuccess ) {

        var npm = new Shell();

        npm.setOptions({ chdir: self.projectLocation });
        npm
            // .run('npm link gina', true)
            .run('gina link @'+ self.projectName, true)
            .onComplete(function (err, data) {
                if (err) {
                    if ( typeof(onSuccess) != 'undefined' ) {
                        onSuccess(err);
                    } else {
                        console.error(err.stack);
                    }

                } else {
                    if ( typeof(onSuccess) != 'undefined' )
                        onSuccess()
                }
            })
    }

    init()
}
module.exports = Add;