/**
 * lib/cmd/bundle/inc/boot-lines.js — the boot lines `gina bundle:start` passes on
 * to its client (#B691), and its wiring into lib/cmd/bundle/start.js.
 *
 * A bundle started through the framework daemon writes each levelled line to its
 * own stdout (the logger's `default` container) and to the MQ listener (the `mq`
 * container). The listener keeps no backlog, and the daemon read that stdout only
 * as a startup watchdog, so a warning logged during the boot reached no
 * `gina tail` attached after it. The filter picks the entries at warn and above
 * out of that stdout for the start command to write to its client.
 *
 * The module is pure (no fs, no framework globals), so §01–§09 exercise it
 * directly by require-by-path, mostly on lines captured from a daemon-started
 * sandbox bundle. §10 pins the start.js wiring by source inspection, the
 * bundle-start.test.js idiom: start.js needs a running daemon's context.
 */

'use strict';

var fs   = require('fs');
var path = require('path');
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');

var FW          = require('../fw');
var MODULE_PATH = path.join(FW, 'lib/cmd/bundle/inc/boot-lines.js');
var START_PATH  = path.join(FW, 'lib/cmd/bundle/start.js');

/**
 * Loads the module on demand, so §10 still reports pin by pin when the module
 * is absent.
 *
 * @returns {object} The module's exports
 */
function bl() {
    return require(MODULE_PATH);
}

// Captured 2026-09-27 from a daemon-started sandbox bundle: each string is one
// entry exactly as the logger's format() rendered it, colour codes included.
var WARN_REQUIREMENT = '\u001b[33m[2026 Sep 27 06:17:10] [warn   ][b691demo@b691sbx] [CONFIG][loadBundleConfig] [ b691demo ] 1 routing requirement is not anchored at both ends (^…$), so it is tested as a partial match and a value that only contains a match passes: b691item@b691demo { id: /[0-9]+/ }. Anchor it (e.g. /^[0-9]+$/), or write an intended partial match in full (e.g. /^pk_.*$/). See https://gina.io/docs/guides/routing#regex-requirements \u001b[39m';
var WARN_AUTOESCAPE  = '\u001b[33m[2026 Sep 27 06:17:11] [warn   ][b691demo@b691sbx] [ SWIG ] settings.swig.autoescape is not set for [ b691demo ]: Swig output ({{ x }}) is not HTML-escaped. The default becomes true in 0.8.0. Set it explicitly to keep this bundle\'s behaviour and silence this warning: true escapes output (a variable that carries HTML on purpose then needs | safe, e.g. {{ gina.csrfInput | safe }}); false keeps output unescaped. See https://gina.io/docs/reference/settings#swig \u001b[39m';
var INFO_SPEAKER     = '\u001b[36m[2026 Sep 27 06:17:10] [info   ][b691demo@b691sbx] [MQSpeaker] connected to server on host: 127.0.0.1 & port: 10425 :)  \u001b[39m';
var NOTICE_MOUNTED   = '\u001b[30m[2026 Sep 27 06:17:11] [notice ][b691demo@b691sbx] [ FRAMEWORK ][ 77155 ] b691demo@b691sbx mounted ! \u001b[39m';
var INFO_ONLINE      = '\u001b[36m[2026 Sep 27 06:17:11] [info   ][b691demo@b691sbx] is now online V(-.o)V \nbundle: [ b691demo ] \nenv: [ dev ] \nscope: [ local ] \nengine: isaac \nprotocol: http/1.1 \nscheme: http \nport: 10400 \ndebugPort: null \npid: 77155 \nThis way please -> http://localhost:10400/b691demo/ \u001b[39m';
var NOTICE_STARTED   = '\u001b[30m[2026 Sep 27 06:17:11] [notice ][b691demo@b691sbx] [ FRAMEWORK ] Bundle started ! \u001b[39m';

// The boot as the daemon read it, in the captured order.
var BOOT = [WARN_REQUIREMENT, INFO_SPEAKER, WARN_AUTOESCAPE, NOTICE_MOUNTED, INFO_ONLINE, NOTICE_STARTED].join('\n') + '\n';

/**
 * Renders an entry the way lib/logger's format() does with the default template
 * `[%d] [%s][%a] %m`: the level padded to 7, the message followed by the space
 * write() appends, the whole message wrapped in the level's colour.
 *
 * @param {string} level - A level name the logger defines
 * @param {string} message - May hold newlines (a multi-line entry)
 * @returns {string} The rendered entry, without its trailing newline
 */
