/**
 * #B1133 — real-bytes boot: a route with no `param` block stops the boot with
 * an error that names the route, instead of an opaque TypeError.
 *
 * `param.control` is required (the routing guide's Route fields). config.js's
 * default-hostname test reads `routing[rule].param.control` for a route whose
 * `hostname` is absent or empty, so a route with no `param` (or `"param": null`)
 * stopped the boot with an uncaughtException « TypeError: Cannot read properties
 * of undefined (reading 'control') » at loadBundleConfig, exit 143, naming
 * neither the route nor the block. The fix refuses that shape by name, as a bad
 * requirement is refused: « [<rule>@<bundle>] Bad routing syntax: the route has
 * no `param` block; `param.control` is required », on stderr, exit 1. A route
 * with a truthy `hostname` never reached the read and still boots, and so does a
 * `param` without `control`, which the router answers per request.
 *
 * This file boots the REAL `bin/gina-container` against a scaffolded project
 * whose `src/<bundle>/config/routing.json` is rewritten per arm (the scaffold's
 * own routes, `$schema` included, plus the arm's route), and observes the
 * process the way a launcher does: its exit code, its piped stderr, and whether
 * the bundle port ever opens. Six boots:
 *
 *   1. a route with no `param`                     → exit 1, the named error on
 *                                                     stderr, the port never opens
 *   2. `"param": null`                             → same
 *   3. no `param`, `"hostname": ""`                → same
 *   4. no `param`, a truthy `hostname` (CONTROL)   → boots, GET 200
 *   5. `"param": {}` (CONTROL)                     → boots, GET 200
 *   6. the scaffold's own table (CONTROL)          → boots, GET 200
 *
 * Pre-fix (measured 2026-11-15 on develop d63836009 through a booted driver),
 * arms 1–3 exit 143 with the TypeError and no named error: that is this file's
 * red-first signature. Arms 4–6 boot before and after the fix.
 *
 * §01 pins the guard in config.js (comment-stripped, with a raw-text control).
 *
 * Isolation: the container-boot.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14750; the other container-boot files use
 * windows up to 14700 and the suite runs files in parallel), project:rm + rmSync
 * at teardown. The real ~/.gina is never touched. Module-path seam:
 * `B1133_GINA_ROOT=<tree>` boots THAT tree's launcher against a project
 * scaffolded by THAT tree's CLI and pins THAT tree's config.js, so the same file
 * runs against a pre-fix checkout with zero shared-tree touch.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-route-without-param-b1133.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rp-home-' + STAMP);   // $HOME override → <FAKE_HOME>/.gina
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rp' + STAMP;                                       // valid [a-z0-9_.]+ project name
var BUNDLE     = 'demo';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14750;                                              // own window — see the header

var BOOT_TIMEOUT_MS  = 25000;   // bounded wait for an exit OR an open port
var POLL_INTERVAL_MS = 250;

var GINA_ROOT  = process.env.B1133_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI        = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER  = path.join(GINA_ROOT, 'bin', 'gina-container');
var CONFIG_SRC = path.join(GINA_ROOT, 'framework', 'v' + require(path.join(GINA_ROOT, 'package.json')).version, 'core', 'config.js');

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
var ROUTING     = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
var BASE_ROUTES = null;   // the scaffold's own routing.json, read once
var current     = null;   // the boot in flight, for the after() net

var OLD_TYPE_ERROR = 'Cannot read properties of';   // the pre-fix uncaughtException, `undefined` or `null`


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

/** A scaffolded config file: full-line `//` comments dropped, then JSON. */
function readConfig(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n'));
}

/**
 * Comment-stripped source: a `//` comment preceded by nothing or by whitespace.
 *
 * @inner
 * @param {string} text
 * @returns {string}
 */
function code(text) {
    return text.split('\n').map(function(l) { return l.replace(/(^|\s)\/\/.*$/, ''); }).join('\n');
}

/**
 * Writes the scaffold's routes plus `extra` to the bundle's routing.json, boots
 * the bundle through the daemonless launcher and waits until the launcher EXITS
 * or the bundle PORT OPENS, bounded by BOOT_TIMEOUT_MS. The caller reads `exit`,
 * `portOpened` and both streams.
 *
 * @param {object} extra - Routes added to the scaffold's own (`{ <rule>: <route> }`)
 * @returns {Promise<{child:object, exit:object|null, portOpened:boolean, stdout:string, stderr:string}>}
 */
