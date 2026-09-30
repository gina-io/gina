/**
 * #B711 — `server.maintenance.allowFrom` lets a listed DIRECT client through a maintenance
 * window on the isaac engine over HTTP/1.1, through a booted bundle.
 *
 * The defect: isaac's maintenance gate admits the listed client from the pristine `Host`
 * (`127.0.0.1:<port>`); isaac then rewrites an http/1.1 `Host` without its port before it hands
 * the request to core/server.js, whose own maintenance gate decided AGAIN — and the port-less
 * `Host` read as "proxied", which closes the IP arm, so the client got 503 on every routed page
 * and static file. The fix: isaac marks its verdict on the request and server.js's gate honours
 * it instead of deciding again.
 *
 * Instrument — which gate answered: core/server.js sets `X-Request-Id` on every response it
 * writes (MS1), isaac's own gate never does. So a 503 WITH the header came from server.js's gate
 * (the #B711 shape), a 503 WITHOUT it from isaac's gate. 02.1 proves the header fires on a
 * server.js answer; 02.4 proves isaac's 503 lacks it — the reading can fail both ways.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine, the default
 * http/1.1 protocol — on a bundle scaffolded by bundle:add + view:add (a bare bundle:add serves
 * no static file), with `"maintenance": { "allowFrom": ["127.0.0.1", "::1"] }` spliced into
 * `settings.server.json`):
 *   00  control: with maintenance off the bundle's static file (`css/default.css`) is served
 *   01  maintenance on, flipped by a direct POST (the operator's path)
 *   02  a listed direct client reaches a routed page (02.1) and that static file (02.2); controls —
 *       the same request with a `hostname` header, which makes isaac skip its h1 `Host` rewrite,
 *       was admitted before the fix too (02.3); a forwarding header closes the IP arm, answered by
 *       isaac's own gate (02.4)
 *   03  maintenance off; the page answers to anyone again
 *
 * Isolation: the b708/b709 live tests' shape — a throwaway HOME under os.tmpdir(), its own port
 * window (10800), project:rm + rmSync at teardown. Seam: `B711_GINA_ROOT=<tree>` boots THAT
 * tree's launcher against a project scaffolded by THAT tree's CLI (red-first: point it at a tree
 * without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-maintenance-allowfrom-b711.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-mb-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'mb' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10800;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B711_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

var ON  = '{"enable":true,"ttlSeconds":120}';
var OFF = '{"enable":false}';
var JSON_BODY = { 'content-type': 'application/json' };


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
 * One direct HTTP/1.1 request on a fresh connection to the bundle: node sends
 * `Host: 127.0.0.1:<port>` and no forwarding header — a listed direct client.
 */
function direct(method, absPath, headers, body) {
    return new Promise(function (resolve) {
        var h = Object.assign({}, headers || {});
        if (body !== undefined) { h['content-length'] = Buffer.byteLength(body); }
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false, headers: h }, function (res) {
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
        if (body !== undefined) { req.write(body); }
        req.end();
    });
}

/** The maintenance state as the bundle reports it to a direct caller. */
async function maintenanceActive() {
    var r = await direct('GET', '/_gina/maintenance', {});
    return (r.json && typeof r.json.active === 'boolean') ? r.json.active : ('unreadable: ' + r.status + ' ' + r.body.slice(0, 120));
}

/** Turn maintenance off from the host — the reset the suite ends with, pass or fail. */
function reopen() { return direct('POST', '/_gina/maintenance', JSON_BODY, OFF); }

/** The bundle's own static file, scaffolded by view:add into its public folder. */
function STATIC_PATH() { return webroot + 'css/default.css'; }

/** Which gate a response came from: core/server.js sets X-Request-Id on every answer, isaac's gate never. */
function gateOf(r) { return ( r.headers && r.headers['x-request-id'] ) ? 'server.js' : 'isaac (or none)'; }

