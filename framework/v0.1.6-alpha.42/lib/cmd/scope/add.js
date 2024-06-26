var fs      = require('fs');

var CmdHelper   = require('./../helper');
var console = lib.logger;

/**
 * Add new scope for a given project
 *
 * TODO - updateManifest()
 * */
function Add(opt, cmd) {
    var self = {}, local = {};

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

            }
            else if (/^[a-z0-9_.]/.test(process.argv[i])) {
                local.scope = process.argv[i];
                scopes.push(process.argv[i]);
            }
        }


        if ( typeof(self.projectName) == 'undefined') {
            var folder = new _(process.cwd()).toArray().last();
            if ( isDefined('project', folder) ) {
                self.projectName = folder
            }
        }

        if ( isDefined('project', self.projectName) && scopes.length > 0) {
            self.scopes = scopes;
            return saveScopes()
        }

        end( new Error('Missing argument @<project_name>'))
    }


    var saveScopes = function() {
        try {
            addScopeToProject();
        } catch (err) {
            return end(err)
        }
    }

    /**
     * Adding scopes to ~/.gina/projects.json
     *
     * @param {array} scopes
     * */
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


    var updateManifest = function() {

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
};

module.exports = Add