function render(level, message) {
    var COLOR = { emerg: 35, alert: 31, crit: 35, error: 31, err: 31, warn: 33, warning: 33, notice: 30, info: 36, debug: 90 };
    var padded = level;
    while (padded.length < 7) padded += ' ';
    return '\u001b[' + COLOR[level] + 'm[2026 Sep 27 12:00:00] [' + padded + '][demo@myproject] ' + message + ' \u001b[39m';
}

/**
 * Feeds `text` to a fresh filter in slices of `size` characters.
 *
 * @param {string} text
 * @param {number} size
 * @returns {string[]} Every entry returned, in order
 */
function feed(text, size) {
    var filter = bl().createBootLineFilter(), out = [];
    for (var i = 0; i < text.length; i += size) {
        out = out.concat(filter.push(text.slice(i, i + size)));
    }
    return out;
}

/**
 * start.js without its comment lines, so a needle matches code only: a comment
 * naming the checks it sits between must not satisfy a pin.
 *
 * @param {string} source
 * @returns {string}
 */
function live(source) {
    return source.split('\n').filter(function (l) {
        var t = l.trim();
        return !(t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0);
    }).join('\n');
}


// ---------------------------------------------------------------------------
// 01 — module shape
// ---------------------------------------------------------------------------

describe('01 - module shape', function () {

    it('exports createBootLineFilter, FORWARDED_LEVELS, MAX_PENDING and MAX_ENTRY', function () {
        var m = bl();
        assert.equal(typeof m.createBootLineFilter, 'function');
        assert.ok(Array.isArray(m.FORWARDED_LEVELS));
        assert.equal(typeof m.MAX_PENDING, 'number');
        assert.equal(typeof m.MAX_ENTRY, 'number');
    });

    it('forwards every level name the logger defines at severity 1 to 4, and only those', function () {
        assert.deepEqual(bl().FORWARDED_LEVELS.slice().sort(), ['alert', 'crit', 'err', 'error', 'warn', 'warning']);
    });

    it('is pure: no fs, no framework globals', function () {
        var code = live(fs.readFileSync(MODULE_PATH, 'utf8'));
        assert.equal(code.indexOf("require('fs')"), -1);
        assert.doesNotMatch(code, /\bgetContext\(|\blib\.|\bgetEnvVar\(/);
    });

    it('each filter keeps its own state', function () {
        var a = bl().createBootLineFilter(), b = bl().createBootLineFilter();
        assert.deepEqual(a.push(WARN_AUTOESCAPE.slice(0, 40)), []);
        assert.deepEqual(b.push(WARN_REQUIREMENT + '\n'), [WARN_REQUIREMENT]);
        assert.deepEqual(a.push(WARN_AUTOESCAPE.slice(40) + '\n'), [WARN_AUTOESCAPE]);
    });
});


// ---------------------------------------------------------------------------
// 02 — which levels are passed on
// ---------------------------------------------------------------------------

describe('02 - levels', function () {

    ['warn', 'warning', 'error', 'err', 'crit', 'alert'].forEach(function (level) {
        it('passes on a `' + level + '` entry, as rendered', function () {
            var line = render(level, 'something to see at boot');
            assert.deepEqual(bl().createBootLineFilter().push(line + '\n'), [line]);
        });
    });

    ['emerg', 'notice', 'info', 'debug'].forEach(function (level) {
        it('leaves out a `' + level + '` entry', function () {
            assert.deepEqual(bl().createBootLineFilter().push(render(level, 'not for the start output') + '\n'), []);
        });
    });

    it('passes on the two captured 0.7.0 boot warnings byte for byte, colour codes kept', function () {
        var out = bl().createBootLineFilter().push(WARN_REQUIREMENT + '\n' + WARN_AUTOESCAPE + '\n');
        assert.deepEqual(out, [WARN_REQUIREMENT, WARN_AUTOESCAPE]);
    });

    it('leaves out the captured info and notice lines', function () {
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(INFO_SPEAKER + '\n' + NOTICE_MOUNTED + '\n' + NOTICE_STARTED + '\n'), []);
    });
});


// ---------------------------------------------------------------------------
// 03 — what counts as the start of an entry
// ---------------------------------------------------------------------------

describe('03 - headers', function () {

    it('passes on a header with no colour codes on its own', function () {
        var plain = '[2026 Sep 27 12:00:00] [warn   ][demo@myproject] rendered without colours ';
        assert.deepEqual(bl().createBootLineFilter().push(plain + '\n'), [plain]);
    });

    it('drops a line that starts no entry (a raw write) when no entry is open', function () {
        assert.deepEqual(bl().createBootLineFilter().push('Please wait...\nThis way please -> http://localhost:3100/\n'), []);
    });

    it('reads the level from the level bracket only, not from the message', function () {
        var line = render('info', 'a message quoting [warn   ][other@project] is still info');
        assert.deepEqual(bl().createBootLineFilter().push(line + '\n'), []);
    });

    it('treats an unknown level name as a header: left out, and it ends the open entry', function () {
        var f = bl().createBootLineFilter();
        var open = render('warn', 'first line\nsecond line').split('\n')[0];
        assert.deepEqual(f.push(open + '\n'), []);
        assert.deepEqual(f.push('[2026 Sep 27 12:00:01] [audit  ][demo@myproject] custom level \n'), [open]);
    });
});


// ---------------------------------------------------------------------------
// 04 — chunk boundaries
// ---------------------------------------------------------------------------

describe('04 - chunks', function () {

    it('holds a line until its newline arrives', function () {
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(WARN_AUTOESCAPE), []);
        assert.deepEqual(f.push('\n'), [WARN_AUTOESCAPE]);
    });

    it('joins a line split across chunks, inside an escape sequence too', function () {
        var f = bl().createBootLineFilter();
        assert.equal(WARN_AUTOESCAPE.slice(0, 3), '\u001b[3');
        assert.deepEqual(f.push(WARN_AUTOESCAPE.slice(0, 3)), []);
        assert.deepEqual(f.push(WARN_AUTOESCAPE.slice(3) + '\n'), [WARN_AUTOESCAPE]);
    });

    it('returns several entries from one chunk in order', function () {
        var a = render('warn', 'first'), b = render('err', 'second');
        var out = bl().createBootLineFilter().push(a + '\n' + render('info', 'between') + '\n' + b + '\n');
        assert.deepEqual(out, [a, b]);
    });

    [1, 3, 7, 64, 1000].forEach(function (size) {
        it('returns the same entries when the captured boot arrives in ' + size + '-character chunks', function () {
            assert.deepEqual(feed(BOOT, size), [WARN_REQUIREMENT, WARN_AUTOESCAPE]);
        });
    });
});


