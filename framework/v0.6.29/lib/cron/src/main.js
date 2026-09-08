// Imports.
var fs      = require('fs');

// var lib     = require('gina').lib;
// var console = lib.logger;

// *    *    *    *    * command to be executed
// ┬    ┬    ┬    ┬    ┬
// │    │    │    │    │
// │    │    │    │    │
// │    │    │    │    └───── day of week(0 - 7)(0 or 7 are Sunday, or use names)
// │    │    │    └────────── month(1 - 12)
// │    │    └─────────────── day of month(1 - 31)
// │    └──────────────────── hour(0 - 23)
// └───────────────────────── min(0 - 59)

/**
 * Crons Collection
 *
 *
 * @package     Lib.Cron
 * @author      Rhinostone
 */
function Cron(opt) {

    // load context
    var cfg             = getConfig()
        , env           = cfg.env
        , bundle        = cfg.bundle
        , bundleConfig  = cfg[bundle][env]
    ;
    /**
     * Init
     * @constructor
     * */
    var init = function(opt) {

        // load crons
        var path        = bundleConfig.cronsPath
            , crons     = {}
            , CronClass = null
            , task      = null // cron task defined in the configuration file
            , files     = fs.readdirSync(path)
            , filename  = ''
            , file      = ''
            , len       = files.length
            , f         = 0
            , cacheless = opt.cacheless
            , conf      = null;

        for (; f<len; ++f) {
            if ( ! /^\./.test(files[f]) &&  files[f] != 'index.js' ) {

                conf = {};

                filename = _(path + '/' +files[f], true);
                if (cacheless) {
                    delete require.cache[require.resolve(filename)];
                }

                if ( fs.statSync(filename).isDirectory() ) {
                    // catalog or set of crons
                    if ( fs.existsSync(_(filename + '/index.js', true)) ) {
                        filename = _(filename + '/index.js', true);
                        if (cacheless) {
                            delete require.cache[require.resolve(filename)];
                        }
                    }

                    if ( typeof(opt[ files[f] ]) != 'undefined' )
                        conf = opt[ files[f] ];

                    if (conf.active) {
                        CronClass                   = require(filename);
                        CronClass.prototype.start   = start;
                        CronClass.prototype.name    = files[f];
                        crons[files[f]]             = new CronClass(conf);
                        crons[files[f]].start('5m'); // by default, 5 min interval
                    }


                } else {
                    file = files[f].replace(/.js/, '');

                    if ( typeof(opt[ file ]) != 'undefined' )
                        conf = opt[ file ];

                    if (conf.active) {
                        CronClass                   = require(filename);
                        CronClass.prototype.start   = start;
                        CronClass.prototype.name    = file;
                        crons[file + 'Cron']        = new CronClass(conf);
                        crons[files[f]].start('5m'); // by default, 5 min interval
                    }
                }
            }
        }
    };

    var start = function (interval) {
        var options = this.options;
        var self    = this;


        var interval        =  options.interval || interval; // for a minute
        var isRealInterval  = ( /\s+/.test(interval) ) ? false : true;
        var value           = interval.match(/\d+/);
        var unit            = null; // will be seconds by default
        try {
            unit = interval.match(/[a-z]+/i)[0]
        } catch(err) {
            unit = 's'
        }

        switch ( unit.toLowerCase() ) {
            case 's':
                interval = value * 1000;
                break;

            case 'm':
                interval = value * 60 * 1000;
                break;

            case 'h':
                interval = value * 60 * 60 * 1000;
                break;

            case 'd':
                interval = value * 60 * 60 * 1000 * 24;
                break;

            default: // seconds by default
                interval = value * 1000;
        }


        if (isRealInterval) {

            if (this.cronId) {
                clearInterval(this.cronId)
            }

            this.cronId = setInterval(function onTimeout() {
                try {
                    self[options.task]();
                } catch (err) {
                    console.error(err.stack)
                }
            }, interval);

        } else {

            interval = options.interval || interval;
            var values = interval.split(/\s+/);

            if (typeof (values.length) == 'undefined' || values.length !== 5 ) {
                console.error('[ cron ] [ '+ this.name +' ] Interval misconfiguration: cron canceled !');

                return false;
            }

            if (this.cronId) {
                clearTimeout(this.cronId)
            }

            this.cronId = setTimeout(function onTimeout() {
                try {
                    self[options.task]();
                } catch (err) {
                    console.error(err.stack)
                }
            }, 3000);

        }

    }

    return init
}

module.exports = Cron;