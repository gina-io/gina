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

        // #M12 — structured (JSON) logging. The render format is resolved once at logger
        // init (main.js -> opt.format) and cloned into this container's `opt`. We read
        // opt.format here; if it is absent (a logger init path that predates #M12) we fall
        // back to the #K8s3 GINA_LOG_STDOUT env flag, so behaviour is unchanged either way.
        // JSON mode  -> one machine-parseable object per line (kubectl logs / Fluentd /
        //               Datadog / Loki).
        // text mode  -> the coloured, human-readable format() output (the default).
        var isJsonMode = (opt && opt.format)
            ? (opt.format === 'json')
            : /^true$/i.test(process.env.GINA_LOG_STDOUT);

        process.on('logger#'+self.name, function onPayload(payload) {

            try {
                var payloadObj = JSON.parse(payload);

                if (isJsonMode) {
                    // #M12 — `bundle` and `message` are the canonical keys; `group` and `msg`
                    // are retained as back-compat aliases for pre-#M12 JSON consumers (the
                    // shipped #K8s3 shape was {ts, level, group, msg}). Additive, non-breaking.
                    var _jsonLine = {
                        ts     : new Date().toISOString(),
                        level  : payloadObj.level,
                        bundle : payloadObj.group,
                        message: payloadObj.content,
                        group  : payloadObj.group,
                        msg    : payloadObj.content
                    };
                    // #M12b — stamp the per-request id + elapsed-ms when a request context
                    // is active (process.gina._reqALS, created by server.js in JSON mode).
                    // Absent for CLI / boot / off-request logs — the fields are then omitted.
                    if (process.gina && process.gina._reqALS) {
                        var _reqStore = process.gina._reqALS.getStore();
                        if (_reqStore) {
                            _jsonLine.requestId  = _reqStore.requestId;
                            _jsonLine.durationMs = Date.now() - _reqStore.startMs;
                        }
                    }
                    process.stdout.write(JSON.stringify(_jsonLine) + '\n');
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