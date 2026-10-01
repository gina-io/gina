/**
 * #P48 — versioned asset URLs, live, through booted bundles (four boots: three production, one dev).
 *
 * A consumer site served every script and stylesheet with `no-cache` because the URLs gina emits
 * carry no version, so a long max-age would serve stale code after a deploy: a returning visitor
 * re-asked for every asset on every page. #P48 appends a content token to every asset URL gina
 * emits (`?v=<10 hex of the file's sha384>`), answers `immutable` on the statics it serves itself
 * when the requested token matches the file it serves, and versions the client routing-table fetch
 * the same way (its token rides `data-gina-routing-v` on gina's own script tag, rendered per
 * request). This scene boots the REAL `bin/gina-container` on a scaffolded bundle with views, in
 * prod (a `bundle:build --env=prod` release, `NODE_ENV=prod`) or dev (the sources), once per mode:
 *
 *   h1   isaac over http/1.1, prod — versioning ON (the default)
 *   h2   isaac over http/2 + TLS, prod — versioning ON (the handleStatics HTTP/2 branch, the fast path)
 *   off  isaac over http/1.1, prod — `templates.json > _common > assetVersioningEnabled: false`
 *   dev  isaac over http/1.1, dev — versioning left ON in the config, never applied (cacheless)
 *
 *   01  every same-origin <script src> / <link href> gina EMITS has `?v=<10 hex>` — gina's own
 *       gina.min.js / gina.min.css (served through the framework's DIRECTORY mapping
 *       `/js/vendor/gina/`), the scaffold's declared assets and the handler script. Tags a
 *       layout hand-writes (the scaffold's manifest and icon links) are out of scope;
 *   02  each token is the first 10 hex of the sha384 of the bytes the server returns for it
 *       (handlers excluded: they are wrapped at serve time) — the token tracks CONTENT;
 *   03  the versioned URL answers 200 + `public, max-age=31536000, immutable`;
 *   04  the same path with a WRONG token answers 200 + `no-cache` + an ETag (never immutable
 *       under a token that does not name the bytes served);
 *   05  the same path without a token answers exactly as before #P48: an ETag and no
 *       Cache-Control (the control);
 *   06  a revalidation (If-None-Match) of the versioned URL answers 304 — over HTTP/2 with the
 *       immutable Cache-Control its 200 carries, over HTTP/1.1 bare (that 304 is decided before a
 *       precompressed sibling is picked, and a bare 304 keeps what the browser stored);
 *   07  gina's own script tag carries `data-gina-routing-v` (10 hex, once per page), and the routing
 *       table answers `immutable` for that token, `no-cache` for a wrong one and for none (today's
 *       contract);
 *   08  (off) no URL carries `?v=`, the page carries no routing token, and the statics answer
 *       exactly as before;
 *   09  (h1) a precompressed sibling (`.br`) not older than its source is served `immutable` under
 *       the source's token; one older than its source (a stale sibling) revalidates;
 *   10  (h1) a browser's request (Accept-Encoding: gzip, deflate, br) for gina.min.js /
 *       gina.min.css gets the dist's `.br` sibling, `immutable`;
 *   11  (h1) a sibling carrying its source's mtime truncated to the second (what a compressor that
 *       keeps the source's timestamp leaves) is the same generation: `immutable`;
 *   12  (h1, LAST) #B707 — a GET for `…/_gina/assets/Routing.json` answers 200 and the bundle keeps
 *       answering (it was an uncaughtException that killed the bundle);
 *   13  (h2) the page's `link` preload header names exactly the tags' versioned URLs;
 *   14  (dev) no URL carries `?v=`, no routing token, and the statics answer `no-store`.
 *
 * Isolation: the container-boot-swig-autoescape shape — a throwaway HOME under os.tmpdir(), its
 * own port window (10400), project:rm + rmSync at teardown; the HTTP/2 boot gets a self-signed
 * certificate triple (the perf harness recipe). Seam: `P48_GINA_ROOT=<tree>` boots THAT tree
 * (red-first against a pre-change tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-asset-versioning.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var http2  = require('http2');
var crypto = require('crypto');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var zlib   = require('zlib');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-p48-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'p48' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 10400;

var BOOT_TIMEOUT_MS  = 40000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.P48_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var IMMUTABLE = 'max-age=31536000, immutable';
var WRONG     = '0000000000';

/** The four boots. */
var MODES = [
    { name: 'h1',  env: 'prod', protocol: 'http/1.1', scheme: 'http',  versioning: true },
    { name: 'h2',  env: 'prod', protocol: 'http/2.0', scheme: 'https', versioning: true },
    { name: 'off', env: 'prod', protocol: 'http/1.1', scheme: 'http',  versioning: false },
    { name: 'dev', env: 'dev',  protocol: 'http/1.1', scheme: 'http',  versioning: true }
];

