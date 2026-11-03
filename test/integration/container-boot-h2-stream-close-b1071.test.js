/**
 * #B1071 — an HTTP/2 stream whose request body gina stops reading once it has answered.
 *
 * Three answers go out while the client may still be sending its body: the 431 by the byte counter
 * past `upload.maxFieldsSize` (a multipart request with no `content-length`), the 413 past
 * `server.maxBodySize` and the 400 of a multipart body that fails to parse. Over HTTP/2 the answer goes
 * out on the request's own stream. Node closes a server stream by itself only when its body was never
 * read, so this stream stayed open: the client could push one more stream window into a request
 * nobody reads, then stalled, and Bun 1.2 / 1.3 took everything the client sent. The server now closes
 * the stream with RST_STREAM(NO_ERROR) once its answer has gone out whole (RFC 9113 § 8.1).
 *
 * This file boots the REAL bin/gina-container (isaac) with one HTTP/2 bundle that has HTML views and
 * custom error pages, and reads what the client sees: the answer, whether the server closed the
 * stream, its reset code and how much the client could still push after the answer. The client never
 * ends a held stream, so a close it reads came from the server. Arms:
 *   C0, C1   controls — a complete upload and a complete JSON body are answered 200 and end normally
 *   P0       over the cap WITH a content-length: the 431 is sent before a byte is read (Node closes that
 *            stream by itself; Bun 1.2 / 1.3 did not)
 *   R1       the ticket — over the cap with NO content-length: the 431 by the byte counter
 *   R2       a JSON body past server.maxBodySize: the 413
 *   R3       a malformed multipart body: the 400
 *   R5       eight R1s on one session
 *   A0 A2 A3 the P0, R2 and R3 shapes as HTML requests, answered through the bundle's custom error page,
 *            which is rendered after throwError has returned: the page must go out whole before the close
 *
 * Instrument: `heldPost()` reads the answer, whether the stream closed before the client's own cleanup,
 * and its reset code. Both of its readings fire on the tree before this change, on Node: P0 reads a
 * server close (Node's own rule for a body never read) and R1 reads none.
 *
 * Isolation: a throwaway HOME and project under os.tmpdir(), its own port window (14500; the next
 * booted window starts at 14550), a self-signed certificate under that HOME, project:rm + rmSync at
 * teardown.
 *
 * Seams, for a reading by hand:
 *   B1071_GINA_ROOT=<tree> boots THAT tree's launcher against a project scaffolded by THAT tree's CLI
 *   (red-first against the tree before this change, with no write to it: R1, R2, R3, R5, A2 and A3 fail
 *   on Node, P0 and A0 too on Bun 1.2 / 1.3);
 *   B1071_RUNTIME=<path to a bun binary> runs the bundle on it (the CLI stays on this runtime);
 *   B1071_PUSH_LIMIT=<bytes> caps what one held stream may push (default 64 MB, since Bun 1.2 / 1.3 took
 *   a held stream's body without bound).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-h2-stream-close-b1071.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http2  = require('http2');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var crypto = require('crypto');
var { spawnSync, spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b1071-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'b1071sc' + STAMP;
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14500;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 10000;
var CAP                = 1024 * 1024;   // upload.maxFieldsSize of the throwaway bundle

// heldPost(): how long a held stream is fed at most, how long without 'drain' reads as a stall, how
// long a close may take to arrive once the feeding stops, and what the client writes at a time
var FEED_MS  = 5000;
var STALL_MS = 1500;
var LATE_MS  = 1500;
var PIECE    = 16 * 1024;
// What the client may still write once it has read the answer's headers. Measured on the seven
// runtimes (Node 22 / 24 / 25 / 26, Bun 1.2.21 / 1.3.14 / 1.4.2 / 1.4.4): 0 to 64 KB once the server
// closes the stream; before that, one stream window on Node (384 KB to 640 KB, then a stall) and
// everything sent on Bun 1.2 / 1.3.
var AFTER_ANSWER_MAX = 256 * 1024;
var PUSH_LIMIT = Number(process.env.B1071_PUSH_LIMIT) || 64 * 1024 * 1024;

var GINA_ROOT = process.env.B1071_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');
var RUNTIME   = process.env.B1071_RUNTIME || process.execPath;

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;

// one bundle: HTTP/2 over TLS, HTML views, custom error pages for 431, 413 and 400
var B = { name: 'webtwo', port: null, webroot: '/webtwo/', child: null, out: '', exit: null };

var BOUNDARY = '----b1071' + STAMP;
var CT       = 'multipart/form-data; boundary=' + BOUNDARY;
var CLOSING  = Buffer.from('--' + BOUNDARY + '--\r\n');
var BAD      = Buffer.from('--' + BOUNDARY + '\r\nBad Header Line\r\n\r\nxx\r\n');

// On a bundle with views, throwError answers an XHR with JSON and any other request with the page.
var XHR  = { 'x-requested-with': 'XMLHttpRequest' };
var HTML = { 'accept': 'text/html' };

var MESSAGES = {
    431: 'Attachment exceeded maximum file size [ 1MB ]',
    413: 'Request body exceeded maximum size [ 256KB ]',
    400: 'Malformed multipart/form-data request'
};

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

function fileHead(filename) {
    return Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="f"; filename="' + filename + '"'
        + '\r\nContent-Type: application/octet-stream\r\n\r\n');
}
function filePart(filename, data) { return Buffer.concat([fileHead(filename), data, Buffer.from('\r\n')]); }

function h2connect(b) {
    return new Promise(function (resolve) {
        var session = http2.connect('https://127.0.0.1:' + b.port, { rejectUnauthorized: false });
        session.on('error', function () {});
        session.once('connect', function () { resolve(session); });
        setTimeout(function () { resolve(session); }, 5000);
    });
}

/** One request over HTTP/2 on `session`, ended by the client. Never rejects. */
function h2call(b, session, method, reqPath, body, headers) {
    return new Promise(function (resolve) {
        var done = false, status = null, data = '', ended = false;
        var finish = function (v) { if (!done) { done = true; resolve(v); } };
        var st;
        try { st = session.request(Object.assign({ ':method': method, ':path': b.webroot + reqPath }, headers || {})); }
        catch (e) { finish({ status: null, json: null, err: e.code || e.message }); return; }
        st.setTimeout(REQUEST_TIMEOUT_MS, function () { st.close(http2.constants.NGHTTP2_CANCEL); });
        st.on('response', function (h) { status = h[':status']; });
        st.on('data', function (d) { data += d; });
        st.on('end', function () { ended = true; });
        st.on('error', function (e) { finish({ status: status, json: null, err: e.code || e.message }); });
        st.on('close', function () {
            var json = null;
            try { json = JSON.parse(data); } catch (e) { json = null; }
            finish({ status: status, json: json, text: data, ended: ended, rst: st.rstCode });
        });
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

async function get(b, reqPath) {
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
    return { mark: b.out.length };
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

/**
 * One POST stream on `session` that the client never ends: writes `first`, then PIECE-sized chunks for
 * FEED_MS, or until the stream closes, the client stalls (no 'drain' within STALL_MS) or `opts.limit`
 * bytes have gone. A close read here therefore came from the server. Returns the reading: the answer
 * (`status`, `body`, `ended` once END_STREAM arrived), `serverClosed` (the stream closed before the
 * client's own cleanup), `rst` (the reset code of that close, null when the server did not close) and
 * `pushedAfterAnswer` (what the client wrote once it had read the answer's headers).
 */
async function heldPost(label, session, headers, first, opts) {
    opts = opts || {};
    var reading = { label: label, status: null, ended: false, body: '', serverClosed: null, rst: null, err: null,
                    tAnswerMs: null, tCloseMs: null, pushedAfterAnswer: 0, stalled: false };
    var st, t0 = Date.now(), body = '', closedAt = null, closeRst = null;
    try { st = session.request(Object.assign({ ':method': 'POST', ':path': B.webroot + 'p/upstage' }, headers)); }
    catch (e) { reading.err = e.code || e.message; return reading; }
    st.on('response', function (h) { reading.status = h[':status']; reading.tAnswerMs = Date.now() - t0; });
    st.on('data', function (d) { body += d; });
    st.on('end', function () { reading.ended = true; });
    st.on('error', function (e) { reading.err = reading.err || (e.code || e.message); });
    st.on('close', function () { if (closedAt === null) { closedAt = Date.now() - t0; closeRst = st.rstCode; } });
    var count = function (n) { if (reading.status !== null) { reading.pushedAfterAnswer += n; } };
    var limit = Math.min(opts.limit || Infinity, PUSH_LIMIT), sent = 0, piece = bytes(PIECE);
    if (first) { st.write(first); sent += first.length; count(first.length); }
    var until = Date.now() + FEED_MS;
    while (Date.now() < until && !st.destroyed && closedAt === null && sent + PIECE <= limit) {
        var ok;
        try { ok = st.write(piece); } catch (e) { reading.err = reading.err || (e.code || e.message); break; }
        sent += PIECE; count(PIECE);
        if (!ok) {
            var drained = await new Promise(function (r) {
                var tm = setTimeout(function () { st.removeListener('drain', onDrain); st.removeListener('close', onClose); r(false); }, STALL_MS);
                var onDrain = function () { clearTimeout(tm); st.removeListener('close', onClose); r(true); };
                var onClose = function () { clearTimeout(tm); st.removeListener('drain', onDrain); r(true); };
                st.once('drain', onDrain); st.once('close', onClose);
            });
            if (!drained) { reading.stalled = true; break; }
        }
        if (opts.gapMs) { await sleep(opts.gapMs); }
    }
    var late = Date.now() + LATE_MS;
    while (closedAt === null && Date.now() < late) { await sleep(50); }
    reading.serverClosed = closedAt !== null;
    reading.tCloseMs = closedAt;
    reading.rst = reading.serverClosed ? closeRst : null;
    reading.body = body;
    try { if (!st.destroyed) { st.close(http2.constants.NGHTTP2_CANCEL); } } catch (e) { /* ignore */ }
    return reading;
}

/** The reading without its body, for a diagnostic line. */
function summary(r) {
    var s = Object.assign({}, r);
    s.body = r.body.slice(0, 120);
    return s;
}

/** The answer went out whole: its END_STREAM arrived, and the page or the JSON document is complete. */
function assertWhole(label, r, want) {
    assert.equal(r.ended, true, label + ': the answer ends (END_STREAM) before the stream closes: ' + JSON.stringify(summary(r)));
    if (want.html) {
        var page = new RegExp('^<!doctype html><html><head><title>t</title></head><body>B1071-PAGE status=' + want.status + ' ref=[0-9A-F]{6}</body></html>$');
        assert.match(r.body, page, label + ': the custom error page, whole');
        return;
    }
    var json = null;
    try { json = JSON.parse(r.body); } catch (e) { json = null; }
    assert.ok(json, label + ': the JSON answer parses: ' + JSON.stringify(r.body.slice(0, 300)));
    assert.equal(json.status, want.status, label + ': its status');
    assert.equal(json.error, MESSAGES[want.status], label + ': its message');
}

/** The reading of one held stream, against what the server must do with it. */
function assertClosedAfterAnswer(label, r, want) {
    assert.equal(r.status, want.status, label + ': answered ' + want.status + ': ' + JSON.stringify(summary(r)));
    assertWhole(label, r, want);
    assert.equal(r.serverClosed, true, label + ': the server closes the stream once it has answered: ' + JSON.stringify(summary(r)));
    assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR, label + ': with NO_ERROR: ' + JSON.stringify(summary(r)));
    assert.equal(r.stalled, false, label + ': the client is never left stalled: ' + JSON.stringify(summary(r)));
    assert.ok(r.pushedAfterAnswer <= AFTER_ANSWER_MAX, label + ': the client pushed ' + r.pushedAfterAnswer + ' B after the answer: ' + JSON.stringify(summary(r)));
}

/** Routes, actions and the upload settings of the throwaway bundle. */
function installScene(b) {
    var src = path.join(PROJ_DIR, 'src', b.name);
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };

    var rf = path.join(src, 'config', 'routing.json');
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.p_ping    = { namespace: 'content', url: '/p/ping',    method: 'GET',  param: { control: 'pping' } };
    r.p_upstage = { namespace: 'content', url: '/p/upstage', method: 'POST', param: { control: 'pupstage' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var sf = path.join(src, 'config', 'settings.json');
    var st = fs.readFileSync(sf, 'utf8');
    if (st.indexOf('"upload"') > -1) { throw new Error('settings.json already holds an upload block'); }
    fs.writeFileSync(sf, st.replace('{', '{\n    "upload": { "maxFieldsSize": "1MB", "groups": { "untagged": { "allowedExtensions": "*", "isMultipleAllowed": true } } },'));

    var cf = path.join(src, 'controllers', 'controller.content.js');
    var c = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (c.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (c.split(anchor).length - 1)); }
    fs.writeFileSync(cf, c.replace(anchor, [
        '    this.pping = function(req, res) { self.renderJSON({ ok: true }); };',
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
}

/** protocol http/2.0 + scheme https + a 256KB maxBodySize, spliced after the scaffold's webroot line. */
function spliceHttp2(b) {
    var ssFile = path.join(PROJ_DIR, 'src', b.name, 'config', 'settings.server.json');
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol or scheme'); }
    fs.writeFileSync(ssFile, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https",\n    "maxBodySize": "256KB"'));
}

/** The custom error pages an HTML request is answered with. */
function addErrorPages(b) {
    var errorsDir = path.join(PROJ_DIR, 'src', b.name, 'templates', 'html', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });
    ['431', '413', '400'].forEach(function (code) {
        fs.writeFileSync(path.join(errorsDir, code + '.html'),
            '<!doctype html><html><head><title>t</title></head><body>B1071-PAGE status={{ page.data.status }} ref={{ page.data.ref }}</body></html>');
    });
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

describe('container-boot-h2-stream-close — the server closes an HTTP/2 stream it has stopped reading, once its answer has gone out (#B1071)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (!hasOpenssl()) { skip = true; skipReason = 'openssl is not available to mint the test certificate'; return; }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) { setupError = 'project:add did not register @' + PROJ; return; }
        runCli(['bundle:add', B.name, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var ports = fs.existsSync(portsReversePath) ? readJSON(portsReversePath) : {};
        if (!ports[B.name + '@' + PROJ]) { setupError = 'bundle:add did not register the bundle: ' + Object.keys(ports); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        // HTML views: an HTML request is then answered through the bundle's error pages
        var va = runCli(['view:add', B.name, '@' + PROJ]);
        if (!fs.existsSync(path.join(PROJ_DIR, 'src', B.name, 'templates', 'html', 'layouts', 'main.html'))) {
            setupError = 'view:add did not install the templates: ' + (va.stdout + va.stderr).slice(-800); return;
        }

        try {
            installScene(B);
            spliceHttp2(B);
            addErrorPages(B);
            makeCertificate();
        } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { B.port = ports[B.name + '@' + PROJ][env]['http/2.0']['https']; } catch (e) { B.port = null; }
        if (!B.port) { setupError = 'could not resolve the bound port'; return; }
        B.webroot = webroot(B);

        if (!(await ensureUp(B))) { setupError = B.name + ' did not come up: ' + JSON.stringify(B.exit) + '\n' + B.out.slice(-2000); }
    });

    after(async function () {
        if (isAlive(B)) {
            try { B.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 4000;
            while (Date.now() < until && isAlive(B)) { await sleep(150); }
            if (isAlive(B)) { try { B.child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        }
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    /** One held stream on a fresh session, then a GET on that same session, then the bundle's state. */
    async function probe(t, label, headers, first, opts, want) {
        var s = await up(label, B);
        var session = await h2connect(B);
        var r = await heldPost(label, session, headers, first, opts);
        var again = await h2call(B, session, 'GET', 'p/ping');
        try { session.close(); } catch (e) { /* ignore */ }
        t.diagnostic(label + ' reading: ' + JSON.stringify(summary(r)) + ' · pingAfter ' + again.status);
        assertClosedAfterAnswer(label, r, want);
        assert.equal(again.status, 200, label + ': the same session still answers: ' + JSON.stringify(again));
        await assertAnswering(label, B, s.mark);
        return r;
    }

    it('C0  CONTROL — a complete upload under the cap: 200, the file listed, and the stream ends normally', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('C0', B);
        var session = await h2connect(B);
        var size = 64 * 1024;
        var r = await h2call(B, session, 'POST', 'p/upstage', Buffer.concat([filePart('ok.bin', bytes(size)), CLOSING]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        t.diagnostic('C0 reading: ' + JSON.stringify({ status: r.status, ended: r.ended, rst: r.rst, err: r.err || null }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(r.json.files, [{ name: 'ok.bin', size: size, onDisk: size }]);
        assert.equal(r.ended, true);
        assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR);
        await assertAnswering('C0', B, s.mark);
    });

    it('C1  CONTROL — a complete JSON body under server.maxBodySize: 200, and the stream ends normally', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('C1', B);
        var session = await h2connect(B);
        var r = await h2call(B, session, 'POST', 'p/upstage', Buffer.from(JSON.stringify({ a: 'b' })), { 'content-type': 'application/json' });
        try { session.close(); } catch (e) { /* ignore */ }
        t.diagnostic('C1 reading: ' + JSON.stringify({ status: r.status, ended: r.ended, rst: r.rst, json: r.json, err: r.err || null }));
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.json.post.a, 'b');
        assert.equal(r.ended, true);
        assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR);
        await assertAnswering('C1', B, s.mark);
    });

    it('P0  over the cap WITH a content-length: the 431 before a byte is read, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'P0', Object.assign({ 'content-type': CT, 'content-length': String(2 * CAP) }, XHR), fileHead('over.bin'), { limit: 2 * CAP, gapMs: 5 }, { status: 431 });
    });

    it('R1  the ticket — over the cap with NO content-length: the 431 by the byte counter, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'R1', Object.assign({ 'content-type': CT }, XHR), fileHead('over.bin'), {}, { status: 431 });
    });

    it('R2  a JSON body past server.maxBodySize (256KB), no content-length: the 413, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'R2', Object.assign({ 'content-type': 'application/json' }, XHR), Buffer.from('{"a":"'), {}, { status: 413 });
    });

    it('R3  a malformed multipart body, no content-length: the 400 by the parser, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'R3', Object.assign({ 'content-type': CT }, XHR), Buffer.concat([filePart('a.bin', bytes(4096)), BAD]), {}, { status: 400 });
    });

    it('R5  eight R1s in a row on ONE session: each answered 431 and closed, and the session still answers', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('R5', B);
        var session = await h2connect(B);
        var rows = [];
        for (var i = 0; i < 8; i++) {
            rows.push(await heldPost('R5.' + i, session, Object.assign({ 'content-type': CT }, XHR), fileHead('over' + i + '.bin'), {}));
        }
        var again = await h2call(B, session, 'GET', 'p/ping');
        try { session.close(); } catch (e) { /* ignore */ }
        t.diagnostic('R5 rows: ' + JSON.stringify(rows.map(function (x) { return { status: x.status, serverClosed: x.serverClosed, rst: x.rst, tCloseMs: x.tCloseMs, pushedAfterAnswer: x.pushedAfterAnswer, stalled: x.stalled, err: x.err }; })) + ' · pingAfter ' + again.status);
        rows.forEach(function (x) { assertClosedAfterAnswer(x.label, x, { status: 431 }); });
        assert.equal(again.status, 200, 'the session still answers: ' + JSON.stringify(again));
        await assertAnswering('R5', B, s.mark);
    });

    it('A0  the P0 shape as an HTML request: the 431 page, whole, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'A0', Object.assign({ 'content-type': CT, 'content-length': String(2 * CAP) }, HTML), fileHead('over.bin'), { limit: 2 * CAP, gapMs: 5 }, { status: 431, html: true });
    });

    it('A2  the R2 shape as an HTML request: the 413 page, whole, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'A2', Object.assign({ 'content-type': 'application/json' }, HTML), Buffer.from('{"a":"'), {}, { status: 413, html: true });
    });

    it('A3  the R3 shape as an HTML request: the 400 page, whole, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'A3', Object.assign({ 'content-type': CT }, HTML), Buffer.concat([filePart('a.bin', bytes(4096)), BAD]), {}, { status: 400, html: true });
    });
});
