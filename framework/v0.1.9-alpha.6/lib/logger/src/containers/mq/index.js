'use strict';
// Imports
const fs          = require('fs');
const net         = require('net');
const util        = require('util');
const promisify   = util.promisify;
var merge         = require(__dirname +'/../../../../merge');
if ( typeof(merge) != 'function' ) {
    // if needed for unit tests
    merge = eval(fs.readFileSync(__dirname +'/../../../../merge/src/main.js').toString())
}
function MqContainer(opt, loggers) {
    var self = {
        // flow or container name/id
        name: 'mq'
    };

    // TODO - get options like the `port` from: ~/.gina/user/extensions/logger/{container}/config.json

    var MQSpeaker       = require('./speaker.js');
    opt = merge(opt, { mqPort: 8125, hostV4: '127.0.0.1' });
    var mqSpeaker       = new MQSpeaker(opt, loggers);

    function init() {

        onPayload()

        // ------------------------------------------------------------------------
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

    function onPayload() {
        process.on('logger#'+self.name, function onPayload(payload) {
            if ( loggers[opt.name]._options.isFlushing ) {
                return;
            }

            if ( !loggers[opt.name]._options.isReporting ) {
                return;
            }

            if (mqSpeaker.write) {
                mqSpeaker.write( payload +'\r\n' );
            }

        });
    }

    init();
}
module.exports = MqContainer;