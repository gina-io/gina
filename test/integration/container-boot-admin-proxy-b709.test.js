/**
 * #B709 — the admin `/_gina/*` endpoints refuse a request relayed by a proxy on the bundle's
 * own host, through a booted bundle.
 *
 * The unit file (test/lib/admin-proxied-b709.test.js) pins the rule in lib/admin and
 * lib/metrics; this one boots the REAL `bin/gina-container` (isaac, the default engine, the
 * default http/1.1 protocol) and puts an in-process reverse proxy on 127.0.0.1 in front of
 * it. The proxy connects from loopback — the address the default `admin.allowFrom` lists —
 * and rewrites each request into one of the shapes measured on a real nginx at the #B709
 * gate:
 *
 *   canonical  `Host $host` (port-less) + X-Forwarded-For / X-Forwarded-Proto / X-Real-IP
 *   health     a fixed port-less Host and no forwarding header (a health-probe proxy)
 *   default    nginx's default: `Host $proxy_host` (the upstream host:port), no header —
 *              byte-identical to a direct client, the pinned residual
 *
 * Arms:
 *   01  controls — direct callers (what the gina CLI and a curl on the host send) keep every
 *       endpoint: maintenance GET/POST, storage/stats (a server.js-only handler, reached after
 *       isaac rewrites an h1 Host port-less — a classifier reading the rewritten Host would
 *       refuse it), the bundle's own webroot form, metrics (503: admitted, not enabled)
 *   02  relayed requests are refused with the handler's own 403 and change nothing
 *   03  the URL channels a narrow proxy location or an edge block cannot see — a nested
 *       endpoint path, the endpoint path in the query string, another letter case, an empty
 *       leading segment — no longer reach an admin handler, even through the residual proxy
 *   04  the residual, pinned: the default proxy shape is still admitted
 *   05  the bundle ends open, and each gate logged its refusal once
 *
 * Every arm that could turn maintenance on resets it. Isolation: the b708 live test's shape —
 * a throwaway HOME under os.tmpdir(), its own port window (10750), project:rm + rmSync at
 * teardown. Seam: `B709_GINA_ROOT=<tree>` boots THAT tree's launcher against a project
 * scaffolded by THAT tree's CLI (red-first: point it at a tree without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-admin-proxy-b709.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ap-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ap' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10750;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B709_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var proxy = null, proxyPort = null;

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

/** One HTTP/1.1 request on a fresh connection to `port`; `absPath` is sent verbatim. */
function send(port, method, absPath, headers, body) {
    return new Promise(function (resolve) {
        var h = Object.assign({}, headers || {});
        if (body !== undefined) { h['content-length'] = Buffer.byteLength(body); }
        var req = http.request({ host: '127.0.0.1', port: port, path: absPath, method: method, agent: false, headers: h }, function (res) {
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

/** A direct caller: node sends `Host: 127.0.0.1:<port>`, no forwarding header — the gina CLI's shape. */
function direct(method, absPath, headers, body) { return send(bundlePort, method, absPath, headers, body); }

/** A caller relayed by the same-host proxy in the given shape. */
function via(shape, method, absPath, headers, body) {
    var h = Object.assign({ 'x-b709-shape': shape }, headers || {});
    return send(proxyPort, method, absPath, h, body);
}

/**
 * The same-host reverse proxy: connects to the bundle from 127.0.0.1 and rewrites the request
 * into the shape named by the (stripped) `x-b709-shape` header.
 */
function startProxy() {
    return new Promise(function (resolve, reject) {
        var server = http.createServer(function (inReq, inRes) {
            var chunks = [];
            inReq.on('data', function (c) { chunks.push(c); });
            inReq.on('end', function () {
                var shape = inReq.headers['x-b709-shape'];
                var headers = {};
                Object.keys(inReq.headers).forEach(function (k) {
                    if (k !== 'x-b709-shape' && k !== 'host' && k !== 'connection') { headers[k] = inReq.headers[k]; }
                });
                if (shape === 'canonical') {
                    headers.host = 'www.example.test';
                    headers['x-forwarded-for']   = '203.0.113.9';
                    headers['x-forwarded-proto'] = 'https';
                    headers['x-real-ip']         = '203.0.113.9';
                } else if (shape === 'health') {
                    headers.host = 'web-prod.example.test';
                } else if (shape === 'default') {
                    headers.host = '127.0.0.1:' + bundlePort;
                } else {
                    inRes.writeHead(500); return inRes.end('unknown proxy shape: ' + shape);
                }
                var body = Buffer.concat(chunks);
                if (body.length) { headers['content-length'] = body.length; }
                var up = http.request({ host: '127.0.0.1', port: bundlePort, path: inReq.url, method: inReq.method, agent: false, headers: headers }, function (upRes) {
                    var out = [];
                    upRes.on('data', function (c) { out.push(c); });
                    upRes.on('end', function () {
                        inRes.writeHead(upRes.statusCode, { 'content-type': upRes.headers['content-type'] || 'text/plain' });
                        inRes.end(Buffer.concat(out));
                    });
                });
                up.on('error', function (e) { inRes.writeHead(502); inRes.end('proxy error: ' + e.message); });
                if (body.length) { up.write(body); }
                up.end();
            });
        });
        server.on('error', reject);
        server.listen(0, '127.0.0.1', function () { resolve(server); });
    });
}

/** The maintenance state as the bundle reports it to a direct caller. */
async function maintenanceActive() {
    var r = await direct('GET', '/_gina/maintenance', {});
    return (r.json && typeof r.json.active === 'boolean') ? r.json.active : ('unreadable: ' + r.status + ' ' + r.body.slice(0, 120));
}

/** Turn maintenance off from the host — the reset every flipping arm runs, pass or fail. */
function reopen() { return direct('POST', '/_gina/maintenance', JSON_BODY, OFF); }

function show(r) { return JSON.stringify({ status: r.status, body: (r.body || '').slice(0, 160), err: r.err || undefined }); }

/** True when a response is the named admin handler's own payload. */
function isInfo(r)    { return !!(r.json && r.json.memory && typeof r.json.uptime === 'number'); }
function isStorage(r) { return !!(r.json && typeof r.json.configured === 'boolean' && Array.isArray(r.json.drivers)); }

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function count(hay, needle) { return hay.split(needle).length - 1; }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('31 - container-boot-admin-proxy-b709 — a request relayed by a same-host proxy never reaches an admin endpoint (#B709)', function () {

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
        if (webroot === '/') { setupError = 'the scaffold webroot must not be "/" — the webroot arms need one'; return; }

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

        proxy = await startProxy();
        proxyPort = proxy.address().port;
    });

    after(async function () {
        if (proxy) { try { proxy.close(); } catch (e) { /* ignore */ } }
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

    /**
     * A relayed POST that tries to turn maintenance on must change nothing: the maintenance
     * handler did not answer (whatever status routing gives the URL) and the state is off.
     */
    async function assertNotFlipped(r, label) {
        try {
            assert.ok(r.status !== null, label + ' → ' + show(r));
            assert.ok(!(r.json && typeof r.json.active === 'boolean'), 'the maintenance handler answered ' + label + ': ' + show(r));
            assert.equal(await maintenanceActive(), false, 'maintenance flipped through ' + label);
        } finally {
            await reopen();
        }
    }

    // ── 01 controls: direct callers keep every endpoint ─────────────────────

    it('01.1  a direct caller reads and flips maintenance (the operator\'s path)', async function (t) {
        if (!ready(t)) return;
        try {
            var st = await direct('GET', '/_gina/maintenance', {});
            assert.equal(st.status, 200, show(st));
            assert.equal(st.json && st.json.active, false, show(st));
            var on = await direct('POST', '/_gina/maintenance', JSON_BODY, ON);
            assert.equal(on.status, 200, show(on));
            assert.equal(await maintenanceActive(), true);
            var off = await direct('POST', '/_gina/maintenance', JSON_BODY, OFF);
            assert.equal(off.status, 200, show(off));
            assert.equal(await maintenanceActive(), false);
        } finally {
            await reopen();
        }
    });

    it('01.2  a direct caller reads storage/stats — a server.js-only handler, reached after isaac rewrote Host', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/storage/stats', {});
        assert.equal(r.status, 200, show(r));
        assert.ok(isStorage(r), show(r));
    });

    it('01.3  a direct caller reads info, through the root and the bundle\'s own webroot, a query ignored', async function (t) {
        if (!ready(t)) return;
        var a = await direct('GET', '/_gina/info', {});
        var b = await direct('GET', webroot + '_gina/info', {});
        var c = await direct('GET', '/_gina/info?x=1', {});
        [a, b, c].forEach(function (r) { assert.equal(r.status, 200, show(r)); assert.ok(isInfo(r), show(r)); });
    });

    it('01.4  a direct scrape of metrics is admitted by its list (503: not enabled)', async function (t) {
        if (!ready(t)) return;
        var r = await direct('GET', '/_gina/metrics', {});
        assert.equal(r.status, 503, show(r));
        assert.ok(r.body.indexOf('metrics not enabled') > -1, show(r));
    });

    // ── 02 relayed requests are refused ──────────────────────────────────────

    it('02.1  the canonical proxy cannot turn maintenance on — pre-fix: 200 and a site-wide 503', async function (t) {
        if (!ready(t)) return;
        var r = await via('canonical', 'POST', '/_gina/maintenance', JSON_BODY, ON);
        try {
            assert.equal(r.status, 403, show(r));
            assert.ok(r.body.indexOf('/_gina/maintenance: client IP not in app.json admin.allowFrom') > -1, show(r));
            assert.equal(await maintenanceActive(), false, 'maintenance flipped through the proxy');
            var page = await via('canonical', 'GET', webroot, {});
            assert.ok(page.status !== null && page.status !== 503, 'the site was closed: ' + show(page));
        } finally {
            await reopen();
        }
    });

    it('02.2  the canonical proxy cannot read info, through the root or the webroot form', async function (t) {
        if (!ready(t)) return;
        var a = await via('canonical', 'GET', '/_gina/info', {});
        var b = await via('canonical', 'GET', webroot + '_gina/info', {});
        [a, b].forEach(function (r) {
            assert.equal(r.status, 403, show(r));
            assert.ok(!isInfo(r), 'process state disclosed: ' + show(r));
        });
    });

    it('02.3  the canonical proxy cannot read storage/stats (the server.js-only handler)', async function (t) {
        if (!ready(t)) return;
        var r = await via('canonical', 'GET', '/_gina/storage/stats', {});
        assert.equal(r.status, 403, show(r));
    });

    it('02.4  the metrics twin refuses a relayed scrape (403 before the not-enabled 503)', async function (t) {
        if (!ready(t)) return;
        var r = await via('canonical', 'GET', '/_gina/metrics', {});
        assert.equal(r.status, 403, show(r));
    });

    it('02.5  a health-probe proxy (fixed port-less Host, no header) is refused too', async function (t) {
        if (!ready(t)) return;
        var r = await via('health', 'GET', '/_gina/info', {});
        assert.equal(r.status, 403, show(r));
        var m = await via('health', 'POST', '/_gina/maintenance', JSON_BODY, ON);
        await assertNotFlipped(m, 'the health-probe proxy');
    });

    // ── 03 URL channels closed, even through the residual proxy ──────────────

    it('03.1  a nested endpoint path (a prefix location forwards it) reaches no admin handler — pre-fix: 200 and a 503', async function (t) {
        if (!ready(t)) return;
        var r = await via('default', 'POST', '/_gina/health/check/_gina/maintenance', JSON_BODY, ON);
        await assertNotFlipped(r, '/_gina/health/check/_gina/maintenance');
    });

    it('03.2  the endpoint path at the end of the query string reaches no admin handler', async function (t) {
        if (!ready(t)) return;
        var r = await via('default', 'POST', '/?x=/_gina/maintenance', JSON_BODY, ON);
        await assertNotFlipped(r, '/?x=/_gina/maintenance');
        var i = await via('default', 'GET', webroot + 'page?next=/_gina/info', {});
        assert.ok(!isInfo(i), 'an app URL answered with process state: ' + show(i));
    });

    it('03.3  another letter case reaches no admin handler (cache/clear, storage/gc)', async function (t) {
        if (!ready(t)) return;
        var c = await via('default', 'POST', '/_GINA/cache/clear', {}, '');
        assert.ok(!(c.json && c.json.ok === true), 'the cache was flushed: ' + show(c));
        var g = await via('default', 'POST', '/_GINA/storage/gc', {}, '');
        assert.ok(!isStorage(g), 'the gc handler ran: ' + show(g));
    });

    it('03.4  an empty leading segment or a letter before `_gina` reaches no admin handler', async function (t) {
        if (!ready(t)) return;
        var r = await via('default', 'POST', '//_gina/maintenance', JSON_BODY, ON);
        await assertNotFlipped(r, '//_gina/maintenance');
        var x = await via('default', 'GET', '/x_gina/info', {});
        assert.ok(!isInfo(x), show(x));
    });

    // ── 04 the residual, pinned ──────────────────────────────────────────────

    it('04.1  RESIDUAL: the default proxy shape (port-bearing Host, no header) is still admitted', async function (t) {
        // byte-identical to a direct client — measured on a real nginx at the #B709 gate; the
        // docs tell the operator to call the bundle's port directly and block /_gina/ at the edge
        if (!ready(t)) return;
        try {
            var r = await via('default', 'POST', '/_gina/maintenance', JSON_BODY, ON);
            assert.equal(r.status, 200, show(r));
            assert.equal(await maintenanceActive(), true);
        } finally {
            await reopen();
        }
    });

    // ── 05 end state ─────────────────────────────────────────────────────────

    it('05.1  maintenance is off and the page is not closed (no 503)', async function (t) {
        if (!ready(t)) return;
        assert.equal(await maintenanceActive(), false);
        var page = await direct('GET', webroot, {});
        assert.ok(page.status !== null && page.status !== 503, show(page));
    });

    it('05.2  each gate logged its first refusal once — the admin list and the metrics list', async function (t) {
        if (!ready(t)) return;
        var until = Date.now() + 3000;
        while (Date.now() < until && (count(childOut, '`app.json > admin.allowFrom`') < 1 || count(childOut, '`app.json > metrics.allowFrom`') < 1)) { await sleep(100); }
        var relayed = childOut.split('\n').filter(function (l) { return l.indexOf('relayed by a proxy on this host') > -1; });
        assert.equal(relayed.filter(function (l) { return l.indexOf('admin.allowFrom') > -1; }).length, 1, relayed.join('\n').slice(0, 1200));
        assert.equal(relayed.filter(function (l) { return l.indexOf('metrics.allowFrom') > -1; }).length, 1, relayed.join('\n').slice(0, 1200));
    });
});
