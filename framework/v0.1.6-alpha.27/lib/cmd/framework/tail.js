var fs          = require('fs');
var os          = require("os");
var util        = require('util');
var net         = require('net');

var EventEmitter    = require('events').EventEmitter;
var e               = new EventEmitter();

var CmdHelper       = require('./../helper');
var console         = lib.logger;
var LoggerHelper    = require( _(GINA_FRAMEWORK_DIR + '/lib/logger/src/helper.js', true) );

/**
 * Framework tail
 * By default, tail will exit when a bundle is exiting. If you want to prevent
 * tail from exiting, you should use `--keep-alive`
 * This will also will restart bundle in case of crach
 *
 * e.g.
 *  gina framework:tail
 *  or
 *  gina tail
 *  or
 *  gina tail --keep-alive
 *
 * */
function Tail(opt, cmd) {

    process.title = 'gina-tail';
    var self        = {};
    var nIntervId   = null;
    var mqPortFile  = _(getTmpDir() +'/mq-listener-v'+ GINA_VERSION +'.port', true);


    var init = function(opt, cmd) {

        console.debug('Getting framework logs');
        // import CMD helpers
        new CmdHelper(self, opt.client, { port: opt.debugPort, brkEnabled: opt.debugBrkEnabled });

        // check CMD configuration
        //if (!isCmdConfigured()) return false;

        // handle server not started yet or server exited
        process.on('gina#mqlistener-started', function onGinaStarted(mqPort) {
            clearInterval(nIntervId);
            nIntervId = null;
            opt.mqPort = mqPort;

            tail(opt, cmd);
        });

        // process.on('gina#container-writting', function onGinaStarted(hostV4, mqPort, type) {
        //     console.info('[MQTail] Container resumed writting on  `'+ hostV4 +'` on port `'+ mqPort +'` :)');
        //     opt.mqPort = mqPort;
        //     console.resumeReporting()
        //     tail(opt, cmd);
        // });




        // if (!self.name) {
        //     status(opt, cmd, 0);
        // } else {
            tail(opt, cmd);
        // }
    }


    var tail = function(opt, cmd, isResuming) {

        var port = opt.mqPort || GINA_MQ_PORT || 8125;
        var host = opt.hostV4 || GINA_HOST_V4 || '127.0.0.1';
        var clientOptions = {
            host    : host,
            port    : port,
            request : 'tail'
        }
        var loggerOptions   = console.getOptions();
        var loggers         = console.getLoggers();
        var loggerHelper    = LoggerHelper(loggerOptions, loggers);
        var format          = loggerHelper.format;

        var delayedMessages = [];

        var resumeTail = function() {

            var i = 0;
            while (i < delayedMessages.length) {
                let pl = delayedMessages[i];
                process.stdout.write( format(pl.group, pl.level, pl.content) );
                i++;
            }
            delayedMessages = []
        }





        var client = net.createConnection(clientOptions, () => {

            e.emit('gina#mqtail-started', true);

            // 'connect' listener.
            console.resumeReporting();
            // console.debug('[MQTail] connected with opt `'+ JSON.stringify(opt, null, 2) +'` :)');
            console.info('[MQTail] Connected to server `'+ host +'` on port `'+ port +'` :)');

            // send request
            client.write( JSON.stringify(clientOptions) +'\r\n');

        });



        client.on('error', (data) => {
            var err = data.toString();
            console.error('[MQTail] ' + err + ' - Gina might not be running');
            console.info('[MQTail] Waitting for `MQListener` to be started ...');

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

            // console.log('[MQTail]  (data): ' + data.toString());
            payloads = data.toString();

            // from speakers & tail
            if ( /^(\{\"|\[\{\")/.test(payloads) ) {
                payloads = payloads.split(/\r\n/g);
                //console.log(payloads);
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
                            process.stdout.write( '[MQTail] (Exception) '+ payload +'\n' );
                            continue;
                        }



                        if (!pl.content) {
                            // only for debug
                            // process.stdout.write( '[MQTail] (undefined content) '+ JSON.stringify(pl, null) +'\n' );

                            // updating logger context since it can run on different processes
                            if ( pl.sessionId && !clientOptions.sessionId ) {
                                clientOptions.sessionId = pl.sessionId;
                                // acknowledging
                                client.write( JSON.stringify(clientOptions) +'\r\n');
                            }

                            if (pl.loggers) {
                                loggers = merge(loggers, pl.loggers);
                                if (delayedMessages.length > 0) {
                                    resumeTail()
                                }
                            }
                            continue;
                        }

                        //  [ duplicate output fix ]
                        // if (loggers[pl.group] && loggers[pl.group]._options.isFlushing) {
                        //     process.stdout.write(  '[MQTail] '+ pl.group +' => '+ loggers[pl.group]._options.isFlushing +'\n' );
                        //     break;
                        // }


                        // resuming logging from another process
                        // we do not want to print twice in this case since another logger server is already running
                        // if (isResuming) {
                        //     return
                        // }

                        // only for debug
                        // process.stdout.write(  '[MQTail] '+ pl.content +'\n' );



                        try {
                            process.stdout.write( format(pl.group, pl.level, pl.content) );
                            if (
                                /(exiting|Got exit code)(.*)(SIGKILL|SIGTERM|SIGINT|SIGABRT)/.test(pl.content)
                                ||
                                // killed by terminal signal or activity monitor
                                // Received SIGTERM or Received SIGINT)
                                /(SIGTERM|SIGINT)/.test(pl.content)
                                ||
                                /JavaScript heap out of memory/.test(pl.content)
                            ) {

                                let bundleDesc = pl.content.match(/\`(.*)\@(.*\`)/);
                                let bundle = null;
                                let project = null;
                                if ( Array.isArray(bundleDesc) && bundleDesc.length > 0) {
                                    bundle = bundleDesc[1];
                                    project= bundleDesc[2];
                                } // else, must be `gina` (the framework)

                                if (opt.argv.indexOf('--keep-alive') < 0) {
                                    // TODO - exits only if no other bundle is runing in the project
                                    // let projectStatus = execSync("gina project:status @"+project);
                                    // if ( /is\ running/.test(projectStatus) ) {
                                    //     return;
                                    // }
                                    // Bundles only !
                                    if (bundle) {
                                        process.stdout.write('[MQTail] Not keeping alive bundle `'+ bundle +'`\n');
                                        client.destroy();
                                        return end()
                                    }
                                }
                                // TODO - restart bundle if not starting or restarting
                                else if (
                                    opt.argv.indexOf('--keep-alive') > -1
                                    && ! /(SIGKILL|SIGTERM|SIGINT)/.test(pl.content)
                                ) {
                                    // only for debug
                                    process.stdout.write('[MQTail]['+ bundle +'] bundle is going offline !\n' );
                                    process.stdout.write('[MQTail] '+ JSON.stringify(payloads, null, 2) +'\n' );
                                    // restart the bundle: look into payloads[0].content
                                    // if (project && bundle) {

                                    // }
                                }
                            }

                            //  [ duplicate output fix ]
                            // if (pl.level == "emerg" && ! /^gina$/.test(pl.group) ) {
                            //     // flush needed
                            //     process.stdout.write('[MQTail] Flush needed (2)\n' + '=> '+ loggers[pl.group]._options.isFlushing); //JSON.stringify(pl, null, 2)
                            //     console.flush(pl.group);
                            // }
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
            console.warn('[MQTail] Disconnected from server');
            console.info('[MQTail] Waitting for `MQListener` to be started ...');
            var mqPort = null;
            nIntervId = setInterval(() => {
                try {
                    mqPort = ~~(fs.readFileSync(mqPortFile).toString());
                    if (mqPort) {
                        process.emit('gina#mqlistener-started', mqPort);
                    }
                } catch (fileErr) {}
            }, 100);
        });
        // setInterval(() => {}, 1 << 30);
    }

    var end = function (output, type, messageOnly) {
        var err = false;
        if ( typeof(output) != 'undefined') {
            if ( output instanceof Error ) {
                err = output = ( typeof(messageOnly) != 'undefined' && /^true$/i.test(messageOnly) ) ? output.message : (output.stack||output.message);
            }
            if ( typeof(type) != 'undefined' ) {
                console[type](output)
            } else {
                console.log(output);
            }
        }

        process.exit( err ? 1:0 )
    }


    init(opt, cmd);
}

module.exports = Tail;