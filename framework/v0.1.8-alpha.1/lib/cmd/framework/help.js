var console = lib.logger;
var open    = require('./open');
/**
 * @module gina/lib/cmd/framework/help
 */
/**
 * Displays help by opening a relevant documentation path.
 * Delegates to the `open` command with the given key.
 *
 * Usage:
 *  gina framework:help [<key>]
 *
 * @class Help
 * @constructor
 * @param {object} opt - Parsed command-line options
 */
function Help(opt) {
    var init = function() {
        if ( typeof(process.argv[3]) == 'undefined') {
            proceed('framework')
        } else {
            proceed(process.argv[3])
        }
    }

    var proceed = function(key){
        switch (key) {
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
            default:
                console.debug('running default');
        }
    }

    init()
};
module.exports = Help