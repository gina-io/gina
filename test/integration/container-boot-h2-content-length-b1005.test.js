/**
 * #B1005 — a booted `http/2.0` bundle's success answers declare their `content-length` over HTTP/2 too.
 *
 * Over HTTP/1.1 Node computes the length when a response ends with its body; over HTTP/2 gina sends its answers
 * through the raw `stream.respond()` (and, for isaac's render-cache hit, the compat `response.end()`), which add
 * none. Before this change no HTTP/2 success answer carried one, so a client could not tell a body cut short from a
 * complete one: gina's own `self.query()` client checks the length since #B985, and a gina upstream that dies
 * mid-body is the case it exists for. This file boots the REAL `bin/gina-container` (isaac, the default engine) with
 * `server.protocol: "http/2.0"`, `scheme: "https"` (so `allowHTTP1` serves HTTP/1.1 clients too), swig views and the
 * render cache on, and reads the answers of renderJSON (small and large), swig, renderXML and the cache's miss and
 * hit over both protocols. Controls: a HEAD declares its length over both (the client sees the header when it is
 * sent), each answer carries its own action's marker, and the HTTP/1.1 answers carry their length before and after.
 * A 204 and a 205 declare none (one 204 from renderJSON's documented `status` key): a Node HTTP/2 client (nghttp2)
 * resets a 204 or 205 that declares a length, so a length there would turn a clean answer into a stream error; a
 * source pin checks that every delegate site skips them.
 *
 * Isolation: the container-boot-route-method.test.js shape — a throwaway HOME under os.tmpdir(), its own port window
 * (13900; the next booted window starts at 13950), a self-signed certificate under that HOME, project:rm + rmSync at
 * teardown. Seam: `GINA_B1005_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against the tree before this change, with no write to it).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-h2-content-length-b1005.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-cl-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'cl' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 13900;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.GINA_B1005_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null, h2session = null;

// a large body (several HTTP/2 DATA frames), with multi-byte characters: a length counts bytes, not characters
var BIG = new Array(4001).join('0123456789abcdefghijklmnopqrstuvwxyz-é_');


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

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function hasOpenssl() {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

/** HTTP/1.1 over TLS, a fresh connection per request: status, headers, bytes received, body. */
function h1(method, reqPath) {
    return new Promise(function (resolve) {
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: webroot + reqPath, method: method,
            rejectUnauthorized: false, agent: false
        }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                var b = Buffer.concat(chunks);
                resolve({ v: res.httpVersion, status: res.statusCode, headers: res.headers, bytes: b.length, body: b.toString('utf8') });
            });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ v: '1.1', status: null, err: e.message, headers: {}, bytes: 0, body: '' }); });
        req.end();
    });
}

/** HTTP/2 over the one session opened in before(): status, headers, bytes received, body. */
function h2(method, reqPath) {
    return new Promise(function (resolve) {
        var hdrs = {}, chunks = [];
        var stream = h2session.request({ ':method': method, ':path': webroot + reqPath });
        stream.setTimeout(15000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (x) { hdrs = x; });
        stream.on('data', function (c) { chunks.push(c); });
        stream.on('error', function (e) { resolve({ v: '2.0', status: null, err: e.message, headers: hdrs, bytes: 0, body: '' }); });
        stream.on('close', function () {
            var b = Buffer.concat(chunks);
            resolve({ v: '2.0', status: hdrs[':status'] || null, headers: hdrs, bytes: b.length, body: b.toString('utf8') });
        });
        stream.end();
    });
}

function show(r) {
    return JSON.stringify({ v: r.v, status: r.status, cl: r.headers ? r.headers['content-length'] : undefined, bytes: r.bytes,
        cs: r.headers ? r.headers['cache-status'] : undefined, err: r.err || undefined, body: (r.body || '').slice(0, 60) });
}

/** The answer came from its own action (its marker is in the body), and declares a length equal to the bytes received. */
function assertLength(r, marker) {
    assert.equal(r.status, 200, 'answered: ' + show(r));
    assert.ok(r.body.indexOf(marker) > -1, 'from its own action: ' + show(r));
    assert.notEqual(r.headers['content-length'], undefined, 'a content-length is declared: ' + show(r));
    assert.equal(Number(r.headers['content-length']), r.bytes, 'the content-length is the bytes received: ' + show(r));
}

