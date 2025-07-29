var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * Select the default scope
 * */
function Use(opt, cmd) {
    var self = {};

    console.debug('scope:use called');

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

    var updateManifest = function(scope, projects) {
        var projectData    = JSON.clone(self.projectData);
        projectData.scope = scope

        lib.generator.createFileFromDataSync(projectData, self.projectManifestPath);
    }

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