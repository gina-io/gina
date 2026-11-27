/**
 * @module gina/lib/cmd/bundle/inc/start-status
 *
 * The outcome of `gina bundle:start`, carried from the framework daemon to the CLI, and the
 * rules that decide it (#B851, #B854).
 *
 * `bundle:start` is the one command `bin/cli` sends to the daemon over its command socket; the
 * daemon runs `lib/cmd/bundle/start.js` and writes text back, then ends the connection.
 * Nothing carried the outcome: `bin/cli` exited 0 when the connection ended, whatever had
 * happened (measured: a crash, a port another program holds, the 64 s timeout, a refusal,
 * a bundle already running — all 0).
 *
 * The daemon now frames two records on that connection: a header right after it reads the
 * command (`bin/cmd`), and the command's exit code just before it ends the connection
 * (`start.js`'s `end()`, and the online refusal paths). A frame is its payload between two
 * ASCII record separators (`\x1e`), a byte no log line carries. `bin/cli` reads them with
 * `createCliState()`: with the header it waits for the outcome and exits with the trailer's
 * code, or 1 when the connection ended without one; without the header (a daemon started
 * before this change and not restarted) it keeps its old behaviour, exactly.
 *
 * The module is pure: no fs, no framework globals, no process access except through the
 * probes its callers pass; `inc/ps-titles.js` gives the `ps` readings.
 */
'use strict';

/**
 * The ASCII record separator that opens and closes a frame.
 *
 * @constant
 * @type {string}
 */
var RS = '\u001e';

/**
 * The header's payload: the daemon reports the outcome of this command.
 *
 * @constant
 * @type {string}
 */
var HEADER_PAYLOAD = 'gina-status:1';

/**
 * The trailer's payload prefix; the exit code follows it.
 *
 * @constant
 * @type {string}
 */
var EXIT_PREFIX = 'gina-exit:';

/**
 * The longest payload read as a frame. An opening separator with no closing one within it
 * is plain text, so a stray `\x1e` can never hold the output back for long.
 *
 * @constant
 * @type {number}
 */
var MAX_FRAME = 64;

/**
 * The line node prints on stderr when the inspector cannot bind its port (`--inspect`,
 * `--inspect-brk`). The bundle then runs without the inspector (measured: it starts and
 * listens), so the line is a warning for the CLI, not an outcome.
 *
 * @constant
 * @type {RegExp}
 */
var INSPECTOR_FAILURE_RE = /Starting inspector on \S+ failed: address already in use/;

/**
 * The bind failure core/server.js reports before it ends the boot: its emerg line
 * (`[ SERVER ] could not listen on port <port>: <code> (…)`) and its stderr line
 * (`[ FRAMEWORK ] abort: could not listen on port <port>: <code> (…)`) both carry it.
 *
 * @constant
 * @type {RegExp}
 */
var BIND_FAILURE_RE = /could not listen on port (\S+): ([A-Z][A-Z0-9_]*)/;

/**
 * Reads an exit code: an integer from 0 to 255; anything else is 1.
 *
 * @param {*} code - The candidate
 * @returns {number} The exit code
 * @example
 * normalizeCode(3);      // 3
 * normalizeCode('3');    // 1 — not a number
 * normalizeCode(300);    // 1
 */
function normalizeCode(code) {
    return ( typeof(code) == 'number' && code === Math.floor(code) && code >= 0 && code <= 255 ) ? code : 1;
}

/**
 * The header frame.
 *
 * @returns {string} `\x1egina-status:1\x1e`
 * @example
 * conn.write(encodeHeader());
 */
function encodeHeader() {
    return RS + HEADER_PAYLOAD + RS;
}

/**
 * The trailer frame for an exit code.
 *
 * @param {number} code - The exit code (read with `normalizeCode()`)
 * @returns {string} `\x1egina-exit:<code>\x1e`
 * @example
 * encodeExit(0);   // '\x1egina-exit:0\x1e'
 */
function encodeExit(code) {
    return RS + EXIT_PREFIX + normalizeCode(code) + RS;
}

