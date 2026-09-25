/**
 * #B645 — route method enforcement through a booted `http/2.0` + https bundle, for
 * HTTP/1.1 AND HTTP/2 clients.
 *
 * The unit file (test/core/route-method-b645.test.js) pins the source and executes the
 * extracted derivations; this one boots the REAL `bin/gina-container` (isaac, the
 * default engine) with `server.protocol: "http/2.0"` and `scheme: "https"`. That keeps
 * the HTTP/2 server's `allowHTTP1` fallback on, so HTTP/1.1 clients are served too —
 * directly, or through a reverse proxy speaking HTTP/1.1 upstream. Arms:
 *
 *   01  HTTP/1.1 — a wrong method on a single-method static rule answers 404, and a
 *       same-URL GET/POST pair dispatches by method (pre-fix: the first static rule
 *       whose URL matched ran for ANY method)
 *   02  HTTP/2 — the same shapes on their own URLs: the reference behaviour, green
 *       before and after the fix
 *   03  one HTTP/1.1 request no longer leaves the wrong rule as the warm route-cache
 *       answer for HTTP/2 clients of that method and path
 *   04  an HTTP/1.1 CORS preflight is answered 204 like an HTTP/2 one (pre-fix: it was
 *       routed, and the POST-only action ran for the OPTIONS request)
 *
 * Every rule group has its own URLs, because the warm route cache is keyed by method +
 * path: arms sharing a URL would read each other's cache entries.
 *
 * Isolation: the container-boot-request-parsing.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (9900; request-parsing uses 9850), a self-signed
 * certificate under that HOME, project:rm + rmSync at teardown. Seam:
 * `B645_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by
 * THAT tree's CLI (red-first against the main tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-route-method.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rm-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rm' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 9900;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B645_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null, h2session = null;

var FORM = { 'content-type': 'application/x-www-form-urlencoded' };


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

function parse(status, data, version) {
    var json = null;
    try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
    return { status: status, body: data, json: json, version: version };
}

/** HTTP/1.1 over TLS: a fresh connection per request, no ALPN offer of h2. */
function h1(method, reqPath, body, headers) {
    return new Promise(function (resolve) {
        var h = Object.assign({}, headers || {});
        if (body != null) { h['content-length'] = Buffer.byteLength(body); }
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: webroot + reqPath, method: method,
            headers: h, rejectUnauthorized: false, agent: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve(parse(res.statusCode, data, res.httpVersion)); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        if (body != null) { req.write(body); }
        req.end();
    });
}

