/**
 * @module gina/lib/cmd/framework/inc/listen-error
 *
 * Decides what `gina start` does when the framework's command socket cannot
 * listen (#B761). `bin/cli` binds the MQ listener, then `bin/cmd` binds the
 * command socket on the framework port; its `error` handler asks `decide()`.
 *
 * When the port is in use, « Framework already running … [ <pid> ] » (the line
 * the `gina` wrapper exits 0 on) is printed only for a `procs.json` entry whose
 * pid is alive and a framework daemon, read with `inc/ps-titles.js`
 * `readPidTitle()`: titled `gina-v<version>` on Node, or, on Bun (which does
 * not show `process.title`), still running the framework's own start command.
 * Otherwise, and for any other listen error, the start writes the reason to
 * stderr and exits 1, which also frees the MQ port the starting process holds.
 *
 * Before 0.7.3 the handler trusted any `procs.json` entry for the port without
 * checking it, returned when there was none, and only logged any other error:
 * a port held by another program read « already running » with exit 0, a stale
 * entry named a dead pid, the process never ended (a half-started daemon kept
 * the MQ port), and an EACCES left `gina start` hanging.
 */
var psTitles = require('./ps-titles');

/**
 * The prefix of every message this module writes.
 *
 * @constant
 * @type {string}
 */
var PREFIX = 'gina: cannot start the framework: ';

/**
 * Lists the pids that `procs.json` records for a port, in the file's order:
 * each entry of its own whose `port` equals `port` once both are strings, its
 * `pid` read with `parsePid()` (so `-1`, `0`, `12abc` and `null` are no pid).
 * A pid recorded twice is listed once.
 *
 * @param {?object} procs - The parsed `procs.json`: `{ "<title>": { pid, port, … } }`
 * @param {number|string} port - The framework port
 * @returns {Array<number>} The recorded pids; empty when there is none
 * @example
 * findRecordedPids({ 'gina-v0.7.2': { pid: 111, port: 8124 }, 'gina-v0.7.3': { pid: 222, port: '8124' } }, 8124);
 * // [ 111, 222 ]
 */
function findRecordedPids(procs, port) {
    var pids = [];
    if (!procs || typeof procs !== 'object' || port === null || typeof port === 'undefined' || String(port) === '') {
        return pids;
    }
    Object.keys(procs).forEach(function (key) {
        var entry = procs[key];
        if (!entry || typeof entry !== 'object' || String(entry.port) !== String(port)) {
            return;
        }
        var pid = psTitles.parsePid(entry.pid);
        if (pid !== null && pids.indexOf(pid) < 0) {
            pids.push(pid);
        }
    });
    return pids;
}

/**
 * The first pid that `procs.json` records for a port (see `findRecordedPids()`).
 *
 * @param {?object} procs - The parsed `procs.json`
 * @param {number|string} port - The framework port
 * @returns {?number} The pid, or `null` when no entry for the port has one
 * @example
 * findRecordedPid({ x: { pid: 4321, port: '8124' } }, 8124);  // 4321
 * findRecordedPid({ x: { pid: '-1', port: 8124 } }, 8124);    // null
 */
function findRecordedPid(procs, port) {
    var pids = findRecordedPids(procs, port);
    return pids.length > 0 ? pids[0] : null;
}

/**
 * Tells what a recorded pid is now. It is `'dead'` when no process has it
 * (`process.kill(pid, 0)` throws, other than EPERM, which another user's live
 * process gives) or when it is a zombie; `'framework'` when it is a framework
 * daemon: titled `gina-v<version>` (`DAEMON_TITLE_RE`, Node), or running the
 * framework's own start command (`DAEMON_COMMAND_RE`, Bun, which does not
 * show `process.title`); `'other'` when another program has it. Where the
 * process cannot be read, the alive check decides, as before 0.7.3: `ps`
 * cannot tell (no `ps` on Windows, busybox), or `ps` lists nothing for
 * another user's live process (a `/proc` mounted with `hidepid`).
 *
 * @param {number} pid - A pid read with `parsePid()`
 * @param {{kill: function(number, number), readPidTitle: function(number): (?object|undefined)}} [probe]
 *   Replaces `process.kill` and `readPidTitle()` (tests)
 * @returns {string} `'framework'`, `'other'` or `'dead'`
 * @example
 * classifyPid(process.pid);  // 'other' — a live process that is not a framework daemon
 * classifyPid(99999);        // 'dead' — when no process has that pid
 */
