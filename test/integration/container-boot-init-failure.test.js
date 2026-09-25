/**
 * #B576 — real-bytes boot: a throw from `onInitialize` before 'complete'
 * exits the bundle with the reason, instead of leaving it alive but unbound.
 *
 * The unit file (test/core/gna-init-failure.test.js) pins the frame and runs a
 * replica; this one boots the REAL `bin/gina-container` against a scaffolded
 * project whose `src/<bundle>/index.js` is rewritten per arm, and observes the
 * process the way a launcher does: its exit code, its piped stderr, and whether
 * the bundle port ever opens. Four boots:
 *
 *   1. a synchronous throw before 'complete'      → exit 1, the reason on stderr,
 *                                                     the port never opens
 *   2. an async callback rejecting before 'complete' → same
 *   3. a throw after 'complete'                   → the port opens, the process
 *                                                     stays up, GET 200, the
 *                                                     after-complete line is logged
 *   4. a clean onInitialize (control)              → the port opens, GET 200,
 *                                                     no #B576 line at all
 *
 * Pre-fix (measured 2026-09-23 through the seam below), arm 1 and 2 never bind
 * and EXIT 0 — a success status — within about two seconds, the reason only an
 * error-level log line on stdout and stderr empty: that is this file's
 * red-first signature (exit code 0, not 1). A process kept running by some
 * other handle would linger unbound instead; the bounded wait reports that
 * shape as STILL RUNNING. Arm 3 and 4 hold pre-fix too (the after-'complete'
 * behaviour is deliberately unchanged), except arm 3's message text.
 *
 * Isolation: the container-boot.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (9800; container-boot uses 9700 and the
 * suite runs files in parallel), project:rm + rmSync at teardown. The real
 * ~/.gina is never touched. Module-path seam: `B576_GINA_ROOT=<tree>` boots
 * THAT tree's launcher against a project scaffolded by THAT tree's CLI, so the
 * same file runs against a pre-fix checkout with zero shared-tree touch.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-init-failure.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ib-home-' + STAMP);   // $HOME override → <FAKE_HOME>/.gina
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ib' + STAMP;                                       // valid [a-z0-9_.]+ project name
var BUNDLE     = 'demo';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 9800;                                              // own window — see the header

var BOOT_TIMEOUT_MS  = 25000;   // bounded wait for an exit OR an open port
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B576_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, {
    HOME           : FAKE_HOME,
    GINA_LOG_STDOUT: 'true'
});
delete CHILD_ENV.GINA_HOMEDIR;   // must derive from HOME, not inherit the dev's value

var skip        = false;
var skipReason  = '';
var setupError  = null;
var bundlePort  = null;
var scheme      = 'http';
var webroot     = '/' + BUNDLE + '/';
var ENTRY       = path.join(PROJ_DIR, 'src', BUNDLE, 'index.js');
var current     = null;   // the boot in flight, for the after() net


// ---------------------------------------------------------------------------
// Bundle entry-point variants (the scaffold's active shape: require, onError, start)
// ---------------------------------------------------------------------------

function entry(body) {
    return 'var demo = require(\'gina\');\n'
        + body + '\n'
        + 'demo.onError(function(err, req, res, next){ next(err); });\n'
        + 'demo.start();\n';
}

var ARM_THROW_BEFORE = entry(
    'demo.onInitialize(function(event, app, express){\n'
  + '    throw new Error(\'B576 boot-time failure\');\n'
  + '});');

var ARM_REJECT_BEFORE = entry(
    'demo.onInitialize(async function(event, app, express){\n'
  + '    await new Promise(function(r){ setTimeout(r, 50); });\n'
  + '    throw new Error(\'B576 async boot-time failure\');\n'
  + '});');

var ARM_THROW_AFTER = entry(
    'demo.onInitialize(function(event, app, express){\n'
  + '    event.emit(\'complete\', app);\n'
  + '    throw new Error(\'B576 after-complete failure\');\n'
  + '});');

var ARM_CLEAN = entry(
    'demo.onInitialize(function(event, app, express){\n'
  + '    event.emit(\'complete\', app);\n'
  + '});');


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function(resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function() { sock.destroy(); resolve(true);  });
        sock.on('error',   function() { resolve(false); });
        sock.on('timeout', function() { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

function httpGet(useScheme, port, reqPath) {
    var lib = (useScheme === 'https') ? https : http;
    return new Promise(function(resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: port, path: reqPath, method: 'GET', rejectUnauthorized: false
        }, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end',  function() { resolve({ status: res.statusCode, body: body }); });
        });
        req.on('error', function(e) { resolve({ status: null, err: e.message, body: '' }); });
        req.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

function isChildAlive(child) { return child && child.exitCode === null && child.signalCode === null; }

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * Writes the entry point, boots the bundle through the daemonless launcher and
 * waits until the launcher EXITS or the bundle PORT OPENS, bounded by
 * BOOT_TIMEOUT_MS. The caller reads `exit`, `portOpened` and both streams.
 *
 * @param {string} indexSource - Content written to src/<bundle>/index.js
 * @returns {Promise<{child:object, exit:object|null, portOpened:boolean, stdout:string, stderr:string}>}
 */