// ---------------------------------------------------------------------------
// 05 — entries spanning several lines
// ---------------------------------------------------------------------------

describe('05 - multi-line entries', function () {

    it('leaves out the captured multi-line info entry, continuation lines included', function () {
        assert.deepEqual(bl().createBootLineFilter().push(INFO_ONLINE + '\n'), []);
    });

    it('passes on a multi-line warning whole, once its colour block closes', function () {
        var entry = render('warning', 'first line\nsecond line\nthird line');
        var lines = entry.split('\n');
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(lines[0] + '\n' + lines[1] + '\n'), []);
        assert.deepEqual(f.push(lines[2] + '\n'), [entry]);
    });

    it('ends an unclosed entry when the next entry starts, and passes on what it read', function () {
        var lines = render('crit', 'first line\nsecond line\nthird line').split('\n');
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(lines[0] + '\n' + lines[1] + '\n' + INFO_SPEAKER + '\n'), [lines[0] + '\n' + lines[1]]);
    });

    it('does not add a raw line to an entry that already closed', function () {
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(WARN_AUTOESCAPE + '\nPlease wait...\n'), [WARN_AUTOESCAPE]);
    });

    it('drops the continuation lines of an entry it leaves out, even warning-like ones', function () {
        var info = render('info', 'first\n[not a header] error: text inside an info entry');
        assert.deepEqual(bl().createBootLineFilter().push(info + '\n'), []);
    });
});


// ---------------------------------------------------------------------------
// 06 — JSON lines (a bundle whose logger renders JSON)
// ---------------------------------------------------------------------------

