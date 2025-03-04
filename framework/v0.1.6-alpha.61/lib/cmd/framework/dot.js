var os      = require('os');
var exec    = require('child_process').exec;

var console = lib.logger;

function Dot(){

    var init = function(opt){
        if ( typeof(process.argv[3]) == 'undefined') {
            proceed('framework')
        } else {
            proceed(process.argv[3])
        }
    }

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
    }

    init()
};

module.exports = Dot