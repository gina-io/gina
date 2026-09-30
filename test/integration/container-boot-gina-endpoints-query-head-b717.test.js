/**
 * #B717 + #B718 — on the isaac engine, the health check and the client routing map answer a url
 * that carries a query string, and the health check answers HEAD, outside and inside a
 * maintenance window, through a booted bundle.
 *
 * The defects: isaac runs its own `/_gina/*` handlers on the RAW url, and they matched `…$`, so a
 * query string missed them — during a maintenance window `/_gina/assets/routing.json?x=1` answered
 * isaac's 503 (outside one, core/server.js answered it, having received the url without its
 * query) (#B717). And the health check answered GET only, so `HEAD /_gina/health/check` fell
 * through to routing: a 404, or the maintenance 503 during a window (#B718).
 *
 * Instrument — which layer answered: core/server.js sets `X-Request-Id` on every response it
 * writes; isaac's own handlers and isaac's gate never do. So a 200 without the header came from
 * isaac's own handler, and 00.1 proves that on the plain health check.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine, the default
 * http/1.1 protocol — on a bundle scaffolded by bundle:add + view:add, NO
 * `server.maintenance.allowFrom`, called by a direct loopback client):
 *   00  maintenance off: the plain health check (control), HEAD, the routing map with a query
 *       answered by isaac's fast path, and a url whose QUERY ends with the routing-map path, which
 *       is served the map and leaves the bundle up
 *   01  maintenance on, flipped by a direct POST (the operator's path)
 *   02  HEAD, HEAD with a query and GET with a query on the health check, and the routing map
 *       with a query, all answer 200; controls — a routed page still gets isaac's 503 (02.5) and
 *       a POST to the health check still gets the maintenance 503 (02.6)
 *   03  maintenance off; the page answers again
 *
 * Isolation: the b715 live test's shape — a throwaway HOME under os.tmpdir(), its own port
 * window (10950), project:rm + rmSync at teardown. Seam: `B717_GINA_ROOT=<tree>` boots THAT
 * tree's launcher against a project scaffolded by THAT tree's CLI (red-first: point it at a tree
 * without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-gina-endpoints-query-head-b717.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-mq-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'mq' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10950;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B717_GINA_ROOT || path.resolve(__dirname, '../..');
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

/** Which layer answered: core/server.js sets X-Request-Id on every answer; isaac's handlers and gate never do. */
function answeredBy(r) { return ( r.headers && r.headers['x-request-id'] ) ? 'server.js' : 'isaac (or none)'; }

function show(r) {
    return JSON.stringify({ status: r.status, answeredBy: answeredBy(r), contentLength: (r.headers || {})['content-length'], retryAfter: (r.headers || {})['retry-after'], body: (r.body || '').slice(0, 120), err: r.err || undefined, bundleExit: childExit || undefined });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** A health HEAD answer: 200, no body, content-length = the GET body's length, the GET headers kept. */
async function assertHealthHead(url, label) {
    var get  = await direct('GET', '/_gina/health/check', {});
    var head = await direct('HEAD', url, {});
    assert.equal(head.status, 200, label + ' → ' + show(head));
    assert.equal(head.body, '', label + ' must answer no body: ' + show(head));
    assert.equal(Number(head.headers['content-length']), Buffer.byteLength(get.body), label + ' content-length must be the GET body length: ' + show(head) + ' vs ' + show(get));
    ['content-type', 'cache-control'].forEach(function (k) {
        assert.equal(head.headers[k], get.headers[k], label + ' must keep the GET ' + k);
    });
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('34 - container-boot-gina-endpoints-query-head-b717 — the health check and the routing map answer a query string, and the health check answers HEAD, on isaac (#B717, #B718)', function () {

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

    // ── 00 maintenance off ───────────────────────────────────────────────────

    it('00.1  control — GET /_gina/health/check answers 200, from isaac\'s own handler', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false, 'precondition: maintenance must start off');
        var r = await direct('GET', '/_gina/health/check', {});
        assert.equal(r.status, 200, 'GET /_gina/health/check → ' + show(r));
        assert.equal(r.json && r.json.status, 'healthy', show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'isaac\'s own handler answers the health check: ' + show(r));
    });

    it('00.2  HEAD /_gina/health/check answers 200 with no body (#B718 — was a 404)', async function (t) {
        if (!ready(t)) return;
        await assertHealthHead('/_gina/health/check', 'HEAD /_gina/health/check');
    });

    it('00.3  the routing map with a query string is answered by isaac\'s fast path (#B717)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/assets/routing.json?x=1', {});
        assert.equal(r.status, 200, 'GET /_gina/assets/routing.json?x=1 → ' + show(r));
        assert.ok(r.json && typeof r.json === 'object', 'the routing map must be JSON: ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'isaac\'s fast path must answer it, not core/server.js: ' + show(r));
    });

    it('00.4  a url whose QUERY ends with the routing-map path is served the map, and the bundle stays up', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/x?y=/_gina/assets/routing.json', {});
        assert.equal(r.status, 200, 'GET /x?y=/_gina/assets/routing.json → ' + show(r));
        assert.ok(r.json && typeof r.json === 'object', 'the routing map must be JSON: ' + show(r));
        await sleep(200);
        assert.ok(isChildAlive(), 'the bundle must still run: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-800));
        var h = await direct('GET', '/_gina/health/check', {});
        assert.equal(h.status, 200, 'the bundle must still answer: ' + show(h));
    });

    // ── 01 maintenance on ────────────────────────────────────────────────────

    it('01.1  a direct POST turns maintenance on (the operator\'s path)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/maintenance', JSON_BODY, ON);
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), true, 'maintenance is not on after the POST');
    });

    // ── 02 inside the window ─────────────────────────────────────────────────

    it('02.1  HEAD /_gina/health/check answers 200 with no body during the window (#B718 — was a 503)', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), true, 'precondition: maintenance must be on');
        await assertHealthHead('/_gina/health/check', 'HEAD /_gina/health/check');
    });

    it('02.2  HEAD with a query string answers 200 with no body during the window', async function (t) {
        if (!ready(t)) return;
        await assertHealthHead('/_gina/health/check?probe=1', 'HEAD /_gina/health/check?probe=1');
    });

    it('02.3  GET with a query string is answered by isaac\'s own health handler during the window (#B717)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/health/check?probe=1', {});
        assert.equal(r.status, 200, 'GET /_gina/health/check?probe=1 → ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'isaac\'s own handler must answer it: ' + show(r));
    });

    it('02.4  the routing map with a query string answers 200 during the window (#B717 — was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/assets/routing.json?x=1', {});
        assert.equal(r.status, 200, 'GET /_gina/assets/routing.json?x=1 → ' + show(r));
        assert.ok(r.json && typeof r.json === 'object', 'the routing map must be JSON: ' + show(r));
    });

    it('02.5  control — a routed page still gets isaac\'s 503', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot, {});
        assert.equal(r.status, 503, 'GET ' + webroot + ' → ' + show(r));
        assert.ok(r.headers['retry-after'], 'the maintenance 503 must carry Retry-After: ' + show(r));
        assert.equal(r.headers['x-request-id'], undefined, 'the 503 must come from isaac\'s gate: ' + show(r));
    });

    it('02.6  control — a POST to the health check still gets the maintenance 503 (GET and HEAD only)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/health/check', {});
        assert.equal(r.status, 503, 'POST /_gina/health/check → ' + show(r));
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
