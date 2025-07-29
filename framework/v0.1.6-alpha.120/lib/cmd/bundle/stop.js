const { execSync } = require('child_process');
var fs = require('fs');
var exec = require('child_process').exec;

var CmdHelper = require('./../helper');
var console = lib.logger;
/**
 * Stop a given bundle or start all bundles at once
 *
 * e.g.
 *  gina bundle:stop <bundle_name> @<project_name>
 *
 *  // stop all bundles within the project
 *  gina bundle:stop @<project_name>
 *
 * */
function Stop(opt, cmd) {
    var self = {};

    var init = function(opt, cmd) {

        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        if (!isCmdConfigured()) return false;

        // start all bundles
        opt.offlineCount = 0;
        opt.notStopped = [];

        if (!self.name) {
            stop(opt, cmd, 0);
        } else {
            stop(opt, cmd);
        }
    }

    var stop = function(opt, cmd, bundleIndex) {

        var isBulkStop = (typeof(bundleIndex) != 'undefined') ? true : false;
        var bundle = (isBulkStop) ? self.bundles[bundleIndex] : self.name;

        var msg = null;
        if (!isBulkStop && !isDefined('bundle', bundle)) {
            msg = 'Bundle [ ' + bundle + ' ] is not registered inside `@' + self.projectName + '`';
            console.error(msg);
            opt.msg = msg;
            return end(opt, cmd, isBulkStop, bundleIndex, true)
        }

        isRealApp(bundle, function(err, appPath) {

            if (err) {
                console.error(err.stack || err.message)
            }

            var error = null;
            var proc = null;
            var isSpecialCase = false;
            var pidPath = _(GINA_RUNDIR +'/'+ bundle +'@'+ self.projectName +'.pid', true);
            try {
                proc = fs.readFileSync(_(GINA_RUNDIR+'/'+bundle + '@' + self.projectName +'.pid')).toString().replace(/\n/g, '');
                proc = parseInt(proc);

            } catch(err) {
                isSpecialCase = true;
                // Some how pid file could have been deleted leaving a zombie process running
                var list = execSync("ps -ef | grep -v grep | grep 'gina: "+ bundle + '@' + self.projectName +"' | awk '{print $2\" \"$8$9}'").toString().replace(/\n$/, '').split(/\n/g);
                if (list.length && list[0] != '') {
                    proc = ~~list[0].split(/\s+/)[0];
                } else {
                    error = err.toString();
                    console.debug(error);
                }
            }

            msg = 'Trying to stop bundle [ ' + bundle + '@' + self.projectName + ' ]\n\r';
            opt.client.write('\n\r'+msg);

            // if ( !re.test(row[0]) ) {
            if (proc) {
                //console.debug('\n'+ row.join('\n'));
                //console.debug('kill -TERM ', proc, arr);

                exec('kill -9 ' + proc, function(err, data) {
                    // just in case
                    if ( new _(pidPath).existsSync() ) {
                        isSpecialCase = true;
                        fs.unlinkSync( pidPath );
                    }
                    if (!err) {
                        ++opt.offlineCount;

                        // resume logging
                        process.emit('gina#bundle-logging', GINA_MQ_PORT, GINA_HOST_V4, bundle + '@' + self.projectName);

                        //console.info('Bundle [ ' + bundle + '@' + self.projectName + ' ] with PID [ ' + proc + ' ] stopped !');
                        opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] with PID [ ' + proc + ' ] stopped !\n');

                        end(opt, cmd, isBulkStop, bundleIndex)
                    } else {
                        if (!isSpecialCase) {
                            console.error( err.toString())
                        } else {
                            end(opt, cmd, isBulkStop, bundleIndex)
                        }
                    }
                })
            } else { // not running
                //console.info('Bundle `' + bundle + '@' + self.projectName + '` is not running');
                opt.client.write('  [ ' + bundle + '@' + self.projectName + ' ] is not running\n');

                ++opt.offlineCount;
                opt.notStopped.push(bundle + '@' + self.projectName);
                end(opt, cmd, isBulkStop, bundleIndex)
            }
        })//EO isRealApp

    }

    var end = function (opt, cmd, isBulkStop, i, error) {
        if ( typeof(opt.msg) != 'undefined' ) {
            opt.client.write('\n\r'+ opt.msg);
        }
        if (isBulkStop) {
            ++i;
            if ( typeof(self.bundles[i]) != 'undefined' ) {
                stop(opt, cmd, i)
            } else {
                opt.client.write('\n\r[ Offline ] '+ opt.offlineCount +'/'+ self.bundles.length +'\r');
                var notStoppedMsg = '';
                if (opt.notStopped.length > 1) {
                    notStoppedMsg = '\nThe following bundles could not be stopped or were not running: \n - '+ opt.notStopped.join('\n - ') + '\n\r';
                    opt.client.write(notStoppedMsg);
                }


                if ( typeof(error) != 'undefined') {
                    process.exit(1);
                }
                if (!opt.client.destroyed)
                    opt.client.emit('end');

                process.exit(0);
            }
        } else {
            if ( typeof(error) != 'undefined') {
                process.exit(1);
            }

            if (!opt.client.destroyed)
                opt.client.emit('end');

            process.exit(0);
        }
    }



    var isRealApp = function(bundle, callback) {

        var p               = null
            , d             = null
            , env           = self.projects[self.projectName]['def_env']
            , isDev         = GINA_ENV_IS_DEV
            , scope         = self.projects[self.projectName]['def_scope']
            , root          = self.projects[self.projectName].path
            , bundleDir     = null
            , bundlesPath   = null
            , bundleInit    = null
            , pkg           = null
            , path          = null
        ;

        try {
            //This is mostly for dev.
            pkg = requireJSON(_(root + '/manifest.json')).bundles;

            if ( typeof(pkg[bundle].version) == 'undefined' && typeof (pkg[bundle].tag) != 'undefined' ) {
                pkg[bundle].version = pkg[bundle].tag
            }
            if (
                pkg[bundle] != 'undefined' && pkg[bundle]['src'] != 'undefined' && isDev
            ) {
                path = pkg[bundle].src;

                p = _(root + '/' + path);//path.replace('/' + bundle, '')
                d = _(root + '/' + path + '/index.js');

                bundleDir = path.replace('/' + bundle, '');
                setContext('bundle_dir', bundleDir);
                bundlesPath = _(root + '/' + bundleDir);
                bundleInit = d;

            } else {
                //Others releases.
                path = 'releases/' + bundle + '/' + scope +'/' + env + '/' + pkg[bundle].version;
                var version = pkg[bundle].version;
                p = _(root + '/' + path);
                d = _(root + '/' + path + '/index.js');

                bundleDir = path;
                bundlesPath = _(root + '/' + bundleDir);
                bundleInit = d;
            }

        } catch (err) {
            // default bundlesPath.
            // TODO - log warn ?
            console.warn(err.stack || err.message);
            bundleDir = 'bundles';
            bundlesPath = _(root + '/' + bundleDir);
            p = _(root + '/' + bundleDir + '/' + bundle);
            d = _(root + '/' + bundleDir + '/' + bundle + '/index.js');
            bundleInit = d;
        }

        // removing mounting point
        var coreEnv = getCoreEnv(bundle);
        new _(coreEnv.mountPath +'/'+ bundle, true).rmSync();


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
        } else {
            //callback(new Error('[ ' + d + ' ] does not exists'))
            console.debug('[ ' + d + ' ] does not exists');
            callback(false)
        }
    }



    init(opt, cmd)
};

module.exports = Stop