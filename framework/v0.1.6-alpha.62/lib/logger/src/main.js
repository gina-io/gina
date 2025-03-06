'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2023 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
// Imports
var fs                  = require('fs');
var util                = require('util');
var promisify           = util.promisify;
const { EventEmitter }  = require('events');

// During initial pre-install & post-install, `colors` might not be installed !
var colors              = null;
var frameworkPath       = __dirname +'/../../../../..';
// var frameworkVersion    = require(frameworkPath + '/package.json').version;
try {
    colors = require('colors') || require(frameworkPath +'/node_modules/colors');
} catch (err) {
    // colors not found
    // It is ok, since this case is handled by the `pre-install` script
    throw err
}

var merge           = require('../../merge');
var inherits        = require('../../inherits');
var helpers         = require('../../../helpers');

// BO - publishing hack
if ( typeof(merge) != 'function' ) {
    // if needed for unit tests
    merge = eval(fs.readFileSync(__dirname +'/../../merge/src/main.js').toString())
}
if ( typeof(JSON.clone) == 'undefined' ) {
    require(__dirname +'/../../../helpers/prototypes')()
}
if ( typeof(_) == 'undefined' ) {
    require(__dirname +'/../../../helpers/path')()
}
if ( typeof(requireJSON) == 'undefined' ) {
    require(__dirname +'/../../../helpers/json')()
}
if ( typeof(getContext) == 'undefined' ) {
    require(__dirname +'/../../../helpers/context')()
}
// EO - publishing hack


/**
 * @class Logger
 *
 * @package gina.lib
 * @namesame gina.lib.logger
 * @author Rhinostone <contact@gina.io>
 *
 * @api Public
 * */