/** HTTP/2 over the one session opened in before(). */
function h2(method, reqPath, body, headers) {
    return new Promise(function (resolve) {
        var h = Object.assign({ ':method': method, ':path': webroot + reqPath }, headers || {});
        var status = null, data = '';
        var stream = h2session.request(h);
        stream.setTimeout(15000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (hdrs) { status = hdrs[':status']; });
        stream.on('data', function (c) { data += c; });
        stream.on('error', function (e) { resolve({ status: null, err: e.message, body: data, json: null }); });
        stream.on('close', function () { resolve(parse(status, data, '2.0')); });
        if (body != null) { stream.write(body); }
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

/** One rule per group and shape; every rule runs the same echo action. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var add = function (name, url, method, extra) {
        r[name] = Object.assign({ namespace: 'content', url: url, method: method, param: { control: 'b645echo' } }, extra || {});
    };
    ['a', 'b'].forEach(function (g) {
        add('b645_' + g + '_getonly',  '/' + g + '/getonly',  'GET');
        add('b645_' + g + '_postonly', '/' + g + '/postonly', 'POST');
        add('b645_' + g + '_list',     '/' + g + '/notes',    'GET');    // declared before its same-URL POST twin
        add('b645_' + g + '_create',   '/' + g + '/notes',    'POST');
        add('b645_' + g + '_multi',    '/' + g + '/multi',    'GET, POST');
        add('b645_' + g + '_item',     '/' + g + '/items/:id', 'GET', { requirements: { id: '/^[0-9]+$/' }, param: { control: 'b645echo', id: ':id' } });
        add('b645_' + g + '_multiitem', '/' + g + '/multiitems/:id', 'GET, POST', { requirements: { id: '/^[0-9]+$/' }, param: { control: 'b645echo', id: ':id' } });
    });
    add('b645_c_postonly', '/c/postonly', 'POST');
    add('b645_d_postonly', '/d/postonly', 'POST');
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = [
        '    this.b645echo = function(req, res) {',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || null, method: req.method, httpVersion: req.httpVersion });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));
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

/** Which rule answered, or null. */
function rule(r) { return (r && r.json && r.json.rule) ? r.json.rule.replace(/@.*$/, '') : null; }
function show(r) { return JSON.stringify({ status: r.status, version: r.version, rule: rule(r), err: r.err || undefined }); }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('23 - container-boot-route-method — method checks on an http/2.0 bundle for HTTP/1.1 and HTTP/2 clients (#B645)', function () {

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

        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            installRoutes();
            spliceHttp2(ssFile);
            makeCertificate();
        } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/2.0']['https']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/2.0 https port for ' + key; return; }
        try {
            var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }

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

    // ── 01 HTTP/1.1 ───────────────────────────────────────────────────────

    it('01.1  controls — the right method reaches each rule over HTTP/1.1', async function (t) {
        if (!ready(t)) return;
        var r = await h1('GET', 'a/getonly');
        assert.equal(r.version, '1.1', 'the client must really speak HTTP/1.1: ' + show(r));
        assert.equal(rule(r), 'b645_a_getonly', show(r));
        r = await h1('POST', 'a/postonly', 'x=1', FORM);
        assert.equal(rule(r), 'b645_a_postonly', show(r));
        r = await h1('GET', 'a/notes');
        assert.equal(rule(r), 'b645_a_list', show(r));
        r = await h1('HEAD', 'a/getonly');
        assert.equal(r.status, 200, 'HEAD still reaches a GET rule: ' + show(r));
    });

    it('01.2  POST and PUT on a GET-only static rule answer 404 over HTTP/1.1 (pre-fix: the GET action ran)', async function (t) {
        if (!ready(t)) return;
        var r = await h1('POST', 'a/getonly', 'x=1', FORM);
        assert.equal(r.status, 404, show(r));
        r = await h1('PUT', 'a/getonly', 'x=1', FORM);
        assert.equal(r.status, 404, show(r));
    });

    it('01.3  GET on a POST-only static rule answers 404 over HTTP/1.1 (pre-fix: the POST action ran)', async function (t) {
        if (!ready(t)) return;
        var r = await h1('GET', 'a/postonly');
        assert.equal(r.status, 404, show(r));
    });

    it('01.4  POST on a same-URL GET/POST pair reaches the POST rule over HTTP/1.1 (pre-fix: the GET rule, declared first)', async function (t) {
        if (!ready(t)) return;
        var r = await h1('POST', 'a/notes', 'x=1', FORM);
        assert.equal(rule(r), 'b645_a_create', show(r));
    });

    it('01.5  a method outside a multi-method rule is refused over HTTP/1.1 the way HTTP/2 refuses it (pre-fix: the rule ran)', async function (t) {
        if (!ready(t)) return;
        var ref = await h2('DELETE', 'b/multi');
        var r   = await h1('DELETE', 'a/multi');
        assert.notEqual(rule(ref), 'b645_b_multi', 'reference: HTTP/2 must not run the rule: ' + show(ref));
        assert.equal(r.status, ref.status, 'HTTP/1.1 ' + show(r) + ' vs HTTP/2 ' + show(ref));
        assert.equal(rule(r), null, show(r));
    });

    it('01.6  control — a single-method placeholder rule was never affected: POST /items/5 answers 404', async function (t) {
        if (!ready(t)) return;
        assert.equal((await h1('POST', 'a/items/5', 'x=1', FORM)).status, 404);
        assert.equal(rule(await h1('GET', 'a/items/5')), 'b645_a_item');
    });

    it('01.7  a method outside a multi-method placeholder rule is refused over HTTP/1.1 the way HTTP/2 refuses it (pre-fix: the rule ran)', async function (t) {
        if (!ready(t)) return;
        var ref = await h2('DELETE', 'b/multiitems/5');
        var r   = await h1('DELETE', 'a/multiitems/5');
        assert.notEqual(rule(ref), 'b645_b_multiitem', 'reference: HTTP/2 must not run the rule: ' + show(ref));
        assert.equal(r.status, ref.status, 'HTTP/1.1 ' + show(r) + ' vs HTTP/2 ' + show(ref));
        assert.equal(rule(r), null, show(r));
        assert.equal(rule(await h1('POST', 'a/multiitems/5', 'x=1', FORM)), 'b645_a_multiitem', 'a declared method still reaches it');
    });

    // ── 02 HTTP/2 — the reference behaviour, on its own URLs ─────────────

    it('02.1  HTTP/2 — wrong methods answer 404 and the same-URL pair dispatches by method', async function (t) {
        if (!ready(t)) return;
        var r = await h2('GET', 'b/getonly');
        assert.equal(r.version, '2.0'); assert.equal(rule(r), 'b645_b_getonly', show(r));
        assert.equal((await h2('POST', 'b/getonly', 'x=1', FORM)).status, 404);
        assert.equal((await h2('PUT', 'b/getonly', 'x=1', FORM)).status, 404);
        assert.equal((await h2('GET', 'b/postonly')).status, 404);
        assert.equal(rule(await h2('POST', 'b/postonly', 'x=1', FORM)), 'b645_b_postonly');
        assert.equal(rule(await h2('GET', 'b/notes')), 'b645_b_list');
        assert.equal(rule(await h2('POST', 'b/notes', 'x=1', FORM)), 'b645_b_create');
    });

    // ── 03 the warm route cache ───────────────────────────────────────────

    it('03.1  one HTTP/1.1 request no longer makes the wrong rule the warm answer for HTTP/2 clients', async function (t) {
        if (!ready(t)) return;
        var before = await h2('GET', 'c/postonly');
        var prime  = await h1('GET', 'c/postonly');
        var after  = await h2('GET', 'c/postonly');
        assert.equal(before.status, 404, 'cold, over HTTP/2: ' + show(before));
        // the discriminator: pre-fix the HTTP/1.1 request left `GET:<path>` → the POST-only rule in
        // the warm cache, and this HTTP/2 client was served from it
        assert.equal(after.status, 404, 'the next HTTP/2 client must still be refused: ' + show(after));
        assert.equal(prime.status, 404, 'the HTTP/1.1 request itself: ' + show(prime));
        assert.equal(rule(await h2('POST', 'c/postonly', 'x=1', FORM)), 'b645_c_postonly', 'the rule itself still answers POST');
    });

    // ── 04 CORS preflight ─────────────────────────────────────────────────

    it('04.1  an HTTP/1.1 preflight is answered 204 without running the action (pre-fix: routed, and the POST-only action ran)', async function (t) {
        if (!ready(t)) return;
        var pre = { 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type', origin: 'https://client.example' };
        var ref = await h2('OPTIONS', 'd/postonly', null, pre);
        assert.equal(ref.status, 204, 'reference: HTTP/2 ' + show(ref));
        var r = await h1('OPTIONS', 'd/postonly', null, pre);
        assert.equal(r.status, 204, show(r));
        assert.equal(rule(r), null, 'the action must not run for a preflight: ' + show(r));
    });
});
