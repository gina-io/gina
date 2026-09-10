'use strict';
/**
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
// Imports
var fs                  = require('fs');
var util                = require('util');
var promisify           = util.promisify;
const { EventEmitter }  = require('events');

var frameworkPath       = __dirname +'/../../../../..';

/**
 * Built-in ANSI color styles — replaces the `colors` npm package.
 *
 * Only the styles actually used by logger levels are included:
 * magenta, red, yellow, black, cyan, gray. All close with code 39
 * (default foreground). Additional styles are provided for completeness
 * so that `setColors()` can copy them if external code references them.
 *
 * @constant {Object} colors
 * @inner
 */
var colors = {
    styles: {
        // Modifiers
        reset:     { open: '\x1b[0m',  close: '\x1b[0m'  },
        bold:      { open: '\x1b[1m',  close: '\x1b[22m' },
        dim:       { open: '\x1b[2m',  close: '\x1b[22m' },
        italic:    { open: '\x1b[3m',  close: '\x1b[23m' },
        underline: { open: '\x1b[4m',  close: '\x1b[24m' },
        inverse:   { open: '\x1b[7m',  close: '\x1b[27m' },
        hidden:    { open: '\x1b[8m',  close: '\x1b[28m' },
        strikethrough: { open: '\x1b[9m', close: '\x1b[29m' },
        // Foreground colors
        black:     { open: '\x1b[30m', close: '\x1b[39m' },
        red:       { open: '\x1b[31m', close: '\x1b[39m' },
        green:     { open: '\x1b[32m', close: '\x1b[39m' },
        yellow:    { open: '\x1b[33m', close: '\x1b[39m' },
        blue:      { open: '\x1b[34m', close: '\x1b[39m' },
        magenta:   { open: '\x1b[35m', close: '\x1b[39m' },
        cyan:      { open: '\x1b[36m', close: '\x1b[39m' },
        white:     { open: '\x1b[37m', close: '\x1b[39m' },
        gray:      { open: '\x1b[90m', close: '\x1b[39m' },
        grey:      { open: '\x1b[90m', close: '\x1b[39m' },
        // Background colors
        bgBlack:   { open: '\x1b[40m', close: '\x1b[49m' },
        bgRed:     { open: '\x1b[41m', close: '\x1b[49m' },
        bgGreen:   { open: '\x1b[42m', close: '\x1b[49m' },
        bgYellow:  { open: '\x1b[43m', close: '\x1b[49m' },
        bgBlue:    { open: '\x1b[44m', close: '\x1b[49m' },
        bgMagenta: { open: '\x1b[45m', close: '\x1b[49m' },
        bgCyan:    { open: '\x1b[46m', close: '\x1b[49m' },
        bgWhite:   { open: '\x1b[47m', close: '\x1b[49m' }
    }
};

var merge           = require('../../merge');
var inherits        = require('../../inherits');
var helpers         = require('../../../helpers');
// #B433 — pre-render log redaction engine (pure, dependency-free). Applied at
// emit() — the single point where every levelled message exists as a string
// before any sink renders it — and on the raw `self.log` path.
var redact          = require('./redact');

/**
 * Is `value` an Error — including one minted in another realm (a `vm`
 * context, a worker's transferred error), which `instanceof Error` misses?
 *
 * #B434 — both stdout writers used to route any `instanceof Object` argument
 * through a property walk that sees ENUMERABLE own props only; an Error's
 * `message` and `stack` are non-enumerable, so a bare Error rendered as `{}`.
 *
 * @private
 * @param {*} value
 * @returns {boolean}
 */
var isError = function(value) {
    return value instanceof Error || util.types.isNativeError(value);
};

/**
 * Render an Error the way Node's own `console.error` does: the stack, then any
 * enumerable own props, then the `cause` chain / `AggregateError` members.
 *
 * @private
 * @param {Error} err
 * @returns {string} A (usually multi-line) description
 *
 * @example
 * var err = new Error('boom'); err.code = 'E_BOOM';
 * inspectError(err);
 * // 'Error: boom\n    at …stack frames… {\n  code: \'E_BOOM\'\n}'
 */
var inspectError = function(err) {
    return util.inspect(err);
};

/**
 * `JSON.stringify` replacer for the raw `console.log` path: an Error nested
 * inside a logged object is rendered through `inspectError()` instead of
 * collapsing to `{}`. Every other value passes through untouched.
 *
 * @private
 * @param {string} key
 * @param {*} value
 * @returns {*}
 */
var errorReplacer = function(key, value) {
    return isError(value) ? inspectError(value) : value;
};

