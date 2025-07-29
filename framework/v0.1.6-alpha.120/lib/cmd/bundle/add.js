var fs          = require('fs');
var readline    = require('readline');
var rl          = readline.createInterface({ input: process.stdin, output: process.stdout });


var CmdHelper   = require('./../helper');
var console     = lib.logger;
var scan        = require('../port/inc/scan');


/**
 * Add new bundle to a given project.
 * NB.: If bundle exists, You will be asked if you want to replace.
 *
 * Usage:
 * $ gina bundle:add <bundle_name> @<project_name>
 * or
 * $ gina bundle:add <bundle_name> @<project_name> --start-port-from=<port_number>
 * */
function Add(opt, cmd) {

    var self    = {
            // --start-port-from
            startFrom: null
        }
        , local     = {
            // bundle index while searching or browsing
            b : 0,
            bundle : null,
            bundlePath : null
        }
    ;

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        var portErr = null;
        for (let i=3, len=process.argv.length; i<len; i++) {
            if ( /^\-\-start\-port\-from\=/.test(process.argv[i]) ) {
                let port = process.argv[i].split(/\=/)[1];
                if ( /[^0-9]+/.test(port) ) {
                    portErr = new Error('Port number must be an integer');
                    break;
                }
                port = parseInt(port);
                if (
                    typeof(port) != 'number'
                    || !Number.isInteger(port)
                ) {
                    portErr = new Error('Port number must be an integer');
                    break;
                }
                self.startFrom = port
            }
        }

        if (portErr) {
            console.error(portErr.message||portErr);
            return process.exit(1)
        }

        // var i = 3, envs = [];
        // for (; i<process.argv.length; ++i) {
        //     if ( /^\@[a-z0-9_.]/.test(process.argv[i]) ) {
        //         if ( !isValidName(process.argv[i]) ) {
        //             console.error('[ '+process.argv[i]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
        //             process.exit(1);
        //         }

        //     } else if (/^[a-z0-9_.]/.test(process.argv[i])) {
        //         envs.push(process.argv[i])
        //     }
        // }

        if (isDefined('project', self.projectName)) {
            addBundles(0);
        } else {
            //console.error('[ '+ self.projectName+' ] is not an existing project');
            if ( self.bundles.length == 0) {
                console.error('Missing argument <bundle_name>');
            } else if  (!isDefined('project', self.projectName) ) {
                console.error('[' + self.projectName +'] is not an existing project.');
            } else {
                console.error('Missing argument @<project_name>');
            }

            process.exit(1)
        }
    }



    /**
     * Add bundles
     *
     * @param {number} b - bundle index
     *
     * */
    var addBundles = function(b) {

        if (b > self.bundles.length-1) { // exits when done
            process.exit(0)
        }

        var options     = {}
            , bundle    = self.bundles[b]
        ;


        if ( /^[a-z0-9_.]/.test(bundle) ) {

            if ( !fs.existsSync(self.envPath) ) {
                lib.generator.createFileFromDataSync({}, self.envPath);
            }

            local.b             = b;
            local.bundle        = bundle;

            local.envFileSaved  = false;

            // find available port
            options = {
                ignore      : getPortsList(),
                limit       : getBundleScanLimit(bundle),
                startFrom   : self.startFrom
            };
            console.log('['+bundle+'] starting ports scan' );

            // scanning for available ports ...
            scan(options, function(err, ports){
                if (err) {
                    rollback(err);
                    return;
                }

                for (let p=0; p<ports.length; ++p) {
                    self.portsList.push(ports[p])
                }
                self.portsList.sort();

                console.debug('available ports '+ JSON.stringify(ports, null, 2));
                self.portsAvailable = ports;
                try {
                    check();
                } catch (err) {
                    rollback(err)
                }
            })

        } else {
            console.error('[ '+ bundle+' ] is not a valid bundle name')
            process.exit(1)
        }
    }

    var check = function() {

        if ( typeof(self.projectData.bundles[local.bundle]) != 'undefined' ) {

            if ( /\-\-(import|replace)/.test(opt.argv.join(',')) ) {
                var pArr                = null
                    , importModeEnabled = false
                    , replaceModeEnabled = false
                ;
                for (let i = 0, len = opt.argv.length; i<len; i++) {
                    if (  !/\-\-(import|replace)/.test(opt.argv[i]) )
                        continue;

                    pArr = opt.argv[i].replace(/\s+/g, '').split(/=/);
                    importModeEnabled   = /\-import/.test(pArr[0]) ? true : false;
                    replaceModeEnabled  = /\-replace/.test(pArr[0]) ? true : false;
                    // only allowing one argument
                    break;
                }
                if (importModeEnabled) {
                    local.envFileSaved = true;
                    makeBundle(local.bundle, false);
                }

                if (replaceModeEnabled) {
                    makeBundle(local.bundle, true);
                }
                return;
            }

            rl.setPrompt('Bundle [ '+ local.bundle +' ] already exists !\n(r) Replace - All existing files will be lost !\n(c) Cancel\n(i) Import\n> ');

            rl.prompt();

            rl
                .on('line', function(line) {

                    switch( line.trim().toLowerCase() ) {

                        case 'r':
                        case 'replace':
                            rl.clearLine();
                            makeBundle(local.bundle, true);
                        break;

                        case 'c':
                        case 'cancel':

                            if (local.b < self.bundles.length) {

                                rl.clearLine();
                                // continue to next bundle
                                ++local.b;
                                addBundles(local.b)

                            } else {

                                console.log('Aborting bundle installation');
                                rl.clearLine();
                                process.exit(0);
                            }

                        break;

                        case 'i':
                        case 'import':

                            rl.clearLine();
                            local.envFileSaved = true;
                            makeBundle(local.bundle, false);

                        break;

                        default:
                            console.log('Please, write "r" to proceed or "c" to cancel.');
                            rl.prompt();
                    }
                })
                .on('close', function() {
                    rl.clearLine();
                    console.log('Exiting bundle installation');
                    process.exit(0)

                });
        } else {
            makeBundle(local.bundle, false)
        }
    }

    var makeBundle = async function(bundle, rewrite) {

        loadAssets();

        // if ( /^true$/i.test(rewrite) ) {
        //     fixPorts
        //     return
        // }

        setPorts(bundle, self.portsAvailable, function onPortsSet(err){
            if (err) {
                rollback(err);
                return;
            }

            if (!local.envFileSaved) {
                saveEnvFile(function doneSavingEnv(err){

                    if (err) rollback(err);

                    saveProjectFile( function doneSavingProject(err, content) {

                        if ( err ) {
                            rollback(err);
                            return;
                        }

                        if (rewrite) {
                            delete content.bundles[local.bundle]
                        }
                        createBundle()
                    })
                })

            } else { // importing
                console.log('Bundle [ '+ local.bundle +' ] has been imported to your project with success ;)');
                rl.clearLine();
                ++local.b;
                addBundles(local.b)
            }
        });
    }

    /**
     * Save manifest.json
     *
     * @param {string} projectPath
     * @param {object} content - Project file content to save
     *
     * */
    var saveProjectFile = function(callback) {

        var data    = JSON.clone(self.projectData);
        var version = '0.0.1';
        var envs    = self.projects[self.projectName].envs;
        var scopes  = self.projects[self.projectName].scopes;

        data.bundles[local.bundle] = {
            "_comment" : "Your comment goes here.",
            "version"   : version,
            "tag" : ( version.split('.') ).join(''),
            "src" : "src/" + local.bundle,
            "link"      : "bundles/"+ local.bundle,
            "releases" : {}
        };
        //"release/"+ local.bundle +"/local/" +"/prod/" + version
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


        try {
            lib.generator.createFileFromDataSync(data, self.projectManifestPath);
            local.projectDataWrote = true;

            callback(false, data)

        } catch (err) {
            callback(err)
        }
    }

    /**
     * Save env path
     *
     * */
    var saveEnvFile = function(callback) {

        loadAssets();

        var e               = 0
            // working with copies in case of rollback
            , content       = JSON.clone(self.envData)
        ;


        if ( typeof(content[local.bundle]) != 'undefined' ) {
            delete content[local.bundle]
        }

        for (; e < self.envs.length; ++e) {

            if ( typeof(content[local.bundle]) == 'undefined' ) {
                content[local.bundle] = {}
            }
            content[local.bundle][ self.envs[e] ] = {
                "host_if_dns_resolution" : "{rootDomain}",
                "host" : "localhost"
            };

        }

        try {

            // save to ~/.gina/envs.json
            lib.generator.createFileFromDataSync(content, self.envPath);
            local.envDataWrote = true;

            local.envFileSaved = true;

            callback(false)
        } catch (err) {
            callback(err)
        }
    }



    /**
     * Create bundle default sources under /src
     *
     * @param {string} bundle
     * @param {object} project
     * */
    var createBundle = function() {

        loadAssets();

        var projectData = requireJSON(self.projectManifestPath)
            , target    = _( self.projects[self.projectName].path +'/'+ projectData.bundles[local.bundle].src, true )
            , sample    = new _( getPath('gina').core + '/template/boilerplate/bundle/' );


        sample.cp(target, function done(err, destination) {

            if (err) {
                rollback(err);
                return;
            }

            // Browse, parse and replace keys
            local.source        = target;
            local.isInstalled   = false;

            // check installed bundle
            browse(local.source);

            if (local.isInstalled) {

                // remove files we don't want yet
                new _(destination + '/config/templates.json', true).rmSync();

                // if first bundle of th project, modify webroot
                if (self.bundlesByProject[self.projectName].count() == 1) {
                    var settingsServerPath = _(destination + '/config/settings.server.json', true);
                    var serverSettings = fs.readFileSync(settingsServerPath).toString();
                    serverSettings = serverSettings.replace('"webroot": "/{bundle}"', '"webroot": "/"');
                    lib.generator.createFileFromDataSync(serverSettings, settingsServerPath);
                }



                console.log('Bundle [ '+ local.bundle +' ] has been added to your project with success ;)');
                rl.clearLine();
                ++local.b;
                addBundles(local.b)
            }

        })
    }

    /**
     * Browse sources
     *
     * @param {string} source
     * @param {string} bundle
     * */
    var browse = function(source, list) {

        var newSource   = null
            , files     = fs.readdirSync(source)
            , f         = 0
        ;

        if (source == local.source && typeof(list) == 'undefined') {//root
            list = [];// root list
            for (let l=0; l<files.length; ++l) {
                list[l] = _(local.source +'/'+ files[l])
            }
        }

        if (!files && list.indexOf(source) > -1) {
            list.splice( list.indexOf(source), 1 )
        }

        for (; f < files.length; ++f) {
            newSource = _(source +'/'+ files[f]);
            if ( fs.statSync(newSource).isDirectory() ) {
                browse(newSource, list)
            } else {
                list = parse(newSource, list)
            }

            if ( f == files.length-1) { //end of current dir
                var p = newSource.split('/');
                p.splice(p.length -1);
                newSource = p.join('/');
                if (list != undefined && list.indexOf(newSource) > -1) {
                    list.splice( list.indexOf(newSource), 1 )
                }
            }

            if (f == files.length-1 && list.length == 0) { //end of all

                local.isInstalled = true;

                break
            }
        }
    }

    /**
     * Parse file and modify only javascripts - *.js
     *
     * @param {string} file - File to parse
     * @param {array} list
     * */
    var parse = function(file, list) {
        //console.log('replacing: ', file);
        try {
            var f = null;
            f = (f=file.split(/\//))[f.length-1];
            var isJS = /\.js/.test(f.substring(f.length-3))
                , isJSON = /\.json/.test(f.substring(f.length-5))
            ;

            if ( isJS || isJSON /*&& /config\/app\.json/.test(file)*/ ) {
                var contentFile = fs.readFileSync(file, 'utf8').toString();
                var dic = {
                    "Bundle" : local.bundle.substring(0, 1).toUpperCase() + local.bundle.substring(1),
                    "bundle" : local.bundle
                };

                contentFile = whisper(dic, contentFile);
                //rewrite file
                lib.generator.createFileFromDataSync(contentFile, file)
            }

            if ( list != undefined && list.indexOf(file) > -1 ) { //end of current dir
                list.splice( list.indexOf(file), 1 )
            }
            return list

        } catch(err) {
            console.error(err.stack);
            process.exit(1)
        }
    }

    var rollback = function(err) {
        console.error('could not complete bundle creation: ', (err.stack||err.message));
        console.warn('rolling back...');

        var writeFiles = function() {
            //restore env.json
            lib.generator.createFileFromDataSync(self.envData, self.envPath);

            //restore manifest.json
            if ( typeof(self.projectData.bundles[local.bundle]) != 'undefined') {
                delete self.projectData.bundles[local.bundle]
            }
            lib.generator.createFileFromDataSync(self.projectData, self.projectManifestPath);

            //restore ports.json
            lib.generator.createFileFromDataSync(self.portsData, self.portsPath);

            //restore ports.reverse.json
            lib.generator.createFileFromDataSync(self.portsReverseData, self.portsReversePath);


            process.exit(1)
        };

        var bundle = new _(local.source);
        if ( bundle.existsSync() ) {
            bundle.rm( function(err) {//remove folder
                if (err) {
                    throw err
                }
                writeFiles()
            })
        } else {
            writeFiles()
        }
    };

    init()
};

module.exports = Add