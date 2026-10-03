/**
 * #B759 — `gina start` returns a non-zero exit code when the framework ends before it is ready.
 *
 * bin/gina runs `start` / `framework:start` through runAsSubProcess(): it spawns bin/cli as a
 * detached daemon child, relays the child's output, and exits 0 once the child prints
 * « Framework ready for connections » or « Framework already running ». When the child ended
 * before either line, nothing relayed its exit code: the wrapper's event loop ran dry and
 * `gina start` exited 0 on a refused or failed start, and a child killed by a signal crashed the
 * wrapper on a `console.emerg` that does not exist there. The wrapper now waits until the
 * child's output is drained and exits with the child's code: 1 when that code is 0, and
 * 128 + the signal number when a signal ended it.
 *
 * Sections:
 *   01 — driven, the real tree: a GINA_VERSION that names no installed framework (the #B584
 *        refusal) through `gina start` exits 1, with the refusal relayed in full. Isolated home
 *        (the shape of test/bin/gina-version-refusal-b584.test.js); the refusal fires before
 *        the framework init, so no daemon starts.
 *   02 — driven, the real bin/gina bytes copied beside a scripted bin/cli (the shape of
 *        test/bin/gina-restart-pid-b689.test.js), one behaviour per arm. 02.1-02.4 fail on the
 *        pre-fix bytes; 02.5 and 02.6 are controls that pass on both.
 */
'use strict';

var fs     = require('fs');
var os     = require('os');
var net    = require('net');
var path   = require('path');
var { spawnSync } = require('child_process');
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');

var REPO        = path.resolve(__dirname, '..', '..');
var GINA_SOURCE = path.join(REPO, 'bin', 'gina');

var TMP     = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-start-exit-code-'));
var MQ_PORT = null;

/**
 * Source of the stub installed as bin/cli in the temp tree. bin/gina spawns it as the daemon
 * child for `start`; it does what `B759_STUB` names, writing synchronously so nothing it prints
 * is left in a buffer, and records its pid in `B759_STUB_PIDFILE` so the test can kill a child
 * that stays alive.
 *
 * @constant
 * @type {string}
 */
var CLI_STUB = [
    "var fs = require('fs');",
    "if (process.env.B759_STUB_PIDFILE) fs.writeFileSync(process.env.B759_STUB_PIDFILE, String(process.pid));",
    "var stayAlive = function () { setInterval(function () {}, 1000); };",
    "switch (process.env.B759_STUB) {",
    "    case 'exit3':     fs.writeSync(2, 'stub: failing before the ready line\\n'); process.exit(3); break;",
    "    case 'exit0':     process.exit(0); break;",
    "    case 'sigkill':   process.kill(process.pid, 'SIGKILL'); break;",
    "    case 'stderr200': for (var i = 0; i < 200; i++) fs.writeSync(2, 'stub line ' + i + '\\n'); process.exit(2); break;",
    "    case 'ready':     fs.writeSync(1, 'Framework ready for connections\\n'); stayAlive(); break;",
    "    case 'already':   fs.writeSync(1, 'Framework already running on port `8124`: [ 4242 ]\\n'); stayAlive(); break;",
    "    default:          fs.writeSync(2, 'stub: unknown B759_STUB ' + process.env.B759_STUB + '\\n'); process.exit(99);",
    "}",
    ""
].join('\n');

/** @type {?string} The copy of bin/gina under test (its bin/cli is the stub). */
var GINA = null;

/**
 * Finds a free TCP port on 127.0.0.1, so the real bin/cli (section 01) binds a private MQ port
 * instead of the default 8125 if it ever got that far.
 *
 * @inner
 * @returns {Promise<number>}
 *
 * @example
 * MQ_PORT = await freePort();
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
 * @param {number} pid
 * @returns {boolean}
 *
 * @example
 * isAlive(process.pid); // true
 */
function isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/**
 * Runs the copied bin/gina with `start`, its stub child doing what `mode` names.
 *
 * @inner
 * @param {string} mode - The stub behaviour (B759_STUB)
 * @returns {{status: ?number, signal: ?string, stdout: string, stderr: string, childPid: ?number}}
 *
 * @example
 * var r = runStub('exit3');
 * r.status; // 3
 */
function runStub(mode) {
    var pidFile = path.join(TMP, 'stub-' + mode + '.pid');
    var env = Object.assign({}, process.env, { B759_STUB: mode, B759_STUB_PIDFILE: pidFile });
    var r = spawnSync(process.execPath, [GINA, 'start'], { cwd: TMP, env: env, encoding: 'utf8', timeout: 30000 });
    var childPid = null;
    try { childPid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10) || null; } catch (e) { childPid = null; }
    return { status: r.status, signal: r.signal, stdout: r.stdout || '', stderr: r.stderr || '', childPid: childPid };
}

/**
 * @inner
 * @param {{status: ?number, stdout: string, stderr: string}} r
 * @returns {string} A diagnostic block for assertion messages
 */
function out(r) {
    return 'rc=' + r.status + '\n--- stdout\n' + r.stdout.slice(-1500) + '\n--- stderr\n' + r.stderr.slice(-1500);
}