describe('06 - JSON lines', function () {

    function jsonLine(level) {
        return JSON.stringify({ ts: '2026-09-27T11:00:00.000Z', level: level, bundle: 'demo@myproject', message: 'm', group: 'demo@myproject', msg: 'm' });
    }

    ['warn', 'warning', 'error', 'err', 'crit', 'alert'].forEach(function (level) {
        it('passes on a JSON `' + level + '` line as it is', function () {
            assert.deepEqual(bl().createBootLineFilter().push(jsonLine(level) + '\n'), [jsonLine(level)]);
        });
    });

    ['emerg', 'notice', 'info', 'debug'].forEach(function (level) {
        it('leaves out a JSON `' + level + '` line', function () {
            assert.deepEqual(bl().createBootLineFilter().push(jsonLine(level) + '\n'), []);
        });
    });

    it('drops a line that only looks like JSON, without throwing', function () {
        assert.deepEqual(bl().createBootLineFilter().push('{"level":"warn", not json\n'), []);
    });

    it('drops a JSON line whose level is not a string', function () {
        assert.deepEqual(bl().createBootLineFilter().push('{"level":4,"message":"m"}\n'), []);
    });
});


// ---------------------------------------------------------------------------
// 07 — order within the boot
// ---------------------------------------------------------------------------

describe('07 - order', function () {

    it('returns only the warnings of the captured boot, in their order', function () {
        assert.deepEqual(bl().createBootLineFilter().push(BOOT), [WARN_REQUIREMENT, WARN_AUTOESCAPE]);
    });

    it('a chunk ending on a started flag still returns the warnings logged before it', function () {
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(WARN_AUTOESCAPE + '\n' + NOTICE_MOUNTED + '\n' + NOTICE_STARTED + '\n'), [WARN_AUTOESCAPE]);
    });
});


// ---------------------------------------------------------------------------
// 08 — memory bounds
// ---------------------------------------------------------------------------