function boot(indexSource) {
    fs.writeFileSync(ENTRY, indexSource);
    var child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], {
        env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe']
    });
    var out = { child: child, exit: null, portOpened: false, stdout: '', stderr: '' };
    current = out;
    child.stdout.on('data', function(d) { out.stdout += d; });
    child.stderr.on('data', function(d) { out.stderr += d; });
    child.on('exit', function(code, signal) { out.exit = { code: code, signal: signal }; });
    return new Promise(function(resolve) {
        var deadline = Date.now() + BOOT_TIMEOUT_MS;
        (function poll() {
            if (out.exit) { return setTimeout(function() { resolve(out); }, 300); }   // let the streams flush
            isTcpPortOpen(bundlePort).then(function(open) {
                if (open) { out.portOpened = true; return setTimeout(function() { resolve(out); }, 300); }
                if (Date.now() >= deadline) { return resolve(out); }
                setTimeout(poll, POLL_INTERVAL_MS);
            });
        })();
    });
}

/** SIGTERM (drain + exit 143), then SIGKILL; waits for the exit so the port is free for the next arm. */
async function teardown(out) {
    if (!out) { return; }
    if (isChildAlive(out.child)) {
        try { out.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 4000;
        while (Date.now() < until && isChildAlive(out.child)) { await sleep(150); }
        if (isChildAlive(out.child)) { try { out.child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        until = Date.now() + 2000;
        while (Date.now() < until && isChildAlive(out.child)) { await sleep(100); }
    }
    var freeBy = Date.now() + 3000;
    while (Date.now() < freeBy && await isTcpPortOpen(bundlePort)) { await sleep(150); }
    if (current === out) { current = null; }
}

function diagnostics(out) {
    var state = out.exit ? '' : (out.portOpened ? ' (running, port open)' : ' (STILL RUNNING at the deadline, never bound)');
    return 'exit: ' + JSON.stringify(out.exit) + state
        + ' | portOpened: ' + out.portOpened + '\n'
        + 'stdout (' + out.stdout.length + ' bytes):\n' + (out.stdout || '(empty)') + '\n---\n'
        + 'stderr (' + out.stderr.length + ' bytes):\n' + (out.stderr || '(empty)');
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('21 - container-boot-init-failure — a throw from onInitialize before \'complete\' exits the bundle with the reason (#B576)', function() {

    before(function() {
        if (process.platform === 'win32') {
            skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)';
            return;
        }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) {
            setupError = 'project:add did not register @' + PROJ + ' in ' + projectsPath; return;
        }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) {
            setupError = 'bundle:add did not register ' + key + ' in ports.reverse.json'; return;
        }
        if (!fs.existsSync(ENTRY)) { setupError = 'bundle entry point not scaffolded: ' + ENTRY; return; }

        // The project must load the tree under test (the #B422 Franken-boot trap):
        // project:add links <proj>/node_modules/gina to the CLI's own root.
        var link = path.join(PROJ_DIR, 'node_modules', 'gina');
        try {
            var target = fs.realpathSync(link);
            if (target !== fs.realpathSync(GINA_ROOT)) {
                setupError = 'node_modules/gina resolves to ' + target + ', not the tree under test ' + GINA_ROOT; return;
            }
        } catch (e) {
            setupError = 'node_modules/gina is not linked in the scaffolded project: ' + (e.message || e); return;
        }

        var projects = readJSON(projectsPath), portsReverse = readJSON(portsReversePath);
        var pe = projects[PROJ], env = pe.def_env || 'dev', proto = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = portsReverse[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
    });

    after(async function() {
        await teardown(current);
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        // project:add may create an empty ~/.<project> on the REAL home even under
        // HOME isolation (boot-smoke recipes, 2026-07-30); the name is unique to this run.
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    it('1. a sync throw before \'complete\' exits 1 with the reason on stderr; the port never opens', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var out = await boot(ARM_THROW_BEFORE);
        try {
            assert.ok(out.exit, 'the launcher must exit.\n' + diagnostics(out));
            assert.equal(out.exit.code, 1, 'exit code must be 1 — pre-fix it is 0, a success status.\n' + diagnostics(out));
            assert.equal(out.portOpened, false, 'the port must never open');
            assert.match(out.stderr, /onInitialize threw before emitting 'complete' — aborting boot: Error: B576 boot-time failure/,
                'the reason must reach the piped stderr (the synchronous flush).\n' + diagnostics(out));
            assert.ok(out.stderr.indexOf(path.join('src', BUNDLE, 'index.js')) > -1,
                'the stack must name the application\'s own entry file.\n' + diagnostics(out));
        } finally { await teardown(out); }
    });

    it('2. an async callback rejecting before \'complete\' exits 1 with the reason on stderr', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var out = await boot(ARM_REJECT_BEFORE);
        try {
            assert.ok(out.exit, 'the launcher must exit — pre-fix the rejection only reaches the unhandledRejection net.\n' + diagnostics(out));
            assert.equal(out.exit.code, 1, 'exit code must be 1 — pre-fix it is 0, a success status.\n' + diagnostics(out));
            assert.equal(out.portOpened, false, 'the port must never open');
            assert.match(out.stderr, /onInitialize threw before emitting 'complete' — aborting boot: Error: B576 async boot-time failure/,
                'the reason must reach the piped stderr.\n' + diagnostics(out));
        } finally { await teardown(out); }
    });

    it('3. a throw after \'complete\' is logged and the bundle keeps starting: port open, GET 200', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var out = await boot(ARM_THROW_AFTER);
        try {
            assert.equal(out.portOpened, true, 'the port must open — the server start was already triggered.\n' + diagnostics(out));
            assert.ok(isChildAlive(out.child), 'the process must stay up.\n' + diagnostics(out));
            var res = await httpGet(scheme, bundlePort, webroot);
            assert.equal(res.status, 200, 'the bundle must serve.\n' + diagnostics(out));
            assert.ok((out.stdout + out.stderr).indexOf('onInitialize threw after emitting \'complete\'') > -1,
                'the after-complete line must be logged (error level, no exit).\n' + diagnostics(out));
            assert.ok((out.stdout + out.stderr).indexOf('aborting boot') < 0, 'no fatal line for an after-complete throw');
        } finally { await teardown(out); }
    });

    it('4. CONTROL: a clean onInitialize boots — port open, GET 200 with the greeting, no #B576 line', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var out = await boot(ARM_CLEAN);
        try {
            assert.equal(out.portOpened, true, 'the port must open.\n' + diagnostics(out));
            assert.ok(isChildAlive(out.child), 'the process must stay up.\n' + diagnostics(out));
            var res = await httpGet(scheme, bundlePort, webroot);
            assert.equal(res.status, 200, 'the bundle must serve.\n' + diagnostics(out));
            assert.ok(res.body.indexOf('Hello World') > -1, 'expected the scaffold greeting; first 200 chars: ' + res.body.substring(0, 200));
            assert.ok((out.stdout + out.stderr).indexOf('onInitialize threw') < 0, 'no #B576 line on a clean boot.\n' + diagnostics(out));
        } finally { await teardown(out); }
    });
});
