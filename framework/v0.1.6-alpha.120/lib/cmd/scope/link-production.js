var console = lib.logger;
/**
 * Link scope to production - A way of renaming production
 * */
function LinkProduction(opt, cmd) {
    var self = {};

    var init = function() {
        self.target = _(GINA_HOMEDIR + '/projects.json');
        self.projects   = require(self.target);

        if ( typeof(process.argv[4]) != 'undefined') {
            if ( !isValidName(process.argv[4]) ) {
                console.error('[ '+process.argv[4]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
                process.exit(1);
            }
        } else {
            // is current path == project path ?
            var root = process.cwd();
            var name = new _(root).toArray().last();
            if ( isDefined(name) ) {
                self.name = name
            }
        }

        if ( typeof(process.argv[3]) != 'undefined' ) {
            if ( !self.projects[self.name].scopes.inArray(process.argv[3]) ) {
                console.error('Scope [ '+process.argv[3]+' ] not found');
                process.exit(1)
            }
        } else {
            console.error('Missing argument in [ gina scope:use <scope> ]');
            process.exit(1)
        }

        if ( typeof(self.name) == 'undefined' ) {
            console.error('Project name is required: @<project_name>');
            process.exit(1)
        } else if ( typeof(self.name) != 'undefined' && isDefined(self.name) ) {
            link(process.argv[3], self.projects, self.target)
        } else {
            console.error('[ '+self.name+' ] is not a valid project name.');
            process.exit(1)
        }
    }

    var isDefined = function(name) {
        if ( typeof(self.projects[name]) != 'undefined' ) {
            return true
        }
        return false
    }

    var isValidName = function(name) {
        if (name == undefined) return false;

        self.name = name.replace(/\@/, '');
        var patt = /^[a-z0-9_.]/;
        return patt.test(self.name)
    }

    var link = function(scope, projects, target) {

        if (scope !== projects[self.name]['production_scope']) {
            if (projects[self.name]['def_scope'] === projects[self.name]['production_scope']) {
                projects[self.name]['def_scope'] = scope
            }

            projects[self.name]['production_scope'] = scope;
            lib.generator.createFileFromDataSync(
                projects,
                target
            )
        }
    };

    init()
};

module.exports = LinkProduction