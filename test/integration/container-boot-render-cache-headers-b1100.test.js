/**
 * #B1100 / #B1101 — a render-cache hit answers with its own `X-Request-Id` and replays no
 * `Set-Cookie`, through a booted `http/2.0` + https bundle (isaac), memory and fs entries,
 * over HTTP/1.1 and HTTP/2.
 *
 * Before the fix, a render delegate stored `res.getHeaders()` when it filled the cache and the
 * isaac pre-routing hit wrote every stored header back: each hit answered with the filling
 * request's `X-Request-Id` (an inbound id included: it was replaced), and a cookie set before
 * the render (by an action here; a CSRF token cookie set by middleware in practice) reached
 * every later visitor. The store now drops those headers and the replay skips them; the hit
 * resolves its own id (a sanitised inbound `X-Request-Id`, else a UUID).
 *
 * Arms: a cached route (memory) — a miss, a hit over HTTP/1.1, a hit over HTTP/2, a hit with a
 * valid inbound id, a hit with an invalid one; a cached route whose action appends
 * `Set-Cookie: rc-test=<token>` before `renderJSON` (memory), and the same on the fs strategy
 * (its `.meta` sidecar on disk is read too); an uncached route, the control.
 *
 * Isolation: the container-boot-request-entry-line.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14650), a self-signed certificate under that HOME,
 * project:rm + rmSync at teardown. Seam: `RC_GINA_ROOT=<tree>` boots THAT tree.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-render-cache-headers-b1100.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rch-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rch' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14650;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.RC_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;
delete CHILD_ENV.GINA_LOG_FORMAT;

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
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

/** HTTP/1.1 over TLS: a fresh connection per request, no ALPN offer of h2. */
function h1(fullPath, headers) {
    return new Promise(function (resolve) {
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: fullPath, method: 'GET', headers: headers || {},
            rejectUnauthorized: false, agent: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, body: data, headers: res.headers }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', headers: {} }); });
        req.end();
    });
}