/**
 * Kills a stub child that was told to stay alive.
 *
 * @inner
 * @param {?number} pid
 */
function reap(pid) {
    if (pid && isAlive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    }
}

before(async function () {
    MQ_PORT = await freePort();
    var tree = path.join(TMP, 'tree');
    GINA = path.join(tree, 'bin', 'gina');
    fs.mkdirSync(path.join(tree, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tree, 'utils'), { recursive: true });
    fs.copyFileSync(GINA_SOURCE, GINA);
    fs.writeFileSync(path.join(tree, 'bin', 'cli'), CLI_STUB);
    fs.writeFileSync(path.join(tree, 'utils', 'runtime.js'),
        'module.exports = require(' + JSON.stringify(path.join(REPO, 'utils', 'runtime.js')) + ');\n');
});

after(function () {
    fs.rmSync(TMP, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// 01 — the real tree: the #B584 refusal through `gina start`
// ---------------------------------------------------------------------------
describe('01 - gina start: the real refusal of an uninstalled GINA_VERSION exits 1', function () {

    it('01.1 GINA_VERSION=0.0.1 → exit 1, the refusal relayed in full', function () {
        var home = path.join(TMP, 'home-01');
        ['prefix', 'run', 'log', 'tmp'].forEach(function (d) {
            fs.mkdirSync(path.join(home, d), { recursive: true });
        });
        var env = Object.assign({}, process.env);
        Object.keys(env).forEach(function (k) { if (/^GINA_/.test(k)) delete env[k]; });
        delete env.NPM_CONFIG_PREFIX;
        delete env.npm_config_prefix;
        Object.assign(env, {
            HOME         : home,
            GINA_PREFIX  : path.join(home, 'prefix'),
            GINA_RUNDIR  : path.join(home, 'run'),
            GINA_LOGDIR  : path.join(home, 'log'),
            GINA_TMPDIR  : path.join(home, 'tmp'),
            GINA_MQ_PORT : String(MQ_PORT),
            GINA_VERSION : '0.0.1'
        });
        var r = spawnSync(process.execPath, [GINA_SOURCE, 'start'], { env: env, encoding: 'utf8', timeout: 60000 });
        r = { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
        assert.match(r.stderr, /framework version 0\.0\.1 is not installed/, 'the refusal did not run: ' + out(r));
        // the refusal's LAST line: everything the child printed was relayed before the exit
        assert.match(r.stderr, /env -u GINA_VERSION gina framework:add 0\.0\.1/, out(r));
        assert.equal(r.status, 1, out(r));
    });

});


// ---------------------------------------------------------------------------
// 02 — the real bin/gina bytes beside a scripted bin/cli
// ---------------------------------------------------------------------------
describe('02 - gina start: the daemon child ending before the ready line sets the exit code', function () {

    it('02.1 the child exits 3 before the ready line → exit 3', function () {
        var r = runStub('exit3');
        assert.match(r.stderr, /stub: failing before the ready line/, 'the child output was not relayed: ' + out(r));
        assert.equal(r.status, 3, out(r));
    });

    it('02.2 the child exits 0 before the ready line → exit 1, with a message', function () {
        var r = runStub('exit0');
        assert.match(r.stderr, /gina: the framework exited before it was ready \(exit code 0\)\./, out(r));
        assert.equal(r.status, 1, out(r));
    });

    it('02.3 the child is killed by SIGKILL before the ready line → exit 137, no TypeError', function () {
        var r = runStub('sigkill');
        assert.doesNotMatch(r.stderr, /TypeError/, 'the wrapper crashed: ' + out(r));
        assert.match(r.stderr, /gina: the framework was stopped by SIGKILL before it was ready\./, out(r));
        assert.equal(r.status, 137, out(r));
    });

    it('02.4 the child writes 200 stderr lines, then exits 2 → exit 2, every line relayed', function () {
        var r = runStub('stderr200');
        var relayed = (r.stderr.match(/^stub line \d+$/gm) || []).length;
        assert.equal(relayed, 200, 'lines relayed: ' + relayed + '\n' + out(r));
        assert.match(r.stderr, /stub line 199/, out(r));
        assert.equal(r.status, 2, out(r));
    });

    it('02.5 CONTROL - the child prints the ready line and stays alive → exit 0, without waiting for it', function () {
        var r = runStub('ready');
        try {
            assert.match(r.stdout, /Gina server started with PID/, 'the ready branch did not run: ' + out(r));
            assert.equal(r.status, 0, out(r));
            assert.ok(r.childPid, 'the stub recorded no pid');
            assert.ok(isAlive(r.childPid), 'the daemon child must outlive the wrapper');
        } finally {
            reap(r.childPid);
        }
    });

    it('02.6 CONTROL - the child reports the framework already running → exit 0', function () {
        var r = runStub('already');
        try {
            assert.match(r.stdout, /Gina server is already running with PID `4242`/, out(r));
            assert.equal(r.status, 0, out(r));
        } finally {
            reap(r.childPid);
        }
    });

});