function show(r) {
    return JSON.stringify({ status: r.status, answeredBy: gateOf(r), retryAfter: (r.headers || {})['retry-after'], body: (r.body || '').slice(0, 120), err: r.err || undefined });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('32 - container-boot-maintenance-allowfrom-b711 — a listed direct client passes a maintenance window on isaac http/1.1 (#B711)', function () {

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
        // a bare bundle:add serves no static file at all; view:add scaffolds the public folder
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

        // Splice the bypass list into settings.server.json. The file carries comments: splice at
        // the single `"webroot": "` anchor, never parse and rewrite it.
        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            var src = fs.readFileSync(ssFile, 'utf8'), anchor = '"webroot": "';
            if (src.split(anchor).length - 1 !== 1) { setupError = 'expected exactly one ' + anchor + ' anchor in ' + ssFile; return; }
            var at = src.indexOf(anchor);
            fs.writeFileSync(ssFile, src.slice(0, at) + '"maintenance": { "allowFrom": ["127.0.0.1", "::1"] },\n    ' + src.slice(at));
            var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { setupError = 'could not splice the bypass list: ' + (e.message || e); return; }
        if (webroot === '/') { setupError = 'the scaffold webroot must not be "/"'; return; }

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
        if (isChildAlive() && bundlePort) {
            try { await reopen(); } catch (e) { /* the bundle may be gone */ }
        }
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

    // ── 00 control: the static file exists ──────────────────────────────────

    it('00.1  control — with maintenance off the static file is served', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false, 'precondition: maintenance must start off');
        var r = await direct('GET', STATIC_PATH(), {});
        assert.equal(r.status, 200, 'GET ' + STATIC_PATH() + ' → ' + show(r));
    });

    // ── 01 maintenance on ────────────────────────────────────────────────────

    it('01.1  a direct POST turns maintenance on (the operator\'s path)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/maintenance', JSON_BODY, ON);
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), true, 'maintenance is not on after the POST');
    });

    // ── 02 the listed direct client passes; the controls hold ────────────────

    it('02.1  a listed direct client reaches a routed page (was 503 from server.js\'s gate)', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), true, 'precondition: maintenance must be on');
        var r = await direct('GET', webroot, {});
        assert.equal(r.status, 200, 'GET ' + webroot + ' → ' + show(r));
        // the instrument can fire: a response written by core/server.js carries X-Request-Id
        assert.ok(r.headers['x-request-id'], 'a server.js answer must carry X-Request-Id: ' + show(r));
    });

    it('02.2  a listed direct client gets a static file (was 503 from server.js\'s gate)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', STATIC_PATH(), {});
        assert.equal(r.status, 200, 'GET ' + STATIC_PATH() + ' → ' + show(r));
    });

    it('02.3  control — with a `hostname` header (isaac skips its h1 Host rewrite) the page is served', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot, { 'hostname': 'x' });
        assert.equal(r.status, 200, 'GET ' + webroot + ' with a hostname header → ' + show(r));
    });

    it('02.4  control — a forwarding header closes the IP arm: isaac\'s own gate answers 503', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot, { 'x-forwarded-for': '203.0.113.9' });
        assert.equal(r.status, 503, 'GET ' + webroot + ' with x-forwarded-for → ' + show(r));
        assert.ok(r.headers['retry-after'], 'the maintenance 503 must carry Retry-After: ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'the 503 must come from isaac\'s gate, not server.js\'s: ' + show(r));
    });

    // ── 03 maintenance off ───────────────────────────────────────────────────

    it('03.1  a direct POST turns maintenance off; the page answers to anyone again', async function (t) {
        if (!ready(t)) return;
        var r = await reopen();
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), false, 'maintenance is still on after the POST');
        var p = await direct('GET', webroot, { 'x-forwarded-for': '203.0.113.9' });
        assert.equal(p.status, 200, 'GET ' + webroot + ' after reopening → ' + show(p));
    });
});
