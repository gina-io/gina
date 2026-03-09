var fs          = require('fs');

var CmdHelper   = require('./../helper');
var console = lib.logger;

/**
 * @module gina/lib/cmd/env/remove
 */
/**
 * Removes an environment from a project, cleans up its port assignments,
 * and updates env.json, ports.json, ports.reverse.json, and the project manifest.
 *
 * Usage:
 *  gina env:rm <env> @<project>
 *
 * TODO - Prompt for confirmation: "This will remove [ environment ] for the whole project. Proceed ? Y/n: "
 *
 * @class Remove
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Remove(opt, cmd) {
    var self = {}, local = { env: null };

    /**
     * Validates argv, resolves the project name, and delegates to removeEnv.
     *
     * @inner
     * @private
     */
    var init = function() {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        self.target = _(GINA_HOMEDIR + '/projects.json', true);
        self.projects   = requireJSON(self.target);
        var env = local.env = process.argv[3];
        if ( typeof(env) == 'undefined' || /^\@/.test(env) ) {
            end( new Error('Missing argument in [ gina env:rm <environment> @<project> ]') )
        }
        else if ( typeof(env) != 'undefined' ) {
            if ( !self.projects[self.projectName].envs.inArray(env) ) {
                end( new Error('Environment [ '+env+' ] not found') )
            }// else, continue
        }

        if ( typeof(process.argv[4]) != 'undefined') {
            if ( !isValidName(process.argv[4]) ) {
                end( new Error('[ '+process.argv[4]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].') );
            }
        } else {
            // is current path == project path ?
            var root = process.cwd();
            var name = new _(root).toArray().last();
            if ( isDefined('project', name) ) {
                self.projectName = name
            }
        }

        if ( typeof(self.projectName) == 'undefined' ) {
            end( new Error('Project name is required: @<project_name>') )
        } else if ( typeof(self.projectName) != 'undefined' && isDefined('project', self.projectName) ) {
            removeEnv(self.projects, self.target)
        } else {
            end( new Error('[ '+self.projectName+' ] is not a valid project name.') )
        }
    }

    /**
     * Removes the environment from projects.json, cleans its port entries from
     * ports.json and ports.reverse.json, updates env.json, and calls updateManifest.
     * Refuses to remove the default or development environment.
     *
     * @inner
     * @private
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     * @param {string} target - Absolute path to projects.json
     */
    var removeEnv = function(projects, target) {
        var err = null, env = local.env;
        // default `dev env` cannot be removed
        if(env === projects[self.projectName]['dev_env']|| env === projects[self.projectName]['def_env']) {
            if (env === projects[self.projectName]['def_env']) {
                err = new Error('Environment [ '+env+' ] is set as "default environment"')
            } else {
                err = new Error('Environment [ '+env+' ] is linked as "development environment"')
            }

            return end(err);
        }

        projects[self.projectName]['envs'].splice(projects[self.projectName]['envs'].indexOf(env), 1);
        lib.generator.createFileFromDataSync(
            projects,
            target
        );
        // clean ports & reverse ports registered for the project
        var portsPath = _(GINA_HOMEDIR + '/ports.json')
            , portsReversePath = _(GINA_HOMEDIR + '/ports.reverse.json')
            , ports = requireJSON(portsPath)
            , portsReverse = requireJSON(portsReversePath)
            , envsPath = _(projects[self.projectName].path +'/env.json')
            , envs = requireJSON(envsPath);


        var patt = new RegExp("\@"+ self.projectName +"/"+ env +"$");
        for (let protocol in ports) {
            for (let scheme  in ports[protocol]) {
                for (let p in ports[protocol][scheme]) {
                    if ( patt.test(ports[protocol][scheme][p]) ) {
                        delete ports[protocol][scheme][p]
                    }
                }
            }
        }

        patt = new RegExp("\@"+ self.projectName +"$");
        for (let bundle in portsReverse) {
            if ( patt.test(bundle) ) {
                for (let e in portsReverse[bundle]) {
                    if ( e == env ) {
                        delete portsReverse[bundle][e]
                    }
                }
            }
        }

        for (let bundle in envs) {
            for (let e in envs[bundle]) {
                if (e == env) {
                    delete envs[bundle][e]
                }
            }
        }

        lib.generator.createFileFromDataSync(ports, portsPath);
        lib.generator.createFileFromDataSync(portsReverse, portsReversePath);
        lib.generator.createFileFromDataSync(envs, envsPath);

        updateManifest();
    };

    /**
     * Removes the environment's release target entries from the project manifest
     * across all scopes, then writes manifest.json and calls end.
     *
     * @inner
     * @private
     */
    var updateManifest = function() {
        var env     = local.env;
        var scopes  = self.projects[self.projectName].scopes;
        var projectData    = JSON.clone(self.projectData);

        for (let bundle in projectData.bundles) {
            for (let s = 0, sLen = scopes.length; s < sLen; ++s) {
                let scope = scopes[s];
                if (
                    typeof(projectData.bundles[bundle].releases[scope][env]) != 'undefined'
                    && typeof(projectData.bundles[bundle].releases[scope][env].target) != 'undefined'
                ) {
                    delete projectData.bundles[bundle].releases[scope][env].target
                }
            }
        }


        lib.generator.createFileFromDataSync(projectData, self.projectManifestPath);

        end()
    }

    /**
     * Prints a success message or an error and exits the process.
     *
     * @inner
     * @private
     * @param {Error} [err] - Error to report; omit on success
     */
    var end = function(err) {
        console.debug('GINA_ENV_IS_DEV ', GINA_ENV_IS_DEV);
        if (err) {
            if (GINA_ENV_IS_DEV) {
                console.error(err.stack);
            } else {
                console.error(err.message);
            }

            return process.exit(1);
        }
        var env = local.env;
        console.log('Environment [ '+env+' ] removed with success');

        return process.exit(0)
    }

    init()
};

module.exports = Remove