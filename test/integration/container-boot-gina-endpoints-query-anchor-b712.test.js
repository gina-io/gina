/**
 * #B712 — on the isaac engine, a page url whose QUERY string ends in a `/_gina/*` endpoint path
 * is answered by the page, not the endpoint, outside and inside a maintenance window; a
 * WebSocket upgrade to such a url is not the agent's; and the dev endpoints answer a url that
 * carries a query string during a window (the #B717 residual) — through a booted bundle.
 *
 * The defects: the handlers left out of #B709's exact-path matching tested the RAW url with no
 * start anchor, so `/web/?next=/_gina/health/check` got the health JSON, `…/_gina/jobs/<id>` the
 * jobs 404, `…/_gina/logs` an event stream and `…/_gina/inspector` the Inspector, instead of the
 * page — and during a maintenance window the endpoint answered where the page's 503 was due.
 * A WebSocket upgrade to `/web/?next=/_gina/agent` got `101`. And `/_gina/logs?x=1` or
 * `/_gina/inspector?x=1` missed their `$`-anchored handlers, so during a window isaac's gate
 * answered them 503.
 *
 * Instrument — the page: the scaffold's routed page answers JSON; its `msg`, read in 00.1, is
 * the page's fingerprint, and core/server.js sets `X-Request-Id` on what it answers (isaac's own
 * handlers never do). An event stream is read to its first chunk only, so an arm that gets one
 * fails at once rather than waiting on it.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine, the default
 * http/1.1 protocol, the scaffold's dev env — on a bundle scaffolded by bundle:add + view:add,
 * NO `server.maintenance.allowFrom`, called by a direct loopback client):
 *   00  maintenance off: the page (control); the health, jobs, logs and inspector paths at the
 *       end of the page's query string all get the page; a prefixed logs path still streams
 *       (control); a WebSocket upgrade to the agent path gets 101 (control), to a page url
 *       whose query ends in it no upgrade
 *   01  maintenance on, flipped by a direct POST (the operator's path)
 *   02  the page and the health-in-query url both get isaac's 503; `/_gina/logs?x=1` streams
 *       and `/_gina/inspector?x=1` answers the Inspector; the health check answers 200 (control)
 *   03  maintenance off; the page answers again
 *
 * Isolation: the b717 live test's shape — a throwaway HOME under os.tmpdir(), its own port
 * window (11000), project:rm + rmSync at teardown. Seam: `B712_GINA_ROOT=<tree>` boots THAT
 * tree's launcher against a project scaffolded by THAT tree's CLI (red-first: point it at a tree
 * without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-gina-endpoints-query-anchor-b712.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var crypto = require('crypto');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-qa-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'qa' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11000;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B712_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var pageMsg = null;

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
 * `Host: 127.0.0.1:<port>` and no forwarding header — a direct loopback client. An event stream
 * is read to its first chunk (or 1.5 s), then the connection is closed.
 */
function direct(method, absPath, headers, body) {
    return new Promise(function (resolve) {
        var h = Object.assign({}, headers || {}), done = false;
        if (body !== undefined) { h['content-length'] = Buffer.byteLength(body); }
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false, headers: h }, function (res) {
            var data = '';
            var finish = function () {
                if (done) { return; }
                done = true;
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
            };
            if ( /event-stream/.test(res.headers['content-type'] || '') ) {
                res.on('data', function (c) { data += c; finish(); req.destroy(); });
                setTimeout(function () { finish(); req.destroy(); }, 1500);
                return;
            }
            res.on('data', function (c) { data += c; });
            res.on('end', finish);
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { if (done) { return; } done = true; resolve({ status: null, headers: {}, err: e.message, body: '', json: null }); });
        if (body !== undefined) { req.write(body); }
        req.end();
    });
}

