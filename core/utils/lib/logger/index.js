/**
 * This file is part of the gina package.
 * Copyright (c) 2016 Rhinostone <gina@rhinostone.com>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
//'use strict';

// Imports
var util = require('util');
var merge = require('../merge');

/**
 * @class Logger
 *
 * @package gina.lib
 * @namesame gina.lib.logger
 * @author Rhinostone <gina@rhinostone.com>
 *
 * @api Public
 * */
function Logger(opt) {
    var self = {};

    var defaultOptions = {
        name: 'gina', // by default
        template: '%d [ %s ] %m',
        //containers: [],
        levels : { // based on Sylog Severity Levels
            emerg: {
                code: 0,
                label: 'Emergency',
                desciption: 'System is unusable.',
                color: 'red'
            },
            alert: {
                code: 1,
                label: 'Alert',
                desciption: 'Action must be taken immediately.',
                color:'red'
            },

            crit: {
                code: 2,
                label: 'Critical',
                desciption: 'Critical conditions.',
                color: 'red'
            },
            error : {
                code: 3,
                label: 'Error',
                desciption: 'Error conditions.',
                color : 'orange'
            },
            warn : {
                code: 4,
                label: 'Warning',
                desciption: 'Warning conditions.',
                color: 'yellow'
            },
            notice: {
                code: 5,
                label: 'Notice',
                desciption: 'Normal but significant condition.',
                color: 'yellow'
            },
            info : {
                code: 6,
                label: 'Informational',
                desciption: 'Informational messages.',
                color: 'blue'
            },
            debug : {
                code: 7,
                label: 'Debug',
                desciption: 'Debug-level messages.',
                color: 'cyan'
                //'format' : '',
                //'pipe' : []
            }

        }
    };

    if (opt) {
        opt = merge(defaultOptions, opt, true)
    } else {
        opt = defaultOptions
    }

    /**
     * init
     * @constructor
     * */
    var init = function(opt) {
        if ( typeof(Logger.initialized) != "undefined" ) {
            console.debug("Logger instance already exists. Loading it.");
            return getInstance(opt)
        } else {
            Logger.initialized = true;
            Logger.instance = self;
            setDefaultLevels();
        }
    }

    var getInstance = function(opt) {
        return Logger.instance
    }

    var setDefaultLevels = function() {

        for (var l in opt.levels) {
            if ( typeof(self[l]) != 'undefined' )
                delete self[l];

            //self[l] = new Function('return '+write+'('+JSON.stringify(opt)+', '+parse+', "'+l+'", arguments);');
            self[l] = new Function('this._log_printed = false; process.stdout.write('+write+'('+JSON.stringify(opt)+', '+parse+', "'+l+'", arguments));');
        }
    }

    var write = function(opt, parse, s, args) {

        if ( /^(debugger listening on port)/.test(args[0])
            && typeof(opt.levels.info) != 'undefined'
        ) {
            s = 'info'
        }
        //process.stdout.write('\n'+ "LOGGER ACTION ? "+ s + ": ("+args.length+") ["+ args[0]+ "]");
        var content = '';
        //To handle logs with coma separated arguments.
        for (var i=0; i<args.length; ++i) {
            if (args[i] instanceof Function) {
                content += args[i].toString() + ''
            } else if (args[i] instanceof Object) {
                // careful, [ parse ] will be out of the main execution context: passing it for recursive use
                content += parse(parse, args[i], '')
            } else {
                //if ( args[i].replace(/\s/g, '') != '')
                //process.stdout.write('\n'+ ("=>> [" + args[i] + "]"));
                content += args[i] + ' '
            }
        }

        if (content != '' && !this._log_printed) {
            var now = new Date();
            var repl = {
                '%s': s, //severity
                '%d': now, // timestamp
                '%m': content // message
                //'%container', //container
            };

            var patt = opt.template.match(/\%[a-z A-Z 0-9]/g);
            content = opt.template;
            for(var p=0; p<patt.length; ++p) {
                content = content.replace(new RegExp(patt[p], 'g'), repl[patt[p]]);
            }

            //return process.stdout.write('\n'+ content)
            this._log_printed = true;
            return '\n'+ content
        }

        this._log_printed = false;
        return content
    }

    var parse = function(parse, obj, str) {
        var l = 0
            , len = obj.count()
            , isArray = (obj instanceof Array) ? true : false;
        str += (isArray) ? '[ ' : '{';

        for (var attr in obj) {
            ++l;
            if (obj[attr] instanceof Function) {
                str += attr +': [Function]';
                // if you want ot have it all replace by the fllowing line
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
        return str + ' '
    }

//    /**
//     * Add or override existing level(s)
//     * @param {object} levels
//     * */
//    this.addLevel = function(levels) {
//        for (var l in levels) {
//            self[l] = new Function('return '+write+'('+JSON.stringify(opt)+', "'+l+'", arguments);');
//        }
//    }

    self.setLevels = function(levels) {
        try {
            //remove default.
            for (var l in opt.levels) {
                delete self[l]
            }


            for (var l in levels) {
                self[l] = new Function('return '+write+'('+JSON.stringify(opt)+', '+parse+', "'+l+'", arguments);');
            }
        } catch(e) {
            setDefaultLevels();
            self.error('Cannot set type: ', e.stack|| e.message)
        }
    }

    self.getLogger = function(details) {
        console.debug('getting logger')
    }

    self.log = function() {
        var args = arguments, content = '';
        //console.log("arg: ", args);
        //To handle logs with coma speparated arguments.
        for (var i=0; i<args.length; ++i) {

            if (args[i] instanceof Object) {
                //console.log("\n...", args[i], args[i].toString());
                content += JSON.stringify(args[i], null, '\t')
            } else {
                content += args[i]
            }
        }
        //process.stdout.write('\n'+ "hum ? "+ content);
        //console.log("hum ? ", content);
        if (content != '')
            process.stdout.write('\n'+ content)
    }


    init(opt);
    return self
};


module.exports = Logger()
