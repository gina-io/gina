/**
 * #B715 — during a maintenance window on the isaac engine, the `/_gina/*` endpoints that only
 * core/server.js answers stay reachable, through a booted bundle.
 *
 * The defect: isaac's maintenance gate sits below isaac's own `/_gina/*` handlers but above the
 * hand-off to core/server.js, whose /_gina band sits above its twin gate. So an endpoint that
 * exists only in core/server.js — `/_gina/storage/stats`, `/_gina/storage/gc`,
 * `/_gina/storage/verify` — answered isaac's 503 for the whole window, and `gina storage:*`
 * failed against a running bundle precisely when an operator runs maintenance work. A health
 * check whose url carries a query string did the same: isaac's `$`-anchored handler tests the
 * raw url and misses it, while core/server.js's twin, which sees the url without its query,
 * answers it outside a window. The express engine was not affected. The fix: isaac's gate lets
 * those exact query-free root paths through to core/server.js (`_isLeftToServerJs`).
 *
 * Instrument — which gate answered: core/server.js sets `X-Request-Id` on every response it
 * writes, isaac's own gate never does. So a 503 WITHOUT the header came from isaac's gate (the
 * #B715 shape). 02.1 proves the header fires on a core/server.js answer; 02.5 proves isaac's
 * 503 lacks it.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine, the default
 * http/1.1 protocol — on a bundle scaffolded by bundle:add + view:add, NO
 * `server.maintenance.allowFrom`, called by a direct loopback client, which `app.json`
 * `admin.allowFrom` admits by default; no storage is configured, so the storage endpoints
 * answer `configured: false`):
 *   00  controls with maintenance off: storage/stats and a health check with a query answer 200
 *   01  maintenance on, flipped by a direct POST (the operator's path)
 *   02  storage/stats (02.1), storage/gc dry run (02.2), storage/verify (02.3) and the health
 *       check with a query (02.4) answer 200; controls — a routed page still gets isaac's 503
 *       (02.5), a relayed storage call is refused by the endpoint's own admin gate, 403 not 503
 *       (02.6), and the webroot form of a storage path, which core/server.js does not answer,
 *       stays behind isaac's gate (02.7)
 *   03  maintenance off; the page answers again
 *
 * Isolation: the b711 live test's shape — a throwaway HOME under os.tmpdir(), its own port
 * window (10850), project:rm + rmSync at teardown. Seam: `B715_GINA_ROOT=<tree>` boots THAT
 * tree's launcher against a project scaffolded by THAT tree's CLI (red-first: point it at a tree
 * without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-maintenance-left-to-server-b715.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ml-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ml' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10850;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B715_GINA_ROOT || path.resolve(__dirname, '../..');
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
 * `Host: 127.0.0.1:<port>` and no forwarding header — a direct loopback client.
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

/** A storage endpoint answer: 200, JSON, and the `configured` field every storage reply carries. */
function assertStorageAnswer(r, label) {
    assert.equal(r.status, 200, label + ' → ' + show(r));
    assert.ok(r.json && typeof r.json.configured === 'boolean', label + ' must answer the storage JSON: ' + show(r));
    assert.ok(r.headers['x-request-id'], label + ' must be answered by core/server.js: ' + show(r));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('33 - container-boot-maintenance-left-to-server-b715 — the /_gina/* endpoints only core/server.js answers stay reachable during a window on isaac (#B715)', function () {

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
        // view:add gives the bundle a routed page that renders, the control 02.5 reads
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

    // ── 00 controls: the endpoints answer with maintenance off ───────────────

    it('00.1  control — with maintenance off, /_gina/storage/stats answers', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false, 'precondition: maintenance must start off');
        assertStorageAnswer(await direct('GET', '/_gina/storage/stats', {}), 'GET /_gina/storage/stats');
    });

    it('00.2  control — with maintenance off, a health check with a query answers 200', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/health/check?probe=1', {});
        assert.equal(r.status, 200, 'GET /_gina/health/check?probe=1 → ' + show(r));
    });

    // ── 01 maintenance on ────────────────────────────────────────────────────

    it('01.1  a direct POST turns maintenance on (the operator\'s path)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/maintenance', JSON_BODY, ON);
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), true, 'maintenance is not on after the POST');
    });

    // ── 02 the endpoints stay reachable; the controls hold ───────────────────

    it('02.1  /_gina/storage/stats answers during the window (was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), true, 'precondition: maintenance must be on');
        assertStorageAnswer(await direct('GET', '/_gina/storage/stats', {}), 'GET /_gina/storage/stats');
    });

    it('02.2  a POST /_gina/storage/gc dry run answers during the window (was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/storage/gc?dryRun=1', {});
        assertStorageAnswer(r, 'POST /_gina/storage/gc?dryRun=1');
        assert.equal(r.json.dryRun, true, 'the dry-run flag must reach the handler: ' + show(r));
    });

    it('02.3  /_gina/storage/verify answers during the window (was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        assertStorageAnswer(await direct('GET', '/_gina/storage/verify', {}), 'GET /_gina/storage/verify');
    });

    it('02.4  a health check with a query answers 200 during the window (was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/health/check?probe=1', {});
        assert.equal(r.status, 200, 'GET /_gina/health/check?probe=1 → ' + show(r));
    });

    it('02.5  control — a routed page still gets isaac\'s 503', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot, {});
        assert.equal(r.status, 503, 'GET ' + webroot + ' → ' + show(r));
        assert.ok(r.headers['retry-after'], 'the maintenance 503 must carry Retry-After: ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'the 503 must come from isaac\'s gate, not core/server.js\'s: ' + show(r));
    });

    it('02.6  control — a relayed storage call is refused by the endpoint\'s own admin gate (403, not 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/storage/stats', { 'x-forwarded-for': '203.0.113.9' });
        assert.equal(r.status, 403, 'GET /_gina/storage/stats with x-forwarded-for → ' + show(r));
    });

    it('02.7  control — the webroot form of a storage path, which core/server.js does not answer, stays behind isaac\'s gate', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot + '_gina/storage/stats', {});
        assert.equal(r.status, 503, 'GET ' + webroot + '_gina/storage/stats → ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'the 503 must come from isaac\'s gate: ' + show(r));
    });

    // ── 03 maintenance off ───────────────────────────────────────────────────

    it('03.1  a direct POST turns maintenance off; the page answers again', async function (t) {
        if (!ready(t)) return;
        var r = await reopen();
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), false, 'maintenance is still on after the POST');
        var p = await direct('GET', webroot, {});
        assert.equal(p.status, 200, 'GET ' + webroot + ' after reopening → ' + show(p));
    });
});
