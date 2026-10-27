var fs = require('fs');

var CmdHelper = require('./../helper');
var console = lib.logger;

/**
 * @module gina/lib/cmd/protocol/list
 */
/**
 * Lists the protocols and schemes configured for all projects, a single project,
 * or a specific bundle. Marks the default protocol/scheme with `[ * ]`.
 *
 * Usage:
 *  gina protocol:list
 *  gina protocol:list @<project_name>
 *  gina protocol:list <bundle> @<project_name>
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
function List(opt, cmd) {

    // self will be pre filled if you call `new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled })`
    var self = {}, local = {};

    /**
     * Validates arguments and delegates to listAllByProject, listByBundle
     * (project scope), or listByBundle (single bundle).
     *
     * @inner
     * @private
     */
    var init = function() {
        //debugger;
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;


        if (!self.name && !self.projectName) {
            listAllByProject()
        } else if (self.projectName && isDefined(self.projectName) && !self.name) {
            listByBundle()
        } else if (typeof (self.name) != 'undefined' && isValidName(self.name) ) {
            listByBundle(self.name)
        } else {
            console.error('[ ' + self.name + ' ] is not a valid project name.');
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
        if (typeof (self.projects[name]) != 'undefined') {
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
     * Lists protocols and schemes for every registered project.
     *
     * @inner
     * @private
     */
    var listAllByProject = function() {

        var protocols       = null
            , schemes       = null
            , projects      = self.projects
            , list          = []
            , p             = null
            , i             = null
            , len           = null
            , str           = ''
            , schemeStr     = ''
            , protocolStr   = ''
            , indexObj      = null
            , index         = null
        ;

        for (p in projects) {
            list.push(p)
        }
        list.sort();

        p = 0;
        for (; p < list.length; ++p) {

            str += '------------------------------------\n\r';
            if (!projects[list[p]].exists) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';
            protocols = projects[list[p]].protocols;
            schemes = projects[list[p]].schemes;

            if (!protocols) continue;

            str += '      Protocol(s)        Scheme(s)\n\r';


            indexObj = {}; index = 2;
            i = 0; len = protocols.length;
            for (; i < len; ++i) {
                protocolStr = '';
                if (projects[list[p]].def_protocol == protocols[i]) {
                    protocolStr += '[ * ] ' + protocols[i]
                } else {
                    protocolStr += '[   ] ' + protocols[i]
                }

                if ( (index % 2) == 0 ){
                    indexObj[index] = protocolStr;
                    index += 2
                }
            }


            index = 3;
            i = 0; len = schemes.length;
            for (; i < len; ++i) {
                schemeStr = '';
                if (projects[list[p]].def_scheme == schemes[i]) {
                    schemeStr += '           [ * ] ' + schemes[i]
                } else {
                    schemeStr += '           [   ] ' + schemes[i]
                }

                if ( (index % 2) != 0 ){
                    indexObj[index] = schemeStr;
                    index += 2
                }
            }

            i = null;
            for (i in indexObj) {
                str += indexObj[i];
                if ( (~~i % 3) == 0 ){
                    str += '\n\r'
                }
            }

            str += '\n\r'
        }

        console.log(str);
        end();
    }

    /**
     * Lists protocols and schemes for every bundle in self.projectName,
     * or for a specific bundle when bundleName is given.
     *
     * @inner
     * @private
     * @param {string} [bundleName] - Bundle name to filter on; omit for all bundles
     */
    var listByBundle = function(bundleName) {

        var protocols       = null
            , schemes       = null
            , bundles       = self.bundlesByProject[self.projectName]
            , list          = []
            , p             = null
            , i             = null
            , len           = null
            , str           = ''
            , schemeStr     = ''
            , protocolStr   = ''
            , indexObj      = null
            , index         = null
        ;

        if ( typeof(bundleName) != 'undefined' ) {
            list.push(bundleName)
        } else {
            for (p in bundles) {
                list.push(p)
            }
            list.sort();
        }



        p = 0;
        for (; p < list.length; ++p) {


            str += '------------------------------------\n\r';
            if (!bundles[list[p]].exists) {
                str += '?! '
            }
            str += list[p] + '\n\r';
            str += '------------------------------------\n\r';

            protocols = bundles[list[p]].protocols;
            schemes = bundles[list[p]].schemes;
            if (!protocols || protocols.length == 0) continue;


            str += '      Protocol(s)        Scheme(s)\n\r';


            indexObj = {}; index = 2;
            i = 0; len = protocols.length;
            for (; i < len; ++i) {
                protocolStr = '';
                if (bundles[list[p]].def_protocol == protocols[i]) {
                    protocolStr += '[ * ] ' + protocols[i]
                } else {
                    protocolStr += '[   ] ' + protocols[i]
                }

                if ( (index % 2) == 0 ){
                    indexObj[index] = protocolStr;
                    index += 2
                }
            }


            index = 3;
            i = 0; len = schemes.length;
            for (; i < len; ++i) {
                schemeStr = '';
                if (bundles[list[p]].def_scheme == schemes[i]) {
                    schemeStr += '           [ * ] ' + schemes[i]
                } else {
                    schemeStr += '           [   ] ' + schemes[i]
                }

                if ( (index % 2) != 0 ){
                    indexObj[index] = schemeStr;
                    index += 2
                }
            }

            i = null;
            for (i in indexObj) {
                str += indexObj[i];
                if ( (~~i % 3) == 0 ){
                    str += '\n\r'
                }
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