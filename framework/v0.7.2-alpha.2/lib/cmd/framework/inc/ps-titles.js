/**
 * @module gina/lib/cmd/framework/inc/ps-titles
 *
 * Finds the current user's running framework daemons in the process listing,
 * without a shell. Used by `framework:status` (#B665, #B677).
 *
 * A daemon titles its process `gina-v<version>`: `lib/cmd/index.js` creates it
 * with `new Proc('gina-v' + version)`, and `lib/proc.js` sets that title
 * verbatim. Only a title that matches this rule is returned, so a title can
 * never name a pid file outside the run directory. `framework:status` used to
 * take any `gina-`-titled process of any user, and `_()` normalises `..`, so a
 * process titled `gina-v/../../x` wrote `~/.gina/x.pid`.
 *
 * `ps` runs from an argument vector and lists the current user's processes
 * only (`ps -f -U <uid>`, measured on macOS and on procps-ng 4.0.2). A host
 * without `ps`, or with a `ps` that rejects `-U` (busybox), lists nothing.
 */
var execFileSync = require('child_process').execFileSync;

/**
 * A framework daemon's process title: `gina-v`, a digit, then version
 * characters only (letters, digits, `.` and `-`). No `/` can pass, so the
 * title is safe as a file name inside the run directory.
 *
 * @constant
 * @type {RegExp}
 */
var DAEMON_TITLE_RE = /^gina-v[0-9][A-Za-z0-9.-]*$/;

/**
 * Output cap for the `ps -f` listing, which is read whole: Node's 1 MB default
 * could be exceeded on a host running many processes with long command lines
 * (the same cap as `bundle:stop`'s).
 *
 * @constant
 * @type {number}
 */
var PS_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Reads a pid: a positive decimal integer without a leading zero, surrounding
 * whitespace allowed. Anything else is not a pid; `parseInt` made `-1` (every
 * process the user may signal) and `12abc` (pid 12) into pids.
 *
 * @param {*} content - A pid file's content, a `ps` column or a Buffer
 * @returns {?number} The pid, or `null`
 * @example
 * parsePid('4242\n');  // 4242
 * parsePid('-1');      // null
 * parsePid('12abc');   // null
 */
function parsePid(content) {
    var s = String(content).trim();
    return /^[1-9]\d*$/.test(s) ? parseInt(s, 10) : null;
}

/**
 * Picks the framework daemons out of a `ps -f` listing (the `ps -ef` layout:
 * `UID PID PPID C STIME TTY TIME CMD`). The title is the eighth column, and a
 * ninth column holding `<defunct>` flags a zombie. A line whose PID column is
 * not a pid (the header) or whose title is not a daemon title is skipped.
 *
 * @param {string|Buffer} psOut - The listing
 * @returns {Array<{pid: number, title: string, zombie: boolean}>}
 * @example
 * parseDaemonTitles('  501 22221     1   0 12:57AM ??   0:00.04 gina-v0.7.1\n');
 * // [ { pid: 22221, title: 'gina-v0.7.1', zombie: false } ]
 */
function parseDaemonTitles(psOut) {
    var found = [];
    String(psOut || '').split(/\n/).forEach(function (line) {
        var cols  = line.trim().split(/\s+/);
        var pid   = parsePid(cols[1]);
        var title = cols[7] || '';
        if (pid === null || !DAEMON_TITLE_RE.test(title)) {
            return;
        }
        found.push({ pid: pid, title: title, zombie: /defunct/.test(cols[8] || '') });
    });
    return found;
}

/**
 * Lists the current user's framework daemons: runs `ps -f -U <uid>` from an
 * argument vector and reads it with `parseDaemonTitles()`. Returns an empty
 * list where there is no uid (Windows) and where no `ps` could list; a `ps`
 * that exits non-zero after printing keeps what it printed.
 *
 * @returns {Array<{pid: number, title: string, zombie: boolean}>}
 * @example
 * listOwnDaemons().forEach(function (d) {
 *     console.log(d.pid, d.title, d.zombie);
 * });
 */
function listOwnDaemons() {
    if (typeof process.getuid !== 'function') {
        return [];
    }
    var psOut = '';
    try {
        psOut = execFileSync('ps', ['-f', '-U', String(process.getuid())], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: PS_MAX_BUFFER });
    } catch (psErr) {
        psOut = (psErr && psErr.stdout) ? psErr.stdout : '';
    }
    return parseDaemonTitles(psOut);
}

module.exports = {
    DAEMON_TITLE_RE   : DAEMON_TITLE_RE,
    parsePid          : parsePid,
    parseDaemonTitles : parseDaemonTitles,
    listOwnDaemons    : listOwnDaemons
};
