var console = lib.logger;
/**
 * Add or edit framework settings
 *
 *  // set or change log_level
 *  $ gina env:set --log-level=debug
 *
 *  // remove sample key
 *  $ gina env:set --sample
 *
 *  NB.: key values can be set to undefined or null
 *  $ gina env:set --sample=undefined
 *  $ gina env:set --sample=null
 *
 *  Once set, you can call the constant from your application
 *  $ gina env:set --my-contant
 *  console.log(GINA_MY_CONTSTANT)
 *
 * */
function Set(opt, cmd){
    var self = {};

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

    var set = function(arr) {
        if ( typeof(arr[1]) == 'undefined' ) {
            delete self.settings[arr[0].replace(/\-\-/, '').replace(/\-/, '_')];
        } else {
            self.settings[arr[0].replace(/\-\-/, '').replace(/\-/, '_')] = arr[1] || '';
        }
    };

    var save = function(data, target) {
        lib.generator.createFileFromDataSync(
            data,
            target
        );

        end('Env variable(s) set with success');
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

    init();
}
module.exports = Set;