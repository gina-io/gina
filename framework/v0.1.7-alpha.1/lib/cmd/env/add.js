var fs      = require('fs');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
var scan        = require('../port/inc/scan.js');

/**
 * @module gina/lib/cmd/env/add
 */
/**
 * Adds a new environment for a given project or registers it globally.
 * Scans for available ports when bundles are present.
 *
 * Usage:
 *  gina env:add <env> @<project>
 *  gina env:add <env>
 *
 * TODO - updateManifest()
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Add(opt, cmd) {
    var self = {}, local = {};

    /**
     * Parses argv for env names and project token, then dispatches to saveEnvs.
     *
     * @inner
     * @private
     */
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
                    return end( new Error('[ '+process.argv[i]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].'))
                }

                if ( typeof(self.projectName) == 'undefined') {
                    var folder = new _(process.cwd()).toArray().last();
                    if ( isDefined('project', folder) ) {
                        self.projectName = folder
                    }
                }

                if ( isDefined('project', self.projectName) && envs.length > 0 ) {
                    self.envs = envs;
                    return saveEnvs(self.projectName)
                }

                return end( new Error('Missing argument @<project_name>'))
            }
            else if (/^[a-z0-9_.]/.test(process.argv[i])) {
                local.env = process.argv[i];
                envs.push(process.argv[i]);
            }
        }

        self.envs = envs;
        return saveEnvs()
    }


    /**
     * Dispatches to addEnvToProject (project-scoped) or registerEnv (global),
     * depending on whether a project name was supplied.
     *
     * @inner
     * @private
     * @param {string} [projectName] - Registered project name; omitted for global registration
     */
    var saveEnvs = function(projectName) {
        try {
            if (projectName) {
                return addEnvToProject();
            }
            registerEnv();
        } catch (err) {
            return end(err)
        }
    }

    /**
     * Loads the project manifest and existing port data, builds the port-ignore list,
     * and either writes env.json directly (no bundles) or delegates to addEnvToBundles.
     *
     * @inner
     * @private
     */
    var addEnvToProject = function() {
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

        if ( typeof(self.bundles.length) == 'undefined' || self.bundles.length == 0) {
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
     * Iterates over project bundles, scans for available ports for each bundle,
     * and assigns ports to the new environment via setPorts.
     * Calls the projects.json updater when all bundles are processed.
     *
     * @inner
     * @private
     * @param {number} b - Current bundle index into self.bundles
     */
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

    /**
     * Appends the new environments to the project entry in ~/.gina/projects.json
     * and writes the file.
     *
     * @inner
     * @private
     */
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

    /**
     * Registers the new environments globally in ~/.gina/settings.json and
     * propagates them to every registered project in projects.json.
     *
     * @inner
     * @private
     */
    var registerEnv = function() {
        var s           = 0
            , envs      = JSON.clone(self.mainConfig.envs[GINA_SHORT_VERSION])
            , newEnvs   = self.envs
        ;
        // to ~/.gina/projects.json
        for (; s < newEnvs.length; ++s) {
            if (envs.indexOf(newEnvs[s]) < 0 ) {
                envs.push(newEnvs[s]);
                if (!self.mainConfig[newEnvs[s]+'_scope']) {
                    self.mainConfig[newEnvs[s]+'_scope'] = {};
                }
                self.mainConfig[newEnvs[s]+'_scope'] = newEnvs[s];
            }
        }
        self.mainConfig.envs[GINA_SHORT_VERSION] = envs;
        //writing
        lib.generator.createFileFromDataSync(
            self.mainConfig,
            self.mainConfigPath
        );
        self.mainConfigUpdated = true;

        // Update existing projects envs
        for (let p in self.projects) {
            let project = self.projects[p];
            envs    = JSON.clone(project.envs);
            s = 0;
            for (; s < newEnvs.length; ++s) {
                if (envs.indexOf(newEnvs[s]) < 0 ) {
                    envs.push(newEnvs[s]);
                    if (!project[newEnvs[s]+'_scope']) {
                        project[newEnvs[s]+'_scope'] = {};
                    }
                    project[newEnvs[s]+'_scope'] = newEnvs[s];
                }
            }
            project.envs = envs;
            // ?? Updating manifest
            // updateManifest(project);
        }

        lib.generator.createFileFromDataSync(
            self.projects,
            self.projectConfigPath
        );

        end('env'+((self.envs.length > 1) ? 's' : '')+' [ '+ self.envs.join(', ') +' ] created');
    }

    /**
     * Updates the project manifest with the new environments.
     * Currently a stub — not yet implemented.
     *
     * @inner
     * @private
     * @param {object} project - Project entry from projects.json
     */
    var updateManifest = function(project) {

    }

    /**
     * Restores env.json, ports.json, ports.reverse.json, and projects.json to
     * their pre-operation state, then exits with code 1.
     *
     * @inner
     * @private
     * @param {Error} err - The error that triggered the rollback
     */
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

    /**
     * Prints optional output and exits the process.
     *
     * @inner
     * @private
     * @param {string|Error} [output] - Message or Error to display
     * @param {string} [type] - console method to call (e.g. 'error', 'warn')
     * @param {boolean} [messageOnly] - When true, print only the message, not the stack
     */
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