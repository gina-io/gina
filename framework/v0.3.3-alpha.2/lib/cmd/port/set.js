var fs = require('fs');
var readline = require('readline');
var CmdHelper = require('./../helper');
var console = lib.logger;

/**
 * @module gina/lib/cmd/port/set
 */
/**
 * Sets or updates the port number for a bundle/environment/protocol/scheme combination.
 *
 * Usage (positional):
 *  gina port:set <bundle_name> @<project_name>
 *  gina port:set <protocol>:<port_number> <bundle_name> @<project_name>/<environment>
 *
 * Usage (flags):
 *  gina port:set <bundle_name> @<project_name> --protocol=http/1.1 --scheme=http --port=3200 --env=dev
 *
 * When a required value is omitted, the user is prompted interactively.
 *
 * @class Set
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Set(opt, cmd) {

    var self = {}, local = {};
    var requestedProtocol = null
        , requestedScheme = null
        , requestedPort   = null
        , requestedEnv    = null
    ;

    // Pre-parse argv before CmdHelper to extract protocol:port and @project/env
    // CmdHelper would misclassify the positional protocol:port as a bundle name
    // and fail on @project/env because the project name would include the /env suffix.
    (function preParseArgs() {
        var cleaned = process.argv.slice(0, 3);
        for (var i = 3; i < process.argv.length; i++) {
            var arg = process.argv[i];

            // Positional protocol:port (e.g. http/1.1:3200, http/2.0:8443)
            var m = arg.match(/^([a-z]+\/[0-9.]+)\:(\d+)$/);
            if (m) {
                requestedProtocol = m[1];
                requestedPort     = ~~m[2];
                continue;
            }

            // @project/env  →  extract env, pass clean @project to CmdHelper
            if ( /^\@[a-z0-9_.]/.test(arg) && arg.indexOf('/') > 0 ) {
                var slash = arg.indexOf('/');
                requestedEnv = arg.substring(slash + 1);
                cleaned.push( arg.substring(0, slash) );
                continue;
            }

            // Flag-based overrides
            if ( /^\-\-port\=/.test(arg) )     { requestedPort     = ~~arg.split('=')[1]; continue; }
            if ( /^\-\-protocol\=/.test(arg) ) { requestedProtocol = arg.split('=')[1];   continue; }
            if ( /^\-\-scheme\=/.test(arg) )   { requestedScheme   = arg.split('=')[1];   continue; }
            if ( /^\-\-env\=/.test(arg) )      { requestedEnv      = arg.split('=')[1];   continue; }

            cleaned.push(arg);
        }
        process.argv = cleaned;
    })();


    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        if (!self.name || !self.projectName) {
            console.error('Usage: gina port:set <bundle_name> @<project_name>');
            process.exit(1);
        }

        // Default scheme from protocol when not explicitly given
        if (requestedProtocol && !requestedScheme) {
            requestedScheme = /^http\/2/.test(requestedProtocol) ? 'https' : self.defaultScheme;
        }

        // If all params are present, set directly; otherwise prompt for missing ones
        if (requestedProtocol && requestedScheme && requestedPort && requestedEnv) {
            setPort(requestedProtocol, requestedScheme, requestedPort, requestedEnv);
        } else {
            promptMissing();
        }
    };


    /**
     * Interactively prompts for any missing parameter (protocol, scheme, env, port)
     * using readline, then delegates to setPort().
     *
     * @inner
     * @private
     */
    var promptMissing = function() {
        var rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        var steps = [];

        // --- protocol ---
        if (!requestedProtocol) {
            steps.push(function(cb) {
                var choices = self.protocolsAvailable;
                var list = '';
                for (var i = 0; i < choices.length; i++) {
                    var def = (choices[i] === self.defaultProtocol) ? ' - default' : '';
                    list += '\n (' + (i+1) + ') ' + choices[i] + def;
                }
                list += '\n\n (c) cancel';
                rl.question('Choose a protocol:' + list + '\r\n> ', function(answer) {
                    answer = answer.trim().toLowerCase();
                    if ( /^(c|cancel)$/.test(answer) ) { rl.close(); process.exit(0); }
                    var idx = ~~answer - 1;
                    if (idx >= 0 && idx < choices.length) {
                        requestedProtocol = choices[idx];
                    } else if (choices.indexOf(answer) > -1) {
                        requestedProtocol = answer;
                    } else {
                        console.error('Invalid choice.');
                        rl.close(); process.exit(1);
                    }
                    cb();
                });
            });
        }

        // --- scheme ---
        if (!requestedScheme) {
            steps.push(function(cb) {
                // auto-derive when possible
                if (requestedProtocol && /^http\/2/.test(requestedProtocol)) {
                    requestedScheme = 'https';
                    return cb();
                }
                var choices = self.schemesAvailable;
                var list = '';
                for (var i = 0; i < choices.length; i++) {
                    var def = (choices[i] === self.defaultScheme) ? ' - default' : '';
                    list += '\n (' + (i+1) + ') ' + choices[i] + def;
                }
                list += '\n\n (c) cancel';
                rl.question('Choose a scheme:' + list + '\r\n> ', function(answer) {
                    answer = answer.trim().toLowerCase();
                    if ( /^(c|cancel)$/.test(answer) ) { rl.close(); process.exit(0); }
                    var idx = ~~answer - 1;
                    if (idx >= 0 && idx < choices.length) {
                        requestedScheme = choices[idx];
                    } else if (choices.indexOf(answer) > -1) {
                        requestedScheme = answer;
                    } else {
                        console.error('Invalid choice.');
                        rl.close(); process.exit(1);
                    }
                    cb();
                });
            });
        }

        // --- environment ---
        if (!requestedEnv) {
            steps.push(function(cb) {
                var choices = self.envs;
                var list = '';
                for (var i = 0; i < choices.length; i++) {
                    var def = (choices[i] === self.defaultEnv) ? ' - default' : '';
                    list += '\n (' + (i+1) + ') ' + choices[i] + def;
                }
                list += '\n\n (c) cancel';
                rl.question('Choose an environment:' + list + '\r\n> ', function(answer) {
                    answer = answer.trim().toLowerCase();
                    if ( /^(c|cancel)$/.test(answer) ) { rl.close(); process.exit(0); }
                    var idx = ~~answer - 1;
                    if (idx >= 0 && idx < choices.length) {
                        requestedEnv = choices[idx];
                    } else if (choices.indexOf(answer) > -1) {
                        requestedEnv = answer;
                    } else {
                        console.error('Invalid choice.');
                        rl.close(); process.exit(1);
                    }
                    cb();
                });
            });
        }

        // --- port number ---
        if (!requestedPort) {
            steps.push(function(cb) {
                rl.question('Enter port number:\r\n> ', function(answer) {
                    answer = answer.trim();
                    if ( /^(c|cancel)$/.test(answer) ) { rl.close(); process.exit(0); }
                    requestedPort = ~~answer;
                    if (!requestedPort || requestedPort < 1 || requestedPort > 65535) {
                        console.error('Invalid port number. Must be between 1 and 65535.');
                        rl.close(); process.exit(1);
                    }
                    cb();
                });
            });
        }

        // Run prompt steps sequentially, then apply
        var runSteps = function(i) {
            if (i >= steps.length) {
                rl.close();
                setPort(requestedProtocol, requestedScheme, requestedPort, requestedEnv);
                return;
            }
            steps[i](function() { runSteps(i + 1); });
        };
        runSteps(0);
    };


    /**
     * Validates inputs and writes the port assignment to ports.json and
     * ports.reverse.json. Removes any previous assignment for the same
     * bundle/env/protocol/scheme before writing the new one.
     *
     * @inner
     * @private
     * @param {string} protocol - e.g. 'http/1.1', 'http/2.0'
     * @param {string} scheme   - e.g. 'http', 'https'
     * @param {number} port     - Port number to assign
     * @param {string} env      - Environment name (e.g. 'dev', 'staging')
     */
    var setPort = function(protocol, scheme, port, env) {

        // --- validation ---
        if ( self.protocolsAvailable.indexOf(protocol) < 0 ) {
            console.error('Protocol [ '+ protocol +' ] is not allowed. Available: '+ self.protocolsAvailable.join(', '));
            process.exit(1);
        }
        if ( self.schemesAvailable.indexOf(scheme) < 0 ) {
            console.error('Scheme [ '+ scheme +' ] is not allowed. Available: '+ self.schemesAvailable.join(', '));
            process.exit(1);
        }
        if ( self.envs.indexOf(env) < 0 ) {
            console.error('Environment [ '+ env +' ] is not defined. Available: '+ self.envs.join(', '));
            process.exit(1);
        }
        if ( port < 1 || port > 65535 ) {
            console.error('Port must be between 1 and 65535.');
            process.exit(1);
        }
        // Reserved range (Gina infrastructure)
        if ( port >= 4100 && port <= 4199 ) {
            console.error('Ports 4100-4199 are reserved for Gina infrastructure.');
            process.exit(1);
        }

        loadAssets();

        var ports        = requireJSON(_(self.portsPath));
        var portsReverse = requireJSON(_(self.portsReversePath));

        var bundleKey = self.name +'@'+ self.projectName;
        var portValue = bundleKey +'/'+ env;
        var portStr   = ''+ port;

        // Check if port is already assigned to a different bundle/env
        if (
            typeof(ports[protocol]) != 'undefined'
            && typeof(ports[protocol][scheme]) != 'undefined'
            && typeof(ports[protocol][scheme][portStr]) != 'undefined'
            && ports[protocol][scheme][portStr] !== portValue
        ) {
            console.error('Port '+ port +' is already assigned to '+ ports[protocol][scheme][portStr]);
            process.exit(1);
        }

        // Remove previous port for this bundle/env/protocol/scheme (if reassigning)
        if ( typeof(ports[protocol]) != 'undefined' && typeof(ports[protocol][scheme]) != 'undefined' ) {
            for (var p in ports[protocol][scheme]) {
                if ( ports[protocol][scheme][p] === portValue ) {
                    delete ports[protocol][scheme][p];
                    break;
                }
            }
        }

        // Ensure structure exists
        if ( typeof(ports[protocol]) == 'undefined' )          ports[protocol] = {};
        if ( typeof(ports[protocol][scheme]) == 'undefined' )  ports[protocol][scheme] = {};

        // Write new assignment
        ports[protocol][scheme][portStr] = portValue;

        // Update reverse map
        if ( typeof(portsReverse[bundleKey]) == 'undefined' )                       portsReverse[bundleKey] = {};
        if ( typeof(portsReverse[bundleKey][env]) == 'undefined' )                  portsReverse[bundleKey][env] = {};
        if ( typeof(portsReverse[bundleKey][env][protocol]) == 'undefined' )        portsReverse[bundleKey][env][protocol] = {};
        portsReverse[bundleKey][env][protocol][scheme] = ~~port;

        // Persist
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        console.log('Port '+ port +' assigned to '+ portValue +' ('+ protocol +'/'+ scheme +')');
        end('You may need to restart the bundle for the change to take effect.');
    };


    /**
     * Prints optional output and exits the process.
     *
     * @inner
     * @private
     * @param {string|Error} [output] - Message or Error to display
     * @param {string} [type] - console method to call (e.g. 'error', 'warn')
     * @param {boolean} [messageOnly] - When true, print only the message, not the stack
     */
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
    };

    init();
}

module.exports = Set;