// #M22 — merge-eval fallback removed; the circular chain that produced a partial merge was broken at the merge.js side (direct require of utils/prototypes.json_clone instead of helpers/index.js's for-loop loader, which transitively required lib/logger).
// BO - publishing hack
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
 * @memberof module:lib
 * @namesame gina.lib.logger
 * @author Rhinostone <contact@gina.io>
 *
 * @api Public
 * */
function Logger() {


    // retrieve context
    var ctx = getContext('loggerInstance') || { initialized: false }; // jshint ignore:line
    // #B433 — redaction state lives on the persisted context, never on a group's
    // options: the level closures of every group (built once, kept in
    // ctx._loggers) close over the FIRST module instance's emit(), and a merged
    // process shares one logger for every bundle — so the state must be
    // process-wide and must survive a lib/logger re-require. `blocks`/`secrets`
    // are keyed by bundle (group) so a bundle's config reload replaces its own
    // contribution; `state` is the compiled union handed to redact.apply().
    if ( typeof(ctx._redact) == 'undefined' ) {
        ctx._redact = { blocks: {}, secrets: {}, state: null };
    }

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

        // Validate hierarchy at init time — same guard used by setLevel(), but applied here so that
        // setting LOG_LEVEL to a level name that has no hierarchy entry (e.g. 'notice', 'alert',
        // 'crit', 'warning') does not cause `undefined.indexOf()` TypeErrors that silently swallow
        // all log output. setLevel() already catches this at runtime; this closes the init-time gap.
        if ( typeof(opt.hierarchies[opt.hierarchy]) == 'undefined' ) {
            process.stdout.write('gina: `' + opt.hierarchy + '` is not a valid log hierarchy: switching to `info`\n');
            opt.hierarchy = 'info';
            process.env.LOG_LEVEL = 'info';
        }

        // #K8s3 — stdout-only mode for containers.
        // When GINA_LOG_STDOUT=true the MQ transport is skipped: there is no MQ listener
        // in a containerised deployment and the TCP connection attempt would produce noise.
        // The default container already writes to process.stdout; it switches to JSON lines
        // in this mode so that log collectors (kubectl logs, Fluentd, Datadog, etc.) can parse output.
        if (/^true$/i.test(process.env.GINA_LOG_STDOUT)) {
            let mqIdx = opt.flows.indexOf('mq');
            if (mqIdx > -1) opt.flows.splice(mqIdx, 1);
        }

        // #M12 — structured (JSON) logging opt-in. The active render format is resolved
        // ONCE here, before loadContainers() clones `opt` into each container, so a
        // container reads `opt.format` instead of re-testing the environment. Precedence:
        //   1. GINA_LOG_FORMAT = json|text  (explicit; works outside container mode)
        //   2. GINA_LOG_STDOUT truthy => json (back-compat alias for the #K8s3 flag)
        //   3. default 'text' — the coloured, human-readable output (unchanged).
        // Keeping the default at 'text' means interactive consumers (docker / OrbStack
        // `docker logs`, a dev terminal) see exactly the same output as before.
        if ( /^json$/i.test(process.env.GINA_LOG_FORMAT) ) {
            opt.format = 'json';
        } else if ( /^text$/i.test(process.env.GINA_LOG_FORMAT) ) {
            opt.format = 'text';
        } else if ( /^true$/i.test(process.env.GINA_LOG_STDOUT) ) {
            opt.format = 'json';
        } else {
            opt.format = 'text';
        }

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
                // #SCS1 (2026-04-23) — replaced `new Function(...)` dynamic method build with a
                //                       closure factory so Socket no longer flags `Uses eval` on
                //                       the server side. `write`, `parse`, `emit` are now captured
                //                       by reference (they were previously stringified via
                //                       `toString()` and embedded as literals into the generated
                //                       function body). `setDefaultLevels` is called fresh on every
                //                       `setLevel`, so methods still reflect the latest options.
                // override if existing
                // logger[l] = new Function('return '+ write +'('+ JSON.stringify(loggerOptions) +', '+ parse +', "'+ l +'", arguments, '+  emit +');');// jshint ignore:line
                logger[l] = function() {
                    return write(loggerOptions, parse, l, arguments, emit);
                };
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
            else if (isError(args[i])) {
                // #B434 — before the Object branch: parse() would only see the
                // enumerable own props and drop the message and stack
                content += inspectError(args[i]) + ' '
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

        // #B433 — redact BEFORE the envelope is minted: one pass per message
        // (not per flow), and the marker lands inside `content`, so the JSON
        // rendered downstream by the default container cannot be corrupted.
        if ( ctx._redact && ctx._redact.state ) {
            content = redact.apply(ctx._redact.state, content);
        }

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
            if (isError(obj[attr])) {
                // #B434 — a nested Error keeps its message and stack (it used to
                // recurse into an enumerable-props walk and render as `{}`)
                str += (isArray ? '' : '"'+attr+'": ') + inspectError(obj[attr]);
                str += (l<len) ? ', ' : '';
            } else if (obj[attr] instanceof Function) {
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
     * @returns {void}
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

    /**
     * <console>.setRedaction — #B433
     *
     * Install (or replace) one bundle's contribution to the process-wide log
     * redaction: its `settings.json > log.redact` block plus the secret values
     * the secrets resolver substituted for it. The effective rule set is the
     * UNION of every installed bundle (a merged process shares this logger),
     * recompiled on every call, and applied to every message at `emit()` and on
     * the raw `console.log` path before any sink renders it.
     *
     * Called by `core/config.js` at config load, right after the bundle's
     * `${secret:KEY}` placeholders are resolved. Throws on an invalid block so
     * the boot refuses instead of dropping a pattern silently.
     *
     * @param {object} [block] - The `log.redact` object (absent = defaults on)
     * @param {object} [options]
     * @param {string} [options.group='gina'] - The bundle this contribution belongs to
     * @param {Array<{path: string, value: *}>} [options.secrets] - Resolved secrets (`lib.secrets.getResolvedValues()`)
     * @returns {{enabled: boolean, rules: number, secrets: number, skippedSecrets: string[]}}
     *   What is now effective, plus the config paths of secrets too short to redact
     * @throws {Error} When the block is malformed (unknown key, non-boolean flag,
     *   invalid or empty-matching pattern)
     *
     * @example
     * var summary = console.setRedaction({ patterns: ['(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])'] }, { group: 'api@myproject' });
     * // summary → { enabled: true, rules: 7, secrets: 0, skippedSecrets: [] }
     * console.setRedaction({ enabled: false }, { group: 'api@myproject' }); // this bundle opts out
     */
    self.setRedaction = function(block, options) {
        options = options || {};
        var group = ( typeof(options.group) == 'string' && options.group.length > 0 ) ? options.group : 'gina';
        // compileBlock throws on a malformed block — nothing is installed in that case
        var compiled = redact.compileBlock(block, group);
        var parts    = redact.partitionSecrets(compiled.secrets ? options.secrets : []);

        ctx._redact.blocks[group]  = compiled;
        ctx._redact.secrets[group] = parts.values;

        var blocks = [], values = [];
        for (var g in ctx._redact.blocks) {
            blocks.push(ctx._redact.blocks[g]);
            values = values.concat(ctx._redact.secrets[g] || []);
        }
        ctx._redact.state = redact.compileState(blocks, values);

        return {
            enabled        : !!ctx._redact.state,
            rules          : ctx._redact.state ? ctx._redact.state.rules.length : 0,
            secrets        : ctx._redact.state ? ctx._redact.state.secretCount : 0,
            skippedSecrets : parts.skipped,
            minSecretLength: redact.MIN_SECRET_LENGTH
        };
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

            if (isError(args[i])) {
                // #B434 — JSON.stringify(new Error()) is `{}`: message and stack are non-enumerable
                content += inspectError(args[i]);
            } else if (args[i] instanceof Object) {
                //console.log("\n...", args[i], args[i].toString());
                content += JSON.stringify(args[i], errorReplacer, '\t');
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

            // #B433 — the raw path bypasses emit(), so it redacts on its own.
            // Every URL-bearing framework site is levelled (measured: 0 of 46
            // use console.log), so this is belt-and-braces for application code.
            if ( ctx._redact && ctx._redact.state ) {
                content = redact.apply(ctx._redact.state, content);
            }

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

            // #M12 — honour the structured (JSON) render mode for the raw console.log
            // path, which writes straight to stdout and bypasses the container dispatch.
            // Without this, JSON mode would emit a mix of JSON lines (levelled output) and
            // plain lines (console.log), breaking a log collector. Text mode is unchanged.
            if ( opt.format === 'json' ) {
                var _jsonLine = {
                    ts     : new Date().toISOString(),
                    level  : 'info',
                    bundle : opt.name,
                    message: content,
                    group  : opt.name,
                    msg    : content
                };
                // #M12b — stamp the per-request id + elapsed-ms when a request context is
                // active (process.gina._reqALS). Absent for CLI / boot / off-request logs.
                if (process.gina && process.gina._reqALS) {
                    var _reqStore = process.gina._reqALS.getStore();
                    if (_reqStore) {
                        _jsonLine.requestId  = _reqStore.requestId;
                        _jsonLine.durationMs = Date.now() - _reqStore.startMs;
                    }
                }
                process.stdout.write(JSON.stringify(_jsonLine) + '\n');
            } else {
                process.stdout.write(content + '\n');
            }
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
