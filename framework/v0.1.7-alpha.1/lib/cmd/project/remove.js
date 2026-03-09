var fs          = require('fs');
var CmdHelper   = require('./../helper');
var readline    = require('readline');
var rl          = readline.createInterface(process.stdin, process.stdout);

var console = lib.logger;

/**
 * @module gina/lib/cmd/project/remove
 */
/**
 * Removes a project from ~/.gina/projects.json, cleans up its port assignments,
 * and optionally deletes the project source directory.
 *
 * Usage:
 *  gina project:rm @<project_name>
 *  gina project:rm @<project_name> --force
 *
 * @class Remove
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Remove(opt, cmd) {
    var self = {};

    /**
     * Validates the project exists, prompts the user for source deletion,
     * and delegates to end.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;



        var err         = false
            , folder    = new _(self.projectLocation)
            , force     = ( typeof(self.params['force']) != 'undefined' ) ? self.params['force'] : false;


        if ( !folder.existsSync() ) {
            console.error('project [ '+ self.projectName+' ] was not found at this location: ' + folder.toString() );
            process.exit(1)
        }

        if ( typeof(self.projects[self.projectName]) == 'undefined' ) {
            console.error('project [ '+ self.projectName + ' ] not found in `~/.gina/projects.json`');

            process.exit(1)
        }


        prompt(force, function(force){


            if ( folder.isValidPath() && force ) {

                if ( !folder.existsSync() ) {
                    console.warn('project path not found at: ', folder.toString() );
                    end()
                }

                folder = folder.rmSync();
                if (folder instanceof Error) {
                    console.error(folder.stack);
                    process.exit(1)
                }
            }

            end(true)
        })
    }


    /**
     * Asks the user whether to also delete the project source files.
     * Skips the prompt and calls cb(true) immediately when force is true.
     *
     * @inner
     * @private
     * @param {boolean} force - When true, skip the prompt and delete sources
     * @param {function} cb - Called with `true` to delete sources, `false` to keep them
     */
    var prompt = function(force, cb) {
        if (!force) {
            rl.setPrompt('Also remove project sources ? (Y/n):\n');
            rl.prompt();
        } else {
            cb(true)
        }

        rl.on('line', function(line) {
            switch( line.trim().toLowerCase() ) {
                case 'y':
                case 'yes':
                    cb(true);
                    break;
                case 'n':
                case 'no':
                    cb(false);
                    break;
                default:
                    console.log('Please, write "yes" or "no" to proceed.');
                    rl.prompt();
                    break;
            }
        }).on('close', function() {
            console.log('\nCommand cancelled !');
            process.exit(0)
        })
    }


    /**
     * Removes port entries for the project, deletes it from projects.json,
     * and exits the process.
     *
     * @inner
     * @private
     * @param {boolean} [removed] - When true, log that the project was removed
     */
    var end = function(removed) {

        // removing ports
        var ports               = JSON.clone(self.portsData)
            , portsReverse      = JSON.clone(self.portsReverseData)
            , reversePortValue  = null
            , re                = null
        ;

        for (var protocol in ports) {

            for (var scheme in ports[protocol]) {

                for (var port in ports[protocol][scheme]) {

                    re = new RegExp("\@"+ self.projectName +"\/");

                    if ( re.test(ports[protocol][scheme][port]) ) {
                        // reverse ports
                        reversePortValue = ports[protocol][scheme][port].split('/')[0];
                        if ( typeof(portsReverse[reversePortValue]) != 'undefined' ) {
                            delete portsReverse[reversePortValue];
                        }

                        // ports
                        delete ports[protocol][scheme][port];
                    }
                }
            }
        }

        // now writing
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);


        var target = _(GINA_HOMEDIR + '/projects.json');
        delete self.projects[self.projectName];
        lib.generator.createFileFromDataSync(
            self.projects,
            target
        )


        if (removed)
            console.log('Project [ '+ self.projectName +' ] removed');

        process.exit(0)
    };

    init()
};

module.exports = Remove