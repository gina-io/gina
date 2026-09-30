/**
 * bin/gina — the `--restart-pid` handling is removed (#B689).
 *
 * bin/gina filtered a `--restart-pid=<pid>` flag out of process.argv and, when the flag was set,
 * wrote `[ quit ]` once the daemon child reported ready: a handshake for framework:restart's
 * METHOD #1 (a detached `gina start --restart-pid=<pid>`), whose one call was commented out and
 * which #B665 S1 removed. Nothing reads `[ quit ]`. The filter reset its index to null after its
 * search loop, so the splice removed argv[0] (the runtime path) instead of the flag:
 * `start --restart-pid=N` spawned the daemon child without `start`, and any other command
 * reached bin/cli shifted by one. The handling is removed; a typed `--restart-pid` is passed on
 * like any other flag.
 *
 * Sections:
 *   01 — driven: the real bin/gina bytes, copied into a temp tree whose bin/cli is a stub that
 *        prints the argv it receives (required in-process for most commands, spawned as the
 *        daemon child for `start`). The flag arms fail on the pre-change bytes; the no-flag arms
 *        are controls that pass on both.
 *   02 — comment-stripped source pins, with controls on the raw text and on the strip itself.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var REPO        = path.resolve(__dirname, '..', '..');
var GINA_SOURCE = path.join(REPO, 'bin', 'gina');
var ginaSrc     = fs.readFileSync(GINA_SOURCE, 'utf8');

/**
 * Source of the stub installed as bin/cli in the temp tree. Required in-process (every command
 * but `start`), it prints the parent's argv. Spawned as the daemon child (`start`), it prints
 * its own argv, then the ready line, so bin/gina's start path runs to its end like a real start.
 *
 * @constant
 * @type {string}
 */
var CLI_STUB = [
    "var spawned = (require.main === module);",
    "process.stdout.write('ARGV ' + JSON.stringify({ mode: spawned ? 'spawned' : 'required', argv: process.argv }) + '\\n');",
    "if (spawned) process.stdout.write('Framework ready for connections\\n');",
    ""
].join('\n');

/** @type {?string} Temp tree root. */
var TMP  = null;
/** @type {?string} The copy of bin/gina under test. */
var GINA = null;

/**
 * Runs the copied bin/gina with `args` and parses the stub's ARGV line.
 *
 * @inner
 * @param {string[]} args - Command-line arguments after the script path
 * @returns {{status: ?number, stdout: string, stderr: string, lines: string[], seen: ?{mode: string, argv: string[]}}}
 *
 * @example
 * var r = run(['bundle:list', '@proj']);
 * r.seen.argv.slice(2); // ['bundle:list', '@proj']
 */
function run(args) {
    var r = spawnSync(process.execPath, [GINA].concat(args), { cwd: TMP, encoding: 'utf8', timeout: 30000 });
    var stdout = r.stdout || '';
    var lines  = stdout.split('\n');
    var seen   = null;
    lines.forEach(function (l) {
        if (l.indexOf('ARGV ') === 0) seen = JSON.parse(l.slice(5));
    });
    return { status: r.status, stdout: stdout, stderr: r.stderr || '', lines: lines, seen: seen };
}

before(function () {
    TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b689-'));
    GINA = path.join(TMP, 'bin', 'gina');
    fs.mkdirSync(path.join(TMP, 'bin'));
    fs.mkdirSync(path.join(TMP, 'utils'));
    fs.copyFileSync(GINA_SOURCE, GINA);
    fs.writeFileSync(path.join(TMP, 'bin', 'cli'), CLI_STUB);
    fs.writeFileSync(path.join(TMP, 'utils', 'runtime.js'),
        'module.exports = require(' + JSON.stringify(path.join(REPO, 'utils', 'runtime.js')) + ');\n');
});

