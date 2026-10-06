/**
 * #B764 — `gina start --inspect-gina` returns the framework's own exit code.
 *
 * With `--inspect-gina`, bin/gina spawns bin/cli-debug instead of bin/cli, and bin/cli-debug
 * spawns bin/cli under `--inspect-brk`. bin/gina reads the code of the process it spawned as
 * the framework's (#B759), but bin/cli-debug relayed its child's output only: once the
 * framework ended, its event loop ran dry and it exited 0. A framework that exited 3 or was
 * killed before it was ready therefore gave `gina start --inspect-gina` the exit code 1 and
 * « (exit code 0) », the code of bin/cli-debug. bin/cli-debug now ends with the framework's
 * code, and with 128 + the signal number when a signal ended it.
 *
 * Under `--inspect-brk` a framework waits for a debugger before it runs any code. The real
 * bin/cli-debug and bin/gina bytes are copied beside a scripted bin/cli (the shape of
 * test/bin/gina-start-exit-code-b759.test.js), and a stand-in `node` first on PATH drops the
 * leading `--inspect-brk=…` argument, so the scripted bin/cli runs at once.
 *
 * Sections:
 *   01 — bin/cli-debug alone: its exit code is the framework's. 01.1 and 01.2 fail on the
 *        pre-fix bytes; 01.3 is a control that passes on both.
 *   02 — `gina start --inspect-gina` through bin/gina. 02.1 and 02.2 fail on the pre-fix
 *        bytes; 02.3 and 02.4 are controls that pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var net    = require('net');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var REPO = path.resolve(__dirname, '..', '..');

/**
 * The stand-in `node` and the copied bin/ scripts are POSIX-only, and under Bun bin/gina and
 * bin/cli-debug spawn the Bun binary rather than the `node` found on PATH.
 *
 * @constant
 * @type {(string|boolean)}
 */
var SKIP = (process.platform === 'win32')
    ? 'the stand-in node is a POSIX shell script'
    : ((typeof Bun !== 'undefined') ? 'under Bun, bin/gina and bin/cli-debug spawn the Bun binary, not the node on PATH' : false);

var TMP  = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-debug-exit-code-'));
var TREE = path.join(TMP, 'tree');
var HOME = path.join(TMP, 'home');
var FAKE = path.join(TMP, 'fakebin');

/**
 * Source of the stub installed as bin/cli in the temp tree: bin/cli-debug spawns it as the
 * framework. It does what `B764_STUB` names, writing synchronously, and records its pid in
 * `B764_STUB_PIDFILE` so a stub that stays alive can be killed.
 *
 * @constant
 * @type {string}
 */
var CLI_STUB = [
    "var fs = require('fs');",
    "if (process.env.B764_STUB_PIDFILE) fs.writeFileSync(process.env.B764_STUB_PIDFILE, String(process.pid));",
    "switch (process.env.B764_STUB) {",
    "    case 'exit3':   fs.writeSync(2, 'stub: failing before the ready line\\n'); process.exit(3); break;",
    "    case 'exit0':   process.exit(0); break;",
    "    case 'sigkill': process.kill(process.pid, 'SIGKILL'); break;",
    "    case 'ready':   fs.writeSync(1, 'Framework ready for connections\\n'); setInterval(function () {}, 1000); break;",
    "    default:        fs.writeSync(2, 'stub: unknown B764_STUB ' + process.env.B764_STUB + '\\n'); process.exit(99);",
    "}",
    ""
].join('\n');

/**
 * Finds a free TCP port on 127.0.0.1 for the `debug_port` setting (the stand-in node drops the
 * flag that would bind it, so nothing listens on it).
 *
 * @inner
 * @returns {Promise<number>}
 *
 * @example
 * var port = await freePort();
 */
function freePort() {
    return new Promise(function (resolve, reject) {
        var srv = net.createServer();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port;
            srv.close(function () { resolve(port); });
        });
    });
}

/**
 * Tells whether a process is alive.
 *
 * @inner
 * @param {?number} pid
 * @returns {boolean}
 *
 * @example
 * isAlive(process.pid); // true
 */
function isAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/**
 * Kills a process that was told to stay alive.
 *
 * @inner
 * @param {?number} pid
 */
function reap(pid) {
    if (isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
}

/**
 * Runs one copied script with its stub framework doing what `mode` names. The stand-in `node`
 * is first on PATH and HOME is the temp home, so bin/cli-debug reads the temp settings.
 *
 * @inner
 * @param {string} script - `cli-debug` or `gina`
 * @param {string[]} args
 * @param {string} mode - The stub behaviour (B764_STUB)
 * @returns {{status: ?number, signal: ?string, stdout: string, stderr: string, stubPid: ?number}}
 *
 * @example
 * var r = run('cli-debug', ['start'], 'exit3');
 * r.status; // 3
 */
function run(script, args, mode) {
    var pidFile = path.join(TMP, 'stub-' + script + '-' + mode + '.pid');
    var env = Object.assign({}, process.env, {
        HOME              : HOME,
        PATH              : FAKE + path.delimiter + (process.env.PATH || ''),
        B764_STUB         : mode,
        B764_STUB_PIDFILE : pidFile
    });
    delete env.NODE_OPTIONS;
    var r = spawnSync(process.execPath, [path.join(TREE, 'bin', script)].concat(args), { cwd: TMP, env: env, encoding: 'utf8', timeout: 30000 });
    var stubPid = null;
    try { stubPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10) || null; } catch (e) { stubPid = null; }
    return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', stubPid: stubPid };
}

