/*
 * This file is part of the gina package.
 * Copyright (c) 2009-2026 Rhinostone <contact@gina.io>
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */
'use strict';

/**
 * Stall watchdog — the blocked thread's call frames, as the stall line names them.
 *
 * Pure (no thread, no inspector), so the formatting is testable without either.
 * `worker.js` hands it the call frames of the inspector's `Debugger.paused` event
 * and the `scriptId → url` map it collected from `Debugger.scriptParsed`: a paused
 * frame's own `url` is empty, so the map is what names its file. A frame reads like
 * a line of a Node stack trace: the function name (`(anonymous)` when it has none),
 * the file, then the 1-based line and column (the inspector counts from 0). The file
 * is written relative to the first root it lies under (the framework directory, the
 * project), and as the runtime named it otherwise (`node:internal/timers`).
 *
 * @module gina/lib/stall-watchdog/frames
 */

var nodePath = require('path');
var nodeUrl  = require('url');

/**
 * Why a stall line carries no frames, as the line writes it: `frames: none (<reason>)`.
 *
 * - `outsideJs`: an inspector step got no answer within its deadline. The main thread
 *   answers only when it runs JavaScript, so it was inside a native call (a synchronous
 *   crypto, zlib, fs or child-process call) or otherwise outside JavaScript.
 * - `bun`: Bun's inspector cannot be used from a worker without opening a debugging
 *   port (`inspector.open()`), which the watchdog never does.
 * - `debugger`: another inspector session already holds the main thread paused (a
 *   debugger at a breakpoint); the watchdog leaves that pause alone.
 * - `ended`: the main thread ran again during the capture, so the frames read were no
 *   longer the stall's.
 * - `unavailable`: this runtime has no inspector to connect to.
 *
 * An error is written `error:<code or name>` ({@link errorReason}).
 *
 * @memberof module:gina/lib/stall-watchdog/frames
 * @constant
 * @type {{outsideJs: string, bun: string, debugger: string, ended: string, unavailable: string}}
 */
var REASONS = {
    outsideJs   : 'native-call-or-outside-js',
    bun         : 'bun',
    debugger    : 'debugger',
    ended       : 'ended',
    unavailable : 'unavailable'
};

/**
 * A frame of the blocked thread, as the stall line names it.
 *
 * @typedef {Object} StallFrame
 * @property {string} fn - The function's name; `(anonymous)` when it has none
 * @property {string} file - Relative to the first root it lies under; otherwise as the runtime named it; `(unknown)` when it has no name
 * @property {number} line - 1-based (0 when the runtime gave none)
 * @property {number} col - 1-based (0 when the runtime gave none)
 */

/**
 * A script url as a file path: a `file://` url is decoded; any other name
 * (`node:internal/timers`, an `evalmachine` script) is kept; none is `(unknown)`.
 *
 * @inner
 * @param {*} url
 * @returns {string}
 */
function toFilePath(url) {
    if ( typeof(url) != 'string' || url === '' ) {
        return '(unknown)';
    }
    if ( url.indexOf('file://') === 0 ) {
        try {
            return nodeUrl.fileURLToPath(url);
        } catch (err) {
            return url;
        }
    }
    return url;
}

/**
 * `file` relative to the first of `roots` it lies under, else unchanged. The roots
 * come longest first, so a project inside the framework tree (or the reverse) is
 * named from the nearer one.
 *
 * @inner
 * @param {string} file
 * @param {string[]} roots - Absolute directories
 * @returns {string}
 */
function relativeTo(file, roots) {
    if ( !Array.isArray(roots) ) {
        return file;
    }
    for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        if ( typeof(root) != 'string' || root === '' ) {
            continue;
        }
        var prefix = ( root.charAt(root.length - 1) === nodePath.sep ) ? root : root + nodePath.sep;
        if ( file.length > prefix.length && file.indexOf(prefix) === 0 ) {
            return file.slice(prefix.length);
        }
    }
    return file;
}

