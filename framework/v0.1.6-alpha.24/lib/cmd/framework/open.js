var Open;

var fs = require('fs');
var child = require('child_process');

var CmdHelper       = require('./../helper');
var console         = lib.logger;

function Open(opt, cmd) {

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