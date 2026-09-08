var console = lib.logger;
/**
 * @module gina/lib/cmd/framework/get
 */
/**
 * Reads and prints one or more entries from the framework settings file.
 * Counterpart to `framework:set`.
 *
 * Usage:
 *  gina get                            (prints all keys)
 *  gina get --rundir                   (prints value of rundir)
 *  gina get --rundir --log-level       (prints values of rundir and log_level)
 *  gina get defaultEnv                 (bare key name — prints value of defaultEnv)
 *  gina get all                        (explicit all — same as no args)
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
        self.target     = _(GINA_HOMEDIR +'/' + GINA_SHORT_VERSION + '/settings.json');
        self.settings   = require(self.target);
        self.bulk       = false;

        if ( process.argv.length > 3 ) {
            self.bulk = true
        }
        get()
    }

    /**
     * Formats and prints the requested settings entries, then exits with code 0.
     * Supports both `--flag` style and bare key names.
     * `--all` or `all` prints every entry (same as no arguments).
     *
     * @inner
     * @private
     */
    var get = function() {
        var str = ''
            , key = ''
            , settings = self.settings;

        if (!self.bulk) {
            for (var prop in settings) {
                str += prop +' = '+ settings[prop] +'\n'
            }
        } else {
            // check for explicit `all` / `--all`
            for (var i = 3; i < process.argv.length; ++i) {
                if ( /^(\-\-all|all)$/i.test(process.argv[i]) ) {
                    for (var prop in settings) {
                        str += prop +' = '+ settings[prop] +'\n'
                    }
                    break
                }
            }

            // if `all` was not matched, look for specific keys
            if (str == '') {
                for (var i = 3; i < process.argv.length; ++i) {
                    if ( /^(\-\-)/.test(process.argv[i]) ) {
                        // --flag style: --log-level → log_level
                        key = process.argv[i].replace(/\-\-/, '').replace(/\-/g, '_');
                    } else {
                        // bare key style: log_level or log-level
                        key = process.argv[i].replace(/\-/g, '_');
                    }

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
