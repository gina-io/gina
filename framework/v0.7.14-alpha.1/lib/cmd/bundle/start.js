const fs            = require('fs');
const { EventEmitter }  = require('events');
const { spawn }     = require('child_process');
const { execSync }  = require('child_process');
// #B665 (2026-09-27) — execFileSync: the reinstall's framework:link step runs from an argument vector.
const { execFileSync } = require('child_process');
const util = require('util');
const promisify = require('util').promisify;

var CmdHelper   = require('./../helper');
// Runtime detection (Bun vs Node) for the PM-aware reinstall below. Required by a
// plain relative path (the bare `lib/<name>` form is unavailable in CLI/daemon scope).
var runtime     = require(__dirname + '/../../../../../utils/runtime.js');
// #B691 (2026-09-27) — picks a bundle's warn-and-above boot lines out of its stdout for the
// client. Relative path: the bare `lib/<name>` form is unavailable in CLI/daemon scope.
var bootLines   = require('./inc/boot-lines');
var escapeRegex = require('./inc/name-rewrite').escapeRegex;
// #B851 — the outcome this command reports to the CLI (frames, exit codes, the bind failure)
// and the « already running » rule; ps-titles reads a pid's title without a shell. Relative
// paths: the bare `lib/<name>` form is unavailable in CLI/daemon scope.
var startStatus = require('./inc/start-status');
var psTitles    = require('./../framework/inc/ps-titles');
// `lib` is previously defiened as this file is required by anoth
// For user output
var terminal    = lib.logger;
// For logs/tail output thru the parent
var console     = null;
/**
 * @module gina/lib/cmd/bundle/start
 */
/**
 * Starts a given bundle or all bundles in a project.
 *
 * Usage:
 *  gina bundle:start <bundle_name> @<project_name>
 *  gina bundle:start @<project_name>
 *  gina bundle:start @<project_name> --max-old-space-size=4096 --inspect=5858
 *
 * Per-bundle framework version override:
 *  Pin a bundle to a specific installed gina version via CLI flag:
 *    gina bundle:start <bundle_name> @<project_name> --gina-version=0.1.8
 *  Or declare it statically in manifest.json under bundles[<name>].gina_version.
 *  The declared version is validated against the tracked versions in ~/.gina/main.json
 *  before the bundle process is spawned. The socket server continues running its
 *  own version; only the spawned bundle process uses the declared version.
 *
 * To inspect the command handler itself, first restart gina with `--inspect-gina`.
 *
 * @class Start
 * @constructor
 * @param {object} opt - Parsed command-line options
 * @param {object} opt.client - Socket client for terminal output
 * @param {string[]} opt.argv - Full argv array
 * @param {number} [opt.debugPort] - Node.js inspector port
 * @param {boolean} [opt.debugBrkEnabled] - True when --inspect-brk is active
 * @param {object} cmd - The cmd dispatcher object (lib/cmd/index.js)
 */
