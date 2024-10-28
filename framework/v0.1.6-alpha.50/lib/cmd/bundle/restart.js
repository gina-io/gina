var fs          = require('fs');
const { runMain } = require('module');
var exec        = require('child_process').exec;

var CmdHelper   = require('./../helper');
var console     = lib.logger;
// var Shell       = lib.Shell;

/**
 * Restart a given bundle or Restart all running bundles at once
 *
 * e.g.
 *  gina bundle:restart <bundle_name> @<project_name>
 *  gina bundle:restart @<project_name>
 *  gina bundle:restart --online
 *
 * */
function Restart(opt, cmd) {

    var self    = {};

    var init = function(opt, cmd) {
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        self.cmdStr = process.argv.splice(0, 2).join(' ');

        self.inheritedArgv = [];
        for (let i = 0, len = process.argv.length; i < len; i++) {
            if ( /^\-\-/.test(process.argv[i]) ) {
                self.inheritedArgv.push(process.argv[i])
            }
        }

        self.inheritedArgv =  self.inheritedArgv.join(' ');

        // start all bundles
        opt.onlineCount = 0;
        opt.notStarted = [];
        if (!self.name) {
            restart(opt, cmd, 0);
        } else {
            restart(opt, cmd);
        }
    }

    var restart = function(opt, cmd, bundleIndex) {

        var isBulkRestart = (typeof(bundleIndex) != 'undefined') ? true : false;
        var bundle = (isBulkRestart) ? self.bundles[bundleIndex] : self.name;

        // console.debug('bundle -> ', bundle);
        var env = ( typeof(self.bundlesByProject[self.projectName][bundle].def_env) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_env : self.defaultEnv;
        var scope = ( typeof(self.bundlesByProject[self.projectName][bundle].def_scope) != 'undefined') ? self.bundlesByProject[self.projectName][bundle].def_scope : self.defaultScope;
        // console.debug('env -> ', env);
        var protocol = self.bundlesByProject[self.projectName][bundle].def_protocol;
        // console.debug('protocol -> ', protocol);
        var scheme = self.bundlesByProject[self.projectName][bundle].def_scheme;
        // console.debug('scheme -> ', scheme);
        var bundlePort = self.portsReverseData[bundle + '@' + self.projectName][env][protocol][scheme];
        // console.debug('port -> ', bundlePort);

        var msg = null;
        if (!isDefined('bundle', bundle)) {

            msg = 'Bundle [ ' + bundle + ' ] is not registered inside `@' + self.projectName + '`';
            console.error(msg);
            opt.client.write(msg);
            end(opt, cmd, isBulkRestart, bundleIndex, true)

        } else {

            isRealApp(bundle, function(err, appPath) {
                if (err) {
                    console.error(err.stack || err.message)
                }


                var error = null;
                //console.debug(' OPTIONS => ', opt.debugPort, opt.debugBrkEnabled);
                //console.info('running: gina bundle:restart '+ bundle + '@' + self.projectName);
                msg = 'Restarting, please wait ...';
                cmd = '$gina bundle:stop ' + bundle + ' @' + self.projectName + ' && $gina bundle:start ' + bundle + ' @' + self.projectName;
                if (self.inheritedArgv != '') {
                    cmd += ' '+ self.inheritedArgv;
                }
                if (opt.debugPort) {
                    cmd += ' --inspect';
                    if (opt.debugBrkEnabled) {
                        cmd += '-brk'
                    }
                    cmd += '='+ opt.debugPort;
                    msg = 'You should now start your debug session on port #'+opt.debugPort;
                }
                cmd = cmd.replace(/\$(gina)/g, self.cmdStr);

                console.debug('Executing: '+cmd);

                opt.client.write('\n\r'+msg +'\n');

                // If it is stuck, the problem is not here ... cmd.start should be a good start
                exec(cmd, function(err, stdout, stderr) {

                    if (err) {
                        error = err.toString();
                        console.error(error);
                        //opt.notStopped.push(bundle + '@' + self.projectName);
                        return setTimeout(() => {
                            end(opt, cmd, isBulkRestart, bundleIndex, true)
                        }, 500);
                    }

                    // retrieve messages from the parent stdout
                    if (stdout) {
                        console.log(stdout.replace(/\n\rTrying to.*/gm, ''));
                    }
                    setTimeout(() => {
                        //opt.client.write('  => bundle [ ' + bundle + '@' + self.projectName + ' ] restarted on port #'+ bundlePort+' :D\n');
                        end(opt, cmd, isBulkRestart, bundleIndex)
                    }, 500);
                })
            })//EO isRealApp
        }
    }

    var end = function (opt, cmd, isBulkRestart, i, error) {
        if (isBulkRestart) {
            ++i;
            if ( typeof(self.bundles[i]) != 'undefined' ) {
                restart(opt, cmd, i)
            } else {

                if ( typeof(error) != 'undefined') {
                    return process.exit(1);
                }
                if (!opt.client.destroyed)
                    opt.client.emit('end');

                process.exit(0);
            }
        } else {
            if ( typeof(error) != 'undefined') {
                return process.exit(1);
            }

            if (!opt.client.destroyed)
                opt.client.emit('end');

            process.exit(0);
        }
    }

    var isRealApp = function(bundle, callback) {

        var p                   = null
            , d                 = null
            , env               = self.projects[self.projectName]['def_env']
            , isDev             = process.env.NODE_ENV_IS_DEV || GINA_ENV_IS_DEV
            , scope             = self.projects[self.projectName]['def_scope']
            , isLocalScope      = process.env.NODE_SCOPE_IS_LOCAL || GINA_SCOPE_IS_LOCAL
            , isProductionScope = process.env.NODE_SCOPE_IS_PRODUCTION || GINA_SCOPE_IS_PRODUCTION
            , root              = self.projects[self.projectName].path
            , bundleDir         = null
            , bundlesPath       = null
            , bundleInit        = null
        ;

        try {
            //This is mostly for dev.
            var pkg = require( _(root + '/manifest.json') ).bundles;

            if ( typeof(pkg[bundle].version) == 'undefined' && typeof(pkg[bundle].tag) != 'undefined') {
                pkg[bundle].version = pkg[bundle].tag
            }
            if (
                pkg[bundle] != 'undefined' && pkg[bundle]['src'] != 'undefined' && isDev
            ) {
                var path = pkg[bundle].src;

                p = _( root +'/'+ path );//path.replace('/' + bundle, '')
                d = _( root +'/'+ path + '/index.js' );

                bundleDir   = path.replace('/' + bundle, '');
                setContext('bundle_dir', bundleDir);
                bundlesPath =  _( root +'/'+ bundleDir );
                bundleInit  = d;

            } else {
                //Others releases.
                var path    = 'releases/'+ bundle +'/' + scope +'/' + env +'/'+ pkg[bundle].version;
                var version = pkg[bundle].version;
                p = _( root +'/'+ path );//path.replace('/' + bundle, '')
                d = _( root +'/'+ path + '/index.js' );

                bundleDir   = path;
                bundlesPath = _(root + '/'+ bundleDir);
                bundleInit  = d;
            }

        } catch (err) {
            // default bundlesPath.
            // TODO - log warn ?
            console.warn(err.stack||err.message);
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
                        callback(false, d)
                    } else {
                        callback(new Error('[ ' + d + ' ] is not a directory'))
                    }
                }
            })
        }
        else {
            console.debug('[ ' + d + ' ] does not exists');
            callback(false)
        }
    }

    init(opt, cmd)
};

module.exports = Restart