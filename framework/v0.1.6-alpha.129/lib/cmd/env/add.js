var fs      = require('fs');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
var scan        = require('../port/inc/scan.js');

/**
 * Add new environment for a given project
 *
 *
 * */
function Add(opt, cmd) {
    var self = {}, local = {};

    var init = function() {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        self.projects = requireJSON(_(GINA_HOMEDIR + '/projects.json', true));
        self.bundles = [];
        self.portsAvailable = {};

        var i = 3, envs = [];
        for (; i<process.argv.length; ++i) {
            if ( /^\@[a-z0-9_.]/.test(process.argv[i]) ) {
                if ( !isValidName(process.argv[i]) ) {
                    console.error('[ '+process.argv[i]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
                    process.exit(1);
                }

            }
            else if (/^[a-z0-9_.]/.test(process.argv[i])) {
                local.env = process.argv[i];
                envs.push(process.argv[i]);
            }
        }


        if ( typeof(self.projectName) == 'undefined') {
            var folder = new _(process.cwd()).toArray().last();
            if ( isDefined('project', folder) ) {
                self.projectName = folder
            }
        }

        if ( isDefined('project', self.projectName) && envs.length > 0) {
            self.envs = envs;
            saveEnvs()
        } else {
            //console.error('[ '+ self.projectName+' ] is not an existing project');
            console.error('Missing argument @<project_name>');
            process.exit(1)
        }
    }


    var saveEnvs = function() {
        var file    = _(self.projects[self.projectName].path + '/env.json')
            , ports = require(_(GINA_HOMEDIR + '/ports.json'))
        ;


        if ( !fs.existsSync( _(self.projects[self.projectName].path + '/manifest.json') )) {
            console.error('project corrupted');
            process.exit(1)
        }

        self.project = requireJSON(_(self.projects[self.projectName].path + '/manifest.json'));
        self.portsList = []; // list of all ports to ignore whles scanning
        var protocols = self.projects[self.projectName].protocols;
        var schemes = self.projects[self.projectName].schemes;
        for (let protocol in ports) {
            if (protocols.indexOf(protocol) < 0) continue;
            for (let scheme in ports[protocol]) {
                if (schemes.indexOf(scheme) < 0) continue;
                for (let p in ports[protocol][scheme]) {
                    if ( self.portsList.indexOf(p) > -1 ) continue;
                    self.portsList.push(p)
                }
            }
        }
        self.portsList.sort();
        for (let b in self.project.bundles) {
            self.bundles.push(b)
        }

        // to env.json file
        if ( !fs.existsSync(file) ) {
            lib.generator.createFileFromDataSync({}, file)
        }

        if ( typeof(self.bundles.length) == 'undefined' || self.bundles.length == 0) {
            try {
                addEnvToProject();
                console.log('environment'+((self.envs.length > 1) ? 's' : '')+' [ '+ self.envs.join(', ') +' ] created');
                process.exit(0);
            } catch (err) {
                console.error(err.stack||err.message);
                process.exit(1)
            }
        } else {
            // rollback infos
            self.envPath = _(self.projects[self.projectName].path + '/env.json');
            self.envData = requireJSON(self.envPath);
            self.portsPath = _(GINA_HOMEDIR + '/ports.json');
            self.portsData = require(self.portsPath);
            self.portsReversePath = _(GINA_HOMEDIR + '/ports.reverse.json');
            self.portsReverseData = require(self.portsReversePath);

            addEnvToBundles(0)
        }
    }


    /**
     * Adding envs to /project/root/env.json
     *
     * @param {string} file
     * */
    var addEnvToBundles = function(b) {
        if (b > self.bundles.length-1) {// done
            try {
                addEnvToProject();
                console.log('environment'+((self.envs.length > 1) ? 's' : '')+' [ '+ self.envs.join(', ') +' ] created');
                process.exit(0)
            } catch (err) {
                console.error(err.stack||err.message);
                process.exit(1)
            }
        }

        var bundle  = self.bundles[b] ;

        if ( /^[a-z0-9_.]/.test(bundle) ) {

            local.bundle    = bundle;
            local.b         = b;


            // find available port
            var options = {
                ignore  : getPortsList(),
                limit   : getBundleScanLimit(bundle)
            };
            console.log('['+bundle+'] starting ports scan' );

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
                //self.portsAvailable = ports;
                setPorts(local.bundle, ports, function onPortsSet(err) {
                    if (err) {
                        rollback(err);
                        return;
                    }

                    //console.debug('available ports '+ JSON.stringify(self.portsAvailable[local.bundle], null, 2));
                    ++local.b;
                    addEnvToBundles(local.b)
                });
            })

        } else {
            console.error('[ '+ bundle+' ] is not a valid bundle name')
            process.exit(1)
        }
    }

    // var setPorts = function(bundle, env) {
    //     var portsPath           = _(GINA_HOMEDIR + '/ports.json', true)
    //         , portsReversePath  = _(GINA_HOMEDIR + '/ports.reverse.json', true)
    //         , envDataPath       = _(self.projects[self.projectName].path + '/env.json', true)
    //     ;


    //     if ( typeof(require.cache[portsPath]) != 'undefined') {
    //         delete require.cache[require.resolve(portsPath)]
    //     }
    //     if ( typeof(require.cache[portsReversePath]) != 'undefined') {
    //         delete require.cache[require.resolve(portsReversePath)]
    //     }
    //     if ( typeof(require.cache[envDataPath]) != 'undefined') {
    //         delete require.cache[require.resolve(envDataPath)]
    //     }

    //     var envData             = requireJSON(envDataPath)
    //         , portsData         = require(portsPath)
    //         , portsReverseData  = require(portsReversePath)
    //     ;


    //     var content                 = JSON.clone(envData)
    //         , ports                 = JSON.clone(portsData)
    //         , portsReverse          = JSON.clone(portsReverseData)
    //         , allProjectEnvs        = self.projects[self.projectName].envs
    //         , allProjectProtocols   = self.projects[self.projectName].protocols
    //         , allProjectSchemes     = self.projects[self.projectName].schemes
    //     ;



    //     // BO project/env.json
    //     if ( typeof(content[bundle]) == 'undefined' ) {
    //         content[bundle] = {}
    //     }

    //     // getting available all envs
    //     for (let n in self.envs) {
    //         let newEnv = self.envs[n];
    //         if (allProjectEnvs.indexOf(newEnv) < 0) {
    //             console.debug('adding new env ['+newEnv+'] VS' + JSON.stringify(self.envs, null, 2));
    //             allProjectEnvs.push(newEnv);
    //         }
    //     }
    //     // getting available all protocols
    //     for (let p in self.protocols) {
    //         let newProtocol = allProjectProtocols[p];
    //         if (allProjectProtocols.indexOf(newProtocol) < 0) {
    //             console.debug('adding new protocol ['+newProtocol+'] VS' + JSON.stringify(self.protocols, null, 2));
    //             allProjectProtocols.push(newProtocol);
    //         }
    //     }
    //     // getting available all schemes
    //     for (let p in self.schemes) {
    //         let newScheme = allProjectSchemes[p];
    //         if (allProjectSchemes.indexOf(newScheme) < 0) {
    //             console.debug('adding new scheme ['+newScheme+'] VS' + JSON.stringify(self.schemes, null, 2));
    //             allProjectSchemes.push(newScheme);
    //         }
    //     }

    //     // editing env.json to add host infos
    //     for (let e in allProjectEnvs) {
    //         let env = allProjectEnvs[e];
    //         if ( typeof(content[bundle][env]) == 'undefined' ) {
    //             content[bundle][env] = {
    //                 "host" : "localhost"
    //             }
    //         }
    //     }
    //     // EO project/env.json


    //     // BO ~/.gina/ports.reverse.json - part 1/2
    //     if ( typeof(portsReverse[bundle + '@' + self.projectName]) == 'undefined' ) {
    //         portsReverse[bundle + '@' + self.projectName] = {}
    //     }
    //     if (
    //         typeof(portsReverse[bundle + '@' + self.projectName][env]) == 'undefined'
    //         ||
    //         /^string$/i.test( typeof(portsReverse[bundle + '@' + self.projectName][env]) )
    //     ) {
    //         portsReverse[bundle + '@' + self.projectName][env] = {}
    //     }
    //     // EO ~/.gina/ports.reverse.json - part 1/2


    //     // BO ~/.gina/ports.json
    //     for (let p in allProjectProtocols) {
    //         let protocol = allProjectProtocols[p];
    //         if ( typeof(ports[protocol]) == 'undefined' ) {
    //             ports[protocol] = {}
    //         }
    //         if ( typeof(portsReverse[bundle + '@' + self.projectName][env][protocol]) == 'undefined' ) {
    //             portsReverse[bundle + '@' + self.projectName][env][protocol] = {}
    //         }
    //         for (let s in allProjectSchemes) {
    //             let scheme = allProjectSchemes[s];
    //             // skipping none `https` schemes for `http/2`
    //             if ( /^http\/2/.test(protocol) && scheme != 'https' ) {
    //                 console.debug('skipping none `https` schemes for `http/2`');
    //                 continue;
    //             }
    //             if ( typeof(ports[protocol][scheme]) == 'undefined' ) {
    //                 ports[protocol][scheme] = {}
    //             }
    //             if ( typeof(portsReverse[bundle + '@' + self.projectName][env][protocol][scheme]) == 'undefined' ) {
    //                 portsReverse[bundle + '@' + self.projectName][env][protocol][scheme] = {}
    //             }

    //             let assigned = [];
    //             if ( ports[protocol][scheme].count() > 0 ) {
    //                 for (let port in ports[protocol][scheme]) {
    //                     let portDescription = ports[protocol][scheme][port] || null;
    //                     // already assigned
    //                     if ( portDescription && assigned.indexOf(portDescription) > -1 ) {
    //                         // cleanup
    //                         delete ports[protocol][scheme][port];
    //                         self.portsAvailable[bundle][env].unshift(port);
    //                         continue;
    //                     }
    //                     assigned.push(portDescription);
    //                 }
    //             }


    //             let stringifiedScheme = JSON.stringify(ports[protocol][scheme]);
    //             let patt = new RegExp(bundle +'@'+ self.projectName +'/'+ env);
    //             let found = false;
    //             let portToAssign = null;
    //             // do not override if existing
    //             if ( patt.test(stringifiedScheme) ) { // there can multiple matches
    //                 found = true;
    //                 // reusing the same for portsReverse
    //                 let re = new RegExp('([0-9]+)\"\:(|\s+)\"('+ bundle +'\@'+ self.projectName +'\/'+ env +')', 'g');
    //                 let m;
    //                 while ((m = re.exec(stringifiedScheme)) !== null) {
    //                     // This is necessary to avoid infinite loops with zero-width matches
    //                     if (m.index === re.lastIndex) {
    //                         re.lastIndex++;
    //                     }
    //                     // The result can be accessed through the `m`-variable.
    //                     try {
    //                         m.forEach((match, groupIndex) => {
    //                             //console.debug(`Found match, group ${groupIndex}: ${match}`);
    //                             if (groupIndex == 1) {
    //                                 portToAssign = ~~match;
    //                                 //console.debug('['+bundle+'] port to assign '+ portToAssign + ' - ' + protocol +' '+ scheme);
    //                                 throw new Error('breakExeception');
    //                             }
    //                         });
    //                     } catch (breakExeption) {
    //                         break;
    //                     }
    //                 }

    //             }

    //             if (!portToAssign) {
    //                 //console.debug('['+bundle+'] No port to assign '+ portToAssign + ' - ' + protocol +' '+ scheme);
    //                 portToAssign = self.portsAvailable[bundle][env][0];
    //                 // port is no longer available
    //                 self.portsAvailable[bundle][env].splice(0,1);
    //             }
    //             ports[protocol][scheme][portToAssign] = bundle +'@'+ self.projectName +'/'+ env;

    //             // BO ~/.gina/ports.reverse.json - part 2/2
    //             //override needed since it is relying on ports definitions
    //             portsReverse[bundle + '@' + self.projectName][env][protocol][scheme] = ~~portToAssign;
    //             // EO ~/.gina/ports.reverse.json - part 2/2

    //         } // EO for (let scheme in schemes)
    //     } // for (let protocol in protocols)
    //     // EO ~/.gina/ports.json



    //     try {
    //         // save to /<project_path>/env.json
    //         lib.generator.createFileFromDataSync(content, envDataPath);
    //         self.envDataWrote = true;
    //         // save to ~/.gina/projects.json
    //         // lib.generator.createFileFromDataSync(ports, portsPath);
    //         // self.projectsDataWrote = true;

    //         // save to ~/.gina/ports.json
    //         lib.generator.createFileFromDataSync(ports, portsPath);
    //         self.portsDataWrote = true;
    //         // save to ~/.gina/ports.reverse.json
    //         lib.generator.createFileFromDataSync(portsReverse, portsReversePath);
    //         self.portsReverseDataWrote = true;

    //         ++local.b;
    //         addEnvToBundles(local.b, local.e)
    //     } catch (err) {
    //         rollback(err)
    //     }
    // }

    /**
     * Adding envs to ~/.gina/projects.json
     *
     * @param {array} envs
     * */
    var addEnvToProject = function() {
        var e = 0
            , newEnvs = self.envs
            , projects = JSON.clone(self.projects)
            , envs = projects[self.projectName].envs
        ;
        // to ~/.gina/projects.json
        for (; e < newEnvs.length; ++e) {
            if (envs.indexOf(newEnvs[e]) < 0 ) {
                modified = true;
                envs.push(newEnvs[e])
            }
        }
        //writing
        lib.generator.createFileFromDataSync(
            projects,
            self.projectConfigPath
        );
        self.projectDataWrote = true
    }

    var updateManifest = function() {
        // projectManifestPath
        var env             = local.env
            , scope         = local.scope
            , projectData   = JSON.clone(self.projectData)
        ;

        // for (let bundle in projectData.bundles) {
        //     if (
        //         typeof(projectData.bundles[bundle].releases[scope][env]) != 'undefined'
        //         && typeof(projectData.bundles[bundle].releases[scope][env].target) != 'undefined'
        //     ) {
        //         delete projectData.bundles[bundle].releases[scope][env].target
        //     }
        // }

        // lib.generator.createFileFromDataSync(projectData, self.projectManifestPath);

        end()

    }

    var rollback = function(err) {
        console.error('could not complete env registration: ', (err.stack||err.message));
        console.warn('rolling back...');

        var writeFiles = function() {
            //restore env.json
            lib.generator.createFileFromDataSync(self.envData, self.envPath);

            //restore ports.json
            lib.generator.createFileFromDataSync(self.portsData, self.portsPath);

            //restore ports.reverse.json
            lib.generator.createFileFromDataSync(self.portsReverseData, self.portsReversePath);

            // restore projects.json
            lib.generator.createFileFromDataSync(self.projects, self.projectConfigPath);

            process.exit(1)
        };

        writeFiles()
    };

    var end = function (output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output);
                if ( messageOnly && type != 'log') {
                    console.log(output);
                }
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }

    init()
};

module.exports = Add