'use strict';
// Imports
const fs                  = require('fs');
const util                = require('util');
//const {EventEmitter}             = require('events');
const net                 = require('net');
// var promisify           = util.promisify;
// const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// const { execSync }      = require('child_process');

var helpers = null;

// #M22 — merge-eval fallback removed (sister fix to lib/merge/src/main.js direct json_clone require)
var merge     = require(__dirname + '/../../../../merge');
// #B160 — control-plane dial-host resolution (pure, no framework globals)
var netLocality = require(__dirname + '/../../../../net-locality');

function FileContainer(opt, loggers) {
    var self = {
        // flow or container name/id
        name: 'file'
    };

    var mqId = 'MQ'+ self.name.substring(0,1).toLocaleUpperCase() + self.name.substring(1);

    helpers         = require(__dirname +'/../../../../../helpers');


    var loggerHelper    = require(__dirname +'/../../helper.js')(opt, loggers);
    var format          = loggerHelper.format;
    var processProperties = null;
    var filenames   = {};

    /**
     * Resolves the framework's connection settings for the file container.
     *
     * Runs before the framework globals are guaranteed to exist (see the
     * "hack for early calls" block below), so every global read is guarded.
     *
     * @inner
     * @param {object} opt - Logger options; mqPort/hostV4/bindHost are filled in here.
     * @returns {void}
     *
     * @example
     * init({ });
     */
    function init(opt) {

        // ---------- BO - hack for early calls
        var isWin32         = (process.platform === 'win32') ? true : false;
        var binPath         = __dirname +'/../../../../../../../';
        var ginaPath        = (binPath.replace(/\\/g, '/')).replace('/bin', '');
        ginaPath = (isWin32) ? ginaPath.replace(/\//g, '\\') : ginaPath;
        // loading pack
        var pack            = ginaPath + '/package.json';
        pack = (isWin32) ? pack.replace(/\//g, '\\') : pack;
        var packObj         = require(pack);
        var version         = packObj.version;// jshint ignore:line
        // var frameworkPath   = ginaPath + '/framework/v' + version;


        var shortVersion = version.split('.');
        shortVersion.splice(2);
        shortVersion = shortVersion.join('.');

        var settings = { mq_port: 8125, host_v4: '127.0.0.1' };
        try {
            // #B160-sibling (3) — honour GINA_HOMEDIR so an isolated home resolves
            // its OWN settings instead of the invoking user's. The variable already
            // carries the `/.gina` segment (bin/cli, bin/gina-init both compose it
            // as `home + '/.gina'`), so it replaces that whole prefix, not just the
            // home.
            // Three tiers, and process.env is load-bearing rather than defensive:
            // this container is constructed BEFORE bin/cli imports the OS env into
            // process.gina (measured: process.gina is empty here, while
            // process.env.GINA_HOMEDIR still holds the value), so the framework-env
            // tier alone would never fire on the CLI path. Framework env still wins
            // where it is populated (bundle processes, gina-container), matching the
            // two-tier read used by the secrets backend and resolveHttpHost.
            var _ginaHome = (typeof getEnvVar === 'function' && getEnvVar('GINA_HOMEDIR'))
                || process.env.GINA_HOMEDIR
                || (getUserHome() + '/.gina');
            settings = require( _ginaHome + '/' + shortVersion + '/settings.json');
        } catch (err) {}

        opt.mqPort = settings.mq_port;
        opt.hostV4 = settings.host_v4;
        // #B160 — carry the daemon's bind address for the dial-host
        // resolution in onPayload().
        opt.bindHost = settings.bind_host;
        // ---------- EO - hack for early calls

        // handle server not started yet or server exited
        // process.on('gina#mqlistener-started', function onGinaStarted(mqPort, hostV4, group) {
        //     if (group) {
        //         console.info('[MQFile] Group `'+group+'` connected `'+ hostV4 +'` on port `'+ mqPort +'` :)');
        //     }
        //     clearInterval(nIntervId);
        //     nIntervId = null;
        //     onPayload({mqPort: mqPort, hostV4: hostV4});
        // });

        process.on('gina#bundle-logging', function onBundleStarted(mqPort, hostV4, group) {
            console.debug('[MQFile] resuming ...')
            if (group) {
                console.info('[MQFile] Group `'+group+'` connected `'+ hostV4 +'` on port `'+ mqPort +'` :)');
            }
            // only if tail not already running !! Or you will get duplicate logs
            onPayload({mqPort: mqPort, hostV4: hostV4}, true);
        });

        onPayload(opt);

        // ----------------------------Debug---------------------------------------
        var level = 'debug';
        // Init debugging - Logs not in hierarchy will just be ignored
        if (opt.hierarchies[opt.hierarchy].indexOf( opt.levels[level].code) > -1) {
            process.emit('logger#'+self.name, JSON.stringify({
                group       : opt.name,
                level       : level,
                // Raw content !
                content     : '`'+ self.name +'` logger container loaded !'
            }));
        }
        // ------------------------------------------------------------------------
    }

    function setup(group, filenames, props) {
        //var group = process.title; // gina, frontend@myproject ...
        console.log('['+ mqId +'] setting up '+ group);

        // we only want the bundle's logs
        if (
            !/\@/.test(group)
            // ||
            // props.bundles
            // && props.bundles.length == 0
            // ||
            // props.bundles
            // && props.bundles.indexOf(group) < 0
        ) {
            return
        }

        if ( !filenames[group] ) {
            filenames[group] = {}
        }
        process.stdout.write( format(opt.name, 'info', '['+ mqId +'] setting up '+ group +'\nFilenames: '+ JSON.stringify(filenames, null, 2)) );
        /// aready defiened
        if ( filenames[group].filename) {
            return
        }

        // retriving hostname
        var bfnArr = group.split(/\@/);
        var bundleName = bfnArr[0];
        var projectName = bfnArr[1];
        var homeDir = getUserHome() || process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];// jshint ignore:line
        homeDir += '/.gina';
        var project = requireJSON(_(homeDir +'/projects.json', true))[projectName];// jshint ignore:line
        var projectPath = project.path;
        // console.debug('logger::file write env: ', bundleName, process.env.NODE_ENV, getEnvVar('GINA_ENV'), JSON.stringify(process.gina, null, 2) );// jshint ignore:line

        var env         = process.env.NODE_ENV || getEnvVar('GINA_ENV');// jshint ignore:line
        var scope       = process.env.NODE_SCOPE || getEnvVar('GINA_SCOPE');// jshint ignore:line
        var Config      = require(getEnvVar('GINA_CORE') + '/config');
        var conf = new Config({
            env: env,
            scope: scope,
            projectName: projectName,
            executionPath: projectPath,
            startingApp: bundleName,
            ginaPath: getEnvVar('GINA_CORE')
        }, true).getInstance(bundleName);

        var envObj      = conf.envConf[bundleName][env];// jshint ignore:line
        var webroot     = ( !/\s+|\//.test(envObj.server && envObj.server.webroot) ) ? envObj.server.webroot +'.' : '';
        var hostname    = envObj.host;
        var logDir      = getLogDir() || getEnvVar('GINA_LOGDIR');// jshint ignore:line

        filenames[group].filename = _(logDir +'/'+ webroot + hostname +'.log', true);// jshint ignore:line
        console.debug('Log group `'+ group +'` filename set to: ' + filenames[group].filename);
        process.stdout.write( format(opt.name, 'info', 'Log group `'+ group +'` filename set to: ' + filenames[group].filename) );
    }

    function onPayload(opt, isResuming) {
        // console.debug('mqFile options: ', JSON.stringify(opt, null, 2));
        var port = opt.mqPort || getEnvVar('GINA_MQ_PORT') || 8125;// jshint ignore:line
        // #B320 — like the MQ speaker, this container's listener is co-located
        // by construction, so `host_v4` (advertisement state — foreign on a
        // shared or stale `~/.gina`, incl. the value the `gina#bundle-logging`
        // event carries) is not an input of the dial. Dial what the local
        // daemon binds; env first, matching the bind side's own precedence
        // (init.js #B161) and covering the early-call construction window.
        var host = netLocality.resolveLocalDialHost(
            ((typeof getEnvVar === 'function' && getEnvVar('GINA_BIND_HOST')) || process.env.GINA_BIND_HOST || null)
            || opt.bindHost
        );// jshint ignore:line
        var clientOptions = {
            host    : host,
            port    : port,
            request : 'writeToFile'
        }
        // var loggerOptions   = console.getOptions();
        // var loggers         = console.getLoggers();
        // var loggerHelper    = LoggerHelper(loggerOptions, loggers);
        // var format          = loggerHelper.format;




        var delayedMessages = [];
        var resume = function(payload) {
            // process.stdout.write('['+ mqId +'] Resuming with group: '+ payload.group);
            var i = 0;
            while (i < delayedMessages.length) {
                let pl = delayedMessages[i];
                // debug only
                // process.stdout.write('['+ mqId +']'+ format(pl.group, pl.level, pl.content) );

                write(pl.group, format(pl.group, pl.level, pl.content) );
                i++;
            }
            delayedMessages = []
        }




        var client = net.createConnection(clientOptions, () => {
            // 'connect' listener.
            console.info('['+ mqId +'] connected to server :) on host: '+ host + ' & port: '+ port, process.argv);
            processProperties = loggerHelper.getProcessProperties();
            console.info('['+ mqId +'] process properties ', processProperties);

            process.emit('gina#container-writting', host, port);

            // send request
            client.write( JSON.stringify(clientOptions) +'\r\n');

        });


        client.on('error', (data) => {
            var err = data.toString();
            process.stdout.write( format(opt.name, 'warn', '['+ mqId +'] ' + err) );

            // allowing the framework to quit properly
            if ( /write EPIPE|read ECONNRESET|connect ECONNREFUSED/i.test(err) ) {
                process.exit(0)
            }

            // var mqPort = null;
            // nIntervId = setInterval(() => {
            //     try {
            //         mqPort = ~~(fs.readFileSync(mqPortFile).toString());
            //         if (mqPort) {
            //             process.emit('gina#mqlistener-started', mqPort, host);
            //         }
            //     } catch (fileErr) {}
            // }, 100);
        });

        var payloads = null, i = null;
        client.on('data', (data) => {

            //console.log('['+ mqId +']  (data): ' + data.toString());
            payloads = data.toString();

            // from speakers
            if ( /^(\{\"|\[\{\")/.test(payloads) ) {
                payloads = payloads.split(/\r\n/g);
                i = -1;
                while(i < payloads.length) {
                    i++;
                    let payload = payloads[i];
                    if (
                        /^\{/.test(payload) && /\}$/.test(payload)
                        || /^\[\{/.test(payload) && /\}\]$/.test(payload)
                    ) {
                        let pl = null;
                        try {
                            pl = JSON.parse(payload);
                        } catch(plErr) {
                            process.stdout.write( '['+ mqId +'] (exception) '+ payload +'\n' );
                            continue;
                        }


                        if (!pl.content) {
                            // only for debug
                            // process.stdout.write( '['+ mqId +'] (undefined content) '+ JSON.stringify(pl, null) +'\n' );

                            // updating logger context since it can run on different processes
                            if ( pl.sessionId && !clientOptions.sessionId ) {
                                clientOptions.sessionId = pl.sessionId;
                                // setting up file descriptor if not existing

                                //setup(pl.group, processProperties);
                                for ( let b = 0, bLen = processProperties.bundles.length; b < bLen; b++) {
                                    let realGroup = processProperties.bundles[b];
                                    setup(realGroup, filenames, processProperties);
                                }

                                // acknowledging
                                client.write( JSON.stringify(clientOptions) +'\r\n');
                            }

                            if (pl.loggers) {
                                loggers = merge(loggers, pl.loggers);
                                if (delayedMessages.length > 0 /**&& /\@/.test(pl.group)*/ ) {
                                    resume(pl)
                                }
                            }
                            continue;
                        }

                        // resuming logging from another process
                        // we do not want to print twice in this case since another logger server is already running
                        if (isResuming) {
                            return
                        }

                        // only for debug
                        // process.stdout.write(  '['+ mqId +'] '+ pl.content +'\n' );

                        try {
                            if (!filenames[pl.group].filename ) {
                                return;
                            }
                            write(pl.group, format(pl.group, pl.level, pl.content) );

                        } catch (writeErr) {
                            // means that the related MQSpeaker is not connected yet
                            // this can happen during `bundle:start` configuration
                            // we'll then delay the output until MQSpeaker is ready
                            delayedMessages.push(pl);
                        }

                    }
                }
            }

        });
        client.on('end', () => {
            console.log('['+ mqId +'] disconnected from server');
        });
        // setInterval(() => {}, 1 << 30);
    }

    function write(group, content) {

        if ( !/\@/.test(group) || !filenames[group] ) {
            process.stdout.write( '['+ mqId +']['+ group +'] '+ content );
            return;
        }

        if ( !filenames[group].filename ) {
            //throw new Error('['+ mqId +'] No filename found!');
            process.emit('logger#'+self.name, JSON.stringify({
                group       : group,
                level       : 'error',
                // Raw content !
                content     : new Error('['+ mqId +'] No filename found!')
            }));
            return;
        }
        var data = new Uint8Array(Buffer.from(content));
        fs.writeFile(filenames[group].filename, data,
            {
                encoding: "utf8",
                // https://nodejs.org/api/fs.html#file-system-flags
                flag: "a"
            },
            (err) => {
                if (err) {
                    process.stdout.write( format(opt.name, 'err', '['+ mqId +'] ' + err) );
                    return;
                }
        });
    }



    init(opt);
}
module.exports = FileContainer;