/** Routes, actions and one swig view. */
function installScene() {
    var bdir = path.join(PROJ_DIR, 'src', BUNDLE);
    var rf = path.join(bdir, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.b1005_json  = { namespace: 'content', url: '/b1005/json',  method: 'GET', param: { control: 'b1005Json' } };
    r.b1005_big   = { namespace: 'content', url: '/b1005/big',   method: 'GET', param: { control: 'b1005Big' } };
    r.b1005_html  = { namespace: 'content', url: '/b1005/html',  method: 'GET', param: { control: 'b1005Html' } };
    r.b1005_xml   = { namespace: 'content', url: '/b1005/xml',   method: 'GET', param: { control: 'b1005Xml' } };
    r.b1005_cache = { namespace: 'content', url: '/b1005/cache', method: 'GET', cache: { type: 'memory', ttl: 60 }, param: { control: 'b1005Cache' } };
    r.b1005_204   = { namespace: 'content', url: '/b1005/nocontent', method: 'GET', param: { control: 'b1005NoContent' } };
    r.b1005_205   = { namespace: 'content', url: '/b1005/resetcontent', method: 'GET', param: { control: 'b1005ResetContent' } };
    r.b1005_204k  = { namespace: 'content', url: '/b1005/nocontentkey', method: 'GET', param: { control: 'b1005NoContentKey' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bdir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b1005Json  = function(req, res) { self.renderJSON({ rule: "b1005_json", s: "\\u00e9\\u00e9\\u00e9" }); };',
        '    this.b1005Big   = function(req, res) { self.renderJSON({ rule: "b1005_big", s: ' + JSON.stringify(BIG) + ' }); };',
        '    this.b1005Html  = function(req, res) { self.render({ title: "T\\u00e9" }); };',
        '    this.b1005Xml   = function(req, res) { self.renderXML("<r>b1005_xml \\u00e9\\u00e9\\u00e9</r>"); };',
        '    this.b1005Cache = function(req, res) { self.renderJSON({ rule: "b1005_cache", s: "\\u00e9\\u00e9\\u00e9" }); };',
        '    this.b1005NoContent    = function(req, res) { res.statusCode = 204; self.renderJSON({ rule: "b1005_204" }); };',
        '    this.b1005ResetContent = function(req, res) { res.statusCode = 205; self.renderJSON({ rule: "b1005_205" }); };',
        '    this.b1005NoContentKey = function(req, res) { self.renderJSON({ status: 204, rule: "b1005_204k" }); };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));

    var td = path.join(bdir, 'templates', 'html', 'content');
    if (!fs.existsSync(td)) { throw new Error('no templates/html/content (did view:add run?)'); }
    fs.writeFileSync(path.join(td, 'b1005_html.html'), '<p id="b1005">RULE=[b1005_html] TITLE=[{{ title }}] ééé</p>\n');
}

/** protocol http/2.0 + scheme https, and the render cache on, spliced after the scaffold's webroot line (comments kept). */
function spliceServerSettings(ssFile) {
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s) || /"cache"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol, scheme or cache'); }
    fs.writeFileSync(ssFile, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https",\n    "cache": { "enable": true }'));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot-h2-content-length — an http/2.0 bundle\'s success answers declare their length over HTTP/2 (#B1005)', function () {

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
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (va.status !== 0) { setupError = 'view:add failed: ' + (va.stderr || va.stdout).slice(-600); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            installScene();
            spliceServerSettings(ssFile);
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

    it('controls: a HEAD declares its length over both protocols, and every HTTP/1.1 answer carries its length', async function (t) {
        if (!ready(t)) return;
        var hh2 = await h2('HEAD', 'b1005/json');
        assert.equal(hh2.status, 200, show(hh2));
        assert.notEqual(hh2.headers['content-length'], undefined, 'HTTP/2 HEAD: ' + show(hh2));
        var hh1 = await h1('HEAD', 'b1005/json');
        assert.equal(hh1.status, 200, show(hh1));
        assert.equal(hh1.v, '1.1', 'the client really spoke HTTP/1.1: ' + show(hh1));
        assert.notEqual(hh1.headers['content-length'], undefined, 'HTTP/1.1 HEAD: ' + show(hh1));
        assertLength(await h1('GET', 'b1005/json'), '"b1005_json"');
        assertLength(await h1('GET', 'b1005/html'), 'RULE=[b1005_html]');
        assertLength(await h1('GET', 'b1005/xml'), 'b1005_xml');
    });

    it('renderJSON, small and large: the HTTP/2 answer declares its length (pre-fix: none)', async function (t) {
        if (!ready(t)) return;
        assertLength(await h2('GET', 'b1005/json'), '"b1005_json"');
        var big = await h2('GET', 'b1005/big');
        assertLength(big, '"b1005_big"');
        assert.ok(big.bytes > 100000, 'the large body spans several DATA frames: ' + show(big));
    });

    it('swig and renderXML: the HTTP/2 answer declares its length (pre-fix: none)', async function (t) {
        if (!ready(t)) return;
        assertLength(await h2('GET', 'b1005/html'), 'RULE=[b1005_html]');
        assertLength(await h2('GET', 'b1005/xml'), 'b1005_xml');
    });

    it('the render cache: its miss and its in-memory hit both declare their length over HTTP/2 (pre-fix: none)', async function (t) {
        if (!ready(t)) return;
        var miss = await h2('GET', 'b1005/cache');
        assertLength(miss, '"b1005_cache"');
        var hit = await h2('GET', 'b1005/cache');
        assert.ok(/; hit/.test(String(hit.headers['cache-status'])), 'control: the second answer is a cache hit: ' + show(hit));
        assertLength(hit, '"b1005_cache"');
    });

    it('a 204 and a 205 declare no length, and arrive clean over HTTP/2 (a Node client resets a 204 or 205 that declares one)', async function (t) {
        if (!ready(t)) return;
        var nc = await h2('GET', 'b1005/nocontent');
        assert.equal(nc.status, 204, 'a clean 204 over HTTP/2: ' + show(nc));
        assert.equal(nc.headers['content-length'], undefined, 'no content-length on a 204: ' + show(nc));
        var rc = await h2('GET', 'b1005/resetcontent');
        assert.equal(rc.status, 205, 'a clean 205 over HTTP/2: ' + show(rc));
        assert.equal(rc.headers['content-length'], undefined, 'no content-length on a 205: ' + show(rc));
        // the documented form: renderJSON's `status` key sets the response code and stays in the body
        var nk = await h2('GET', 'b1005/nocontentkey');
        assert.equal(nk.status, 204, 'a clean 204 from renderJSON({ status: 204 }) over HTTP/2: ' + show(nk));
        assert.equal(nk.headers['content-length'], undefined, 'no content-length on it: ' + show(nk));
        var next = await h2('GET', 'b1005/json');
        assert.equal(next.status, 200, 'control: the session still answers: ' + show(next));
        assert.ok(next.body.indexOf('"b1005_json"') > -1, 'control: from its own action: ' + show(next));
    });
});

describe('container-boot-h2-content-length — source: every HTTP/2 success site of the render delegates skips the length on a 204, 205 or 304 (#B1005)', function () {

    it('the 7 sites in the 6 delegates declare the length only when the status carries content', function () {
        var cdir = path.join(GINA_ROOT, 'framework', 'v' + require(path.join(GINA_ROOT, 'package.json')).version, 'core', 'controller');
        var files = { 'controller.render-json.js': 1, 'controller.render-nunjucks-async.js': 1, 'controller.render-nunjucks.js': 1,
            'controller.render-swig-async.js': 1, 'controller.render-swig.js': 2, 'controller.render-xml.js': 1 };
        var total = 0;
        Object.keys(files).forEach(function (f) {
            // code lines only: a comment that names the guard does not count
            var code = fs.readFileSync(path.join(cdir, f), 'utf8').split('\n').filter(function (l) { return !/^\s*(\/\/|\*)/.test(l); }).join('\n');
            var sets = code.split("['content-length'] = Buffer.byteLength(").length - 1;
            var guarded = (code.match(/&& \[204, 205, 304\]\.indexOf\(\+\w+\[':status'\]\) < 0 \) \{ \w+\['content-length'\] = Buffer\.byteLength\(/g) || []).length;
            assert.equal(sets, files[f], f + ': the HTTP/2 body sites that set a length');
            assert.equal(guarded, sets, f + ': each skips a 204, 205 or 304');
            total += guarded;
        });
        assert.equal(total, 7);
    });
});
