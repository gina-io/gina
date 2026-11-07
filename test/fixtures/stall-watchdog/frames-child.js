'use strict';
/**
 * A bundle's main thread, for test/lib/stall-watchdog-frames.test.js: the REAL logger,
 * the REAL watchdog thread (or a test thread through `workerPath`), a request in flight,
 * then a blocked main thread of the kind the spec names. Driven by one JSON spec in
 * argv[2]; every marker the test times is written with fs.writeSync (not the logger), so
 * it reaches the pipe at once.
 *
 * Spec:
 *   fw          framework directory
 *   conf        what lib.stallWatchdog.init() gets as `conf` (a resolveConfig() result)
 *   roots       init()'s `roots`: the directories frame files are written relative to
 *   workerPath  another thread script: a wrapper of the real one (wrap-worker.js), or a
 *               test thread (pausing-worker.js)
 *   test        handed to the thread as `workerData.test`, with `realWorker` (the real
 *               thread's script) added; `signal: true` also adds `flag` (a
 *               SharedArrayBuffer the busy loop polls)
 *   block       `js` (a busy loop in deep/blocker.js), `native` (a sleep through execSync),
 *               `held` (another inspector session pauses the thread: holder-worker.js)
 *   blockMs     how long the block lasts (the busy loop stops early when the flag reads 1)
 *   holdMs      `held`: how long the holder keeps the thread paused
 *   enters      [{ id, m, p }] — requests added to the ring
 *   afterMs     time left after the block for the resume line (default 800)
 *
 * Markers: @@READY <init result>, @@BLOCK-START, @@BLOCK-END, @@LATE <ms> (how late the
 * first timer after the block fired), @@METRIC <seconds>, @@ALIVE <isEnabled()>, and the
 * test threads' own (@@HOLD-START, @@HOLD-EARLY, @@HOLD-END, @@TEST-PAUSED <fault>).
 */
var fs   = require('fs');
var path = require('path');
var EE   = require('events');
var wt   = require('worker_threads');
var spec = JSON.parse(process.argv[2]);

/**
 * Write one marker line straight to fd 1.
 *
 * @param {string} s
 * @returns {void}
 */
function mark(s) {
    fs.writeSync(1, '@@' + s + '\n');
}

process.title = 'gina: demo@proj';
var logger  = require(spec.fw + '/lib/logger');
var sw      = require(spec.fw + '/lib/stall-watchdog');
var blocker = require('./deep/blocker.js');

var flag = null;
var test = ( spec.test ) ? Object.assign({}, spec.test) : null;
if ( test ) {
    test.realWorker = path.join(spec.fw, 'lib', 'stall-watchdog', 'src', 'worker.js');
    if ( test.signal ) {
        var sab = new SharedArrayBuffer(4);
        flag      = new Int32Array(sab);
        test.flag = sab;
    }
}

var metrics = {
    isEnabled                      : function() { return true; },
    registerMainThreadStallMetrics : function() { return true; },
    recordMainThreadStall          : function(s) { mark('METRIC ' + s); }
};
var started = false;
try {
    started = sw.init({
        conf       : spec.conf,
        logger     : logger,
        metrics    : metrics,
        workerPath : spec.workerPath,
        roots      : spec.roots,
        testData   : test
    });
} catch (err) {
    mark('INIT-THREW ' + err.message);
}
mark('READY ' + started);

(spec.enters || []).forEach(function(e) {
    sw.enter({ _ginaReqId: e.id, method: e.m }, new EE(), e.p);
});

/**
 * After the block: how late the first timer fires, then the time left for the resume
 * line, then the watchdog's state.
 *
 * @returns {void}
 */
function after() {
    var t = Date.now();
    setTimeout(function() {
        mark('LATE ' + ( Date.now() - t - 10 ));
        setTimeout(function() {
            mark('ALIVE ' + sw.isEnabled());
            process.exit(0);
        }, ( typeof(spec.afterMs) == 'number' ) ? spec.afterMs : 800);
    }, 10);
}

setTimeout(function() {
    if ( spec.block === 'held' ) {
        var holder = new wt.Worker(path.join(__dirname, 'holder-worker.js'), { workerData: { holdMs: spec.holdMs }, execArgv: [] });
        holder.on('error', function(err) { mark('HOLDER-ERROR ' + err.message); });
        holder.on('exit', function() { after(); });
        return;
    }
    mark('BLOCK-START');
    if ( spec.block === 'native' ) {
        blocker.nativeWait(spec.blockMs);
    } else {
        blocker.parseBody(spec.blockMs, flag);
    }
    mark('BLOCK-END');
    after();
}, 300);