/**
 * Writes the trailer to a client that takes frames: the connection `bin/cmd` marked with
 * `ginaStatusFrames`. Any other client (process.stdout for an offline command) is left alone,
 * and so is one already destroyed. Never throws.
 *
 * @param {object} client - The command's client
 * @param {number} code - The exit code
 * @returns {boolean} `true` when the trailer was written
 * @example
 * writeExit(opt.client, 1);
 * opt.client.emit('end');
 */
function writeExit(client, code) {
    if ( !client || client.ginaStatusFrames !== true || client.destroyed ) {
        return false;
    }
    try {
        client.write(encodeExit(code));
        return true;
    } catch (writeErr) {
        return false;
    }
}

/**
 * Reads the frames out of a stream of chunks. `push()` returns the text with every frame of
 * ours removed; an incomplete frame at the end of a chunk is held until the next one; a
 * payload that is not ours is passed through as text, and its closing separator is read again
 * as the one that may open our next frame, so a stray separator just before a frame of ours
 * does not hide it.
 *
 * @returns {{push: function(*): string, flush: function(): string, hasHeader: function(): boolean, exitCode: function(): ?number}}
 * @example
 * var r = createStatusReader();
 * r.push('Trying to start\x1egina-st');     // 'Trying to start'
 * r.push('atus:1\x1e … started\x1egina-exit:0\x1e');  // ' … started'
 * r.hasHeader();   // true
 * r.exitCode();    // 0
 */
function createStatusReader() {
    var pending = '', header = false, exit = null;
    return {
        push: function (chunk) {
            var s = pending + String(chunk);
            var out = '', i = 0;
            pending = '';
            while (i < s.length) {
                var a = s.indexOf(RS, i);
                if (a < 0) {
                    out += s.slice(i);
                    break;
                }
                out += s.slice(i, a);
                var b = s.indexOf(RS, a + 1);
                if (b < 0 || b - a - 1 > MAX_FRAME) {
                    if (b < 0 && s.length - a - 1 <= MAX_FRAME) {
                        // possibly a frame split across chunks: hold it
                        pending = s.slice(a);
                        break;
                    }
                    // not a frame: the separator is text
                    out += RS;
                    i = a + 1;
                    continue;
                }
                var payload = s.slice(a + 1, b);
                if (payload === HEADER_PAYLOAD) {
                    header = true;
                } else if (payload.indexOf(EXIT_PREFIX) === 0 && /^\d{1,3}$/.test(payload.slice(EXIT_PREFIX.length))) {
                    exit = normalizeCode(parseInt(payload.slice(EXIT_PREFIX.length), 10));
                } else {
                    // not ours: the opening separator and the payload are text, and the closing
                    // separator is read again, since it may open our next frame. Consumed here, a
                    // stray separator up to MAX_FRAME characters before the trailer swallowed the
                    // trailer's own opening one and the exit code was lost (the #B851 review, F1).
                    // was: out += s.slice(a, b + 1);
                    out += s.slice(a, b);
                    i = b;
                    continue;
                }
                i = b + 1;
            }
            return out;
        },
        flush: function () {
            var p = pending;
            pending = '';
            return p;
        },
        hasHeader: function () { return header; },
        exitCode: function () { return exit; }
    };
}

/**
 * The state `bin/cli` keeps for one online command.
 *
 * `onData(chunk)` returns what to print and what to do: with the daemon's header, nothing ends
 * the command early, and the debugger hint is asked for once, when node could not bind the
 * inspector; without it (an older daemon) a chunk carrying `address already in use` asks for
 * the hint and for the connection to end at once, as `bin/cli` always did. `onEnd()` returns
 * the exit code: the trailer's with the header, 1 with the header and no trailer (the
 * connection ended before the daemon reported the outcome), 0 without the header.
 *
 * @returns {{onData: function(*): {print: string, hint: boolean, endNow: boolean}, onEnd: function(): {print: string, code: number, message: ?string}}}
 * @example
 * var state = createCliState();
 * client.on('data', function (d) { var r = state.onData(d); process.stdout.write(r.print); });
 * client.on('end', function () { var r = state.onEnd(); process.exit(r.code); });
 */
