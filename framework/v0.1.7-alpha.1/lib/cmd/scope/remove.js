var fs          = require('fs');
var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * @module gina/lib/cmd/scope/remove
 */
/**
 * Removes a scope from a project's scope list in ~/.gina/projects.json.
 * Refuses to remove the default, local, or production scope.
 *
 * Usage:
 *  gina scope:rm <scope> @<project>
 *
 * TODO - Prompt for confirmation: "This will remove [ scope ] for the whole project. Proceed ? Y/n: "
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
    var self = {}, local = { scope: null };

    /**
     * Validates argv, resolves the project name, and delegates to removeScope.
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
        var scope = local.scope = process.argv[3];
        if ( typeof(scope) == 'undefined' || /^\@/.test(scope) ) {
            end( new Error('Missing argument in [ gina scope:rm <scope> @<project> ]') )
        }
        else if ( typeof(scope) != 'undefined' ) {
            if ( !self.projects[self.projectName].scopes.inArray(scope) ) {
                end( new Error('Scope [ '+scope+' ] not found') )
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
            removeScope(self.projects, self.target)
        } else {
            end( new Error('[ '+self.projectName+' ] is not a valid project name.') )
        }
    }

    /**
     * Removes the scope from the project's scopes array in projects.json.
     * Refuses to remove the default, local, or production scope.
     *
     * @inner
     * @private
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     * @param {string} target - Absolute path to projects.json
     */
    var removeScope = function(projects, target) {
        var err = null, scope = local.scope;
        // default `local scope` or default `production scope` cannot be removed
        if(
            scope === projects[self.projectName]['local_scope']
            ||
            scope === projects[self.projectName]['production_scope']
            ||
            scope === projects[self.projectName]['def_scope']
        ) {
            if (scope === projects[self.projectName]['def_scope']) {
                err = new Error('Scope [ '+scope+' ] is set as "default scope" and cannot be removed until you `use` another default scope')
            }
            else {
                err = new Error('Scope [ '+scope+' ] is linked as "local scope" and cannot be removed until you `link` another local scope')
            }

            return end(err, 'error', true);
        }


        projects[self.projectName]['scopes'].splice(projects[self.projectName]['scopes'].indexOf(scope), 1);
        lib.generator.createFileFromDataSync(
            projects,
            target
        );

        // updateManifest();

        end('Scope [ '+scope+' ] removed with success');
    };

    /**
     * Removes the scope's release entries from the project manifest and writes it.
     * Currently unused — commented out at the call site.
     *
     * @inner
     * @private
     */
    var updateManifest = function() {
        var scope = local.scope;
        var projectData    = JSON.clone(self.projectData);
        for (let bundle in projectData.bundles) {
            if (
                typeof(projectData.bundles[bundle].releases[scope]) != 'undefined'
            ) {
                delete projectData.bundles[bundle].releases[scope]
            }
        }

        lib.generator.createFileFromDataSync(projectData, self.projectManifestPath);
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

module.exports = Remove