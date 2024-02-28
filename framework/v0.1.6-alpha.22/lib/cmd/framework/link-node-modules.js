var fs              = require('fs');
var os              = require('os');
const {spawn}       = require('child_process');
const {execSync}    = require('child_process');
var CmdHelper       = require('./../helper');
var console         = lib.logger;

/**
 * Framework link node_modules
 *
 * e.g.
 *  gina framework:link-node-modules @<project>
 *  or
 *  gina link-node-modules @<project>
 *
 * */
 function LinkNodeModules(opt, cmd) {

    var self    = {};
    var init = function(opt, cmd) {

        var err = false;
        if ( !/^true$/i.test(GINA_GLOBAL_MODE) ) {
            err = new Error('Gina is not installed globally: cannot proceed with linking.');
            return end(err, 'error', true);
        }

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;


        if ( !isDefined('project', self.projectName) ) {
            err = new Error('Missing argument: `@<project-name>`');
            return end(err, 'error')
        }

        var projectLocationObj = new _(self.projectLocation)
        if ( !projectLocationObj.isValidPath() ) {
            err = new Error('Project path not found. You should run project:add @'+ self.projectLocation + ' --path=<your-project-location>');
            return end(err, 'error')
        }

        linkLocalNodeModules(opt, cmd);
    }

    var linkLocalNodeModules = function(opt, cmd) {
        var projectObj  = self.projects[ self.projectName ]
            err         = null
        ;


        if (!projectObj || typeof(projectObj) == 'undefined' ) {
            err = new Error('Node modules not found for project '+ self.projectName);
            return end(err, 'error')
        }

        if ( typeof(projectObj.homedir) == 'undefined' || projectObj.homedir == '' || !projectObj.homedir) {
            projectObj.homedir = self.projectHomedir || _(getUserHome() +'/.'+ self.projectName, true);
        }

        var nodeModulesFromProjectHomeDir = _(projectObj.homedir + '/lib/node_modules', true)
        var nodeModulesDirObj = new _(self.projectLocation + '/node_modules', true);
        var hasNodeModules = ( nodeModulesDirObj.existsSync() ) ? true : false;
        // Check if symlink
        if (
            hasNodeModules && nodeModulesDirObj.isSymlinkSync()
        ) {

            // same scope ? e.g: Shared code between docker & localhost
            if ( nodeModulesDirObj.getSymlinkSourceSync() != nodeModulesFromProjectHomeDir ) {
                // if not, remove symlink
                nodeModulesDirObj.rmSync();
                hasNodeModules = false;
            }
        }

        var sourceObj = new _(nodeModulesFromProjectHomeDir, true);
        if (!hasNodeModules) {
            if ( !sourceObj.existsSync() ) {
                sourceObj.mkdirSync()
            }
            // link from homdir to project path

            var destination = _(self.projectLocation + '/node_modules', true);

            err = sourceObj.symlinkSync(destination);
            if (err instanceof Error) {
                return end(err, 'error')
            }

            return end('Node modules link updated to '+ sourceObj.toString())
        }

        // nothing to do
        end('Node modules linked to `'+ sourceObj.toString() +'`')
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

    init(opt, cmd)
 }

 module.exports = LinkNodeModules;