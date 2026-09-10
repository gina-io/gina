var console = lib.logger;
/**
 * @module gina/lib/cmd/env/unset
 */
/**
 * Removes one or more keys from the framework settings file.
 *
 * Usage:
 *  gina env:unset --rundir --log-level
 *
 * @class Unset
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Unset(opt, cmd){
    var self = {};

    /**
     * Loads settings, removes all `--flag` keys found in argv, and saves.
     *
     * @inner
     * @private
     */
    var init = function() {
        self.target     = _(GINA_HOMEDIR +'/' + GINA_RELEASE + '/settings.json');
        self.settings   = require(self.target);

        var modified = false, argv = JSON.clone(process.argv);

        for (var i in argv) {
            if ( /^(\-\-)/.test(argv[i]) ) {
                unset( argv[i].split(/=/) );
                modified = true
            }
        }

        if (modified)
            save(self.settings, self.target)
    }

    /**
     * Deletes a single key from self.settings; warns if the key does not exist.
     *
     * @inner
     * @private
     * @param {string[]} arr - Result of splitting the flag on `=`; arr[0] is the key
     */
    var unset = function(arr) {
        var key = arr[0].replace(/\-\-/, '').replace(/\-/, '_');
        if ( typeof(self.settings[key]) != 'undefined' ) {
            delete self.settings[key]
        } else {
            console.warn('Key [ '+key+' ] not found')
        }
    }

    /**
     * Writes the updated settings object to disk.
     *
     * @inner
     * @private
     * @param {object} data - Settings object to persist
     * @param {string} target - Absolute path to settings.json
     */
    var save = function(data, target) {
        lib.generator.createFileFromDataSync(
            data,
            target
        )
    };

    init()
};

module.exports = Unset