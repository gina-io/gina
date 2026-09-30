/**
 * #B722 — isaac's own event streams answer HTTP/2 clients, through a booted `http/2.0` + https
 * bundle.
 *
 * The defect: `/_gina/logs` and `/_gina/agent` (and `/_gina/release/events`, same code — unit
 * file test/core/isaac-event-streams-h2-b722.test.js) passed `connection: keep-alive` to node's
 * HTTP/2 `respond()`, which throws `ERR_HTTP2_INVALID_CONNECTION_HEADERS` on a connection-specific
 * header. lib/proc.js logged the throw as a warn (`[ SERVER ][ HTTP2 UNCAUGHT EXCEPTION ]`) and
 * the client never received response headers; over HTTP/1.1 the same handlers streamed.
 *
 * Instrument: an event stream is read to its first chunk only (the `:ok` comment every stream
 * opens with); no answer in 5 s is a failure. The bundle's own output is read for node's error.
 *
 * Arms (ONE boot of the REAL `bin/gina-container` — isaac, the default engine — with
 * `server.protocol: "http/2.0"` and `scheme: "https"`, whose `allowHTTP1` fallback also serves
 * HTTP/1.1 clients; the scaffold's dev env, so the dev gate is open):
 *   00  controls: the health check answers an HTTP/2 client (the client speaks h2 and isaac
 *       answers it); `/_gina/logs` streams to an HTTP/1.1 client (the handler works)
 *   01  `/_gina/logs` and `/_gina/agent` stream to an HTTP/2 client (pre-fix: no answer);
 *       `/_gina/logs?x=1` too — with #B712 the query form reaches isaac's handler (before
 *       #B712, core/server.js answered it, so this arm guards the pair, not #B722 alone)
 *   02  the bundle logged no ERR_HTTP2_INVALID_CONNECTION_HEADERS (pre-fix: logged for each HTTP/2
 *       stream request)
 *
 * Isolation: the b675 live test's shape — a throwaway HOME under os.tmpdir(), its own port
 * window (11050), a self-signed certificate under that HOME, project:rm + rmSync at teardown.
 * Seam: `B722_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT
 * tree's CLI (red-first: point it at a tree without the fix).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-sse-h2-b722.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var https  = require('https');
var http2  = require('http2');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn, execFileSync } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-es-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'es' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11050;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;
var STREAM_WAIT_MS   = 5000;

var GINA_ROOT = process.env.B722_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null;
var child = null, childOut = '', childExit = null, h2session = null;


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

/** HTTP/1.1 over TLS, no ALPN offer of h2; an event stream resolves on its first chunk. */
function h1(reqPath) {
    return new Promise(function (resolve) {
        var done = false;
        function fin(r) { if (!done) { done = true; resolve(r); } }
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: 'GET', rejectUnauthorized: false, agent: false
        }, function (res) {
            var body = '', sse = /event-stream/.test(res.headers['content-type'] || '');
            res.on('data', function (c) {
                body += c;
                if (sse) { fin({ status: res.statusCode, version: res.httpVersion, headers: res.headers, body: body }); req.destroy(); }
            });
            res.on('end', function () { fin({ status: res.statusCode, version: res.httpVersion, headers: res.headers, body: body }); });
        });
        req.setTimeout(STREAM_WAIT_MS, function () { req.destroy(new Error('no answer in ' + STREAM_WAIT_MS + ' ms')); });
        req.on('error', function (e) { fin({ status: null, err: e.message, headers: {}, body: '' }); });
        req.end();
    });
}

