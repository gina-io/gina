var console = lib.logger;
/**
 * Get framework settings
 *
 * e.g.
 *  // get all
 *  $ gina env:get
 *
 *  // get rundir
 *  $ gina env:get --rundir
 *
 *  //get rundir & log_level
 *  $ gina env:get --rundir --log-level
 *
 *  // set or change log_level
 *  $ gina env:set --log-level=debug
 *
 * */
function Get(opt, cmd){
    var self = {};

    var init = function(){
        self.target     = _(GINA_HOMEDIR +'/' + GINA_RELEASE + '/settings.json');
        self.settings   = require(self.target);
        self.bulk       = false;

        if ( process.argv.length > 3 ) {
            self.bulk = true
        }
        get()
    }

    var get = function() {
        var str = ''
            , key = ''
            , settings = self.settings;
        if (!self.bulk) {
            for(var prop in settings) {
                str += prop +' = '+ settings[prop] +'\n'
            }
        } else {
            for (var i=0; i<process.argv.length; ++i) {
                if ( /^(\-\-)/.test(process.argv[i]) ) {
                    key = process.argv[i].replace(/\-\-/, '').replace(/\-/, '_');
                    if ( typeof(settings[key]) != 'undefined' ) {
                        str += settings[key] +'\n'
                    }
                }
            }

        }

        if (str != '')
            console.log(str.substr(0, str.length-1));

        process.exit(0)
    }

    init()
};

module.exports = Get