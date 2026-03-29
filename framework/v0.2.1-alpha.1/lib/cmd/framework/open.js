var Open;
/**
 * @module gina/lib/cmd/framework/open
 */
var fs = require('fs');
var child = require('child_process');

var CmdHelper       = require('./../helper');
var console         = lib.logger;
/**
 * Opens a named Gina filesystem path in the OS file manager or Finder.
 *
 * Usage:
 *  gina framework:open <key>
 *  gina open <key>
 *
 * Keys: service | services | gina | framework | tmp | log | run | home
 *
 * @class Open
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Open(opt, cmd) {

    /**
     * Resolves the path key from argv and invokes the OS open command.
     * @inner
     * @private
     */
    var init = function(){
        var openCmd = (GINA_IS_WIN32) ?  'start' : 'open';

        switch (process.argv[3]) {
            case 'service':
            case 'services':
                child.exec(openCmd + ' ' + GINA_DIR + '/services');
                break;

            case 'gina':
            case 'framework':
                child.exec(openCmd + ' ' + GINA_DIR);
                break;

            case 'tmp':
                child.exec(openCmd + ' ' + GINA_TMPDIR);
                break;

            case 'log':
                child.exec(openCmd + ' ' + GINA_LOGDIR);
                break;

            case 'run':
                child.exec(openCmd + ' ' + GINA_RUNDIR);
                break;

            case 'home':
                if ( fs.existsSync(GINA_HOMEDIR) ) {
                    child.exec(openCmd + ' ' +  GINA_HOMEDIR)
                } else {
                    console.log((GINA_IS_WIN32) ? 'gina: sorry, no %USERPROFILE% found' : 'gina: sorry, no $HOME found')
                }
                break;

            default:
                console.log('gina: shortcut not indexed [' + process.argv[3] + ']' );
        }

        end()
    };

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

module.exports = Open