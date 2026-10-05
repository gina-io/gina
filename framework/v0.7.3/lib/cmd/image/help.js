var fs        = require('fs');

var CmdHelper = require('./../helper');
var console   = lib.logger;

/**
 * @module gina/lib/cmd/image/help
 */
/**
 * Displays the image command group help text.
 *
 * Usage:
 *  gina image:help
 *
 * @class Help
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Help(opt, cmd) {
    var self = {};

    /**
     * Loads CMD helpers and prints the image group help text, then exits.
     *
     * @inner
     * @private
     */
    var init = function () {

        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        if ( !isCmdConfigured() ) return false;

        getHelp();
        process.exit(0);
    };

    init();
}

module.exports = Help;
