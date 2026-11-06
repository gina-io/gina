'use strict';
/**
 * A bundle's main thread, for test/lib/stall-watchdog-worker.test.js: the REAL
 * logger and the REAL watchdog thread, a few requests in flight, then a blocked
 * main thread. Driven by one JSON spec in argv[2]; every marker the test times is
 * written with fs.writeSync (not the logger), so it reaches the pipe at once.
 *
 * Spec:
 *   fw            framework directory
 *   title         process title (default 'gina: demo@proj': the bundle's group)
 *   conf          what lib.stallWatchdog.init() gets as `conf` (a resolveConfig() result)
 *   workerPath    another worker script (the fault test)
 *   redactBefore  { block, secret } — setRedaction() before init (the copy the thread starts with)
 *   redactAfter   { block } — setRedaction() after init (the logger#redaction event)
 *   enters        [{ id, m, p, finish }] — requests added to the ring; `finish` ends one
 *   many          { count, m, p } — that many more requests, none finished
 *   idleMs        idle time before the block (the suspension test sends SIGSTOP in it)
 *   blockMs       the main thread's synchronous block (0: none)
 *   holdMs        time left after the block for the resume line (default 800)
 *   endpoint      write lib.stallWatchdog.resolveMqEndpoint() as @@ENDPOINT
 *
 * Markers: @@READY <init result>, @@BLOCK-START, @@BLOCK-END, @@METRIC <seconds>,
 * @@ENDPOINT <json>, @@ALIVE <isEnabled()>.
 */
var fs   = require('fs');
var EE   = require('events');
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

process.title = spec.title || 'gina: demo@proj';
var logger = require(spec.fw + '/lib/logger');
var sw     = require(spec.fw + '/lib/stall-watchdog');

var group = sw.resolveLogGroup(logger.getOptions().name, process.title);
if ( spec.redactBefore ) {
    logger.setRedaction(spec.redactBefore.block, { group: group, secrets: [{ path: 'test.secret', value: spec.redactBefore.secret }] });
}

// the logger's own crit line: the prefix the watchdog's line must share
logger.crit('PARITY-PROBE');

if ( spec.endpoint ) {
    mark('ENDPOINT ' + JSON.stringify(sw.resolveMqEndpoint()));
}

var metrics = {
    isEnabled                      : function() { return true; },
    registerMainThreadStallMetrics : function() { return true; },
    recordMainThreadStall          : function(s) { mark('METRIC ' + s); }
};
var started = false;
try {
    started = sw.init({ conf: spec.conf, logger: logger, metrics: metrics, workerPath: spec.workerPath });
} catch (err) {
    mark('INIT-THREW ' + err.message);
}
mark('READY ' + started);

if ( spec.redactAfter ) {
    logger.setRedaction(spec.redactAfter.block, { group: group + '-after' });
}

(spec.enters || []).forEach(function(e) {
    var response = new EE();
    sw.enter({ _ginaReqId: e.id, method: e.m }, response, e.p);
    if ( e.finish ) {
        response.emit('finish');
        response.emit('close');
    }
});
if ( spec.many ) {
    for (var i = 0; i < spec.many.count; i++) {
        sw.enter({ _ginaReqId: 'many-' + i, method: spec.many.m }, new EE(), spec.many.p + i);
    }
}

setTimeout(function() {
    if ( spec.blockMs > 0 ) {
        mark('BLOCK-START');
        var end = Date.now() + spec.blockMs;
        while ( Date.now() < end ) { /* the main thread is blocked */ }
        mark('BLOCK-END');
    }
    setTimeout(function() {
        mark('ALIVE ' + sw.isEnabled());
        process.exit(0);
    }, ( typeof(spec.holdMs) == 'number' ) ? spec.holdMs : 800);
}, ( spec.idleMs || 0 ) + 300);
