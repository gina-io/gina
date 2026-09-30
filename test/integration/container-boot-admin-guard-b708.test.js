/**
 * #B708 — a cross-site write to a `/_gina/*` control endpoint is refused whatever the
 * shape of its URL, through a booted bundle.
 *
 * The unit file (test/core/admin-write-guard-b708.test.js) proves, over the engine
 * sources, that the guard's URL test covers every write handler's; this one boots the
 * REAL `bin/gina-container` (isaac, the default engine, the default http/1.1 protocol) and
 * sends the requests over HTTP. The cross-site requests carry what a browser computes
 * itself — `Origin` of the attacker page and `Sec-Fetch-Site: cross-site` — with a
 * `text/plain` body (a CORS simple request: a `<form enctype="text/plain">` or a no-cors
 * fetch sends it, no preflight). Arms:
 *
 *   01  controls — the canonical URL is refused (as since #B384); a non-browser client and
 *       a same-origin browser still reach a webroot-prefixed endpoint; a cross-site POST to
 *       an app URL without `/_gina/` is not refused by the guard
 *   02  the four shapes that reached a write handler past the guard before the fix — a
 *       path prefix, an empty leading segment, another letter case, and the endpoint path
 *       at the end of the query string — are refused, and the maintenance state never flips
 *   03  after every arm the bundle is open: maintenance off, the page is not a 503
 *
 * Each arm that could turn maintenance on resets it, so on a pre-fix tree every red arm is
 * independent of the others. Isolation: the container-boot-route-confusion.test.js shape —
 * a throwaway HOME under os.tmpdir(), its own port window (10650), project:rm + rmSync at
 * teardown. Seam: `B708_GINA_ROOT=<tree>` boots THAT tree's launcher against a project
 * scaffolded by THAT tree's CLI (red-first: point it at a tree without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-admin-guard-b708.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ag-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ag' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10650;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B708_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

/** What a browser attaches to a cross-site POST it sends on a page's behalf. */
var XSITE = { 'origin': 'https://attacker.example', 'sec-fetch-site': 'cross-site', 'content-type': 'text/plain;charset=UTF-8' };
var ON    = '{"enable":true,"ttlSeconds":120}';
var GUARD_MESSAGE = 'cross-origin write to a /_gina/* control endpoint is refused';


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

/** One HTTP/1.1 request on a fresh connection; `absPath` is sent verbatim. */
function request(method, absPath, headers, body) {
    return new Promise(function (resolve) {
        var h = Object.assign({}, headers || {});
        if (body !== undefined) { h['content-length'] = Buffer.byteLength(body); }
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false, headers: h }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        if (body !== undefined) { req.write(body); }
        req.end();
    });
}

/** The maintenance state as the bundle reports it (a non-browser GET, admitted from loopback). */
async function maintenanceActive() {
    var r = await request('GET', '/_gina/maintenance', {});
    return (r.json && typeof r.json.active === 'boolean') ? r.json.active : ('unreadable: ' + r.status + ' ' + r.body.slice(0, 120));
}

/** Turn maintenance off from the host — the reset every flipping arm runs, pass or fail. */
function reopen() {
    return request('POST', '/_gina/maintenance', { 'content-type': 'application/json' }, '{"enable":false}');
}

function show(r) { return JSON.stringify({ status: r.status, body: (r.body || '').slice(0, 160), err: r.err || undefined }); }

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

describe('29 - container-boot-admin-guard-b708 — a cross-site write to a /_gina/* control endpoint is refused whatever its URL shape (#B708)', function () {

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

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }
        try {
            var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
            var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
        if (webroot === '/') { setupError = 'the scaffold webroot must not be "/" — the prefix arms need one'; return; }

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

    /** A cross-site POST that must be refused by the guard, with maintenance left off. */
    async function assertRefused(absPath, body) {
        var r;
        try {
            r = await request('POST', absPath, XSITE, body === undefined ? '' : body);
            assert.equal(r.status, 403, absPath + ' → ' + show(r));
            assert.ok(r.body.indexOf(GUARD_MESSAGE) > -1, 'the refusal must come from the guard: ' + show(r));
            assert.equal(await maintenanceActive(), false, 'maintenance flipped through ' + absPath);
        } finally {
            await reopen();
        }
    }

    // ── 01 controls ───────────────────────────────────────────────────────

    it('01.1  the canonical URL is refused, as since #B384', async function (t) {
        if (!ready(t)) return;
        await assertRefused('/_gina/maintenance', ON);
    });

    it('01.2  a non-browser client still reaches a webroot-prefixed endpoint', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', webroot + '_gina/cache/clear', {}, '');
        assert.equal(r.status, 200, show(r));
        assert.equal(r.json && r.json.ok, true, show(r));
    });

    it('01.3  a same-origin browser still turns maintenance on and off through the webroot', async function (t) {
        if (!ready(t)) return;
        var same = { 'sec-fetch-site': 'same-origin', 'content-type': 'text/plain;charset=UTF-8' };
        try {
            var on = await request('POST', webroot + '_gina/maintenance', same, ON);
            assert.equal(on.status, 200, show(on));
            assert.equal(await maintenanceActive(), true);
            var off = await request('POST', webroot + '_gina/maintenance', same, '{"enable":false}');
            assert.equal(off.status, 200, show(off));
            assert.equal(await maintenanceActive(), false);
        } finally {
            await reopen();
        }
    });

    it('01.4  a cross-site POST to an app URL without /_gina/ is not refused by the guard', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', webroot, XSITE, '');
        assert.ok(r.status !== null, show(r));
        assert.equal(r.body.indexOf(GUARD_MESSAGE), -1, 'the guard refused an app URL: ' + show(r));
    });

    // ── 02 the four shapes ────────────────────────────────────────────────

    it('02.1  a path prefix (the webroot) is refused — pre-fix: 200 and a site-wide 503', async function (t) {
        if (!ready(t)) return;
        await assertRefused(webroot + '_gina/maintenance', ON);
    });

    it('02.2  an empty leading segment is refused', async function (t) {
        if (!ready(t)) return;
        await assertRefused('//_gina/maintenance', ON);
    });

    it('02.3  another letter case is refused on cache/clear — pre-fix: 200, the cache flushed', async function (t) {
        if (!ready(t)) return;
        await assertRefused('/_GINA/cache/clear');
    });

    it('02.4  another letter case is refused on storage/gc — pre-fix: 200, the handler ran', async function (t) {
        if (!ready(t)) return;
        await assertRefused('/_GINA/storage/gc');
    });

    it('02.5  the endpoint path at the end of the query string is refused on maintenance — pre-fix: 200 and a site-wide 503', async function (t) {
        if (!ready(t)) return;
        await assertRefused('/?next=/_gina/maintenance', ON);
    });

    it('02.6  the endpoint path at the end of the query string is refused on cache/clear', async function (t) {
        if (!ready(t)) return;
        await assertRefused('/?next=/_gina/cache/clear');
    });

    // ── 03 the bundle is open after every arm ─────────────────────────────

    it('03.1  maintenance is off and the page is not closed (no 503)', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false);
        var page = await request('GET', webroot, {});
        assert.ok(page.status !== null && page.status !== 503, show(page));
    });
});
