/**
 * #B1062 — a multipart request that does not complete.
 *
 * The multipart branch of core/server.js streams each file part to a staged temp file while the
 * body arrives. This file boots the REAL bin/gina-container (isaac, the default engine) and reads
 * what such a request leaves behind: its answer, the write streams it opened and the files it
 * staged. Arms:
 *   01  controls — complete uploads are unchanged, also on a slow disk (the request has ended and
 *       the parser has not, which is the normal end of an upload)
 *   02  a body that ends early is answered 400 and nothing stays staged
 *   05  the same over HTTP/2
 *
 * Instruments, each with a control that can fire: `staged()` walks the project for `.part` files
 * (01.1 reads one), `partDescriptors()` reads the bundle's open `.part` descriptors, /proc on Linux,
 * lsof elsewhere. A slow disk is a test double in the
 * bundle's index.js, armed through the `p/slow` route, delaying each write of a staged file.
 *
 * Isolation: the container-boot-multipart-nested-throw-b844.test.js shape — a throwaway HOME and
 * project under os.tmpdir(), its own port window (14450; the next booted window starts at 14500), a
 * self-signed certificate under that HOME, project:rm + rmSync at teardown.
 *
 * Seam: B1062_GINA_ROOT=<tree> boots THAT tree's launcher against a project scaffolded by THAT
 * tree's CLI (red-first against the tree before this change, with no write to it):
 *   B1062_GINA_ROOT=/path/to/pre-fix/tree \
 *     node --test test/integration/container-boot-multipart-abort-b1062.test.js
 *
 * Two more seams read the same arms on another runtime or engine, for a reading by hand:
 *   B1062_RUNTIME=<path to a bun binary> runs the bundles on it (the CLI stays on this runtime);
 *   B1062_ENGINE=express runs the `web` bundle on that engine (needs NODE_PATH to reach an `express`).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-multipart-abort-b1062.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var http2  = require('http2');
var tls    = require('tls');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var crypto = require('crypto');
var { spawnSync, spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b1062-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'b1062ab' + STAMP;
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14450;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 10000;
var SETTLE_MS          = 4000;      // how long a descriptor or a file may take to go
var CAP                = 1024 * 1024; // upload.maxFieldsSize of the throwaway bundles
var CLEANUP_TIMEOUT    = '800ms';   // upload.autoTmpCleanupTimeout of `webtwo`
var AFTER_CLEANUP_MS   = 1400;      // long enough for that timer to have run

var GINA_ROOT = process.env.B1062_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');
var RUNTIME   = process.env.B1062_RUNTIME || process.execPath;

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;

// `web` answers HTTP/1.1 in clear, `webtwo` HTTP/2 over TLS (and HTTP/1.1 over TLS, allowHTTP1)
var H1 = { name: 'web',    scheme: 'http',  port: null, webroot: '/web/',    child: null, out: '', exit: null };
var H2 = { name: 'webtwo', scheme: 'https', port: null, webroot: '/webtwo/', child: null, out: '', exit: null };

var BOUNDARY = '----b1062' + STAMP;
var CT       = 'multipart/form-data; boundary=' + BOUNDARY;
var CLOSING  = Buffer.from('--' + BOUNDARY + '--\r\n');
var NEXT     = Buffer.from('--' + BOUNDARY + '\r\n');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function isAlive(b) { return b.child && b.child.exitCode === null && b.child.signalCode === null; }
function bytes(n) { return crypto.randomBytes(n); }

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function hasOpenssl() {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

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

function fileHead(filename, group) {
    return Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="f"; filename="' + filename + '"'
        + (group ? '; group="' + group + '"' : '') + '\r\nContent-Type: application/octet-stream\r\n\r\n');
}
function filePart(filename, data) { return Buffer.concat([fileHead(filename), data, Buffer.from('\r\n')]); }
function fieldHead(name) { return Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n'); }
function fieldPart(name, value) { return Buffer.concat([fieldHead(name), Buffer.from(value + '\r\n')]); }

/** One request over HTTP/1.1. Never rejects: what the client read is in `status`, what stopped it in `err`. */
function call(b, method, reqPath, body, headers, opts) {
    opts = opts || {};
    var lib = (b.scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var done = false, status = null;
        var finish = function (v) { if (!done) { done = true; resolve(v); } };
        var h = Object.assign({}, headers || {});
        if (body && !opts.chunked) { h['content-length'] = body.length; }
        var req = lib.request({ host: '127.0.0.1', port: b.port, path: b.webroot + reqPath, method: method, headers: h, agent: false, rejectUnauthorized: false }, function (res) {
            status = res.statusCode;
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                var text = Buffer.concat(chunks).toString('utf8'), json = null;
                try { json = JSON.parse(text); } catch (e) { json = null; }
                finish({ status: status, json: json, text: text, type: String(res.headers['content-type'] || '') });
            });
            res.on('error', function (e) { finish({ status: status, json: null, err: e.code || e.message }); });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { finish({ status: status, json: null, err: 'client timeout' }); req.destroy(); });
        req.on('error', function (e) { finish({ status: status, json: null, err: e.code || e.message }); });
        if (!body) { req.end(); return; }
        if (!opts.chunked) { req.write(body); req.end(); return; }
        (async function () {
            var piece = opts.piece || 65536;
            for (var i = 0; i < body.length && !req.destroyed; i += piece) {
                if (!req.write(body.subarray(i, i + piece))) {
                    await new Promise(function (r) { req.once('drain', r); req.once('close', r); });
                }
                if (opts.gapMs) { await sleep(opts.gapMs); }
            }
            if (!req.destroyed) { req.end(); }
        })();
    });
}

