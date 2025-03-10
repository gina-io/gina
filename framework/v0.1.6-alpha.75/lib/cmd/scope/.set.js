var console = lib.logger;
/**
 * Add or edit framework settings
 *
 *  // set or change log_level
 *  $ gina scope:set --scope=production
 *
 *  // remove sample key
 *  $ gina scope:unset --scope
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
    };

    init();
}
module.exports = Set;