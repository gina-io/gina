var fs          = require('fs');
var readline    = require('readline');
var rl          = readline.createInterface(process.stdin, process.stdout);

var CmdHelper   = require('./../helper');
var console     = lib.logger;

/**
 * Remove existing bundle from a given project.
 * NB.: If bundle exists, it won't be replaced. You'll only get warnings.
 *
 * TODO - Remove multiple bundles at once - ref. bundle/add
 * */
function Remove(opt, cmd) {

    var self    = {}
        , local = {
            b : 0,
            bundle : null,
            force : false
        }
    ;

    var init = function(opt) {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;


        if ( typeof(self.projects[self.projectName].path) == 'undefined' ) {
            console.error('project path not defined in ~/.gina/projects.json for [ '+ self.projectName + ' ]');
            process.exit(1)
        }

        if (isDefined('project', self.projectName)) {
            removeBundle(0)
        } else {
            //console.error('[ '+ self.projectName+' ] is not an existing project');
            if ( self.bundles.length == 0) {
                console.error('Missing argument <bundle_name>');
            } else if  (!isDefined('project', self.projectName) ) {
                console.error('[' + self.projectName +'] is not an existing project.');
            } else {
                console.error('Missing argument @<project_name>');
            }

            process.exit(1)
        }

        //var Proc = require( getPath('gina').lib + '/proc');



    }

    var removeBundle = function (b) {

        if (b > self.bundles.length-1) { // exits when done
            end()
        }

        local.b             = b;
        local.bundle        = self.bundles[b];
        local.envFileSaved  = false;
        local.force         = ( typeof(self.params['force']) != 'undefined' ) ? self.params['force'] : false;


        if (local.force) {
            // remove without checking
            remove(local.bundle)
        } else {
            check()
        }

    }

    var check = function() {


        rl.setPrompt('['+ local.bundle +'@'+ self.projectName +'] Also remove bundle files ? (Y/n):\n');

        rl.prompt();

        rl
            .on('line', function(line) {
                switch( line.trim().toLowerCase() ) {
                    case 'y':
                    case 'yes':
                        rl.clearLine();
                        remove(local.bundle);

                    break;
                    case 'n':
                    case 'no':
                        rl.clearLine();
                        // continue to next bundle
                        ++local.b;
                        removeBundle(local.b);
                    break;

                    default:
                        console.log('Please, write "yes" or "no" to proceed.');
                        rl.prompt();
                        break;
                }
            })
            .on('close', function() {
                rl.clearLine();
                console.log('Action cancelled !');
                process.exit(0)
            })
    }

    var remove = function (bundle) {

        // reload assets context with changes
        loadAssets();

        var hasFolder = true, folderPath = null, folder = null;
        console.debug('Removing bundle: ', bundle);
        try {
            folderPath = _(self.projects[self.projectName].path + '/' + self.projectData.bundles[bundle].src, true);
            folder = new _(folderPath);

            if ( !folder.isValidPath() ) {
                console.warn('`'+ folder.toString() +'` is not a valid path')
            } else {

                // removing mounting point: just in case
                var coreEnv = getCoreEnv(bundle);
                new _(coreEnv.mountPath +'/'+ bundle, true).rmSync();

                // removing folder
                folder = folder.rmSync();
                if (folder instanceof Error) {
                    console.error(folder.stack);
                    process.exit(1)
                }
            }
        } catch(folderException) {
            hasFolder = false;
        }



        // updating project env
        if ( typeof(self.envData) != 'undefined' && typeof(self.envData[bundle]) != 'undefined' ) (
            delete self.envData[bundle]
        )

        // updating project bundles
        if ( typeof(self.projectData.bundles) != 'undefined' && typeof(self.projectData.bundles[bundle]) != 'undefined' ) (
            delete self.projectData.bundles[bundle]
        )

        // removing ports
        var ports               = JSON.clone(self.portsData)
            , portsReverse      = JSON.clone(self.portsReverseData)
            , re                = null
        ;

        for (let protocol in ports) {
            for (let scheme in ports[protocol]) {
                for (let port in ports[protocol][scheme]) {
                    re = new RegExp(bundle +"\@"+ self.projectName +"\/");
                    if ( re.test(ports[protocol][scheme][port]) ) {
                        delete ports[protocol][scheme][port];
                    }
                }
            }
        }

        for (let bundleAddress in portsReverse) {
            re = new RegExp(bundle +"\@"+ self.projectName);
            if ( re.test(bundleAddress) ) {
                delete portsReverse[bundleAddress];
            }
        }

        // now writing
        lib.generator.createFileFromDataSync(ports, self.portsPath);
        lib.generator.createFileFromDataSync(portsReverse, self.portsReversePath);

        // env
        // var envData = JSON.clone(self.envData);
        // if ( typeof(envData[bundle]) != 'undefined' ) {
        //     delete envData[bundle];
            lib.generator.createFileFromDataSync(
                self.envData,
                self.envPath
            );
        // }

        // manifest
        // var projectData = JSON.clone(self.projectData);
        // if ( typeof(projectData.bundles) != 'undefined' && typeof(projectData.bundles[bundle]) != 'undefined' ) {
        //     delete projectData.bundles[bundle];
            // if (projectData.bundles.count() == 0) {
            //     delete projectData.bundles
            // }
            lib.generator.createFileFromDataSync(
                self.projectData,
                self.projectManifestPath
            );
        // }


        console.log('Bundle [ '+ bundle+'@'+self.projectName+' ] removed');


        ++local.b;
        removeBundle(local.b);
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
};

module.exports = Remove