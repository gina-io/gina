/**
 * @module gina/lib/cmd/bundle/inc/boot-lines
 *
 * The boot lines `gina bundle:start` passes on to its client (#B691).
 *
 * A bundle started through the framework daemon writes each levelled line twice:
 * to its own stdout (the logger's `default` container) and to the MQ listener (the
 * `mq` container), which forwards the line to the `gina tail` sessions attached at
 * that instant and keeps no backlog. The daemon reads the bundle's stdout only as a
 * startup watchdog (`start.js`), and until 0.7.1 it passed on nothing from it but an
 * emerg and the started and URL lines. So a warning the bundle logged while it
 * booted reached no operator whose tail attached after the boot: the ordinary
 * `gina bundle:start`, then `gina tail`, and a container whose init script starts
 * the bundle before its tail.
 *
 * `createBootLineFilter()` reads that stdout during the boot and returns the entries
 * logged at warn and above, for `start.js` to write to its client. Each entry comes
 * back as the bundle rendered it, colour codes included. `emerg` is left to the
 * abort path in `start.js`; info, notice and debug stay out.
 *
 * No `fs`, no framework globals: require-by-path unit-testable. It lives in `inc/`
 * so the command loader never takes it for a `bundle:<action>` handler.
 */
'use strict';

/**
 * The level names passed on: every name the logger defines at severity 1 to 4. The
 * logger renders the name the caller used, and it recommends `warning` and `err`
 * over their deprecated aliases `warn` and `error`, so all six are matched.
 *
 * @constant
 * @type {string[]}
 */
var FORWARDED_LEVELS = ['alert', 'crit', 'error', 'err', 'warn', 'warning'];

/**
 * The longest line read, in characters. A longer line is dropped, up to its
 * newline: no boot warning is that long, and the daemon must not buffer a
 * bundle's output without bound.
 *
 * @constant
 * @type {number}
 */
var MAX_PENDING = 64 * 1024;

/**
 * The longest entry passed on, in characters. An entry reaching it is passed on as
 * read so far, and the rest of it is dropped.
 *
 * @constant
 * @type {number}
 */
var MAX_ENTRY = 64 * 1024;

/**
 * The start of an entry once colour codes are stripped: the logger's default
 * template `[%d] [%s][%a] %m`, whose level name is padded to a fixed width, as in
 * `[2026 Sep 27 06:17:10] [warn   ][api@shop] …`. Group 1 is the level name.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var HEADER_RE = /^\[[^\]\n]+\] \[([a-z]+) *\]\[/;

/**
 * Every SGR (colour or style) escape sequence, for stripping.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var SGR_ALL_RE = /\x1b\[[0-9;]*m/g;

/**
 * Whether a line holds an SGR escape sequence.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var SGR_ANY_RE = /\x1b\[[0-9;]*m/;

/**
 * An SGR sequence closing a colour or style at the end of a line. The logger's
 * `format()` wraps a whole message in ONE colour block, so the line that carries
 * the close is the entry's last.
 *
 * @constant
 * @type {RegExp}
 * @private
 */
