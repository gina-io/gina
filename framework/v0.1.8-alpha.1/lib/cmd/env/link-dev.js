var console = lib.logger;
/**
 * @module gina/lib/cmd/env/link-dev
 */
/**
 * Links an environment to the development slot (dev_env) for a project,
 * optionally promoting it to the default (def_env) if def_env was previously
 * the development environment.
 *
 * Usage:
 *  gina env:link-dev <env> [@<project>]
 *
 * @class LinkDev
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function LinkDev(opt, cmd) {
    var self = {};

    /**
     * Resolves the project name from argv or cwd, validates the env argument,
     * and delegates to link.
     *
     * @inner
     * @private
     */
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
            if ( !self.projects[self.name].envs.inArray(process.argv[3]) ) {
                console.error('Environment [ '+process.argv[3]+' ] not found');
                process.exit(1)
            }
        } else {
            console.error('Missing argument in [ gina env:use <environment> ]');
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

    /**
     * Returns true when a project name exists in the projects registry.
     *
     * @inner
     * @private
     * @param {string} name - Project name to look up
     * @returns {boolean}
     */
    var isDefined = function(name) {
        if ( typeof(self.projects[name]) != 'undefined' ) {
            return true
        }
        return false
    }

    /**
     * Strips a leading `@` from the name token, stores it in self.name,
     * and validates it against the allowed pattern.
     *
     * @inner
     * @private
     * @param {string} name - Raw project name token (may start with `@`)
     * @returns {boolean}
     */
    var isValidName = function(name) {
        if (name == undefined) return false;

        self.name = name.replace(/\@/, '');
        var patt = /^[a-z0-9_.]/;
        return patt.test(self.name)
    }

    /**
     * Sets dev_env to the given env; also updates def_env when it previously
     * matched the old dev_env. Writes projects.json when a change is made.
     *
     * @inner
     * @private
     * @param {string} env - Environment name to link as development
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     * @param {string} target - Absolute path to projects.json
     */
    var link = function(env, projects, target) {

        if (env !== projects[self.name]['dev_env']) {
            if (projects[self.name]['def_env'] === projects[self.name]['dev_env']) {
                projects[self.name]['def_env'] = env
            }

            projects[self.name]['dev_env'] = env;
            lib.generator.createFileFromDataSync(
                projects,
                target
            )
        }
    };

    init()
};

module.exports = LinkDev