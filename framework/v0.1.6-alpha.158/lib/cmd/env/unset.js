var console = lib.logger;
/**
 * Remove from framework settings
 * */
function Unset(opt, cmd){
    var self = {};

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

    var unset = function(arr) {
        var key = arr[0].replace(/\-\-/, '').replace(/\-/, '_');
        if ( typeof(self.settings[key]) != 'undefined' ) {
            delete self.settings[key]
        } else {
            console.warn('Key [ '+key+' ] not found')
        }
    }

    var save = function(data, target) {
        lib.generator.createFileFromDataSync(
            data,
            target
        )
    };

    init()
};

module.exports = Unset