function boot(extra) {
    var table = JSON.parse(JSON.stringify(BASE_ROUTES));
    Object.keys(extra).forEach(function(k) { table[k] = extra[k]; });
    fs.writeFileSync(ROUTING, JSON.stringify(table, null, 2));
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

/** The refusal config.js writes for `<rule>@<bundle>`. */
function namedError(rule) {
    return '[' + rule + '@' + BUNDLE + '] Bad routing syntax: the route has no `param` block; `param.control` is required';
}

/** Arms 1–3: the boot stops with the named error, exit 1, the port never opens. */
async function assertRefused(extra, rule) {
    var out = await boot(extra);
    try {
        assert.ok(out.exit, 'the launcher must exit.\n' + diagnostics(out));
        assert.equal(out.exit.code, 1, 'exit code must be 1 — pre-fix it is 143, the uncaughtException path.\n' + diagnostics(out));
        assert.equal(out.portOpened, false, 'the port must never open');
        assert.ok(out.stderr.indexOf(namedError(rule)) > -1,
            'the named error must reach the piped stderr (the synchronous flush).\n' + diagnostics(out));
        assert.ok((out.stdout + out.stderr).indexOf(OLD_TYPE_ERROR) < 0,
            'no opaque TypeError any more.\n' + diagnostics(out));
    } finally { await teardown(out); }
}

/** Arms 4–6: the bundle boots and serves the scaffold's homepage. */
async function assertBoots(extra) {
    var out = await boot(extra);
    try {
        assert.equal(out.portOpened, true, 'the port must open.\n' + diagnostics(out));
        assert.ok(isChildAlive(out.child), 'the process must stay up.\n' + diagnostics(out));
        var res = await httpGet(scheme, bundlePort, webroot);
        assert.equal(res.status, 200, 'the bundle must serve.\n' + diagnostics(out));
        assert.ok(res.body.indexOf('Hello World') > -1, 'expected the scaffold greeting; first 200 chars: ' + res.body.substring(0, 200));
        assert.ok((out.stdout + out.stderr).indexOf('Bad routing syntax') < 0, 'no refusal on a boot that must pass.\n' + diagnostics(out));
    } finally { await teardown(out); }
}


// ---------------------------------------------------------------------------
// §01 — source pins
// ---------------------------------------------------------------------------

describe('#B1133 §01 — config.js refuses a route with no `param` block by name, before the default-hostname test reads it', function() {

    var RAW  = fs.readFileSync(CONFIG_SRC, 'utf8');
    var CODE = code(RAW);

    it('the guard sits in the route loop, before the default-hostname test reads `param.control`', function() {
        var loopAt  = CODE.indexOf("if (typeof(routing[rule]) != 'object' || routing[rule] === null) continue;");
        var guardAt = CODE.indexOf("( typeof(routing[rule].param) == 'undefined' || routing[rule].param === null )");
        var readAt  = CODE.indexOf('&& !/^redirect$/.test(routing[rule].param.control)', loopAt);
        assert.ok(loopAt > -1, 'extraction control: the route loop\'s non-object skip must exist');
        assert.ok(guardAt > loopAt, 'the guard must exist inside the route loop');
        assert.ok(readAt > guardAt, 'the guard must precede the first `param.control` read');
        var hostAt = CODE.indexOf('&& !routing[rule].hostname', guardAt);
        assert.ok(hostAt > guardAt && hostAt < readAt, 'only a route without a truthy `hostname` reaches the read: the guard tests it too');
    });

    it('the refusal names the route and the block, and flushes stderr before exiting 1', function() {
        var guardAt = CODE.indexOf("( typeof(routing[rule].param) == 'undefined' || routing[rule].param === null )");
        assert.ok(guardAt > -1, 'the guard must exist');
        var exitAt = CODE.indexOf('process.exit(1);', guardAt);
        assert.ok(exitAt > guardAt, 'the guard must end in process.exit(1)');
        var branch = CODE.substring(guardAt, exitAt);
        assert.ok(branch.indexOf("'] Bad routing syntax: the route has no `param` block; `param.control` is required'") > -1, 'the message');
        assert.ok(branch.indexOf("( !/\\@/.test(rule) ) ? rule +'@'+ bundle : rule") > -1, 'the route named `<rule>@<bundle>`');
        assert.ok(branch.indexOf('console.emerg(') > -1, 'logged at emerg level');
        assert.ok(branch.indexOf('fs.writeSync(2,') > -1, 'the reason must survive process.exit() on an async pipe');
    });

    it('CONTROL: the comment stripping is not vacuous (a comment of the route loop is in the raw text only)', function() {
        assert.ok(RAW.indexOf('// default hostname') > -1, 'the raw text must carry the comment');
        assert.equal(CODE.indexOf('// default hostname'), -1, 'the stripped text must not');
    });
});


// ---------------------------------------------------------------------------
// §02, §03 — boots
// ---------------------------------------------------------------------------

describe('#B1133 §02 / §03 — container-boot: a route with no `param` block (real bytes)', function() {

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
        if (!fs.existsSync(ROUTING)) { setupError = 'bundle routing.json not scaffolded: ' + ROUTING; return; }

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

        try { BASE_ROUTES = readConfig(ROUTING); } catch (e) { setupError = 'could not read the scaffold routing.json: ' + (e.message || e); return; }
        if (!BASE_ROUTES || typeof(BASE_ROUTES.homepage) != 'object') { setupError = 'the scaffold routing.json has no homepage route'; return; }

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

    it('§02.1 a route with no `param` exits 1 with the named error on stderr; the port never opens', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertRefused({ b1133np: { url: '/b1133/np' } }, 'b1133np');
    });

    it('§02.2 `"param": null` exits 1 with the named error', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertRefused({ b1133nl: { url: '/b1133/nl', param: null } }, 'b1133nl');
    });

    it('§02.3 no `param` and `"hostname": ""` exits 1 with the named error', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertRefused({ b1133nz: { url: '/b1133/nz', hostname: '' } }, 'b1133nz');
    });

    it('§03.1 CONTROL: no `param` with a truthy `hostname` never reached the read: the bundle boots and serves', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertBoots({ b1133nph: { url: '/b1133/nph', hostname: 'http://127.0.0.1:1' } });
    });

    it('§03.2 CONTROL: `"param": {}` boots (the router answers such a route per request)', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertBoots({ b1133empty: { url: '/b1133/empty', param: {} } });
    });

    it('§03.3 CONTROL: the scaffold\'s own table, `$schema` entry included, boots and serves', { timeout: BOOT_TIMEOUT_MS + 10000 }, async function(t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        await assertBoots({});
    });
});
