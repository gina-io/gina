'use strict';
/**
 * Wraps the REAL watchdog thread for test/lib/stall-watchdog-frames.test.js, to steer a
 * capture from outside it (`workerData.test`):
 *
 *   signal          when the watchdog connects to the main thread's inspector (its capture
 *                   starts), set the flag the main thread's busy loop polls, so the block
 *                   ends just as the capture starts (§05)
 *   delayDisableMs  hold the capture's last step (`Debugger.disable`) that long, so the
 *                   readings see the main thread run again while the capture still runs (§05)
 *   throwInFrames   make frames.js's toFrames() throw, inside the capture's handling of the
 *                   pause, while the main thread is paused (§07.05)
 *
 * The watchdog requires `inspector` and `./frames.js` itself; within this thread they are
 * the same module objects as the ones patched here.
 */
var path      = require('path');
var wt        = require('worker_threads');
var inspector = require('inspector');

var test = wt.workerData.test;

if ( test.signal ) {
    var flag    = new Int32Array(test.flag);
    var connect = inspector.Session.prototype.connectToMainThread;
    inspector.Session.prototype.connectToMainThread = function() {
        Atomics.store(flag, 0, 1);
        return connect.apply(this, arguments);
    };
}

if ( test.delayDisableMs > 0 ) {
    var post = inspector.Session.prototype.post;
    inspector.Session.prototype.post = function(method) {
        var self = this, args = arguments;
        if ( method === 'Debugger.disable' ) {
            setTimeout(function() { post.apply(self, args); }, test.delayDisableMs);
            return;
        }
        return post.apply(this, args);
    };
}

if ( test.throwInFrames ) {
    var frames = require(path.join(path.dirname(test.realWorker), 'frames.js'));
    frames.toFrames = function() {
        throw new Error('a fault while the main thread is paused');
    };
}

require(test.realWorker);