/**
 * @inner
 * @param {{status: ?number, signal: ?string, stdout: string, stderr: string}} r
 * @returns {string} A diagnostic block for assertion messages
 */
function out(r) {
    return 'rc=' + r.status + ' signal=' + r.signal + '\n--- stdout\n' + r.stdout.slice(-1500) + '\n--- stderr\n' + r.stderr.slice(-1500);
}

before(async function () {
    if (SKIP) return;
    fs.mkdirSync(path.join(TREE, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(TREE, 'utils'), { recursive: true });
    fs.copyFileSync(path.join(REPO, 'bin', 'cli-debug'), path.join(TREE, 'bin', 'cli-debug'));
    fs.copyFileSync(path.join(REPO, 'bin', 'gina'), path.join(TREE, 'bin', 'gina'));
    fs.writeFileSync(path.join(TREE, 'bin', 'cli'), CLI_STUB);
    fs.writeFileSync(path.join(TREE, 'utils', 'runtime.js'),
        'module.exports = require(' + JSON.stringify(path.join(REPO, 'utils', 'runtime.js')) + ');\n');
    // bin/cli-debug reads ~/.gina/main.json for the version, then <short>/settings.json for debug_port
    fs.mkdirSync(path.join(HOME, '.gina', '9.9'), { recursive: true });
    fs.writeFileSync(path.join(HOME, '.gina', 'main.json'), JSON.stringify({ def_framework: '9.9.9' }));
    fs.writeFileSync(path.join(HOME, '.gina', '9.9', 'settings.json'), JSON.stringify({ debug_port: await freePort() }));
    // the stand-in node: drops the --inspect-brk=… that bin/cli-debug puts first, runs the rest
    fs.mkdirSync(FAKE, { recursive: true });
    fs.writeFileSync(path.join(FAKE, 'node'),
        '#!/bin/sh\ncase "$1" in --inspect*) shift ;; esac\nexec ' + JSON.stringify(process.execPath) + ' "$@"\n', { mode: 0o755 });
});

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — bin/cli-debug alone
// ---------------------------------------------------------------------------
describe('01 - bin/cli-debug ends with the code of the framework it started', { skip: SKIP }, function () {

    it('01.1 the framework exits 3 → bin/cli-debug exits 3, the framework output relayed', function () {
        var r = run('cli-debug', ['start'], 'exit3');
        assert.match(r.stdout, /\[debugger\]stub: failing before the ready line/, 'the stub did not run: ' + out(r));
        assert.equal(r.status, 3, out(r));
    });

    it('01.2 the framework is killed by SIGKILL → bin/cli-debug exits 137', function () {
        var r = run('cli-debug', ['start'], 'sigkill');
        assert.ok(r.stubPid, 'the stub did not run: ' + out(r));
        assert.equal(r.status, 137, out(r));
    });

    it('01.3 CONTROL - the framework exits 0 → bin/cli-debug exits 0', function () {
        var r = run('cli-debug', ['start'], 'exit0');
        assert.ok(r.stubPid, 'the stub did not run: ' + out(r));
        assert.equal(r.status, 0, out(r));
    });

});


// ---------------------------------------------------------------------------
// 02 — gina start --inspect-gina, through bin/gina
// ---------------------------------------------------------------------------
describe('02 - gina start --inspect-gina returns the framework\'s exit code', { skip: SKIP }, function () {

    it('02.1 the framework exits 3 before it is ready → exit 3', function () {
        var r = run('gina', ['start', '--inspect-gina'], 'exit3');
        assert.match(r.stdout, /\[debugger\]stub: failing before the ready line/, 'the framework output was not relayed: ' + out(r));
        assert.doesNotMatch(r.stderr, /exit code 0/, out(r));
        assert.equal(r.status, 3, out(r));
    });

    it('02.2 the framework is killed by SIGKILL before it is ready → exit 137', function () {
        var r = run('gina', ['start', '--inspect-gina'], 'sigkill');
        assert.ok(r.stubPid, 'the stub did not run: ' + out(r));
        assert.doesNotMatch(r.stderr, /exit code 0/, out(r));
        assert.equal(r.status, 137, out(r));
    });

    it('02.3 CONTROL - the framework exits 0 before it is ready → exit 1, with the #B759 message', function () {
        var r = run('gina', ['start', '--inspect-gina'], 'exit0');
        assert.match(r.stderr, /gina: the framework exited before it was ready \(exit code 0\)\./, out(r));
        assert.equal(r.status, 1, out(r));
    });

    it('02.4 CONTROL - the framework prints the ready line and stays alive → exit 0, the framework alive', function () {
        var r = run('gina', ['start', '--inspect-gina'], 'ready');
        var m = r.stdout.match(/Gina server started with PID `(\d+)`/);
        var debugPid = m ? parseInt(m[1], 10) : null;
        try {
            assert.ok(m, 'the ready branch did not run: ' + out(r));
            assert.equal(r.status, 0, out(r));
            assert.ok(isAlive(r.stubPid), 'the framework must outlive the wrapper');
        } finally {
            reap(r.stubPid);
            reap(debugPid);
        }
    });

});
