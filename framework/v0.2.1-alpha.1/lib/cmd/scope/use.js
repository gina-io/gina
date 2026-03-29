var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/scope/use
 */
/**
 * Sets the default scope for a project in ~/.gina/projects.json
 * and updates the project manifest with the selected scope.
 *
 * Usage:
 *  gina scope:use <scope> @<project>
 *
 * @class Use
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Use(opt, cmd) {
    var self = {};

    console.debug('scope:use called');

    /**
     * Loads projects.json, imports CMD helpers, and delegates to useScope.
     *
     * @inner
     * @private
     */
    var init = function() {
        self.target     = _(GINA_HOMEDIR + '/projects.json');
        self.projects   = require(self.target);

        // Import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // Check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if (!self.scopes) {
            return end( new Error('No scope found for your project `'+ self.projectName +'`') );
        }

        useScope(process.argv[3], self.projects, self.target)
    }


    /**
     * Updates def_scope in projects.json and the project manifest.
     * No-ops if the scope is already the default.
     *
     * @inner
     * @private
     * @param {string} scope - Scope name to activate
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     * @param {string} target - Absolute path to projects.json
     */
    var useScope = function(scope, projects, target) {
        console.debug('proj.: ', scope, self.projectName, projects[self.projectName].scopes);
        if ( !self.projects[self.projectName].scopes.inArray(scope) ) {
            end( new Error('Scope [ '+scope+' ] not found for project `'+ self.projectName +'`'), 'error', true )
        }

        if (scope !== projects[self.projectName]['def_scope']) {
            projects[self.projectName]['def_scope'] = scope;
            lib.generator.createFileFromDataSync(
                projects,
                target
            )
        }

        updateManifest(scope, projects);

        end('Scope [ '+ scope +' ] selected with success')
    };

    /**
     * Writes the selected scope into the project manifest file.
     *
     * @inner
     * @private
     * @param {string} scope - Scope name that was selected
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     */
    var updateManifest = function(scope, projects) {
        var projectData    = JSON.clone(self.projectData);
        projectData.scope = scope

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
}
module.exports = Use;