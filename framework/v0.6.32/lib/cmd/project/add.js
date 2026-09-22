var fs          = require('fs');
var os          = require('os');
var util        = require('util');
var execSync    = require('child_process').execSync;
var promisify   = util.promisify;

var CmdHelper   = require('./../helper');
var Shell       = lib.Shell;
var console     = lib.logger;
var scan        = require('../port/inc/scan');

/**
 * @module gina/lib/cmd/project/add
 */
/**
 * Creates a new project directory structure and registers it in ~/.gina/projects.json,
 * or re-registers an existing project (import mode). Optionally adds a scope and env,
 * scans for available ports, and links the gina module.
 *
 * Usage:
 *  gina project:add @<project_name> --path=<dir>
 *  gina project:add @<project_name> --path=<dir> --scope=local --env=dev --start-port-from=4100
 *  gina project:import @<project_name> --path=<dir>
 *
 * @class Add
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Add(opt, cmd) {

    var self        = {}
        , local     = {
            // bundle index while searching or browsing
            b : 0,
            bundle : null,
            bundlePath : null,
            ports : []
        }
    ;

    /**
     * Parses argv flags, ensures the project directory exists, creates package.json,
     * manifest.json, and env.json, optionally adding scope/env via sub-commands.
     *
     * @inner
     * @private
     */
    var init = function() {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        for (let i=3, len=process.argv.length; i<len; i++) {
            if ( /\-\-start\-port\-from\=/.test(process.argv[i]) ) {
                self.startFrom = process.argv[i].split(/\=/)[1]
            }

            if ( /\-\-homedir\=/.test(process.argv[i]) ) {
                self.projectHomedir = process.argv[i].split(/\=/)[1]
            }

            if ( /\-\-scope\=/.test(process.argv[i]) ) {
                self.scope = process.argv[i].split(/\=/)[1]
            }

            if ( /\-\-env\=/.test(process.argv[i]) ) {
                self.env = process.argv[i].split(/\=/)[1]
            }

            if ( /\-\-path\=/.test(process.argv[i]) ) {
                self.projectLocation = process.argv[i].split(/\=/)[1];
                self.projectManifestPath = _(self.projectLocation + '/manifest.json', true);
            }
        }

        // check CMD configuration
        if ( !isCmdConfigured() ) return false;

        local.imported = ( /\:import/i.test(self.task) ) ? true : false;
        if ( checkImportMode() ) {
            return;
        }

        var err         = false
            , folder    = null
            , file      = null
        ;

        folder = new _(self.projectLocation);

        if (
            folder.isValidPath()
            && isValidName(self.projectName)
            && !folder.existsSync()
        ) {
            err = folder.mkdirSync();

            if (err instanceof Error) {
                console.error(err.stack);
                process.exit(1)
            }
        }

        loadAssets();

        // creating package file
        file = new _(self.projectLocation + '/package.json', true);
        if ( !file.existsSync() ) {
            createPackageFile( file.toString() )
        } else {
            console.warn('[ package.json ] already exists in this location: '+ file + '\nUpdating package.json...');
            // Merge existing package.json with framework template; createPackageFile calls end()
            // which writes projects.json and calls process.exit(0). Without this, the process
            // hangs indefinitely because MQSpeaker keeps the event loop alive.
            createPackageFile( file.toString(), true );
        }

        if ( self.scope && !isDefined('scope', self.scope) ) {
            try {
                // cloning it
                let currentEnv = { ...process.env };
                currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
                // Re-export the home: the bootstrap env sweep strips GINA_* from
                // process.env, so the child would otherwise resolve the default
                // home and register the scope there instead of the active one.
                currentEnv['GINA_HOMEDIR'] = GINA_HOMEDIR;
                let execOptions = {
                    cwd: self.projectLocation,
                    // Inherit stdio to see the debug prompt in the console
                    stdio: 'inherit',
                    // Pass the debug options via the environment variables
                    env: currentEnv
                };
                // A PATH-resolved `gina` is not guaranteed to exist or to be this
                // install — invoke the running install's own CLI instead.
                let cmd = '"'+ process.execPath +'" "'+ require('path').resolve(__dirname, '../../../../..', 'bin/cli') +'" scope:add '+ self.scope;
                console.warn('['+ self.task +'] running: '+ cmd);
                // With inherited stdio, execSync returns null — the child's output
                // already reached the console; do not read the return value.
                execSync( cmd , execOptions);
                self.scopes.push(self.scope);
            } catch (scopeErr) {
                console.error('[scope]['+ self.scope +'] could not be set: '+ (scopeErr.message || scopeErr));
                process.exit(1);
            }
        }

        if ( self.env && !isDefined('env', self.env) ) {
            try {
                // cloning it
                let currentEnv = { ...process.env };
                currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
                // Re-export the home: the bootstrap env sweep strips GINA_* from
                // process.env, so the child would otherwise resolve the default
                // home and register the environment there instead of the active one.
                currentEnv['GINA_HOMEDIR'] = GINA_HOMEDIR;
                let execOptions = {
                    cwd: self.projectLocation,
                    // Inherit stdio to see the debug prompt in the console
                    stdio: 'inherit',
                    // Pass the debug options via the environment variables
                    env: currentEnv
                };
                // A PATH-resolved `gina` is not guaranteed to exist or to be this
                // install — invoke the running install's own CLI instead.
                let cmd = '"'+ process.execPath +'" "'+ require('path').resolve(__dirname, '../../../../..', 'bin/cli') +'" env:add '+ self.env;
                console.warn('['+ self.task +'] running: '+ cmd);
                // With inherited stdio, execSync returns null — the child's output
                // already reached the console; do not read the return value.
                execSync( cmd , execOptions);
                self.envs.push(self.env);
            } catch (envErr) {
                console.error('[env]['+ self.env +'] could not be set: '+ (envErr.message || envErr));
                process.exit(1);
            }
        }


        // creating project manifest
        file = new _(self.projectManifestPath, true);
        // override for `add` & `import`
        // if ( !file.existsSync() ) {
            createManifestFile( file.toString() )
        // } else {
        //     console.warn('[ manifest.json ] already exists in this location: '+ file);
        // }

        // creating env file
        file = new _(self.projectLocation + '/env.json', true);
        if ( !file.existsSync() ) {
            createEnvFile( file.toString() )
        } else {
            console.warn('[ env.json ] already exists in this location: '+ file);
        }
    }

    /**
     * Handles `project:import` mode: validates the project is already registered,
     * updates its path, and links gina if the symlink is missing.
     * Returns true when import mode was handled; returns undefined otherwise.
     *
     * @inner
     * @private
     * @returns {boolean|undefined}
     */
    var checkImportMode = function() {

        if ( self.task != 'project:import')
            return;

        console.debug('Starting import mode @'+ self.projectName );

        if (!self.projects[self.projectName]) {
            console.error('[ '+ self.projectName  +' ] is not an existing project. Instead, use gina projet:add @'+ self.projectName +' --path='+ self.projectLocation);
            process.exit(1);
        }


        if ( typeof(self.projects[self.projectName ]) != 'undefined' ) {
            // import if exists but path just changed
            if ( typeof(self.projects[self.projectName ].path) != 'undefined') {
                var old = new _(self.projects[self.projectName ].path, true).toArray().last();

                if (old === self.projectName) {
                    self.projects[self.projectName ].path = self.projectLocation;

                    var target = _(GINA_HOMEDIR + '/projects.json')
                        , projects = JSON.clone(self.projects);

                    lib.generator.createFileFromDataSync(
                        projects,
                        target
                    );


                    var ginaModule = _( self.projectLocation +'/node_modules/gina',true );

                    if ( !fs.existsSync(ginaModule) ) {
                        linkGina(
                            function onError(err) {
                                console.error(err.stack);
                                process.exit(1)
                            },
                            function onSuccess() {
                                local.imported = true;
                                end();
                                return true;
                            })

                    } else {
                        local.imported = true;
                        end();
                        return true;
                    }
                }
            } else {
                console.error('[ '+ self.projectLocation  +' ] is an existing project. Please choose another name for your project or remove this one.');
                process.exit(1)
            }
        }
    }

    /**
     * Creates or updates manifest.json from the framework template, merging
     * any existing file contents and applying project-specific substitutions.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to manifest.json
     */
    var createManifestFile = function(target) {

        // if ( self.scope ) {
        //     try {
        //         // cloning it
        //         let currentEnv = { ...process.env };
        //         currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
        //         let execOptions = {
        //             cwd: self.projectLocation,
        //             // Inherit stdio to see the debug prompt in the console
        //             stdio: 'inherit',
        //             // Pass the debug options via the environment variables
        //             env: currentEnv
        //         };
        //         let cmd = 'gina scope:add '+ self.scope +' @'+ self.projectName;
        //         console.warn('['+ self.stask +'] running: '+ cmd);
        //         console.log(execSync( cmd , execOptions).toString().trim());
        //         cmd = 'gina scope:use '+ self.scope +' @'+ self.projectName;
        //         console.warn('['+ self.stask +'] running: '+ cmd);
        //         console.log(execSync( cmd , execOptions).toString().trim());
        //     } catch (scopeErr) {
        //         console.error('[scope]['+ self.scope  +'] could not be set.');
        //         process.exit(1);
        //     }
        // }

        // if ( self.env ) {
        //     try {
        //         // cloning it
        //         let currentEnv = { ...process.env };
        //         currentEnv['NODE_OPTIONS'] = self.nodeParams.join(' ');
        //         let execOptions = {
        //             cwd: self.projectLocation,
        //             // Inherit stdio to see the debug prompt in the console
        //             stdio: 'inherit',
        //             // Pass the debug options via the environment variables
        //             env: currentEnv
        //         };

        //         let cmd = 'gina env:add '+ self.env +' @'+ self.projectName;
        //         console.warn('['+ self.stask +'] running: '+ cmd);
        //         console.log(execSync( cmd , execOptions).toString().trim());
        //         cmd = 'gina env:use '+ self.env +' @'+ self.projectName;
        //         console.warn('['+ self.stask +'] running: '+ cmd);
        //         console.log(execSync( cmd , execOptions).toString().trim());
        //     } catch (envErr) {
        //         console.error('[env]['+ self.env  +'] could not be set.');
        //         process.exit(1);
        //     }
        // }

        loadAssets();

        var conf            = _(getPath('gina').core +'/template/conf/manifest.json', true);
        var contentFile     = requireJSON(conf);
        var packageContent  = requireJSON(_(self.projectLocation + '/package.json', true));
        var version = packageContent.version || "1.0.0";
        // hostname by default
        var rootDomain = os.hostname();
        // fqdn by default
        var shortVersion = GINA_SHORT_VERSION;// jshint ignore:line
        home = GINA_HOMEDIR;// jshint ignore:line
        var homeVersionDirObj = new _( home +'/'+ shortVersion, true );
        var settingsPath = _( homeVersionDirObj.toString() +'/settings.json', true );// jshint ignore:line
        if ( new _(settingsPath).existsSync() ) {
            var settings = requireJSON(settingsPath);// jshint ignore:line
            if ( settings.hostname != 'localhost' ) {
                rootDomain = settings.hostname;
            }
        }
        var bundles = {};
        if ( new _(target).existsSync() ) {
            var existingManifest = requireJSON(target);
            if ( typeof(existingManifest.rootDomain) != 'undefined' && existingManifest.rootDomain != os.hostname() ) {
                rootDomain = existingManifest.rootDomain;
            }
            existingManifest.version = version;
            existingManifest.rootDomain = rootDomain;
            if ( typeof(existingManifest.bundles) != 'undefined' ) {
                bundles = JSON.clone(existingManifest.bundles);
                delete existingManifest.bundles;
            }

            contentFile = merge(existingManifest, contentFile);
            contentFile.bundles = bundles;
        }

        var dic = {
            "project"   : self.projectName,
            "version"   : version,
            "scope"     : self.defaultScope || self.mainConfig['def_scope'][ GINA_SHORT_VERSION ],
            "rootDomain": rootDomain
        };

        // Compiling & writing to ~//gina/project.json
        contentFile = whisper(dic, contentFile);
        lib.generator.createFileFromDataSync(
            contentFile,
            target
        )
    }

    /**
     * Writes an empty env.json to the project root.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to env.json
     */
    var createEnvFile = function(target) {
        lib.generator.createFileFromDataSync(
            {},
            target
        )
    }


    /**
     * Copies the framework's `_gitignore` template to the project's `.gitignore`,
     * but only when the project does not already have one (#B258).
     *
     * The `_` prefix is the ship-time name: a real `.gitignore` tracked inside
     * `core/template/` would be read by git as ignore rules for the framework's
     * own tree. The rename to the dotted form belongs here, at scaffold time —
     * and until now nothing performed it, so the template shipped in every
     * tarball with no consumer and scaffolded projects got no `.gitignore` at
     * all. That left the `.env` / `*.env` globs it carries unable to protect
     * anything, which is the security-adjacent half of this fix.
     *
     * SKIP-IF-EXISTS is deliberate. A project's `.gitignore` is the user's file
     * and routinely carries rules the framework knows nothing about; filling a
     * gap is safe, replacing is not. This also makes the step idempotent, so
     * re-running `project:add` over an existing project cannot clobber it.
     *
     * Note this does NOT reuse `lib.generator.createFileFromTemplateSync`, which
     * is otherwise the right shape: it unlinks the target first, so it cannot
     * express skip-if-exists, and it chmods 0755 — an executable `.gitignore`.
     *
     * Never fatal: a scaffold that produced a complete, working project should
     * not fail over an ignore file the operator can write by hand.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to the project's `.gitignore`
     * @returns {boolean} true when written, false when one already existed or the write was skipped
     *
     * @example
     * createGitignoreFile('/path/to/project/.gitignore'); // → true on a fresh project
     * createGitignoreFile('/path/to/project/.gitignore'); // → false the second time
     */
    var createGitignoreFile = function(target) {
        try {
            if ( fs.existsSync(target) ) {
                return false
            }
            var source = _(getPath('gina').core + '/template/_gitignore', true).toString();
            if ( !fs.existsSync(source) ) {
                return false
            }
            fs.writeFileSync(target, fs.readFileSync(source));
            try { fs.chmodSync(target, 0o644) } catch (chmodErr) { /* best effort */ }
            return true
        } catch (gitignoreErr) {
            console.warning('[ project:add ] could not write `.gitignore`: ' + (gitignoreErr.message || gitignoreErr));
            return false
        }
    }


    /**
     * Creates or updates package.json from the framework template, merging
     * any existing file when isCreatedFromExistingPackage is true.
     *
     * @inner
     * @private
     * @param {string} target - Absolute path to package.json
     * @param {boolean} [isCreatedFromExistingPackage] - When true, merge with the existing file
     */
    var createPackageFile = function(target, isCreatedFromExistingPackage) {

        loadAssets();

        var conf = _(getPath('gina').core +'/template/conf/package.json', true);
        var contentFile = requireJSON(conf);

        var dic = {
            'project' : self.projectName,
            'node_version' : GINA_NODE_VERSION.match(/\d+/g).join('.'),
            'gina_version' : GINA_VERSION
        };

        contentFile = whisper(dic, contentFile);//data

        // Updating package.json if needed
        if (
            typeof(isCreatedFromExistingPackage) != 'undefined'
            && /^true$/i.test(isCreatedFromExistingPackage)
        ) {
            var existingPack = require(target);
            contentFile = merge(contentFile, existingPack);
            contentFile.version = existingPack.version || "1.0.0";
            new _(target, true).rmSync()
        }

        lib.generator.createFileFromDataSync(
            contentFile,
            target
        );

        // #B258 — the project's `.gitignore`, written only when absent. This is
        // the last scaffold step for both the new-project and the import path:
        // an imported project without one has exactly the same exposure as a
        // fresh one, and skip-if-exists keeps the import non-destructive.
        createGitignoreFile( _(self.projectLocation + '/.gitignore', true).toString() );

        end(true)
    }

    /**
     * Writes the project entry to projects.json, runs addBundlePorts and
     * addBundleToManifest in import mode, links gina, and exits the process.
     *
     * @inner
     * @private
     * @param {boolean} [created] - When true, use all available protocols/schemes (new project)
     */
    var end = async function(created) {

        var target      = _(GINA_HOMEDIR + '/projects.json')
            , projects  = JSON.clone(self.projects)
            , error     = false
        ;
        // Making sure the prefix is the right one
        let realGinaPrefix = GINA_PREFIX;
        try {
            realGinaPrefix = execSync('echo $(which gina)|sed s/\\\\/bin\\\\/gina$//').toString().trim();
        } catch (realGinaPrefixException) {
            let errMsg = '[helper] while trying to get real gina prefix\n' + realGinaPrefixException.stack;
            console.error(errMsg);
            process.exit(1)
        }

        if ( /^$true/i.test(local.imported) ) {
            if (self.scope) {
                self.defaultScope = self.scope
            }
            if (self.env) {
                self.defaultEnv = self.env
            }
        }

        projects[self.projectName] = {
            "path"              : self.projectLocation,
            "homedir"           : self.projectHomedir || _(getUserHome() +'/.'+ self.projectName, true),
            "bundles_path"      : self.projectBundlesPath || _(getUserHome() +'/.'+ self.projectName +'/bunldes', true),
            "releases_path"     : self.projectReleasesPath || _(getUserHome() +'/.'+ self.projectName +'/releases', true),
            "logs_path"         : self.projectLogsPath || _(getUserHome() +'/.'+ self.projectName +'/var/logs', true),
            "tmp_path"          : self.projectTmpPath || _(getUserHome() +'/.'+ self.projectName +'/tmp', true),
            "def_prefix"        : realGinaPrefix,
            "framework"         : "v" + GINA_VERSION,
            "envs"              : (self.envs && self.envs.length) ? self.envs : self.mainConfig['envs'][ GINA_SHORT_VERSION ],
            "def_env"           : self.defaultEnv || self.mainConfig['def_env'][ GINA_SHORT_VERSION ],
            "dev_env"           : self.devEnv || self.mainConfig['dev_env'][ GINA_SHORT_VERSION ],
            "scopes"            : (self.scopes && self.scopes.length) ? self.scopes : self.mainConfig['scopes'][ GINA_SHORT_VERSION ],
            "def_scope"         : self.defaultScope || self.mainConfig['def_scope'][ GINA_SHORT_VERSION ],
            "local_scope"       : self.localScope || self.mainConfig['local_scope'][ GINA_SHORT_VERSION ],
            "production_scope"  : self.productionScope || self.mainConfig['production_scope'][ GINA_SHORT_VERSION ],
            "protocols"         : (created) ? self.protocolsAvailable : self.protocols,
            "def_protocol"      : self.defaultProtocol,
            "schemes"           : (created) ? self.schemesAvailable : self.schemes,
            "def_scheme"        : self.defaultScheme
        };


        // On import only
        if ( /^true$/i.test(local.imported) ) {
            self.projects[self.projectName] = projects[self.projectName];

            self.bundles.sort();
            var bundleErr = null;
            // Create/update ports, protocols & schemes
            await promisify(addBundlePorts)(0)
                .catch( function onBundlePortsError(err) {
                    bundleErr = err;
                });
            if (bundleErr) {
                console.error('Could not finalize [ addBundlePorts ] \n'+ bundleErr.stack);
                process.exit(1)
            }

            // Create/update manifest
            await promisify(addBundleToManifest)(null, 0)
                .catch( function onBundleError(err) {
                    bundleErr = err;
                });
            if (bundleErr) {
                console.error('Could not finalize [ addBundleToManifest ] \n'+ bundleErr.stack);
                process.exit(1)
            }
        }

        console.warn('[import::'+ local.imported +'] self.env vs self.defaultEnv: ', self.env, self.defaultEnv);

        // writing file
        lib.generator.createFileFromDataSync(
            projects,
            target
        );



        var onSuccess = function () {
            if ( /project\:add/i.test(self.task) ) {
                console.log('Project [ '+ self.projectName +' ] has been added');
            } else {
                console.log('Project [ '+ self.projectName +' ] has been imported');
            }

            process.exit(0)
        }

        var onError = function (err) {
            console.error('Could not finalize [ '+ self.projectName +' ] install\n'+ err.stack);
            process.exit(1)
        }

        var ginaModule = new _( self.projectLocation +'/node_modules/gina',true );

        if ( !ginaModule.existsSync() ) {
            linkGina(onError, onSuccess)
        } else if ( /^true$/i.test(GINA_GLOBAL_MODE) ) {

            error = ginaModule.rmSync();

            if (error instanceof Error) {
                console.error(err.stack);
                process.exit(1);
            } else {
                linkGina(onError, onSuccess)
            }

        } else {
            onSuccess()
        }
    }

    /**
     * Verifies that the given protocol and scheme are allowed in the framework
     * configuration, optionally exiting with code 1 on failure.
     *
     * @inner
     * @private
     * @param {string} protocol - Protocol to validate (e.g. 'http/1.1', 'http/2.0')
     * @param {string} scheme - Scheme to validate (e.g. 'http', 'https')
     * @param {boolean} [exitOnError] - When true, call process.exit(1) on validation failure
     */
    var hasPastProtocolAndSchemeCheck = function (protocol, scheme, exitOnError) {
        loadAssets();

        // are selected protocol & scheme allowed ?
        if ( self.protocolsAvailable.indexOf(protocol) < 0 ) {
            console.error('Protocol [ '+scheme+' ] is not an allowed protocol: check your framework configuration (~/main.json)');
            if ( typeof(exitOnError) != 'undefined' && exitOnError)
                process.exit(1)
        }
        if ( self.schemesAvailable.indexOf(scheme) < 0 ) {
            console.error('Scheme [ '+scheme+' ] is not an allowed scheme: check your framework configuration (~/main.json)');
            if ( typeof(exitOnError) != 'undefined' && exitOnError)
                process.exit(1)
        }
    }

    /**
     * Scans for available ports for one bundle at a time (index `b`), then
     * assigns all collected ports across every protocol/scheme/env combination
     * and writes ports.json and ports.reverse.json when all bundles are done.
     * Also used by the `port:reset` command.
     *
     * Bundles declared in the manifest but absent from disk (e.g. restricted to
     * other scopes — #B373) carry no `configPaths`; the settings-consistency
     * check skips them (#B375) while their port entries are still processed.
     *
     * @inner
     * @private
     * @param {number} b - Current bundle index into self.bundles
     * @param {function} done - Node-style callback `(err: Error|false) => void`
     */
    var addBundlePorts = async function(b, done) {
        loadAssets();

        if (b > self.bundles.length-1) { // writing to files on complete

            hasPastProtocolAndSchemeCheck(self.defaultProtocol, self.defaultScheme, true);

            //console.debug('self.protocols ...', self.protocols);
            // get user protocols list
            var protocols = JSON.clone(self.protocols);
            // get user schemes list
            var schemes = JSON.clone(self.schemes);
            var projectConfig   = JSON.clone(self.projects);

            //console.debug('about to update project ports conf\n\rBundles: '+ JSON.stringify(self.projectData, null, 4));
            var ports               = JSON.clone(self.portsData) // cloning
                , portsReverse      = JSON.clone(self.portsReverseData) // cloning
                , portsList         = local.ports
                , isPortUsed        = false
                , envs              = self.envs
                , i                 = 0
                , defaultProtocol   = self.defaultProtocol
                , defaultScheme     = self.defaultScheme
            ;

            if ( typeof(ports[defaultProtocol]) == 'undefined' ) {
                ports[defaultProtocol] = {};
            }

            if ( typeof(ports[defaultProtocol][defaultScheme]) == 'undefined' ) {
                ports[defaultProtocol][defaultScheme] = {};
            }

            // to fixe bundle settings inconsistency
            var bundleConfig    = null;
            var settingsPath    = null;
            var bundleSettingsUpdate = false;

            var portValue = null, portReverseValue = null;
            var re = null, portsListStr = JSON.stringify(self.portsData);

            for (;i < portsList.length; ++i) {

                if ( !ports.count() ) {
                    ports[defaultProtocol] = {};
                    ports[defaultProtocol][defaultScheme] = {};
                    ports[defaultProtocol][defaultScheme][ portsList[i] ] = null;
                }


                for ( let protocol in ports ) {
                    // ignore unmatched protocol : in case of the framework update
                    if ( self.protocolsAvailable.indexOf(protocol) < 0) {
                        delete ports[protocol];
                        if ( protocols.indexOf(protocol) < 0) {
                            delete self.protocols[self.protocols.indexOf(protocol)];
                        }
                        continue;
                    }

                    for (let scheme in ports[protocol]) {

                        // skipping none `https` schemes for `http/2`
                        if ( /^http\/2/.test(protocol) && scheme != 'https' ) {
                            console.debug('skipping none `https` schemes for `http/2`');
                            continue;
                        }

                        if ( !ports[protocol][scheme].count() ) {
                            ports[protocol][scheme][ portsList[i] ] = null;
                        }

                        for (let b = 0, bLen = self.bundles.length; b < bLen; ++b) {

                            local.bundle = self.bundles[b];

                            // bundle settings inconsistency check @ fix
                            bundleName              = local.bundle;
                            bundleConfig            = self.bundlesByProject[self.projectName][bundleName];
                            // #B375 — a bundle declared in the manifest but absent from disk
                            // (e.g. restricted to other scopes) carries no `configPaths`: skip
                            // its settings-consistency check instead of throwing; the ports
                            // handling below is unaffected.
                            settingsPath            = ( bundleConfig && bundleConfig.configPaths ) ? _(bundleConfig.configPaths.settings, true) : null;
                            bundleSettingsUpdate    = false;

                            if ( settingsPath && fs.existsSync(settingsPath) ) {

                                bundleSettings  = requireJSON(settingsPath);
                                //console.debug('found [ '+ bundleName +' ] settings ');
                                if ( typeof(bundleSettings.server) != 'undefined' ) {
                                    // #B378 — this heal is what makes an invalid declaration
                                    // bootable again, but a user file must never be rewritten
                                    // silently: every change is collected and reported by name.
                                    var _settingsChanges = [];
                                    // update only if given bundle protocol setting not in project protocols list
                                    // use project def_protocol by default in that case
                                    if (
                                        typeof(bundleSettings.server.protocol) != 'undefined'
                                        && protocols.indexOf(bundleSettings.server.protocol) < 0
                                    ) {
                                        _settingsChanges.push('server.protocol "'+ bundleSettings.server.protocol +'" -> "'+ self.defaultProtocol +'"');
                                        bundleSettings.server.protocol = self.defaultProtocol;
                                        bundleSettingsUpdate = true
                                    }

                                    // update only if given bundle scheme setting not in project schemes list
                                    // use project def_scheme by default in that case
                                    if (
                                        typeof(bundleSettings.server.scheme) != 'undefined'
                                        && schemes.indexOf(bundleSettings.server.scheme) < 0
                                    ) {
                                        _settingsChanges.push('server.scheme "'+ bundleSettings.server.scheme +'" -> "'+ self.defaultScheme +'"');
                                        bundleSettings.server.scheme = self.defaultScheme;
                                        bundleSettingsUpdate = true
                                    }

                                    if (bundleSettingsUpdate) {
                                        lib.generator.createFileFromDataSync(bundleSettings, settingsPath);
                                        console.warn('Updated [ '+ bundleName +' ] settings: '+ _settingsChanges.join('; ') +' — the declared value is not in the project protocols/schemes list.');
                                    }
                                }
                            }

                            // updating ports
                            for (let port in ports[protocol][scheme]) {


                                    for (let e = 0, envsLen = envs.length; e < envsLen; ++e ) {

                                        if (!portsList[i]) break;

                                        // ports
                                        portValue = local.bundle +'@'+ self.projectName +'/'+ envs[e];
                                        re = new RegExp(portValue);


                                        if ( !re.test(portsListStr) ) {

                                            // ports - add only if not existing
                                            isPortUsed = false;

                                            for (let portNum in ports[protocol][scheme]) {
                                                if ( ports[protocol][scheme][portNum] == portValue ) {
                                                    isPortUsed = true;
                                                    break;
                                                }
                                            }
                                            //console.debug('portValue -> ', portValue+ ': '+ portsList[i] +' ? ' +isPortUsed);
                                            if (!isPortUsed) {
                                                //console.debug(local.bundle, ': ',portsList[i], ' => ', portValue);
                                                ports[protocol][scheme][ portsList[i] ] = portValue;

                                                // reverse ports
                                                portReverseValue = portsList[i];
                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ] = {};

                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ] = {};

                                                if ( typeof(portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ]) == 'undefined' )
                                                    portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ] = {};

                                                // erasing in order to keep consistency
                                                portsReverse[ local.bundle +'@'+ self.projectName ][ envs[e] ][ protocol ][ scheme ] = ~~portsList[i];


                                                ++i;
                                            }
                                        }
                                    }

                                }
                        }
                    }
                }
            }

            // save to ~/.gina/projects.json
            lib.generator.createFileFromDataSync(projectConfig, self.projectConfigPath);

            // save to ~/.gina/ports.json
            //console.debug('data \n'+ JSON.stringify(self.portsData, null, 4) +'\n\rcurrent \n'+ JSON.stringify(ports, null, 4));
            lib.generator.createFileFromDataSync( merge(self.portsData, ports), self.portsPath);

            // save to ~/.gina/ports.reverse.json
            lib.generator.createFileFromDataSync( merge(self.portsReverseData, portsReverse), self.portsReversePath);


            return done(false);
        }

        //console.debug('Bundles list on project import [ '+ b +' ]', self.bundles.length, self.bundles);
        var options     = {}
            , bundle    = self.bundles[b]
        ;

        if ( /^[a-z0-9_.]/.test(bundle) ) {

            local.b             = b;
            local.bundle        = bundle;

            // find available port
            options = {
                // ignore  : merge(self.portsGlobalList, local.ports),
                ignore  : local.ports,
                // get for each bundle ports for available protocol, scheme & env
                limit   : ( self.protocolsAvailable.length * self.schemesAvailable.length * self.envs.length * self.bundles.length )
            };

            // defining range startFrom depending of the project index (self.projectsList - OK only)...
            if (self.startFrom) {
                options.startFrom = self.startFrom;
            } else { // Find startFrom out of projects
                options.startFrom = ~~(''+ (self.projectsList.indexOf(self.projectName)+3) + 100);
            }
            // scanning for available ports ...
            await scan(options, function(err, ports){
                if (err) {
                    console.error(err.stack||err.message);
                    process.exit(1)
                }


                for (let p = 0; p < ports.length; ++p) {
                    local.ports.push(ports[p])
                }

                local.ports.sort();

                ++local.b;
                addBundlePorts(local.b, done);
            });
        } else {
            // console.error('[ '+ bundle+' ] is not a valid bundle name')
            return done( new Error('[ '+ bundle+' ] is not a valid bundle name'))
        }
    }

    /**
     * Iterates over bundles and populates their release targets in the manifest,
     * then writes manifest.json when all bundles are done.
     *
     * Additive (#B55): an existing bundle entry and its `releases` map are
     * preserved — only scope×env cells that have no target yet are seeded with a
     * default. Release targets previously registered under other scopes/envs (and
     * any custom target path/version) survive a `project:import`; only a bundle
     * that is new to the manifest gets the default skeleton.
     *
     * @inner
     * @private
     * @param {object|null} data - Working copy of the manifest; null on first call
     * @param {number} b - Current bundle index into self.bundles
     * @param {function} done - Node-style callback `(err: Error|false) => void`
     */
    var addBundleToManifest = function(data, b, done) {

        loadAssets();

        if ( typeof(data) == 'undefined' || !data ) {
            data = JSON.clone(self.projectData);
        }

        if (b > self.bundles.length-1) { // writing to files on complete

            lib.generator.createFileFromDataSync(data, self.projectManifestPath);

            return done(false);
        }

        var bundle = self.bundles[b];

        if ( /^[a-z0-9_.]/.test(bundle) ) {

            local.b             = b;
            local.bundle        = bundle;

            var version = '0.0.1';
            var scopes  = self.projects[self.projectName].scopes || self.scopes || self.mainConfig['scopes'][ GINA_SHORT_VERSION ];
            var envs    = self.projects[self.projectName].envs || self.envs || self.mainConfig['envs'][ GINA_SHORT_VERSION ];

            // #B55 — `project:import` must be additive: only seed the default
            // bundle entry when the bundle is NEW to this manifest. Preserving an
            // existing entry (and its `releases` map) keeps release targets
            // previously registered under other scopes/envs — and any custom
            // target path/version — from being dropped on import. Mirrors the
            // additive pattern in lib/cmd/bundle/build.js (only set a target when
            // one is absent). Previously this block reset `releases` to `{}` on
            // every import, wiping every other scope×env's target.
            if ( typeof(data.bundles[local.bundle]) == 'undefined' || !data.bundles[local.bundle] ) {
                data.bundles[local.bundle] = {
                    "_comment"  : "Your comment goes here.",
                    "version"   : version,
                    "tag"       : ( version.split('.') ).join(''),
                    "src"       : "src/" + local.bundle,
                    "link"      : "bundles/"+ local.bundle,
                    "releases"  : {}
                };
            }
            // an existing bundle entry may pre-date the `releases` map
            if ( typeof(data.bundles[local.bundle].releases) == 'undefined' || !data.bundles[local.bundle].releases ) {
                data.bundles[local.bundle].releases = {};
            }
            // seed any default target path below with the bundle's real version
            version = data.bundles[local.bundle].version || version;
            //"release/"+ local.bundle +"/local/prod/" + version
            for (let s = 0, sLen = scopes.length; s < sLen; ++s) {
                let scope = scopes[s];
                if ( typeof(data.bundles[local.bundle].releases[scope]) == 'undefined' ) {
                    data.bundles[local.bundle].releases[scope] = {}
                }
                for (let i = 0, len = envs.length; i < len; ++i) {
                    let env = envs[i];
                    // ignore target for dev env
                    if ( self.projects[self.projectName]['dev_env'] == env ) {
                        continue;
                    }
                    if ( typeof(data.bundles[local.bundle].releases[scope][env]) == 'undefined' ) {
                        data.bundles[local.bundle].releases[scope][env] = {}
                    }
                    // additive: only seed a default target when none exists — never
                    // clobber a custom target path/version already registered here.
                    if ( typeof(data.bundles[local.bundle].releases[scope][env].target) == 'undefined' ) {
                        data.bundles[local.bundle].releases[scope][env].target = "releases/"+ local.bundle +"/"+ scope +"/"+ env +"/" + version;
                    }
                }
            }


            ++local.b;
            addBundleToManifest(data, local.b, done);

        } else {
            // console.error('[ '+ bundle+' ] is not a valid bundle name')
            // process.exit(1)
            return done( new Error('[ '+ bundle+' ] is not a valid bundle name'))
        }
    }

    /**
     * Creates the project's `node_modules/gina` symlink by invoking the running
     * install's own CLI: `<node> <gina root>/bin/cli link @<project>`.
     *
     * The CLI path is resolved from this file's location — NOT from a PATH-resolved
     * `gina` binary: the PATH may carry no gina at all (a repo checkout where
     * `npm install --ignore-scripts` skipped the bin linking) or a different install
     * than the one executing `project:add`. Same rationale as framework/link.js,
     * which resolves the symlink source from its own location.
     *
     * Success is verified on the actual postcondition — the symlink exists — because
     * the Shell helper reports any stderr output as an error even when the command
     * succeeded.
     *
     * The child is spawned with the parent's environment PLUS an explicit
     * GINA_HOMEDIR: the CLI bootstrap moves every GINA_* key out of process.env
     * (read back via getEnvVar), so without the re-export a home override would
     * never reach the child — it would resolve the default home, miss the
     * just-registered project, and fail the link. When the postcondition fails,
     * the tail of the child's captured output is appended to the error so the
     * child's own failure message is not lost with its temp logs.
     *
     * @inner
     * @private
     * @param {function} onError - Called with an Error when the gina symlink is still missing after the link attempt
     * @param {function} onSuccess - Called with no arguments on success
     */
    var linkGina = function ( onError, onSuccess ) {

        var npm = new Shell();

        // Re-export the home: the bootstrap env sweep strips GINA_* from
        // process.env, so the child would otherwise resolve the default home
        // and miss a project registered under a GINA_HOMEDIR override.
        npm.setOptions({
            chdir   : self.projectLocation,
            env     : Object.assign({}, process.env, { GINA_HOMEDIR: GINA_HOMEDIR })
        });
        npm
            // .run('npm link gina', true)
            // was: .run('gina link @'+ self.projectName, true)
            // A PATH-resolved binary is not guaranteed to exist (repo checkout,
            // non-global install) and its failure was silently swallowed — the
            // scaffolded bundle then crashed at boot with MODULE_NOT_FOUND on its
            // framework require. Invoke the running install's own CLI instead.
            .run([ process.execPath, require('path').resolve(__dirname, '../../../../..', 'bin/cli'), 'link', '@'+ self.projectName ], true)
            .onComplete(function (err, data) {

                var ginaModule = _(self.projectLocation + '/node_modules/gina', true);
                if ( !fs.existsSync(ginaModule) ) {
                    // The child's stdio goes to temp logs the Shell helper deletes on
                    // close; the real failure is printed by the child through the
                    // logger (on stdout), so surface its tail with the error.
                    var childOutput = ( data && String(data).trim().length > 0 ) ? '\n[ link output ] '+ String(data).trim().slice(-800) : '';
                    err = new Error('Could not create the gina symlink in [ '+ self.projectLocation +'/node_modules ]'+ ( err ? '\n'+ ( err.stack || err ) : '' ) + childOutput);
                    if ( typeof(onError) != 'undefined' ) {
                        return onError(err);
                    }
                    return console.error(err.stack);
                }

                if ( typeof(onSuccess) != 'undefined' )
                    onSuccess()
            })
    }

    init()
}
module.exports = Add;