/**
 * #B707 — on the isaac engine, one GET of the client routing map spelled in another letter case no
 * longer ends the bundle, through a booted bundle.
 *
 * The defect: isaac's routing-map fast path accepted `/_gina/assets/Routing.json` (a
 * case-insensitive test) and then looked the asset up by that spelling with an exact-match
 * `findOne`; the asset is registered as `routing.json`, so the lookup found nothing and the
 * `localAsset.mime` read threw — an uncaughtException that ended the process (measured on
 * 2026-09-30: exit 143, the next request refused). The fix lower-cases the looked-up name.
 *
 * Instrument — which layer answered: core/server.js sets `X-Request-Id` on every response it
 * writes; isaac's own handlers never do, so a 200 without the header came from isaac's fast path.
 * Liveness is read from the launcher child itself (it must not have exited) and from a health
 * check after the mixed-case requests.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine, the default
 * http/1.1 protocol — on a bundle scaffolded by bundle:add + view:add, called by a direct loopback
 * client, so the request is not classified as proxied):
 *   00.1  control — the lowercase routing map under the webroot: 200, JSON, from isaac's fast path
 *   00.2  `Routing.json` under the webroot: 200 with the same table, and the bundle still runs
 *   00.3  `ROUTING.JSON?x=1` at the root: 200 with the same table, and the bundle still runs
 *   00.4  the health check still answers after both, and the launcher has not exited
 *
 * Isolation: the b717 live test's shape — a throwaway HOME under os.tmpdir(), its own port window
 * (11100), project:rm + rmSync at teardown. Seam: `B707_GINA_ROOT=<tree>` boots THAT tree's launcher
 * against a project scaffolded by THAT tree's CLI (red-first: point it at a tree without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-routing-case-b707.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b707-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rc' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11100;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B707_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var controlBody = null;


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function (resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function () { sock.destroy(); resolve(true); });
        sock.on('error',   function () { resolve(false); });
        sock.on('timeout', function () { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * One direct HTTP/1.1 GET on a fresh connection to the bundle: node sends
 * `Host: 127.0.0.1:<port>` and no forwarding header — a direct loopback client.
 */
function direct(absPath) {
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: 'GET', agent: false }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
            });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, headers: {}, err: e.message, body: '', json: null }); });
        req.end();
    });
}

function show(r) {
    return JSON.stringify({ status: r.status, err: r.err, xRequestId: (r.headers || {})['x-request-id'], body: (r.body || '').slice(0, 160) });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

async function assertStillRunning(label) {
    await sleep(300);
    assert.ok(isChildAlive(), label + ' — the bundle must still run: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1200));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('37 - container-boot-routing-case-b707 — a mixed-case GET of the routing map is answered and leaves an isaac bundle up (#B707)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (va.status !== 0) { setupError = 'view:add failed (' + va.status + '): ' + (va.stderr || va.stdout).slice(-400); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }

        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { setupError = 'could not read the webroot: ' + (e.message || e); return; }

        // ONE boot for every arm
        child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', function (d) { childOut += d; });
        child.stderr.on('data', function (d) { childOut += d; });
        child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
        var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
        while (Date.now() < deadline && !childExit) {
            if (await isTcpPortOpen(bundlePort)) { up = true; break; }
            await sleep(POLL_INTERVAL_MS);
        }
        if (!up) { setupError = 'the bundle did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000); return; }
        await sleep(300);
    });

    after(async function () {
        if (isChildAlive()) {
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 12000;
            while (Date.now() < until && isChildAlive()) { await sleep(150); }
            if (isChildAlive()) {
                // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
                var m = childOut.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
                if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
                try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
        }
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    function ready(t) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        return true;
    }

    it('00.1  control — the lowercase routing map under the webroot answers 200, from isaac\'s fast path', async function (t) {
        if (!ready(t)) return;
        var r = await direct(webroot + '_gina/assets/routing.json');
        assert.equal(r.status, 200, 'GET ' + webroot + '_gina/assets/routing.json → ' + show(r));
        assert.ok(r.json && typeof r.json === 'object', 'the routing map must be JSON: ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'isaac\'s fast path must answer it, not core/server.js: ' + show(r));
        controlBody = r.body;
    });

    it('00.2  `Routing.json` under the webroot answers 200 with the same table, and the bundle still runs (#B707 — was: no answer, the process ended)', async function (t) {
        if (!ready(t)) return;
        var r = await direct(webroot + '_gina/assets/Routing.json');
        assert.equal(r.status, 200, 'GET ' + webroot + '_gina/assets/Routing.json → ' + show(r) + '\n' + childOut.slice(-800));
        assert.equal(r.body, controlBody, 'the same routing map as the lowercase request');
        await assertStillRunning('after Routing.json');
    });

    it('00.3  `ROUTING.JSON?x=1` at the root answers 200 with the same table, and the bundle still runs', async function (t) {
        if (!ready(t)) return;
        var r = await direct('/_gina/assets/ROUTING.JSON?x=1');
        assert.equal(r.status, 200, 'GET /_gina/assets/ROUTING.JSON?x=1 → ' + show(r) + '\n' + childOut.slice(-800));
        assert.equal(r.body, controlBody, 'the same routing map as the lowercase request');
        await assertStillRunning('after ROUTING.JSON?x=1');
    });

    it('00.4  the health check still answers, and the launcher has not exited', async function (t) {
        if (!ready(t)) return;
        var h = await direct('/_gina/health/check');
        assert.equal(h.status, 200, 'GET /_gina/health/check → ' + show(h));
        assert.equal(childExit, null, 'the launcher must not have exited: ' + JSON.stringify(childExit));
        assert.equal((childOut.match(/reading 'mime'/g) || []).length, 0, 'no null-read of the asset may have been logged:\n' + childOut.slice(-800));
    });
});
