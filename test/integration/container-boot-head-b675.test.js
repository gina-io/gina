/**
 * #B675 — a HEAD served by a GET rule, through a booted `http/2.0` + https bundle, for
 * HTTP/1.1 AND HTTP/2 clients.
 *
 * gina serves HEAD on every rule that serves GET and runs the GET action in full. Before the
 * fix the action saw `req.get` undefined on a HEAD — processRequestData keeps a HEAD's params
 * in `req.head` — so an action reading `req.get.<param>` without a guard answered 500. The
 * unit file (test/core/head-req-get-b675.test.js) pins the alias and executes it lifted out
 * of the source; this one boots the REAL `bin/gina-container` (isaac, the default engine)
 * with `server.protocol: "http/2.0"` and `scheme: "https"`, whose `allowHTTP1` fallback also
 * serves HTTP/1.1 clients. Arms:
 *
 *   01  HTTP/1.1 — HEAD answers 200 on a static GET rule, a `:param` GET rule and a
 *       "GET, POST" `:param` rule whose actions read `req.get` unguarded (pre-fix: 500 on
 *       each); a second HEAD on the same URLs, served from the warm route cache, answers 200
 *       too. Controls: GET answers 200 with the params; HEAD on a requirement mismatch 404.
 *   02  HTTP/2 — the same, on its own URLs.
 *   03  what the action saw, reported as response headers, over each protocol: on HEAD
 *       `req.method` is still HEAD and `req.get` is `req.head` itself, holding the URL and
 *       query params the GET twin sees, on the cold and the warm path.
 *
 * Which path matched is proven, not assumed: each action reports the keys of `req.routing`,
 * and the warm route cache builds it without the top-level `control` the routing scan sets
 * (servedCold / servedWarm). Each protocol has its own URLs, because the warm route cache is
 * keyed by method + path: arms sharing a URL would read each other's cache entries.
 *
 * Isolation: the container-boot-route-method.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (10000; route-confusion uses 9950, and a bundle takes six
 * ports), a self-signed certificate under that HOME, project:rm + rmSync at teardown. Seam:
 * `B675_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT
 * tree's CLI (red-first against the main tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-head-b675.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-hd-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'hd' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10000;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B675_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

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

function parse(status, data, version, headers) {
    var json = null;
    try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
    return { status: status, body: data, json: json, version: version, headers: headers || {} };
}

/** HTTP/1.1 over TLS: a fresh connection per request, no ALPN offer of h2. */
function h1(method, reqPath) {
    return new Promise(function (resolve) {
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: webroot + reqPath, method: method,
            rejectUnauthorized: false, agent: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve(parse(res.statusCode, data, res.httpVersion, res.headers)); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null, headers: {} }); });
        req.end();
    });
}