/** A WebSocket handshake on a raw socket: `101`, or `none` when no listener answers within 2.5 s. */
function upgrade(absPath) {
    return new Promise(function (resolve) {
        var sock = net.connect(bundlePort, '127.0.0.1'), buf = '', done = false;
        var finish = function (v) { if (done) { return; } done = true; try { sock.destroy(); } catch (e) { /* gone */ } resolve(v); };
        sock.setTimeout(2500, function () { finish({ got: 'none', line: 'no status line within 2.5 s' }); });
        sock.on('connect', function () {
            sock.write('GET ' + absPath + ' HTTP/1.1\r\nHost: 127.0.0.1:' + bundlePort + '\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n'
                + 'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64') + '\r\n\r\n');
        });
        sock.on('data', function (c) {
            buf += c;
            if ( buf.indexOf('\r\n') > -1 ) { var line = buf.split('\r\n')[0]; finish({ got: / 101 /.test(line) ? '101' : 'none', line: line }); }
        });
        sock.on('error', function (e) { finish({ got: 'none', line: 'error ' + e.message }); });
        sock.on('close', function () { finish({ got: 'none', line: 'closed' }); });
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
    return JSON.stringify({ status: r.status, answeredBy: answeredBy(r), contentType: (r.headers || {})['content-type'], body: (r.body || '').slice(0, 120), err: r.err || undefined, bundleExit: childExit || undefined });
}

/** The page answered: a 200 whose JSON carries the page's `msg`, written by core/server.js. */
function assertPage(r, label) {
    assert.equal(r.status, 200, label + ' → ' + show(r));
    assert.ok(r.json && r.json.msg === pageMsg, label + ' must be answered by the page (msg ' + JSON.stringify(pageMsg) + '): ' + show(r));
    assert.ok(r.headers['x-request-id'], label + ' must be routed through core/server.js: ' + show(r));
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

describe('35 - container-boot-gina-endpoints-query-anchor-b712 — an endpoint path in a page\'s query string is the page\'s, and the dev endpoints answer a query string, on isaac (#B712)', function () {

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
        // view:add gives the bundle a routed page, the one the query-string arms must reach
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (va.status !== 0) { setupError = 'view:add failed (' + va.status + '): ' + (va.stderr || va.stdout).slice(-400); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        if (env !== 'dev') { setupError = 'the dev endpoints need the dev env; the scaffold uses ' + env; return; }
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }

        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            var ss = fs.readFileSync(ssFile, 'utf8');
            if (/"allowFrom"/.test(ss)) { setupError = 'settings.server.json carries an allowFrom — the window arms would be void'; return; }
            var wr = (ss.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
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

    it('00.1  control — the page answers 200 with its JSON, through core/server.js', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false, 'precondition: maintenance must start off');
        var r = await direct('GET', webroot, {});
        assert.equal(r.status, 200, 'GET ' + webroot + ' → ' + show(r));
        assert.ok(r.json && typeof r.json.msg === 'string', 'the scaffold page must answer JSON with a msg: ' + show(r));
        assert.ok(r.headers['x-request-id'], 'the page is routed through core/server.js: ' + show(r));
        pageMsg = r.json.msg;
    });

    it('00.2  the health-check path at the end of the page\'s query string gets the page (#B712 — was the health JSON)', async function (t) {
        if (!ready(t)) return;
        assertPage(await direct('GET', webroot + '?next=/_gina/health/check', {}), 'GET ' + webroot + '?next=/_gina/health/check');
    });

    it('00.3  a jobs path at the end of the page\'s query string gets the page (#B712 — was the jobs 404)', async function (t) {
        if (!ready(t)) return;
        assertPage(await direct('GET', webroot + '?next=/_gina/jobs/nope', {}), 'GET ' + webroot + '?next=/_gina/jobs/nope');
    });

    it('00.4  the logs path at the end of the page\'s query string gets the page, not an event stream (#B712)', async function (t) {
        if (!ready(t)) return;
        assertPage(await direct('GET', webroot + '?next=/_gina/logs', {}), 'GET ' + webroot + '?next=/_gina/logs');
    });

    it('00.5  the Inspector path at the end of the page\'s query string gets the page, not the Inspector (#B712)', async function (t) {
        if (!ready(t)) return;
        assertPage(await direct('GET', webroot + '?next=/_gina/inspector', {}), 'GET ' + webroot + '?next=/_gina/inspector');
    });

    it('00.6  control — a prefixed logs path still streams (the Inspector sends the opener page\'s pathname)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot + 'deep/page/_gina/logs', {});
        assert.equal(r.status, 200, show(r));
        assert.match(r.headers['content-type'] || '', /event-stream/, 'the logs stream must answer a prefixed path: ' + show(r));
    });

    it('00.7  control — a WebSocket upgrade to the agent path gets 101', async function (t) {
        if (!ready(t)) return;
        var u = await upgrade('/_gina/agent');
        assert.equal(u.got, '101', 'GET /_gina/agent (upgrade) → ' + u.line);
    });

    it('00.8  a WebSocket upgrade to a page url whose query string ends in the agent path is not upgraded (#B712 — was 101)', async function (t) {
        if (!ready(t)) return;
        var u = await upgrade(webroot + '?next=/_gina/agent');
        assert.equal(u.got, 'none', 'GET ' + webroot + '?next=/_gina/agent (upgrade) → ' + u.line);
        await sleep(200);
        assert.ok(isChildAlive(), 'the bundle must still run: ' + JSON.stringify(childExit));
    });

    // ── 01 maintenance on ────────────────────────────────────────────────────

    it('01.1  a direct POST turns maintenance on (the operator\'s path)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('POST', '/_gina/maintenance', JSON_BODY, ON);
        assert.equal(r.status, 200, 'POST ' + show(r));
        assert.equal(await maintenanceActive(), true, 'maintenance is not on after the POST');
    });

    // ── 02 inside the window ─────────────────────────────────────────────────

    it('02.1  control — the page gets isaac\'s 503', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), true, 'precondition: maintenance must be on');
        var r = await direct('GET', webroot, {});
        assert.equal(r.status, 503, 'GET ' + webroot + ' → ' + show(r));
        assert.ok(r.headers['retry-after'], 'the maintenance 503 must carry Retry-After: ' + show(r));
    });

    it('02.2  the health-check path at the end of the page\'s query string gets the page\'s 503 (#B712 — was the health 200)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', webroot + '?next=/_gina/health/check', {});
        assert.equal(r.status, 503, 'GET ' + webroot + '?next=/_gina/health/check → ' + show(r));
    });

    it('02.3  /_gina/logs?x=1 streams during the window (#B717 residual — was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/logs?x=1', {});
        assert.equal(r.status, 200, 'GET /_gina/logs?x=1 → ' + show(r));
        assert.match(r.headers['content-type'] || '', /event-stream/, show(r));
    });

    it('02.4  /_gina/inspector?x=1 answers the Inspector during the window (#B717 residual — was isaac\'s 503)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/inspector?x=1', {});
        assert.equal(r.status, 200, 'GET /_gina/inspector?x=1 → ' + show(r));
        assert.match(r.body, /<title>Inspector<\/title>/, 'the Inspector must answer: ' + show(r));
    });

    it('02.5  control — the health check answers 200 during the window', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/health/check', {});
        assert.equal(r.status, 200, 'GET /_gina/health/check → ' + show(r));
        assert.equal(r.json && r.json.status, 'healthy', show(r));
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
