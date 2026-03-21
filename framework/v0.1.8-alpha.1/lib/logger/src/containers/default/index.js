'use strict';
// Imports

function DefaultContainer(opt, loggers) {
    var self = {
        // flow or container name/id
        name: 'default'
    };
    var loggerHelper    = require(__dirname +'/../../helper.js')(opt, loggers);
    var format          = loggerHelper.format;

    function init() {

        // process.on('gina#bundle-started', function onBundleStarted(mqPort, hostV4, group) {
        //     onPayload(true);
        // });
        // process.on('gina#container-writting', function onBundleStarted(mqPort, hostV4, group) {
        //     console.debug('[MQDefault] resuming ...');
        //     if (group) {
        //         console.info('[MQTail] Group `'+group+'` connected `'+ hostV4 +'` on port `'+ mqPort +'` :)');
        //     }
        //     onPayload(true);
        // });

        onPayload();
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
        level = null;
        // ------------------------------------------------------------------------
    }

    function onPayload() {

        // #K8s3 — write JSON lines when GINA_LOG_STDOUT=true so that log collectors
        // (kubectl logs, Fluentd, Datadog, etc.) can parse structured output.
        // Otherwise write the standard formatted, coloured output for interactive terminals.
        var isContainerMode = /^true$/i.test(process.env.GINA_LOG_STDOUT);

        process.on('logger#'+self.name, function onPayload(payload) {

            try {
                var payloadObj = JSON.parse(payload);

                if (isContainerMode) {
                    process.stdout.write(JSON.stringify({
                        ts   : new Date().toISOString(),
                        level: payloadObj.level,
                        group: payloadObj.group,
                        msg  : payloadObj.content
                    }) + '\n');
                } else {
                    process.stdout.write( format(payloadObj.group, payloadObj.level, payloadObj.content, payloadObj.skipFormating) );
                }
            } catch (e) {
                process.stdout.write( format('', '', payload, true) );
            }

            payloadObj = null;
        });
    }



    init();
}
module.exports = DefaultContainer;