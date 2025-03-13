var fs          = require('fs');
var CmdHelper   = require('./../helper');
var readline    = require('readline');
var rl          = readline.createInterface(process.stdin, process.stdout);

var console = lib.logger;

/**
 * Remove project or unregister existing one from `~/.gina/projects.json`.
 * */
function Remove(opt, cmd) {
    var self = {};

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