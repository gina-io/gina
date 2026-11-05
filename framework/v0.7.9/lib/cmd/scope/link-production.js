var console = lib.logger;
/**
 * @module gina/lib/cmd/scope/link-production
 */
/**
 * Links a scope to the production slot in ~/.gina/projects.json,
 * effectively renaming which scope is treated as "production".
 * If the current default scope matches the old production scope, the default is updated too.
 *
 * Usage:
 *  gina scope:link-production <scope> [@<project>]
 *
 * @class LinkProduction
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function LinkProduction(opt, cmd) {
    var self = {};

    /**
     * Resolves the project name from argv or cwd, checks that the project is
     * registered, then validates the scope against it, and delegates to link.
     * A missing or unregistered project is refused with a message, exit 1 —
     * checked before the lookup that used to crash on it (#B641).
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

        if ( typeof(process.argv[3]) == 'undefined' ) {
            console.error('Missing argument in [ gina scope:link-production <scope> [@<project_name>] ]');
            process.exit(1)
        }

        // #B641 — check the project before looking the scope up in it: the lookup used
        // to run first, so a missing or unregistered project crashed with a TypeError
        // instead of reaching the two messages below.
        if ( typeof(self.name) == 'undefined' ) {
            console.error('Project name is required: @<project_name>');
            process.exit(1)
        }
        if ( !isDefined(self.name) ) {
            console.error('[ '+self.name+' ] is not a valid project name.');
            process.exit(1)
        }

        if ( !self.projects[self.name].scopes.inArray(process.argv[3]) ) {
            console.error('Scope [ '+process.argv[3]+' ] not found');
            process.exit(1)
        }

        link(process.argv[3], self.projects, self.target);
        // #B648 — end the process here: link() writes synchronously, and wherever
        // bin/cli has bound its MQ listener (an npm install, whose argv[1] ends in
        // gina/bin/cli) nothing else would, so the command hung after its write.
        process.exit(0)
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
     * Sets production_scope to the given scope in projects.json.
     * If def_scope matched the old production_scope, def_scope is updated too.
     * No-ops if the scope is already the production scope.
     *
     * @inner
     * @private
     * @param {string} scope - Scope name to assign as production
     * @param {object} projects - Parsed contents of ~/.gina/projects.json
     * @param {string} target - Absolute path to projects.json
     */
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