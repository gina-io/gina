var fs = require('fs');

var CmdHelper   = require('./../helper');
var console     = lib.logger;
/**
 * @module gina/lib/cmd/project/list
 */
/**
 * Lists all registered projects with their existence status.
 * Supports `--more` to include the project path.
 *
 * Usage:
 *  gina project:list
 *  gina project:list --more
 *
 * TODO: check if path exists and add in front of each a green check or a red cross
 * TODO: --help
 * TODO: switch options for `$ gina project:list [ [ --more ] | [-b | --with-bundles] | [-e | --with-envs] ]`
 *
 * @class List
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function List(opt, cmd){

    var self = {};

    /**
     * Loads CMD helpers, formats all project entries, prints them, and exits.
     *
     * @inner
     * @private
     */
    var init = function(){

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        var projects = self.projects
            , list = []
            , str = ''
            , more = (process.argv[3] && /^(?:\-\-more$)/.test(process.argv[3])) ? true : false ;

        for (let p in projects) {
            list.push(p)
        }
        list.sort();

        for(let l=0; l<list.length; ++l) {
            if ( fs.existsSync(projects[ list[l]].path) ) {
                str += '[ ok ] '+ list[l];
                if (more)
                    str += '\n\r\t'+ projects[ list[l] ].path;
                str += '\n\r';
            } else {
                str += '[ ?! ] '+ list[l];
                if (more)
                    str += '\n\r\t'+projects[ list[l] ].path + ' <- where is it ?';
                str += '\n\r';
            }
        }
        console.log(str.substring(0, str.length-2))
        end();
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

module.exports = List