/**
 * One raw upload held open over a plain socket: returns the socket once `chunks` have been written.
 * `length` sends a content-length, the shape a browser sends; otherwise the framing is chunked.
 */
function hold(b, chunks, length) {
    return new Promise(function (resolve) {
        var sock = net.connect(b.port, '127.0.0.1', function () {
            sock.write('POST ' + b.webroot + 'p/upstage HTTP/1.1\r\nHost: localhost\r\nContent-Type: ' + CT + '\r\n'
                + (length ? 'Content-Length: ' + length : 'Transfer-Encoding: chunked') + '\r\n\r\n');
            var body = Buffer.concat(chunks);
            if (length) {
                sock.write(body, function () { setTimeout(function () { resolve(sock); }, 250); });
            } else {
                sock.write(body.length.toString(16) + '\r\n');
                sock.write(body);
                sock.write('\r\n', function () { setTimeout(function () { resolve(sock); }, 250); });
            }
        });
        sock.on('error', function () {});
    });
}

function h2connect(b) {
    return new Promise(function (resolve) {
        var session = http2.connect('https://127.0.0.1:' + b.port, { rejectUnauthorized: false });
        session.on('error', function () {});
        session.once('connect', function () { resolve(session); });
        setTimeout(function () { resolve(session); }, 5000);
    });
}

/** One request over HTTP/2 on `session`. Never rejects; `keep` returns the stream unended instead. */
function h2call(b, session, method, reqPath, body, headers, keep) {
    return new Promise(function (resolve) {
        var done = false, status = null, data = '';
        var finish = function (v) { if (!done) { done = true; resolve(v); } };
        var st;
        try { st = session.request(Object.assign({ ':method': method, ':path': b.webroot + reqPath }, headers || {})); }
        catch (e) { finish({ status: null, json: null, err: e.code || e.message }); return; }
        st.setTimeout(REQUEST_TIMEOUT_MS, function () { st.close(http2.constants.NGHTTP2_CANCEL); });
        st.on('response', function (h) { status = h[':status']; });
        st.on('data', function (d) { data += d; });
        st.on('error', function (e) { finish({ status: status, json: null, err: e.code || e.message }); });
        st.on('close', function () {
            var json = null;
            try { json = JSON.parse(data); } catch (e) { json = null; }
            finish({ status: status, json: json, text: data, rst: st.rstCode });
        });
        if (keep) {
            var written = body ? st.write(body) : true;
            setTimeout(function () { resolve(st); }, written ? 250 : 400);
            return;
        }
        (async function () {
            for (var i = 0; body && i < body.length && !st.destroyed; i += 65536) {
                if (!st.write(body.subarray(i, i + 65536))) {
                    await new Promise(function (r) { st.once('drain', r); st.once('close', r); });
                }
            }
            if (!st.destroyed) { st.end(); }
        })();
    });
}

