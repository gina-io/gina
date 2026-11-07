'use strict';
/**
 * Replaces the watchdog thread for test/lib/stall-watchdog-frames.test.js §07. Once the
 * heartbeat has been silent 400 ms (the main thread is blocked), it pauses the main
 * thread through its own inspector session and then, still holding the pause, goes away
 * as `workerData.test.fault` says: `disconnect` (the session closes, the thread lives
 * on), `throw` (an uncaught error, thrown from a timer, ends the thread), `exit` (the
 * thread exits), or `hold` (it keeps the pause: the control, under which the main thread
 * must NOT run again).
 *
 * ⚠️ The error is thrown from a timer on purpose: thrown INSIDE the `Debugger.paused`
 * handler instead, it leaves the main thread paused for good (measured, Node 25.3.0).
 * The watchdog keeps every inspector callback from throwing; §07.05 tests that guard.
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

var hb    = new Int32Array(wt.workerData.hb);
var fault = wt.workerData.test.fault;
var last  = Atomics.load(hb, 0);
var since = Date.now();
var done  = false;

setInterval(function() {
    var v = Atomics.load(hb, 0);
    if ( v !== last ) {
        last  = v;
        since = Date.now();
        return;
    }
    if ( done || Date.now() - since < 400 ) {
        return;
    }
    done = true;
    var session = new inspector.Session();
    session.on('Debugger.paused', function() {
        mark('TEST-PAUSED ' + fault);
        if ( fault === 'disconnect' ) {
            session.disconnect();
        } else if ( fault === 'throw' ) {
            setTimeout(function() { throw new Error('a fault while the main thread is paused'); }, 0);
        } else if ( fault === 'exit' ) {
            process.exit(0);
        }
        // `hold`: the pause stays
    });
    session.connectToMainThread();
    session.post('Debugger.enable', {}, function() {
        session.post('Debugger.pause', {});
    });
}, 50);
