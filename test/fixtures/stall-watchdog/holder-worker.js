'use strict';
/**
 * Stands for a debugger, for test/lib/stall-watchdog-frames.test.js: pauses the main
 * thread through its own inspector session and keeps it paused for `holdMs`, then
 * resumes it and ends. @@HOLD-EARLY means the main thread ran again before the holder
 * resumed it: another session ended the hold.
 */
var fs        = require('fs');
var wt        = require('worker_threads');
var inspector = require('inspector');

/**
 * Write one marker line straight to fd 1.
 *
 * @param {string} s
 * @returns {void}
 */
function mark(s) {
    fs.writeSync(1, '@@' + s + '\n');
}

var session   = new inspector.Session();
var paused    = false;
var releasing = false;

// An inspector session holds no handle of its own: this keeps the thread alive until
// the hold is over.
var keepalive = setInterval(function() {}, 1000);

session.on('Debugger.paused', function() {
    if ( paused ) {
        return;
    }
    paused = true;
    mark('HOLD-START');
    setTimeout(function() {
        releasing = true;
        mark('HOLD-END');
        session.post('Debugger.resume', {}, function() {
            session.disconnect();
            clearInterval(keepalive);
        });
    }, wt.workerData.holdMs);
});
session.on('Debugger.resumed', function() {
    if ( !releasing ) {
        mark('HOLD-EARLY');
    }
});
session.connectToMainThread();
session.post('Debugger.enable', {}, function() {
    session.post('Debugger.pause', {});
});
