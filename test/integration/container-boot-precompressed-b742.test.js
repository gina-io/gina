/**
 * #B742 + #B743 — a precompressed static's Content-Encoding and Vary, live, through booted bundles
 * (three boots: two production, one dev).
 *
 * In production, gina serves `app.js.br` / `app.js.gz` in place of `app.js` over HTTP/1.x when the
 * request accepts that coding (handleStatics), and isaac serves the routing table's own copies the
 * same way, over both protocols.
 *  - #B742: a `.gz` copy went out as `Content-Encoding: gz` — the file extension without its dot,
 *    which is not a coding — and Chromium does not run such a script. It is now `gzip`.
 *  - #B743: none of those responses carried `Vary: Accept-Encoding`, so a shared cache could hand
 *    the compressed bytes to a client that did not accept them (0.7.2 serves a versioned static
 *    `public` for a year). Every production HTTP/1.x static now carries it, on the 200 and on the
 *    304 (RFC 9110 § 15.4.5), next to a configured `vary` (which completeHeaders() sets on the 200
 *    only); the routing table appends it to its `Vary: Origin`. HTTP/2 statics serve the file
 *    itself and stay without.
 *
 * Boots the REAL `bin/gina-container` on a scaffolded bundle (the asset-versioning scene's shape):
 *
 *   h1   isaac over http/1.1, prod — no configured vary
 *   h2   isaac over http/2 + TLS, prod — the project's env.json configures `"vary": "Origin"`;
 *        also asked over HTTP/1.1 through TLS, which is how a reverse proxy reaches it
 *   dev  isaac over http/1.1, dev — no precompressed copy, nothing changes
 *
 *   01  (h1) `Accept-Encoding: gzip` gets the `.gz` copy as `Content-Encoding: gzip`, and it
 *       decodes to the file;
 *   02  (h1) `br` gets the `.br` copy as `br` (the label that was already right — the control);
 *   03  (h1) every production HTTP/1.1 static varies on Accept-Encoding: the gzip, br and identity
 *       answers for a file with copies, and the answers for a file without any;
 *   04  (h1) its 304 carries the same Vary;
 *   05  (h1) the routing table answers `Vary: Origin, Accept-Encoding`, its `.gz` copy as `gzip`,
 *       and its 304 carries the same Vary;
 *   06  (h2) over HTTP/2 the static is the file itself: no Content-Encoding, `Vary: Origin` (the
 *       configured value: proof the configuration reaches the response), no Accept-Encoding;
 *   07  (h2) over HTTP/1.1 through TLS: the `.gz` copy as `gzip`, Vary listing Origin AND
 *       Accept-Encoding, once each;
 *   08  (h2) that path's 304 carries Origin and Accept-Encoding too (the configured value is not
 *       lost on revalidation);
 *   09  (h2) the routing table over HTTP/2: `Vary: Origin, Accept-Encoding` and its `.gz` copy as
 *       `gzip`;
 *   10  (dev) no copy, no Vary on statics, and the routing table keeps `Vary: Origin` alone.
 *
 * The routing-table copies are written at boot by the host's `gzip` binary; the arms that need one
 * are skipped, with the reason, when `gzip` is not installed.
 *
 * Isolation: a throwaway HOME under os.tmpdir(), its own port window (11150), project:rm + rmSync
 * at teardown; the HTTP/2 boot gets a self-signed certificate triple. Seam:
 * `B742_GINA_ROOT=<tree>` boots THAT tree (red-first against a pre-change tree).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-precompressed-b742.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var http2  = require('http2');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var zlib   = require('zlib');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b742-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'b742' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11150;

var BOOT_TIMEOUT_MS  = 40000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B742_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

/** The three boots. */
var MODES = [
    { name: 'h1',  env: 'prod', protocol: 'http/1.1', scheme: 'http' },
    { name: 'h2',  env: 'prod', protocol: 'http/2.0', scheme: 'https', configuredVary: 'Origin' },
    { name: 'dev', env: 'dev',  protocol: 'http/1.1', scheme: 'http' }
];

/** A public script with both copies, and one without any. */
var JS_NAME    = 'b742.js';
var JS_CONTENT = Buffer.from('/* #B742 fixture */\nwindow.__b742 = ' + JSON.stringify(Array.from({ length: 300 }, function (x, i) { return 'entry-' + i; })) + ';\n');
var PLAIN_NAME = 'b742plain.js';
var PLAIN_CONTENT = Buffer.from('/* #B743 fixture, no precompressed copy */\nwindow.__b742plain = true;\n');