/** The precompressed-sibling fixture: a public script and its brotli copy, requested by path. */
var SIB_NAME    = 'p48sib.js';
var SIB_CONTENT = '/* #P48 sibling fixture */\nwindow.__p48sib = ' + JSON.stringify(Array.from({ length: 200 }, function (x, i) { return 'entry-' + i; })) + ';\n';

var skip = false, skipReason = '', setupError = null;
var webroot = '/' + BUNDLE + '/';
var results = {};   // mode name -> { page, assets: [...], routing: {...}, out, err }


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
 * One GET, the body as a Buffer. HTTP/1.1 through a fresh socket; HTTP/2 through one session per
 * call (TLS, self-signed). No Accept-Encoding: the identity bytes, so a sha384 of the body is the
 * sha384 of the file.
 */
function get(mode, port, reqPath, headers) {
    headers = headers || {};
    if (mode.protocol === 'http/2.0') {
        return new Promise(function (resolve) {
            var session = http2.connect('https://127.0.0.1:' + port, { rejectUnauthorized: false });
            var done = false;
            var finish = function (r) { if (done) { return; } done = true; try { session.close(); } catch (e) { /* ignore */ } resolve(r); };
            session.on('error', function (e) { finish({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
            var h = Object.assign({ ':path': reqPath }, headers);
            var req = session.request(h);
            var chunks = [], resHeaders = {};
            req.setTimeout(15000, function () { req.close(); finish({ status: null, headers: {}, body: Buffer.alloc(0), err: 'timeout' }); });
            req.on('response', function (hs) { resHeaders = hs; });
            req.on('data', function (c) { chunks.push(c); });
            req.on('end', function () { finish({ status: Number(resHeaders[':status']), headers: resHeaders, body: Buffer.concat(chunks) }); });
            req.on('error', function (e) { finish({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
            req.end();
        });
    }
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: port, path: reqPath, method: 'GET', agent: false, headers: headers }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, headers: {}, body: Buffer.alloc(0), err: e.message }); });
        req.end();
    });
}

/**
 * The same-origin asset URLs gina EMITTED in a page — the exact tag shapes the resource builder
 * writes (`<link href="…" [media="…"] rel="…" type="…"` and `<script [defer] type="…" src="…"`).
 * Tags hand-written in a layout (the scaffold's `<link rel="manifest" href="…">`, icons) are the
 * template author's, deliberately out of #P48's reach, and never match these shapes.
 */
function assetUrls(html) {
    var out = [], m;
    var reCss = /<link href="([^"]+)"(?: media="[^"]*")? rel="[^"]*" type="[^"]*"/g;
    var reJs  = /<script(?: defer)? type="[^"]*" src="([^"]+)"/g;
    while ((m = reCss.exec(html))) { out.push(m[1]); }
    while ((m = reJs.exec(html)))  { out.push(m[1]); }
    return out.filter(function (u) { return !/^(?:[a-z]+:)?\/\//i.test(u); });
}

/** `url` without its `v=` query parameter (and without an empty trailing `?`). */
function withoutV(url) { return url.replace(/([?&])v=[^&#]*&?/, '$1').replace(/[?&]$/, ''); }
function withV(url, token) { var base = withoutV(url); return base + (base.indexOf('?') > -1 ? '&' : '?') + 'v=' + token; }
function tokenOf(url) { var m = /[?&]v=([^&#]*)/.exec(url); return m ? m[1] : null; }
function sha384Token(buf) { return crypto.createHash('sha384').update(buf).digest('hex').substring(0, 10); }

/** Every copy of the sibling fixture under the project (sources and releases), each with its `.br`. */
function sibCopies() {
    var out = [];
    (function walk(dir) {
        var ents;
        try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        ents.forEach(function (d) {
            if (d.isSymbolicLink() || d.name === 'node_modules') { return; }   // node_modules/gina links the framework tree
            var p = path.join(dir, d.name);
            if (d.isDirectory()) { walk(p); }
            else if (d.name === SIB_NAME && fs.existsSync(p + '.br')) { out.push(p); }
        });
    })(PROJ_DIR);
    return out;
}

/** Set every copy's mtime: the source's and its `.br` sibling's, in (fractional) seconds. */
function setSibTimes(sourceSec, siblingSec) {
    var copies = sibCopies();
    copies.forEach(function (p) {
        fs.utimesSync(p, sourceSec, sourceSec);
        fs.utimesSync(p + '.br', siblingSec, siblingSec);
    });
    return copies.length;
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

/**
 * A route + an action rendering a template through the scaffold layout (the scaffold's own home
 * action answers JSON, so it carries no asset tags).
 */
function installFixture() {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);

    var rf = path.join(src, 'config', 'routing.json');
    var r = readConfig(rf);
    r.p48page = { namespace: 'content', url: '/p48/page', method: 'GET', param: { control: 'p48page' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(src, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    fs.writeFileSync(cf, s.replace(anchor, "    this.p48page = function(req, res) { self.render({ msg: 'p48' }); };\n" + anchor));

    fs.writeFileSync(path.join(src, 'templates', 'html', 'content', 'p48page.html'), [
        "{% extends 'layouts/main.html' %}",
        '{% block content %}<div id="p48">{{ page.data.msg }}</div>{% endblock %}',
        ''
    ].join('\n'));

    // the sibling fixture, served through the bundle's public mapping
    if (!fs.existsSync(path.join(src, 'public'))) { throw new Error('no public directory under ' + src); }
    var js = path.join(src, 'public', 'js');
    fs.mkdirSync(js, { recursive: true });
    fs.writeFileSync(path.join(js, SIB_NAME), SIB_CONTENT);
    fs.writeFileSync(path.join(js, SIB_NAME + '.br'), zlib.brotliCompressSync(Buffer.from(SIB_CONTENT)));
}

/** Point the bundle at `mode`'s protocol and write its versioning flag, then build the prod release. */
function configureAndBuild(mode) {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);
    var sf = path.join(src, 'config', 'settings.json');
    var settings = readConfig(sf);
    settings.server = Object.assign({}, settings.server, { protocol: mode.protocol, scheme: mode.scheme });
    fs.writeFileSync(sf, JSON.stringify(settings, null, 2));

    var tf = path.join(src, 'config', 'templates.json');
    var templates = readConfig(tf);
    templates._common = templates._common || {};
    if (mode.versioning) { delete templates._common.assetVersioningEnabled; }   // the default
    else { templates._common.assetVersioningEnabled = false; }
    fs.writeFileSync(tf, JSON.stringify(templates, null, 2));

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

/** Boot the prod release, drive every arm, stop. */
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
    var res = { page: null, assets: [], routing: null, out: '', err: null };
    if (!up) {
        res.err = 'the bundle did not come up on ' + port + ': exit ' + JSON.stringify(exit) + '\n' + out.slice(-2500);
    } else {
        await sleep(300);
        res.page = await get(mode, port, webroot + 'p48/page');
        var html = res.page.body.toString('utf8');
        var urls = assetUrls(html);
        for (var i = 0; i < urls.length; ++i) {
            var u = urls[i], token = tokenOf(u), rec = { url: u, token: token };
            rec.plain   = await get(mode, port, withoutV(u));
            rec.wrong   = await get(mode, port, withV(u, WRONG));
            if (token) {
                rec.matched = await get(mode, port, u);
                var etag = rec.matched.headers && rec.matched.headers.etag;
                rec.revalidated = etag ? await get(mode, port, u, { 'if-none-match': etag }) : null;
            }
            res.assets.push(rec);
        }
        var rv = /<script(?: defer)? type="[^"]*" src="([^"]+)" data-gina-routing-v="([^"]*)"/.exec(html);
        var routingPath = webroot + '_gina/assets/routing.json';
        res.routing = {
            token     : rv ? rv[2] : null,
            attrSrc   : rv ? rv[1] : null,
            attrCount : (html.match(/data-gina-routing-v=/g) || []).length,
            plain     : await get(mode, port, routingPath),
            wrong     : await get(mode, port, routingPath + '?v=' + WRONG),
            matched   : (rv && rv[2]) ? await get(mode, port, routingPath + '?v=' + rv[2]) : null
        };

        if (mode.name === 'h1') {
            // 10 — gina's own files with a browser's Accept-Encoding: the dist's siblings as built
            res.browser = [];
            var own = res.assets.filter(function (a) { return a.token && /\/vendor\/gina\/gina\.min\.(?:js|css)$/.test(withoutV(a.url)); });
            for (var g = 0; g < own.length; ++g) {
                res.browser.push({ url: own[g].url, r: await get(mode, port, own[g].url, { 'accept-encoding': 'gzip, deflate, br' }) });
            }
            // 09 / 11 — the sibling fixture in three mtime states (every copy on disk set alike)
            var sibUrl = webroot + 'js/' + SIB_NAME + '?v=' + sha384Token(Buffer.from(SIB_CONTENT));
            var t0 = Math.floor(Date.now() / 1000) - 60;
            res.sibling = { url: sibUrl };
            res.sibling.copies    = setSibTimes(t0, t0 + 5);           // the sibling is newer
            res.sibling.newer     = await get(mode, port, sibUrl, { 'accept-encoding': 'br' });
            res.sibling.identity  = await get(mode, port, sibUrl);
            setSibTimes(t0 + 5, t0);                                    // the source is newer: a stale sibling
            res.sibling.stale     = await get(mode, port, sibUrl, { 'accept-encoding': 'br' });
            setSibTimes(t0 + 0.464, t0);                                // the same second, the sibling truncated to it
            res.sibling.truncated = await get(mode, port, sibUrl, { 'accept-encoding': 'br' });
            // 12 — #B707, LAST: before the fix this request killed the bundle
            res.b707      = await get(mode, port, webroot + '_gina/assets/Routing.json');
            await sleep(500);
            res.b707After = await get(mode, port, webroot + 'p48/page');
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


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('28 - container-boot-asset-versioning — versioned asset URLs and immutable caching, live (#P48)', function () {

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
        assert.equal(r.page.status, 200, name + ': the page — ' + r.page.body.toString('utf8').slice(0, 400));
        assert.ok(r.assets.length >= 3, name + ': the page carries gina-emitted asset tags (control) — found ' + r.assets.map(function (a) { return a.url; }).join(', '));
        return r;
    }
    function findAsset(r, re) { return r.assets.filter(function (a) { return re.test(withoutV(a.url)); })[0]; }

    ['h1', 'h2'].forEach(function (name) {
        it('01 - ' + name + ': every same-origin asset URL carries ?v=<10 hex> — gina.min.js, gina.min.css, the stylesheet, the handler', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name);
            r.assets.forEach(function (a) {
                assert.ok(/^[0-9a-f]{10}$/.test(a.token || ''), name + ': ' + a.url + ' has no content token');
            });
            ['gina\\.min\\.js$', 'gina\\.min\\.css$', 'handlers/main\\.js$'].forEach(function (p) {
                assert.ok(findAsset(r, new RegExp(p)), name + ': the page emits ' + p + ' (control)');
            });
        });

        it('02 - ' + name + ': each token is the first 10 hex of the sha384 of the bytes served for it', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name), checked = 0;
            r.assets.forEach(function (a) {
                if (/\/handlers\//.test(a.url) || !a.token) { return; }   // handlers are wrapped at serve time
                assert.equal(a.plain.status, 200, name + ': ' + a.url + ' is served');
                assert.equal(a.token, sha384Token(a.plain.body), name + ': ' + a.url + ' — the token names the served bytes');
                checked++;
            });
            assert.ok(checked >= 3, name + ': at least gina.min.js, gina.min.css and the stylesheet were checked, got ' + checked);
        });

        it('03 - ' + name + ': the versioned URL answers 200 + public, ' + IMMUTABLE, function (t) {
            if (!ready(t)) { return; }
            booted(name).assets.forEach(function (a) {
                assert.ok(a.matched, name + ': ' + a.url + ' was requested with its token');
                assert.equal(a.matched.status, 200, name + ': ' + a.url);
                assert.equal(header(a.matched, 'cache-control'), 'public, ' + IMMUTABLE, name + ': ' + a.url);
            });
        });

        it('04 - ' + name + ': a wrong token answers 200 + no-cache + an ETag, never immutable', function (t) {
            if (!ready(t)) { return; }
            booted(name).assets.forEach(function (a) {
                assert.equal(a.wrong.status, 200, name + ': ' + a.url);
                assert.equal(header(a.wrong, 'cache-control'), 'no-cache', name + ': ' + withV(a.url, WRONG));
                assert.ok(header(a.wrong, 'etag'), name + ': an ETag lets the browser revalidate');
            });
        });

        it('05 - ' + name + ': without a token the statics answer as before #P48 — an ETag, no Cache-Control (the control)', function (t) {
            if (!ready(t)) { return; }
            booted(name).assets.forEach(function (a) {
                assert.equal(a.plain.status, 200, name + ': ' + withoutV(a.url));
                assert.ok(header(a.plain, 'etag'), name + ': ' + withoutV(a.url) + ' has an ETag');
                assert.equal(header(a.plain, 'cache-control'), undefined, name + ': ' + withoutV(a.url));
            });
        });

        it('06 - ' + name + ': revalidating the versioned URL answers 304 — ' + (name === 'h2' ? 'with the immutable Cache-Control' : 'bare'), function (t) {
            if (!ready(t)) { return; }
            booted(name).assets.forEach(function (a) {
                assert.ok(a.revalidated, name + ': ' + a.url + ' was revalidated with its ETag');
                assert.equal(a.revalidated.status, 304, name + ': ' + a.url);
                if (name === 'h2') {
                    assert.equal(header(a.revalidated, 'cache-control'), 'public, ' + IMMUTABLE, name + ': ' + a.url);
                } else {
                    assert.equal(header(a.revalidated, 'cache-control'), undefined, name + ': a bare 304 keeps what the browser stored — ' + a.url);
                }
            });
        });

        it('07 - ' + name + ': gina\'s own script tag carries the routing token; the routing table is immutable for it, no-cache otherwise', function (t) {
            if (!ready(t)) { return; }
            var r = booted(name).routing;
            assert.equal(r.attrCount, 1, name + ': one routing token per page');
            assert.ok(/\/vendor\/gina\/gina\.min\.js\?v=[0-9a-f]{10}$/.test(r.attrSrc || ''), name + ': on gina\'s own tag — ' + r.attrSrc);
            assert.ok(/^[0-9a-f]{10}$/.test(r.token || ''), name + ': data-gina-routing-v = ' + JSON.stringify(r.token));
            assert.equal(r.plain.status, 200, name + ': the routing table without a token');
            assert.ok(/no-cache/.test(header(r.plain, 'cache-control') || ''), name + ': no token — revalidate, as before');
            assert.equal(r.wrong.status, 200, name + ': the routing table with a wrong token');
            assert.ok(/no-cache/.test(header(r.wrong, 'cache-control') || ''), name + ': wrong token — revalidate');
            assert.ok(r.matched, name + ': the routing table was requested with the page\'s token');
            assert.equal(r.matched.status, 200, name + ': the routing table with its token');
            assert.ok(new RegExp(IMMUTABLE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$').test(header(r.matched, 'cache-control') || ''), name + ': ' + header(r.matched, 'cache-control'));
            assert.equal(r.matched.body.toString('utf8'), r.plain.body.toString('utf8'), name + ': the same table either way');
        });
    });

    it('08 - off: no URL carries ?v=, the page carries no routing token, and the statics answer as before', function (t) {
        if (!ready(t)) { return; }
        var r = booted('off');
        r.assets.forEach(function (a) {
            assert.equal(a.token, null, 'off: ' + a.url + ' carries no token');
            assert.equal(a.plain.status, 200, 'off: ' + a.url);
            assert.equal(header(a.plain, 'cache-control'), undefined, 'off: ' + a.url + ' — no Cache-Control, as before');
        });
        assert.equal(r.routing.attrCount, 0, 'off: no data-gina-routing-v in the page');
        assert.ok(/no-cache/.test(header(r.routing.plain, 'cache-control') || ''), 'off: the routing table revalidates, as before');
    });

    it('09 - h1: a precompressed sibling not older than its source is immutable under the source\'s token; a stale one revalidates', function (t) {
        if (!ready(t)) { return; }
        var s = booted('h1').sibling;
        assert.ok(s.copies >= 1, 'the sibling fixture was found on disk (' + s.copies + ' copies)');
        assert.equal(s.newer.status, 200, s.url);
        assert.equal(header(s.newer, 'content-encoding'), 'br', 'the sibling was served');
        assert.equal(header(s.newer, 'cache-control'), 'public, ' + IMMUTABLE, 'a sibling newer than its source');
        assert.equal(header(s.identity, 'content-encoding'), undefined, 'control: without Accept-Encoding, the source itself');
        assert.equal(header(s.identity, 'cache-control'), 'public, ' + IMMUTABLE, 'control: the source under its token');
        assert.equal(header(s.stale, 'content-encoding'), 'br', 'the stale sibling is still what is served');
        assert.equal(header(s.stale, 'cache-control'), 'no-cache', 'a source newer than its sibling: revalidate');
    });

    it('10 - h1: a browser\'s request for gina.min.js / gina.min.css gets the dist\'s .br sibling, immutable', function (t) {
        if (!ready(t)) { return; }
        var b = booted('h1').browser;
        assert.equal(b.length, 2, 'gina.min.js and gina.min.css were requested (control): ' + b.map(function (x) { return x.url; }).join(', '));
        // every reading first, so one failure still reports both files
        var seen = b.map(function (x) {
            return { url: x.url, status: x.r.status, encoding: header(x.r, 'content-encoding'), cacheControl: header(x.r, 'cache-control') };
        });
        seen.forEach(function (x) {
            assert.equal(x.status, 200, JSON.stringify(seen));
            assert.equal(x.encoding, 'br', 'the sibling is served — ' + JSON.stringify(seen));
            assert.equal(x.cacheControl, 'public, ' + IMMUTABLE, JSON.stringify(seen));
        });
    });

    it('11 - h1: a sibling carrying its source\'s mtime truncated to the second is the same generation — immutable', function (t) {
        if (!ready(t)) { return; }
        var s = booted('h1').sibling;
        assert.equal(header(s.truncated, 'content-encoding'), 'br', 'the sibling is served');
        assert.equal(header(s.truncated, 'cache-control'), 'public, ' + IMMUTABLE, 'got ' + JSON.stringify(header(s.truncated, 'cache-control')));
    });

    it('12 - h1: #B707 — a GET for …/Routing.json answers 200 and the bundle keeps answering', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h1');
        assert.equal(r.b707.status, 200, 'Routing.json: ' + (r.b707.err || r.b707.status));
        assert.equal(r.b707.body.toString('utf8'), r.routing.plain.body.toString('utf8'), 'the same table as routing.json');
        assert.equal(r.b707After.status, 200, 'the page afterwards: ' + (r.b707After.err || r.b707After.status));
    });

    it('13 - h2: the page\'s link preload header names exactly the tags\' versioned URLs', function (t) {
        if (!ready(t)) { return; }
        var r = booted('h2');
        var link = [].concat(header(r.page, 'link') || []).join(','), hinted = [], m, re = /<([^>]+)>/g;
        while ((m = re.exec(link))) { hinted.push(m[1]); }
        assert.ok(hinted.length >= 3, 'the page carries preload hints: ' + JSON.stringify(link));
        hinted.forEach(function (u) { assert.ok(/[?&]v=[0-9a-f]{10}$/.test(u), 'a versioned hint: ' + u); });
        assert.deepEqual(hinted.slice().sort(), r.assets.map(function (a) { return a.url; }).sort());
    });

    it('14 - dev: nothing is versioned — no ?v=, no routing token, the statics answer no-store', function (t) {
        if (!ready(t)) { return; }
        var r = booted('dev');
        r.assets.forEach(function (a) {
            assert.equal(a.token, null, 'dev: ' + a.url + ' carries no token');
            assert.equal(header(a.plain, 'cache-control'), 'no-cache, no-store, must-revalidate', 'dev: ' + a.url);
        });
        assert.equal(r.routing.attrCount, 0, 'dev: no data-gina-routing-v in the page');
        assert.ok(/no-cache/.test(header(r.routing.plain, 'cache-control') || ''), 'dev: the routing table revalidates');
    });
});