/** HTTP/2 over the boot's session. */
function h2(fullPath, headers) {
    return new Promise(function (resolve) {
        var status = null, data = '', hdrs = {};
        var stream = h2session.request(Object.assign({ ':method': 'GET', ':path': fullPath }, headers || {}));
        stream.setTimeout(15000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (h) { status = h[':status']; hdrs = h; });
        stream.on('data', function (c) { data += c; });
        stream.on('error', function (e) { resolve({ status: null, err: e.message, body: data, headers: hdrs }); });
        stream.on('close', function () { resolve({ status: status, body: data, headers: hdrs }); });
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

/** The value of cookie `name` in a response's set-cookie list, or null. */
function cookie(res, name) {
    var list = [].concat(res.headers['set-cookie'] || []);
    for (var i = 0; i < list.length; i++) {
        var eq = String(list[i]).indexOf('=');
        if ( eq > 0 && String(list[i]).slice(0, eq) === name ) { return String(list[i]).slice(eq + 1).split(';')[0]; }
    }
    return null;
}

function isHit(res) { return /;\s*hit\b/.test(String(res.headers['cache-status'] || '')); }

/** Every fs `.meta` sidecar under the project's cache directory, as text. */
function metaFiles() {
    var found = [];
    (function walk(dir, depth) {
        if ( depth > 12 ) { return; }
        var list = [];
        try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        list.forEach(function (d) {
            var p = path.join(dir, d.name);
            if ( d.isDirectory() ) { walk(p, depth + 1); return; }
            if ( /\.meta$/.test(d.name) ) { found.push({ file: p, text: fs.readFileSync(p, 'utf8') }); }
        });
    })(path.join(PROJ_DIR, 'cache'), 0);
    return found;
}

/** Routes and actions: a cached GET, a cached GET that sets a cookie (memory, fs), an uncached GET. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.rc_cached   = { namespace: 'content', url: '/rc/cached',   method: 'GET', param: { control: 'rcFast' },   cache: { type: 'memory', ttl: 60 } };
    r.rc_cookie   = { namespace: 'content', url: '/rc/cookie',   method: 'GET', param: { control: 'rcCookie' }, cache: { type: 'memory', ttl: 60 } };
    r.rc_fs       = { namespace: 'content', url: '/rc/fs',       method: 'GET', param: { control: 'rcFsCookie' }, cache: { type: 'fs', ttl: 300 } };
    r.rc_uncached = { namespace: 'content', url: '/rc/uncached', method: 'GET', param: { control: 'rcFast' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if ( s.split(anchor).length !== 2 ) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.rcFast = function(req, res) {',
        '        self.renderJSON({ ok: true });',
        '    };',
        '    var rcAppendCookie = function(res, name) {',
        '        var token = name + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);',
        '        var prev = res.getHeader("set-cookie");',
        '        var list = prev ? [].concat(prev) : [];',
        '        list.push(name + "=" + token + "; Path=/; HttpOnly");',
        '        res.setHeader("Set-Cookie", list);',
        '        return token;',
        '    };',
        '    this.rcCookie = function(req, res) {',
        '        self.renderJSON({ ok: true, token: rcAppendCookie(res, "rc-test") });',
        '    };',
        '    this.rcFsCookie = function(req, res) {',
        '        self.renderJSON({ ok: true, token: rcAppendCookie(res, "rc-fs") });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/** protocol http/2.0 + scheme https + the render cache on, spliced after the scaffold's webroot line. */
function spliceServer(file) {
    var s = fs.readFileSync(file, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if ( m.length !== 1 ) { throw new Error('webroot anchor count ' + m.length); }
    if ( /"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s) ) { throw new Error('the scaffold already declares protocol/scheme'); }
    fs.writeFileSync(file, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https",\n    "cache": { "enable": true }'));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}

/** Boots the bundle; resolves an error string or null. */
async function boot() {
    childOut = ''; childExit = null;
    var env = Object.assign({}, CHILD_ENV, { GINA_LOG_FORMAT: 'text' });
    child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { childOut += d; });
    child.stderr.on('data', function (d) { childOut += d; });
    child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while ( Date.now() < deadline && !childExit ) {
        if ( await isTcpPortOpen(bundlePort) ) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    if ( !up ) { return 'the bundle did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000); }
    await sleep(300);
    h2session = http2.connect('https://127.0.0.1:' + bundlePort, { rejectUnauthorized: false });
    h2session.on('error', function () { /* an arm reads its own stream error */ });
    await new Promise(function (resolve) { h2session.once('connect', resolve); setTimeout(resolve, 5000); });
    return null;
}

async function stop() {
    if ( h2session ) { try { h2session.close(); } catch (e) { /* ignore */ } h2session = null; }
    if ( isChildAlive() ) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 12000;
        while ( Date.now() < until && isChildAlive() ) { await sleep(150); }
        if ( isChildAlive() ) {
            // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
            var m = childOut.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
            if ( m ) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
    child = null;
    if ( !bundlePort ) { return; }
    var free = Date.now() + 8000;
    while ( Date.now() < free && await isTcpPortOpen(bundlePort) ) { await sleep(150); }
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot-render-cache-headers-b1100 — a render-cache hit replays no per-request header', function () {

    var r = null, err = null;

    before(async function () {
        if ( process.platform === 'win32' ) { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if ( !hasOpenssl() ) { skip = true; skipReason = 'openssl is not available to mint the test certificate'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if ( !fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ] ) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if ( !fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key] ) { setupError = 'bundle:add did not register ' + key; return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if ( target !== fs.realpathSync(GINA_ROOT) ) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            installRoutes();
            spliceServer(ssFile);
            makeCertificate();
        } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/2.0']['https']; } catch (e) { bundlePort = null; }
        if ( !bundlePort ) { setupError = 'could not resolve the http/2.0 https port for ' + key; return; }
        var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
        webroot = wr.replace(/\/+$/, '') + '/';

        err = await boot();
        if ( !err ) {
            var W = webroot;
            r = {};
            r.miss          = await h1(W + 'rc/cached');
            await sleep(150);
            r.hit1          = await h1(W + 'rc/cached');
            r.hit2          = await h2(W + 'rc/cached');
            r.hitInbound    = await h1(W + 'rc/cached', { 'x-request-id': 'rc-inbound-1' });
            r.hitBadInbound = await h1(W + 'rc/cached', { 'x-request-id': 'not a valid id!' });
            r.cookieMiss    = await h1(W + 'rc/cookie');
            await sleep(150);
            r.cookieHit     = await h1(W + 'rc/cookie');
            r.cookieHitH2   = await h2(W + 'rc/cookie');
            r.fsMiss        = await h1(W + 'rc/fs');
            await sleep(400);
            r.fsHit         = await h1(W + 'rc/fs');
            r.unc1          = await h1(W + 'rc/uncached');
            r.unc2          = await h1(W + 'rc/uncached');
            r.meta          = metaFiles();
            r.alive         = isChildAlive();
        }
        await stop();
    });

    after(async function () {
        await stop();
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    it('01 - the controls: the cached route answers a miss then hits, the uncached one a fresh id each time', function (t) {
        if ( skip ) { return t.skip(skipReason); }
        assert.equal(setupError, null, setupError);
        assert.equal(err, null, err);
        assert.equal(r.miss.status, 200);
        assert.match(String(r.miss.headers['cache-status']), /fwd=uri-miss/);
        [['hit1', r.hit1], ['hit2', r.hit2], ['hitInbound', r.hitInbound], ['cookieHit', r.cookieHit], ['cookieHitH2', r.cookieHitH2]].forEach(function (p) {
            assert.equal(p[1].status, 200, p[0] + ' status');
            assert.ok(isHit(p[1]), p[0] + ' is a cache hit: ' + p[1].headers['cache-status']);
        });
        assert.ok(isHit(r.fsHit) && /detail=fs/.test(String(r.fsHit.headers['cache-status'])), 'the fs route answers a fs hit: ' + r.fsHit.headers['cache-status']);
        assert.ok(UUID_RE.test(r.unc1.headers['x-request-id']) && UUID_RE.test(r.unc2.headers['x-request-id']), 'uncached ids are UUIDs');
        assert.notEqual(r.unc1.headers['x-request-id'], r.unc2.headers['x-request-id']);
        assert.equal(r.alive, true, 'the bundle stayed up');
    });

    it('02 - #B1100: every hit answers with its own X-Request-Id; an inbound id is kept when valid', function (t) {
        if ( skip ) { return t.skip(skipReason); }
        assert.equal(err, null, err);
        var A = r.miss.headers['x-request-id'];
        assert.ok(UUID_RE.test(A), 'the miss carries a UUID');
        assert.ok(UUID_RE.test(r.hit1.headers['x-request-id']), 'the HTTP/1.1 hit carries a UUID');
        assert.notEqual(r.hit1.headers['x-request-id'], A, 'the HTTP/1.1 hit does not answer with the filler\'s id');
        assert.ok(UUID_RE.test(r.hit2.headers['x-request-id']), 'the HTTP/2 hit carries a UUID');
        assert.notEqual(r.hit2.headers['x-request-id'], A, 'the HTTP/2 hit does not answer with the filler\'s id');
        assert.notEqual(r.hit2.headers['x-request-id'], r.hit1.headers['x-request-id'], 'two hits, two ids');
        assert.equal(r.hitInbound.headers['x-request-id'], 'rc-inbound-1', 'a hit echoes a valid inbound id');
        assert.ok(UUID_RE.test(r.hitBadInbound.headers['x-request-id']), 'an invalid inbound id is replaced by a fresh UUID');
        assert.notEqual(r.hitBadInbound.headers['x-request-id'], A);
    });

    it('03 - #B1101: a cookie set before the render reaches the filling visitor only (memory and fs), and no .meta file holds it', function (t) {
        if ( skip ) { return t.skip(skipReason); }
        assert.equal(err, null, err);
        assert.ok(cookie(r.cookieMiss, 'rc-test'), 'the filling visitor gets its cookie (memory)');
        assert.equal(cookie(r.cookieHit, 'rc-test'), null, 'an HTTP/1.1 hit replays no cookie');
        assert.equal(cookie(r.cookieHitH2, 'rc-test'), null, 'an HTTP/2 hit replays no cookie');
        assert.ok(cookie(r.fsMiss, 'rc-fs'), 'the filling visitor gets its cookie (fs)');
        assert.equal(cookie(r.fsHit, 'rc-fs'), null, 'a fs hit replays no cookie');
        assert.ok(r.meta.length > 0, 'the fs entry wrote a .meta sidecar');
        r.meta.forEach(function (m) {
            assert.equal(/set-cookie|x-request-id/i.test(m.text), false, 'no per-request header in ' + path.basename(m.file));
        });
    });
});
