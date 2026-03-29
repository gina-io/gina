var console = lib.logger;
/**
 * @module gina/lib/cmd/env/set
 */
/**
 * Adds or updates key/value entries in the framework settings file.
 * Passing a flag without a value (`--sample`) removes that key.
 *
 * Usage:
 *  gina env:set --log-level=debug
 *  gina env:set --sample=null
 *  gina env:set --sample             (removes the key)
 *
 * @class Set
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Set(opt, cmd){
    var self = {};

    /**
     * Loads settings, applies all --flag[=value] arguments, and saves.
     *
     * @inner
     * @private
     */
    var init = function(){
        self.target = _(GINA_HOMEDIR +'/' + GINA_RELEASE + '/settings.json');
        self.settings = require(self.target);

        var modified = false, argv = JSON.clone(process.argv);

        for (var i in argv) {
            if ( /^(\-\-)(?=)/.test(argv[i]) ) {
                set( argv[i].split(/=/) );
                modified = true
            }
        }

        if (modified)
            save(self.settings, self.target);
    };

    /**
     * Applies a single `--key[=value]` token to self.settings.
     * Deletes the key when no value is provided.
     *
     * @inner
     * @private
     * @param {string[]} arr - Result of splitting the flag on `=`; arr[0] is the key, arr[1] the value
     */
    var set = function(arr) {
        if ( typeof(arr[1]) == 'undefined' ) {
            delete self.settings[arr[0].replace(/\-\-/, '').replace(/\-/, '_')];
        } else {
            self.settings[arr[0].replace(/\-\-/, '').replace(/\-/, '_')] = arr[1] || '';
        }
    };

    /**
     * Writes the updated settings object to disk and exits with a success message.
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
        );

        end('Env variable(s) set with success');
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

    init();
}
module.exports = Set;