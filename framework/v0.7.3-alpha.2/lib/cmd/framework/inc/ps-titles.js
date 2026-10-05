/**
 * @module gina/lib/cmd/framework/inc/ps-titles
 *
 * Reads framework daemon titles from the process listing, without a shell.
 * `listOwnDaemons()` finds the current user's running daemons for
 * `framework:status` (#B665, #B677); `readPidTitle()` reads one pid's title
 * for the start's listen-error check, `inc/listen-error.js` (#B761).
 *
 * A daemon titles its process `gina-v<version>`: `lib/cmd/index.js` creates it
 * with `new Proc('gina-v' + version)`, and `lib/proc.js` sets that title
 * verbatim. Only a title that matches this rule is returned, so a title can
 * never name a pid file outside the run directory. `framework:status` used to
 * take any `gina-`-titled process of any user, and `_()` normalises `..`, so a
 * process titled `gina-v/../../x` wrote `~/.gina/x.pid`.
 *
 * `ps` runs from an argument vector. `listOwnDaemons()` lists the current
 * user's processes only (`ps -f -U <uid>`, measured on macOS and on procps-ng
 * 4.0.2); a host without `ps`, or with a `ps` that rejects `-U` (busybox),
 * lists nothing. `readPidTitle()` asks for one pid of any user
 * (`ps -p <pid>`), so a framework that another user started still reads as
 * one, and it returns the whole command line as well: Bun does not show
 * `process.title` to `ps` (measured on Bun 1.2.21 under macOS and 1.4.2 under
 * Linux), so a framework running on Bun keeps the command line it was started
 * with, `<bun> …/bin/cli start …` (`DAEMON_COMMAND_RE`).
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
 * A framework daemon's command line where the runtime does not show
 * `process.title` (Bun): the framework's own start command, `bin/cli` followed
 * by `start` or `framework:start` (`gina start` spawns
 * `<runtime> <gina>/bin/cli start --fake-daemon-pid=<pid>`). The `gina` wrapper
 * itself (`bin/gina start`) and any other `bin/cli` command do not match.
 *
 * @constant
 * @type {RegExp}
 */
var DAEMON_COMMAND_RE = /\/bin\/cli\s+(?:framework:)?start(?:\s|$)/;

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

/**
 * Reads one process's title and command line, and whether it is a zombie:
 * runs `ps -ww -p <pid> -o stat=,command=` from an argument vector. The
 * command is everything after the state column; the title is its first word,
 * which a framework daemon on Node sets to `gina-v<version>` (the eighth
 * column of `ps -f`). On Bun the title stays the runtime's path and the
 * command keeps its arguments (see `DAEMON_COMMAND_RE`). A zombie's state
 * starts with `Z`. `-ww` keeps the command whole: procps-ng cuts it to
 * `$COLUMNS` even when its output is piped (measured; macOS does not).
 * Unlike `listOwnDaemons()`, it asks for a pid of any user, so a framework
 * that another user started (with sudo) still reads as one.
 *
 * @param {*} pid - The pid, read with `parsePid()`
 * @returns {?{title: string, command: string, zombie: boolean}|undefined} The
 *   title, the command line and the zombie flag; `null` when `pid` is not a
 *   pid, or when `ps` lists no process for it (it exits 1 and prints nothing,
 *   measured on macOS and procps-ng); `undefined` when `ps` cannot tell: no
 *   `ps` (Windows, a slim container image), a `ps` that rejects `-p` (busybox
 *   writes to stderr), any other failure, or an output it cannot read
 * @example
 * readPidTitle(22221);  // { title: 'gina-v0.7.1', command: 'gina-v0.7.1', zombie: false }
 * readPidTitle(22222);  // { title: '/usr/local/bin/bun', command: '/usr/local/bin/bun /opt/gina/bin/cli start --fake-daemon-pid=22220', zombie: false }
 * readPidTitle(99999);  // null — no such process
 * readPidTitle('-1');   // null — not a pid
 */
function readPidTitle(pid) {
    var n = parsePid(pid);
    if (n === null) {
        return null;
    }
    var psOut = '';
    try {
        psOut = execFileSync('ps', ['-ww', '-p', String(n), '-o', 'stat=,command='], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (psErr) {
        // no process for the pid: exit 1, nothing on stdout or stderr
        if (
            psErr
            && psErr.status === 1
            && String(psErr.stdout || '').trim() === ''
            && String(psErr.stderr || '').trim() === ''
        ) {
            return null;
        }
        return undefined;
    }
    var line = String(psOut || '').split(/\n/).map(function (l) { return l.trim(); }).filter(Boolean)[0];
    if (!line) {
        return undefined;
    }
    var stat    = line.split(/\s+/)[0];
    var command = line.slice(stat.length).trim();
    var zombie  = /^Z/.test(stat);
    if (!zombie && command === '') {
        return undefined;
    }
    return { title: command.split(/\s+/)[0] || '', command: command, zombie: zombie };
}

module.exports = {
    DAEMON_TITLE_RE   : DAEMON_TITLE_RE,
    DAEMON_COMMAND_RE : DAEMON_COMMAND_RE,
    parsePid          : parsePid,
    parseDaemonTitles : parseDaemonTitles,
    listOwnDaemons    : listOwnDaemons,
    readPidTitle      : readPidTitle
};