var HAS_GZIP = spawnSync('which', ['gzip'], { encoding: 'utf8' }).status === 0;

var skip = false, skipReason = '', setupError = null;
var webroot = '/' + BUNDLE + '/';
var results = {};   // mode name -> { out, err, ... }


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

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
/** The scaffold's JSON files carry whole-line `//` comments only. */
function stripLineComments(raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }
function readConfig(file) { return JSON.parse(stripLineComments(fs.readFileSync(file, 'utf8'))); }

/**
 * One GET, the body as a Buffer, never decoded. `via`: 'h1' (plain HTTP/1.1), 'h2' (HTTP/2 over
 * TLS, one session per call) or 'h1tls' (HTTP/1.1 over TLS, ALPN http/1.1 — a reverse proxy's path
 * to an HTTP/2 bundle).
 */
function get(via, port, reqPath, headers) {
    headers = headers || {};
    if (via === 'h2') {
        return new Promise(function (resolve) {
            var session = http2.connect('https://127.0.0.1:' + port, { rejectUnauthorized: false });
            var done = false;
            var finish = function (r) { if (done) { return; } done = true; try { session.close(); } catch (e) { /* ignore */ } resolve(r); };
            session.on('error', function (e) { finish({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
            var req = session.request(Object.assign({ ':path': reqPath }, headers));
            var chunks = [], resHeaders = {};
            req.setTimeout(15000, function () { req.close(); finish({ status: null, headers: {}, body: Buffer.alloc(0), err: 'timeout' }); });
            req.on('response', function (hs) { resHeaders = hs; });
            req.on('data', function (c) { chunks.push(c); });
            req.on('end', function () { finish({ status: Number(resHeaders[':status']), headers: resHeaders, body: Buffer.concat(chunks), alpn: 'h2' }); });
            req.on('error', function (e) { finish({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
            req.end();
        });
    }
    var lib  = ( via === 'h1tls' ) ? https : http;
    var opts = { host: '127.0.0.1', port: port, path: reqPath, method: 'GET', agent: false, headers: headers };
    if (via === 'h1tls') { opts.rejectUnauthorized = false; opts.ALPNProtocols = ['http/1.1']; }
    return new Promise(function (resolve) {
        var req = lib.request(opts, function (res) {
            var chunks = [];
            var alpn = ( res.socket && res.socket.alpnProtocol ) || null;
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), httpVersion: res.httpVersion, alpn: alpn }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
        req.end();
    });
}

/** Self-signed certificate triple for the HTTP/2 boot (isaac reads all three for https). */
function writeCerts() {
    var certDir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(certDir, { recursive: true });
    var ssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
        '-keyout', path.join(certDir, 'private.key'), '-out', path.join(certDir, 'certificate.crt'),
        '-days', '2', '-subj', '/CN=localhost'], { encoding: 'utf8' });
    if (ssl.status !== 0 || !fs.existsSync(path.join(certDir, 'private.key'))) {
        throw new Error('openssl self-signed cert generation failed: ' + (ssl.stderr || ssl.status));
    }
    fs.copyFileSync(path.join(certDir, 'certificate.crt'), path.join(certDir, 'ca_bundle.crt'));
}

/** The fixture scripts, served through the bundle's public mapping. */
function installFixture() {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);
    if (!fs.existsSync(path.join(src, 'public'))) { throw new Error('no public directory under ' + src); }
    var js = path.join(src, 'public', 'js');
    fs.mkdirSync(js, { recursive: true });
    fs.writeFileSync(path.join(js, JS_NAME), JS_CONTENT);
    fs.writeFileSync(path.join(js, JS_NAME + '.gz'), zlib.gzipSync(JS_CONTENT));
    fs.writeFileSync(path.join(js, JS_NAME + '.br'), zlib.brotliCompressSync(JS_CONTENT));
    fs.writeFileSync(path.join(js, PLAIN_NAME), PLAIN_CONTENT);
}

/**
 * `server.response.header.vary` for the bundle's prod env, in the PROJECT's env.json — the
 * override block completeHeaders() reads (`conf.server.response.header`). `null` removes it.
 */
function setConfiguredVary(value) {
    var ef = path.join(PROJ_DIR, 'env.json');
    var env = fs.existsSync(ef) ? readConfig(ef) : {};
    env[BUNDLE] = env[BUNDLE] || {};
    env[BUNDLE].prod = env[BUNDLE].prod || {};
    env[BUNDLE].prod.server = env[BUNDLE].prod.server || {};
    if (value === null) {
        if (env[BUNDLE].prod.server.response && env[BUNDLE].prod.server.response.header) {
            delete env[BUNDLE].prod.server.response.header.vary;
        }
    } else {
        env[BUNDLE].prod.server.response = env[BUNDLE].prod.server.response || {};
        env[BUNDLE].prod.server.response.header = env[BUNDLE].prod.server.response.header || {};
        env[BUNDLE].prod.server.response.header.vary = value;
    }
    fs.writeFileSync(ef, JSON.stringify(env, null, 2));
}

/** Point the bundle at `mode`'s protocol, write its configured vary, then build the prod release. */
function configureAndBuild(mode) {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);
    var sf = path.join(src, 'config', 'settings.json');
    var settings = readConfig(sf);
    settings.server = Object.assign({}, settings.server, { protocol: mode.protocol, scheme: mode.scheme });
    fs.writeFileSync(sf, JSON.stringify(settings, null, 2));
    setConfiguredVary(mode.configuredVary || null);

    if (mode.env === 'dev') { return; }   // dev boots the sources
    var b = runCli(['bundle:build', BUNDLE, '@' + PROJ, '--env=prod', '--scope=local']);
    var relRoot = path.join(PROJ_DIR, 'releases', BUNDLE, 'local', 'prod');
    var built = fs.existsSync(relRoot) && fs.readdirSync(relRoot).some(function (v) {
        return fs.existsSync(path.join(relRoot, v, 'index.js'));
    });
    if (!built) { throw new Error('bundle:build produced no prod release under ' + relRoot + '\n' + (b.stdout + b.stderr).slice(-1500)); }
}

function portFor(mode) {
    var key = BUNDLE + '@' + PROJ;
    return readJSON(path.join(GINA_HOME, 'ports.reverse.json'))[key][mode.env][mode.protocol][mode.scheme];
}

/**
 * The routing table asked with `Accept-Encoding: gzip`, until its `.gz` copy (written at boot by
 * the host's gzip, asynchronously) is served — or `waitMs` runs out.
 */
async function routingGzip(via, port, waitMs) {
    var until = Date.now() + waitMs, r = null;
    do {
        r = await get(via, port, webroot + '_gina/assets/routing.json', { 'accept-encoding': 'gzip' });
        if (r.headers && r.headers['content-encoding']) { break; }
        await sleep(200);
    } while (Date.now() < until);
    return r;
}

/** Boot, drive every arm of the mode, stop. */
async function bootDriveStop(mode) {
    var port = portFor(mode);
    var out = '', exit = null;
    var childEnv = Object.assign({}, CHILD_ENV, { NODE_ENV: 'prod' });
    if (mode.env === 'dev') { delete childEnv.NODE_ENV; }   // the project's def_env (dev)
    var child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], {
        env: childEnv, cwd: FAKE_HOME, stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', function (d) { out += d; });
    child.stderr.on('data', function (d) { out += d; });
    child.on('exit', function (code, signal) { exit = { code: code, signal: signal }; });
    var alive = function () { return child.exitCode === null && child.signalCode === null; };
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while (Date.now() < deadline && !exit) {
        if (await isTcpPortOpen(port)) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    var res = { out: '', err: null };
    if (!up) {
        res.err = 'the bundle did not come up on ' + port + ': exit ' + JSON.stringify(exit) + '\n' + out.slice(-2500);
    } else {
        await sleep(300);
        var js = webroot + 'js/' + JS_NAME, plain = webroot + 'js/' + PLAIN_NAME, routing = webroot + '_gina/assets/routing.json';
        if (mode.name === 'h1' || mode.name === 'dev') {
            res.gzip     = await get('h1', port, js, { 'accept-encoding': 'gzip' });
            res.br       = await get('h1', port, js, { 'accept-encoding': 'br' });
            res.identity = await get('h1', port, js);
            res.plain    = await get('h1', port, plain);
            res.plainGz  = await get('h1', port, plain, { 'accept-encoding': 'gzip' });
            var etag = res.identity.headers && res.identity.headers.etag;
            res.revalidated = etag ? await get('h1', port, js, { 'if-none-match': etag }) : null;
            res.routing = ( mode.name === 'h1' && HAS_GZIP ) ? await routingGzip('h1', port, 5000) : await get('h1', port, routing, { 'accept-encoding': 'gzip' });
            var rEtag = res.routing.headers && res.routing.headers.etag;
            res.routing304 = rEtag ? await get('h1', port, routing, { 'if-none-match': rEtag }) : null;
        } else {
            res.h2      = await get('h2', port, js, { 'accept-encoding': 'gzip' });
            res.tlsGzip = await get('h1tls', port, js, { 'accept-encoding': 'gzip' });
            var tEtag = res.tlsGzip.headers && res.tlsGzip.headers.etag;
            res.tls304  = tEtag ? await get('h1tls', port, js, { 'if-none-match': tEtag }) : null;
            res.routing = HAS_GZIP ? await routingGzip('h2', port, 5000) : await get('h2', port, routing, { 'accept-encoding': 'gzip' });
        }
    }
    if (alive()) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 12000;
        while (Date.now() < until && alive()) { await sleep(150); }
        if (alive()) {
            var m = out.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
            if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
    var free = Date.now() + 8000;
    while (Date.now() < free && await isTcpPortOpen(port)) { await sleep(150); }
    res.out = out;
    return res;
}

function header(r, name) { return (r && r.headers && r.headers[name]) || undefined; }
/** The Vary list, lower-cased and trimmed ([] when absent). */
function varyOf(r) {
    var v = header(r, 'vary');
    if (Array.isArray(v)) { v = v.join(','); }
    return ( typeof v === 'string' && v.trim() !== '' ) ? v.split(',').map(function (s) { return s.trim().toLowerCase(); }) : [];
}
function brief(r) {
    return r ? (r.status + ' ce=' + header(r, 'content-encoding') + ' vary=' + JSON.stringify(header(r, 'vary')) + ( r.err ? ' err=' + r.err : '' )) : 'no response';
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('29 - container-boot-precompressed-b742 — Content-Encoding names the coding, Vary: Accept-Encoding, live (#B742 #B743)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (spawnSync('openssl', ['version'], { encoding: 'utf8' }).status !== 0) { skip = true; skipReason = 'openssl is not available (the HTTP/2 boot needs a certificate)'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (!fs.existsSync(path.join(PROJ_DIR, 'src', BUNDLE, 'templates', 'html', 'layouts', 'main.html'))) {
            setupError = 'view:add did not install the templates: ' + (va.stdout + va.stderr).slice(-800); return;
        }
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }
        try {
            var ss = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr = (ss.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
        try { installFixture(); } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }
        try { writeCerts(); } catch (e) { setupError = e.message; return; }

        for (var i = 0; i < MODES.length; ++i) {
            try { configureAndBuild(MODES[i]); }
            catch (e) { setupError = MODES[i].name + ': ' + e.message; return; }
            results[MODES[i].name] = await bootDriveStop(MODES[i]);
        }
    });

    after(async function () {
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    function ready(t) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        return true;
    }
    function booted(name) {
        var r = results[name];
        assert.ok(r, 'the ' + name + ' boot ran');
        assert.equal(r.err, null, name + ': ' + r.err);
        return r;
    }

    // ── h1 ───────────────────────────────────────────────────────────────────

    it('01 - h1: `Accept-Encoding: gzip` gets the .gz copy as `Content-Encoding: gzip`, which decodes to the file', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1').gzip;
        assert.equal(r.status, 200, brief(r));
        assert.equal(header(r, 'content-encoding'), 'gzip', brief(r));
        assert.ok(zlib.gunzipSync(r.body).equals(JS_CONTENT), 'the body gunzips to the file');
    });

    it('02 - h1: `br` gets the .br copy as `br` (the control: that label was already right)', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1').br;
        assert.equal(r.status, 200, brief(r));
        assert.equal(header(r, 'content-encoding'), 'br', brief(r));
        assert.ok(zlib.brotliDecompressSync(r.body).equals(JS_CONTENT), 'the body decodes to the file');
    });

    it('03 - h1: every production static varies on Accept-Encoding, with a copy served or not', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1');
        assert.ok(!header(r.identity, 'content-encoding') && r.identity.body.equals(JS_CONTENT), 'identity: the file itself — ' + brief(r.identity));
        assert.ok(!header(r.plainGz, 'content-encoding') && r.plainGz.body.equals(PLAIN_CONTENT), 'no copy on disk: the file itself — ' + brief(r.plainGz));
        [['gzip', r.gzip], ['br', r.br], ['identity', r.identity], ['plain', r.plain], ['plain, gzip asked', r.plainGz]].forEach(function (x) {
            assert.equal(x[1].status, 200, x[0] + ': ' + brief(x[1]));
            assert.deepEqual(varyOf(x[1]), ['accept-encoding'], x[0] + ': ' + brief(x[1]));
        });
    });

    it('04 - h1: the 304 carries the Vary of its 200', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1').revalidated;
        assert.ok(r, 'the identity 200 carried an ETag (control)');
        assert.equal(r.status, 304, brief(r));
        assert.deepEqual(varyOf(r), ['accept-encoding'], brief(r));
    });

    it('05 - h1: the routing table answers `Vary: Origin, Accept-Encoding`, its .gz copy as `gzip`, and its 304 the same Vary', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1');
        assert.equal(r.routing.status, 200, brief(r.routing));
        assert.deepEqual(varyOf(r.routing), ['origin', 'accept-encoding'], brief(r.routing));
        assert.ok(r.routing304, 'the routing table carried an ETag (control)');
        assert.equal(r.routing304.status, 304, brief(r.routing304));
        assert.deepEqual(varyOf(r.routing304), ['origin', 'accept-encoding'], brief(r.routing304));
        if (!HAS_GZIP) { t.diagnostic('gzip is not installed: the routing table has no .gz copy to label'); return; }
        assert.equal(header(r.routing, 'content-encoding'), 'gzip', brief(r.routing));
        assert.ok(JSON.parse(zlib.gunzipSync(r.routing.body).toString('utf8')), 'the body gunzips to the JSON table');
    });

    // ── h2 (configured vary: Origin) ─────────────────────────────────────────

    it('06 - h2: over HTTP/2 the static is the file itself, with the configured `Vary: Origin` and no Accept-Encoding', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h2').h2;
        assert.equal(r.status, 200, brief(r));
        assert.ok(!header(r, 'content-encoding') && r.body.equals(JS_CONTENT), 'the file itself — ' + brief(r));
        assert.deepEqual(varyOf(r), ['origin'], 'the configured value reaches the response (the control for 07/08) — ' + brief(r));
    });

    it('07 - h2: over HTTP/1.1 through TLS (a reverse proxy\'s path) the .gz copy goes out as `gzip`, varying on Origin and Accept-Encoding', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h2').tlsGzip;
        assert.equal(r.status, 200, brief(r));
        assert.equal(r.httpVersion, '1.1', 'answered over HTTP/1.1 (control): ' + r.httpVersion + ' alpn=' + r.alpn);
        assert.equal(header(r, 'content-encoding'), 'gzip', brief(r));
        assert.ok(zlib.gunzipSync(r.body).equals(JS_CONTENT), 'the body gunzips to the file');
        assert.deepEqual(varyOf(r).slice().sort(), ['accept-encoding', 'origin'], brief(r));
    });

    it('08 - h2: that path\'s 304 carries Origin and Accept-Encoding (a cache keeps both on revalidation)', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h2').tls304;
        assert.ok(r, 'the 200 carried an ETag (control)');
        assert.equal(r.status, 304, brief(r));
        assert.deepEqual(varyOf(r).slice().sort(), ['accept-encoding', 'origin'], brief(r));
    });

    it('09 - h2: the routing table over HTTP/2 answers `Vary: Origin, Accept-Encoding` and its .gz copy as `gzip`', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h2').routing;
        assert.equal(r.status, 200, brief(r));
        assert.deepEqual(varyOf(r), ['origin', 'accept-encoding'], brief(r));
        if (!HAS_GZIP) { t.diagnostic('gzip is not installed: the routing table has no .gz copy to label'); return; }
        assert.equal(header(r, 'content-encoding'), 'gzip', brief(r));
        assert.ok(JSON.parse(zlib.gunzipSync(r.body).toString('utf8')), 'the body gunzips to the JSON table');
    });

    // ── dev ──────────────────────────────────────────────────────────────────

    it('10 - dev: no copy and no Vary on statics; the routing table keeps `Vary: Origin` alone (the control)', function (t) {
        if (!ready(t)) { return; }
        var r = booted('dev');
        [['gzip', r.gzip], ['br', r.br], ['identity', r.identity], ['plain', r.plain]].forEach(function (x) {
            assert.equal(x[1].status, 200, x[0] + ': ' + brief(x[1]));
            assert.equal(header(x[1], 'content-encoding'), undefined, x[0] + ': ' + brief(x[1]));
            assert.deepEqual(varyOf(x[1]), [], x[0] + ': ' + brief(x[1]));
        });
        assert.equal(r.routing.status, 200, brief(r.routing));
        assert.deepEqual(varyOf(r.routing), ['origin'], brief(r.routing));
    });
});
