const fs            = require('fs');
const { execSync }  = require('child_process');

var console     = lib.logger;
var CmdHelper   = require('./../helper');
var scan        = require('../port/inc/scan');
const { setFips } = require('crypto');

/**
 * Reset ports for a given project
 *
 * e.g.:
 *  gina port:reset @<project_name>
 *  gina port:reset @<project_name> --start-port-from=4100
 *
 * */
function Reset(opt, cmd) {

    // self will be pre filled if you call `new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled })`
    var self = { forAllProjects: false }
        , local = {
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
        if (!isCmdConfigured()) return false;

        for (let i=3, len=process.argv.length; i<len; i++) {
            if ( /^\-\-start\-port\-from\=/.test(process.argv[i]) ) {
                self.startFrom = process.argv[i].split(/\=/)[1]
            }
        }

        if (!self.projectName) { // reset for all projects
            self.forAllProjects = true;
            self.projectName = self.projectsList[0];
        }

        if ( self.projectName && isDefined('project', self.projectName) ) {
            loadAssets();
            reset()
        }
        // if (self.projectName && isDefined(self.projectName) && !self.name) {
        //     listProjectOnly()
        // } else if (typeof (self.name) != 'undefined' && isValidName(self.name)) {
        //     listBundleOnly()
        // } else {
        //     console.error('[ ' + self.name + ' ] is not a valid project name.');
        //     process.exit(1)
        // }
    }


    var reset = function() {
        // get bundles list
        var bundlesCollection = null, out = null;
        try {
            out = execSync('gina bundle:list @'+ self.projectName +' --format=json').toString().replace(/(\n|\r)$/, '').split(/(\n|\r)/g);
            out = out[out.length-1];
            bundlesCollection = JSON.parse(out);
        } catch (err) {}// silently ...

        // remove definitions from port.reverse.json & port.json
        var i       = 0
            , ports = JSON.clone(self.portsData) // cloning
        ;
        while (i < bundlesCollection.length) {
            let bundleObj = bundlesCollection[i];
            let bundle = bundleObj.bundle;
            let project = bundleObj.project;

            delete self.portsReverseData[ bundle +'@'+ project ];

            for (let protocol in ports) {
                for (let scheme in ports[protocol]) {
                    for (let p in ports[protocol][scheme]) {
                        let re = new RegExp('^'+ bundle +'@'+ project);
                        if ( re.test( ports[protocol][scheme][p]) ) {
                            delete self.portsData[protocol][scheme][p]
                        }
                    }
                }
            }

            i++;
        }

        // save to ~/.gina/ports.json
        //console.debug('data \n'+ JSON.stringify(self.portsData, null, 4) +'\n\rcurrent \n'+ JSON.stringify(ports, null, 4));
        lib.generator.createFileFromDataSync( self.portsData, self.portsPath);

        // save to ~/.gina/ports.reverse.json
        lib.generator.createFileFromDataSync( self.portsReverseData, self.portsReversePath);

        self.bundles.sort();
        // for each bundle,re assign ports
        addBundlePorts(0);

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
     * NB.: also used in `project:add` task
     *
     * @param {number} b - bundle index
     *
     */
    var addBundlePorts = function(b) {
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
                            try {
                                bundleName              = local.bundle;
                                bundleConfig            = self.bundlesByProject[self.projectName][bundleName];
                                settingsPath            = _(bundleConfig.configPaths.settings, true);
                                bundleSettingsUpdate    = false;
                            } catch (err) {
                                return end(new Error('[port:reset error] project `'+ self.projectName+'` bundleConfig might be broken !') )
                            }


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


                                    for (let e=0, envsLen = envs.length; e < envsLen; ++e ) {

                                        if (!portsList[i]) {
                                            break;
                                        }

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

                                                ++i
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
            lib.generator.createFileFromDataSync( merge(self.portsData, ports), self.portsPath);

            // save to ~/.gina/ports.reverse.json
            lib.generator.createFileFromDataSync( merge(self.portsReverseData, portsReverse), self.portsReversePath);

            if ( /^true$/.test(self.forAllProjects) ) {
                // reload project assets
                self.projectName = self.projectsList[self.projectsList.indexOf(self.projectName)+1];
                if (!self.projectName) {
                    return end();
                }
                self.bundles = [];
                loadAssets();
                // reset context
                local = {
                    // bundle index while searching or browsing
                    b : 0,
                    bundle : null,
                    bundlePath : null,
                    ports : []
                };
                b = 0;
                reset()
            } else {
                return end();
            }
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
            scan(options, function(err, ports){

                if (err) {
                    console.error(err.stack|err.message);
                    process.exit(1)
                }


                for (let p = 0; p < ports.length; ++p) {
                    local.ports.push(ports[p])
                }

                // local.ports.sort();

                ++local.b;
                addBundlePorts(local.b);
            });




        } else {
            console.error('[ '+ bundle+' ] is not a valid bundle name')
            process.exit(1)
        }
    } // EO addBundlePorts(bundleIndex)

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

module.exports = Reset