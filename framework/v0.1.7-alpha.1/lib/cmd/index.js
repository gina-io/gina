'use strict';
/**
 * Gina.Lib.cmd
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, extend, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
var cmd = {};
// cmd options
cmd.option = [];


/**
 * @module gina/lib/cmd
 */

/**
 * Sets one or more named options on the cmd dispatcher.
 * When `option` is an array, each element must have a `name` and `content` property.
 *
 * @memberof module:gina/lib/cmd
 * @param {Array<{name: string, content: *}>|{name: string, content: *}} option - Option or array of options to register
 */
cmd.setOption = function(option) {
    if (option instanceof Array) {
        for (var i=0; i<option.length; ++i) {
            cmd.option[option[i].name] = option[i].content
        }
    } else {
        cmd.option[options.name] = option.content// jshint ignore:line
    }
}

/**
 * Returns the gina CLI string that was used to invoke the current process,
 * reconstructed from process.argv (replacing the node binary with 'gina').
 *
 * @memberof module:gina/lib/cmd
 * @returns {string} The reconstructed gina command string
 */
cmd.getString = function() {
    var cmd = process.argv
        .toString()
        .replace(/,/g,' ')
        .replace(/node\s/g, 'gina ');
        //.replace(/node/g, 'gina');

    var cmdArr = cmd.split('/');
    cmd = cmdArr[cmdArr.length-1];
    return cmd
}


/**
 * Returns the content of a named option previously registered with setOption.
 *
 * @memberof module:gina/lib/cmd
 * @param {string} name - Option name to retrieve
 * @returns {string|object} The option content, or undefined if not found
 */
cmd.getOption = function(name) {
    return cmd.option[name]
}

/**
 * Returns the full options array.
 *
 * @memberof module:gina/lib/cmd
 * @returns {Array} All registered options
 */
cmd.getOptions = function() {
    return cmd.option
}


/**
 * Main dispatcher called by `bin/cmd` after receiving an argv packet over the socket.
 * Routes to the appropriate framework or bundle command handler based on `opt.task`.
 * For framework 'start' tasks it sets up the Proc master and waits for onReady.
 * For other framework tasks it runs the handler directly after init.
 * For online bundle commands it starts the framework socket listener first.
 *
 * @memberof module:gina/lib/cmd
 * @param {object} client - Socket client for writing responses
 * @param {boolean} isFromFramework - True when the command originates from the framework
 * @param {object} opt - Parsed command options
 * @param {string} opt.task.topic - Command group (e.g. 'bundle')
 * @param {string} opt.task.action - Command action (e.g. 'start')
 * @param {boolean} [opt.isFromFramework] - Overrides isFromFramework parameter
 * @param {boolean} [opt.isOnlineCommand] - True when cmd needs a live framework socket
 */
cmd.onExec = function(client, isFromFramework, opt) {

    var console = lib.logger;// jshint ignore:line
    cmd.option = opt;

    var Proc = require( getPath('gina').lib + '/proc');// jshint ignore:line
    var self = {};

    cmd.msg = require( _(__dirname + '/framework/msg.json') );// jshint ignore:line
    self.isFromFramework = opt.isFromFramework || isFromFramework || false;
    self.isOnlineCommand = opt.isOnlineCommand || false;

    var ignore = function() {

        if (!self.isFromFramework) {
            var m = cmd.msg.default[0].replace("%command%", cmd.getString());
            client.write(m)
        }
    };


    var init = null;
    if (self.isFromFramework) {

        init = require('./framework/init')(opt);
        //Framework CMD.
        if (opt.task.action == 'start') {
            // Current version of the framework by default
            // But can be overriden with argument: @{version_number}
            // eg.: gina stop @1.0.0
            self.version = getEnvVar('GINA_VERSION');// jshint ignore:line
            // checkcking version number
            if ( typeof(opt.argv[3]) != 'undefined' && /^@/.test(opt.argv[3]) ) {
                var err = null;
                var version = opt.argv[3].replace(/\@/, '');
                var shortVersion = version.split('.').splice(0,2).join('.');
                if ( !/^\d\.\d/.test(shortVersion) ) {
                    err = new Error('Wrong version: '+ version);
                    console.log(err.message);
                    return;
                }
                var availableVersions = requireJSON(_(getEnvVar('GINA_HOMEDIR') +'/main.json', true)).frameworks[shortVersion];// jshint ignore:line
                if ( availableVersions.indexOf(version) < 0 ) {
                    err = new Error('Version not installed: '+ version);
                    console.log(err.message);
                    return;
                }

                self.version = version;
            }

            init.onComplete( function done(err, run){
                console.debug('loading task `',  opt.task.topic +':'+ opt.task.action, '`');

                //Setting master process with its own PID file.
                cmd.proc = new Proc('gina-v' + self.version, process);
                cmd.proc.setMaster(process.pid);

                cmd.proc.onReady( function(err, pid){ //starting others

                    if (!err) {
                        console.debug('[ '+ pid +' ] registered');

                        opt.pid = process.pid;
                        run(opt)
                    } else {
                        console.error(err.stack)
                    }

                })
            })
        } else { // Offline CMD
            init.onComplete( function done(err, run, opt){
                run(opt)
            })
        }

    } else if (self.isOnlineCommand) {
        var arr = opt.argv[2].split(':');
        if ( typeof(opt.task) == 'undefined' ) {
            opt.task = {}
        }
        opt.task.topic  = arr[0];
        opt.task.action = arr[1];

        console.debug('[ FRAMEWORK ] is starting online CLI '+ arr[0] +':'+arr[1]);

        init = require('./framework/init')(opt);
        init.onListen( function done(err, run, opt){
            run(opt, cmd)
        })

    } else {
        ignore()
    }
};

module.exports = cmd