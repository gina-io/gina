/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Stall watchdog — the heartbeat reading rules, as a pure state machine (no
 * thread, no clock of its own), so the watching thread's timing is testable with
 * synthetic time. `worker.js` steps it once per reading.
 *
 * @module gina/lib/stall-watchdog/detector
 */

/**
 * Build a detector for one watched thread.
 *
 * `step(now, value)` takes one reading of the heartbeat counter:
 *   - the first reading only sets the start;
 *   - a value that moved ends a reported stall: `{ t: 'resumed', ms }`, `ms` being
 *     the whole silence (from the last move before it to this one);
 *   - a value that has not moved for `thresholdMs` reports ONE stall:
 *     `{ t: 'stall', ms }`; the readings that follow, still silent, report nothing;
 *   - a reading that comes `thresholdMs` or more after the previous one, outside a
 *     reported stall, means the reader itself did not run: the whole process, or
 *     its host, was suspended (`SIGSTOP`, a laptop's sleep), so the silence is not
 *     the watched thread's — the count starts again from this reading.
 *
 * @memberof module:gina/lib/stall-watchdog/detector
 * @param {number} thresholdMs - The silence that is a stall
 * @returns {{step: function(number, number): ?{t: string, ms: number}}}
 * @example
 * var d = createDetector(1000);
 * d.step(0, 1);    // null (the start)
 * d.step(250, 2);  // null (it moved)
 * d.step(1250, 2); // { t: 'stall', ms: 1000 }
 * d.step(3000, 3); // { t: 'resumed', ms: 2750 }
 */
function createDetector(thresholdMs) {
    var last       = null;
    var lastChange = null;
    var lastTick   = null;
    var stalled    = false;

    return {
        step: function(now, value) {
            if ( lastTick === null || ( !stalled && now - lastTick >= thresholdMs ) ) {
                last       = value;
                lastChange = now;
                lastTick   = now;
                return null;
            }
            lastTick = now;
            if ( value !== last ) {
                var silence = now - lastChange;
                var ended   = stalled;
                last       = value;
                lastChange = now;
                stalled    = false;
                return ( ended ) ? { t: 'resumed', ms: silence } : null;
            }
            if ( !stalled && now - lastChange >= thresholdMs ) {
                stalled = true;
                return { t: 'stall', ms: now - lastChange };
            }
            return null;
        }
    };
}

module.exports = {
    createDetector : createDetector
};