/** HTTP/2 over the one session opened in before(); an event stream resolves on its first chunk. */
function h2(reqPath) {
    return new Promise(function (resolve) {
        var done = false, status = null, headers = {}, body = '', sse = false;
        function fin(r) { if (!done) { done = true; resolve(r); } }
        var stream = h2session.request({ ':method': 'GET', ':path': reqPath });
        stream.setTimeout(STREAM_WAIT_MS, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (h) { status = h[':status']; headers = h; sse = /event-stream/.test(h['content-type'] || ''); });
        stream.on('data', function (c) {
            body += c;
            if (sse) { fin({ status: status, version: '2.0', headers: headers, body: body }); stream.close(http2.constants.NGHTTP2_CANCEL); }
        });
        stream.on('error', function (e) { fin({ status: status, version: '2.0', err: e.message, headers: headers, body: body }); });
        stream.on('close', function () { fin({ status: status, version: '2.0', headers: headers, body: body, rst: stream.rstCode }); });
        stream.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function hasOpenssl() {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

/** protocol http/2.0 + scheme https, spliced after the scaffold's webroot line (comments kept). */
function spliceHttp2(ssFile) {
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol/scheme'); }
    fs.writeFileSync(ssFile, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https"'));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}

function show(r) {
    return JSON.stringify({ status: r.status, version: r.version, ctype: r.headers && r.headers['content-type'],
        body: (r.body || '').slice(0, 24), rst: r.rst, err: r.err || undefined });
}

function assertStreams(r, version, label) {
    assert.equal(r.version, version, label + ': the client must really speak ' + version + ': ' + show(r));
    assert.equal(r.status, 200, label + ': ' + show(r));
    assert.match(String(r.headers['content-type'] || ''), /^text\/event-stream/, label + ': ' + show(r));
    assert.ok((r.body || '').indexOf(':ok') === 0, label + ': the stream opens with its `:ok` comment: ' + show(r));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('36 - container-boot-sse-h2-b722 — isaac\'s own event streams answer HTTP/2 clients on an http/2.0 bundle (#B722)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (!hasOpenssl()) { skip = true; skipReason = 'openssl is not available to mint the test certificate'; return; }
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
        if (env !== 'dev') { setupError = 'the scaffold\'s default env is ' + env + ', not dev: the dev gate would be closed'; return; }
        try {
            spliceHttp2(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'));
            makeCertificate();
        } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        try { bundlePort = readJSON(portsReversePath)[key][env]['http/2.0']['https']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/2.0 https port for ' + key; return; }

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

        h2session = http2.connect('https://127.0.0.1:' + bundlePort, { rejectUnauthorized: false });
        h2session.on('error', function () { /* an arm reads its own stream error */ });
        await new Promise(function (resolve) { h2session.once('connect', resolve); setTimeout(resolve, 5000); });
    });

    after(async function () {
        if (h2session) { try { h2session.close(); } catch (e) { /* ignore */ } }
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

    // ── 00 controls ───────────────────────────────────────────────────────

    it('00.1  control: the health check answers an HTTP/2 client', async function (t) {
        if (!ready(t)) return;
        var r = await h2('/_gina/health/check');
        assert.equal(r.version, '2.0');
        assert.equal(r.status, 200, show(r));
        assert.equal(JSON.parse(r.body).status, 'healthy', show(r));
    });

    it('00.2  control: /_gina/logs streams to an HTTP/1.1 client', async function (t) {
        if (!ready(t)) return;
        assertStreams(await h1('/_gina/logs'), '1.1', 'logs over HTTP/1.1');
    });

    // ── 01 the streams over HTTP/2 ────────────────────────────────────────

    it('01.1  /_gina/logs streams to an HTTP/2 client (pre-fix: no answer)', async function (t) {
        if (!ready(t)) return;
        assertStreams(await h2('/_gina/logs'), '2.0', 'logs over HTTP/2');
    });

    it('01.2  /_gina/agent streams to an HTTP/2 client (pre-fix: no answer)', async function (t) {
        if (!ready(t)) return;
        assertStreams(await h2('/_gina/agent'), '2.0', 'agent over HTTP/2');
    });

    it('01.3  /_gina/logs?x=1 streams to an HTTP/2 client (the #B712 query form, now answered by isaac)', async function (t) {
        if (!ready(t)) return;
        assertStreams(await h2('/_gina/logs?x=1'), '2.0', 'logs?x=1 over HTTP/2');
    });

    // ── 02 the bundle's own output ────────────────────────────────────────

    it('02.1  the bundle logged no ERR_HTTP2_INVALID_CONNECTION_HEADERS (pre-fix: logged for each HTTP/2 stream request)', async function (t) {
        if (!ready(t)) return;
        await sleep(300);
        var hits = childOut.split('ERR_HTTP2_INVALID_CONNECTION_HEADERS').length - 1;
        assert.equal(hits, 0, 'node refused a stream\'s headers ' + hits + ' time(s)');
        assert.ok(isChildAlive(), 'the bundle is still up');
    });
});