function classifyPid(pid, probe) {
    var kill = (probe && probe.kill) ? probe.kill : function (p, signal) { return process.kill(p, signal); };
    var read = (probe && probe.readPidTitle) ? probe.readPidTitle : psTitles.readPidTitle;
    var otherUser = false;
    try {
        kill(pid, 0);
    } catch (killErr) {
        if (!killErr || killErr.code !== 'EPERM') {
            return 'dead';
        }
        otherUser = true;
    }
    var seen = read(pid);
    if (typeof seen === 'undefined') {
        return 'framework';
    }
    if (seen === null) {
        // our own process is always listed, so it has just exited; another
        // user's live process can be hidden from `ps`
        return otherUser ? 'framework' : 'dead';
    }
    if (seen.zombie) {
        return 'dead';
    }
    var isDaemon = psTitles.DAEMON_TITLE_RE.test(seen.title || '')
        || psTitles.DAEMON_COMMAND_RE.test(seen.command || '');
    return isDaemon ? 'framework' : 'other';
}

/**
 * The message for a framework port held by something that is not a running
 * framework: the cause, the fix, and (not on Windows) how to find the holder.
 * It never says « address already in use »: the `gina` wrapper exits on those
 * words at once instead of waiting for the start's exit code.
 *
 * @param {number|string} port - The framework port
 * @param {?{procsFile: string, pid: number, state: string}} recorded - The
 *   `procs.json` entry for the port, with the `classifyPid()` state of its pid
 *   (`'dead'` or `'other'`); `null` when there is none
 * @param {string} platform - `process.platform`
 * @returns {string} Two or three lines, without a trailing newline
 * @example
 * heldPortMessage(8124, null, 'darwin');
 * // gina: cannot start the framework: port 8124 is held by another program, not a running gina framework.
 * // Free the port, or move the framework: gina framework:set --port=<port>
 * // Find the holder: lsof -nP -iTCP:8124 -sTCP:LISTEN
 */
function heldPortMessage(port, recorded, platform) {
    var cause = PREFIX + 'port ' + port + ' is held by another program';
    if (recorded && recorded.pid) {
        cause += '; ' + recorded.procsFile + ' names pid ' + recorded.pid + ', which is '
            + (recorded.state === 'dead' ? 'not running.' : 'not a gina framework.');
    } else {
        cause += ', not a running gina framework.';
    }
    var lines = [cause, 'Free the port, or move the framework: gina framework:set --port=<port>'];
    if (platform !== 'win32') {
        lines.push('Find the holder: lsof -nP -iTCP:' + port + ' -sTCP:LISTEN');
    }
    return lines.join('\n');
}

/**
 * Decides what the command socket's `error` handler does when the socket
 * cannot listen. Only an EADDRINUSE under `framework:start` looks at
 * `procs.json`: when a pid recorded for the port is a running framework, the
 * start reports it as already running; otherwise it exits 1 with
 * `heldPortMessage()`. Any other error exits 1 with its own message, on one
 * line.
 *
 * @param {Error} err - The listen error (`code`, `port`, `message`)
 * @param {object} ctx
 * @param {string} ctx.command - The command being run (`process.argv[2]`)
 * @param {number|string} ctx.port - The framework port
 * @param {string} ctx.procsFile - The path of `procs.json`, named in the message
 * @param {?object} ctx.procs - The parsed `procs.json`; `null` when it is
 *   missing or does not parse
 * @param {string} [ctx.platform] - Defaults to `process.platform`
 * @param {function(number): string} [ctx.classifyPid] - Defaults to `classifyPid()` (tests)
 * @returns {{action: string, pid: number, port: (number|string)}|{action: string, code: number, message: string}}
 *   `{ action: 'already-running', pid, port }` or `{ action: 'exit', code: 1, message }`
 * @example
 * var decision = decide(err, { command: 'framework:start', port: 8124, procsFile: procsFile, procs: procs });
 * if (decision.action === 'already-running') {
 *     console.warn('Framework already running on port `'+ decision.port +'`: [ '+ decision.pid +' ]');
 * } else {
 *     fs.writeSync(2, decision.message + '\n');
 *     process.exit(decision.code);
 * }
 */
function decide(err, ctx) {
    ctx = ctx || {};
    var platform = ctx.platform || process.platform;

    if (err && err.code === 'EADDRINUSE' && ctx.command === 'framework:start') {
        var classify = ctx.classifyPid || classifyPid;
        var pids     = findRecordedPids(ctx.procs, ctx.port);
        var recorded = null;
        for (var i = 0; i < pids.length; i++) {
            var state = classify(pids[i]);
            if (state === 'framework') {
                return { action: 'already-running', pid: pids[i], port: ctx.port };
            }
            if (!recorded) {
                recorded = { procsFile: ctx.procsFile, pid: pids[i], state: state };
            }
        }
        return { action: 'exit', code: 1, message: heldPortMessage(ctx.port, recorded, platform) };
    }

    var reason = (err && err.message) ? String(err.message) : String(err);
    return { action: 'exit', code: 1, message: PREFIX + reason.split(/\r?\n/)[0] };
}

module.exports = {
    findRecordedPids : findRecordedPids,
    findRecordedPid  : findRecordedPid,
    classifyPid      : classifyPid,
    heldPortMessage  : heldPortMessage,
    decide           : decide
};
