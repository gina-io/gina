/**
 * #B663 — `gina bundle:restart` runs `bundle:stop` then `bundle:start` from
 * argument vectors, without a shell.
 *
 * The handler joined the runtime and CLI script paths into one string, spliced
 * the bundle name, the project name and every inherited `--` flag into a command
 * line unquoted, chained the two commands with `&&`, and ran the line through
 * `sh` (`child_process.exec`). A CLI installed under a path containing a space
 * could not restart anything, and shell syntax in a flag ran. It now makes two
 * `execFile` calls — the start only once the stop has succeeded, as `&&` did —
 * with the script path, the names and each flag passed as separate arguments.
 *
 * Sections:
 *   01 — restart.js (comment-stripped source pins; the pre-existing guard pins
 *        live in bundle-restart.test.js)
 *   02 — replica of the argument assembly (locked to the source by 01)
 *   03 — the replica's two steps driven against a fake CLI under a path with a
 *        space: the arguments arrive whole, a failed stop skips the start, a
 *        failed start is reported. SUBTRACT — the pre-change command line fails
 *        on that path, and on a path without a space it runs shell syntax
 *        carried by a flag.
 *
 * Red-first: on the pre-change restart.js the 01 pins fail; 02 and 03 exercise
 * the replica and the pre-change line, and pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { execFile, exec } = require('child_process');
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');

var RAW = fs.readFileSync(path.join(require('../fw'), 'lib/cmd/bundle/restart.js'), 'utf8');
// comment-stripped handler source, so a pin never matches the kept pre-change lines
var SRC = RAW.split('\n').filter(function (l) {
    return !/^\s*(\/\/|\*|\/\*)/.test(l);
}).join('\n');

/**
 * The text from the first `start` to the first `end` after it.
 *
 * @inner
 * @param {string} src - Text to slice
 * @param {string} start - Opening anchor
 * @param {string} end - Closing anchor
 * @returns {string}
 */
function between(src, start, end) {
    var i = src.indexOf(start);
    assert.ok(i > -1, '`' + start + '` not found — test needs updating');
    var j = src.indexOf(end, i + start.length);
    assert.ok(j > -1, '`' + end + '` not found after `' + start + '`');
    return src.slice(i, j);
}


