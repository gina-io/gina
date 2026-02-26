var console = lib.logger;
/**
 * @module gina/lib/cmd/framework/set
 */
/**
 * Sets one or more framework configuration values in `~/.gina/main.json` and
 * `~/.gina/{shortVersion}/settings.json`.
 *
 * Usage:
 *  gina framework:set --prefix=<path>
 *  gina framework:set --env=<env>
 *  gina framework:set --scope=<scope>
 *  gina framework:set --log-level=<level>
 *  gina framework:set --port=<port>
 *  gina framework:set --culture=<culture>
 *  gina framework:set --timezone=<tz>
 *  (and more — see switch cases inside set())
 *
 * @class Set
 * @constructor
 * @param {object} opt - Parsed command-line options
 */
function Set(opt){

    var mainConfPath        = _(GINA_HOMEDIR + '/main.json', true)
        , mainConf          = require(mainConfPath)
        , mainSettingsPath  = _(GINA_HOMEDIR +'/'+ GINA_SHORT_VERSION + '/settings.json', true)
        , mainSettingsConf  = require(mainSettingsPath)
        , pack              = require(_(GINA_DIR +'/package.json', true ))
    ;

    /**
     * Iterates over process.argv from index 3 and calls set(k, v) for each key=value pair.
     * @inner
     * @private
     * @param {object} opt
     */
    var init = function(opt){

        var a = [], k = null, v = null;
        for (let i=3; i<process.argv.length; ++i) {
            a = process.argv[i].split(/=/);
            k = a[0];
            v = a[1];
            console.debug('Preprocessing `framework:set '+ process.argv[i] +'`');
            set(k,v);
        }
        end()
    };



    /**
     * Dispatches a single key/value setting to the appropriate setter function.
     * @inner
     * @private
     * @param {string} k - Flag name (e.g. '--env', '--prefix')
     * @param {string} v - Value to set
     */
    var set = function(k, v) {
        var err = null;
        if ( /^-—/.test(k) ) {
            k = k.replace(/-—/, '--');
        }
        switch(k) {
            case '--prefix':
                setPrefix(v);
            break;

            case '--global_mode':
            case '--global-mode':
                setGlobalMode(v);
            break;

            case '--log_level':
            case '--log-level':
                setLogLevel(v);
            break;

            case '--env':
                setEnv(v);
            break;

            case '--scope':
                setScope(v)
            break;

            case '--culture':
                setCulture(v);
            break;

            case '--port':
                setKeyVal('port', ~~v);
            break;

            case '--debug_port':
            case '--debug-port':
                setKeyVal('debug_port', ~~v);
            break;

            case '--mq_port':
            case '--mq-port':
                setKeyVal('mq_port', ~~v);
            break;

            case '--host_v4':
            case '--host-v4':
                setKeyVal('host_v4', v);
            break;

            case '--iso_short':
            case '--iso-short':
                setKeyVal('iso_short', v);
            break;

            case '--hostname':
                setKeyVal('hostname', v);
            break;

            case '--timezone':
                setTimezone(v);
            break;

            case '--date':
                setKeyVal('date', v);
            break;

            default:
                return end(new Error('Setting environment variable `'+ k +'` is not supported'), 'error', true);
                // err = new Error('Setting environment variable `'+ k +'` is not supported');
                // console.error(err.message);

        }
    }

    /**
     * Generic setter — writes a key/value pair to `process.gina` and `settings.json`.
     * @inner
     * @private
     * @param {string} key - Settings key
     * @param {string|number|boolean} value - Value to store
     */
     var setKeyVal = function(key, value) {
        console.debug('Setting `'+key+'` to '+ value);
        // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
        if ( /^(true|false)$/i.test(value) ) {
            value = ( /^true$/i.test(value) ) ? true : false;
        }

        process['gina'][key] = value;
        mainSettingsConf[key] = value;
        lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    }

    /**
     * Updates the install prefix in main.json, settings.json, and package.json.
     * @inner
     * @private
     * @param {string} prefix - Absolute filesystem prefix path
     */
    var setPrefix = function(prefix) {
        var err = null;
        if ( !prefix || typeof(prefix) == 'undefined' || prefix == '' ) {
            err = new Error('Prefix cannot be left empty or undefined');
            console.error(err.message);
            return
        }
        // save to ~/.gina/main.json
        if ( typeof(mainConf['def_prefix']) == 'undefined' ) {
            mainConf['def_prefix'] = {}
        }
        mainConf['def_prefix'][GINA_SHORT_VERSION] = prefix;
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
        // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
        process['gina']['prefix'] = prefix;
        mainSettingsConf['prefix'] = prefix;
        lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
        // update package.json
        pack.config.prefix = prefix;
        var ginaPackagePathObj = new _(GINA_DIR +'/package.json', true);
        // skip for post install step
        if ( ginaPackagePathObj.existsSync() ) {
            lib.generator.createFileFromDataSync(pack, ginaPackagePathObj.toString());
        }
    }


    /**
     * Updates the global_mode flag in main.json, settings.json, and package.json.
     * @inner
     * @private
     * @param {string} globalMode - 'true' or 'false'
     */
    var setGlobalMode = function(globalMode) {
        var err = null;
        try {
            if ( typeof(globalMode) == 'undefined' || globalMode == '' ) {
                err = new Error('Global Mode cannot be left empty or undefined');
                console.error(err.message);
                return
            }
            var ginaPackagePathObj = new _(GINA_DIR +'/package.json', true);
            globalMode = /^true$/i.test(globalMode) ? true : false;
            // save to ~/.gina/main.json
            if ( typeof(mainConf['def_global_mode']) == 'undefined' ) {
                mainConf['def_global_mode'] = {}
            }
            mainConf['def_global_mode'][GINA_SHORT_VERSION] = globalMode;
            // skip for post install step
            if ( ginaPackagePathObj.existsSync() ) {
                lib.generator.createFileFromDataSync(mainConf, mainConfPath);
            }
            // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
            process['gina']['global_mode'] = globalMode;
            mainSettingsConf['global_mode'] = globalMode;
            lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
            // update package.json
            pack.config.globalMode = globalMode;
            console.info('GINA_DIR => ', GINA_DIR);

            // skip for post install step
            if ( ginaPackagePathObj.existsSync() ) {
                lib.generator.createFileFromDataSync(pack, ginaPackagePathObj.toString());
            }
        } catch (setGlobalModeErr) {
            throw setGlobalModeErr
        }
    }

    /**
     * Updates the log level in main.json and settings.json.
     * @inner
     * @private
     * @param {string} level - Log level (must be in main.json log_levels list)
     */
    var setLogLevel = function(level) {
        var supported   = mainConf['log_levels'][GINA_SHORT_VERSION]
            , err       = null
        ;
        if (supported.indexOf(level) < 0) {
            err = new Error('Log level `'+ level +'` is not supported at the moment');
            console.error(err.message);
            return;
        }
        // save to ~/.gina/main.json
        mainConf['def_log_level'][GINA_SHORT_VERSION] = level;
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
        // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
        process['gina']['log_level'] = level;
        mainSettingsConf['log_level'] = level;
        lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    }

    /**
     * Updates the default environment in main.json.
     * @inner
     * @private
     * @param {string} env - Environment name (must be registered in main.json)
     */
    var setEnv = function(env) {
        var supported   = mainConf['envs'][GINA_SHORT_VERSION]
            , err       = null
        ;
        if (supported.indexOf(env) < 0) {
            err = new Error('Environment `'+ env +'` is not supported at the moment');
            console.error(err.message);
            return;
        }
        mainConf['def_env'][GINA_SHORT_VERSION] = env;
        // save to ~/.gina/main.json
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
    }

    /**
     * Updates the default scope in main.json.
     * @inner
     * @private
     * @param {string} scope - Scope name (must be registered in main.json)
     */
    var setScope = function(scope) {
        var supported   = mainConf['scopes'][GINA_SHORT_VERSION]
            , err       = null
        ;
        if (supported.indexOf(scope) < 0) {
            err = new Error('Scope `'+ scope +'` is not supported at the moment');
            console.error(err.message);
            return;
        }
        mainConf['def_scope'][GINA_SHORT_VERSION] = scope;
        // save to ~/.gina/main.json
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
    }

    /**
     * Updates the default culture in main.json and settings.json.
     * @inner
     * @private
     * @param {string} culture - Culture string (must be registered in main.json)
     */
    var setCulture = function(culture) {
        var supported   = mainConf['cultures'][GINA_SHORT_VERSION]
            , err       = null
        ;
        if (supported.indexOf(culture) < 0) {
            err = new Error('Culture `'+ culture +'` is not supported at the moment');
            console.error(err.message);
            return;
        }
        // save to ~/.gina/main.json
        mainConf['def_culture'][GINA_SHORT_VERSION] = culture;
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
        // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
        process['gina']['culture'] = culture;
        mainSettingsConf['culture'] = culture;
        lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    }

    // var setPort = function(key, port) {
    //     console.debug('Setting `'+ key +'` to #'+ port);
    //     // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
    //     process['gina'][key] = ~~port;
    //     mainSettingsConf[key] = ~~port;
    //     lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    // }


    // var setDebugPort = function(port) {
    //     console.debug('Setting `debug port` to #'+ port);
    //     // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
    //     process['gina']['debug_port'] = ~~port;
    //     mainSettingsConf['debug_port'] = ~~port;
    //     lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    // }

    /**
     * Updates the default timezone in main.json and settings.json.
     * @inner
     * @private
     * @param {string} timezone - IANA timezone string (e.g. 'Europe/Paris')
     */
    var setTimezone = function(timezone) {
        // save to ~/.gina/main.json
        mainConf['def_timezone'][GINA_SHORT_VERSION] = timezone;
        lib.generator.createFileFromDataSync(mainConf, mainConfPath);
        // save to ~/.gina/{GINA_VERSION_SHORT}/settings.json
        process['gina']['timezone'] = timezone;
        mainSettingsConf['timezone'] = timezone;
        lib.generator.createFileFromDataSync(mainSettingsConf, mainSettingsPath);
    }

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
}
module.exports = Set;