after(function () {
    if (TMP) fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — driven: the argv bin/gina hands on
// ---------------------------------------------------------------------------
describe('01 - bin/gina: a --restart-pid flag no longer eats the command (driven, real bin/gina bytes)', function () {

    it('01.1 a non-start command reaches bin/cli whole, and the flag is passed on as an argument', function () {
        var r = run(['bundle:list', '@proj', '--restart-pid=4242']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.seen, 'the stub printed no ARGV line: ' + r.stdout);
        assert.equal(r.seen.mode, 'required');
        assert.equal(r.seen.argv[0], process.execPath, 'argv[0] must stay the runtime path');
        assert.deepEqual(r.seen.argv.slice(2), ['bundle:list', '@proj', '--restart-pid=4242']);
    });

    it('01.2 `start` keeps its task in the daemon child, and no `[ quit ]` is written', function () {
        var r = run(['start', '--restart-pid=4242']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.seen, 'the stub printed no ARGV line: ' + r.stdout);
        assert.equal(r.seen.mode, 'spawned', 'the start path spawns the daemon child');
        assert.deepEqual(r.seen.argv.slice(2, 4), ['start', '--restart-pid=4242']);
        assert.match(r.seen.argv[4] || '', /^--fake-daemon-pid=\d+$/);
        // positive evidence the ready branch ran, so the absence below is not vacuous
        assert.match(r.stdout, /Gina server started with PID/, 'the ready branch did not run');
        assert.ok(r.lines.indexOf('[ quit ]') < 0, 'no `[ quit ]` line may be written: ' + r.stdout);
    });

    it('01.3 CONTROL - without the flag, a non-start command reaches bin/cli whole', function () {
        var r = run(['bundle:list', '@proj']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.seen, 'the stub printed no ARGV line: ' + r.stdout);
        assert.equal(r.seen.mode, 'required');
        assert.equal(r.seen.argv[0], process.execPath);
        assert.deepEqual(r.seen.argv.slice(2), ['bundle:list', '@proj']);
    });

    it('01.4 CONTROL - without the flag, `start` spawns the daemon child with its task and writes no `[ quit ]`', function () {
        var r = run(['start']);
        assert.equal(r.status, 0, r.stderr);
        assert.ok(r.seen, 'the stub printed no ARGV line: ' + r.stdout);
        assert.equal(r.seen.mode, 'spawned');
        assert.deepEqual(r.seen.argv.slice(2, 3), ['start']);
        assert.match(r.stdout, /Gina server started with PID/);
        assert.ok(r.lines.indexOf('[ quit ]') < 0);
    });
});


// ---------------------------------------------------------------------------
// 02 — source pins
// ---------------------------------------------------------------------------
/**
 * bin/gina without its block comments and `//` line comments (bin/gina holds no `//` or `/*`
 * inside a string), so a pin never matches the #B689 note.
 *
 * @inner
 * @param {string} src - bin/gina source
 * @returns {string}
 */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map(function (l) { return l.replace(/\/\/.*$/, ''); })
        .join('\n');
}

describe('02 - bin/gina: the --restart-pid filter and the `[ quit ]` write are gone (source)', function () {

    var CODE = code(ginaSrc);

    it('02.1 no restartPid state is left in the code', function () {
        assert.ok(CODE.indexOf('restartPid') < 0, 'restartPid must not appear outside comments');
    });

    it('02.2 no --restart-pid token is matched or spliced in the code', function () {
        assert.doesNotMatch(CODE, /restart\\?-pid/, '--restart-pid must not appear outside comments');
    });

    it('02.3 no `[ quit ]` line is written', function () {
        assert.ok(CODE.indexOf('[ quit ]') < 0, '`[ quit ]` must not appear outside comments');
    });

    it('02.4 CONTROL - the raw source still names --restart-pid (the strip is what makes 02.2 meaningful)', function () {
        assert.ok(ginaSrc.indexOf('--restart-pid') > -1, 'the raw source must still carry the #B689 note');
    });

    it('02.5 CONTROL - the strip keeps the code (a strip that emptied the file would pass 02.1-02.3)', function () {
        assert.ok(CODE.indexOf('function runCMD()') > -1, 'runCMD must survive the strip');
        assert.ok(CODE.indexOf('require(cliBin);') > -1, 'the require(cliBin) hand-off must survive the strip');
        assert.ok(CODE.indexOf('spawn(nodeBin, argv') > -1, 'the daemon spawn must survive the strip');
    });
});
