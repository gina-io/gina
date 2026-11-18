'use strict';
/**
 * Named functions a fixture main thread blocks in, for
 * test/lib/stall-watchdog-frames.test.js: the frames the watchdog reads must name them,
 * innermost first, with their 1-based line and column. `parseBody` calls `mergeBody`,
 * which calls `spinUntil`, a busy loop that also polls an optional flag (an Int32Array
 * over a SharedArrayBuffer) and stops when it reads 1. `nativeWait` blocks inside a
 * native call instead (a child process run synchronously).
 *
 * The test reads this file to find the lines and columns it expects: keep each call on
 * its own line.
 */
var childProcess = require('child_process');

/**
 * @param {number} deadline - Date.now() value to stop at
 * @param {?Int32Array} flag
 * @returns {string} what stopped the loop
 */
function spinUntil(deadline, flag) {
    while ( Date.now() < deadline ) {
        if ( flag && Atomics.load(flag, 0) === 1 ) { return 'flag'; }
    }
    return 'time';
}

/**
 * @param {number} ms
 * @param {?Int32Array} flag
 * @returns {string}
 */
function mergeBody(ms, flag) {
    return spinUntil(Date.now() + ms, flag);
}

/**
 * @param {number} ms
 * @param {?Int32Array} flag
 * @returns {string}
 */
function parseBody(ms, flag) {
    return mergeBody(ms, flag);
}

/**
 * @param {number} ms
 * @returns {void}
 */
function nativeWait(ms) {
    childProcess.execSync('sleep ' + ( ms / 1000 ));
}

module.exports = { parseBody: parseBody, nativeWait: nativeWait };