function createCliState() {
    var reader = createStatusReader(), hinted = false;
    return {
        onData: function (chunk) {
            var text = reader.push(chunk);
            var r = { print: text, hint: false, endNow: false };
            if ( reader.hasHeader() ) {
                if ( !hinted && INSPECTOR_FAILURE_RE.test(text) ) {
                    hinted = true;
                    r.hint = true;
                }
            } else if ( /address already in use/.test(text) ) {
                r.hint = true;
                r.endNow = true;
            }
            return r;
        },
        onEnd: function () {
            var rest = reader.flush();
            if ( !reader.hasHeader() ) {
                return { print: rest, code: 0, message: null };
            }
            var code = reader.exitCode();
            if ( code === null ) {
                return { print: rest, code: 1, message: 'gina: the framework ended this command before it reported the outcome.' };
            }
            return { print: rest, code: code, message: null };
        }
    };
}

/**
 * The exit code for a bundle that stopped before it was ready: its own code when it is not 0,
 * 128 + the signal number when a signal stopped it (1 for a signal with no known number), 1
 * when it exited 0 — `bin/gina`'s `exitCodeBeforeReady()` for the framework (#B759).
 *
 * @param {?number} code - The child's exit code; null when a signal ended it
 * @param {?string} signal - The signal; null when it exited
 * @returns {number} The exit code
 * @example
 * exitCodeBeforeReady(3, null);          // 3
 * exitCodeBeforeReady(null, 'SIGKILL');  // 137
 * exitCodeBeforeReady(0, null);          // 1
 */
function exitCodeBeforeReady(code, signal) {
    if ( typeof(code) == 'number' && code !== 0 ) {
        return normalizeCode(code);
    }
    if ( signal ) {
        var signo = require('os').constants.signals[signal];
        return ( typeof(signo) == 'number' ) ? 128 + signo : 1;
    }
    return 1;
}

/**
 * Reads the bind failure out of a bundle's output.
 *
 * @param {*} text - A chunk of the bundle's stdout or stderr
 * @returns {?{port: string, code: string}} The port and the error code, or `null`
 * @example
 * parseBindFailure('[ FRAMEWORK ] abort: could not listen on port 3100: EADDRINUSE (listen …)');
 * // { port: '3100', code: 'EADDRINUSE' }
 */
function parseBindFailure(text) {
    var m = BIND_FAILURE_RE.exec(String(text));
    return m ? { port: m[1], code: m[2] } : null;
}

/**
 * The line `bundle:start` prints when the bundle could not bind its port: for `EADDRINUSE`,
 * another program holds it (a running gina bundle of this name is found before the spawn), and
 * outside Windows the line names a command that finds the holder — the wording of the
 * framework's own held-port message (#B761).
 *
 * @param {string} name - `<bundle>@<project>`
 * @param {{port: string, code: string}} failure - From `parseBindFailure()`
 * @param {boolean} [isWin32] - True on Windows (no `lsof`)
 * @returns {string} The line, starting with two spaces like the other outcome lines
 * @example
 * bindFailureMessage('api@shop', { port: '3100', code: 'EADDRINUSE' }, false);
 * // '  [ api@shop ] could not start: port 3100 is held by another program, not a running gina bundle api@shop.\n  Find the holder: lsof -nP -iTCP:3100 -sTCP:LISTEN'
 */
function bindFailureMessage(name, failure, isWin32) {
    if ( failure.code !== 'EADDRINUSE' ) {
        return '  [ '+ name +' ] could not start: it could not listen on port '+ failure.port +' ('+ failure.code +').';
    }
    var msg = '  [ '+ name +' ] could not start: port '+ failure.port +' is held by another program, not a running gina bundle '+ name +'.';
    if ( !isWin32 ) {
        msg += '\n  Find the holder: lsof -nP -iTCP:'+ failure.port +' -sTCP:LISTEN';
    }
    return msg;
}

/**
 * Escapes a string for a RegExp.
 *
 * @inner
 * @param {string} s - The text
 * @returns {string} The escaped text
 */