/** The `.part` files on disk under the project. */
function staged() {
    var out = [];
    (function walk(d) {
        var entries = [];
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        entries.forEach(function (e) {
            var p = path.join(d, e.name);
            if (e.isDirectory()) { walk(p); } else if (/\.part$/.test(e.name)) { out.push(p); }
        });
    })(PROJ_DIR);
    return out;
}
function stagedSince(before) { return staged().filter(function (p) { return before.indexOf(p) < 0; }); }

/** The open `.part` descriptors of the launcher and its child. */
function partDescriptors(b) {
    var pids = [b.child.pid];
    try { execFileSync('pgrep', ['-P', String(b.child.pid)], { encoding: 'utf8' }).trim().split('\n').forEach(function (p) { if (p) { pids.push(Number(p)); } }); } catch (e) { /* no child */ }
    var count = 0;
    if (fs.existsSync('/proc/self/fd')) {
        pids.forEach(function (pid) {
            var fds = [];
            try { fds = fs.readdirSync('/proc/' + pid + '/fd'); } catch (e) { return; }
            fds.forEach(function (fd) {
                try { if (/\.part( \(deleted\))?$/.test(fs.readlinkSync('/proc/' + pid + '/fd/' + fd))) { ++count; } } catch (e) { /* closed meanwhile */ }
            });
        });
        return count;
    }
    var out = '';
    try { out = execFileSync('lsof', ['-nP', '-p', pids.join(',')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch (e) { out = e.stdout || ''; }
    out.split('\n').forEach(function (l) { if (/\.part\b/.test(l)) { ++count; } });
    return count;
}

/** Polls `read` until `want` holds or SETTLE_MS has passed; returns the last reading. */
async function settle(read, want) {
    var until = Date.now() + SETTLE_MS, last;
    do {
        last = read();
        if (want(last)) { return last; }
        await sleep(100);
    } while (Date.now() < until);
    return last;
}

/** The arm's request has left nothing behind: no staged file added, no `.part` descriptor open. */
async function assertNothingLeft(label, b, before) {
    var left = await settle(function () { return stagedSince(before); }, function (l) { return l.length === 0; });
    assert.deepEqual(left, [], label + ': no staged file may stay');
    var fds = await settle(function () { return partDescriptors(b); }, function (n) { return n === 0; });
    assert.equal(fds, 0, label + ': no staged file may stay open');
}

/** One GET, over the protocol the bundle is configured for. */
async function get(b, reqPath) {
    if (b !== H2) { return call(b, 'GET', reqPath); }
    var session = await h2connect(b);
    var r = await h2call(b, session, 'GET', reqPath);
    try { session.close(); } catch (e) { /* ignore */ }
    return r;
}

/** Boots the bundle unless it is running and answering. */
async function ensureUp(b) {
    if (isAlive(b)) {
        var probe = await get(b, 'p/ping');
        if (probe.status === 200) { return true; }
        var gone = Date.now() + 8000;
        while (Date.now() < gone && isAlive(b)) { await sleep(150); }
        if (isAlive(b)) { try { b.child.kill('SIGKILL'); } catch (e) { /* ignore */ } await sleep(300); }
    }
    b.exit = null;
    var mine = spawn(RUNTIME, [CONTAINER, b.name, '@' + PROJ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    b.child = mine;
    mine.stdout.on('data', function (d) { b.out += d; });
    mine.stderr.on('data', function (d) { b.out += d; });
    mine.on('exit', function (code, signal) { if (b.child === mine) { b.exit = { code: code, signal: signal }; } });
    var deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline && !b.exit) {
        if (await isTcpPortOpen(b.port)) { await sleep(300); return true; }
        await sleep(POLL_INTERVAL_MS);
    }
    return false;
}

async function up(label, b) {
    assert.ok(await ensureUp(b), label + ': the bundle did not come up: ' + JSON.stringify(b.exit) + '\n' + b.out.slice(-1200));
    return { mark: b.out.length, before: staged() };
}

/** The state every arm ends on: the process is up, a control GET is answered, nothing reached the process. */
async function assertAnswering(label, b, mark) {
    await sleep(300);
    assert.ok(isAlive(b), label + ': the bundle must keep running — exit: ' + JSON.stringify(b.exit) + '\n' + b.out.slice(-1200));
    var ctl = await get(b, 'p/ping');
    assert.equal(ctl.status, 200, label + ': the control GET must still answer');
    assert.equal(ctl.json && ctl.json.ok, true);
    assert.equal((b.out.slice(mark).match(/uncaughtException/g) || []).length, 0, label + ': nothing may reach the process');
}

async function slowDisk(b, ms, finalMs) {
    var r = await get(b, 'p/slow?ms=' + ms + '&final=' + (finalMs || 0));
    assert.equal(r.status, 200, '[instrument] the slow-disk double is armed: ' + JSON.stringify(r) + '\n' + b.out.slice(-1500));
    assert.equal(r.json.ms, ms, '[instrument] the slow-disk double reads ' + ms);
}

/** Routes, actions and the upload settings of one throwaway bundle. */
function installScene(b) {
    var src = path.join(PROJ_DIR, 'src', b.name);
    var serverFile = path.join(GINA_ROOT, 'framework', 'v' + readJSON(path.join(GINA_ROOT, 'package.json')).version, 'core', 'server.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };

    var rf = path.join(src, 'config', 'routing.json');
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.p_ping    = { namespace: 'content', url: '/p/ping',    method: 'GET',  param: { control: 'pping' } };
    r.p_slow    = { namespace: 'content', url: '/p/slow',    method: 'GET',  param: { control: 'pslow' } };
    r.p_upstage = { namespace: 'content', url: '/p/upstage', method: 'POST', param: { control: 'pupstage' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var sf = path.join(src, 'config', 'settings.json');
    var st = fs.readFileSync(sf, 'utf8');
    if (st.indexOf('"upload"') > -1) { throw new Error('settings.json already holds an upload block'); }
    fs.writeFileSync(sf, st.replace('{', '{\n    "upload": { "maxFieldsSize": "1MB", ' + ((b === H2) ? '"autoTmpCleanupTimeout": "' + CLEANUP_TIMEOUT + '", ' : '') + '"groups": { "untagged": { "allowedExtensions": "*", "isMultipleAllowed": true } } },'));

    var cf = path.join(src, 'controllers', 'controller.content.js');
    var c = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (c.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (c.split(anchor).length - 1)); }
    fs.writeFileSync(cf, c.replace(anchor, [
        '    this.pping = function(req, res) { self.renderJSON({ ok: true }); };',
        '    this.pslow = function(req, res) { global.__b1062SlowMs = Number(req.get.ms); global.__b1062SlowFinalMs = Number(req.get.final); self.renderJSON({ ms: global.__b1062SlowMs }); };',
        '    this.pupstage = function(req, res) {',
        '        var fsMod = require("fs");',
        '        self.renderJSON({ post: req.post, files: (req.files || []).map(function (f) {',
        '            var onDisk = null;',
        '            try { onDisk = fsMod.statSync(f.path).size; } catch (e) { onDisk = null; }',
        '            return { name: f.originalFilename, size: f.size, onDisk: onDisk };',
        '        }) });',
        '    };',
        ''
    ].join('\n') + anchor));

    var xf = path.join(src, 'index.js');
    var x = fs.readFileSync(xf, 'utf8');
    var startAnchor = b.name + '.start();';
    if (x.split(startAnchor).length !== 2) { throw new Error('index.js start anchor count ' + (x.split(startAnchor).length - 1)); }
    fs.writeFileSync(xf, x.replace(startAnchor, [
        '(function () {',
        '    var fsMod = require("fs"), realCWS = fsMod.createWriteStream;',
        '    fsMod.createWriteStream = function () {',
        '        var ws = realCWS.apply(this, arguments), ms = global.__b1062SlowMs;',
        '        if (ms) {',
        '            var realWrite = ws._write;',
        '            ws._writev = null;',
        // a real write stream holds its close for a write in flight: the delay must not outlive the stream
        '            ws._write = function (chunk, enc, cb) { var me = this; setTimeout(function () { if (me.destroyed) { return cb(); } realWrite.call(me, chunk, enc, cb); }, ms); };',
        '        }',
        '        return ws;',
        '    };',
        // the parser's end-of-input step, delayed: what a full part stream does to it on a slow disk
        '    var Multipart = require("module").createRequire(' + JSON.stringify(serverFile) + ')("@rhinostone/busboy/lib/types/multipart");',
        '    var realFinal = Multipart.prototype._final;',
        '    Multipart.prototype._final = function (cb) {',
        '        var me = this, ms = global.__b1062SlowFinalMs;',
        '        if (!ms) { return realFinal.call(me, cb); }',
        '        setTimeout(function () { realFinal.call(me, cb); }, ms);',
        '    };',
        '})();',
        ''
    ].join('\n') + startAnchor));
}

/** protocol http/2.0 + scheme https, spliced after the scaffold's webroot line (comments kept). */
function spliceHttp2(b) {
    var ssFile = path.join(PROJ_DIR, 'src', b.name, 'config', 'settings.server.json');
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol or scheme'); }
    fs.writeFileSync(ssFile, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https"'));
}

/** `engine` spliced after the scaffold's webroot line, the B1062_ENGINE seam. */
function spliceEngine(b, engine) {
    var ssFile = path.join(PROJ_DIR, 'src', b.name, 'config', 'settings.server.json');
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    fs.writeFileSync(ssFile, s.replace(m[0], m[0] + ',\n    "engine": "' + engine + '"'));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}

function webroot(b) {
    var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', b.name, 'config', 'settings.server.json'), 'utf8');
    var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + b.name);
    return wr.replace(/\/+$/, '') + '/';
}

function ready(t) {
    if (skip) { t.skip(skipReason); return false; }
    assert.equal(setupError, null, 'setup failed: ' + setupError);
    return true;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot-multipart-abort — a multipart request that does not complete leaves nothing behind (#B1062)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (!hasOpenssl()) { skip = true; skipReason = 'openssl is not available to mint the test certificate'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', H1.name, '@' + PROJ, '--start-port-from=' + PORT_START]);
        runCli(['bundle:add', H2.name, '@' + PROJ, '--start-port-from=' + (PORT_START + 25)]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var ports = fs.existsSync(portsReversePath) ? readJSON(portsReversePath) : {};
        if (!ports[H1.name + '@' + PROJ] || !ports[H2.name + '@' + PROJ]) { setupError = 'bundle:add did not register both bundles: ' + Object.keys(ports); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        try {
            installScene(H1);
            installScene(H2);
            spliceHttp2(H2);
            if (process.env.B1062_ENGINE) { spliceEngine(H1, process.env.B1062_ENGINE); }
            makeCertificate();
        } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try {
            H1.port = ports[H1.name + '@' + PROJ][env]['http/1.1']['http'];
            H2.port = ports[H2.name + '@' + PROJ][env]['http/2.0']['https'];
        } catch (e) { H1.port = null; }
        if (!H1.port || !H2.port) { setupError = 'could not resolve the bound ports: ' + H1.port + ', ' + H2.port; return; }
        H1.webroot = webroot(H1);
        H2.webroot = webroot(H2);

        if (!(await ensureUp(H1))) { setupError = 'web did not come up: ' + JSON.stringify(H1.exit) + '\n' + H1.out.slice(-2000); return; }
        if (!(await ensureUp(H2))) { setupError = 'webtwo did not come up: ' + JSON.stringify(H2.exit) + '\n' + H2.out.slice(-2000); }
    });

    after(async function () {
        for (var i = 0, list = [H1, H2]; i < list.length; ++i) {
            if (isAlive(list[i])) {
                try { list[i].child.kill('SIGTERM'); } catch (e) { /* ignore */ }
                var until = Date.now() + 4000;
                while (Date.now() < until && isAlive(list[i])) { await sleep(150); }
                if (isAlive(list[i])) { try { list[i].child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
            }
        }
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    // ── 01 controls: a complete upload is unchanged ──────────────────────────

    it('01.1  a complete upload is answered 200, with its bytes on disk and its file staged', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('01.1', H1);
        var data = bytes(2048);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([filePart('one.bin', data), CLOSING]), { 'content-type': CT });
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(r.json.files, [{ name: 'one.bin', size: 2048, onDisk: 2048 }]);
        assert.equal(stagedSince(s.before).length, 1, '[instrument] staged() reads the staged file');
        await assertAnswering('01.1', H1, s.mark);
    });

    it('01.2  three file parts and a text field, sent slowly with no content-length, keep their order and sizes', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('01.2', H1);
        var body = Buffer.concat([filePart('a.bin', bytes(4096)), fieldPart('x', 'v'), filePart('b.bin', bytes(300 * 1024)), filePart('c.bin', bytes(4096)), CLOSING]);
        var r = await call(H1, 'POST', 'p/upstage', body, { 'content-type': CT }, { chunked: true, piece: 32768, gapMs: 15 });
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(r.json.post, { x: 'v' });
        assert.deepEqual(r.json.files, [
            { name: 'a.bin', size: 4096, onDisk: 4096 },
            { name: 'b.bin', size: 300 * 1024, onDisk: 300 * 1024 },
            { name: 'c.bin', size: 4096, onDisk: 4096 }
        ]);
        await assertAnswering('01.2', H1, s.mark);
    });

    it('01.3  on a slow disk the request ends before the parser does: the upload is still answered 200, whole', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('01.3', H1);
        // small pieces, paced so that each reaches the parser on its own: the buffers between the parser
        // and the disk count chunks, so they hold little of this body, and it is still being written
        // when the request ends
        await slowDisk(H1, 10);
        try {
            var size = 600 * 1024;
            var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([filePart('slow.bin', bytes(size)), CLOSING]), { 'content-type': CT }, { chunked: true, piece: 4096, gapMs: 2 });
            assert.equal(r.status, 200, JSON.stringify(r));
            assert.deepEqual(r.json.files, [{ name: 'slow.bin', size: size, onDisk: size }]);
        } finally { await slowDisk(H1, 0); }
        await assertAnswering('01.3', H1, s.mark);
    });

    // ── 02 a body that ends early ────────────────────────────────────────────

    it('02.1  CONTROL — a body ending inside a text field, with no file part, is answered 400', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.1', H1);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([fieldHead('a'), Buffer.from('value')]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertNothingLeft('02.1', H1, s.before);
        await assertAnswering('02.1', H1, s.mark);
    });

    it('02.2  a body ending inside a file part, to a url no route matches, is answered 400', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.2', H1);
        var r = await call(H1, 'POST', 'no/such/route', Buffer.concat([fileHead('x.bin'), bytes(2048)]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('02.2', H1, s.mark);
        await assertNothingLeft('02.2', H1, s.before);
    });

    it('02.3  the same on a routed url: answered 400, and the action does not run', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.3', H1);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([fileHead('x.bin'), bytes(2048)]), { 'content-type': CT }, {});
        assert.equal(r.status, 400, JSON.stringify(r));
        assert.equal(r.json.files, undefined, 'the action did not answer');
        await assertAnswering('02.3', H1, s.mark);
        await assertNothingLeft('02.3', H1, s.before);
    });

    it('02.4  a complete file part, then a second one the body ends inside: neither stays staged', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.4', H1);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([filePart('a.bin', bytes(4096)), fileHead('b.bin'), bytes(4096)]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('02.4', H1, s.mark);
        await assertNothingLeft('02.4', H1, s.before);
    });

    it('02.5  a complete file part, then a text field the body ends inside: the file does not stay staged', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.5', H1);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([filePart('a.bin', bytes(4096)), fieldHead('t'), Buffer.from('partial')]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('02.5', H1, s.mark);
        await assertNothingLeft('02.5', H1, s.before);
    });

    it('02.6  a body ending inside a part its upload group refuses is answered 400', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.6', H1);
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([fileHead('x.bin', 'nosuchgroup'), bytes(2048)]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('02.6', H1, s.mark);
        await assertNothingLeft('02.6', H1, s.before);
    });

    it('02.7  a malformed part header after a complete file part: answered 400, and what follows it is not staged', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('02.7', H1);
        var bad  = Buffer.from('--' + BOUNDARY + '\r\nBad Header Line\r\n\r\nxx\r\n');
        var r = await call(H1, 'POST', 'p/upstage', Buffer.concat([filePart('a.bin', bytes(4096)), bad, filePart('after.bin', bytes(4096)), CLOSING]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('02.7', H1, s.mark);
        await assertNothingLeft('02.7', H1, s.before);
    });

    // ── 03 a client that goes away ───────────────────────────────────────────








    // ── 04 the whole-body cap with no content-length ─────────────────────────








    // ── 05 HTTP/2 ────────────────────────────────────────────────────────────

    it('05.1  CONTROL — a complete upload with no content-length under the cap is answered 200, whole', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('05.1', H2);
        var session = await h2connect(H2);
        var size = 64 * 1024;
        var r = await h2call(H2, session, 'POST', 'p/upstage', Buffer.concat([filePart('h2.bin', bytes(size)), CLOSING]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(r.json.files, [{ name: 'h2.bin', size: size, onDisk: size }]);
        await sleep(AFTER_CLEANUP_MS);
        assert.deepEqual(stagedSince(s.before), [], '[instrument] the cleanup timer of this bundle is armed and removes the staged file');
        await assertAnswering('05.1', H2, s.mark);
    });



    it('05.4  a body ending inside a file part is answered 400', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('05.4', H2);
        var session = await h2connect(H2);
        var r = await h2call(H2, session, 'POST', 'p/upstage', Buffer.concat([fileHead('x.bin'), bytes(2048)]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('05.4', H2, s.mark);
        await assertNothingLeft('05.4', H2, s.before);
    });


    it('05.6  a body ending early, the stream cancelled while the parser is still finishing: the bundle keeps answering', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('05.6', H2);
        var session = await h2connect(H2);
        await slowDisk(H2, 0, 500);
        try {
            var st = await h2call(H2, session, 'POST', 'p/upstage', Buffer.concat([fileHead('x.bin'), bytes(2048)]), { 'content-type': CT }, true);
            st.end();
            await sleep(150);
            st.close(http2.constants.NGHTTP2_CANCEL);
            await sleep(800);
        } finally { await slowDisk(H2, 0); }
        try { session.close(); } catch (e) { /* ignore */ }
        assert.equal(/HTTP2 UNCAUGHT EXCEPTION/.test(H2.out.slice(s.mark)), false, 'the late answer does not write to the closed stream');
        await assertAnswering('05.6', H2, s.mark);
        await assertNothingLeft('05.6', H2, s.before);
    });


    it('05.9  a finished part removed by the stop: its cleanup timer finds it gone and does nothing', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('05.9', H2);
        var session = await h2connect(H2);
        var r = await h2call(H2, session, 'POST', 'p/upstage', Buffer.concat([filePart('a.bin', bytes(4096)), fileHead('b.bin'), bytes(4096)]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        assert.equal(r.status, 400, JSON.stringify(r));
        await sleep(AFTER_CLEANUP_MS);
        var logged = H2.out.slice(s.mark);
        assert.equal(logged.indexOf('[ onListenerThrow ]'), -1, 'the timer raised nothing: ' + logged.slice(-400));
        await assertAnswering('05.9', H2, s.mark);
        await assertNothingLeft('05.9', H2, s.before);
    });

    it('05.7  over HTTP/1.1 on the same bundle (TLS): a body ending inside a file part is answered 400', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('05.7', H2);
        var r = await call(H2, 'POST', 'p/upstage', Buffer.concat([fileHead('x.bin'), bytes(2048)]), { 'content-type': CT });
        assert.equal(r.status, 400, JSON.stringify(r));
        await assertAnswering('05.7', H2, s.mark);
        await assertNothingLeft('05.7', H2, s.before);
    });
});
