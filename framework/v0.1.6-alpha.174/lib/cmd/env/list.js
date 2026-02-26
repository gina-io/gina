var fs = require('fs');
var console = lib.logger;
/**
 * @module gina/lib/cmd/env/list
 */
/**
 * Lists environments for a given project or all projects.
 * Marks the currently selected default env with `[ * ]`.
 *
 * Usage:
 *  gina env:list [@<project_name>]
 *  gina env:list --all
 *
 * TODO - add selected icon (green check) for selected env
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function List(opt, cmd){
    var self = {};

    /**
     * Loads projects, resolves project name, and delegates to listAll or listProjectOnly.
     *
     * @inner
     * @private
     */
    var init = function(){

        self.projects = require(_(GINA_HOMEDIR + '/projects.json'));
        var err = null;

        if ( typeof(process.argv[3]) != 'undefined') {
            if (process.argv[3] === '--all') {
                listAll()
            } else if ( !isValidName(process.argv[3]) ) {
                console.error('[ '+process.argv[3]+' ] is not a valid project name. Please, try something else: @[a-z0-9_.].');
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
            listAll()
        } else if ( typeof(self.name) != 'undefined' && isDefined(self.name) ) {
            listProjectOnly()
        } else {
            err = new Error('[ '+self.name+' ] is not a valid project name.');
            end(err, 'log', true);
        }
    }

    /**
     * Returns true when a project name exists in the projects registry.
     *
     * @inner
     * @private
     * @param {string} name - Project name
     * @returns {boolean}
     */
    var isDefined = function(name) {
        if ( typeof(self.projects[name]) != 'undefined' ) {
            return true
        }
        return false
    }

    /**
     * Validates a project name token (strips leading `@`) and sets self.name.
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
     * Lists environments for every registered project.
     *
     * @inner
     * @private
     */
    var listAll = function() {
        var projects = self.projects
            , list = []
            , p = ''
            , e = 0
            , str = '';

        for (p in projects) {
            list.push(p)
        }
        list.sort();

        p = 0;
        for (; p<list.length; ++p) {
            projects[list[p]].envs.sort();
            str += '------------------------------------\n\r';
            if ( !fs.existsSync(projects[list[p]].path) ) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';
            for (var e=0; e<projects[list[p]].envs.length; e++) {
                if (projects[list[p]].envs[e] === projects[list[p]].def_env) {
                    str += '[ * ] ' + projects[list[p]].envs[e]
                } else {
                    str += '[   ] ' + projects[list[p]].envs[e]
                }
                str += '\n\r'
            }
            str += '\n\r'
        }

        console.log(str);
        end();
    }

    /**
     * Lists environments for self.name project only.
     *
     * @inner
     * @private
     */
    var listProjectOnly = function (){
        var projects = self.projects
            , p = self.name
            , e = 0
            , str = '';

        for (; e<projects[p].envs.length; e++) {
            if (projects[p].envs[e] === projects[p].def_env) {
                str += '[ * ] ' + projects[p].envs[e]
            } else {
                str += '[   ] ' + projects[p].envs[e]
            }
            str += '\n\r'
        }

        console.log(str);
        end();
    };

    /**
     * Prints optional output and exits the process.
     *
     * @inner
     * @private
     * @param {string|Error} [output] - Message or error to display
     * @param {string} [type] - console method to call (e.g. 'error')
     * @param {boolean} [messageOnly] - When true, print only the message (not the stack)
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

module.exports = List