describe('08 - bounds', function () {

    it('drops a line longer than MAX_PENDING, up to its newline, then reads on', function () {
        var m = bl(), f = m.createBootLineFilter();
        assert.deepEqual(f.push('x'.repeat(m.MAX_PENDING + 10)), []);
        assert.deepEqual(f.push('more of the same line ' + render('warn', 'inside the long line')), []);
        assert.deepEqual(f.push('\n' + WARN_AUTOESCAPE + '\n'), [WARN_AUTOESCAPE]);
    });

    it('drops a complete line longer than MAX_PENDING that arrives in one chunk', function () {
        var m = bl(), long = render('warn', 'y'.repeat(m.MAX_PENDING + 10));
        assert.deepEqual(m.createBootLineFilter().push(long + '\n' + WARN_REQUIREMENT + '\n'), [WARN_REQUIREMENT]);
    });

    it('passes on an entry reaching MAX_ENTRY as read so far, and drops the rest of it', function () {
        var m = bl(), f = m.createBootLineFilter();
        var header = render('alert', 'first').split('\n')[0].replace(/ \u001b\[39m$/, '');
        var filler = 'z'.repeat(1000);
        var out = f.push(header + '\n');
        for (var i = 0; i < 100; i++) out = out.concat(f.push(filler + '\n'));
        assert.equal(out.length, 1, 'one entry, returned when it reached the bound');
        assert.ok(out[0].length <= m.MAX_ENTRY, 'within the bound: ' + out[0].length);
        assert.equal(out[0].indexOf(header), 0);
        assert.deepEqual(f.push('last line of it \u001b[39m\n'), [], 'the rest of that entry is dropped');
        assert.deepEqual(f.push(WARN_AUTOESCAPE + '\n'), [WARN_AUTOESCAPE], 'and the next entry is read');
    });
});


// ---------------------------------------------------------------------------
// 09 — input
// ---------------------------------------------------------------------------

describe('09 - input', function () {

    it('returns nothing for an empty, null or undefined chunk', function () {
        var f = bl().createBootLineFilter();
        assert.deepEqual(f.push(''), []);
        assert.deepEqual(f.push(null), []);
        assert.deepEqual(f.push(undefined), []);
    });

    it('reads a Buffer chunk', function () {
        assert.deepEqual(bl().createBootLineFilter().push(Buffer.from(WARN_AUTOESCAPE + '\n')), [WARN_AUTOESCAPE]);
    });

    it('reads CRLF line endings and returns the entry without the carriage return', function () {
        var line = render('warn', 'windows line ending');
        assert.deepEqual(bl().createBootLineFilter().push(line + '\r\n'), [line]);
    });
});


// ---------------------------------------------------------------------------
// 10 — Source: the start.js wiring
// ---------------------------------------------------------------------------

describe('10 - start.js passes the boot lines on to its client', function () {

    var code = live(fs.readFileSync(START_PATH, 'utf8'));

    /**
     * The child stdout handler of start(), comment lines removed.
     * @returns {string}
     */
    function stdoutHandler() {
        var at = code.indexOf("child.stdout.on('data', function(data) {");
        assert.ok(at > -1, 'the child stdout handler was not found — the pins need updating');
        var end = code.indexOf("child.stderr.setEncoding('utf8');", at);
        assert.ok(end > at, 'the end of the stdout handler was not found — the pins need updating');
        return code.slice(at, end);
    }

    it('CONTROL — the handler still returns first thing once the bundle has started (runtime lines stay the tail\'s)', function () {
        var h = stdoutHandler();
        assert.ok(h.indexOf('if (isStarting) return;') > -1, 'guard present');
        assert.equal(h.indexOf('if (isStarting) return;'), h.indexOf('if ('), 'the guard is the first check');
    });

    it('requires the filter by a relative path (the bare lib/ form does not resolve in daemon scope)', function () {
        assert.match(code, /require\(\s*'\.\/inc\/boot-lines'\s*\)/);
    });

    it('creates one filter per spawned bundle, after the spawn and before the stdout handler', function () {
        var from = code.indexOf('var proceedToStart = function(nodeModulesErr)');
        var to   = code.indexOf('checkArchAgainstNodeModules(opt, proceedToStart);', from);
        assert.ok(from > -1 && to > from, 'proceedToStart not found — the pins need updating');
        var body = code.slice(from, to);
        var iSpawn   = body.indexOf('var child = spawn(');
        var iCreate  = body.indexOf('createBootLineFilter()');
        var iHandler = body.indexOf("child.stdout.on('data'");
        assert.ok(iCreate > -1, 'createBootLineFilter() is not called in proceedToStart');
        assert.ok(iSpawn < iCreate && iCreate < iHandler, 'spawn ' + iSpawn + ' < create ' + iCreate + ' < handler ' + iHandler);
    });

    it('pushes each chunk after the started guard and before the EADDRINUSE, emerg and started checks', function () {
        var h = stdoutHandler();
        var iGuard = h.indexOf('if (isStarting) return;');
        var iPush  = h.indexOf('bootLineFilter.push(data)');
        var iAddr  = h.indexOf('/EADDRINUSE.*port/i.test(data)');
        var iEmerg = h.indexOf('/(\\[|\\[\\s+)emerg/.test(data)');
        var iFlags = h.indexOf('data.match(checkCaseRe)');
        assert.ok(iPush > -1, 'the handler does not push its chunk to the filter');
        assert.ok(iAddr > -1 && iEmerg > -1 && iFlags > -1, 'the existing checks were not found — the pins need updating');
        assert.ok(iGuard < iPush, 'after the started guard');
        assert.ok(iPush < iAddr && iPush < iEmerg && iPush < iFlags, 'before the EADDRINUSE, emerg and started checks');
    });

    it('writes the entries to the client only while it is connected', function () {
        var h = stdoutHandler();
        var iPush = h.indexOf('bootLineFilter.push(data)');
        assert.ok(iPush > -1, 'the handler does not push its chunk to the filter');
        var region = h.slice(iPush, h.indexOf('/EADDRINUSE.*port/i.test(data)'));
        var iGuard = region.indexOf('!opt.client.destroyed');
        var iWrite = region.indexOf('opt.client.write(');
        assert.ok(iGuard > -1 && iWrite > -1, 'a guarded client write follows the push');
        assert.ok(iGuard < iWrite, 'the destroyed check comes before the write');
    });

    it('a fault in the filter cannot break a start: the push and the write sit in a try/catch', function () {
        var h = stdoutHandler();
        var iPush = h.indexOf('bootLineFilter.push(data)');
        assert.ok(iPush > -1, 'the handler does not push its chunk to the filter');
        var iTry   = h.lastIndexOf('try {', iPush);
        var iCatch = h.indexOf('} catch (', iPush);
        var iAddr  = h.indexOf('/EADDRINUSE.*port/i.test(data)');
        assert.ok(iTry > h.indexOf('if (isStarting) return;'), 'a try opens after the guard, before the push');
        assert.ok(iCatch > iPush && iCatch < iAddr, 'its catch closes before the EADDRINUSE check');
    });
});
