const fs            = require('fs');
const { EventEmitter }  = require('events');
const { spawn }     = require('child_process');
const { execSync }  = require('child_process');
const util = require('util');
const promisify = require('util').promisify;

var CmdHelper   = require('./../helper');
// `lib` is previously defiened as this file is required by anoth
// For user output
var terminal    = lib.logger;
// For logs/tail output thru the parent
var console     = null;

/**
 * Start a given bundle or start all bundles at once
 *
 *
 * e.g.
 *  gina bundle:start <bundle_name> @<project_name>
 *
 * // start all bundles within the project
 *  gina bundle:start @<project_name>
 * or
 *  gina bundle:start @<project_name> --max-old-space-size=4096 --inspect=5858
 *
 *
 * If you want to inspect/debug here, you first need to restart gina with `--inspect-gina`
 *   gina start --inspect-gina
 * then
 *   gina bundle:start <bundle_name> @<project_name> --max-old-space-size=4096 --inspect=5858
 *
 * */
function Start(opt, cmd) {
    var self    = {};
    // terminal.register(console, opt.client.write);


    var init = function(opt, cmd) {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;


        // start all bundles
        opt.onlineCount = 0;
        opt.notStarted = [];

        if (!self.name) {
            return start(opt, cmd, 0);
        }

        start(opt, cmd);
    }

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
        var nodeModulesContentArr = ( nodeModulesPathObj.existsSync() ) ? fs.readdirSync(nodeModulesPathObj.toString()) : [];
        var newNodeModulesContentArr = [], n = 0;
        for (let f in nodeModulesContentArr) {
            if (/^\./.test(nodeModulesContentArr[f]) ) {
               continue
            }
            newNodeModulesContentArr[n] = nodeModulesContentArr[f];
        }
        nodeModulesContentArr = newNodeModulesContentArr.slice();
        newNodeModulesContentArr = null;

        var pack = requireJSON(packagePath);

        if (
            !projectArchFileObj.existsSync()
            ||
            !projectPlatformFileObj.existsSync()
            ||
            projectArchFileObj.existsSync() && fs.readFileSync(projectArchFile).toString() != currentArch
            ||
            projectPlatformFileObj.existsSync() && fs.readFileSync(projectPlatformFile).toString() != currentPlatform
            ||
            !nodeModulesPathObj.existsSync()
            ||
            nodeModulesPathObj.existsSync()
            && !nodeModulesContentArr.length
            ||
            nodeModulesPathObj.existsSync()
            && nodeModulesContentArr.length == 1
            && nodeModulesContentArr[0] == 'gina'
            && typeof(pack.dependencies) != 'object'
            && pack.dependencies.count() > 0
        ) {
            isNodeModulesReinstallNeeded = true;
        }

        opt.client.write('\nArch: '+ currentArch);
        // opt.client.write('\nprojectArchFile: '+ projectArchFile);
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
            var npmCmd = ( isWin32() ) ? 'npm.cmd install' : 'npm install';
            process.chdir( _(projectObj.path, true) );

            opt.client.write('\nRe-installing node_modules to match arch & platform');
            opt.client.write('\nrunning: `'+ npmCmd +'` from '+ process.cwd() );
            opt.client.write('\nrunning using TMPDIR: '+  _(getTmpDir(), true) );
            var oldConfigGlobal = process.env.npm_config_global;
            process.env.npm_config_global = false;
            var result = null; resultError = false;
            try {
                result = execSync(npmCmd).toString();
                var ginaBin = execSync('which gina').toString().trim();
                execSync(ginaBin +' framework:link @'+ self.projectName);
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
                }, 1000);

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
        var env = ( typeof(self.bundlesByProject[self.projectName][bundle].def_env) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_env : self.defaultEnv;
        var scope = ( typeof(self.bundlesByProject[self.projectName][bundle].def_scope) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_scpoe : self.defaultScope;
        // terminal.debug('env -> ', env);
        var protocol = self.bundlesByProject[self.projectName][bundle].def_protocol;
        // terminal.debug('protocol -> ', protocol);
        var scheme = self.bundlesByProject[self.projectName][bundle].def_scheme;
        // terminal.debug('scheme -> ', scheme);
        var bundlePort = self.portsReverseData[bundle + '@' + self.projectName][env][protocol][scheme];
        // terminal.debug('port -> ', bundlePort);

        var msg = null;
        if ( !isBulkStart && !isDefined('bundle', bundle) ) {
            msg = 'Bundle [ '+ bundle +' ] is not registered inside `@'+ self.projectName +'`';
            terminal.error(msg);
            // opt.client.write(msg);
            // // CMD exit
            // opt.client.emit('end');

            opt.msg = msg;
            return end(opt, cmd, isBulkStart, bundleIndex, true)
        }

        var isStarting  = false
            , params    = null
            , index     = null
            , i         = null
            , len       = null
        ;

        isRealApp(bundle, function(err, appPath, bundleDir){

            if (err) {
                terminal.error(err.stack||err.message)
            } else {
                if (isStarting)
                    return;


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

                    params = [
                        // node arguments will be passed by gina
                        appPath,
                        JSON.stringify(getContext()), //Passing context to child.
                        self.projectName, // project name
                        bundle// bundle name
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
                            if (!opt.client.destroyed) {
                                opt.client.emit('exit');
                                opt.client.emit('end');
                            }


                            //end(opt, cmd, isBulkStart, bundleIndex);
                        }
                    }, maxTimeout);

                    var checkCaseCount = 2
                        // The 2 flags we need to free the child.stdout if we do not want the command to wait for a timeout
                        // NB.: you can place flag by using terminal.notice
                        , checkCaseRe = new RegExp('('+bundle + '@' + self.projectName + ' mounted !|Bundle started !)', 'g')
                        , url = null
                        , debuggerOn = null
                    ;
                    var port = '', errorFound = false;
                    child.stdout.on('data', function(data) {
                        // terminal.log(data);

                        // handle errors
                        if ( /EADDRINUSE.*port/i.test(data) && !errorFound ) {
                            terminal.log(data);
                            // kill the bundle starting process first
                            child.kill('SIGKILL');

                            errorFound = true;
                            //opt.client.write(data);
                            try {
                                port = ' #'+ data.match(/port\":\s+\d+/)[0].split(/\:/)[1].trim() +' ';
                                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] has already been started, or port'+ port+'might be busy');

                            } catch(_err) {
                                opt.client.write(_err);
                            }


                            ++opt.onlineCount;
                            end(opt, cmd, isBulkStart, bundleIndex);
                            clearInterval(timerId);

                            return;
                        }

                        // catch fatal errors to exit
                        if ( /(\[|\[\s+)emerg/.test(data) ) {
                            terminal.log(data);

                            // kill the bundle starting process first
                            child.kill('SIGKILL');

                            opt.notStarted.push(bundle + '@' + self.projectName);
                            opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] aborted :( \n  => Check your logs to see why.');

                            ++opt.onlineCount;
                            end(opt, cmd, isBulkStart, bundleIndex);
                            clearInterval(timerId);

                            return;
                        }

                        // Expecting 2 flags (checkCaseCount) to free the child stdout !!
                        // terminal.debug('BO case count '+ checkCaseCount);
                        var _matched =  data.match(checkCaseRe);
                        if ( _matched ) {
                            // terminal.warn('case count: '+ checkCaseCount +'\nMatched: '+ _matched.length + '\n'+ checkCaseRe +'\n-> '+ data + '<-\n');
                            checkCaseCount -= _matched.length;
                        }
                        // terminal.debug('EO case count: '+ checkCaseCount + ' -> '+ data);

                        // cache bundle state info given by the server while starting
                        if ( !debuggerOn && new RegExp('Debugger listening on','gmi').test(data)) {
                            debuggerOn = '\n   ' + data.match(new RegExp('Debugger listening on .*','gmi'));
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


                            end(opt, cmd, isBulkStart, bundleIndex);
                            return;
                        }

                        return;

                    });

                    //when an exception is thrown, it is sent to the client
                    child.stderr.setEncoding('utf8');
                    var error = null, onException = false;
                    child.stderr.on('data', function(err) {
                        error = err.toString();

                        if (/Waiting for the debugger to disconnect.../.test(error) ) { // dual debug --inspect-gina && --inspect
                            onException = true;
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
                            return end(opt, cmd, isBulkStart, bundleIndex);
                        }
                        // if (/(SIGKILL|SIGSTOP)/i.test(signal)) {
                        // Fixed on 2023-03-23 - Allowing docker to catch exit signal on `SIGABRT`
                        if (/^(SIGKILL|SIGSTOP|SIGABRT)$/i.test(signal)) {
                            if (error) {
                                terminal.error('[' + this.pid + '] `'+ self.name +'@'+ self.projectName +'` : ', error);
                            }
                            terminal.emerg('[' + this.pid + '] `'+ self.name +'@'+ self.projectName +'` exiting with signal: ', signal);
                            cmd.proc.dismiss(this.pid, signal);
                            return;
                        }

                    });

                } // EO proceedToStart

                checkArchAgainstNodeModules(opt, proceedToStart);

            } // EO Else

        });//EO isRealApp

    } //EO start




    var end = function (opt, cmd, isBulkStart, i, error) {
        if ( typeof(opt.msg) != 'undefined' ) {
            opt.client.write('\n\r'+ opt.msg);
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

                if (!opt.client.destroyed)
                    opt.client.emit('end');
            }
            return;
        }

        // TODO - 2023-01-08 Remove this if not needed
        // if ( typeof(error) != 'undefined' && !new RegExp('gina-v').test(process.title) ) { // will also stop the framework !!!
        //     process.exit(1);
        // }

        if (!opt.client.destroyed)
            opt.client.emit('end');
        // Force exit in case process is stuck
        setTimeout(() => {
            if (!opt.client.destroyed) {
                opt.client.emit('exit');
            }
        }, 150);
    }



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

        try {
            //This is mostly for dev.
            var pkg = requireJSON( _(root+ '/manifest.json', true) ).bundles;
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
        if ( new _(d, true).existsSync() ) {
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