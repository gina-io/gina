var fs = require('fs');
var readline = require('readline');
var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
var CmdHelper = require('./../helper');
var console = lib.logger;
var scan = require('../port/inc/scan');

/**
 * Set a protocol to your project
 *
 * e.g.
 *  gina protocol:set
 *  gina protocol:set @<project_name>
 *  gina protocol:set <bundle> @<project_name>
 *
 * */
function Set(opt, cmd) {

    // self will be pre filled if you call `new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled })`
    var self = {}, local = { portsAvailable: [] };

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // backup in case of rolllover
        local.ports         = requireJSON(_(self.portsPath));
        local.portsReverse  = requireJSON(_(self.portsReversePath));
        local.mainConfig    = JSON.clone(self.mainConfig);


        // find available port
        options = {
            ignore  : merge(self.portsGlobalList, local.ports),
            // get for each bundle ports for available protocol, scheme & env
            limit   : ( self.protocolsAvailable.length * self.schemesAvailable.length * self.envs.length * self.bundles.length )
        };

        scan(options, function(err, ports){

            if (err) {
                console.error(err.stack|err.message);
                process.exit(1);
            }


            for (var p = 0; p < ports.length; ++p) {
                local.portsAvailable.push(ports[p]);
            }

            local.portsAvailable.sort();


            if (!self.name && !self.projectName) {
                // this case is allways catched excepted for `LIST` command
            } else if (self.projectName && isDefined(self.projectName) && !self.name) {
                local.projectConfig = JSON.clone(self.projects);
                check('project');
            } else if (typeof (self.name) != 'undefined' && isValidName(self.name)) {
                local.projectConfig = JSON.clone(self.projects);
                check('bunlde');
            } else {
                console.error('[ ' + self.name + ' ] is not a valid project name.');
                process.exit(1);
            }
        });
    };

    //  check if bundle is defined
    var isDefined = function(name) {
        if (typeof (self.projects[name]) != 'undefined') {
            return true;
        }
        return false;
    };

    var isValidName = function(name) {
        if (name == undefined) return false;

        self.name = name.replace(/\@/, '');
        var patt = /^[a-z0-9_.]/;
        return patt.test(self.name);
    };

    var check = function(actionType) {

        self.actionType = actionType;

        var phrase      = null
            , list      = ''
            , choices   = {} // protocol choice
            , choices2  = {} // scheme choice
            , choicesOpt = JSON.clone(self.protocolsAvailable)
        ;

        var name = (actionType == 'project') ? self.projectName : self.name;

        if ( /\-\-(protocol|scheme)/.test(opt.argv.join(',')) ) {
            if ( ! /\-\-(protocol)/.test(opt.argv.join(',')) ) {
                console.error('`--protocol=<http/1.1|http/2.0>` is missing in your command line !');
                process.exit(1);
            }
            if ( ! /\-\-(scheme)/.test(opt.argv.join(',')) ) {
                console.error('`--scheme=<http|https>` is missing in your command line !');
                process.exit(1);
            }
            var pArr                = null
                , protocolModeEnabled = false
                , schemeModeEnabled = false
            ;
            for (let i = 0, len = opt.argv.length; i<len; i++) {
                if (  !/\-\-(protocol|scheme)/.test(opt.argv[i]) )
                    continue;

                pArr = opt.argv[i].replace(/\s+/g, '').split(/=/);
                if ( /\-protocol/.test(pArr[0]) ) {
                    protocolModeEnabled   = true;
                    choices.protocol = pArr[1]
                }

                if ( /\-scheme/.test(pArr[0]) ) {
                    schemeModeEnabled  = true;
                    choices.scheme = pArr[1]
                }
            }
            if (/project/.test(actionType))
                setProjectOnly(choices.protocol, choices.scheme);
            else
                setBundleOnly(choices.protocol, choices.scheme);

            return;
        }

        choicesOpt.push('cancel');

        for (var p = 0, len = choicesOpt.length; p < len; ++p) {

            if (p < len-1) {
                choices[p+1] = choicesOpt[p];
                choices[choicesOpt[p]] = choicesOpt[p];
            }

            if (p == len-1) {
                list += '\n';
            }

            if ( self.defaultProtocol == choicesOpt[p]) {
                list += '\n ('+ (p+1) +') '+ choicesOpt[p] + ' - default';
            } else {
                list += '\n ('+ ( (p == len-1) ? 'c' : (p+1) ) +') '+ choicesOpt[p];
            }
        }


        phrase = 'Choose among the following protocols the new default setting for your ' + actionType +' ('+ name +').\n'+ list +'\r\n> ';
        rl.setPrompt(phrase);



        var choice = null, choice2 = null;
        rl
            .on('line', function(line) {

                if (!choice || typeof(choices[choice]) == 'undefined') { // protocol definition
                    choice = line.trim().toLowerCase();

                    if ( typeof(choices[choice]) != 'undefined') {
                        rl.clearLine();

                        // to the next question
                        list = '';
                        choicesOpt = JSON.clone(self.schemesAvailable);
                        choicesOpt.push('cancel');

                        for (var p = 0, len = choicesOpt.length; p < len; ++p) {

                            if (p < len-1) {
                                choices2[p+1] = choicesOpt[p];
                                choices2[choicesOpt[p]] = choicesOpt[p];
                            }

                            if (p == len-1) {
                                list += '\n';
                            }

                            if ( self.defaultScheme == choicesOpt[p]) {
                                list += '\n ('+ (p+1) +') '+ choicesOpt[p] + ' - default';
                            } else {
                                list += '\n ('+ ( (p == len-1) ? 'c' : (p+1) ) +') '+ choicesOpt[p];
                            }
                        }

                        phrase = 'Choose among the following schemes the new default setting for your ' + actionType +' ('+ name +').\n'+ list +'\r\n> ';
                        rl.setPrompt(phrase);
                        rl.prompt();

                    } else {

                        if ( /^(c|cancel)$/.test(choice) ) {
                            rl.clearLine();
                            rl.close();
                        } else {
                            console.log('Please, write '+ self.protocolsAvailable.join(', ') +' or "c" (cancel) to proceed.');
                            rl.prompt();
                        }
                    }

                } else { // scheme definition
                    choice2 = line.trim().toLowerCase();
                    if ( typeof(choices2[choice2]) != 'undefined') {
                        rl.clearLine();

                        console.debug('[ '+ actionType +' ] Picked: '+ choices[choice] +' - '+ choices2[choice2]);

                        if (/project/.test(actionType))
                            setProjectOnly(choices[choice], choices2[choice2]);
                        else
                            setBundleOnly(choices[choice], choices2[choice2]);

                    } else {
                        if ( /^(c|cancel)$/.test(choice2) ) {
                            rl.clearLine();
                            rl.close();
                        } else {
                            console.log('Please, write '+ self.schemesAvailable.join(', ') +' or "c" (cancel) to proceed.');
                            rl.prompt();
                        }
                    }
                }


            })
            .on('close', function() {
                rl.clearLine();
                console.log('Exiting protocol setup');
                //rl.close();
            });

            rl.prompt();
            // to debug, comment the line above & uncomment one of the 2 lines below
            //setProjectOnly('http/2')
            //setBundleOnly('http/2')


    };


    var setProjectOnly = function(protocol, scheme) {
        loadAssets();

        // are selected protocol & scheme allowed ?
        if ( self.protocolsAvailable.indexOf(protocol) < 0 ) {
            console.error('Scheme [ '+scheme+' ] is not an allowed scheme: check your framework configuration (~/main.json)');
            process.exit(1);
        }
        if ( self.schemesAvailable.indexOf(scheme) < 0 ) {
            console.error('Scheme [ '+scheme+' ] is not an allowed scheme: check your framework configuration (~/main.json)');
            process.exit(1);
        }


        // get user protocols list
        var protocols = JSON.clone(self.protocols);
        // get user schemes list
        var schemes = JSON.clone(self.schemes);


        var projectConfig   = JSON.clone(local.projectConfig);

        if ( protocols.indexOf(protocol) < 0 ) {
            protocols.push(protocol);
            self.protocols = protocols;
            projectConfig[self.projectName].protocols = protocols;
        }
        if ( schemes.indexOf(scheme) < 0 ) {
            schemes.push(scheme);
            self.schemes = schemes;
            projectConfig[self.projectName].schemes = schemes;
        }

        //console.debug('Setting project protocol & scheme: '+ protocol +' - '+scheme + '\n\r protocols: '+ self.protocols + '\n\r schemes: '+ self.schemes);
        //process.exit(0);

        // update default protocol & scheme
        self.defaultProtocol    = protocol;
        self.defaultScheme      = scheme;
        projectConfig[self.projectName].def_protocol    = self.defaultProtocol;
        projectConfig[self.projectName].def_scheme      = self.defaultScheme;
        projectConfig[self.projectName].protocols       = self.protocols;
        projectConfig[self.projectName].schemes         = self.schemes;

        var re      = new RegExp('\@'+ self.projectName +'$', '');
        var bundles = self.bundles;
        var envs    = self.envs;

        var ports           = JSON.clone(local.ports);
        var portsReverse    = JSON.clone(local.portsReverse);

        // to fixe bundle settings inconsistency
        var bundleConfig    = null;
        var settingsPath    = null;
        var bundleSettingsUpdate = false;

        if ( typeof(ports[protocol]) == 'undefined' ) {
            ports[protocol] = {};
        }
        if ( typeof(ports[protocol][scheme]) == 'undefined' ) {
            ports[protocol][scheme] = {};
        }

        // setup new for the whole project
        var port                = null
            , portsAvailable    = local.portsAvailable
            , b                 = null
            , len               = null
            , e                 = null
            , eLen              = null
            , i                 = null
            , s                 = null
            , p                 = null
            , found             = null
        ;


        // ports
        b = 0; len = bundles.length;
        for (; b < len; ++b ) { // for each bundle
            e = 0; eLen = envs.length
            for (; e < eLen; ++e)  { // for each env
                // check if already set
                found = false;
                for (i in ports) {
                    if (i != protocol) continue;

                    for (s in ports[protocol]) {
                        if (s != scheme) continue;

                        for (p in ports[protocol][s]) {
                            if ( ports[protocol][s][p] == bundles[b] +'@'+ self.projectName +'/'+ envs[e] ) {
                                found = true;
                                break
                            }
                        }
                        if (found) break;
                    }
                    if (found) break;
                }
                if (!found) {
                    port = portsAvailable.splice(0, 1)[0];
                    ports[protocol][scheme][port] = bundles[b] +'@'+ self.projectName +'/'+ envs[e];
                }
            }
        }

        // updating reverse ports
        var arr = []
            , key = null
            , env = null
        ;
        b = 0;
        for (i in ports) { // each protocol
            if (i != protocol) continue;

            for (s in ports[protocol]) { // each scheme
                if (s != scheme) continue;

                for (let port in ports[protocol][scheme])  { // for each port

                    key = ports[protocol][scheme][port];

                    arr = key.split(/\//g);
                    env = arr.pop();
                    b = arr.join(); //bundle

                    if ( typeof(portsReverse[b]) == 'undefined' )
                        portsReverse[b] = {};

                    if ( typeof(portsReverse[b][env]) == 'undefined' )
                        portsReverse[b][ env ] = {};

                    if ( typeof(portsReverse[b][env][protocol]) == 'undefined' )
                        portsReverse[b][ env ][ protocol ] = {};

                    if ( typeof(portsReverse[b][env][protocol][scheme]) == 'undefined' )
                        portsReverse[b][ env ][ protocol ][ scheme ] = {};

                    if ( re.test(b)) {
                        //console.log(b, ' [ ' + protocol + ' ] -> ', ~~port);
                        portsReverse[b][ env ][ protocol ][ scheme ] = ~~port;

                        // bundle settings inconsistency check & fix
                        bundleName              = b.split(/\@/)[0];
                        bundleConfig            = self.bundlesByProject[self.projectName][bundleName];
                        settingsPath            = _(bundleConfig.configPaths.settings, true);
                        bundleSettingsUpdate    = false;

                        if ( fs.existsSync(settingsPath) ) {

                            bundleSettings  = requireJSON(settingsPath);

                            if ( typeof(bundleSettings.server) != 'undefined' ) {
                                // update only if given bundle protocol setting not in project protocols list
                                // use project def_protocol by default in that case
                                if (
                                    typeof(bundleSettings.server.protocol) == 'undefined'
                                    || typeof(bundleSettings.server.protocol) != 'undefined'
                                        && protocols.indexOf(bundleSettings.server.protocol) < 0
                                    || typeof(bundleSettings.server.protocol) != 'undefined'
                                        && bundleSettings.server.protocol != protocol
                                ) {
                                    bundleSettings.server.protocol = protocol;
                                    bundleSettingsUpdate = true
                                }

                                // update only if given bundle scheme setting not in project schemes list
                                // use project def_scheme by default in that case
                                if (
                                    typeof(bundleSettings.server.scheme) == 'undefined'
                                    || typeof(bundleSettings.server.scheme) != 'undefined'
                                        && schemes.indexOf(bundleSettings.server.scheme) < 0
                                    || typeof(bundleSettings.server.scheme) != 'undefined'
                                        && bundleSettings.server.scheme != scheme
                                ) {
                                    bundleSettings.server.scheme = scheme;
                                    bundleSettingsUpdate = true
                                }

                                if (bundleSettingsUpdate) {
                                    // updating bundle internal config/settings
                                    bundleSettings.server.protocol    = protocol;
                                    bundleSettings.server.scheme      = scheme;
                                    if ( /http\/2/.test(protocol) && typeof(bundleSettings.server.allowHTTP1) == 'undefined' ) {
                                        bundleSettings.server.allowHTTP1 = true;
                                    } else if ( typeof(bundleSettings.server.allowHTTP1) != 'undefined' ) {
                                        delete bundleSettings.server.allowHTTP1
                                    }
                                    lib.generator.createFileFromDataSync(bundleSettings, settingsPath);
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
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        // save to ~/.gina/ports.reverse.json
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        self.mainConfigUpdated = true;

        console.log('Protocol updated with success ;)');
        end('You need to restart your ' + self.actionType);
    };

    var setBundleOnly = function(protocol, scheme) {
        loadAssets();

        // are selected protocol & scheme allowed ?
        if ( self.protocolsAvailable.indexOf(protocol) < 0 ) {
            console.error('Protocol [ '+protocol+' ] is not an allowed protocol: check your framework configuration (~/main.json)');
            process.exit(1);
        }
        if ( self.schemesAvailable.indexOf(scheme) < 0 ) {
            console.error('Scheme [ '+scheme+' ] is not an allowed scheme: check your framework configuration (~/main.json)');
            process.exit(1);
        }

        // get user protocols list
        var protocols = JSON.clone(self.protocols);
        // get user schemes list
        var schemes = JSON.clone(self.schemes);

        var projectConfig   = JSON.clone(local.projectConfig);

        if ( protocols.indexOf(protocol) < 0 ) {
            protocols.push(protocol);
            self.protocols = protocols;
            projectConfig[self.projectName].protocols = protocols;
        }
        if ( schemes.indexOf(scheme) < 0 ) {
            schemes.push(scheme);
            self.schemes = schemes;
            projectConfig[self.projectName].schemes = schemes;
        }

        //console.debug('Setting project protocol & scheme: '+ protocol +' - '+scheme + '\n\r protocols: '+ self.protocols + '\n\r schemes: '+ self.schemes);
        //process.exit(0);
        // is existing ?
        //var found = protocols.indexOf(protocol);
        //if ( found < 0 || schemes.indexOf(scheme) < 0 ) exit(); // not possible in theory

        //var bundles = self.bundles;
        var envs            = self.envs;
        var scopes          = self.scopes;
        var re              = new RegExp('\@'+ self.projectName +'$', '');
        var ports           = JSON.clone(local.ports);
        var portsReverse    = JSON.clone(local.portsReverse);
        if ( typeof(ports[protocol]) == 'undefined' ) {
            ports[protocol] = {};
        }
        if ( typeof(ports[protocol][scheme]) == 'undefined' ) {
            ports[protocol][scheme] = {};
        }

        var bundleConfig = self.bundlesByProject[self.projectName][self.name];
        var settingsPath = _(bundleConfig.configPaths.settings, true);

        var settings = {};

        if ( fs.existsSync(settingsPath) ) {
            settings = requireJSON(settingsPath);
        }

        if ( typeof(settings.server) == 'undefined' ) {
            settings.server = {}
        }

        var port                    = null
                , portsAvailable    = local.portsAvailable
                , portValue         = null
                , b                 = null // bundle@project
                , e                 = 0 // env
                , eLen              = envs.length
                , found             = null
                , i                 = null // port
                , s                 = null //scheme
                , p                 = null // protocol
        ;


        // bundle ports
        e = 0;
        for (; e < eLen; ++e)  { // for each env

            // check if already set
            found = false;
            for (i in ports) {
                if (i != protocol) continue;

                for (s in ports[protocol]) {
                    if (s != scheme) continue;

                    for (p in ports[protocol][s]) {
                        if ( ports[protocol][s][p] == self.name +'@'+ self.projectName +'/'+ envs[e] ) {
                            found = true;
                            break
                        }
                    }
                    if (found) break;
                }
                if (found) break;
            }

            if (!found) {
                portValue = self.name +'@'+ self.projectName +'/'+ envs[e];
                // ports
                port = portsAvailable.splice(0, 1)[0];
                ports[protocol][scheme][port] = portValue;

                b = portValue.split(/\//)[0];
                // portReverse
                if ( typeof(portsReverse[b]) == 'undefined' )
                    portsReverse[b] = {};

                if ( typeof(portsReverse[b][ envs[e] ]) == 'undefined' )
                    portsReverse[b][ envs[e] ] = {};

                if ( typeof(portsReverse[b][ envs[e] ][protocol]) == 'undefined' )
                    portsReverse[b][ envs[e] ][ protocol ] = {};

                if ( typeof(portsReverse[b][ envs[e] ][protocol][scheme]) == 'undefined' )
                    portsReverse[b][ envs[e] ][ protocol ][ scheme ] = {};

                if ( re.test(b)) {
                    portsReverse[b][ envs[e] ][ protocol ][ scheme ] = ~~port;
                }
            }
        }


        // save to ~/.gina/ports.json
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        // save to ~/.gina/ports.reverse.json
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);


        // updating bundle internal config/settings
        settings.server.protocol    = protocol;
        settings.server.scheme      = scheme;
        if ( /http\/2/.test(protocol) && typeof(settings.server.allowHTTP1) == 'undefined' ) {
            settings.server.allowHTTP1 = true;
        } else if ( typeof(settings.server.allowHTTP1) != 'undefined' ) {
            delete settings.server.allowHTTP1
        }
        // save to bundle's /config/settings.json
        lib.generator.createFileFromDataSync(settings, settingsPath);

        self.bundleConfigUpdated = true;

        console.log('Protocol updated with success ;)');
        end('You need to restart your ' + self.actionType);
    };

    var rollback = function(err) {
        console.error('[ CLI ] could not complete protocol creation: ', (err.stack||err.message));
        console.info('[ CLI ] rolling back...');

        var writeFiles = function() {

            //restore env.json
            if ( typeof(local.envDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.envData, self.envPath);
            }
            //restore project.json
            if ( typeof(local.projectDataWrote) == 'undefined' ) {
                if ( typeof(self.projectData.bundles[local.bundle]) != 'undefined') {
                    delete self.projectData.bundles[local.bundle];
                }
                lib.generator.createFileFromDataSync(self.projectData, self.projectConfigPath);
            }

            //restore ports.json
            if ( typeof(local.portsDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.portsData, self.portsPath);
            }

            //restore ports.reverse.json
            if ( typeof(local.portsReverseDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.portsReverseData, self.portsReversePath);
            }


            process.exit(1);
        };

        // var bundle = new _(local.source);
        // if ( bundle.existsSync() ) {
        //     bundle.rm( function(err) {//remove folder
        //         if (err) {
        //             throw err
        //         }
        //         writeFiles()
        //     })
        // } else {
        //     writeFiles()
        // }
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

    init();
}
module.exports = Set;