function Logger() {


    // retrieve context
    var ctx = getContext('loggerInstance') || { initialized: false }; // jshint ignore:line

    var self            = {}
        , loggers       = {}
        // `containers`, also meaning transports
        , containers    = {}
        // for `getInstance()`
        , opt           = ctx._options || {}
    ;

    // only used for defaultOption init
    var homeDir             = null
        // user options
        , userOptions       = ctx._userOptions || null
        , flowsOptions      = ctx._flowsOptions || {}
        , shortVersion      = null
        , defaultLogLevel   = null
    ;
    try {
        homeDir = getUserHome() || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];// jshint ignore:line
        homeDir += '/.gina';
        shortVersion = requireJSON( _(frameworkPath +'/package.json', true) ).version;// jshint ignore:line
        shortVersion = shortVersion.split('.').splice(0,2).join('.').replace(/^v/, '');
        if ( new _(homeDir +'/'+ shortVersion +'/settings.json', true).existsSync() ) {
            defaultLogLevel = requireJSON( _(homeDir +'/'+ shortVersion +'/settings.json', true) ).log_level;// jshint ignore:line
        } else {
            defaultLogLevel = 'info'
        }

    } catch(logLevelError) {
        // It is ok to fail  ... do not worry
    }


    var defaultOptions = ctx._defaultOptions || {
        // Group name by default: it is usually the application or the service PROC.title
        name: 'gina',
        template: '[%d] [%s][%a] %m',

        // Where the events flow will be dispatched - e.g.: event.on('logger#<container_name>', function(appName, code, severityLevel, content){ ... })
        // A `flow` is binded to related container
        //      `default` is `process.stdout`
        //      `mq` is for message dispatching: from speakers to the main listener
        // A flow name is always the same as the container/transport name: checkout the `containers` folder for more
        // Don't touch this part!
        flows: ['default', 'mq'],
        // Levels are based on Syslog: https://en.wikipedia.org/wiki/Syslog
        levels : {
            // will also kill the process
            emerg: {
                code: 0,
                label: 'Emergency',
                description: 'System is unusable.',
                color: 'magenta'
            },
            // Only used to send email or trigger a push to an alert system
            alert: {
                code: 1,
                label: 'Alert',
                description: 'Action must be taken immediately.',
                color:'red'
            },

            crit: {
                code: 2,
                label: 'Critical',
                description: 'Critical conditions.',
                color: 'magenta'
            },
            // deprecated
            error : {
                code: 3,
                label: 'Error',
                description: 'Error conditions.',
                color : 'red',
                deprecated: 'Use `console.err` instead'
            },
            err : {
                code: 3,
                label: 'Error',
                description: 'Error conditions.',
                color : 'red'
            },
            // deprecated
            warn : {
                code: 4,
                label: 'Warning',
                description: 'Warning conditions.',
                color: 'yellow',
                deprecated: 'Use `console.warning` instead'
            },
            warning : {
                code: 4,
                label: 'Warning',
                description: 'Warning conditions.',
                color: 'yellow'
            },
            // notice is use in the framework to raise flags that can be picked-up by child processes (CLI, Bundle, Workers)
            notice: {
                code: 5,
                label: 'Notice',
                description: 'Normal but significant condition.',
                color: 'black'
            },
            info : {
                code: 6,
                label: 'Informational',
                description: 'Informational messages.',
                color: 'cyan'
            },
            debug : {
                code: 7,
                label: 'Debug',
                description: 'Debug-level messages.',
                color: 'gray'
            },
            // hidden level
            catch : {
                code: -1,
                label: 'Catch',
                description: 'Unhandled or already formated messages.',
                color: 'gray'
            }
        },
        // logging hierarchy
        // Descriptions from https://sematext.com/blog/logging-levels/
        // start with the app log_level, then gina log_level, and if nothing is found, set it by default to info
        // eg.:
        // [ From the CLI ]
        // $ gina set --log-level=trace
        // This will apply for the framework, and will be inherited for all bundles unless you ovveride it in your application/bundle code
        // ----
        // [ Inside your code ]
        // var lib      = require('gina').lib;
        // var console  = lib.logger;
        // console.setLevel('trace', bundleName) - Put that in the bundle bootstrap
        hierarchy: process.env.LOG_LEVEL || defaultLogLevel || 'info', // by default: info
        hierarchies: {
            /**
             * TRACE
             * The most fine-grained information only used in rare cases where you need the full visibility
             * of what is happening in your application and inside the third-party libraries that you use.
             * Expect the TRACE logging level to be very verbose
             */
            trace: [0,1,2,3,4,5,6,7], // we want it all
            /**
             * DEBUG
             * Should be used for information that may be needed for diagnosing issues and troubleshooting
             * or when running application in the test environment
             */
            debug: [0,1,2,3,4,5,6,7],
            /**
             * INFO
             * The standard log level indicating that something happened.
             * Should be purely informative and not looking into them on a regular basis shouldn’t result in
             * missing any important information.
             */
            info: [0,1,2,3,4,5,6],
            /**
             * WARN
             * Indicates that something unexpected happened in the application, a problem, or a situation that might
             * disturb one of the processes. But that doesn’t mean that the application failed.
             */
            warn: [0,1,2,3,4,5],
            /**
             * ERROR
             * Should be used when the application hits an issue preventing one or more functionalities from properly
             * functioning.
             */
            error: [0,1,2,3,5],
            /**
             * FATAL
             * Tells that the application encountered an event or entered a state in which one of the
             * crucial business functionality is no longer working.
             */
            fatal: [0,1,2,5]
            /**
             * OFF
             * Simple enough. NO LOGGING !!
             */
            //off: [5]
        },
        isReporting: true,
        isFlushing: false
    };

    var getInstance = function() {
        self    = ctx.instance;
        loggers = ctx._loggers;
        // opt = ctx._options;

        return self;
    }

    /**
     * init
     * @constructor
     * */
    var init = function(opt) {


        if ( typeof(ctx.initialized) != 'undefined' && ctx.initialized == true) {
            getInstance();
            // process.env.NODE_ENV
            if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels['debug'].code) > -1) {
                emit(opt, 'debug', '`'+ opt.name +' `Logger instance already exists: reusing it ;)');
            }

            return self;
        }
        ctx.initialized = true;
        if (!homeDir) {
            homeDir =  ( typeof(getUserHome) != 'undefined' ) ? getUserHome() : process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];// jshint ignore:line
            homeDir += '/.gina';
        }
        // user main options & flows options
        var extPath = _(homeDir +'/user/extensions/logger', true)
        var optionsPath = _(extPath +'/default/config.json', true);
        if ( new _(optionsPath).existsSync() ) {
            userOptions = requireJSON(optionsPath);// jshint ignore:line
            if (userOptions.flows && userOptions.flows.length > 0) {
                if (userOptions.flows.indexOf('default') > -1) {
                    userOptions.flows.splice(userOptions.flows.indexOf('default'), 1)
                }
                if (userOptions.flows.indexOf('mq') > -1) {
                    userOptions.flows.splice(userOptions.flows.indexOf('mq'), 1)
                }
                if (userOptions.flows.length > 0) {
                    for (let i = 0, len = userOptions.flows.length; i < len; i++) {
                        let flowName = userOptions.flows[i];
                        if ( new _(extPath +'/'+ flowName +'/config.json', true).existsSync() ) {
                            let flowOpt = requireJSON(_(extPath +'/'+ flowName +'/config.json', true));// jshint ignore:line
                            flowsOptions[flowName] = flowOpt;
                        }
                    }
                }
            }
        }
        // setting up `opt`
        // this is done to repespect arrays order
        var newDefaultOptions = merge(JSON.clone(defaultOptions), userOptions);
        // var newDefaultOptions = merge(defaultOptions, userOptions);

        defaultOptions = JSON.clone(newDefaultOptions);
        newDefaultOptions = null;
        if (userOptions && userOptions.flows) {
            delete userOptions.flows;
        }

        opt = merge(userOptions, defaultOptions);
        // if ( new _(optionsPath).existsSync() ) {
        //     if (userOptions.flows.indexOf('mq') < 0) {
        //         userOptions.flows.splice(0, 0, 'mq')
        //     }
        //     if (userOptions.flows.indexOf('default') < 0) {
        //         userOptions.flows.splice(0, 0, 'default')
        //     }
        // }

        // if (opt) {
        //     opt = merge(options, JSON.clone(defaultOptions), opt, true)
        // } else {
        //     //opt = ( typeof(ctx.instance) != 'undefined' && typeof(ctx.instance._options) != 'undefined' ) ? ctx.instance._options : defaultOptions;
        //     opt = JSON.clone(defaultOptions)
        // }

        if ( typeof(opt.name) == 'undefined' || /^gina\-/.test(opt.name) ) {
            opt.name = 'gina'
        }

        if ( typeof(loggers[opt.name]) == 'undefined' ) {
            // defining default prototypes
            loggers[opt.name] = {}
        }
        loggers[opt.name]._options = opt;



        // setup default group, colors
        setupNewGroup(opt.name, opt);

        for (let l in opt.levels) {
            // don't override here since it is generic
            if ( typeof(self[l]) == 'undefined' ) {
                self[l] = function(){// jshint ignore:line

                    let group = opt.name || defaultOptions.name; // by default
                    if ( process.title != 'node' && !/(\\|\/)*node$/.test(process.title) ) {
                        group = process.title.replace(/^gina\:\s*/, '');
                        if ( typeof(group) == 'undefined' || /^gina\-/.test(group) ) {
                            group = 'gina'
                        }
                    }

                    //self.log('--> '+ group + ' '+ process.env.LOG_GROUP +' '+ process.title);
                    if ( typeof(loggers[group]) == 'undefined' ) {
                        setupNewGroup(group)
                    }
                    loggers[group][l].apply(self[l], arguments)
                }
            }
        }


        // TODO - load container/flow if !== `default`
        try {
            // only afer this, we can send logs to containers/transports
            loadContainers(opt, flowsOptions);
        } catch (err) {
            throw err;
        }


        // backing up context
        ctx.instance        = self;
        ctx._options        = opt;
        ctx._defaultOptions = defaultOptions;
        ctx._flowsOptions   = flowsOptions;
        ctx._loggers        = loggers;
        setContext('loggerInstance', ctx);// jshint ignore:line

        if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels['debug'].code) > -1) {
            emit(opt, 'debug', 'New Logger instance created');
        }

        return self;
    }



    var loadContainers = function(opt, flowsOptions) {
        var containersPath = _(__dirname +'/containers', true);// jshint ignore:line
        for (let i=0, len=opt.flows.length; i<len; i++) {
            let flow = opt.flows[i];
            let loggerOptions = JSON.clone(opt);
            if ( typeof(containers[flow]) == 'undefined' ) {
                if ( typeof(flowsOptions[flow]) != 'undefined' ) {
                    loggerOptions = merge(loggerOptions, flowsOptions[flow], true);
                }
                containers[flow] = require( _(containersPath +'/'+ flow, true))(loggerOptions, loggers);// jshint ignore:line
            }
        }
    }

    /**
     *
     *
     * @param {string} group
     * @param {object} [opt]
     */
    var setupNewGroup = function(group, opt) {
        if ( typeof(loggers[group]) == 'undefined' ) {
            loggers[group] = {};
        }

        if (!opt) {
            opt = ctx._options || JSON.clone(defaultOptions)
        }
        loggers[group]._options = opt;

        // lock group name
        loggers[group]._options.name = group;

        // setup colors
        setColors(group);

        //setup default levels for the group
        setDefaultLevels(group);
    }

    var setColors = function(group) {
        // using colors module, but we can add support for other modules
        if (colors) {
            var _colors = {};
            for (let k in colors.styles) {
                _colors[k] = {};
                for (let i in colors.styles[k]) {
                    _colors[k][i] = colors.styles[k][i]
                }
            }
            loggers[group].colors = JSON.clone(_colors);
        }
    }



    var setDefaultLevels = function(group) {

        var loggerOptions = loggers[group]._options || ctx._options || JSON.clone(defaultOptions);
        var logger = loggers[group];
        try {

            //console.log('colors ----> ', colors);
            // setting default level string length
            loggerOptions._maxLevelLen = loggerOptions._maxLevelLen || 0;
            if (!loggerOptions._maxLevelLen) {
                for (let l in loggerOptions.levels) {
                    if (l.length > loggerOptions._maxLevelLen) {
                        loggerOptions._maxLevelLen = l.length;
                    }
                }
            }

            for (let l in loggerOptions.levels) {
                // override if existing
                logger[l] = new Function('return '+ write +'('+ JSON.stringify(loggerOptions) +', '+ parse +', "'+ l +'", arguments, '+  emit +');');// jshint ignore:line
            }

        } catch (err) {
            //process.stdout.write(err.stack + '\n')
            emit(opt, 'error', err.stack);
        }
    }




    var write = function(opt, parse, s, args, cb) {
        // caller is __stack[3]
        //console.log("----->" + __stack.toString().replace(/\,/g, '\n') );
        // console.log("----->" + __stack[3] );
        // if ( /tail\.js/.test(__stack[3]) ) {
        //     return;
        // }

        var content = '';
        // Ignore logs not in hierarchy
        if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels[s].code) < 0) {
            return;
        }

        //To handle logs with coma separated arguments.
        for (let i = 0, iLen = args.length; i < iLen; ++i) {

            if (args[i] instanceof Function) {
                content += args[i].toString() + ""
            }
            else if (args[i] instanceof Object) {
                // careful, [ parse ] will be out of the main execution context: passing it for recursive use
                content += parse(parse, args[i], "")
            }
            else {

                if ( /(?:\\[rnt]|[\r\n\t])/.test(args[i]) ) { // special replacement for mixed string
                    args[i] = args[i]
                        .replace(/(?:\\[rn]|[\r\n])/gm, String.fromCharCode('10')) // \r 10, but should be 13, but will be 10 because of the terminal
                        .replace(/(?:\\[t]|[\t])/gm, String.fromCharCode('09'))
                    ;
                    /**
                     *  Oct   Dec   Hex   Char
                    *  ─────────────────────────────────────────────
                    *  000   0     00    NUL '\0'
                    *  001   1     01    SOH (start of heading)
                    *  002   2     02    STX (start of text)
                    *  003   3     03    ETX (end of text)
                    *  004   4     04    EOT (end of transmission)
                    *  005   5     05    ENQ (enquiry)
                    *  006   6     06    ACK (acknowledge)
                    *  007   7     07    BEL '\a' (bell)
                    *  010   8     08    BS  '\b' (backspace)
                    *  011   9     09    HT  '\t' (horizontal tab)
                    *  012   10    0A    LF  '\n' (new line)
                    *  013   11    0B    VT  '\v' (vertical tab)
                    *  014   12    0C    FF  '\f' (form feed)
                    *  015   13    0D    CR  '\r' (carriage ret)
                    */

                }

                content += args[i] + ' '
            }
        }


        if (content != '') {
            //process.stdout.write('FLOW: '+ opt.flows + '\n');
            // Forwarding flow to containers
            if (s == 'catch') {
                cb(opt, s, content, true);
                return;
            }
            cb(opt, s, content);
        }
    }
    // Forwarding flow to containers
    var emit = function(opt, severity, content, skipFormating) {

        skipFormating = (typeof(skipFormating) != 'undefined' && /true/i.test(skipFormating)) ? true : false;
        // Sample of a payload
        // process.emit('logger#default', JSON.stringify({
        //     group   : group,
        //     level   : severity,
        //     content : content
        // }));
        for (let i=0, len=opt.flows.length; i<len; i++) {
            let container = opt.flows[i];
            process.emit('logger#'+container, JSON.stringify({
                group       : opt.name,
                level       : severity,
                // Raw content !
                content     : content,
                skipFormating: skipFormating
            }));
        }
    }

    var parse = function(parse, obj, str) {

        var l           = 0
            , len       = obj.count()
            , isArray   = (obj instanceof Array) ? true : false
        ;
        str += (isArray) ? '[ ' : '{';


        for (var attr in obj) {
            ++l;
            if (obj[attr] instanceof Function) {
                str += attr +': [Function]';
                // if you want ot have it all replace by the following line
                //str += attr +':'+ obj[attr].toString();
                str += (l<len) ? ', ' : ''
            } else if (obj[attr] instanceof Object && !isArray) {
                str += '"'+attr+'": ';
                str = parse(parse, obj[attr], str);
                str += (l<len) ? ', ' : '';
            } else {
                if (!isArray && typeof(obj[attr]) == 'string') {
                    str += '"'+attr+'": "' + obj[attr]
                            .replace(/\'/g, "\\'")
                            .replace(/\"/g, '\\"') +'"';
                } else if (isArray) {
                    str += ( typeof(obj[attr]) != 'string' ) ? obj[attr] : '"'+ obj[attr] +'"'
                } else {
                    str += '"'+attr+'": ' + obj[attr]
                }
                str += (l<len) ? ', ' : ''
            }

        }

        str += (isArray) ? ' ]' : '}';
        return str + ' ';
    }

    self.getOptions = function() {
        var loggerOptions = null, opt = ctx._options;
        for (let i=0, len=opt.flows.length; i<len; i++) {
            let flow = opt.flows[i];
            loggerOptions = JSON.clone(opt);
            if ( typeof(ctx._flowsOptions[flow]) != 'undefined' ) {
                loggerOptions = merge(loggerOptions, ctx._flowsOptions[flow], true);// jshint ignore:line
            }
        }
        return loggerOptions
    }

    self.getLoggers = function() {
        return ctx._loggers
    }

//    /**
//     * Add or override existing level(s)
//     * @param {object} levels
//     * */
//    self.addLevel = function(levels) {
//        for (var l in levels) {
//            self[l] = new Function('return '+write+'('+JSON.stringify(opt)+', "'+l+'", arguments);');
//        }
//    }

    /**
     * <console>.setLevel
     * Define a level for a given application
     *
     * @param {string} level hierarchy
     * @param {string} group - existing application or service
     * @returns
     */
    self.setLevel = function(level, group) {
        if ( typeof(group) == 'undefined' || /^gina\-/.test(group) ) {
            group = 'gina'
        }

        var opt = loggers[group]._options;
        level = level.toLowerCase();
        if ( typeof(opt.hierarchies[level]) == 'undefined' ) {
            console.warn('`'+ level +'` is not a valid level: swithcing to `info`');
            level = 'info';
        }

        opt.name = group;
        process.env.LOG_GROUP = group;
        opt.hierarchy = level;
        process.env.LOG_LEVEL = level;

        setColors(group);
        setDefaultLevels(group);


        self.debug('Log level set for `'+ group +'`: '+ level);

        return
    }

    self.pauseReporting = function() {
        loggers[ctx._options.name]._options.isReporting = false;
    }
    self.resumeReporting = function(group) {

        //  [ duplicate output fix ]
        // if (group && loggers[group]._options) {
        //     self.warn('[logger]['+ group +'] now resuming ('+ group +')\n');
        //     loggers[group]._options.isFlushing = false;
        // }

        loggers[ctx._options.name]._options.isReporting = true;



    }

    //  [ duplicate output fix ]
    self.flush = function (group) {
        self.warn('[logger]['+ group +'] now flushing ('+ group +')\n');
        loggers[group]._options.isFlushing = true;
    }



    // Might be overkill ...
    // TODO - <console>.filterLoggerByGroup('myApp')
    // => Should log `myApp` only
    // TODO - <console>.filterLoggerByLevel('warn')
    // Should only log
    // self.filterLogger['ByGroup'] = function(group) {
    //     console.debug('Getting `'+ group +'` logger');
    // }

    self.log = function() {
        var opt = self.getOptions();
        var args = arguments, content = '';

        //To handle logs with coma separated arguments.
        for (let i=0; i<args.length; ++i) {

            if (args[i] instanceof Object) {
                //console.log("\n...", args[i], args[i].toString());
                content += JSON.stringify(args[i], null, '\t');
            } else {
                content += args[i];

                // In case of formated entries - eg.: spawned server that is already returning formated logs
                // if ( /(\[|\[\s+)debug/.test(args[i]) ) {
                //     // args[i] = args[i].replace(/\n$/, '');
                //     // self.debug(args[i].replace(/^.*\[debug.*\]\s+/, '').replace(/\n$/, ''));

                // emit(opt, 'log', content.replace(/\n$/, ''), true);
                // return;

                    // emit(opt, 'debug', content.replace(/\n$/, ''), true);

                    // for (let p=0, pLen=opt.flows.length; p<pLen; p++) {
                    //     let container = opt.flows[p];
                    //     process.emit('logger#'+container, args[i].replace(/\n$/, ''));
                    // }
                //     // process.stdout.write(content);

                    // continue;
                // }
            }
        }

        if (content != '') {

            // intercepte already formated messages
            if ( /^\S\[\d+[m]/.test(content) && /\n$/.test(content) ) {
                emit(opt, 'catch', content, true);
                return;
            }
            // else {
                // for (let i=0, len=opt.flows.length; i<len; i++) {
                //     let container = opt.flows[i];
                //     process.emit('logger#'+container, content);
                // }
            // }

            process.stdout.write(content + '\n');
        }

    };

    return init(opt);
}

module.exports = Logger();
// if ( ( typeof(module) !== 'undefined' ) && module.exports ) {
//     // Publish as node.js module
//     module.exports = Logger();
// } else if ( typeof(define) === 'function' && define.amd) {
//     // Publish as AMD module
//     define( function() { return Logger() });
// }