// ---------------------------------------------------------------------------
// 01 — source
// ---------------------------------------------------------------------------
describe('01 - bundle/restart.js starts its children without a shell (comment-stripped source)', function () {

    it('requires execFile, and neither requires nor calls exec', function () {
        assert.match(SRC, /require\('child_process'\)\.execFile;/);
        assert.equal(/require\('child_process'\)\.exec;/.test(SRC), false, 'exec is not required');
        assert.equal(/\bexec\(/.test(SRC), false, 'no exec( call');
    });

    it('keeps the runtime and CLI script paths as an argument pair, with no $gina command line', function () {
        assert.match(SRC, /self\.cliArgv\s*=\s*process\.argv\.splice\(0,\s*2\);/);
        assert.equal(SRC.indexOf("'$gina "), -1, 'no $gina placeholder');
        assert.equal(SRC.indexOf('.replace(/\\$(gina)/g'), -1, 'no string .replace of $gina');
    });

    it('the inherited flags stay a list (they are not joined into one string)', function () {
        var blk = between(SRC, 'var init = function', 'var restart = function');
        assert.ok(blk.indexOf('self.inheritedArgv.push(process.argv[i])') > -1, 'the flags are still collected');
        assert.equal(/self\.inheritedArgv\s*=\s*self\.inheritedArgv\.join\(/.test(blk), false, 'no join');
    });

    it('stop and start are two argument vectors, the flags going to start only', function () {
        var blk = between(SRC, 'var restart = function', 'var end = function');
        assert.match(blk, /var stopArgv\s*=\s*\[\s*self\.cliArgv\[1\]\s*,\s*'bundle:stop'\s*,\s*bundle\s*,\s*'@'\s*\+\s*self\.projectName\s*\];/);
        assert.match(blk, /var startArgv\s*=\s*\[\s*self\.cliArgv\[1\]\s*,\s*'bundle:start'\s*,\s*bundle\s*,\s*'@'\s*\+\s*self\.projectName\s*\]\.concat\(\s*self\.inheritedArgv\s*\);/);
        assert.match(blk, /startArgv\.push\(\s*'--inspect'\s*\+\s*\(\s*opt\.debugBrkEnabled\s*\?\s*'-brk'\s*:\s*''\s*\)\s*\+\s*'='\s*\+\s*opt\.debugPort\s*\)/);
    });

    it('start runs from the stop callback, after its error return', function () {
        var blk      = between(SRC, 'var restart = function', 'var end = function');
        var stopIdx  = blk.indexOf('execFile(self.cliArgv[0], stopArgv');
        var errIdx   = blk.indexOf('return onFailed(err)', stopIdx);
        var startIdx = blk.indexOf('execFile(self.cliArgv[0], startArgv');
        assert.ok(stopIdx > -1 && errIdx > -1 && startIdx > -1, 'the three anchors exist');
        assert.ok(stopIdx < errIdx && errIdx < startIdx, 'stop, then its error return, then start');
    });

    it('the pre-change lines survive only as comments (the strip is real)', function () {
        assert.ok(RAW.indexOf('exec(cmd, function(err, stdout, stderr)') > -1, 'kept as a comment');
        assert.equal(SRC.indexOf('exec(cmd, function(err, stdout, stderr)'), -1, 'not live');
    });
});


// ---------------------------------------------------------------------------
// 02 — replica of the argument assembly
// ---------------------------------------------------------------------------

/**
 * Mirror of the handler's argument assembly (locked to the source by 01).
 *
 * @inner
 * @param {string[]} cliArgv - [runtime path, CLI script path]
 * @param {string} bundle
 * @param {string} projectName
 * @param {string[]} inheritedArgv - The `--` flags the restart was given
 * @param {number} [debugPort]
 * @param {boolean} [debugBrkEnabled]
 * @returns {{ file: string, stop: string[], start: string[] }}
 */
function assemble(cliArgv, bundle, projectName, inheritedArgv, debugPort, debugBrkEnabled) {
    var stopArgv  = [cliArgv[1], 'bundle:stop', bundle, '@' + projectName];
    var startArgv = [cliArgv[1], 'bundle:start', bundle, '@' + projectName].concat(inheritedArgv);
    if (debugPort) {
        startArgv.push('--inspect' + (debugBrkEnabled ? '-brk' : '') + '=' + debugPort);
    }
    return { file: cliArgv[0], stop: stopArgv, start: startArgv };
}

describe('02 - replica: the argument assembly', function () {

    var CLI_ARGV = ['/opt/Node Runtime/bin/node', '/opt/My Tools/gina/bin/cli'];

    it('the runtime is the file to run; the CLI script is the first argument, whole', function () {
        var a = assemble(CLI_ARGV, 'api', 'shop', []);
        assert.equal(a.file, '/opt/Node Runtime/bin/node');
        assert.deepEqual(a.stop, ['/opt/My Tools/gina/bin/cli', 'bundle:stop', 'api', '@shop']);
        assert.deepEqual(a.start, ['/opt/My Tools/gina/bin/cli', 'bundle:start', 'api', '@shop']);
    });

    it('the inherited flags and the debug flag go to start only, each one argument', function () {
        var a = assemble(CLI_ARGV, 'api', 'shop', ['--max-old-space-size=2048', '--label=a b'], 9229);
        assert.deepEqual(a.stop, ['/opt/My Tools/gina/bin/cli', 'bundle:stop', 'api', '@shop']);
        assert.deepEqual(a.start.slice(4), ['--max-old-space-size=2048', '--label=a b', '--inspect=9229']);
    });

    it('--inspect-brk when the break flag is on, and no debug flag without a port', function () {
        assert.equal(assemble(CLI_ARGV, 'api', 'shop', [], 9229, true).start.pop(), '--inspect-brk=9229');
        assert.equal(assemble(CLI_ARGV, 'api', 'shop', []).start.length, 4);
    });
});


// ---------------------------------------------------------------------------
// 03 — the two steps, driven
// ---------------------------------------------------------------------------
var TMP      = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b663-restart-'));
var LOG      = path.join(TMP, 'calls.log');
var FAKE_SRC = [
    "var fs = require('fs');",
    "fs.appendFileSync(process.env.B663_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
    "process.stdout.write('ran ' + process.argv[2] + '\\n');",
    "process.exit(process.env.B663_FAIL === process.argv[2] ? 1 : 0);",
    ''
].join('\n');

/**
 * Write a fake CLI that records its arguments (one JSON line per call) and fails
 * the task named by B663_FAIL.
 *
 * @inner
 * @param {string} dir - Directory to create the fake `bin/cli` in
 * @returns {string} The fake CLI path
 */
function fakeCli(dir) {
    fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bin', 'cli'), FAKE_SRC);
    return path.join(dir, 'bin', 'cli');
}

var SPACED_CLI = fakeCli(path.join(TMP, 'My Gina'));
var PLAIN_CLI  = fakeCli(path.join(TMP, 'plain'));

after(function () {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});

/**
 * The calls the fake CLI recorded, oldest first; the log is then emptied.
 *
 * @inner
 * @returns {string[][]}
 */
function takeCalls() {
    if ( !fs.existsSync(LOG) ) return [];
    var calls = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
    fs.unlinkSync(LOG);
    return calls;
}

/**
 * The handler's two steps: stop, then start only once stop has succeeded.
 *
 * @inner
 * @param {{ file: string, stop: string[], start: string[] }} a - From assemble()
 * @param {object} env - Child environment
 * @param {function(?Error, string)} cb - The first error, and stdout of the steps that ran
 */
function runSteps(a, env, cb) {
    execFile(a.file, a.stop, { env: env }, function (err, stopOut) {
        if (err) return cb(err, stopOut || '');
        execFile(a.file, a.start, { env: env }, function (err2, startOut) {
            cb(err2 || null, (stopOut || '') + (startOut || ''));
        });
    });
}

/**
 * The environment for one drive.
 *
 * @inner
 * @param {string} [failTask] - The task the fake CLI fails
 * @returns {object}
 */
function driveEnv(failTask) {
    return Object.assign({}, process.env, { B663_LOG: LOG, B663_FAIL: failTask || '' });
}

describe('03 - the two steps, against a fake CLI under a path with a space', function () {

    it('each argument arrives whole, stop before start, and shell syntax in a flag stays text', function (t, done) {
        var marker = path.join(TMP, 'RAN-flag');
        var flags  = ['--label=a b', '--x=$(touch ' + marker + ')'];
        var a      = assemble([process.execPath, SPACED_CLI], 'api', 'shop', flags, 9229);
        runSteps(a, driveEnv(), function (err, out) {
            assert.equal(err, null, String(err));
            assert.deepEqual(takeCalls(), [
                ['bundle:stop', 'api', '@shop'],
                ['bundle:start', 'api', '@shop', '--label=a b', '--x=$(touch ' + marker + ')', '--inspect=9229']
            ]);
            assert.equal(out, 'ran bundle:stop\nran bundle:start\n');
            assert.equal(fs.existsSync(marker), false, 'the flag was not run as a command');
            done();
        });
    });

    it('a failed stop skips the start (what `&&` did)', function (t, done) {
        runSteps(assemble([process.execPath, SPACED_CLI], 'api', 'shop', []), driveEnv('bundle:stop'), function (err) {
            assert.ok(err, 'the failure is reported');
            assert.deepEqual(takeCalls(), [['bundle:stop', 'api', '@shop']], 'start never ran');
            done();
        });
    });

    it('a failed start is reported after the stop ran', function (t, done) {
        runSteps(assemble([process.execPath, SPACED_CLI], 'api', 'shop', []), driveEnv('bundle:start'), function (err) {
            assert.ok(err, 'the failure is reported');
            assert.deepEqual(takeCalls(), [['bundle:stop', 'api', '@shop'], ['bundle:start', 'api', '@shop']]);
            done();
        });
    });

    /**
     * The pre-change command line for a script path and inherited flags.
     *
     * @inner
     * @param {string} cliPath
     * @param {string[]} flags
     * @returns {string}
     */
    function preChangeLine(cliPath, flags) {
        var cmd = '$gina bundle:stop api @shop && $gina bundle:start api @shop';
        if (flags.length) cmd += ' ' + flags.join(' ');
        return cmd.replace(/\$(gina)/g, [process.execPath, cliPath].join(' '));
    }

    it('SUBTRACT: the pre-change command line fails on the path with a space, and never reaches the CLI', function (t, done) {
        exec(preChangeLine(SPACED_CLI, []), { env: driveEnv() }, function (err) {
            assert.ok(err, 'the shell line failed');
            assert.deepEqual(takeCalls(), [], 'the CLI never ran');
            done();
        });
    });

    it('SUBTRACT: on a path without a space, the pre-change command line runs shell syntax carried by a flag', function (t, done) {
        var marker = path.join(TMP, 'RAN-pre-change');
        exec(preChangeLine(PLAIN_CLI, ['--x=$(touch ' + marker + ')']), { env: driveEnv() }, function (err) {
            assert.equal(err, null, String(err));
            takeCalls();
            assert.equal(fs.existsSync(marker), true, 'the flag ran as a command');
            done();
        });
    });
});