var SGR_CLOSE_AT_END_RE = /\x1b\[(?:0|22|23|24|27|28|29|39|49)?m[ \t]*$/;

/**
 * Reads the level of a line that starts an entry: a text header, or a JSON line
 * (a logger rendering JSON writes one object per entry).
 *
 * @inner
 * @private
 * @param {string} line - One complete line, without its line ending
 * @returns {?{level: string, closed: boolean}} The entry's level and whether this
 *   line is also its last, or null when the line starts no entry
 */
function readHeader(line) {
    if ( line.charAt(0) == '{' ) {
        try {
            var obj = JSON.parse(line);
            if ( obj && typeof(obj.level) == 'string' ) {
                return { level: obj.level.toLowerCase(), closed: true };
            }
        } catch (parseErr) {
            // not JSON: no entry starts here
        }
        return null;
    }

    var m = line.replace(SGR_ALL_RE, '').match(HEADER_RE);
    if (!m) {
        return null;
    }
    return {
        level : m[1],
        // without colour codes nothing marks where the entry ends: the line is all of it
        closed: !SGR_ANY_RE.test(line) || SGR_CLOSE_AT_END_RE.test(line)
    };
}

/**
 * The filter `createBootLineFilter()` returns.
 *
 * @typedef {object} BootLineFilter
 * @property {function((string|Buffer)): string[]} push - Reads one chunk of the
 *   bundle's stdout; returns the entries at warn and above that the chunk
 *   completed, in order, each as rendered and without a trailing newline
 */

/**
 * Creates the filter for one bundle's boot. A chunk may split a line or carry
 * several: a line is read once its newline arrives, and an entry spanning several
 * lines is returned once its colour block closes or the next entry starts.
 *
 * @returns {BootLineFilter} A filter holding the state of this bundle's output only
 *
 * @example
 *  var bootLines = require('./inc/boot-lines');
 *  var filter    = bootLines.createBootLineFilter();
 *
 *  child.stdout.on('data', function(data) {
 *      var entries = filter.push(data);
 *      // e.g. ['\x1b[33m[2026 Sep 27 06:17:11] [warn   ][api@shop] [ SWIG ] … \x1b[39m']
 *      if (entries.length) client.write('\n' + entries.join('\n') + '\n');
 *  });
 */
function createBootLineFilter() {
    var pending  = ''    // the start of a line whose newline has not arrived yet
      , skipping = false // dropping the rest of a line longer than MAX_PENDING
      , entry    = null  // the entry being read: { forward: boolean, text: string }
    ;

    /**
     * Ends the entry being read; keeps it when it is passed on.
     *
     * @inner
     * @private
     * @param {string[]} out - The entries this push completed
     */
    function finish(out) {
        if (entry && entry.forward) {
            out.push(entry.text);
        }
        entry = null;
    }

    /**
     * Reads one complete line.
     *
     * @inner
     * @private
     * @param {string} line - Without its newline
     * @param {string[]} out - The entries this push completed
     */
    function readLine(line, out) {
        if ( line.charCodeAt(line.length - 1) === 13 ) { // a CRLF line ending
            line = line.slice(0, -1);
        }

        var header = readHeader(line);
        if (header) {
            finish(out); // a new entry ends the one before it
            var forward = FORWARDED_LEVELS.indexOf(header.level) > -1;
            entry = { forward: forward, text: forward ? line : '' };
            if (header.closed) {
                finish(out);
            }
            return;
        }

        if (!entry) { // a line outside any entry: a raw write
            return;
        }
        var closes = SGR_CLOSE_AT_END_RE.test(line);
        if (entry.forward) {
            if ( entry.text.length + 1 + line.length > MAX_ENTRY ) {
                finish(out); // passed on as read so far,
                entry = { forward: false, text: '' }; // and the rest of it read and dropped
            } else {
                entry.text += '\n' + line;
            }
        }
        if (closes) {
            finish(out);
        }
    }

    /**
     * Reads one chunk of the bundle's stdout.
     *
     * @param {string|Buffer} chunk - As read from the child's stdout
     * @returns {string[]} The entries at warn and above this chunk completed, in order
     */
    function push(chunk) {
        var out = [];
        if ( chunk === null || typeof(chunk) == 'undefined' ) {
            return out;
        }

        var text = String(chunk), start = 0, nl = -1, line = null;
        while ( (nl = text.indexOf('\n', start)) > -1 ) {
            line  = pending + text.slice(start, nl);
            start = nl + 1;
            pending = '';
            if (skipping) { // the end of a line too long to read
                skipping = false;
                continue;
            }
            if (line.length > MAX_PENDING) {
                continue;
            }
            readLine(line, out);
        }

        if (!skipping) {
            var rest = text.slice(start);
            if ( pending.length + rest.length > MAX_PENDING ) {
                pending  = '';
                skipping = true;
            } else {
                pending += rest;
            }
        }
        return out;
    }

    return { push: push };
}

module.exports = {
    createBootLineFilter: createBootLineFilter,
    FORWARDED_LEVELS    : FORWARDED_LEVELS,
    MAX_PENDING         : MAX_PENDING,
    MAX_ENTRY           : MAX_ENTRY
};
