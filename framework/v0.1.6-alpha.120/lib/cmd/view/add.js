var fs          = require('fs');
var readline    = require('readline');
var rl          = readline.createInterface(process.stdin, process.stdout);

var CmdHelper   = require('./../helper');
var console = lib.logger;

/**
 * Add new view to a given project bundle.
 * NB.: If bundle exists, You will be asked if you want to replace.
 *
 * Usage:
 * $ gina bundle:add <bundle_name> @<project_name>
 * */
function Add(opt, cmd) {
    var self = { task: 'add' }
        , local = {}
    ;

    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        if ( isDefined('project', self.projectName) && self.bundles.length > 0) {

            addViews(0)

        } else {
            //console.error('[ '+ self.projectName+' ] is not an existing project');
            if ( self.bundles.length == 0) {
                console.error('Missing argument <bundle_name>');
            } else if  (!isDefined('project', self.projectName) ) {
                console.error('`@' + self.projectName +'` is not an existing project.');
            } else {
                console.error('Missing argument @<project_name>');
            }

            process.exit(1)
        }
    }

    /**
     * Browse sources
     *
     * @param {string} source
     * @param {string} bundle
     * */
     var browse = function(source, list) {

        var bundle = local.bundle
            , newSource
            , files = fs.readdirSync(source)
            , f = 0;

        if (source == local.source && typeof(list) == 'undefined') {//root
            list = [];// root list
            for (let l=0; l<files.length; ++l) {
                list[l] = _(local.source +'/'+ files[l])
            }
        }

        if (!files && list.indexOf(source) > -1) {
            list.splice( list.indexOf(source), 1 )
        }

        for (; f < files.length; ++f) {
            newSource = _(source +'/'+ files[f]);
            if ( fs.statSync(newSource).isDirectory() ) {
                browse(newSource, list)
            } else {
                list = parse(newSource, list)
            }

            if ( f == files.length-1) { //end of current dir
                var p = newSource.split('/');
                p.splice(p.length -1);
                newSource = p.join('/');
                if (list != undefined && list.indexOf(newSource) > -1) {
                    list.splice( list.indexOf(newSource), 1 )
                }
            }

            if (f == files.length-1 && list.length == 0) { //end of all

                local.isInstalled = true;

                break
            }
        }
    }

    /**
     * Parse file and modify only javascripts - *.js
     *
     * @param {string} file - File to parse
     * @param {array} list
     * */
     var parse = function(file, list) {
        //console.log('replacing: ', file);
        try {
            var f;
            f =(f=file.split(/\//))[f.length-1];
            var isJS = /\.js/.test(f.substring(f.length-3))
                , isJSON = /\.js/.test(f.substring(f.length-5));

            if ( isJS || isJSON && /config\/app\.json/.test(file) ) {
                var contentFile = fs.readFileSync(file, 'utf8').toString();
                var dic = {
                    "Bundle" : local.bundle.substring(0, 1).toUpperCase() + local.bundle.substring(1),
                    "bundle" : local.bundle,
                    "Namespace" : (local.namespace) ? local.namespace.substring(0, 1).toUpperCase() + local.namespace.substring(1) : '',
                    "namespace" : local.namespace || ''
                };

                contentFile = whisper(dic, contentFile);
                //rewrite file
                lib.generator.createFileFromDataSync(contentFile, file)
            }

            if ( list != undefined && list.indexOf(file) > -1 ) { //end of current dir
                list.splice( list.indexOf(file), 1 )
            }
            return list

        } catch(err) {
            console.error(err.stack);
            process.exit(1)
        }
    }

    // var checkForNamespaces = function(src) {
    //     var routingObj = null
    //         , namespaces = {}
    //     ;
    //     try {
    //         routingObj = require(_(src + '/config/routing.json', true));
    //         // Looking for namespaces
    //         for (let r in routing) {
    //             if ( typeof(routing[r].namespace) != 'undefined' ) {
    //                 namespaces[r] = {
    //                     namespace : routing[r].namespace
    //                 }
    //             }
    //         }
    //     } catch (err) {
    //         console.error(err.stack);
    //         process.exit(1);
    //     }

    //     return (namespaces.count() > 0) ? namespaces : null
    // }

    /**
     * Add bundles
     *
     * @param {number} b - bundle index
     * @param {number} e - env index
     *
     * */
    var addViews = function(b) {
        if (b > self.bundles.length-1) {// done
            process.exit(0)
        }

        var bundle = self.bundles[b];


        if ( /^[a-z0-9_.]/.test(bundle) ) {

            if ( !fs.existsSync(self.envPath) ) {
                lib.generator.createFileFromDataSync({}, self.envPath);
            }

            local.bundle    = bundle;
            local.b         = b;
            local.env       = self.projects[self.projectName]['def_env'];
            local.root      = self.projects[self.projectName].path;
            local.src       = _(self.bundlesLocation +'/'+ bundle, true);

            console.info('Adding view folder for: '+ local.bundle +'@'+ self.projectName);

            // local.namespaces = checkForNamespaces(local.src);


            addConfFile()

        } else {
            console.error('[ '+ bundle+' ] is not a valid bundle name')
            process.exit(1)
        }
    }



    /**
     * Adding view configuration
     *
     * */
    var addConfFile = function() {

        var templatesConf = new _( getPath('gina').core + '/template/boilerplate/bundle/config/templates.json');
        var target  = _(local.src + '/config/templates.json');
        var folder  = _(local.src + '/templates');

        if ( fs.existsSync(target) || fs.existsSync(folder) ) {
            rl.setPrompt('Found templates for [ '+ local.bundle +'@'+ self.projectName +' ]. Do you want to override ? (yes|no) > \n');
            rl.prompt();

            rl.on('line', function(line) {
                switch( line.trim().toLowerCase() ) {
                    case 'y':
                    case 'yes':
                        createFile(templatesConf, target);
                        break;
                    case 'n':
                    case 'no':
                        process.exit(0);
                        break;
                    default:
                        console.log('Please, write "yes" to proceed or "no" to cancel. ');
                        rl.prompt();
                        break;
                }
            }).on('close', function() {
                console.log('exiting ['+ local.bundle +'@'+ self.projectName +'] templates installation');

                ++local.b;
                addViews(local.b)
            })

        } else {
            createFile(templatesConf, target)
        }

    }


    /**
     * Create file
     *
     * @param {string} file
     * @param {string} target
     * */
    var createFile = function(file, target) {
        file.cp(target, function(err) {
            if (err) {
                console.log(err.stack);
                process.exit(1)
            }
            copyFolder()
        })
    }

    var copyFolder = function() {
        var folder = new _( getPath('gina').core +'/template/boilerplate/bundle_templates' );
        var folderPublic = new _( getPath('gina').core +'/template/boilerplate/bundle_public' );
        var target = _(local.src);

        folder.cp(target + '/templates', function(err, targetPath){
            if (err) {
                console.log(err.stack);
                process.exit(1)
            }
            console.debug('targetPath: ', targetPath);
            // Browse, parse and replace keys
            local.source        = _(targetPath +'/handlers', true);
            local.isInstalled   = false;
            browse(local.source);

            console.log('['+ local.bundle +'@'+ self.projectName +'] templates installed with success !');
            folderPublic.cp(target + '/public', function(err, targetPath){
                if (err) {
                    console.log(err.stack);
                    process.exit(1)
                }
                console.log('['+ local.bundle +'@'+ self.projectName +'] public installed with success !');
                ++local.b;
                addViews(local.b)
            });

        });
    }


    var rollback = function(err) {
        console.error('could not complete view creation: ', (err.stack||err.message));
        console.warn('rolling back...');

        var writeFiles = function() {
            //restore env.json
            if ( typeof(self.envDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.envData, self.envPath)
            }
            //restore project.json
            if ( typeof(self.projectDataWrote) == 'undefined' ) {
                if ( typeof(self.projectData.bundles[local.bundle]) != 'undefined') {
                    delete self.projectData.bundles[local.bundle]
                }
                lib.generator.createFileFromDataSync(self.projectData, self.projectManifestPath)
            }

            //restore ports.json
            if ( typeof(self.portsDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.portsData, self.portsPath)
            }

            //restore ports.reverse.json
            if ( typeof(self.portsReverseDataWrote) == 'undefined' ) {
                lib.generator.createFileFromDataSync(self.portsReverseData, self.portsReversePath)
            }


            process.exit(1)
        };

        var bundle = new _(local.source);
        if ( bundle.existsSync() ) {
            bundle.rm( function(err) {//remove folder
                if (err) {
                    throw err
                }
                writeFiles()
            })
        } else {
            writeFiles()
        }
    };

    init()
};

module.exports = Add