/**
 * The top `max` call frames of a paused thread, innermost first.
 *
 * @memberof module:gina/lib/stall-watchdog/frames
 * @param {Array<Object>} callFrames - `Debugger.paused`'s `params.callFrames` (`functionName`, `url`, `location: {scriptId, lineNumber, columnNumber}`, 0-based)
 * @param {Map<string, string>} urls - `scriptId → url`, from `Debugger.scriptParsed`
 * @param {string[]} roots - Absolute directories, longest first
 * @param {number} max - How many frames to keep
 * @returns {{frames: StallFrame[], more: boolean}} `more`: the stack holds frames beyond `max`
 * @example
 * toFrames([{ functionName: 'mergeBody', url: '', location: { scriptId: '42', lineNumber: 411, columnNumber: 8 } }],
 *     new Map([['42', 'file:///srv/gina/framework/v1.0.0/lib/merge/src/main.js']]), ['/srv/gina/framework/v1.0.0'], 8);
 * // { frames: [{ fn: 'mergeBody', file: 'lib/merge/src/main.js', line: 412, col: 9 }], more: false }
 * toFrames(undefined, new Map(), [], 8); // { frames: [], more: false }
 */
function toFrames(callFrames, urls, roots, max) {
    var list   = Array.isArray(callFrames) ? callFrames : [];
    var limit  = ( typeof(max) == 'number' && max > 0 ) ? max : list.length;
    var frames = [];
    for (var i = 0; i < list.length && frames.length < limit; i++) {
        var cf  = list[i] || {};
        var loc = cf.location || {};
        var url = ( urls && typeof(urls.get) == 'function' ) ? urls.get(loc.scriptId) : null;
        if ( typeof(url) != 'string' || url === '' ) {
            url = cf.url;
        }
        frames.push({
            fn   : ( typeof(cf.functionName) == 'string' && cf.functionName !== '' ) ? cf.functionName : '(anonymous)',
            file : relativeTo(toFilePath(url), roots),
            line : ( typeof(loc.lineNumber) == 'number' ) ? loc.lineNumber + 1 : 0,
            col  : ( typeof(loc.columnNumber) == 'number' ) ? loc.columnNumber + 1 : 0
        });
    }
    return { frames: frames, more: list.length > frames.length };
}

/**
 * The frames as the text line writes them, innermost first: `fn (file:line:col)`
 * joined by ` <- ` (« called from »), and a last ` <- …` when the stack is deeper.
 *
 * @memberof module:gina/lib/stall-watchdog/frames
 * @param {StallFrame[]} frames
 * @param {boolean} [more] - The stack holds frames beyond these
 * @returns {string}
 * @example
 * describeFrames([{ fn: 'mergeBody', file: 'lib/merge/src/main.js', line: 412, col: 9 },
 *     { fn: 'parseBody', file: 'core/server.js', line: 6611, col: 21 }], true);
 * // 'mergeBody (lib/merge/src/main.js:412:9) <- parseBody (core/server.js:6611:21) <- …'
 * describeFrames([], false); // ''
 */
function describeFrames(frames, more) {
    var parts = ( Array.isArray(frames) ? frames : [] ).map(function(f) {
        return f.fn + ' (' + f.file + ':' + f.line + ':' + f.col + ')';
    });
    if ( more ) {
        parts.push('…');
    }
    return parts.join(' <- ');
}

/**
 * The reason a failed capture writes: `error:` and the error's code, or its name;
 * only letters, digits, `_`, `.` and `-` are kept (40 at most).
 *
 * @memberof module:gina/lib/stall-watchdog/frames
 * @param {*} err
 * @returns {string}
 * @example
 * errorReason(Object.assign(new Error('Session is not connected'), { code: 'ERR_INSPECTOR_NOT_CONNECTED' })); // 'error:ERR_INSPECTOR_NOT_CONNECTED'
 * errorReason(new TypeError('x'));                                                                            // 'error:TypeError'
 */
function errorReason(err) {
    var name = ( err && ( err.code || err.name ) ) || 'Error';
    name = String(name).replace(/[^A-Za-z0-9_.\-]/g, '').slice(0, 40);
    return 'error:' + ( name || 'Error' );
}

module.exports = {
    REASONS        : REASONS,
    toFrames       : toFrames,
    describeFrames : describeFrames,
    errorReason    : errorReason
};