function Start(opt, cmd) {
    var self    = {};
    // terminal.register(console, opt.client.write);


    /**
     * Imports CmdHelper and delegates to start() or bulk-start().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     */
    var init = function(opt, cmd) {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        // #B855 — isCmdConfigured() is async: the Promise it returns is always truthy, so this
        // guard never fired. Its body runs synchronously, and a refusal in it called exit(), which
        // ended the framework daemon this handler runs in. exit() now ends only this client and
        // marks the command: stop here.
        // was: if (!isCmdConfigured()) return false;
        isCmdConfigured();
        if (self.cmdExited) return false;


        // start all bundles
        opt.onlineCount = 0;
        opt.notStarted = [];
        // #B851 — the first failure's exit code (end() sends it to the CLI)
        opt.exitCode = 0;

        if (!self.name) {
            // bulk mode needs at least one bundle — `self.bundles[0]` is undefined on a zero-bundle
            // project, and the resulting throw would take down the framework daemon (bin/cmd)
            if ( !self.bundles || !self.bundles.length ) {
                opt.msg = 'No bundles found in project `@'+ self.projectName +'`.\nDid you run `gina bundle:add <bundle> @'+ self.projectName +'` first?';
                return end(opt, cmd, false, undefined, true);
            }
            return start(opt, cmd, 0);
        }

        start(opt, cmd);
    }

    /**
     * #B890 — the error this command reports for a project file it cannot use. Its message
     * names the file and the reason (the reason names the path), and it carries no stack: the
     * branches that report it print `err.stack` (isRealApp's callback, proceedToStart), and
     * the frames of a fault the user fixes in that file would only bury the reason.
     *
     * @inner
     * @private
     * @param {string} name - the file's name as the message shows it (`manifest.json`)
     * @param {Error} err - the read or parse error (parseJSONWithComments() names the file)
     * @returns {Error} an Error whose message and stack are « <name> cannot be used: <reason> »
     *
     * @example
     * cb(fileError('package.json', parseErr));
     * // Error: package.json cannot be used: could not parse `/path/to/package.json`: …
     */
    var fileError = function(name, err) {
        var e = new Error(name +' cannot be used: '+ err.message);
        e.stack = e.message;
        return e;
    };

    /**
     * Checks if the project's node_modules need to be reinstalled due to an arch/platform mismatch.
     * Reinstalls via `npm install` (or `bun install` under Bun) if needed, re-links
     * gina with this install's own `bin/gina framework:link`, run under the current
     * runtime from an argument vector without a shell (#B665), then calls cb(false)
     * to proceed. A project package.json that cannot be read or parsed calls cb() with
     * « package.json cannot be used: <reason> » (#B890: requireJSON() ended the daemon).
     * @inner
     * @private
     * @param {object} opt
     * @param {function} cb - Called with (err) — err is false when node_modules are ready
     */
    var checkArchAgainstNodeModules = function(opt, cb) {

        var currentArch         = GINA_ARCH
            , currentPlatform   = GINA_PLATFORM
            , projectObj        = self.projects[ self.projectName ]
            , packagePathObj    = new _(projectObj.path +'/package.json', true)
            , packagePath       = packagePathObj.toString()
        ;

        if ( !packagePathObj.existsSync() ) {
            terminal.warn('[checkArchAgainstNodeModules] File`'+packagePath +'` not found');
            return cb(false);
        }

        var gnaPath    =  _(projectObj.path +'/.gna', true);
        var gnaPathObj  =  new _(gnaPath, true);
        if ( ! gnaPathObj.existsSync() ) {
            gnaPathObj.mkdirSync()
        }

        var isNodeModulesReinstallNeeded = false;
        var nodeModulesPathObj = new _(projectObj.path +'/node_modules', true);


        var projectArchFileObj = new _(gnaPath +'/arch', true);
        var projectArchFile = projectArchFileObj.toString();
        var projectPlatformFileObj = new _(gnaPath +'/platform', true);
        var projectPlatformFile = projectPlatformFileObj.toString();
        var nodeModulesContentArr = ( nodeModulesPathObj.existsSync() && !nodeModulesPathObj.isSymlinkSync() ) ? fs.readdirSync(nodeModulesPathObj.toString()) : [];
        var newNodeModulesContentArr = [], n = 0;
        for (let f in nodeModulesContentArr) {
            if (/^\./.test(nodeModulesContentArr[f]) ) {
               continue
            }
            newNodeModulesContentArr[n] = nodeModulesContentArr[f];
        }
        nodeModulesContentArr = newNodeModulesContentArr.slice();
        newNodeModulesContentArr = null;

        var pack    = null;
        try {
            pack = parseJSONWithComments(fs.readFileSync(packagePath, 'utf8'), packagePath);   // #B890 — requireJSON() ended the daemon on a malformed package.json
        } catch (packErr) {
            return cb(fileError('package.json', packErr));
        }
        var scope   = process.env.NODE_SCOPE || self.defaultScope
        var env     = process.env.NODE_ENV || self.defaultEnv;

        if (
            !projectArchFileObj.existsSync()
            ||
            !projectPlatformFileObj.existsSync()
            ||
            projectArchFileObj.existsSync()
            && fs.readFileSync(projectArchFile).toString() != currentArch
            ||
            projectPlatformFileObj.existsSync()
            && fs.readFileSync(projectPlatformFile).toString() != currentPlatform
            ||
            !nodeModulesPathObj.existsSync()
            ||
            nodeModulesPathObj.existsSync()
            && !nodeModulesPathObj.isSymlinkSync()
            && !nodeModulesContentArr.length
            ||
            nodeModulesPathObj.existsSync()
            && nodeModulesContentArr.length == 1
            && nodeModulesContentArr[0] == 'gina'
            && typeof(pack.dependencies) == 'object'
            && pack.dependencies.count() > 0
        ) {
            if (scope == "local")
                isNodeModulesReinstallNeeded = true;
        }

        opt.client.write('\nScope: '+ scope);
        opt.client.write('\nEnv: '+ env);
        opt.client.write('\nArch: '+ currentArch);
        opt.client.write('\nPlatform: '+ currentPlatform);
        opt.client.write('\nisNodeModulesReinstallNeeded: '+ isNodeModulesReinstallNeeded);

        // TODO - Do we want this for production ?
        if (isNodeModulesReinstallNeeded) {
            // remove node_modules
            if ( nodeModulesPathObj.existsSync() ) {
                nodeModulesPathObj.rmSync();
            }
        }

        // reinstall node_modules if needed
        if ( isNodeModulesReinstallNeeded ) {
            var initialDir = process.cwd();
            // Bun-only images ship no npm — use `bun install` under Bun. Zero Node
            // delta: isBun() is false on Node, so npmCmd is byte-identical to before.
            var npmCmd = runtime.isBun()
                             ? 'bun install'
                             : ( ( isWin32() ) ? 'npm.cmd install' : 'npm install' );
            process.chdir( _(projectObj.path, true) );

            opt.client.write('\nRe-installing node_modules to match arch & platform');
            opt.client.write('\nrunning: `'+ npmCmd +'` from '+ process.cwd() );
            opt.client.write('\nrunning using TMPDIR: '+  _(getTmpDir(), true) );
            var oldConfigGlobal = process.env.npm_config_global;
            process.env.npm_config_global = false;
            var result = null; resultError = false;
            try {
                result = execSync(npmCmd).toString();
                // #B665 (2026-09-27) — this install's own bin/gina, run from an argument vector,
                // without a shell: `which gina` could find no gina or a different install, and
                // the project name reached `sh` unquoted. runtimeBinary() keeps the Bun
                // behaviour (the running Bun binary, so a no-node image never meets the
                // `#!/usr/bin/env node` shebang); under Node it returns the running node.
                // was: var ginaBin = execSync('which gina').toString().trim();
                // was: var linkCmd = runtime.isBun()
                // was:                   ? runtime.runtimeBinary() +' '+ ginaBin +' framework:link @'+ self.projectName
                // was:                   : ginaBin +' framework:link @'+ self.projectName;
                // was: execSync(linkCmd);
                var ginaBin = require('path').resolve(__dirname, '../../../../..', 'bin/gina');
                execFileSync(runtime.runtimeBinary(process.execPath), [ginaBin, 'framework:link', '@' + self.projectName]);
            } catch (err) {
                resultError = err;
            }

            process.chdir(initialDir);
            process.env.npm_config_global = oldConfigGlobal;

            if (resultError) {
                opt.msg = resultError.stack || resultError.message || resultError;
                return cb(resultError);
                // return end(opt, cmd)
            }

            opt.client.write('\n'+result);

            opt.client.write('\r\nPlease wait...');

            // handle node_modules installed
            var e = new EventEmitter();
            var trigger = self.projectName +'_'+ self.name +'#node-modules-installed';
            var nIntervId = null;

            e.once(trigger, function onBundleStarted(done) {
                clearInterval(nIntervId);
                nIntervId = null;

                opt.client.write('\nOk, I am ready :)');
                lib.generator.createFileFromDataSync(GINA_ARCH, projectArchFile);
                lib.generator.createFileFromDataSync(GINA_PLATFORM, projectPlatformFile);
                setTimeout(() => {
                    done(false)
                }, 500); // 1000

            });

            var nodeModulesPath = nodeModulesPathObj.toString();
            var found = false;
            nIntervId = setInterval(() => {
                // Check for modules availability
                found = new _(nodeModulesPath +'/gina', true).existsSync();

                if ( found ) {
                    clearInterval(nIntervId);
                    e.emit(trigger, cb)
                }
            }, 200);

            return;
        }

        cb(false);
    }



    /**
     * Spawns the bundle process, monitors stdout for start/error signals, passes the
     * bundle's warn-and-above boot lines on to the client (#B691), and calls end().
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     * @param {number} [bundleIndex] - When set, enables bulk-start mode
     */
    var start = function(opt, cmd, bundleIndex) {

        // getting the debug port
        var debugStr = null;
        if ( /\-\-(inspect|debug)/.test(opt.argv.join(',')) ) {
            var pArr = null;
            for (let i = 0, len = opt.argv.length; i<len; i++) {
                if ( /\-\-(inspect|debug)/.test(opt.argv[i]) ) {
                    pArr = opt.argv[i].replace(/\s+/g, '').split(/=/);
                    opt.debugBrkEnabled = /\-brk/.test(pArr[0]);
                    opt.debugPort = pArr[1];
                    debugStr = opt.argv[i];
                    break;
                }
            }
        }


        var isBulkStart = (typeof(bundleIndex) != 'undefined') ? true : false;

        var bundle = (isBulkStart) ? self.bundles[bundleIndex] : self.name;
        // terminal.debug('bundle -> ', bundle);

        var msg = null;
        // #B890 — a bundle the ports registry knows but the manifest does not declare (a
        // manifest.json rewritten from the template after it went missing) is refused here
        // too: the lines below read its manifest entry, and threw a TypeError on `def_env`
        var isDeclared = !!( self.bundlesByProject[self.projectName] && typeof(self.bundlesByProject[self.projectName][bundle]) != 'undefined' );
        // was: if ( !isBulkStart && !isDefined('bundle', bundle) ) {
        if ( !isBulkStart && ( !isDefined('bundle', bundle) || !isDeclared ) ) {
            msg = 'Bundle [ '+ bundle +' ] is not registered inside `@'+ self.projectName +'`.\nDid you run `gina bundle:add '+ bundle +' @'+ self.projectName +'` first?';
            terminal.error(msg);

            opt.msg = msg;
            return end(opt, cmd, isBulkStart, bundleIndex, true)
        }

        var env = ( typeof(self.bundlesByProject[self.projectName][bundle].def_env) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_env : self.defaultEnv;
        var scope = ( typeof(self.bundlesByProject[self.projectName][bundle].def_scope) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_scope : self.defaultScope;
        // terminal.debug('env -> ', env);
        var protocol = self.bundlesByProject[self.projectName][bundle].def_protocol;
        // terminal.debug('protocol -> ', protocol);
        var scheme = self.bundlesByProject[self.projectName][bundle].def_scheme;
        // terminal.debug('scheme -> ', scheme);
        var bundlePort = self.portsReverseData[bundle + '@' + self.projectName][env][protocol][scheme];
        // terminal.debug('port -> ', bundlePort);

        var isStarting  = false
            , params    = null
            , index     = null
            , i         = null
            , len       = null
        ;

        isRealApp(bundle, function(err, appPath, bundleDir){

            if (err) {
                // Surface the error to the terminal AND close the CLI socket.
                // Previously this branch only called terminal.error() — the connected
                // `gina bundle:start` client would then wait forever on a daemon that
                // had already given up. end() writes `opt.msg` back to the client and
                // ends the connection so the CLI process can exit cleanly.
                terminal.error(err.stack||err.message);
                opt.msg = err.stack || err.message;
                return end(opt, cmd, isBulkStart, bundleIndex, true);
            } else {
                if (isStarting)
                    return;

                // #B851 / #B854 — a bundle that already runs is not started again. A second start
                // spawned a child that overwrote the running bundle's pid file with its own pid,
                // could not bind the port and removed the file as it exited (measured), so
                // `bundle:status` read the running bundle as stopped; the command printed the
                // bind error and exited 0. Checked before the node_modules check, which may
                // remove and reinstall node_modules under the running bundle.
                var runningPid = findRunning(bundle, appPath);
                if ( runningPid !== null ) {
                    ++opt.onlineCount;
                    opt.client.write('\n\r  [ ' + bundle + '@' + self.projectName + ' ] is already running with PID [ ' + runningPid + ' ]');
                    return end(opt, cmd, isBulkStart, bundleIndex, 0);
                }


                var proceedToStart = function(nodeModulesErr) {
                    if (nodeModulesErr) {
                        opt.msg = nodeModulesErr.stack;
                        return end(opt, cmd, isBulkStart, bundleIndex, true)
                    }


                    msg = 'Trying to start bundle [ ' + bundle + '@' + self.projectName + ' ]';
                    if (opt.debugPort) {
                        msg += ' (debug port: '+ opt.debugPort +')'
                    }
                    // To gina log
                    terminal.info(msg);
                    // to the terminal stdout
                    opt.client.write('\n\r'+msg);



                    process.list = (process.list == undefined) ? [] : process.list;
                    setContext('processList', process.list);
                    setContext('ginaProcess', process.pid);
                    setContext('debugPort', opt.debugPort);
                    setContext('debugBrkEnabled', opt.debugBrkEnabled);

                    // setPath('node_modules', _(self.projectLocation + '/node_modules', true));

                    // Build the context for the child process.
                    // When a per-bundle gina version is declared, clone the context so
                    // the GINA_VERSION/GINA_FRAMEWORK_DIR/GINA_CORE overrides are
                    // isolated to this spawn and do not affect concurrent bundle starts.
                    var _ctx = getContext();
                    // Populate envVars so gna.js defineDefault() can create GINA_* globals.
                    // gina-container does this explicitly; the socket-server path must too.
                    if ( !_ctx.envVars ) _ctx.envVars = process.gina;
                    if ( self.bundleGinaVersion ) {
                        _ctx = JSON.clone(_ctx);
                        var _ginaDir = getEnvVar('GINA_DIR');
                        _ctx.envVars['GINA_VERSION']       = self.bundleGinaVersion;
                        _ctx.envVars['GINA_FRAMEWORK_DIR'] = _ginaDir + '/framework/v' + self.bundleGinaVersion;
                        _ctx.envVars['GINA_CORE']          = _ginaDir + '/framework/v' + self.bundleGinaVersion + '/core';
                        terminal.info('Bundle ['+ bundle +'@'+ self.projectName +'] using framework v'+ self.bundleGinaVersion);
                    }

                    params = [
                        // node arguments will be passed by gina
                        appPath,
                        //Passing context to child.
                        JSON.stringify(_ctx),
                        // project name
                        self.projectName,
                        // bundle name
                        bundle
                    ];

                    // injecting node arguments
                    index = 0; i = 0; len = self.nodeParams.length;
                    if (len > 0) {
                        for (; i < len; ++i) {
                            params.splice(index, 0, self.nodeParams[i]);
                            ++index
                        }
                    }

                    i = 0; len = params.length;
                    for (; i < len; ++i) {
                        if (params[i] == '') {
                            params.splice(i, 1);
                        }
                    }

                    // terminal.debug('Spawning '+ opt.argv[0] +' [with args] '+ params);

                    var child = spawn(opt.argv[0], params,
                        {
                            // cwd: bundleDir,
                            detached: true
                        }
                    );

                    child.stdout.setEncoding('utf8');//Set encoding.

                    // CMD Auto Exit
                    var retry = 0, maxRetry = 15, maxTimeout = (self.debugBrkEnabled) ? 1200000 : 4000;
                    var timerId = setInterval(function() {
                        if (!isStarting ) {
                            ++retry;
                            //opt.client.write('what is wrong ? '+ retry);
                        } else {
                            clearInterval(timerId);
                        }

                        if (retry > maxRetry) {
                            clearInterval(timerId);
                            opt.client.write('Sorry my friend, this is taking too long ! Terminating. Check your logs.');
                            child.kill('SIGKILL');
                            // #B851 — was: 'exit' and 'end' emitted on the client without end(), so
                            // no outcome, and in bulk mode the bundles after this one never started.
                            // if (!opt.client.destroyed) {
                            //     opt.client.emit('exit');
                            //     opt.client.emit('end');
                            // }
                            opt.notStarted.push(bundle + '@' + self.projectName);
                            settle(1);
                        }
                    }, maxTimeout);

                    // #B851 — one outcome per attempt. Several paths can see one failure (an emerg
                    // line, then the exit); a second end() wrote to an ended client and, in bulk
                    // mode, started the next bundle twice.
                    var settled = false;
                    var settle = function(code) {
                        if (settled) {
                            return false;
                        }
                        settled = true;
                        clearInterval(timerId);
                        end(opt, cmd, isBulkStart, bundleIndex, code);
                        return true;
                    };
                    // #B851 — the bind failure core/server.js reports before it ends the boot
                    var bindFailure = null;

                    // #B851 review F2 — a spawn that fails (the runtime binary gone, EAGAIN, EMFILE)
                    // emits 'error' on the child and no 'exit'. With no listener it was an uncaught
                    // exception in this daemon, which proc.js only logs here, and nothing ended the
                    // attempt until the watchdog. It ends at once now. An 'error' once the attempt
                    // has its outcome (a kill that failed) is only logged.
                    child.on('error', function(spawnErr) {
                        var reason = ( spawnErr && spawnErr.code ) ? spawnErr.code : String( ( spawnErr && spawnErr.message ) || spawnErr );
                        if (isStarting || settled) {
                            terminal.warn('[bundle:start] ' + bundle + '@' + self.projectName + ': child process error (' + reason + ')');
                            return;
                        }
                        opt.notStarted.push(bundle + '@' + self.projectName);
                        opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] could not be started: its process could not be spawned (' + reason + '). Check your logs.');
                        settle(1);
                    });

                    var checkCaseCount = 2
                        // The 2 flags we need to free the child.stdout if we do not want the command to wait for a timeout
                        // NB.: you can place flag by using terminal.notice
                        // #B665 — the name is matched literally: `a+b` never matched its own
                        // `mounted !` line, so the start never counted the bundle as mounted and
                        // killed it after its timeout, and a `(` threw.
                        // was: , checkCaseRe = new RegExp('('+bundle + '@' + self.projectName + ' mounted !|Bundle started !)', 'g')
                        , checkCaseRe = new RegExp('('+ escapeRegex(bundle + '@' + self.projectName) + ' mounted !|Bundle started !)', 'g')
                        , url = null
                        , debuggerOn = null
                    ;
                    var port = '', errorFound = false;
                    // #B691 (2026-09-27) — one filter per spawned bundle. The MQ listener keeps no
                    // backlog, so a line the bundle logs while it boots reaches only a `gina tail`
                    // attached before it: the bundle's warn-and-above boot lines go to this client too.
                    var bootLineFilter = bootLines.createBootLineFilter(), bootLinesShown = false;
                    child.stdout.on('data', function(data) {
                        // terminal.log(data);

                        // Startup watchdog only — once the bundle is running, proc.js owns its lifecycle.
                        // Without this guard, every runtime emerg log (written to stdout by the logger's
                        // 'default' container) triggers child.kill('SIGKILL') and silences the error.
                        if (isStarting) return;
                        // #B851 — nor once the attempt has its outcome.
                        if (settled) return;

                        // #B691 — pass the bundle's warn-and-above boot lines on to the client, ahead
                        // of the checks below, so a warning comes before the started or aborted line.
                        // The first one starts a new line: `Trying to start bundle [ … ]` ends without
                        // one. A fault here must never break a start.
                        try {
                            var _bootEntries = bootLineFilter.push(data);
                            if ( _bootEntries.length && !opt.client.destroyed ) {
                                opt.client.write( (bootLinesShown ? '' : '\n') + _bootEntries.join('\n') + '\n' );
                                bootLinesShown = true;
                            }
                        } catch (bootLinesErr) {
                            terminal.debug('[bundle:start] boot lines not passed on: '+ bootLinesErr.message);
                        }

                        // #B851 — the bind failure core/server.js reports (its emerg line) before it
                        // ends the boot: kept to name the outcome.
                        if (!bindFailure) {
                            bindFailure = startStatus.parseBindFailure(data);
                        }

                        // handle errors
                        // #B851 — was: the « has already been started, or port … might be busy »
                        // branch. In text logs it never fired (`EADDRINUSE` and `port` sit on
                        // different lines of the logged error); in JSON logs `port\":` never
                        // matched and the branch wrote an Error object to the client, which threw.
                        // A bundle that already runs is now found before the spawn, and a bind
                        // failure is named from core/server.js's own line.
                        // if ( /EADDRINUSE.*port/i.test(data) && !errorFound ) {
                        //     terminal.log(data);
                        //     // kill the bundle starting process first
                        //     child.kill('SIGKILL');
                        //
                        //     errorFound = true;
                        //     //opt.client.write(data);
                        //     try {
                        //         port = ' #'+ data.match(/port\":\s+\d+/)[0].split(/\:/)[1].trim() +' ';
                        //         opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] has already been started, or port'+ port+'might be busy');
                        //
                        //     } catch(_err) {
                        //         opt.client.write(_err);
                        //     }
                        //
                        //
                        //     ++opt.onlineCount;
                        //     end(opt, cmd, isBulkStart, bundleIndex);
                        //     clearInterval(timerId);
                        //
                        //     return;
                        // }

                        // catch fatal errors to exit
                        if ( /(\[|\[\s+)emerg/.test(data) ) {
                            terminal.log(data);

                            // kill the bundle starting process first
                            child.kill('SIGKILL');

                            // Surface the emerg message so it is visible in docker logs
                            // and CLI output — not just routed to the daemon's MQ logger.
                            var _emergMsg = data.toString().replace(/\x1B\[\d+m/g, '').trim();
                            opt.notStarted.push(bundle + '@' + self.projectName);
                            // #B851 — a bind failure is named for what it is
                            if (bindFailure) {
                                opt.client.write('\n' + startStatus.bindFailureMessage(bundle + '@' + self.projectName, bindFailure, isWin32()));
                            } else {
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] aborted :( \n  ' + _emergMsg);
                            }

                            // #B851 — was: ++opt.onlineCount (an aborted bundle counted as online),
                            // end() with no outcome, then clearInterval (settle() clears it).
                            settle(1);

                            return;
                        }

                        // Expecting 2 flags (checkCaseCount) to free the child stdout !!
                        // terminal.debug('BO case count '+ checkCaseCount);
                        // terminal.log('[debug] ', data);
                        var _matched =  data.match(checkCaseRe);
                        if ( _matched ) {
                            // terminal.warn('case count: '+ checkCaseCount +'\nMatched: '+ _matched.length + '\n'+ checkCaseRe +'\n-> '+ data + '<-\n');
                            checkCaseCount -= _matched.length;
                        }
                        // terminal.debug('EO case count: '+ checkCaseCount + ' -> '+ data);

                        // cache bundle state info given by the server while starting
                        if ( !debuggerOn && new RegExp('Listening on','gmi').test(data)) {
                            debuggerOn = '\n   ' + data.match(new RegExp('Listening on .*','gmi'));
                        }
                        if ( !url && new RegExp('This way please','gmi').test(data)) {
                            url = '\n   ' + data.match(new RegExp('This way please -> .*','gmi'));
                        }



                        if (!opt.client.destroyed && !isStarting && !checkCaseCount) {
                            isStarting = true;
                            clearInterval(timerId);
                            ++opt.onlineCount;

                            if (!debuggerOn) {
                                debuggerOn = ''
                            }

                            // resume logging
                            process.emit('gina#bundle-logging', GINA_MQ_PORT, GINA_HOST_V4, bundle + '@' + self.projectName);
                            terminal.debug('Sent:  gina#bundle-logging');


                            opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] started V(-.o)V'+ url + debuggerOn);


                            // #B851 — was: end(opt, cmd, isBulkStart, bundleIndex);
                            settle(0);
                            return;
                        }

                        return;

                    });

                    //when an exception is thrown, it is sent to the client
                    child.stderr.setEncoding('utf8');
                    var error = null, onException = false;
                    child.stderr.on('data', function(err) {
                        error = err.toString();

                        // #B851 — core/server.js writes its bind failure here too, synchronously
                        // (the stdout emerg line can be lost on a pipe at exit)
                        if (!bindFailure) {
                            bindFailure = startStatus.parseBindFailure(error);
                        }

                        if (/Waiting for the debugger to disconnect: will be reused if not disconected./.test(error) ) { // dual debug --inspect-gina && --inspect
                            onException = true;
                        }

                        // gina framework startup debug traces: pre-formatted with colors, forward raw only
                        if (/\[debug  \]\[gina:/.test(error)) {
                            if (!opt.client.destroyed) {
                                opt.client.write(error);
                            }
                            return;
                        }

                        if (/Debugger listening|Debugger attached|Warning|address already in use/i.test(error)) {

                            if (!opt.client.destroyed) {
                                opt.client.write(error);
                            }

                            if (/address already in use/i.test(error)) {
                                return terminal.warn(error);
                            }

                            if (/listening|attached/i.test(error)) {
                                return terminal.info(error);
                            }

                            return terminal.error(error);
                        }

                        terminal.error(error);
                    });

                    child.on('exit', function(code, signal) {
                        // handles only signals that cannot be cannot be caught or ignored
                        // ref.: `framework/<version>/lib/proc.js`
                        if (onException) { // dual debug --inspect-gina && --inspect
                            // #B851 — was: return end(opt, cmd, isBulkStart, bundleIndex);
                            return settle(0);
                        }
                        // if (/(SIGKILL|SIGSTOP)/i.test(signal)) {
                        // Fixed on 2023-03-23 - Allowing docker to catch exit signal on `SIGABRT`
                        if (/^(SIGKILL|SIGSTOP|SIGABRT)$/i.test(signal)) {
                            if (error) {
                                terminal.error('[' + this.pid + '] `'+ self.name +'@'+ self.projectName +'` : ', error);
                            }
                            terminal.emerg('[' + this.pid + '] `'+ self.name +'@'+ self.projectName +'` exiting with signal: ', signal);
                            cmd.proc.dismiss(this.pid, signal);
                            // #B851 — a signal from outside before readiness (`kill -9`, the OOM
                            // killer) reported nothing: the client waited for the timeout. A kill
                            // this command sent itself has already settled the attempt.
                            if (!isStarting && !settled) {
                                opt.notStarted.push(bundle + '@' + self.projectName);
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] stopped before it was ready (signal ' + signal + '). Check your logs.');
                                settle(startStatus.exitCodeBeforeReady(code, signal));
                            }
                            return;
                        }

                        // Fixed (#B9): child crashed during startup (non-zero exit, no signal)
                        // before stdout emitted the expected readiness flags. Previously this
                        // fell through silently and the setInterval timer ran the full 60-second
                        // wait before reporting "Sorry my friend...". Now we clean up immediately.
                        // #B851 — any exit before readiness ends the attempt with the bundle's own
                        // code (1 when it was 0, 128 + the signal number for a signal): an exit 0
                        // waited for the timeout too. A bind failure is named.
                        // was: if (!isStarting && code !== 0) {
                        // was:     clearInterval(timerId);
                        // was:     opt.notStarted.push(bundle + '@' + self.projectName);
                        // was:     opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] crashed during startup (exit code ' + code + '). Check your logs.');
                        // was:     end(opt, cmd, isBulkStart, bundleIndex);
                        // was: }
                        if (!isStarting && !settled) {
                            opt.notStarted.push(bundle + '@' + self.projectName);
                            if (bindFailure) {
                                opt.client.write('\n' + startStatus.bindFailureMessage(bundle + '@' + self.projectName, bindFailure, isWin32()));
                            } else if (signal) {
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] stopped before it was ready (signal ' + signal + '). Check your logs.');
                            } else if (code !== 0) {
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] crashed during startup (exit code ' + code + '). Check your logs.');
                            } else {
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] exited before it was ready (exit code 0). Check your logs.');
                            }
                            settle(startStatus.exitCodeBeforeReady(code, signal));
                        }

                    });

                } // EO proceedToStart

                checkArchAgainstNodeModules(opt, proceedToStart);

            } // EO Else

        });//EO isRealApp

    } //EO start




    /**
     * #B851 / #B854 — the pid of the bundle when it already runs: its pid file names a running
     * process titled `gina: <bundle>@<project>` (on Bun, one running the bundle's entry; where
     * `ps` cannot tell, a live pid), read with `inc/start-status.js` `findRunningBundle()`.
     * `null` when there is no such file or process. Never throws.
     *
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @param {?string} appPath - The bundle's entry (`index.js`), which Bun's `ps` shows
     * @returns {?number} The running bundle's pid, or `null`
     */
    var findRunning = function(bundle, appPath) {
        var content = null;
        try {
            content = fs.readFileSync(_(GINA_RUNDIR +'/'+ bundle +'@'+ self.projectName +'.pid', true)).toString();
        } catch (pidErr) {
            return null;
        }
        try {
            return startStatus.findRunningBundle(content, bundle +'@'+ self.projectName, appPath || null, {
                parsePid : psTitles.parsePid,
                read     : psTitles.readPidTitle,
                alive    : function(pid) {
                    try {
                        process.kill(pid, 0);
                        return true;
                    } catch (killErr) {
                        return !!(killErr && killErr.code === 'EPERM');
                    }
                }
            });
        } catch (findErr) {
            terminal.debug('[bundle:start] running check skipped: '+ findErr.message);
            return null;
        }
    };

    /**
     * Advances to the next bundle in bulk-start mode, or emits 'end' on the client socket.
     *
     * #B851 — the outcome reaches the CLI: before the connection ends, the exit code is framed
     * to the client (`inc/start-status.js` `writeExit()`, for a client `bin/cmd` marked): the
     * attempt's own code in single mode, 1 when any bundle failed in bulk mode. The CLI
     * exited 0 for every outcome.
     *
     * @inner
     * @private
     * @param {object} opt
     * @param {object} cmd
     * @param {boolean} [isBulkStart]
     * @param {number} [i] - Current bundle index in bulk mode
     * @param {(boolean|number)} [error] - The attempt's exit code; `true` is 1 (a refusal), absent is 0
     */
    var end = function (opt, cmd, isBulkStart, i, error) {
        if ( typeof(opt.msg) != 'undefined' ) {
            opt.client.write('\n\r'+ opt.msg);
            // #B851 — printed once: in bulk mode every later bundle's end() printed it again
            delete opt.msg;
        }

        // #B851 — the attempt's exit code; the first failure's is kept for the command
        var code = ( error === true ) ? 1 : ( ( typeof(error) == 'number' ) ? startStatus.normalizeCode(error) : 0 );
        if ( code !== 0 && !opt.exitCode ) {
            opt.exitCode = code;
        }

        isBulkStart = ( typeof(isBulkStart) == 'undefined' ) ? false : isBulkStart;
        if (isBulkStart) {
            ++i;
            if ( typeof(self.bundles[i]) != 'undefined' ) {
                start(opt, cmd, i)
            } else {
                opt.client.write('\n\r[ Online ] '+ opt.onlineCount +'/'+ self.bundles.length);
                var notStartedMsg = '\nCould not start: \n  - '+ opt.notStarted.join('\n');
                opt.client.write(notStartedMsg);

                // TODO - 2023-01-08 Remove this if not needed
                // if ( typeof(error) != 'undefined' && !new RegExp('gina-v').test(process.title) ) { // will also stop the framework !!!
                //     process.exit(1);
                // }

                // #B851 — bulk: 1 when any bundle failed
                startStatus.writeExit(opt.client, opt.exitCode ? 1 : 0);
                if (!opt.client.destroyed)
                    opt.client.emit('end');
            }
            return;
        }

        // TODO - 2023-01-08 Remove this if not needed
        // if ( typeof(error) != 'undefined' && !new RegExp('gina-v').test(process.title) ) { // will also stop the framework !!!
        //     process.exit(1);
        // }

        // #B851 — the outcome, framed last
        startStatus.writeExit(opt.client, code);
        if (!opt.client.destroyed)
            opt.client.emit('end');
        // Force exit in case process is stuck
        setTimeout(() => {
            if (!opt.client.destroyed) {
                opt.client.emit('exit');
            }
        }, 150);
    }



    /**
     * Resolves the bundle's entry point path based on manifest and env, and verifies it exists.
     * A manifest.json that cannot be read or parsed calls back with « manifest.json cannot be
     * used: <reason> » (#B890: requireJSON() ended the daemon); loadAssets() has read the same
     * file just before, so only a file changed in between reaches that branch.
     * @inner
     * @private
     * @param {string} bundle - Bundle name
     * @param {function} callback - Called with (err, appPath, bundleDir)
     */
    var isRealApp = function(bundle, callback) {
        var p               = null
            , d             = null
            , env           = self.projects[self.projectName]['def_env']
            , isDev         = ( self.projects[self.projectName]['dev_env'] == env ) ? true : false
            , scope         = self.projects[self.projectName]['def_scope']
            , root          = self.projectLocation
            , bundleDir     = null
            , bundlesPath   = null
            , bundleInit    = null
        ;

        // #B890 — read outside the try below: its catch falls back to `bundles/<bundle>`,
        // a path that cannot boot, and requireJSON() ended the daemon before reaching it
        var manifest        = null
            , manifestFile  = _(root+ '/manifest.json', true)
        ;
        try {
            manifest = parseJSONWithComments(fs.readFileSync(manifestFile, 'utf8'), manifestFile);
        } catch (manifestErr) {
            return callback(fileError('manifest.json', manifestErr));
        }

        try {
            //This is mostly for dev.
            // was: var pkg = requireJSON( _(root+ '/manifest.json', true) ).bundles;
            var pkg = manifest.bundles;
            if ( typeof(pkg[bundle].version) == 'undefined' && typeof(pkg[bundle].tag) != 'undefined') {
                pkg[bundle].version = pkg[bundle].tag
            }

            var path = null, version = null;
            if (
                pkg[bundle] != 'undefined' && pkg[bundle]['src'] != 'undefined' && isDev
            ) {
                path = pkg[bundle].src;

                p = _( root +'/'+ path );//path.replace('/' + bundle, '')
                d = _( root +'/'+ path + '/index.js' );

                bundleDir   = path.replace('/' + bundle, '');
                setContext('bundle_dir', bundleDir);
                bundlesPath =  _( root +'/'+ bundleDir );
                bundleInit  = d;

            } else {
                //Others releases.
                path    = 'releases/'+ bundle +'/' + scope +'/' + env +'/'+ pkg[bundle].version;
                version = pkg[bundle].version;
                p = _( root +'/'+ path );//path.replace('/' + bundle, '')
                d = _( root +'/'+ path + '/index.js' );

                bundleDir   = path;
                bundlesPath = _(root + '/'+ bundleDir);
                bundleInit  = d;
            }

        } catch (err) {
            // default bundlesPath.
            // TODO - log warn ?
            terminal.warn(err.stack||err.message);
            bundleDir   = 'bundles';
            bundlesPath = _(root +'/'+ bundleDir);
            p = _(root +'/'+ bundleDir +'/'+ bundle);
            d = _(root + '/'+ bundleDir +'/'+ bundle + '/index.js');
            bundleInit = d;
        }

        //Checking root.
        var dExists = new _(d, true).existsSync();
        terminal.debug('[Checking bundle bootstrap] `'+ d +'`: '+ dExists);
        if ( dExists ) {
            //checking bundle directory.
            fs.stat(p, function(err, stats) {
                if (err) {
                    callback(err)
                } else {

                    if (stats.isDirectory()) {
                        callback(false, d, p)
                    } else {
                        callback(new Error('[ ' + d + ' ] is not a directory'))
                    }
                }
            })
        }
        else {
            callback(new Error('[ ' + d + ' ] does not exists'))
        }
    }


    init(opt, cmd)
}
module.exports = Start;