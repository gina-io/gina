const { execSync } = require('child_process');
var fs          = require('fs');
const { promisify } = require('util');
var console     = lib.logger;
var merge       = lib.merge;
var inherits    = lib.inherits;
var Collection  = lib.Collection;
var helpers     = require( getPath('gina').helpers);
/**
 * CmdHelper
 *
 * @package     gina.lib.cmd
 * @author      Rhinostone <contact@gina.io>
 * @api public
 * */
function CmdHelper(cmd, client, debug) {

    var conf = {
        main: null,
        settings: null,
        ports: null, // ports & protocols
        reversePorts: null,
        projects: null
    };


    // cmd properties list
    var self = {
        task: null,
        // framework main config {object}
        mainConfig : null,
        // framework main config path {string}
        mainConfigPath : null,
        // framework core env - core/template/conf/env.json
        coreEnv : null,

        // CMD params list ( starting with --) {object}
        params : {}, //
        nodeParams : [],
        debugPort: debug.port,
        debugBrkEnabled: debug.brkEnabled,
        // gina short version for the project
        def_framework_short : null,
        // project name {string}
        projectName : null, // defined by filterArgs()
        projectLocation: null,
        projectArgvList: [],
        // global projects collection {collection}
        projects : null, // defined by filterArgs()
        projectsList : [], // Array of project names, asc sorted
        // current project paths
        projectManifestPath : null, // local project/manifest.json - defined by filterArgs()
        projectConfigPath: null, // path to .gina/projects.json
        projectHomedir: null, // path to ~/.<my-project> ( project $home), defined by loadAssets()
        projectBundlesPath: null, // real project bundles path
        projectReleasesPath: null, // real project releases path
        projectLogsPath: null, // real project logs path
        projectTmpPath: null, // real project tmp path
        projectData: {}, // Project manifest object
        // current project bundles list {array}
        bundles : [], // defined by filterArgs()
        // don't use this collection to store into files
        bundlesByProject: {}, // bundles collection will be loaded into cmd.projects[$project].bundles
        bundlesLocation : null, // symlink to cmd.projects[$project].bundles_path

        // current project env.json path
        envPath : null, // path to env.json - defined by filterArgs()
        // current env {object}
        envData : {}, // defined by loadAssets()
        scopes : [], // all gina envs defined by loadAssets()
        defaultScope : null, // defined by loadAssets()
        localScope : null, // defined by loadAssets()
        productionScope : null, // defined by loadAssets()
        envs : [], // all gina envs defined by loadAssets()
        defaultEnv : null, // defined by loadAssets()
        devEnv : null, // defined by loadAssets()
        protocols : [], // defined by loadAssets()
        protocolsAvailable : [], // defined by loadAssets()
        defaultProtocol : null, // defined by loadAssets()
        schemes : [], // defined by loadAssets()
        schemesAvailable : [], // defined by loadAssets()
        defaultScheme : null, // defined by loadAssets()
        portsPath : null, // defined by filterArgs()
        portsData : {}, // defined by loadAssets()
        portsList : [], // conxtual ports list (bundle or project)  for the scanner ?
        portsGlobalList : [], // global ports list  for the scanner ?
        portsReversePath : null, // defined by filterArgs()
        portsReverseData : {} // defined by loadAssets()
    };


    // merging with default
    var _cmd = JSON.clone(cmd);
    _cmd = merge(_cmd, self);
    for (let prop in _cmd) {
        cmd[prop] = _cmd[prop]
    }


    var getParams = function () {

        // filtering CMD arguments VS node.js argument
        var taskGroup       = cmd.task.split(/:/)[0]
            , file          = _( __dirname +'/'+ taskGroup +'/arguments.json', true )
            , cmdArguments = []
        ;

        if ( fs.existsSync(file) ) {
            if ( typeof(require.cache[file]) != 'undefined') {
                delete require.cache[require.resolve(file)]
            }

            cmdArguments = requireJSON(file);
        }

        var arr = [];

        // retieving debug infos
        var debugOption = null;
        if ( cmd.debugPort ) {
            debugOption = '--inspect=' + cmd.debugPort;

            if (cmd.debugBrkEnabled) {
                debugOption = debugOption.replace(/\-\-inspect/, '--inspect-brk')
            }

            cmd.nodeParams.push(debugOption)
        }

        console.debug('process.argv: ', process.argv);
        for (let a in process.argv) {


            if ( /^\-\-(inspect|debug)\-brk/.test(process.argv[a]) ) {
                cmd.debugBrkEnabled = debug.brkEnabled = true;
            }

            if ( process.argv[a].indexOf('--') > -1 && process.argv[a].indexOf('=') > -1) {

                arr = (process.argv[a].replace(/--/, '')).split(/=/);

                arr[0] = arr[0].toLowerCase();

                //Boolean values.
                if ( typeof(arr[1]) == 'undefined' || arr[1] === "true" ) {
                    arr[1] = true
                }

                if (arr[1] === "false") {
                    arr[1] = false
                }

                if ( cmdArguments.indexOf('--' + arr[0]) > -1 )
                    cmd.params[arr[0]] = arr[1];
                else
                    cmd.nodeParams.push('--' + arr[0] +'='+ arr[1]);


            } else if ( process.argv[a].indexOf('--') > -1 ) {

                if ( cmdArguments.indexOf(process.argv[a]) > -1 )
                    cmd.params[ process.argv[a].replace(/--/, '') ] = true;
                else
                    cmd.nodeParams.push(process.argv[a]);

            }
        }

        // console.debug('nodeParams ', cmd.nodeParams)
    }

    /**
     * isCmdConfigured
     * filter argv & merge cmd properties
     * Used once at init to filter argv inputs and set some assets variables
     *
     *
     * @returns {boolean} isConfigured
     * */
    isCmdConfigured = async function() {

        cmd.configured = ( typeof(cmd.configured) != 'undefined' ) ? cmd.configured : false;

        if (cmd.configured) return; // can only be called once !!

        var errMsg = null;

        try {

            // framework package
            //cmd.package     = require( _(GINA_HOMEDIR + '/template/conf/package.json', true) );


            // main config
            cmd.mainConfigPath = _(GINA_HOMEDIR + '/main.json', true);
            if ( typeof(require.cache[cmd.mainConfigPath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.mainConfigPath)]
            }
            cmd.mainConfig  = requireJSON( cmd.mainConfigPath );

            // projects
            cmd.projectConfigPath = _(GINA_HOMEDIR + '/projects.json', true);
            if ( typeof(require.cache[cmd.projectConfigPath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.projectConfigPath)]
            }

            cmd.projects    = requireJSON( cmd.projectConfigPath );
            var pIndex      = 0;
            for (let p in cmd.projects) {
                if ( new _(cmd.projects[p].path).existsSync() ) {
                    cmd.projectsList[pIndex] = p;
                    pIndex++
                }
            }
            cmd.projectsList.sort();

            // bundles passed to the CMD
            cmd.bundles = ( typeof(cmd.bundles) == 'undefined' ) ? [] : cmd.bundles;

            var i           = 3 // usual the index start position for CMD task argument
                , argv      = process.argv
                , len       = argv.length
                , folder    = null
            ;

            cmd.task = argv[2];
            if (
                /^project\:/.test(cmd.task)
                // excluded
                && !/^project\:(list|help|status)/.test(cmd.task)
                && !/^\@/.test(argv[3])
            ) {
                errMsg = 'This is a project command line. Cannot understand what your are asking with: `'+ process.argv.slice(2).join(' ') +'`';
                console.error(errMsg);
                exit(errMsg);
            }
            // getting CMD params
            getParams();
            console.debug('nodeParams: ', cmd.nodeParams);
            console.debug('cmd.params: ', cmd.params);


            var mightBeASomeBundle = true;
            for (; i < len; ++i) {

                if ( typeof(argv[i]) == 'undefined' )
                    break;

                // detection for project name
                if ( /^\@[a-z0-9_.]/.test(argv[i]) ) {

                    mightBeASomeBundle = false;

                    if ( !isValidName(argv[i]) ) {
                        errMsg = '[ '+ argv[i] +' ] is not a valid project name. Please, try something else: @[a-z0-9_.]';
                        console.error(errMsg);
                        exit(errMsg);
                        return false;
                    } else {
                        // only take the first one
                        if ( !cmd.projectArgvList.length )
                            cmd.projectName = argv[i].replace('@', '');
                    }

                    // only take the first one
                    if ( !cmd.projectArgvList.length ) {
                        // if path is set through CMD argv
                        // --path
                        if ( typeof(cmd.params.path) != 'undefined' ) {
                            if ( /^\.\//.test(cmd.params.path) ) {
                                if (cmd.params.path == './') {
                                    cmd.params.path += cmd.projectName;
                                }
                                cmd.params.path = cmd.params.path.replace(/^\.\//, process.cwd() +'/')
                            }
                            folder = new _( cmd.params.path, true );


                        }
                        else if ( typeof(cmd.params.path) == 'undefined' ) {
                            // getting the current path
                            try {
                                folder = new _( process.cwd(), true );
                            } catch (err) {
                                errMsg = 'You are trying to run command from a deleted path ! Please move to another location to run this command.';
                                console.error(errMsg);
                                exit(errMsg);
                                return false;
                            }

                        }

                        if ( folder.isValidPath() ) {

                            if ( folder.toArray().last() == cmd.projectName ) {
                                cmd.projectLocation = _( folder.toString(), true );
                            }
                            else if (
                                typeof(cmd.projects[cmd.projectName]) !=  'undefined'
                                && typeof(cmd.projects[cmd.projectName].path) !=  'undefined'
                            ) {
                                cmd.projectLocation = _(cmd.projects[cmd.projectName].path, true);
                            }
                            else {
                                cmd.projectLocation = _( folder.toString(), true );
                            }

                        } else {
                            errMsg = 'Argument `--path=`' +cmd.params.path + ' is not valid';
                            console.error(errMsg);
                            exit(errMsg);
                            return false;
                        }
                    }

                    if ( cmd.projectName && !cmd.projects.count() ) {
                        cmd.projects[cmd.projectName] = {
                            "path"              : cmd.projectLocation,
                            "homedir"           : cmd.projectHomedir,
                            "bundles_path"      : cmd.projectBundlesPath,
                            "releases_path"     : cmd.projectReleasesPath,
                            "logs_path"         : cmd.projectLogsPath,
                            "tmp_path"          : cmd.projectTmpPath,
                            "def_prefix"        : GINA_PREFIX,
                            "framework"         : "v" + GINA_VERSION,
                            "envs"              : cmd.envs,
                            "def_env"           : cmd.defaultEnv,
                            "dev_env"           : cmd.devEnv,
                            "def_scope"         : cmd.defaultScope,
                            "local_scope"       : cmd.localScope,
                            "production_scope"  : cmd.productionScope,
                            "protocols"         : cmd.protocolsAvailable,
                            "def_protocol"      : cmd.defaultProtocol,
                            "schemes"           : cmd.schemesAvailable,
                            "def_scheme"        : cmd.defaultScheme
                        }
                    }



                    cmd.projectArgvList.push( argv[i].replace('@', '') )

                } else if (mightBeASomeBundle && !/^\@/.test(argv[i]) && isValidName(argv[i]) ) { // bundles list
                    cmd.bundles.push( argv[i] )
                }
            }

            // cleanup bundles list in case of `bundle:`task
            if ( /^bundle\:/.test(cmd.task) ) {
                var newArgv = argv.slice();
                // remove the first part of the command line
                newArgv.splice(0, 3);
                // filter
                for (let a = 0, len = newArgv.length; a < len; ++a) {
                    if ( /^\@/.test(newArgv[a]) ) {
                        newArgv.splice(a, 1);
                        len--;
                        a--;
                        continue
                    }
                    if ( /^\-\-/.test(newArgv[a]) ) {
                        newArgv.splice(a, 1);
                        len--;
                        a--;
                    }
                }

                cmd.bundles = newArgv.slice();
                newArgv = null;
            }

            if (cmd.bundles.length == 1 ) {
                if  ( isValidName(cmd.bundles[0]) ) {
                    cmd.name = cmd.bundles[0]
                } else {
                    console.error('[ ' + cmd.name + ' ] is not a valid bundle name.');
                    process.exit(1)
                }
            } // else, might be a bulk operation: look for `isBulkOperation`

            // project name : passed or using the current folder as project name by default
            if ( cmd.projectName == null || typeof(cmd.projectName) == 'undefined' || cmd.projectName == '' ) {

                if (!/\:list$/.test(cmd.task)) {// ignore this cases
                    var folder = new _(process.cwd()).toArray().last();

                    if (isDefined('project', folder)) {

                        cmd.projectName = folder;
                        cmd.projectLocation = _(process.cwd(), true);
                    } else if (!/\:help$/.test(cmd.task) && !/port\:reset$/.test(cmd.task) ) {

                        errMsg = 'No project name found: make sure it starts with `@` as `@<project_name>`';
                        console.error(errMsg);
                        exit(errMsg);
                        return false;
                    }
                }
            }

            // Additional project checking & actions
            if (cmd.projectName != null) {
                // valid name but not in projects and task != :add, :remove or :import
                if ( typeof(cmd.projects[cmd.projectName]) == 'undefined' && !/\:(add|import|remove)$/.test(cmd.task) ) {
                    errMsg = 'Project ['+ cmd.projectName +'] not found in your projects list';
                    console.error(errMsg);
                    exit(errMsg);
                    return false;
                }

                if ( typeof(cmd.projects[cmd.projectName]) == 'undefined') {
                    cmd.projectManifestPath = _(cmd.projectLocation + '/manifest.json', true)
                }

                cmd.projectManifestPath = (!cmd.projectManifestPath) ? _(cmd.projects[cmd.projectName].path + '/manifest.json', true) : cmd.projectManifestPath;

                if (typeof (cmd.projects[cmd.projectName]) != 'undefined') // ignore when adding project
                    cmd.envPath = _(cmd.projects[cmd.projectName].path + '/env.json', true);
            }



            cmd.portsPath          = _(GINA_HOMEDIR + '/ports.json', true);
            cmd.portsReversePath   = _(GINA_HOMEDIR + '/ports.reverse.json', true);


            loadAssets();

            // cmd.configured = true;
            var err = null;

            return true; // completed configuration

        } catch (err) {

            console.emerg(err.stack);
            exit(err.stack);
            return false; // configuration failed
        }
    }

    getCoreEnv = function(bundle, env) {
        var coreEnvPath = _(GINA_CORE + '/template/conf/env.json', true);
        var coreEnv     = requireJSON(coreEnvPath);

        var reps = {
            "frameworkDir"  : GINA_FRAMEWORK_DIR,
            "executionPath" : _(cmd.projects[cmd.projectName].path, true),
            "projectPath"   : _(cmd.projects[cmd.projectName].path, true),
            // "bundlesPath" : appsPath,
            // "modelsPath" : modelsPath,
            "env" : env || cmd.projects[cmd.projectName].def_env,
            "bundle" : bundle,
            "version" : GINA_VERSION
        };


        try {
            //console.error("reps ", reps);
            coreEnv = whisper(reps, coreEnv);
        } catch (err) {
            console.error('`whisper(reps, coreEnv)` - Potential `reps` issue '+ coreEnvPath + ' ?\n' + err.stack);
        }


        return coreEnv
    }

    /**
     * loadAssets
     * Will load files & content without cache
     * Use before require()
     *
     * @param {object} [usercmd]
     * */
    loadAssets = function () {

        var ports = null;

        if (
            cmd.projectName != null
            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
            //&& !cmd.params['force']
        ) { // ignore when adding project

            if (!cmd.projectManifestPath) {
                cmd.projectManifestPath =  _(cmd.projects[cmd.projectName].path + '/manifest.json', true);
            }

            if ( typeof(require.cache[cmd.projectManifestPath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.projectManifestPath)]
            }

            if ( ! new _(cmd.projectManifestPath).existsSync() ) {
                if ( !/^project\:(add|import)/.test(cmd.task) ) {
                    console.warn('Project manifest.json not found. Trying to fix it ...');
                    // return process.exit(1);
                }

                // Creating default manifest
                var conf        = _(getPath('gina').core +'/template/conf/manifest.json', true);
                var contentFile = require(conf);
                var dic = {
                    "project"   : cmd.projectName,
                    "version"   : "1.0.0",
                    "scope"     : cmd.mainConfig['def_scope'][ GINA_SHORT_VERSION ]
                };

                contentFile = whisper(dic, contentFile); //data
                lib.generator.createFileFromDataSync(
                    contentFile,
                    _(cmd.projectManifestPath, true)
                )
            }


            cmd.projectData         = requireJSON(cmd.projectManifestPath);

            cmd.projectHomedir      = (
                                        typeof(cmd.projects[cmd.projectName].homedir) != 'undefined'
                                        && cmd.projects[cmd.projectName].homedir != ''
                                        && cmd.projects[cmd.projectName].homedir != 'null'
                                        && cmd.projects[cmd.projectName].homedir != null
                                    ) ? _(cmd.projects[cmd.projectName].homedir, true)
                                    : _(getUserHome() +'/.'+ cmd.projectName, true);
            var projectHomedirObject = new _(cmd.projectHomedir, true);
            console.debug('Creating project homedir');
            if (projectHomedirObject.existsSync() && !projectHomedirObject.isDirectory() ) {
                throw new Error('Found ' + projectHomedirObject.toString() + ': but it appears to be a symbolik link !');
            } else if (!projectHomedirObject.existsSync() ) {
                projectHomedirObject.mkdirSync();
                cmd.projects[cmd.projectName].homedir = projectHomedirObject.toString();
            }

            if (
                typeof(cmd.projects[cmd.projectName].homedir) == 'undefined'
                || cmd.projects[cmd.projectName].homedir != projectHomedirObject.toString()
            ) {
                cmd.projects[cmd.projectName].homedir = projectHomedirObject.toString()
            }

            // bundles
            var projectBundlesPathObj = new _(cmd.projects[cmd.projectName].homedir +'/bundles', true);
            if (!projectBundlesPathObj.existsSync() ) {
                projectBundlesPathObj.mkdirSync();
            }
            cmd.projectBundlesPath = projectBundlesPathObj.toString();
            // bundles symlink
            var bundlesLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/bundles', true);
            if (
                bundlesLinkPathObj.existsSync()
                && !bundlesLinkPathObj.isSymlinkSync()
                ||
                bundlesLinkPathObj.existsSync()
                && fs.readlinkSync(bundlesLinkPathObj.toString()) != cmd.projectBundlesPath
            ) {
                bundlesLinkPathObj.rmSync();
            }
            if (!bundlesLinkPathObj.existsSync()) {
                projectBundlesPathObj.symlinkSync(bundlesLinkPathObj.toString());
            }
            projectBundlesPathObj = null;

            // releases
            var projectReleasesPathObj = new _(cmd.projects[cmd.projectName].homedir +'/releases', true);
            if (!projectReleasesPathObj.existsSync() ) {
                projectReleasesPathObj.mkdirSync();
            }
            cmd.projectReleasesPath = projectReleasesPathObj.toString();
            // releases symlink
            var releaseLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/releases', true);
            if (
                releaseLinkPathObj.existsSync()
                && !releaseLinkPathObj.isSymlinkSync()
                ||
                releaseLinkPathObj.existsSync()
                && fs.readlinkSync(releaseLinkPathObj.toString()) != cmd.projectReleasesPath
            ) {
                releaseLinkPathObj.rmSync();
            }
            if (!releaseLinkPathObj.existsSync()) {
                projectReleasesPathObj.symlinkSync(releaseLinkPathObj.toString());
            }

            projectReleasesPathObj = null;

            // logs
            var projectLogsPathObj = new _(cmd.projects[cmd.projectName].homedir +'/var/logs', true);
            if (!projectLogsPathObj.existsSync() ) {
                projectLogsPathObj.mkdirSync();
            }
            cmd.projectLogsPath = projectLogsPathObj.toString();
            // logs symlink
            var logLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/logs', true);
            if (
                logLinkPathObj.existsSync()
                && !logLinkPathObj.isSymlinkSync()
                ||
                logLinkPathObj.existsSync()
                && fs.readlinkSync(logLinkPathObj.toString()) != cmd.projectLogsPath
            ) {
                logLinkPathObj.rmSync();
            }
            if (!logLinkPathObj.existsSync()) {
                projectLogsPathObj.symlinkSync(logLinkPathObj.toString());
            }
            projectLogsPathObj = null;

            // tmp
            var projectTmpPathObj = new _(cmd.projects[cmd.projectName].homedir +'/tmp', true);
            if (!projectTmpPathObj.existsSync() ) {
                projectTmpPathObj.mkdirSync();
            }
            cmd.projectTmpPath = projectTmpPathObj.toString();
            // tmp symlink
            var tmpLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/tmp', true);
            if (
                tmpLinkPathObj.existsSync()
                && !tmpLinkPathObj.isSymlinkSync()
                ||
                tmpLinkPathObj.existsSync()
                && fs.readlinkSync(tmpLinkPathObj.toString()) != cmd.projectTmpPath
            ) {
                tmpLinkPathObj.rmSync();
            }
            if (!tmpLinkPathObj.existsSync()) {
                projectTmpPathObj.symlinkSync(tmpLinkPathObj.toString());
            }
            projectTmpPathObj = null;


            cmd.projectLocation     = _(cmd.projects[cmd.projectName].path, true);
            cmd.bundlesLocation     = _(cmd.projects[cmd.projectName].path +'/src', true);
            cmd.envPath             = _(cmd.projects[cmd.projectName].path + '/env.json', true);
            // For safety precaution
            if ( ! new _(cmd.envPath).existsSync() ) {
                if ( !/^project\:(add|import)/.test(cmd.task) ) {
                    console.warn('Project env.json not found. Trying to fix it ...');
                    // return process.exit(1);
                }

                // Creating default manifest
                lib.generator.createFileFromDataSync(
                    {},
                    cmd.envPath
                )
            }

            if (fs.existsSync(cmd.projectLocation) ) {
                cmd.projects[cmd.projectName].exists = true;
            } else {
                cmd.projects[cmd.projectName].exists = false;
                return;
            }


            if (typeof(require.cache[cmd.envPath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.envPath)]
            }
            console.debug('[ ConfigAssetsLoaderHelper ] envPath ', cmd.envPath);
            cmd.envData = requireJSON(cmd.envPath);

            cmd.def_framework_short = ( typeof(cmd.projects[cmd.projectName].framework) != 'undefined' ) ? (cmd.projects[cmd.projectName].framework.replace(/^v/, '').split(/\./g).splice(0,2)).join('.') : (cmd.mainConfig.def_framework.split(/\./g).splice(0,2)).join('.');
            console.debug('default def_framework_short ', cmd.def_framework_short);



            // Getting default scopes list
            cmd.scopes = (
                            cmd.projectName != null
                            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                            && Array.isArray(cmd.projects[cmd.projectName]['scopes'])
                            && cmd.projects[cmd.projectName]['scopes'].length > 0
                        ) ? cmd.projects[cmd.projectName]['scopes'] : cmd.mainConfig['scopes'][ GINA_SHORT_VERSION ];
            // Getting default scope
            cmd.defaultScope = (
                            cmd.projectName != null
                            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                            && typeof(cmd.projects[cmd.projectName]['def_scope']) != 'undefined'
                            && cmd.projects[cmd.projectName]['def_scope']
                        ) ? cmd.projects[cmd.projectName]['def_scope'] : cmd.mainConfig['def_scope'][ GINA_SHORT_VERSION ];
            // Getting local scope
            cmd.localScope = (
                                cmd.projectName != null
                                && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                                && typeof(cmd.projects[cmd.projectName]['local_scope']) != 'undefined'
                                && cmd.projects[cmd.projectName]['local_scope']
                            ) ? cmd.projects[cmd.projectName]['local_scope'] : cmd.mainConfig['local_scope'][ GINA_SHORT_VERSION ];
            // Getting production scope
            cmd.productionScope = (
                                cmd.projectName != null
                                && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                                && typeof(cmd.projects[cmd.projectName]['production_scope']) != 'undefined'
                                && cmd.projects[cmd.projectName]['production_scope']
                            ) ? cmd.projects[cmd.projectName]['production_scope'] : cmd.mainConfig['production_scope'][ GINA_SHORT_VERSION ];
            // Project or bundle scope override through : --scope=<some scope>
            if ( typeof(cmd.params.scope) != 'undefined' && /\:(start|stop|restart|build|deploy)/i.test(cmd.task) ) {
                console.debug('Overriding default project scope: '+ cmd.defaultScope +' => '+ cmd.params.scope);
                if (cmd.scopes.indexOf(cmd.params.scope) < 0) {
                    errMsg = 'Scope `'+ cmd.params.scope +'` not found in your project ['+ cmd.projectName +']';
                    console.error(errMsg);
                    return false;
                }
                cmd.defaultScope = process.env.NODE_SCOPE = cmd.params.scope;
            } else {
                delete process.env.NODE_SCOPE
            }
            cmd.scopes.sort();

            // getting default envs list
            cmd.envs = (
                            cmd.projectName != null
                            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                            && Array.isArray(cmd.projects[cmd.projectName]['envs'])
                            && cmd.projects[cmd.projectName]['envs'].length > 0
                        ) ? cmd.projects[cmd.projectName]['envs'] : cmd.mainConfig['envs'][ GINA_SHORT_VERSION ];
            // getting default env
            cmd.defaultEnv = (
                                cmd.projectName != null
                                && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                                && typeof(cmd.projects[cmd.projectName]['def_env']) != 'undefined'
                                && cmd.projects[cmd.projectName]['def_env']
                            ) ? cmd.projects[cmd.projectName]['def_env'] : cmd.mainConfig['def_env'][ GINA_SHORT_VERSION ];
            // getting dev env
            cmd.devEnv = (
                            cmd.projectName != null
                            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
                            && typeof(cmd.projects[cmd.projectName]['dev_env']) != 'undefined'
                            && cmd.projects[cmd.projectName]['dev_env']
                        ) ? cmd.projects[cmd.projectName]['dev_env'] : cmd.mainConfig['dev_env'][ GINA_SHORT_VERSION ];


            //cmd.bundlesByProject[cmd.projectName][cmd.name].def_env = cmd.defaultEnv; // by default
            // project or bundle environment override through : --env=<some env>
            if ( typeof(cmd.params.env) != 'undefined' && /\:(start|stop|restart|build|deploy)/i.test(cmd.task) ) {
                console.debug('Overriding default project env: '+ cmd.defaultEnv +' => '+ cmd.params.env);
                if (cmd.envs.indexOf(cmd.params.env) < 0) {
                    errMsg = 'Environment `'+ cmd.params.env +'` not found in your project ['+ cmd.projectName +']';
                    console.emerg(errMsg);
                    return false;
                }
                cmd.defaultEnv = process.env.NODE_ENV = cmd.params.env;
                // override
                //cmd.bundlesByProject[cmd.projectName][cmd.name].def_env = cmd.params.env;
            } else {
                delete process.env.NODE_ENV
            }
            cmd.envs.sort();

            // project or bundle scope override through : --scope=<some scope>
            if ( typeof(cmd.params.scope) != 'undefined' && /\:(start|stop|restart|build|deploy)/i.test(cmd.task) ) {
                console.debug('Overriding default project scope: '+ cmd.defaultScope +' => '+ cmd.params.scope);
                if (cmd.scopes.indexOf(cmd.params.scope) < 0) {
                    errMsg = 'Scope `'+ cmd.params.scope +'` not found in your project ['+ cmd.projectName +']';
                    console.emerg(errMsg);
                    return false;
                }
                cmd.defaultScope = process.env.NODE_SCOPE = cmd.params.scope;
                // override
                //cmd.bundlesByProject[cmd.projectName][cmd.name].def_scope = cmd.params.scope;
            } else {
                delete process.env.NODE_SCOPE
            }
            cmd.scopes.sort();



            // updating default protocols list
            cmd.protocols = [];
            for (let p in cmd.projects[cmd.projectName].protocols) {
                cmd.protocols.push(cmd.projects[cmd.projectName].protocols[p])
            }
            if ( !cmd.protocols.length ) {
                var defProtocols = cmd.mainConfig.protocols[cmd.def_framework_short];
                console.debug('default protocols ', defProtocols);
                for (let p in defProtocols) {
                    cmd.protocols.push(defProtocols[p]);
                }
            }
            //cmd.protocols.sort();
            // updating default schemes list
            cmd.schemes = [];
            for (let s in cmd.projects[cmd.projectName].schemes) {
                cmd.schemes.push(cmd.projects[cmd.projectName].schemes[s])
            }
            if ( !cmd.schemes.length ) {
                var defSchemes = cmd.mainConfig.schemes[cmd.def_framework_short];
                console.debug('default schemes ', defSchemes);
                for (let s in defSchemes) {
                    cmd.schemes.push(defSchemes[s]);
                }
            }
            //cmd.schemes.sort();

            if ( typeof(require.cache[cmd.portsPath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.portsPath)]
            }
            cmd.portsData          = requireJSON(cmd.portsPath) || {};

            if ( typeof(require.cache[cmd.portsReversePath]) != 'undefined') {
                delete require.cache[require.resolve(cmd.portsReversePath)]
            }
            cmd.portsReverseData   = requireJSON(cmd.portsReversePath) || {};



            ports = JSON.clone(cmd.portsData);

            var re = null;
            //console.debug('[ ConfigAssetsLoaderHelper ] Loaded bundles list\n'+ JSON.stringify(cmd.bundles, null, 4));

            // protocols & schemes list: for the project
            re = new RegExp('\@' + cmd.projectName, '');

            for (let protocol in ports) {
                if ( typeof(cmd.portsData[protocol]) == 'undefined')
                    cmd.portsData[protocol] = {};

                for (let scheme in ports[protocol]) {
                    if ( typeof(cmd.portsData[protocol][scheme]) == 'undefined')
                        cmd.portsData[protocol][scheme] = {};

                    for (let port in ports[protocol][scheme]) {
                        // updating protocols list
                        if (cmd.protocols.indexOf(protocol) < 0 && re.test(ports[protocol][scheme][port])) {
                            //cmd.protocols.push(protocol);
                            if (typeof(cmd.portsData[protocol][scheme][port]) == 'undefined')
                                cmd.portsData[protocol][scheme][port] = {}
                        }

                        // updating schemes list
                        if (cmd.schemes.indexOf(scheme) < 0 && re.test(ports[protocol][scheme][port])) {
                            //cmd.schemes.push(scheme);
                            if (typeof(cmd.portsData[protocol][scheme][port]) == 'undefined')
                                cmd.portsData[protocol][scheme][port] = {}
                        }

                        // updating port list
                        //if (cmd.portsList.indexOf(protocol) < 0 && re.test(ports[protocol][scheme][port])) {
                        if (cmd.portsList.indexOf(port) < 0 && re.test(ports[protocol][scheme][port])) {
                            cmd.portsList.push(port);
                            cmd.portsData[protocol][scheme][port] = ports[protocol][scheme][port]
                        }
                    }
                }
            }

            cmd.configured = true;


            // linking gina
            if (
                cmd.projectName != null
                && /^true$/i.test(GINA_GLOBAL_MODE)
                && !/\:(link|link-node-modules)$/.test(cmd.task)
            ) {
                if (
                    /project\:(restart|start|stop)$/.test(cmd.task)
                    ||
                    /bundle\:(restart|start|stop)$/.test(cmd.task)
                ) {
                    console.debug('Running: gina link-node-modules @'+cmd.projectName);
                    err = execSync('gina link-node-modules @'+cmd.projectName);// +' --inspect-gina'
                    if (err instanceof Error) {
                        console.error(err.message || err.stack);
                        return exit(err.message || err.stack);
                    }
                }


                console.debug('Running: gina link @'+cmd.projectName);
                err = execSync('gina link @'+cmd.projectName);// +' --inspect-gina'
                if (err instanceof Error) {
                    console.error(err.message || err.stack);
                    return exit(err.message || err.stack);
                }
            }


        }

        //console.debug('[ ConfigAssetsLoaderHelper ] Loaded portsData\n'+ JSON.stringify(cmd.portsData, null, 4));
        // sorting
        cmd.protocols.sort();
        cmd.schemes.sort();

        // // getting default envs list
        // cmd.envs = (cmd.projectName != null && typeof(cmd.projects[cmd.projectName]) != 'undefined') ? cmd.projects[cmd.projectName]['envs'] : cmd.mainConfig['envs'][ GINA_SHORT_VERSION ];
        // // getting default env
        // cmd.defaultEnv = (cmd.projectName != null && typeof(cmd.projects[cmd.projectName]) != 'undefined' ) ? cmd.projects[cmd.projectName]['def_env'] : cmd.mainConfig['def_env'][ GINA_SHORT_VERSION ];
        // // getting dev env
        // cmd.devEnv = (cmd.projectName != null &&typeof(cmd.projects[cmd.projectName]) != 'undefined' ) ? cmd.projects[cmd.projectName]['dev_env'] : cmd.mainConfig['dev_env'][ GINA_SHORT_VERSION ];
        // //cmd.bundlesByProject[cmd.projectName][cmd.name].def_env = cmd.defaultEnv; // by default
        // // project or bundle environment override through : --env=<some env>
        // if ( typeof(cmd.params.env) != 'undefined' && /\:(start|stop|restart|build|deploy)/i.test(cmd.task) ) {
        //     console.debug('Overriding default project env: '+ cmd.defaultEnv +' => '+ cmd.params.env);
        //     if (cmd.envs.indexOf(cmd.params.env) < 0) {
        //         errMsg = 'Environment `'+ cmd.params.env +'` not found in your project ['+ cmd.projectName +']';
        //         console.error(errMsg);
        //         return false;
        //     }
        //     cmd.defaultEnv = process.env.NODE_ENV = cmd.params.env;
        //     // override
        //     //cmd.bundlesByProject[cmd.projectName][cmd.name].def_env = cmd.params.env;
        // } else {
        //     delete process.env.NODE_ENV
        // }

        // available protocols
        cmd.protocolsAvailable = cmd.mainConfig.protocols[GINA_SHORT_VERSION];
        // getting default protocol
        cmd.defaultProtocol = (cmd.projectName != null && typeof(cmd.projects[cmd.projectName]) != 'undefined' && typeof(cmd.projects[cmd.projectName]['def_protocol']) != 'undefined' ) ? cmd.projects[cmd.projectName]['def_protocol'] : cmd.mainConfig['def_protocol'][ GINA_SHORT_VERSION ];
        if (cmd.protocolsAvailable.indexOf(cmd.defaultProtocol) < 0) {
            cmd.defaultProtocol = cmd.protocolsAvailable[0]; //take the first one by default if no match
        }

        // available schemes
        cmd.schemesAvailable = cmd.mainConfig.schemes[GINA_SHORT_VERSION];
        // getting default scheme
        cmd.defaultScheme = (cmd.projectName != null && typeof(cmd.projects[cmd.projectName]) != 'undefined' && typeof(cmd.projects[cmd.projectName]['def_scheme']) != 'undefined' ) ? cmd.projects[cmd.projectName]['def_scheme'] : cmd.mainConfig['def_scheme'][ GINA_SHORT_VERSION ];
        if (cmd.schemesAvailable.indexOf(cmd.defaultScheme) < 0) {
            cmd.defaultScheme = cmd.schemesAvailable[0]; //take the first one by default if no match
        }

        // global & currnet project ports list
        if (typeof (require.cache[cmd.portsPath]) != 'undefined') {
            delete require.cache[require.resolve(cmd.portsPath)]
        }

        ports = requireJSON(cmd.portsPath);
        portsReverse = requireJSON(cmd.portsReversePath);

        // protocols list
        if (cmd.protocols.length == 0)
            cmd.protocols = [];
        // schemes list
        if (cmd.schemes.length == 0)
            cmd.schemes = [];
        // setting port list
        var hasProject = false, re = null;
        if ( cmd.projectName != null && typeof(cmd.projects[cmd.projectName]) != 'undefined' ) {
            hasProject = true;
            re = new RegExp('\@'+ cmd.projectName +'\/', '');

            if ( cmd.name != null ) {
                re = new RegExp(cmd.name + '\@'+ cmd.projectName +'\/', '');
            }
        }

        for (let protocol in ports) {
            if ( !protocol || protocol == 'undefined' ) continue;
            for (let scheme in ports[protocol]) {
                if ( !scheme || scheme == 'undefined' ) continue;
                for (let port in ports[protocol][scheme]) {
                    cmd.portsGlobalList.push(~~port); // updating global ports list

                    if ( hasProject && re.test(ports[protocol][scheme][port]) && cmd.portsList.indexOf(port) < 0 ) {
                        cmd.portsList.push(port) // updating contextual ports list

                        // updating protocols list
                        if ( re.test(ports[protocol][scheme][port]) ) {
                            if ( cmd.protocols.indexOf(protocol) < 0 )
                                cmd.protocols.push(protocol); // updating contextual protocol list
                            if ( cmd.schemes.indexOf(scheme) < 0 )
                                cmd.schemes.push(scheme); // updating contextual protocol list
                        }
                    }

                }
            }
        }
        //console.debug('Got Global Ports List ', cmd.portsGlobalList);

        if ( !cmd.portsData.count() )
            cmd.portsData = ports;

        if ( !cmd.portsReverseData.count() )
            cmd.portsReverseData = portsReverse;

        if (cmd.protocols.length > 0)
            cmd.protocols.sort();

        if (cmd.schemes.length > 0)
            cmd.schemes.sort();

        // supplementing projects with bundles collection

        //console.debug('[ ConfigAssetsLoaderHelper ] getting bundles by project ', JSON.stringify(cmd.projects, null, 4));
        for (let project in cmd.projects) {

            let projectPropertiesPath = _(cmd.projects[project].path + '/manifest.json', true);
            if (typeof (require.cache[projectPropertiesPath]) != 'undefined') {
                delete require.cache[require.resolve(projectPropertiesPath)]
            }
            cmd.bundlesByProject[project] = (typeof(cmd.bundlesByProject[project]) != 'undefined' ) ? cmd.bundlesByProject[project] : {};
            if (fs.existsSync(cmd.projects[project].path) ) {
                cmd.projects[project].exists    = true;
                if ( !new _(projectPropertiesPath).existsSync() ) {
                    console.error('`'+ projectPropertiesPath +'` not found ! Maybe, you can try to remove the project reference by hand by editing: `'+ _(GINA_HOMEDIR + '/project.json') +'`')
                }

                cmd.bundlesByProject[project]   = (cmd.bundlesByProject[project].count() > 0) ? cmd.bundlesByProject[project] : requireJSON(projectPropertiesPath).bundles;
                // additional checks
                let bundlesCount = cmd.bundlesByProject[project].count();
                if ( /^project\:(add|import)/.test(cmd.task) && bundlesCount > 0 ) {
                    let releasesPathObj = new _(cmd.projects[project].path +'/releases', true);
                    let _bundleConfigPath = cmd.bundlesLocation;
                    let files = [], f = 0;
                    if ( new _(cmd.projects[project].path +'/src', true).existsSync() ) {
                        files = fs.readdirSync(_(cmd.projects[project].path +'/src', true));
                    } else if (releasesPathObj.existsSync()) {
                        _bundleConfigPath = releasesPathObj.toString();
                        files = fs.readdirSync(releasesPathObj.toString());
                    }
                    let _count = 0;
                    for (;f < files.length; ++f) {
                        // skip hidden
                        let name = files[f];
                        if ( /^\./.test(name) ) continue;
                        _count++
                    }
                    if (_count != bundlesCount) {
                        cmd.bundles = [];
                        cmd.bundlesByProject[project] = {}
                        let updatedManifest = requireJSON(projectPropertiesPath);
                        updatedManifest.bundles = {};
                        lib.generator.createFileFromDataSync(
                            updatedManifest,
                            projectPropertiesPath
                        )
                    }
                }

            } else {
                cmd.projects[project].exists    = false;
            }
        }



        var bundleConfigPath = null, settings = null, isBulkOperation = false;
        for (let project in cmd.bundlesByProject) { // for each project

            if (!cmd.bundlesByProject[project]) continue;

            if (
                !cmd.bundles.length && /^bundle\:/.test(cmd.task)
                && project == cmd.projectName
            ) {
                isBulkOperation = true;
            }

            for (let bundle in cmd.bundlesByProject[project]) { // for each bundle
                // bundles array list
                if (
                    !/^bundle\:/.test(cmd.task)
                    && cmd.bundles.indexOf(bundle) < 0
                    && cmd.projectName != null
                    && project == cmd.projectName
                    ||
                    isBulkOperation
                    && project == cmd.projectName
                ) {
                    cmd.bundles.push(bundle);
                }



                if ( typeof(cmd.bundlesByProject[project][bundle].protocols) == 'undefined' ) {
                    cmd.bundlesByProject[project][bundle].protocols = []
                }
                if ( typeof(cmd.bundlesByProject[project][bundle].schemes) == 'undefined' ) {
                    cmd.bundlesByProject[project][bundle].schemes = []
                }

                // bundle default environment inherits project's default environement
                cmd.bundlesByProject[project][bundle].defaultEnv = cmd.projects[project].def_env;

                // adding project available protocols & schemes to the bundle
                cmd.bundlesByProject[project][bundle].protocols = cmd.projects[project].protocols;
                cmd.bundlesByProject[project][bundle].def_protocol = cmd.defaultProtocol;

                cmd.bundlesByProject[project][bundle].schemes   = cmd.projects[project].schemes;
                cmd.bundlesByProject[project][bundle].def_scheme = cmd.defaultScheme;

                if ( fs.existsSync(_(cmd.projectLocation + '/'+ cmd.bundlesByProject[project][bundle].src )) ) {
                    cmd.bundlesByProject[project][bundle].exists = true;
                    // adding configurations
                    bundleConfigPath = _(cmd.projectLocation + '/'+ cmd.bundlesByProject[project][bundle].src +'/config' );
                    cmd.bundlesByProject[project][bundle].configPaths = {
                        settings: _(bundleConfigPath +'/settings.json')
                    };
                    // adding protocol & scheme found in the bunble settings
                    if ( fs.existsSync(cmd.bundlesByProject[project][bundle].configPaths.settings) ) {

                        settings = requireJSON(cmd.bundlesByProject[project][bundle].configPaths.settings);
                        if (
                            typeof(settings.server) != 'undefined'
                            && typeof(settings.server.protocol) != 'undefined'
                        ) {
                            // adding in case of bad configuration : exists in bundle, but not listed in available/global settings
                            if (cmd.bundlesByProject[project][bundle].protocols.indexOf(settings.server.protocol) < 0)
                                cmd.bundlesByProject[project][bundle].protocols.push(settings.server.protocol);

                            cmd.bundlesByProject[project][bundle].def_protocol = settings.server.protocol
                        }

                        if (
                            typeof(settings.server) != 'undefined'
                            && typeof(settings.server.scheme) != 'undefined'
                        ) {
                            // adding in case of bad configuration : exists in bundle, but not listed in available/global settings
                            if (cmd.bundlesByProject[project][bundle].schemes.indexOf(settings.server.scheme) < 0)
                                cmd.bundlesByProject[project][bundle].schemes.push(settings.server.scheme);

                            cmd.bundlesByProject[project][bundle].def_scheme = settings.server.scheme
                        }
                    }

                    cmd.bundlesByProject[cmd.projectName][bundle].def_env = (cmd.params.env) ? cmd.params.env : cmd.defaultEnv; // by default


                } else {
                    cmd.bundlesByProject[project][bundle].exists = false;
                }
            }
        }



        // control the bundle name
        // no existing project found for the bundle
        if ( cmd.projectName != null && cmd.name != null && typeof(cmd.projects[cmd.projectName]) == 'undefined' ) {
            return false;
        }
        if (
            /bundle\:/.test(cmd.task)
            && cmd.projectName != null
            && cmd.name != null
            && typeof(cmd.bundlesByProject[cmd.projectName][cmd.name]) == 'undefined'
        ) {

            errMsg = 'Bundle name `'+ cmd.name +'` not found in your project `@'+ cmd.projectName +'`';
            //console.debug('task `'+ cmd.task +'` error:');
            if ( cmd.task != 'bundle:add' ) {
                console.warn(errMsg);
            }
            return false;
        }

        if (
            /^project\:(add|import)/.test(cmd.task)
            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
            && !cmd.bundles.length
        ) {
            var releasesPathObj = new _(cmd.projects[cmd.projectName].path +'/releases', true);
            var _bundleConfigPath = cmd.bundlesLocation;
            var files = [], f = 0;
            if ( new _(cmd.bundlesLocation).existsSync() ) {
                files = fs.readdirSync(cmd.bundlesLocation);
            } else if (releasesPathObj.existsSync()) {
                _bundleConfigPath = releasesPathObj.toString();
                files = fs.readdirSync(releasesPathObj.toString());
            }
            for (;f < files.length; ++f) {
                // skip hidden
                let name = files[f];
                if ( /^\./.test(name) ) continue;
                cmd.bundles.push(name);
                _bundleConfigPath += '/'+ name;
                cmd.bundlesByProject[cmd.projectName][name] = {
                    configPaths: {
                        settings: _(_bundleConfigPath +'/config/settings.json', true)
                    }
                };
            }
            cmd.bundles.sort()
        }

    }


    /**
     * isDefined
     *
     * @param {string} type [ project | bundle | env ]
     * @param {string} name
     *
     * @returns {boolean} exists
     * */
    isDefined = function(type, name) {

        if (
            typeof(name) == 'undefined'
            || typeof(name) != 'undefined' && name == ''
            || typeof(name) != 'undefined' && name == null
        ) {
            throw new Error('isDefined Error : name cannot be undefined, null or blank !')
        }

        switch (type) {

            case 'project':
                return ( typeof(cmd.projects) != 'undefined' && typeof(cmd.projects[name]) != 'undefined' && cmd.projects[name] != null && cmd.projects[name] != '' ) ? true : false;

            case 'bundle':
                return ( typeof(cmd.portsReverseData) != 'undefined' &&  typeof(cmd.portsReverseData[ name +'@'+ cmd.projectName ]) != 'undefined' ) ? true : false;

            case 'env':
                return ( typeof(cmd.envs) != 'undefined' && cmd.envs.indexOf(name) > -1 ) ? true : false;

            case 'scope':
                return ( typeof(cmd.scopes) != 'undefined' && cmd.scopes.indexOf(name) > -1 ) ? true : false;

            default:
                return false;
        }
    }

    /**
     * isValidName
     * test if a given [ project | bundle | env] name is valid or not
     * */
    isValidName = function(name) {

        if ( typeof(name) == 'undefined' || name == null || name == undefined || name == '')
            return false;

        return /^[a-z0-9_.]/.test( name.replace('@', '') )
    }

    /**
     * getHelp
     *
     * Output current help.txt
     * */
    getHelp = function () {

        var taskGroup   = cmd.task.split(/:/)[0]
            , file      = _( __dirname +'/'+ taskGroup +'/help.txt', true )
            , errMsg    = 'No help available for `'+ taskGroup +'` command line at the moment. Please try again on the next release';

        console.log('file ', file);
        if ( !fs.existsSync(file) ) {

            console.error(errMsg);
            exit(errMsg);
            return false;
        }

        try {
            console.log( '\n' + fs.readFileSync( file ) )
        } catch(err) {
            console.error( err.stack )
        }
    }

    getBundleScanLimit = function(bundle, env) {
        var limit           = null
            , i             = 0
            , maxLimit      = cmd.projects[cmd.projectName].envs.length * cmd.projects[cmd.projectName].protocols.length * cmd.projects[cmd.projectName].schemes.length
            , portsReverse  = cmd.portsReverseData[bundle +'@'+ cmd.projectName]
        ;

        if ( typeof(env) != 'undefined' ) {
            maxLimit        = cmd.projects[cmd.projectName].protocols.length * cmd.projects[cmd.projectName].schemes.length;
            portsReverse    = cmd.portsReverseData[bundle +'@'+ cmd.projectName][env];
            for ( let protocol in portsReverse[env]) {
                for (let scheme in portsReverse[env][protocol]) {
                    ++i;
                }
            }
            limit = maxLimit - i;
        } else {
            for (let env in portsReverse) {
                for (let protocol in portsReverse[env]) {
                    for (let scheme in portsReverse[env][protocol]) {
                        ++i;
                    }
                }
            }
            limit = maxLimit - i;
        }

        return limit;
    }

    getPortsList = function() {
        var ports = require(_(GINA_HOMEDIR + '/ports.json'));
        var portsList = []; // list of all ports to ignore whles scanning
        var protocols = cmd.projects[cmd.projectName].protocols;
        var schemes = cmd.projects[cmd.projectName].schemes;
        for (let protocol in ports) {
            if (protocols.indexOf(protocol) < 0) continue;
            for (let scheme in ports[protocol]) {
                if (schemes.indexOf(scheme) < 0) continue;
                for (let p in ports[protocol][scheme]) {
                    if ( cmd.portsList.indexOf(p) > -1 ) continue;
                    portsList.push(''+p)
                }
            }
        }
        // double checking
        var portsReverse = require(_(GINA_HOMEDIR + '/ports.reverse.json'));
        for (let bundle in portsReverse) {
            for (let env in portsReverse[bundle]) {
                for (let protocole in portsReverse[bundle][env]) {
                    for (let scheme in portsReverse[bundle][env][protocole]) {
                        let p = portsReverse[bundle][env][protocole][scheme];
                        if ( portsList.indexOf(''+p) < 0 ) {

                            portsList.push(''+p)
                        }
                    }
                }
            }
        }

        portsList.sort();

        return portsList;
    }

    /**
     * setPorts
     * Setting bundle ports per env
     *
     * @param {string} bundle
     * @param {array} portsAvailable
     *
     * @callback cb
    */
    setPorts = function(bundle, portsAvailable, cb) {
        var portsPath           = _(GINA_HOMEDIR + '/ports.json', true)
            , portsReversePath  = _(GINA_HOMEDIR + '/ports.reverse.json', true)
            , envDataPath       = _(cmd.projects[cmd.projectName].path + '/env.json', true)
        ;

        if ( typeof(require.cache[portsPath]) != 'undefined') {
            delete require.cache[require.resolve(portsPath)]
        }
        if ( typeof(require.cache[portsReversePath]) != 'undefined') {
            delete require.cache[require.resolve(portsReversePath)]
        }
        if ( typeof(require.cache[envDataPath]) != 'undefined') {
            delete require.cache[require.resolve(envDataPath)]
        }

        var envData             = requireJSON(envDataPath)
            , portsData         = requireJSON(portsPath)
            , portsReverseData  = requireJSON(portsReversePath)
        ;


        var content                 = JSON.clone(envData)
            , ports                 = JSON.clone(portsData)
            , portsReverse          = JSON.clone(portsReverseData)
            , allProjectEnvs        = cmd.projects[cmd.projectName].envs
            , allProjectProtocols   = cmd.projects[cmd.projectName].protocols
            , allProjectSchemes     = cmd.projects[cmd.projectName].schemes
        ;



        // BO project/env.json
        if ( typeof(content[bundle]) == 'undefined' ) {
            content[bundle] = {}
        }

        // getting available all envs
        for (let n in cmd.envs) {
            let newEnv = cmd.envs[n];
            if (allProjectEnvs.indexOf(newEnv) < 0) {
                console.debug('adding new env ['+newEnv+'] VS' + JSON.stringify(cmd.envs, null, 2));
                allProjectEnvs.push(newEnv);
            }
        }

        // getting available all protocols
        for (let p in cmd.protocols) {
            let newProtocol = allProjectProtocols[p];
            if (allProjectProtocols.indexOf(newProtocol) < 0) {
                console.debug('adding new protocol ['+newProtocol+'] VS' + JSON.stringify(cmd.protocols, null, 2));
                allProjectProtocols.push(newProtocol);
            }
        }
        // getting available all schemes
        for (let p in cmd.schemes) {
            let newScheme = allProjectSchemes[p];
            if (allProjectSchemes.indexOf(newScheme) < 0) {
                console.debug('adding new scheme ['+newScheme+'] VS' + JSON.stringify(cmd.schemes, null, 2));
                allProjectSchemes.push(newScheme);
            }
        }
        // EO project/env.json





        for (let e in allProjectEnvs) { // ports are to be set for each env
            let env = allProjectEnvs[e];

            // editing env.json to add host infos
            if ( typeof(content[bundle][env]) == 'undefined' ) {
                content[bundle][env] = {}
            }
            if ( typeof(content[bundle][env].host) == 'undefined' ) {
                content[bundle][env].host = "localhost"
            }


            // BO ~/.gina/ports.reverse.json - part 1/2
            if ( typeof(portsReverse[bundle + '@' + cmd.projectName]) == 'undefined' ) {
                portsReverse[bundle + '@' + cmd.projectName] = {}
            }
            if (
                typeof(portsReverse[bundle + '@' + cmd.projectName][env]) == 'undefined'
                ||
                /^string$/i.test( typeof(portsReverse[bundle + '@' + cmd.projectName][env]) )
            ) {
                portsReverse[bundle + '@' + cmd.projectName][env] = {}
            }
            // EO ~/.gina/ports.reverse.json - part 1/2


            // BO ~/.gina/ports.json
            for (let p in allProjectProtocols) {
                let protocol = allProjectProtocols[p];
                if ( typeof(ports[protocol]) == 'undefined' ) {
                    ports[protocol] = {}
                }
                if ( typeof(portsReverse[bundle + '@' + cmd.projectName][env][protocol]) == 'undefined' ) {
                    portsReverse[bundle + '@' + cmd.projectName][env][protocol] = {}
                }
                for (let s in allProjectSchemes) {
                    let scheme = allProjectSchemes[s];
                    // skipping none `https` schemes for `http/2`
                    if ( /^http\/2/.test(protocol) && scheme != 'https' ) {
                        // console.debug('skipping none `https` schemes for `http/2`');
                        continue;
                    }
                    if ( typeof(ports[protocol][scheme]) == 'undefined' ) {
                        ports[protocol][scheme] = {}
                    }
                    if ( typeof(portsReverse[bundle + '@' + cmd.projectName][env][protocol][scheme]) == 'undefined' ) {
                        portsReverse[bundle + '@' + cmd.projectName][env][protocol][scheme] = {}
                    }

                    let assigned = [];
                    if ( ports[protocol][scheme].count() > 0 ) {
                        for (let port in ports[protocol][scheme]) {
                            let portDescription = ports[protocol][scheme][port] || null;
                            // already assigned
                            if ( portDescription && assigned.indexOf(portDescription) > -1 ) {
                                // cleanup
                                delete ports[protocol][scheme][port];
                                portsAvailable.unshift(port);
                                continue;
                            }
                            assigned.push(portDescription);
                        }
                    }


                    let stringifiedScheme = JSON.stringify(ports[protocol][scheme]);
                    let patt = new RegExp(bundle +'@'+ cmd.projectName +'/'+ env);
                    let found = false;
                    let portToAssign = null;
                    // do not override if existing
                    if ( patt.test(stringifiedScheme) ) { // there can multiple matches
                        found = true;
                        // reusing the same for portsReverse
                        let re = new RegExp('([0-9]+)\"\:(|\s+)\"('+ bundle +'\@'+ cmd.projectName +'\/'+ env +')', 'g');
                        let m;
                        while ((m = re.exec(stringifiedScheme)) !== null) {
                            // This is necessary to avoid infinite loops with zero-width matches
                            if (m.index === re.lastIndex) {
                                re.lastIndex++;
                            }
                            // The result can be accessed through the `m`-variable.
                            try {
                                m.forEach((match, groupIndex) => {
                                    //console.debug(`Found match, group ${groupIndex}: ${match}`);
                                    if (groupIndex == 1) {
                                        portToAssign = ~~match;
                                        //console.debug('['+bundle+'] port to assign '+ portToAssign + ' - ' + protocol +' '+ scheme);
                                        throw new Error('breakExeception');
                                    }
                                });
                            } catch (breakExeption) {
                                break;
                            }
                        }
                    }

                    if (!portToAssign) {
                        //console.debug('['+bundle+'] No port to assign '+ portToAssign + ' - ' + protocol +' '+ scheme);
                        portToAssign = portsAvailable[0];

                        // port is no longer available
                        portsAvailable.splice(0,1);
                    }
                    ports[protocol][scheme][portToAssign] = bundle +'@'+ cmd.projectName +'/'+ env;

                    // BO ~/.gina/ports.reverse.json - part 2/2
                    //override needed since it is relying on ports definitions
                    portsReverse[bundle + '@' + cmd.projectName][env][protocol][scheme] = ~~portToAssign;
                    // EO ~/.gina/ports.reverse.json - part 2/2

                } // EO for (let scheme in schemes)
            } // for (let protocol in protocols)
            // EO ~/.gina/ports.json
        }


        try {
            // save to /<project_path>/env.json
            lib.generator.createFileFromDataSync(content, envDataPath);
            cmd.envDataWrote = true;

            // save to ~/.gina/ports.json
            lib.generator.createFileFromDataSync(ports, portsPath);
            cmd.portsDataWrote = true;
            // save to ~/.gina/ports.reverse.json
            lib.generator.createFileFromDataSync(portsReverse, portsReversePath);
            cmd.portsReverseDataWrote = true;

            cb(false)
        } catch (err) {
            cb(err)
        }
    }

    orderBundles = function(bundles) {
        var bList = [], i = 0;
        for (let b in bundles) {
            bList[i] = bundles[b];
            bList[i].name = b;
            i++;
        }

        bList = new Collection(bList)
            .orderBy({name: 'asc'})
            .toRaw();

        var newBundles = {}
        for (let i = 0, len = bList.length; i < len; i++) {
            newBundles[ bList[i].name ] = bList[i]
        }

        return newBundles;
    }


    exit = function(errorMessage) {
        // CMD Client exit
        if ( typeof(errorMessage) != 'undefined' ) {
            client.write(errorMessage + '\n');
        }
        client.end();
        if (errorMessage) {
            process.exit(1)
        } else {
            process.exit()
        }
    }

};

module.exports = CmdHelper;