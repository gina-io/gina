var fs      = require('fs');

var CmdHelper   = require('./../helper');
var console = lib.logger;

/**
 * @module gina/lib/cmd/scope/add
 */
/**
 * Adds a new scope to a specific project or registers it globally across all projects.
 *
 * Usage:
 *  gina scope:add <scope> @<project>
 *  gina scope:add <scope>
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
     * Parses argv for scope names and project token, then dispatches to saveScopes.
     *
     * @inner
     * @private
     */
    var init = function() {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        self.projects = requireJSON(_(GINA_HOMEDIR + '/projects.json'));
        self.bundles = [];
        self.portsAvailable = {};

        var i = 3, scopes = [];
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

                if ( isDefined('project', self.projectName) && scopes.length > 0) {
                    self.scopes = scopes;
                    return saveScopes(self.projectName)
                }

                return end( new Error('Missing argument @<project_name>'))
            }
            else if (/^[a-z0-9_.]/.test(process.argv[i])) {
                local.scope = process.argv[i];
                scopes.push(process.argv[i]);
            }
        }

        self.scopes = scopes;
        return saveScopes()
    }


    /**
     * Dispatches to addScopeToProject (project-scoped) or registerScope (global),
     * depending on whether a project name was supplied.
     *
     * @inner
     * @private
     * @param {string} [projectName] - Registered project name; omitted for global registration
     */
    var saveScopes = function(projectName) {
        try {
            if (projectName) {
                return addScopeToProject();
            }
            registerScope();
        } catch (err) {
            return end(err)
        }
    }

    /**
     * Appends the new scopes to the project entry in ~/.gina/projects.json
     * and writes the file.
     *
     * @inner
     * @private
     */
    var addScopeToProject = function() {
        var s = 0
            , newScopes = self.scopes
            , projects = JSON.clone(self.projects)
            , scopes = projects[self.projectName].scopes
            , modified = true
        ;
        // to ~/.gina/projects.json
        for (; s < newScopes.length; ++s) {

            if (scopes.indexOf(newScopes[s]) < 0 ) {
                modified = false;
                scopes.push(newScopes[s])
            }
        }
        //writing
        lib.generator.createFileFromDataSync(
            projects,
            self.projectConfigPath
        );
        self.projectDataWrote = true;

        //updateManifest()

        if (modified) {
            return end('scope `'+ local.scope +'` updated');
        }

        end('scope'+((self.scopes.length > 1) ? 's' : '')+' [ '+ self.scopes.join(', ') +' ] created');
    }

    /**
     * Registers the new scopes globally in ~/.gina/settings.json and
     * propagates them to every registered project in projects.json.
     *
     * @inner
     * @private
     */
    var registerScope = function() {
        var s           = 0
            , scopes    = JSON.clone(self.mainConfig.scopes[GINA_SHORT_VERSION])
            , newScopes = self.scopes
        ;
        // to ~/.gina/projects.json
        for (; s < newScopes.length; ++s) {
            if (scopes.indexOf(newScopes[s]) < 0 ) {
                scopes.push(newScopes[s]);
                if (!self.mainConfig[newScopes[s]+'_scope']) {
                    self.mainConfig[newScopes[s]+'_scope'] = {};
                }
                self.mainConfig[newScopes[s]+'_scope'] = newScopes[s];
            }
        }
        self.mainConfig.scopes[GINA_SHORT_VERSION] = scopes;
        //writing
        lib.generator.createFileFromDataSync(
            self.mainConfig,
            self.mainConfigPath
        );
        self.mainConfigUpdated = true;

        // Update existing projects scopes
        for (let p in self.projects) {
            let project = self.projects[p];
            scopes    = JSON.clone(project.scopes);
            s = 0;
            for (; s < newScopes.length; ++s) {
                if (scopes.indexOf(newScopes[s]) < 0 ) {
                    scopes.push(newScopes[s]);
                    if (!project[newScopes[s]+'_scope']) {
                        project[newScopes[s]+'_scope'] = {};
                    }
                    project[newScopes[s]+'_scope'] = newScopes[s];
                }
            }
            project.scopes = scopes;
            // ?? Updating manifest
            // updateManifest(project);
        }

        lib.generator.createFileFromDataSync(
            self.projects,
            self.projectConfigPath
        );

        end('scope'+((self.scopes.length > 1) ? 's' : '')+' [ '+ self.scopes.join(', ') +' ] created');
    }


    /**
     * Updates the project manifest with the new scopes.
     * Currently a stub — not yet implemented.
     *
     * @inner
     * @private
     * @param {object} project - Project entry from projects.json
     */
    var updateManifest = function(project) {

    }



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