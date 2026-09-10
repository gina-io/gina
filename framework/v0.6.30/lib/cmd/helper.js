const { execSync } = require('child_process');
var fs          = require('fs');
var os          = require('os');
const { promisify } = require('util');
var console     = lib.logger;
var merge       = lib.merge;
var inherits    = lib.inherits;
var Collection  = lib.Collection;
var helpers     = require( getPath('gina').helpers);
/**
 * @module gina/lib/cmd/helper
 */
/**
 * Enriches a cmd handler's `self` object with framework configuration, project
 * data, port maps, and shared helper globals (isCmdConfigured, isDefined,
 * isValidName, getHelp, setPorts, loadAssets, exit, etc.).
 *
 * Called once at the top of every cmd handler's `init()`:
 *  new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });
 *
 * After construction, the following globals are available in the handler:
 *  - isCmdConfigured() — validates and loads all config assets; for bundle:start,
 *    also resolves self.bundleGinaVersion from --gina-version flag or
 *    manifest.json bundles[name].gina_version and validates it against main.json
 *  - isDefined(type, name) — checks project / bundle / env / scope existence
 *  - isValidName(name) — validates a project or bundle name
 *  - getHelp() — prints the command group's help.txt
 *  - setPorts(bundle, portsAvailable, cb) — allocates ports for a bundle
 *  - loadAssets() — re-reads all config files without require cache
 *  - exit(errorMessage) — writes to client and calls process.exit
 *  - getBundleScanLimit(bundle, env) — calculates remaining port slots
 *  - getPortsList() — returns sorted list of all registered ports
 *  - orderBundles(bundles) — sorts a bundles object alphabetically
 *  - getCoreEnv(bundle, env) — returns rendered core env.json for a bundle
 *
 * @class CmdHelper
 * @constructor
 * @param {object} cmd - The cmd handler's `self` object to enrich
 * @param {object} client - Socket client used by exit() to write error output
 * @param {object} debug - Debug options
 * @param {number} [debug.port] - Node.js inspector port
 * @param {boolean} [debug.brkEnabled] - True when --inspect-brk is active
 */
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
        // Params forward: when a command line is running another command line
        // E.g: gina link or gina link-node-modules
        paramsStringified: '',
        nodeParams : [],
        debugPort: debug.port,
        debugBrkEnabled: debug.brkEnabled,
        def_framework : null,
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
        warnedAbsentBundles : {}, // #B375 — once-per-command dedup for the declared-but-absent-bundle warning emitted by loadAssets()
        warnedInvalidServerSettings : {}, // #B378 — once-per-command dedup for the invalid bundle protocol/scheme warning emitted by loadAssets()

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
        portsReverseData : {}, // defined by loadAssets()
        // per-bundle gina version override (from --gina-version flag or manifest.json bundles[name].gina_version)
        bundleGinaVersion : null // defined by loadAssets()
    };


    // merging with default
    var _cmd = JSON.clone(cmd);
    _cmd = merge(_cmd, self);
    for (let prop in _cmd) {
        cmd[prop] = _cmd[prop]
    }


    /**
     * Parses process.argv for `--key[=value]` tokens.
     * Tokens listed in the command group's arguments.json are stored in
     * cmd.params; all other `--` tokens go to cmd.nodeParams (forwarded to Node).
     * Also detects --inspect-brk and sets cmd.debugBrkEnabled accordingly.
     *
     * @inner
     * @private
     */
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

                // Split on the first `=` only. Values with `=` (e.g.
                // `--driver-version=">=5.3.0 <6.0.0"`, base64-ish passwords,
                // api keys) would otherwise be silently truncated.
                var _raw = process.argv[a].replace(/--/, '');
                var _eq  = _raw.indexOf('=');
                arr      = (_eq > -1) ? [ _raw.substring(0, _eq), _raw.substring(_eq + 1) ] : [ _raw ];

                arr[0] = arr[0].toLowerCase();

                //Boolean values.
                if ( typeof(arr[1]) == 'undefined' || arr[1] === "true" ) {
                    arr[1] = true
                }

                if (arr[1] === "false") {
                    arr[1] = false
                }

                if ( cmdArguments.indexOf('--' + arr[0]) > -1 ) {
                    cmd.params[arr[0]] = arr[1];
                    cmd.paramsStringified += ' --' + arr[0] +'='+ arr[1];
                } else {
                    cmd.nodeParams.push('--' + arr[0] +'='+ arr[1]);
                }

            } else if ( process.argv[a].indexOf('--') > -1 ) {

                if ( cmdArguments.indexOf(process.argv[a]) > -1 ) {
                    cmd.params[ process.argv[a].replace(/--/, '') ] = true;
                    cmd.paramsStringified += ' '+process.argv[a] +'='+ true;
                } else {
                    cmd.nodeParams.push(process.argv[a]);
                }
            }
        }

        // console.debug('nodeParams ', cmd.nodeParams)
    }

    /**
     * Validates the command context, filters argv, and loads all project/bundle
     * configuration assets into `cmd`. Must be called once at the top of a
     * handler's `init()`. Delegates to getParams() then loadAssets().
     * Assigns itself to the global `isCmdConfigured` so all cmd handlers can call it.
     *
     * @global
     * @async
     * @returns {boolean} True when configuration loaded successfully; false on error
     */
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
                // #B59 — a corrupt registration (empty / undefined / too-short `.path`,
                // or a non-object entry) would make the global `_()` path helper throw
                // (helpers/path.js:67 rejects undefined / '' / length<=2), which the outer
                // catch (:537-541) turns into a `console.emerg` stack-dump + `exit(1)` —
                // aborting EVERY gina command, not just those targeting the corrupt project.
                // Pre-check the exact set `_()` would reject and SKIP it with a clean,
                // actionable warning instead (mirrors #B24's degrade-and-continue).
                var _projectPath = ( cmd.projects[p] && typeof(cmd.projects[p]) == 'object' )
                                    ? cmd.projects[p].path
                                    : null;
                if ( typeof(_projectPath) == 'undefined' || !_projectPath || _projectPath == '' || _projectPath.length <= 2 ) {
                    console.warn('Project @'+ p +' has an empty/invalid path in projects.json — skipping; re-add with `gina project:add @'+ p +' --path=<path>` (or remove the stale entry).');
                    continue;
                }
                if ( new _(_projectPath).existsSync() ) {
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
                errMsg = 'This is a project command line. Cannot understand what your are asking with: `'+ process.argv.slice(2).join(' ') +'`.\nYou need to add:` @<project_name>`. Do not forget the space before `@`.';
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
                                // #B59 — treat an empty / too-short `.path` the SAME as an
                                // undefined one (the existing `typeof != 'undefined'` test
                                // already routes an undefined path to the cwd-fallback `else`
                                // below). A bare `_('')` here would throw (helpers/path.js:67)
                                // → the outer catch's emerg stack-dump, even though loadAssets
                                // already has a clean "path no longer exists" guard (#B59, below)
                                // for exactly this targeted-corrupt-project case. Skipping the
                                // throw lets control reach that clean exit.
                                && cmd.projects[cmd.projectName].path
                                && String(cmd.projects[cmd.projectName].path).length > 2
                            ) {
                                cmd.projectLocation = _(cmd.projects[cmd.projectName].path, true);
                            }
                            else {
                                cmd.projectLocation = _( folder.toString(), true );
                            }

                            // Creating project location if not existing
                            if ( isValidName(cmd.projectName) && !folder.existsSync() ) {
                                let err = folder.mkdirSync();
                                if (err instanceof Error) {
                                    exit(err.stack||err.message||err);
                                    return false;
                                }
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
                    // cmd.projects[cmd.projectName] override required ?
                    else if ( /^project\:import/i.test(cmd.task) ) {
                        let newHomeDir = _(getUserHome() +'/.'+ cmd.projectName, true);
                        let pathArg = argv.find(arg => arg.startsWith('--path=')) || null;
                        let pathValue = pathArg
                                ? pathArg.split('=')[1].replace(/['"]/g, '')
                                : null;
                        if ( pathValue && pathValue != cmd.projectLocation ) {
                            // Making sure the prefix is the right one
                            let realGinaPrefix = cmd.projects[cmd.projectName].def_prefix;
                            try {
                                realGinaPrefix = execSync('echo $(which gina)|sed s/\\\\/bin\\\\/gina$//').toString().trim();
                            } catch (realGinaPrefixException) {
                                let errMsg = '[helper] while trying to get real gina prefix\n' + realGinaPrefixException.stack;
                                console.error(errMsg);
                                exit(errMsg);
                                return false;
                            }
                            cmd.projects[cmd.projectName].def_prefix = realGinaPrefix;
                            let oldHomedir          = cmd.projects[cmd.projectName].homedir;
                            let reOldHomedir        = new RegExp('^'+ oldHomedir);
                            let oldProjectPath      = cmd.projects[cmd.projectName].path;
                            let reOldProjectPath    = new RegExp('^'+ oldProjectPath);
                            for ( let p in cmd.projects[cmd.projectName] ) {
                                if ( typeof(cmd.projects[cmd.projectName][p]) == 'string' ) {
                                    if ( reOldHomedir.test(cmd.projects[cmd.projectName][p]) ) {
                                        cmd.projects[cmd.projectName][p] = cmd.projects[cmd.projectName][p].replace(reOldHomedir, newHomeDir);
                                        continue;
                                    }

                                    if ( reOldProjectPath.test(cmd.projects[cmd.projectName][p]) ) {
                                        cmd.projects[cmd.projectName][p] = cmd.projects[cmd.projectName][p].replace(reOldProjectPath, pathValue);
                                        continue;
                                    }
                                }
                            }
                        }
                    }



                    cmd.projectArgvList.push( argv[i].replace('@', '') )

                } else if ( /^\@/.test(argv[i]) ) {
                    // #B69 — an `@` token whose FIRST char fails the detection class
                    // above (`@Myproject`, `@-x`, a bare `@`) was SILENTLY DROPPED:
                    // cmd.projectName stayed null, so the command fell through to the
                    // cwd-project / all-projects resolution and ran against the WRONG
                    // scope with exit 0 — a mutating task (e.g. bundle:add) could write
                    // to the cwd project while reporting success. Reject it loudly
                    // instead. Same message + exit shape as the isValidName guard above,
                    // whose reject branch is unreachable for detected tokens (detection
                    // and isValidName test the same first-char predicate).
                    errMsg = '[ '+ argv[i] +' ] is not a valid project name. Please, try something else: @[a-z0-9_.]';
                    console.error(errMsg);
                    exit(errMsg);
                    return false;
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

                // `image:rm` / `image:run` and the `container:*` verbs are
                // HOST-level, not project-scoped: they act on the container host
                // by image ref or container name/id, so demanding a `@<project>`
                // would be meaningless. Anchored to each task so `project:rm`
                // keeps its own project requirement. (`image:list` needs no
                // entry — it rides the general `:list` exemption.)
                if (!/\:list$/.test(cmd.task) && !/^project\:status$/.test(cmd.task) && !/^image\:rm$/.test(cmd.task) && !/^image\:run$/.test(cmd.task) && !/^container\:(ps|stop)$/.test(cmd.task)) {// ignore this cases ( project:status is all-projects like project:list )
                    var folder = new _(process.cwd()).toArray().last();

                    if (isDefined('project', folder)) {

                        cmd.projectName = folder;
                        cmd.projectLocation = _(process.cwd(), true);
                    } else if (
                        !/\:help$/.test(cmd.task)
                        && !/port\:reset$/.test(cmd.task)
                        && !/scope\:add$/.test(cmd.task)
                        && !/env\:add$/.test(cmd.task)
                    ) {

                        errMsg = 'No project name found: make sure it starts with `@` as `@<project_name>`';
                        console.error(errMsg);
                        exit(errMsg);
                        return false;
                    }
                }
            }

            // Additional project checking & actions
            if (cmd.projectName != null) {
                // valid name but not in projects and task != :add, :remove, :import or :restore
                // (project:restore registers a brand-new on-disk tree from an archive,
                //  so its @<name> is legitimately not-yet-registered — like :add/:import)
                // #B104 — `rm` co-listed with `remove` so the `project:rm` alias follows the
                // same not-yet-registered exemption as `project:remove` (consistent alias).
                if ( typeof(cmd.projects[cmd.projectName]) == 'undefined' && !/\:(add|import|remove|rm|restore)$/.test(cmd.task) ) {
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

    /**
     * Loads and renders core/template/conf/env.json with project-specific
     * substitutions (framework dir, project path, env, bundle, version).
     * Returns the rendered env config object.
     * Assigns itself to the global `getCoreEnv`.
     *
     * @global
     * @param {string} bundle - Bundle name to substitute into the env template
     * @param {string} [env] - Environment name; falls back to project def_env
     * @returns {object} Rendered core env configuration
     */
    getCoreEnv = function(bundle, env) {
        var coreEnvPath = _(GINA_CORE + '/template/conf/env.json', true);
        var coreEnv     = requireJSON(coreEnvPath);

        var projectObj  = cmd.projects[cmd.projectName];
        var projectPath = _(projectObj.path, true);

        // whisper() does a single-pass substitution — env.json uses self-referential
        // placeholders (e.g. ${bundlesPath} references ${projectPath}, ${bundlePath}
        // references ${bundlesPath}). All derived values must be pre-computed here before
        // building reps; whisper will NOT resolve a placeholder whose value was itself a
        // placeholder in a sibling key. Migration note: placeholders use ${variable} syntax (not {variable}).
        var homedir     = projectObj.homedir
            ? _(projectObj.homedir, true)
            : _(os.homedir() + '/.' + cmd.projectName, true);
        var bundlesPath = projectObj.bundles_path
            ? _(projectObj.bundles_path, true)
            : projectPath + '/bundles';
        var cachePath   = projectPath + '/cache';

        var projectVersion      = '';
        var projectVersionMajor = '';
        try {
            var _manifest = requireJSON(_(projectPath + '/manifest.json', true));
            if ( _manifest.version ) {
                projectVersion      = _manifest.version;
                projectVersionMajor = String(_manifest.version).split(/\./g)[0];
            }
        } catch(e) { /* manifest may not exist during project:add */ }

        var reps = {
            "frameworkDir"        : GINA_FRAMEWORK_DIR,
            "executionPath"       : projectPath,
            "projectPath"         : projectPath,
            "projectName"         : cmd.projectName,
            "homedir"             : homedir,
            "bundlesPath"         : bundlesPath,
            "cachePath"           : cachePath,
            "projectVersion"      : projectVersion,
            "projectVersionMajor" : projectVersionMajor,
            // "modelsPath" is bundle-specific; resolved downstream from bundlesPath after whisper
            "env"    : env || projectObj.def_env,
            "bundle" : bundle,
            "version": GINA_VERSION
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
     * Reads all framework config files (main.json, projects.json, manifest.json,
     * env.json, ports.json, ports.reverse.json) fresh from disk (no require cache).
     * Populates cmd with scopes, envs, protocols, schemes, port maps, and bundle lists.
     * A registered project whose directory exists but whose manifest.json is missing
     * (a stale ~/.gina/projects.json entry) is warned and skipped (#B24) rather than
     * aborting the whole command.
     * On `project:add`/`project:import`, the current project's bundle list is the
     * UNION of the manifest's declared bundles and the bundle directories found on
     * disk (#B375): declared entries are preserved as-is, disk-only bundles are
     * appended for additive registration, and a declared bundle whose tree is
     * absent is warned about once per command — never auto-pruned, since the
     * declaration may be scope-restricted (#B373).
     * Each project's bundles are resolved against that project's OWN path (#B379),
     * and a project's protocols/schemes lists are DERIVED bookkeeping constrained
     * to the framework's supported sets from `~/main.json` (#B378): a bundle's
     * declared `server.protocol`/`server.scheme` may extend its project's list
     * only when the framework supports the value — an unsupported one is warned
     * about once per command and never adopted or made a default.
     * Also links node_modules and gina when running start/stop/restart tasks in global mode.
     * Assigns itself to the global `loadAssets`.
     *
     * @global
     */
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
                // #B16 — project:remove --force tolerates a missing manifest:
                // registry-only removal (`~/.gina/projects.json` + state-store)
                // is sufficient to unregister a partially-broken project. The
                // recreate-from-template branch may itself fail when the
                // project directory is gone, and the downstream read would
                // error out. Stub `cmd.projectData` to a minimal shape and
                // skip both recreate and read. The rest of `loadAssets`
                // (homedir / bundles / releases / ports) reads `projectData`
                // only via guarded `typeof != 'undefined'` checks, so a stub
                // satisfies every downstream consumer for the removal path.
                if ( /\:(remove|rm)$/.test(cmd.task) && cmd.params['force'] ) {
                    // #B104 — accept BOTH `project:remove` and the `project:rm` alias:
                    // `cmd.task` is the raw argv token (`:292`), and `:rm` resolves to
                    // `remove.js` purely via the `rm.js` file redirect, leaving the token
                    // literal. The bare `/\:remove$/` failed the alias, so `project:rm
                    // @<stale> --force` fell through to the #B59 gone-dir error below and
                    // removed nothing. (`:544`'s sibling exemption set is broadened to match.)
                    console.warn('Project manifest.json not found at '+ cmd.projectManifestPath +' — proceeding with registry-only removal (--force).');
                    cmd.projectData = { project: cmd.projectName, version: '0.0.0', bundles: {} };
                    // #B105 — for a stale-entry removal, SKIP every asset-recreation block
                    // below (the homedir / bundles / releases / logs / tmp / cache mkdirSync
                    // blocks + the env.json write): there is nothing to (re)build for a project
                    // being deleted, and for an UNCREATABLE path (a top-level `/app`, or any
                    // path under a non-writable parent) the env.json write ENOENT-throws — the
                    // outer catch turns it into an emerg + exit(1) BEFORE `remove.js` runs.
                    // Skipping also drops the wasteful resurrect-then-delete for a merely-gone
                    // (creatable) path. Populate exactly what `remove.js` reads — projectLocation
                    // (its init) + the port maps (its end()'s cleanup) — then return.
                    // The ports load is LOAD-BEARING here: the gone-path early-return further
                    // down sits BEFORE the canonical ports load, and `remove.js` end() rewrites
                    // ports.json / ports.reverse.json unconditionally — so without loading them
                    // the maps would be the empty `{}` defaults and EVERY project's ports would
                    // be wiped. Mirror the canonical load (see the `cmd.portsData = requireJSON`
                    // site later in this function); the port paths are already set at `:563-564`.
                    cmd.projectLocation = _(cmd.projects[cmd.projectName].path, true);
                    if ( typeof(require.cache[cmd.portsPath]) != 'undefined') {
                        delete require.cache[require.resolve(cmd.portsPath)]
                    }
                    cmd.portsData          = requireJSON(cmd.portsPath) || {};
                    if ( typeof(require.cache[cmd.portsReversePath]) != 'undefined') {
                        delete require.cache[require.resolve(cmd.portsReversePath)]
                    }
                    cmd.portsReverseData   = requireJSON(cmd.portsReversePath) || {};
                    return;
                } else if ( ! fs.existsSync(cmd.projects[cmd.projectName].path) ) {
                    // #B59 — the project DIRECTORY itself is gone (a valid-length path pointing
                    // at a deleted dir, or an empty/invalid `.path`). The recreate `else` below
                    // would ENOENT-throw: createFileFromDataSync does NOT `mkdir -p` its parent
                    // (lib/generator/index.js), the env.json mirror write (~:885) has the same
                    // shape, and the homedir/bundles/releases mkdirSync blocks further down would
                    // otherwise RESURRECT the deleted tree as an empty skeleton. The pre-existing
                    // gone-dir guard (`exists=false; return`, ~:910) sits AFTER both writes, so it
                    // never runs. Fail cleanly with an actionable message instead of the outer
                    // catch (:537-541) turning it into a `console.emerg` stack-dump + exit(1).
                    // (`project:remove --force` is the branch above; a SEPARATE `else if` here —
                    // not a guard atop the recreate `else` — keeps that branch byte-identical.
                    // fs.existsSync tests an empty `.path` without `_()` throwing.)
                    var _err59 = 'Project ['+ cmd.projectName +'] path `'+ cmd.projects[cmd.projectName].path +'` no longer exists — re-add it with `gina project:add @'+ cmd.projectName +' --path=<path>`, or remove the stale entry with `gina project:remove @'+ cmd.projectName +' --force`.';
                    console.error(_err59);
                    return exit(_err59);
                } else {
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
                        "scope"     : cmd.mainConfig['def_scope'][ GINA_SHORT_VERSION ],
                        "rootDomain": os.hostname()
                    };

                    contentFile = whisper(dic, contentFile); //data
                    lib.generator.createFileFromDataSync(
                        contentFile,
                        _(cmd.projectManifestPath, true)
                    );
                    cmd.projectData = requireJSON(cmd.projectManifestPath);
                }
            } else {
                cmd.projectData = requireJSON(cmd.projectManifestPath);
            }

            cmd.projectHomedir      = (
                                        typeof(cmd.projects[cmd.projectName].homedir) != 'undefined'
                                        && cmd.projects[cmd.projectName].homedir != ''
                                        && cmd.projects[cmd.projectName].homedir != 'null'
                                        && cmd.projects[cmd.projectName].homedir != null
                                    ) ? _(cmd.projects[cmd.projectName].homedir, true)
                                    : _(getUserHome() +'/.'+ cmd.projectName, true);
            var projectHomedirObject = new _(cmd.projectHomedir, true);
            console.debug('Checking project homedir: '+ projectHomedirObject.toString());
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
            var projectBundlesPathObj = new _(cmd.projects[cmd.projectName].path +'/bundles', true);
            if (!projectBundlesPathObj.existsSync() ) {
                projectBundlesPathObj.mkdirSync();
            }
            cmd.projectBundlesPath = projectBundlesPathObj.toString();
            // // bundles symlink
            // var bundlesLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/bundles', true);

            // try {
            //     // in case there is an invalid argument, readlink
            //     fs.readlinkSync(bundlesLinkPathObj.toString());
            // } catch (err) {
            //     console.warn('[bundles] Found invalid readlink: fixing it...');
            //     bundlesLinkPathObj.rmSync();
            // }

            // if (
            //     bundlesLinkPathObj.existsSync()
            //     && !bundlesLinkPathObj.isSymlinkSync()
            //     ||
            //     bundlesLinkPathObj.existsSync()
            //     && fs.readlinkSync(bundlesLinkPathObj.toString()) != cmd.projectBundlesPath
            // ) {
            //     bundlesLinkPathObj.rmSync();
            // }
            // if (!bundlesLinkPathObj.existsSync()) {
            //     console.debug('[ FRAMEWORK ][ CmdHelper ] Linking ['+ projectBundlesPathObj.toString() +'] to [ '+ bundlesLinkPathObj.toString() +' ] ');
            //     projectBundlesPathObj.symlinkSync(bundlesLinkPathObj.toString());
            // }
            projectBundlesPathObj = null;

            // releases
            var projectReleasesPathObj = new _(cmd.projects[cmd.projectName].path +'/releases', true);
            if (!projectReleasesPathObj.existsSync() ) {
                projectReleasesPathObj.mkdirSync();
            }
            cmd.projectReleasesPath = projectReleasesPathObj.toString();
            // // releases symlink
            // var releaseLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/releases', true);
            // try {
            //     // in case there is an invalid argument, readlink
            //     fs.readlinkSync(releaseLinkPathObj.toString());
            // } catch (err) {
            //     console.warn('[releases] Found invalid readlink: fixing it...');
            //     releaseLinkPathObj.rmSync();
            // }
            // if (
            //     releaseLinkPathObj.existsSync()
            //     && !releaseLinkPathObj.isSymlinkSync()
            //     ||
            //     releaseLinkPathObj.existsSync()
            //     && fs.readlinkSync(releaseLinkPathObj.toString()) != cmd.projectReleasesPath
            // ) {
            //     releaseLinkPathObj.rmSync();
            // }
            // if (!releaseLinkPathObj.existsSync()) {
            //     console.debug('[ FRAMEWORK ][ CmdHelper ] Linking ['+ projectReleasesPathObj.toString() +'] to [ '+ releaseLinkPathObj.toString() +' ] ');
            //     projectReleasesPathObj.symlinkSync(releaseLinkPathObj.toString());
            // }

            projectReleasesPathObj = null;

            // logs
            var projectLogsPathObj = new _(cmd.projects[cmd.projectName].path +'/logs', true);
            if (!projectLogsPathObj.existsSync() ) {
                projectLogsPathObj.mkdirSync();
            }
            cmd.projectLogsPath = projectLogsPathObj.toString();
            // // logs symlink
            // var logLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/logs', true);
            // try {
            //     // in case there is an invalid argument, readlink
            //     fs.readlinkSync(logLinkPathObj.toString());
            // } catch (err) {
            //     console.warn('[log] Found invalid readlink: fixing it...');
            //     logLinkPathObj.rmSync();
            // }
            // if (
            //     logLinkPathObj.existsSync()
            //     && !logLinkPathObj.isSymlinkSync()
            //     ||
            //     logLinkPathObj.existsSync()
            //     && fs.readlinkSync(logLinkPathObj.toString()) != cmd.projectLogsPath
            // ) {
            //     logLinkPathObj.rmSync();
            // }
            // if (!logLinkPathObj.existsSync()) {
            //     console.debug('[ FRAMEWORK ][ CmdHelper ] Linking ['+ projectLogsPathObj.toString() +'] to [ '+ logLinkPathObj.toString() +' ] ');
            //     projectLogsPathObj.symlinkSync(logLinkPathObj.toString());
            // }
            projectLogsPathObj = null;

            // tmp
            var projectTmpPathObj = new _(cmd.projects[cmd.projectName].path +'/tmp', true);
            if (!projectTmpPathObj.existsSync() ) {
                projectTmpPathObj.mkdirSync();
            }
            cmd.projectTmpPath = projectTmpPathObj.toString();
            // // tmp symlink
            // var tmpLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/tmp', true);
            // try {
            //     // in case there is an invalid argument, readlink
            //     fs.readlinkSync(tmpLinkPathObj.toString());
            // } catch (err) {
            //     console.warn('[tmp] Found invalid readlink: fixing it...');
            //     tmpLinkPathObj.rmSync();
            // }
            // if (
            //     tmpLinkPathObj.existsSync()
            //     && !tmpLinkPathObj.isSymlinkSync()
            //     ||
            //     tmpLinkPathObj.existsSync()
            //     && fs.readlinkSync(tmpLinkPathObj.toString()) != cmd.projectTmpPath
            // ) {
            //     tmpLinkPathObj.rmSync();
            // }
            // if (!tmpLinkPathObj.existsSync()) {
            //     console.debug('[ FRAMEWORK ][ CmdHelper ] Linking ['+ projectTmpPathObj.toString() +'] to [ '+ tmpLinkPathObj.toString() +' ] ');
            //     projectTmpPathObj.symlinkSync(tmpLinkPathObj.toString());
            // }
            projectTmpPathObj = null;

            // cache
            var projectCachePathObj = new _(cmd.projects[cmd.projectName].path +'/cache', true);
            if (!projectCachePathObj.existsSync() ) {
                projectCachePathObj.mkdirSync();
            }
            cmd.projectCachePath = projectCachePathObj.toString();
            // cache symlink
            // var cacheLinkPathObj = new _(cmd.projects[cmd.projectName].path +'/cache', true);
            // try {
            //     // in case there is an invalid argument, readlink
            //     fs.readlinkSync(cacheLinkPathObj.toString());
            // } catch (err) {
            //     console.warn('[cache] Found invalid readlink: fixing it...');
            //     cacheLinkPathObj.rmSync();
            // }
            // if (
            //     cacheLinkPathObj.existsSync()
            //     && !cacheLinkPathObj.isSymlinkSync()
            //     ||
            //     cacheLinkPathObj.existsSync()
            //     && fs.readlinkSync(cacheLinkPathObj.toString()) != cmd.projectCachePath
            // ) {
            //     cacheLinkPathObj.rmSync();
            // }
            // if (!cacheLinkPathObj.existsSync()) {
            //     console.debug('[ FRAMEWORK ][ CmdHelper ] Linking ['+ projectCachePathObj.toString() +'] to [ '+ cacheLinkPathObj.toString() +' ] ');
            //     projectCachePathObj.symlinkSync(cacheLinkPathObj.toString());
            // }
            projectCachePathObj = null;


            cmd.projectLocation     = _(cmd.projects[cmd.projectName].path, true);
            cmd.bundlesLocation     = _(cmd.projects[cmd.projectName].path +'/src', true);
            cmd.envPath             = _(cmd.projects[cmd.projectName].path + '/env.json', true);
            // For safety precaution
            if ( ! new _(cmd.envPath).existsSync() ) {
                if ( !/^project\:(add|import)/.test(cmd.task) ) {
                    console.warn('Project env.json not found. Trying to fix it ...');
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

            cmd.def_framework = ( typeof(cmd.projects[cmd.projectName].framework) != 'undefined' ) ? (cmd.projects[cmd.projectName].framework.replace(/^v/, '').split(/\./g)).join('.') : (cmd.mainConfig.def_framework.split(/\./g)).join('.');
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

            // per-bundle gina version override through: --gina-version=<version> or manifest.json bundles[name].gina_version
            if ( /\:start$/i.test(cmd.task) && cmd.name ) {
                var bundleGinaVersion = cmd.params['gina-version'] || null;
                // fall back to manifest.json per-bundle declaration
                if (
                    !bundleGinaVersion
                    && typeof(cmd.projectData.bundles) != 'undefined'
                    && typeof(cmd.projectData.bundles[cmd.name]) != 'undefined'
                ) {
                    bundleGinaVersion = cmd.projectData.bundles[cmd.name]['gina_version'] || null;
                }
                if ( bundleGinaVersion ) {
                    var bvShort = bundleGinaVersion.split('.').splice(0,2).join('.');
                    var knownVersions = ( cmd.mainConfig.frameworks && cmd.mainConfig.frameworks[bvShort] ) ? cmd.mainConfig.frameworks[bvShort] : null;
                    if ( !Array.isArray(knownVersions) || knownVersions.indexOf(bundleGinaVersion) < 0 ) {
                        errMsg = 'gina_version `'+ bundleGinaVersion +'` is not an installed version. Known versions: '+ JSON.stringify(cmd.mainConfig.frameworks);
                        console.emerg(errMsg);
                        return false;
                    }
                    cmd.bundleGinaVersion = bundleGinaVersion;
                    console.debug('Bundle ['+ cmd.name +'] gina version override: '+ bundleGinaVersion);
                }
            }

            // // project or bundle scope override through : --scope=<some scope>
            // if ( typeof(cmd.params.scope) != 'undefined' && /\:(start|stop|restart|build|deploy)/i.test(cmd.task) ) {
            //     console.debug('Overriding default project scope: '+ cmd.defaultScope +' => '+ cmd.params.scope);
            //     if (cmd.scopes.indexOf(cmd.params.scope) < 0) {
            //         errMsg = 'Scope `'+ cmd.params.scope +'` not found in your project ['+ cmd.projectName +']';
            //         console.emerg(errMsg);
            //         return false;
            //     }
            //     cmd.defaultScope = process.env.NODE_SCOPE = cmd.params.scope;
            //     // override
            //     //cmd.bundlesByProject[cmd.projectName][cmd.name].def_scope = cmd.params.scope;
            // } else {
            //     delete process.env.NODE_SCOPE
            // }
            // cmd.scopes.sort();



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


            // linking node-modules & gina
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
                    // was: err = execSync('$(which gina) link-node-modules @'+cmd.projectName +cmd.paramsStringified);
                    // A PATH-resolved binary is not guaranteed to exist (repo checkout,
                    // non-global install) and execSync THROWS on failure rather than
                    // returning an Error (the old `instanceof Error` check was dead
                    // code) — invoke the running install's own CLI instead.
                    var selfCli = require('path').resolve(__dirname, '../../../..', 'bin/cli');
                    // Re-export the home: the bootstrap env sweep strips GINA_* from
                    // process.env, so the link children would otherwise resolve the
                    // default home (see linkGina in project/add.js).
                    var _linkEnv = Object.assign({}, process.env, { GINA_HOMEDIR: GINA_HOMEDIR });
                    console.info('[helper] Running: '+ process.execPath +' '+ selfCli +' link-node-modules @'+cmd.projectName +cmd.paramsStringified);
                    try {
                        execSync('"'+ process.execPath +'" "'+ selfCli +'" link-node-modules @'+cmd.projectName +cmd.paramsStringified, { env: _linkEnv });// +' --inspect-gina'
                    } catch (linkErr) {
                        var linkErrOutput = (linkErr.stderr) ? linkErr.stderr.toString().trim() : (linkErr.message || linkErr.stack);
                        console.error(linkErrOutput);
                        return exit(linkErrOutput);
                    }

                    console.info('[helper] Running: '+ process.execPath +' '+ selfCli +' link @'+cmd.projectName +cmd.paramsStringified);
                    try {
                        console.debug(execSync('"'+ process.execPath +'" "'+ selfCli +'" link @'+cmd.projectName +cmd.paramsStringified, { env: _linkEnv }).toString().trim());// +' --inspect-gina'
                    } catch (err) {
                        var errOutput = (err.stderr) ? err.stderr.toString().trim() : (err.message || err.stack);
                        console.emerg(errOutput);
                        return exit(errOutput);
                    }
                }

                // TODO - remove this
                // console.debug('[helper] Running: gina link @'+cmd.projectName +cmd.paramsStringified);
                // err = execSync('$(which gina) link @'+cmd.projectName +cmd.paramsStringified);// +' --inspect-gina'
                // if (err instanceof Error) {
                //     console.error(err.message || err.stack);
                //     return exit(err.message || err.stack);
                // }
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
                    console.error('`'+ projectPropertiesPath +'` not found ! Maybe, you can try to remove the project reference by hand by editing: `'+ _(GINA_HOMEDIR + '/projects.json') +'`')
                    // #B24: skip this stale project (dir present, manifest.json gone) instead of
                    // falling through to the requireJSON(...).bundles below, which process-exits on
                    // ENOENT — aborting every offline asset command when ANY one registered project
                    // is stale. bundlesByProject[project] stays {} (pre-set above); exists stays true.
                    continue;
                }

                cmd.bundlesByProject[project]   = (cmd.bundlesByProject[project].count() > 0) ? cmd.bundlesByProject[project] : requireJSON(projectPropertiesPath).bundles;
                // #B375 — the "additional checks" block below (introduced 2023, absorbed into an
                // automated version-bump commit, never revisited) compared each project's declared
                // bundle COUNT against a readdir of `<project>/src` (else `/releases`) and, on ANY
                // mismatch, emptied `manifest.bundles` and wrote it back to disk — for EVERY
                // registered project, not just the one being added/imported. That destroyed every
                // per-bundle declaration the recreation skeleton does not carry (the `scopes`
                // allow-list — #B373 —, `gina_version`, any custom key), reset `version`/`tag` and
                // release targets to defaults, permanently emptied bystander projects' manifests
                // (no rebuild ever runs for a non-target project), and did the same on plain
                // `project:add` (the rebuild only runs on import). Its one legitimate function —
                // forcing a rescan of the bundle directories so bundles on disk but missing from
                // the manifest still get registered on import — is now served non-destructively by
                // the union rescan near the end of loadAssets, which no longer needs `cmd.bundles`
                // to be emptied to fire. Manifest entries are never auto-pruned anymore: a
                // declared bundle whose tree is absent is warned about there instead.
                // Kept commented per the replace-don't-delete convention:
                //
                // // additional checks
                // let bundlesCount = cmd.bundlesByProject[project].count();
                // if ( /^project\:(add|import)/.test(cmd.task) && bundlesCount > 0 ) {
                //     let releasesPathObj = new _(cmd.projects[project].path +'/releases', true);
                //     let _bundleConfigPath = cmd.bundlesLocation;
                //     let files = [], f = 0;
                //     if ( new _(cmd.projects[project].path +'/src', true).existsSync() ) {
                //         files = fs.readdirSync(_(cmd.projects[project].path +'/src', true));
                //     } else if (releasesPathObj.existsSync()) {
                //         _bundleConfigPath = releasesPathObj.toString();
                //         files = fs.readdirSync(releasesPathObj.toString());
                //     }
                //     let _count = 0;
                //     for (;f < files.length; ++f) {
                //         // skip hidden
                //         let name = files[f];
                //         if ( /^\./.test(name) ) continue;
                //         _count++
                //     }
                //     if (_count != bundlesCount) {
                //         cmd.bundles = [];
                //         cmd.bundlesByProject[project] = {}
                //         let updatedManifest = requireJSON(projectPropertiesPath);
                //         updatedManifest.bundles = {};
                //         lib.generator.createFileFromDataSync(
                //             updatedManifest,
                //             projectPropertiesPath
                //         )
                //     }
                // }

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

                // #B379 — resolve each project's bundles against ITS OWN path. This loop
                // runs over EVERY registered project, while the singular
                // `cmd.projectLocation` names only the CURRENT one — so a same-named
                // bundle in another project used to be read out of the wrong tree: its
                // `exists` flag, `configPaths` and default protocol/scheme all came from
                // the current project's files, and whatever its namesake declared there
                // leaked into the other project's registry entry.
                let _ownProjectPath = cmd.projects[project].path;
                if ( fs.existsSync(_(_ownProjectPath + '/'+ cmd.bundlesByProject[project][bundle].src )) ) {
                    cmd.bundlesByProject[project][bundle].exists = true;
                    // adding configurations
                    bundleConfigPath = _(_ownProjectPath + '/'+ cmd.bundlesByProject[project][bundle].src +'/config' );
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
                            // #B378 — a bundle's declared protocol may extend the project's
                            // list ONLY when the framework itself supports it. The entry's
                            // `.protocols` deliberately aliases the project's own array
                            // (assigned above): that aliasing is how the project's port
                            // matrix learns what its bundles use — and it persists to
                            // ~/.gina/projects.json on the next registry write, from where
                            // `image:build` bakes the list into a container's environment.
                            // So an unsupported value is surfaced by name instead of
                            // adopted, and never becomes the entry's default either.
                            if ( cmd.protocolsAvailable.indexOf(settings.server.protocol) > -1 ) {
                                if (cmd.bundlesByProject[project][bundle].protocols.indexOf(settings.server.protocol) < 0)
                                    cmd.bundlesByProject[project][bundle].protocols.push(settings.server.protocol);

                                cmd.bundlesByProject[project][bundle].def_protocol = settings.server.protocol
                            } else if ( !cmd.warnedInvalidServerSettings[project +'/'+ bundle +':protocol'] ) {
                                cmd.warnedInvalidServerSettings[project +'/'+ bundle +':protocol'] = true;
                                console.warn('Bundle `'+ bundle +'` of project `@'+ project +'` declares `server.protocol: "'+ settings.server.protocol +'"`, which is not an allowed protocol (allowed: '+ cmd.protocolsAvailable.join(', ') +' — check your framework configuration `~/main.json`). Ignoring it: the bundle keeps the default `'+ cmd.bundlesByProject[project][bundle].def_protocol +'`.');
                            }
                        }

                        if (
                            typeof(settings.server) != 'undefined'
                            && typeof(settings.server.scheme) != 'undefined'
                        ) {
                            // #B378 — same rule as the protocol above.
                            if ( cmd.schemesAvailable.indexOf(settings.server.scheme) > -1 ) {
                                if (cmd.bundlesByProject[project][bundle].schemes.indexOf(settings.server.scheme) < 0)
                                    cmd.bundlesByProject[project][bundle].schemes.push(settings.server.scheme);

                                cmd.bundlesByProject[project][bundle].def_scheme = settings.server.scheme
                            } else if ( !cmd.warnedInvalidServerSettings[project +'/'+ bundle +':scheme'] ) {
                                cmd.warnedInvalidServerSettings[project +'/'+ bundle +':scheme'] = true;
                                console.warn('Bundle `'+ bundle +'` of project `@'+ project +'` declares `server.scheme: "'+ settings.server.scheme +'"`, which is not an allowed scheme (allowed: '+ cmd.schemesAvailable.join(', ') +' — check your framework configuration `~/main.json`). Ignoring it: the bundle keeps the default `'+ cmd.bundlesByProject[project][bundle].def_scheme +'`.');
                            }
                        }
                    }

                    // #B27: index by the loop variable `project` — every other write in this
                    // double-loop does. With the old cmd.projectName index, the loop reaching a
                    // project other than the freshly-added @alias (which has no bundlesByProject
                    // entry yet) dereferenced undefined and hard-crashed `gina project:add`.
                    cmd.bundlesByProject[project][bundle].def_env = (cmd.params.env) ? cmd.params.env : cmd.defaultEnv; // by default


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

        // #B375 — this rescan used to be gated on `!cmd.bundles.length`, which only ever
        // opened after the destructive count-mismatch reset (now retired, see above) had
        // emptied the list: that reset WAS the discovery mechanism for bundles present on
        // disk but missing from the manifest. The rescan now always runs for
        // `project:add`/`project:import` on the current project and UNIONS the two sources
        // instead: manifest-declared bundles keep their existing entries untouched
        // (`scopes`, `version`, custom keys, release targets — all preserved), and only
        // bundles found on disk but absent from the manifest are appended, for
        // `addBundleToManifest` to seed additively (#B55). A bundle declared in the
        // manifest but absent from disk is warned about, never auto-pruned: the
        // declaration may be deliberate (a bundle restricted to other scopes — #B373 —
        // whose tree is stripped at this scope); removing it for good is
        // `gina bundle:remove`'s job.
        if (
            /^project\:(add|import)/.test(cmd.task)
            && typeof(cmd.projects[cmd.projectName]) != 'undefined'
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
            var _diskNames = [];
            for (;f < files.length; ++f) {
                // skip hidden
                let name = files[f];
                if ( /^\./.test(name) ) continue;
                _diskNames.push(name);
                if ( cmd.bundles.indexOf(name) > -1 ) {
                    // already declared in the manifest — keep the existing entry untouched
                    continue;
                }
                cmd.bundles.push(name);
                // #B376 — the settings path is derived from the loop-invariant scan root
                // for every bundle: the previous version mutated the root across
                // iterations, so every bundle after the first got a path nested under its
                // predecessors and the settings-consistency pass silently skipped it.
                cmd.bundlesByProject[cmd.projectName][name] = {
                    src: 'src/'+ name,
                    configPaths: {
                        settings: _(_bundleConfigPath +'/'+ name +'/config/settings.json', true)
                    }
                };
            }
            // Surface manifest entries whose tree is missing from the scanned location —
            // once per bundle per command (loadAssets runs several times per command).
            for (let declared in cmd.bundlesByProject[cmd.projectName]) {
                if ( _diskNames.indexOf(declared) > -1 || cmd.warnedAbsentBundles[declared] ) continue;
                cmd.warnedAbsentBundles[declared] = true;
                console.warn('Bundle `'+ declared +'` is declared in the manifest.json of project `@'+ cmd.projectName +'` but was not found under `'+ _bundleConfigPath +'` — keeping the declaration (it may be restricted to other scopes); if the bundle is gone for good, remove it with `gina bundle:remove '+ declared +' @'+ cmd.projectName +'`.');
            }
            cmd.bundles.sort()
        }

    }


    /**
     * Returns true when the named entry exists in the loaded configuration.
     * Supported types: 'project', 'bundle', 'env', 'scope'.
     * Assigns itself to the global `isDefined`.
     *
     * @global
     * @param {string} type - Entity type: 'project', 'bundle', 'env', or 'scope'
     * @param {string} name - Entity name to look up
     * @returns {boolean} True when the entry is found
     */
    isDefined = function(type, name) {

        // if (
        //     typeof(name) == 'undefined'
        //     || typeof(name) != 'undefined' && name == ''
        //     || typeof(name) != 'undefined' && name == null
        // ) {
        //     throw new Error('isDefined Error : name cannot be undefined, null or blank !')
        // }

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
     * Returns true when the name matches the allowed pattern `^[a-z0-9_.]`.
     * Strips a leading `@` before testing.
     * Assigns itself to the global `isValidName`.
     *
     * @global
     * @param {string} name - Name to validate (may start with `@`)
     * @returns {boolean} True when valid
     */
    isValidName = function(name) {

        if ( typeof(name) == 'undefined' || name == null || name == undefined || name == '')
            return false;

        return /^[a-z0-9_.]/.test( name.replace('@', '') )
    }

    /**
     * Reads and prints the task group's help.txt to stdout.
     * Derives the group name from the first segment of cmd.task (e.g. 'bundle' from 'bundle:start').
     * Assigns itself to the global `getHelp`.
     *
     * @global
     */
    getHelp = function () {

        var taskGroup   = cmd.task.split(/:/)[0]
            , file      = _( __dirname +'/'+ taskGroup +'/help.txt', true )
            , errMsg    = 'No help available for `'+ taskGroup +'` command line at the moment. Please try again on the next release';

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

    /**
     * Calculates how many port slots remain unassigned for a bundle.
     * The theoretical maximum is: envs × protocols × schemes (or protocols × schemes when
     * `env` is specified). The actual count of already-assigned slots is subtracted.
     * Assigns itself to the global `getBundleScanLimit`.
     *
     * @global
     * @param {string} bundle - Bundle name (e.g. 'api')
     * @param {string} [env] - Restrict calculation to a single env
     * @returns {number} Number of port slots still available to assign
     */
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

    /**
     * Returns a sorted list of all port numbers currently registered in
     * ports.json and ports.reverse.json, excluding those already assigned to
     * the current project's bundles.
     * Assigns itself to the global `getPortsList`.
     *
     * @global
     * @returns {string[]} Sorted array of port number strings
     */
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
     * Allocates ports for a bundle across all envs × protocols × schemes and
     * writes the updated ports.json, ports.reverse.json, and env.json to disk.
     * Assigns itself to the global `setPorts`.
     *
     * @global
     * @param {string} bundle - Bundle name to allocate ports for
     * @param {string[]} portsAvailable - Sorted list of candidate port numbers to assign
     * @param {function} cb - Node-style callback `function(err)` called when done
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
        // #B380 — read the SOURCE list by its own index, exactly as the env loop
        // above does: the previous form indexed the TARGET with the source's index,
        // so once the contextual list outgrew the project's own, the overshoot read
        // undefined. #B378 — and merge only values the framework supports: the
        // contextual list also grows from ports.json keys, which can retain
        // protocols a framework update removed.
        for (let p in cmd.protocols) {
            let newProtocol = cmd.protocols[p];
            if (
                cmd.protocolsAvailable.indexOf(newProtocol) > -1
                && allProjectProtocols.indexOf(newProtocol) < 0
            ) {
                console.debug('adding new protocol ['+newProtocol+'] VS' + JSON.stringify(cmd.protocols, null, 2));
                allProjectProtocols.push(newProtocol);
            }
        }
        // getting available all schemes
        // #B380 / #B378 — same two rules as the protocol loop above.
        for (let p in cmd.schemes) {
            let newScheme = cmd.schemes[p];
            if (
                cmd.schemesAvailable.indexOf(newScheme) > -1
                && allProjectSchemes.indexOf(newScheme) < 0
            ) {
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

    /**
     * Sorts a bundles object (keyed by bundle name) alphabetically by name
     * and returns a new object with entries in that order.
     * Assigns itself to the global `orderBundles`.
     *
     * @global
     * @param {object} bundles - Bundles map from a project manifest
     * @returns {object} New map with entries sorted by name ascending
     */
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


    /**
     * Writes an optional error message to the socket client, closes it,
     * and exits the process. Exit code 1 when errorMessage is truthy; 0 otherwise.
     * Assigns itself to the global `exit`.
     *
     * @global
     * @param {string} [errorMessage] - Error text to send to the client before closing
     */
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