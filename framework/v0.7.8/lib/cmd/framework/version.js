var os = require('os');
var fs = require('fs');
var console = lib.logger;
/**
 * @module gina/lib/cmd/framework/version
 */
/**
 * Prints the installed Gina framework version, platform, architecture, middleware,
 * and — when the engine package is resolvable — the bundled template engine name and
 * version (swig by default). The template-engine line is omitted when the engine
 * package cannot be read (e.g. a framework directory not yet `npm install`-ed),
 * satisfying the "when available" contract.
 *
 * Usage:
 *  gina framework:version
 *  gina version
 *  gina version --short=true   (prints version number only; no template-engine line)
 *
 * @class Version
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {string} [opt.frameworkPath] - Absolute path to the framework directory (used to read MIDDLEWARE and the bundled template engine's package.json)
 * @param {string} [opt.pack] - Path to package.json for reading the copyright field
 */
function Version(opt){

    /**
     * Reads version info and prints it to the logger.
     * @inner
     * @private
     * @param {object} opt
     */
    var init = function(opt){
        var arch = process.arch;
        switch (process.arch) {
            case 'x64':
                arch = 'amd64'
                break;
            case 'armv7l':
                arch = 'armhf'
                break;
            case 'x86':
                arch = 'i386'
                break;
            default:
                break;
        }
        // Template engine in use — read the framework-bundled engine package (swig by
        // default, declared in framework/v<version>/package.json). Read defensively so a
        // framework directory without the engine package installed (e.g. a fresh clone
        // before `npm install`) simply omits the line, satisfying the "when available"
        // contract rather than crashing the banner.
        var engine = '';
        try {
            var enginePack = JSON.parse( fs.readFileSync(_( opt.frameworkPath + '/node_modules/@rhinostone/swig/package.json')).toString() );
            if ( enginePack && enginePack.name && enginePack.version ) {
                engine = enginePack.name + '@' + enginePack.version;
            }
        } catch (engineErr) {
            engine = '';
        }

        // Read the framework MIDDLEWARE file defensively — it is normally created
        // by post_install / framework:init (checkIfMiddlewareFile), but if it is
        // still absent (e.g. a read-only framework dir) degrade to 'none' instead
        // of crashing, matching the "when available" guard on the engine read above.
        var middleware = 'none';
        try {
            middleware = fs.readFileSync(_( opt.frameworkPath + '/MIDDLEWARE')).toString() || 'none';
        } catch (middlewareErr) {
            middleware = 'none';
        }

        var vers = "",
            short = ( typeof(process.argv[3]) != 'undefined') ? process.argv[3]: false,
            msg = require('./msg.json'),
            version = {
                "number"        : GINA_VERSION,
                "platform"      : process.platform,
                "arch"          : arch,
                "middleware"    : middleware,
                "engine"        : engine,
                "copyright"     : require(opt.pack).copyright
            };

        vers = msg.basic[4]
            .replace(/%version%/, version.number +' '+ version.platform +' '+ version.arch + ' (MIT)')
            .replace(/%middleware%/, version.middleware)
            .replace(/%engine%/, version.engine ? ('Template engine: ' + version.engine + '\n') : '')
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