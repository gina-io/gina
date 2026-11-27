var console = lib.logger;
/**
 * @module gina/lib/cmd/env/get
 */
/**
 * Reads and prints one or more entries from the framework settings file.
 *
 * Usage:
 *  gina env:get                        (prints all keys)
 *  gina env:get --rundir
 *  gina env:get --rundir --log-level
 *
 * @class Get
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Get(opt, cmd){
    var self = {};

    /**
     * Loads settings and determines whether to print all keys or a specific subset.
     *
     * @inner
     * @private
     */
    var init = function(){
        self.target     = _(GINA_HOMEDIR +'/' + GINA_RELEASE + '/settings.json');
        self.settings   = require(self.target);
        self.bulk       = false;

        if ( process.argv.length > 3 ) {
            self.bulk = true
        }
        get()
    }

    /**
     * Formats and prints the requested settings entries, then exits with code 0.
     * Prints all entries when no `--flag` arguments are present (non-bulk mode).
     *
     * @inner
     * @private
     */
    var get = function() {
        var str = ''
            , key = ''
            , settings = self.settings;
        if (!self.bulk) {
            for(var prop in settings) {
                str += prop +' = '+ settings[prop] +'\n'
            }
        } else {
            for (var i=0; i<process.argv.length; ++i) {
                if ( /^(\-\-)/.test(process.argv[i]) ) {
                    key = process.argv[i].replace(/\-\-/, '').replace(/\-/, '_');
                    if ( typeof(settings[key]) != 'undefined' ) {
                        str += settings[key] +'\n'
                    }
                }
            }

        }

        if (str != '')
            console.log(str.substring(0, str.length-1));

        process.exit(0)
    }

    init()
};

module.exports = Get