/** HTTP/2 over the one session opened in before(). */
function h2(method, reqPath) {
    return new Promise(function (resolve) {
        var status = null, data = '', headers = {};
        var stream = h2session.request({ ':method': method, ':path': webroot + reqPath });
        stream.setTimeout(15000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (hdrs) { status = hdrs[':status']; headers = hdrs; });
        stream.on('data', function (c) { data += c; });
        stream.on('error', function (e) { resolve({ status: null, err: e.message, body: data, json: null, headers: headers }); });
        stream.on('close', function () { resolve(parse(status, data, '2.0', headers)); });
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

/**
 * One rule group per protocol. The static, item and multi actions read `req.get`
 * unguarded, as an action written for GET does; the echo action reports what it saw as
 * response headers, because a HEAD answer has no body.
 */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var num = { id: '/^[0-9]+$/' };
    var add = function (name, url, method, control, withId) {
        r[name] = { namespace: 'content', url: url, method: method, param: { control: control } };
        if (withId) { r[name].param.id = ':id'; r[name].requirements = num; }
    };
    ['a', 'b'].forEach(function (g) {
        add('b675_' + g + '_static', '/b675/' + g + '/static',    'GET',       'b675static', false);
        add('b675_' + g + '_item',   '/b675/' + g + '/items/:id', 'GET',       'b675item',   true);
        add('b675_' + g + '_multi',  '/b675/' + g + '/multi/:id', 'GET, POST', 'b675item',   true);
        add('b675_' + g + '_echo',   '/b675/' + g + '/echo/:id',  'GET',       'b675echo',   true);
    });
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    // Every action first reports the keys of `req.routing`, which tell the cold routing scan
    // from the warm route cache (see servedCold / servedWarm).
    var routingKeys = "        res.setHeader('x-b675-routing', Object.keys(req.routing || {}).sort().join(','));";
    var actions = [
        '    this.b675static = function(req, res) {',
        routingKeys,
        '        self.renderJSON({ rule: req.routing.rule, method: req.method, x: req.get.x });',
        '    };',
        '    this.b675item = function(req, res) {',
        routingKeys,
        '        self.renderJSON({ rule: req.routing.rule, method: req.method, id: req.get.id, x: req.get.x });',
        '    };',
        '    this.b675echo = function(req, res) {',
        routingKeys,
        '        var g = req.get || {};',
        "        res.setHeader('x-b675-method', String(req.method));",
        "        res.setHeader('x-b675-get-type', typeof req.get);",
        "        res.setHeader('x-b675-get-is-head', String(typeof req.get == 'object' && req.get !== null && req.get === req.head));",
        "        res.setHeader('x-b675-get-id', String(g.id));",
        "        res.setHeader('x-b675-get-x', String(g.x));",
        '        self.renderJSON({ rule: req.routing.rule, method: req.method, id: g.id, x: g.x });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
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
function hdr(r, name) { return (r && r.headers) ? r.headers[name] : undefined; }

/**
 * Which path matched the rule, read from the `req.routing` keys the action reported. The
 * cold routing scan (core/server.js) always sets a top-level `control`; the warm route
 * cache (lib/routing `getCached`) builds `req.routing` without one. Both carry `rule`,
 * which proves the header was reported at all — an absent header must not read as warm.
 *
 * @param {object} r - A response from h1() or h2()
 * @returns {string[]} The keys, or [] when the action reported none
 */
function routingKeys(r) { var v = hdr(r, 'x-b675-routing'); return v ? String(v).split(',') : []; }
function servedCold(r) { var k = routingKeys(r); return k.indexOf('rule') > -1 && k.indexOf('control') > -1; }
function servedWarm(r) { var k = routingKeys(r); return k.indexOf('rule') > -1 && k.indexOf('control') === -1; }
function show(r) {
    return JSON.stringify({ status: r.status, version: r.version, rule: rule(r), err: r.err || undefined,
        seen: { method: hdr(r, 'x-b675-method'), getType: hdr(r, 'x-b675-get-type'), getIsHead: hdr(r, 'x-b675-get-is-head'),
            id: hdr(r, 'x-b675-get-id'), x: hdr(r, 'x-b675-get-x') } });
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('26 - container-boot-head-b675 — a HEAD served by a GET rule gives the action `req.get`, over HTTP/1.1 and HTTP/2 (#B675)', function () {

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

    /**
     * HEAD on each rule whose action reads `req.get` unguarded, twice: the first request on a
     * URL is matched by the routing scan, the second is served from the warm route cache.
     */
    async function headArms(send, g, version) {
        var urls = ['b675/' + g + '/static?x=1', 'b675/' + g + '/items/5?x=1', 'b675/' + g + '/multi/5'];
        for (var pass = 0; pass < 2; ++pass) {
            for (var i = 0; i < urls.length; ++i) {
                var r = await send('HEAD', urls[i]);
                var label = (pass ? 'warm' : 'cold') + ' HEAD ' + urls[i];
                assert.equal(r.version, version, 'the client must really speak ' + version + ': ' + show(r));
                assert.equal(r.status, 200, label + ': ' + show(r));
                assert.ok(pass ? servedWarm(r) : servedCold(r), label + ' took the ' + (pass ? 'warm route cache' : 'routing scan') + ': ' + hdr(r, 'x-b675-routing'));
            }
        }
    }

    /** GET answers with the params; HEAD on a value the requirement refuses answers 404. */
    async function controlArms(send, g) {
        var r = await send('GET', 'b675/' + g + '/items/5?x=1');
        assert.equal(r.status, 200, show(r));
        assert.equal(rule(r), 'b675_' + g + '_item', show(r));
        assert.equal(r.json.id, '5');
        assert.equal(String(r.json.x), '1');
        r = await send('GET', 'b675/' + g + '/static?x=1');
        assert.equal(r.status, 200, show(r));
        assert.equal(String(r.json.x), '1');
        r = await send('HEAD', 'b675/' + g + '/items/abc');
        assert.equal(r.status, 404, 'a requirement mismatch is still refused under HEAD: ' + show(r));
    }

    /** The echo rule: GET, then HEAD through the routing scan, then HEAD from the warm route cache. */
    async function echoArms(send, g) {
        var url = 'b675/' + g + '/echo/5?x=1';
        var get = await send('GET', url);
        assert.equal(get.status, 200, show(get));
        assert.equal(hdr(get, 'x-b675-get-id'), '5', 'the GET twin: ' + show(get));
        assert.equal(hdr(get, 'x-b675-get-x'), '1', 'the GET twin: ' + show(get));

        var cold = await send('HEAD', url);
        var warm = await send('HEAD', url);
        assert.ok(servedCold(cold), 'the first HEAD took the routing scan: ' + hdr(cold, 'x-b675-routing'));
        assert.ok(servedWarm(warm), 'the second HEAD took the warm route cache: ' + hdr(warm, 'x-b675-routing'));
        [['cold', cold], ['warm', warm]].forEach(function (pair) {
            var r = pair[1], label = pair[0] + ' HEAD';
            assert.equal(r.status, 200, label + ': ' + show(r));
            assert.equal(hdr(r, 'x-b675-method'), 'HEAD', label + ': `req.method` stays HEAD: ' + show(r));
            assert.equal(hdr(r, 'x-b675-get-type'), 'object', label + ': `req.get` is set: ' + show(r));
            assert.equal(hdr(r, 'x-b675-get-is-head'), 'true', label + ': `req.get` is `req.head` itself: ' + show(r));
            assert.equal(hdr(r, 'x-b675-get-id'), '5', label + ': the URL param, as on GET: ' + show(r));
            assert.equal(hdr(r, 'x-b675-get-x'), '1', label + ': the query param, as on GET: ' + show(r));
        });
    }

    // ── 01 HTTP/1.1 ───────────────────────────────────────────────────────

    it('01.1  HTTP/1.1 — HEAD answers 200 on GET rules whose actions read req.get unguarded, cold and warm (pre-fix: 500)', async function (t) {
        if (!ready(t)) return;
        await headArms(h1, 'a', '1.1');
    });

    it('01.2  HTTP/1.1 — controls: GET answers with the params, and a requirement mismatch is refused under HEAD', async function (t) {
        if (!ready(t)) return;
        await controlArms(h1, 'a');
    });

    // ── 02 HTTP/2 ─────────────────────────────────────────────────────────

    it('02.1  HTTP/2 — HEAD answers 200 on GET rules whose actions read req.get unguarded, cold and warm (pre-fix: 500)', async function (t) {
        if (!ready(t)) return;
        await headArms(h2, 'b', '2.0');
    });

    it('02.2  HTTP/2 — controls: GET answers with the params, and a requirement mismatch is refused under HEAD', async function (t) {
        if (!ready(t)) return;
        await controlArms(h2, 'b');
    });

    // ── 03 what the action saw ────────────────────────────────────────────

    it('03.1  HTTP/1.1 — on HEAD `req.get` is `req.head` and holds what the GET twin sees, on the cold and the warm path', async function (t) {
        if (!ready(t)) return;
        await echoArms(h1, 'a');
    });

    it('03.2  HTTP/2 — on HEAD `req.get` is `req.head` and holds what the GET twin sees, on the cold and the warm path', async function (t) {
        if (!ready(t)) return;
        await echoArms(h2, 'b');
    });
});