function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Finds the bundle that already runs under this name, from its pid file (#B851, #B854): the
 * pid the file holds is a running process titled `gina: <bundle>@<project>`; on Bun, which
 * shows no title to `ps`, a running process whose command line holds the bundle's entry; where
 * `ps` cannot tell (Windows, busybox), a live pid. A zombie, a dead pid, a pid that another
 * program now has and a file that holds no pid are not a running bundle. The title check is
 * the framework's own rule (#B761): in a fresh pid namespace a stale file can name a live,
 * unrelated process.
 *
 * @param {*} pidContent - The pid file's content; `null` when there is no file
 * @param {string} name - `<bundle>@<project>`
 * @param {?string} entry - The bundle's entry (its `index.js` path), for Bun; may be null
 * @param {{read: function(number): (?object|undefined), alive: function(number): boolean, parsePid: function(*): ?number}} probe
 *   `read` is `inc/ps-titles.js` `readPidTitle()`; `alive` sends signal 0; `parsePid` reads the content
 * @returns {?number} The running bundle's pid, or `null`
 * @example
 * findRunningBundle('4242', 'api@shop', '/srv/shop/src/api/index.js', probe);  // 4242 while it runs
 */
function findRunningBundle(pidContent, name, entry, probe) {
    if ( pidContent === null || typeof(pidContent) == 'undefined' ) {
        return null;
    }
    var pid = probe.parsePid(pidContent);
    if ( pid === null ) {
        return null;
    }
    var seen = probe.read(pid);
    if ( seen === null ) {
        return null;
    }
    if ( typeof(seen) == 'undefined' ) {
        return probe.alive(pid) ? pid : null;
    }
    if ( seen.zombie ) {
        return null;
    }
    var command = String(seen.command || '');
    if ( new RegExp('^gina: '+ escapeRegex(name) +'(\\s|$)').test(command) ) {
        return pid;
    }
    if ( entry && command.indexOf(entry) > -1 ) {
        return pid;
    }
    return null;
}

/**
 * Whether `bundle:restart` restarted the bundle (#B851, the check moved from #B850): after a
 * start that exited 0, a bundle runs (`findRunningBundle()` read its pid file) and it is not
 * the process that ran before the stop. A start that reported « already running » after a stop
 * that did not stop the bundle exits 0 with the same pid; a start that read as started while no
 * bundle runs is the older daemon's case (`b850-design.md` § 7).
 *
 * @param {?number} prePid - The running bundle's pid before the stop, or null
 * @param {?number} postPid - The running bundle's pid after the start, or null
 * @returns {?string} `null` when it restarted; otherwise the reason, for
 *   `[ <bundle>@<project> ] did not restart: <reason>`
 * @example
 * restartFailure(4242, 4300);   // null
 * restartFailure(4242, 4242);   // 'PID 4242 still runs after the stop'
 * restartFailure(null, null);   // 'no running bundle after the start'
 */
function restartFailure(prePid, postPid) {
    if ( postPid === null || typeof(postPid) == 'undefined' ) {
        return 'no running bundle after the start';
    }
    if ( prePid !== null && typeof(prePid) != 'undefined' && postPid === prePid ) {
        return 'PID '+ postPid +' still runs after the stop';
    }
    return null;
}

module.exports = {
    restartFailure       : restartFailure,
    RS                   : RS,
    HEADER_PAYLOAD       : HEADER_PAYLOAD,
    EXIT_PREFIX          : EXIT_PREFIX,
    INSPECTOR_FAILURE_RE : INSPECTOR_FAILURE_RE,
    BIND_FAILURE_RE      : BIND_FAILURE_RE,
    normalizeCode        : normalizeCode,
    encodeHeader         : encodeHeader,
    encodeExit           : encodeExit,
    writeExit            : writeExit,
    createStatusReader   : createStatusReader,
    createCliState       : createCliState,
    exitCodeBeforeReady  : exitCodeBeforeReady,
    parseBindFailure     : parseBindFailure,
    bindFailureMessage   : bindFailureMessage,
    findRunningBundle    : findRunningBundle
};
