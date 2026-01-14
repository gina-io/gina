var console = lib.logger;
/**
 * Select the default environment
 * */
function Use(opt, cmd) {
    var self = {};

    var init = function() {
        self.target     = _(GINA_HOMEDIR + '/projects.json');
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

        if ( typeof(self.name) == 'undefined' ) {
            // console.error('Project name is required: @<project_name>');
            // process.exit(1);
            return end( new Error('Project name is required: @<project_name>'));
        }
        else if ( typeof(self.name) != 'undefined' && isDefined(self.name) ) {
            if ( typeof(process.argv[3]) != 'undefined' ) {

                if ( !self.projects[self.name].envs.inArray(process.argv[3]) ) {
                    // console.error('Environment [ '+process.argv[3]+' ] not found');
                    // process.exit(1)
                    return end(new Error('Environment [ '+process.argv[3]+' ] not found'))
                }
            } else {
                // console.error('Missing argument in [ gina env:use <environment> ]');
                // process.exit(1);
                return end(new Error('Missing argument in [ gina env:use <environment> ]'))
            }

            return useEnv(process.argv[3], self.projects, self.target);
        }

        end(new Error('[ '+self.name+' ] is not a valid project name.'))

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

    var useEnv = function(env, projects, target) {
        // console.debug('proj.: ', self.name, projects[self.name] , '\nEnv:' + env);
        if (env !== projects[self.name]['def_env']) {
            // console.log('Project [ '+ self.name+' ] env `'+ projects[self.name]['def_env'] +'` set to '+ env);
            projects[self.name]['def_env'] = env;
            lib.generator.createFileFromDataSync(
                projects,
                target
            )
        }


        end('Env [ '+ env +' ] selected with success');
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

    init()
};

module.exports = Use