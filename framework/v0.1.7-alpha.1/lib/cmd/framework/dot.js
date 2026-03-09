var os      = require('os');
var exec    = require('child_process').exec;
/**
 * @module gina/lib/cmd/framework/dot
 */
var console = lib.logger;
/**
 * Opens a Gina-related directory in a new terminal window (macOS only).
 *
 * Usage:
 *  gina .
 *  gina . home | framework | services | lib
 *
 * @class Dot
 * @constructor
 */
function Dot(){

    /**
     * Reads process.argv[3] for the target key and delegates to proceed().
     * @inner
     * @private
     */
    var init = function(opt){
        if ( typeof(process.argv[3]) == 'undefined') {
            proceed('framework')
        } else {
            proceed(process.argv[3])
        }
    }

    /**
     * Opens `target` in a new Terminal.app window (macOS only).
     * @inner
     * @private
     * @param {string} target - Absolute path to open
     */
    var open = function(target){
        var platform = os.platform();
        switch (platform) {
            case 'darwin':
                console.info('About to open: ', target);
                cmd = 'open -a Terminal.app ' + target;
                exec(cmd)
                break;
        }
    }

    /**
     * Maps the key argument to a known Gina path and calls open().
     * @inner
     * @private
     * @param {string} key - One of: home | framework | services | lib | --help | -h
     */
    var proceed = function(key){
        switch (key) {
            case '--help':
            case '-h':
            case 'help':
                console.log('e.g.: open terminal with gina homedir\n $ gina . home\n');
                var spacer = '\n  ';
                console.log(
                    'Available paths are:',
                    '[',
                    'home | framework | services | lib',
                    ']'
                );
                console.log('Empty key will open [ gina ] location');
                console.log( 'FYI: \n\r',
                    '[ framework ] '+ GINA_DIR +'\n\r',
                    '[ home ] '+ GINA_HOMEDIR
                );
                break;

            case 'homedir':
            case 'home':
                open(GINA_HOMEDIR)
                break;

            case 'fwk':
            case 'framework':
                open(GINA_DIR)
                break;

            case 'service':
            case 'services':
                open(GINA_DIR + '/services')
                break;
            case 'lib':
                open(getPath('gina').lib)
                break;
        }

        end();
    }

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

module.exports = Dot