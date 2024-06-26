var os = require('os');
var fs = require('fs');
var console = lib.logger;

function Version(opt){

    var init = function(opt){
        var vers = "",
            short = ( typeof(process.argv[3]) != 'undefined') ? process.argv[3]: false,
            msg = require('./msg.json'),
            version = {
                "number"        : GINA_VERSION,
                "platform"      : process.platform,
                "arch"          : process.arch,
                "middleware"    : fs.readFileSync(_( opt.frameworkPath + '/MIDDLEWARE')).toString() || 'none',
                "copyright"     : require(opt.pack).copyright
            };

        vers = msg.basic[4]
            .replace(/%version%/, version.number +' '+ version.platform +' '+ version.arch + ' (MIT)')
            .replace(/%middleware%/, version.middleware)
            .replace(/%copyright%/, version.copyright);

        if (typeof(GINA_VERSION) != "undefined") {
            if (short && (short.split(/=/))[1] == 'true' ) {
                console.log(version.number)
            } else {
                console.log(vers)
            }
        } else {
            console.error(msg.basic[5])
        }

        end();
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

    init(opt)
};

module.exports = Version