/**
 * #B1086 — a multipart request that gina refuses while it parses the body is answered, then its HTTP/2
 * stream is closed.
 *
 * The busboy listeners in core/server.js refuse a request mid-parse in ten places. Eight are in the
 * 'file' listener: the 400s for too many files (`upload.maxFields`), an unconfigured upload group, a
 * disallowed extension and a second file in a single-file group, the 500 of an upload directory that
 * cannot be created, the 500 of a write error (here through the documented `simulateWriteError` probe)
 * and the guard's 500 when the listener throws. In each the part's stream is never read, so the parser
 * waits on it and gina stops reading the request: on Node.js and Bun 1.4 the client stalls at the stream
 * window with the stream left open; Bun 1.2 / 1.3 take everything the client sends. Two are text-field
 * caps (`upload.maxTextFieldSize`, `upload.maxTextFields`), and the guard's 500 when the 'field'
 * listener throws behaves like them: the parser goes on reading, so the client can keep sending, later
 * file parts are staged, and on a request that ends before `upload.maxFieldsSize` those staged parts stay
 * on disk with no owner. The fix gives each refusal the shape of the parse-failure stop: the upload stops
 * (abortMultipart), the answer goes out, then the stream closes with RST_STREAM(NO_ERROR) (#B1071).
 *
 * This file boots the REAL bin/gina-container (isaac) with one HTTP/2 bundle and reads what the client
 * sees, through the held-stream instrument of container-boot-h2-stream-close-b1071.test.js: the answer,
 * whether the server closed the stream, its reset code, whether the client stalled and how much it could
 * push after the answer. The client never ends a held stream, so a close read here came from the server.
 * Arms:
 *   C0, C1   controls — a complete upload and a complete upload with a text field: 200, ended normally
 *   U1–U4    the 'file' listener's 400s: an unconfigured group, a disallowed extension, a second file in a
 *            single-file group, more files than upload.maxFields
 *   U5, U6   its 500s: an upload directory that cannot be created, a write error (simulateWriteError)
 *   U7f      the guard's 500 for a throw in the 'file' listener (a test double on fs.createWriteStream)
 *   U7d      the guard's 500 for a throw in the 'field' listener (the #B843 double on nestBracketNotationKey)
 *   U8, U9   the text-field caps, then a file part the client keeps feeding
 *   U8c, U9c the text-field caps on a request the client ends under the cap: no staged part stays on disk
 *   C2       control — a complete upload in the single-file group: its part is staged where the arms look
 *   U3c, U4c the 'file' 400s on a request the client ends: the parts staged AHEAD of the refused one go
 *   ZU1, ZU7f a zero receive window (the answer never finishes): the bundle's rss, read while the stream is
 *            held, does not grow with what the client keeps sending (Bun 1.2 / 1.3 have no flow control)
 *   HC       control over HTTP/1.1 (ALPN http/1.1, same bundle): a complete upload answers 200
 *   HU1, HU8 the U1 and U8 refusals over HTTP/1.1: the 400 arrives and the bundle keeps answering; what
 *            the socket does (closed, stalled, pushed after the answer) is recorded, not asserted
 *
 * Instrument: on the tree before this change every U arm fails. On Node.js U1–U7f read a stall and no
 * server close, and U8, U9 and U7d read the close of the byte counter (#B1056) only once the client has
 * pushed past upload.maxFieldsSize (1 MB here), far past AFTER_ANSWER_MAX; U8c and U9c find the staged
 * part. C0 and C1 pass on both trees.
 *
 * Isolation: a throwaway HOME and project under os.tmpdir(), its own port window (14550), a self-signed
 * certificate under that HOME, project:rm + rmSync at teardown.
 *
 * Seams, for a reading by hand:
 *   B1086_GINA_ROOT=<tree> boots THAT tree's launcher against a project scaffolded by THAT tree's CLI;
 *   B1086_RUNTIME=<path to a bun binary> runs the bundle on it (the CLI stays on this runtime);
 *   B1086_PUSH_LIMIT=<bytes> caps what one held stream may push (default 64 MB).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-h2-upload-refusal-b1086.test.js
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http2  = require('http2');
var https  = require('https');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var crypto = require('crypto');
var { spawnSync, spawn, execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b1086-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'b1086ur' + STAMP;
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14550;

// where the bundle stages parts: the global tmpPath, the throwing double's group, and a path that
// cannot be created (a directory under a character device)
var STAGING    = path.join(FAKE_HOME, 'staging');
var THROWY     = path.join(FAKE_HOME, 'staging-b1086throw');
var NODIR      = '/dev/null/b1086';

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
// What the client may still write once it has read the answer's headers (the #B1071 bound): 0 to 64 KB
// once the server closes the stream; before that, one stream window on Node.js and everything sent on
// Bun 1.2 / 1.3.
var AFTER_ANSWER_MAX = 256 * 1024;
var PUSH_LIMIT = Number(process.env.B1086_PUSH_LIMIT) || 64 * 1024 * 1024;
// The retention arms (ZU1, ZU7f): what one held stream is offered under a zero receive window, and the
// growth of the bundle's rss, read while the stream is held, under which nothing counts as held.
var RETAIN_OFFER    = Number(process.env.B1086_RETAIN_OFFER) || 48 * 1024 * 1024;
var RETAIN_BOUND_MB = 20;

var GINA_ROOT = process.env.B1086_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');
var RUNTIME   = process.env.B1086_RUNTIME || process.execPath;

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
// Bun answers HTTP/1.1 on an HTTP/2 server (allowHTTP1) only from 1.4: below it the HTTP/1.1 arms cannot run
var h1Skip = '';
if (RUNTIME !== process.execPath) {
    try {
        var bunVer = String(execFileSync(RUNTIME, ['--version'], { encoding: 'utf8' })).trim().split('.').map(Number);
        if (bunVer[0] < 1 || (bunVer[0] === 1 && bunVer[1] < 4)) { h1Skip = 'Bun ' + bunVer.join('.') + ' serves no HTTP/1.1 on an HTTP/2 server (allowHTTP1 came with Bun 1.4)'; }
    } catch (e) { h1Skip = 'the runtime version could not be read: ' + (e.message || e); }
}

// one bundle: HTTP/2 over TLS
var B = { name: 'webtwo', port: null, webroot: '/webtwo/', child: null, out: '', exit: null };

var BOUNDARY = '----b1086' + STAMP;
var CT       = 'multipart/form-data; boundary=' + BOUNDARY;
var CLOSING  = Buffer.from('--' + BOUNDARY + '--\r\n');

var XHR = { 'x-requested-with': 'XMLHttpRequest' };

// what each refusal answers (a prefix for the 500s, whose message carries the error that caused them)
var MESSAGES = {
    U1: '`nope` is not a configured upload group. See the `upload.groups` definition in settings.json.',
    U2: '`bin` is not an allowed extension. See `imgs` upload group definition.',
    U3: 'multiple uploads not allowed. See `single` upload group definition.',
    U4: 'too many upload fields (max 2). See the `upload.maxFields` definition in settings.json.',
    U5: { prefix: 'upload destination for group `nodir` is not creatable' },
    U6: { prefix: 'Internal server error' },
    U7: { prefix: 'Could not evaluate POST request data.' },
    U8: 'multipart text field `t` exceeds the allowed size. See the `upload.maxTextFieldSize` definition in settings.json.',
    U9: 'too many multipart text fields (max 2). See the `upload.maxTextFields` definition in settings.json.'
};

var DOUBLE_MARK = '[B1086-DOUBLE] fs.createWriteStream wrapped';

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

/** The head of a file part, tagged with an upload group when `group` is given. */
function fileHead(filename, group) {
    return Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="f"'
        + ( group ? '; group="' + group + '"' : '' ) + '; filename="' + filename + '"'
        + '\r\nContent-Type: application/octet-stream\r\n\r\n');
}
function filePart(filename, data, group) { return Buffer.concat([fileHead(filename, group), data, Buffer.from('\r\n')]); }
function fieldPart(name, value) {
    return Buffer.from('--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n');
}

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
    try { st = session.request(Object.assign({ ':method': 'POST', ':path': opts.path || (B.webroot + 'p/upstage') }, headers)); }
    catch (e) { reading.err = e.code || e.message; return reading; }
    st.on('response', function (h) { reading.status = h[':status']; reading.tAnswerMs = Date.now() - t0; });
    st.on('data', function (d) { body += d; });
    st.on('end', function () { reading.ended = true; });
    st.on('error', function (e) { reading.err = reading.err || (e.code || e.message); });
    st.on('close', function () { if (closedAt === null) { closedAt = Date.now() - t0; closeRst = st.rstCode; } });
    var count = function (n) { if (reading.status !== null) { reading.pushedAfterAnswer += n; } };
    var limit = opts.bigLimit || Math.min(opts.limit || Infinity, PUSH_LIMIT), sent = 0, piece = bytes(PIECE);
    if (first) { st.write(first); sent += first.length; count(first.length); }
    var until = Date.now() + (opts.feedMs || FEED_MS);
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
    // a retention arm keeps the stream open and reads the bundle's memory while it is held
    if (opts.keep) { Object.defineProperty(reading, 'stream', { value: st, enumerable: false }); return reading; }
    try { if (!st.destroyed) { st.close(http2.constants.NGHTTP2_CANCEL); } } catch (e) { /* ignore */ }
    return reading;
}

/** The reading without its body, for a diagnostic line. */
function summary(r) {
    var s = Object.assign({}, r);
    s.body = String(r.body || r.text || '').slice(0, 160);
    delete s.text;
    return s;
}

/** The JSON answer went out whole (its END_STREAM arrived) and carries the refusal's status and message. */
function assertRefusal(label, r, want) {
    var raw = ( typeof(r.body) == 'string' ) ? r.body : r.text;
    assert.equal(r.status, want.status, label + ': answered ' + want.status + ': ' + JSON.stringify(summary(r)));
    assert.equal(r.ended, true, label + ': the answer ends (END_STREAM): ' + JSON.stringify(summary(r)));
    var json = null;
    try { json = JSON.parse(raw); } catch (e) { json = null; }
    assert.ok(json, label + ': the JSON answer parses: ' + JSON.stringify(String(raw).slice(0, 300)));
    assert.equal(json.status, want.status, label + ': its status');
    if ( typeof(want.message) == 'string' ) {
        assert.equal(json.error, want.message, label + ': its message');
    } else {
        assert.equal(String(json.error).indexOf(want.message.prefix), 0, label + ': its message: ' + String(json.error).slice(0, 200));
    }
}

/** The reading of one held stream, against what the server must do with it once it has refused it. */
function assertClosedAfterRefusal(label, r, want) {
    assertRefusal(label, r, want);
    assert.equal(r.serverClosed, true, label + ': the server closes the stream once it has answered: ' + JSON.stringify(summary(r)));
    assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR, label + ': with NO_ERROR: ' + JSON.stringify(summary(r)));
    assert.equal(r.stalled, false, label + ': the client is never left stalled: ' + JSON.stringify(summary(r)));
    assert.ok(r.pushedAfterAnswer <= AFTER_ANSWER_MAX, label + ': the client pushed ' + r.pushedAfterAnswer + ' B after the answer: ' + JSON.stringify(summary(r)));
}

/** The staged parts (`*.part`) in the global staging directory. */
function stagedParts() {
    try { return fs.readdirSync(STAGING).filter(function (n) { return /\.part$/.test(n); }).sort(); }
    catch (e) { return [ 'unreadable: ' + (e.code || e.message) ]; }
}

/** Routes, actions, the upload settings and the two throwing doubles of the throwaway bundle. */
function installScene(b) {
    var src = path.join(PROJ_DIR, 'src', b.name);
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };

    var rf = path.join(src, 'config', 'routing.json');
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.p_ping    = { namespace: 'content', url: '/p/ping',    method: 'GET',  param: { control: 'pping' } };
    r.p_upstage = { namespace: 'content', url: '/p/upstage', method: 'POST', param: { control: 'pupstage' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var upload = {
        maxFieldsSize: '1MB',
        maxFields: 2,
        maxTextFields: 2,
        maxTextFieldSize: '1KB',
        tmpPath: STAGING,
        groups: {
            // the framework's own default gives `untagged` a `path` (its ${tmpPath}), which the merge would
            // keep: set it here, so the staged parts land where stagedParts() reads (C0 and C1 check it)
            untagged: { path: STAGING, allowedExtensions: '*', isMultipleAllowed: true },
            imgs:     { allowedExtensions: [ 'jpg' ], isMultipleAllowed: true },
            single:   { allowedExtensions: '*', isMultipleAllowed: false },
            nodir:    { path: NODIR, allowedExtensions: '*', isMultipleAllowed: true },
            probe:    { path: STAGING, allowedExtensions: '*', isMultipleAllowed: true, simulateWriteError: true },
            throwy:   { path: THROWY, allowedExtensions: '*', isMultipleAllowed: true }
        }
    };
    var sf = path.join(src, 'config', 'settings.json');
    var st = fs.readFileSync(sf, 'utf8');
    if (st.indexOf('"upload"') > -1) { throw new Error('settings.json already holds an upload block'); }
    fs.writeFileSync(sf, st.replace('{', '{\n    "upload": ' + JSON.stringify(upload) + ','));
    fs.mkdirSync(STAGING, { recursive: true });

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

    // Two test doubles, ahead of the bundle's start: fs.createWriteStream throws for a path under the
    // `throwy` group's directory (a throw inside the 'file' listener, after its refusals), and the #B843
    // double on nestBracketNotationKey throws for a bracket-notation field name nested through the
    // sentinel key "b1086nest" (a throw inside the 'field' listener). nestBracketNotationKey is a
    // framework global the data helper re-assigns when it is loaded again, so its double sits behind an
    // accessor that re-wraps whatever is assigned (the #B793 / #B843 harness pattern).
    var xf = path.join(src, 'index.js');
    var x = fs.readFileSync(xf, 'utf8');
    var startAnchor = b.name + '.start();';
    if (x.split(startAnchor).length !== 2) { throw new Error('index.js start anchor count ' + (x.split(startAnchor).length - 1)); }
    var doubles = [
        '(function () {',
        '    var fsMod = require("fs");',
        '    var realCreateWriteStream = fsMod.createWriteStream;',
        '    fsMod.createWriteStream = function (p) {',
        '        if (typeof p === "string" && p.indexOf("b1086throw") > -1) { throw new TypeError("b1086 injected: createWriteStream"); }',
        '        return realCreateWriteStream.apply(this, arguments);',
        '    };',
        '    console.error(' + JSON.stringify(DOUBLE_MARK) + ' + " " + (fsMod.createWriteStream !== realCreateWriteStream));',
        '    var guardGlobal = function (name, shouldThrow) {',
        '        var wrap = function (fn) {',
        '            var w = function () {',
        '                if (shouldThrow.apply(null, arguments)) { throw new TypeError("b1086 injected: " + name); }',
        '                return fn.apply(this, arguments);',
        '            };',
        '            w.__b1086 = true;',
        '            return w;',
        '        };',
        '        var cur = wrap(global[name]);',
        '        Object.defineProperty(global, name, { configurable: true, enumerable: true,',
        '            get: function () { return cur; },',
        '            set: function (fn) { cur = (fn && fn.__b1086) ? fn : wrap(fn); } });',
        '    };',
        '    guardGlobal("nestBracketNotationKey", function (obj, keys) {',
        '        return keys && typeof keys.indexOf === "function" && keys.indexOf("b1086nest") > -1;',
        '    });',
        '})();',
        ''
    ].join('\n');
    fs.writeFileSync(xf, x.replace(startAnchor, doubles + startAnchor));
}

/** protocol http/2.0 + scheme https, spliced after the scaffold's webroot line. */
function spliceHttp2(b) {
    var ssFile = path.join(PROJ_DIR, 'src', b.name, 'config', 'settings.server.json');
    var s = fs.readFileSync(ssFile, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol or scheme'); }
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

describe('container-boot-h2-upload-refusal — a multipart request refused while its body is parsed is answered, then its HTTP/2 stream is closed (#B1086)', function () {

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

        try {
            installScene(B);
            spliceHttp2(B);
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
    async function probe(t, label, first, want) {
        var s = await up(label, B);
        var session = await h2connect(B);
        var r = await heldPost(label, session, Object.assign({ 'content-type': CT }, XHR), first, {});
        var again = await h2call(B, session, 'GET', 'p/ping');
        try { session.close(); } catch (e) { /* ignore */ }
        t.diagnostic(label + ' reading: ' + JSON.stringify(summary(r)) + ' · pingAfter ' + again.status);
        assertClosedAfterRefusal(label, r, want);
        assert.equal(again.status, 200, label + ': the same session still answers: ' + JSON.stringify(again));
        await assertAnswering(label, B, s.mark);
        return r;
    }

    /** One request the client ends under the cap: the refusal, then no part it staged may stay on disk. */
    async function complete(t, label, body, want) {
        var s = await up(label, B);
        var before = stagedParts();
        var session = await h2connect(B);
        var r = await h2call(B, session, 'POST', 'p/upstage', body, Object.assign({ 'content-type': CT }, XHR));
        try { session.close(); } catch (e) { /* ignore */ }
        await sleep(800);
        var after = stagedParts();
        var added = after.filter(function (n) { return before.indexOf(n) < 0; });
        t.diagnostic(label + ' reading: ' + JSON.stringify(summary(r)) + ' · staged before ' + before.length + ', after ' + after.length + ', added ' + JSON.stringify(added));
        assertRefusal(label, r, want);
        assert.deepEqual(added, [], label + ': no part the refused request staged may stay on disk');
        await assertAnswering(label, B, s.mark);
        return r;
    }

    it('C0  CONTROL — a complete upload: 200, the file listed, and the stream ends normally', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('C0', B);
        var before = stagedParts();
        var session = await h2connect(B);
        var size = 64 * 1024;
        var r = await h2call(B, session, 'POST', 'p/upstage', Buffer.concat([filePart('ok.bin', bytes(size)), CLOSING]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        var added = stagedParts().filter(function (n) { return before.indexOf(n) < 0; });
        t.diagnostic('C0 reading: ' + JSON.stringify({ status: r.status, ended: r.ended, rst: r.rst, err: r.err || null, stagedAdded: added }));
        assert.equal(r.status, 200, JSON.stringify(summary(r)));
        assert.deepEqual(r.json.files, [{ name: 'ok.bin', size: size, onDisk: size }]);
        assert.equal(r.ended, true);
        assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR);
        // [instrument] the staged part of an accepted upload (its action stores nothing) is where U8c / U9c look
        assert.equal(added.length, 1, '[instrument] C0: the accepted part is staged where stagedParts() reads: ' + JSON.stringify(added));
        await assertAnswering('C0', B, s.mark);
    });

    it('C1  CONTROL — a complete upload with a text field under the caps: 200, the field and the file read', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('C1', B);
        var before = stagedParts();
        var session = await h2connect(B);
        var size = 16 * 1024;
        var r = await h2call(B, session, 'POST', 'p/upstage', Buffer.concat([fieldPart('t', 'short'), filePart('ok.bin', bytes(size)), CLOSING]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        var added = stagedParts().filter(function (n) { return before.indexOf(n) < 0; });
        t.diagnostic('C1 reading: ' + JSON.stringify({ status: r.status, ended: r.ended, rst: r.rst, json: r.json, err: r.err || null, stagedAdded: added }));
        assert.equal(r.status, 200, JSON.stringify(summary(r)));
        assert.equal(r.json.post.t, 'short');
        assert.deepEqual(r.json.files, [{ name: 'ok.bin', size: size, onDisk: size }]);
        assert.equal(r.ended, true);
        assert.equal(r.rst, http2.constants.NGHTTP2_NO_ERROR);
        assert.equal(added.length, 1, '[instrument] C1: the accepted part is staged where stagedParts() reads: ' + JSON.stringify(added));
        await assertAnswering('C1', B, s.mark);
    });

    it('U1  a file part naming an unconfigured upload group: the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U1', fileHead('a.bin', 'nope'), { status: 400, message: MESSAGES.U1 });
    });

    it('U2  a file part with an extension its group does not allow: the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U2', fileHead('a.bin', 'imgs'), { status: 400, message: MESSAGES.U2 });
    });

    it('U3  a second file part in a single-file group: the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U3', Buffer.concat([filePart('one.bin', bytes(4096), 'single'), fileHead('two.bin', 'single')]), { status: 400, message: MESSAGES.U3 });
    });

    it('U4  more file parts than upload.maxFields (2): the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U4', Buffer.concat([filePart('one.bin', bytes(4096)), filePart('two.bin', bytes(4096)), fileHead('three.bin')]), { status: 400, message: MESSAGES.U4 });
    });

    it('U5  a file part whose group directory cannot be created: the 500, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U5', fileHead('a.bin', 'nodir'), { status: 500, message: MESSAGES.U5 });
    });

    it('U6  a file part whose write fails (the simulateWriteError probe): the 500, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U6', fileHead('a.bin', 'probe'), { status: 500, message: MESSAGES.U6 });
    });

    it('U7f a throw inside the \'file\' listener: the guard\'s 500, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        assert.ok(B.out.indexOf(DOUBLE_MARK + ' true') > -1, '[instrument] the fs.createWriteStream double is installed: ' + B.out.slice(-600));
        var mark = B.out.length, failure = null;
        try { await probe(t, 'U7f', fileHead('a.bin', 'throwy'), { status: 500, message: MESSAGES.U7 }); } catch (e) { failure = e; }
        // the double's own throw is read first: a reading taken without it says nothing about the guard
        assert.ok(B.out.slice(mark).indexOf('b1086 injected: createWriteStream') > -1, '[instrument] U7f: the double threw (its message is logged)');
        if (failure) { throw failure; }
    });

    it('U7d a throw inside the \'field\' listener, then a file part the client keeps feeding: the guard\'s 500, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        var mark = B.out.length, failure = null;
        try { await probe(t, 'U7d', Buffer.concat([fieldPart('b1086nest[a]', '1'), fileHead('a.bin')]), { status: 500, message: MESSAGES.U7 }); } catch (e) { failure = e; }
        // the double's own throw is read first: a reading taken without it says nothing about the guard
        assert.ok(B.out.slice(mark).indexOf('b1086 injected: nestBracketNotationKey') > -1, '[instrument] U7d: the double threw (its message is logged)');
        if (failure) { throw failure; }
    });

    it('U8  a text field past upload.maxTextFieldSize (1KB), then a file part the client keeps feeding: the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U8', Buffer.concat([fieldPart('t', 'x'.repeat(2048)), fileHead('a.bin')]), { status: 400, message: MESSAGES.U8 });
    });

    it('U9  more text fields than upload.maxTextFields (2), then a file part the client keeps feeding: the 400, then the stream closes', async function (t) {
        if (!ready(t)) { return; }
        await probe(t, 'U9', Buffer.concat([fieldPart('a', '1'), fieldPart('b', '2'), fieldPart('c', '3'), fileHead('a.bin')]), { status: 400, message: MESSAGES.U9 });
    });

    it('U8c the U8 refusal on a request the client ends under the cap: no part it staged stays on disk', async function (t) {
        if (!ready(t)) { return; }
        await complete(t, 'U8c', Buffer.concat([fieldPart('t', 'x'.repeat(2048)), filePart('a.bin', bytes(64 * 1024)), CLOSING]), { status: 400, message: MESSAGES.U8 });
    });

    it('U9c the U9 refusal on a request the client ends under the cap: no part it staged stays on disk', async function (t) {
        if (!ready(t)) { return; }
        await complete(t, 'U9c', Buffer.concat([fieldPart('a', '1'), fieldPart('b', '2'), fieldPart('c', '3'), filePart('a.bin', bytes(64 * 1024)), CLOSING]), { status: 400, message: MESSAGES.U9 });
    });

    // ── part 72: the 'file' refusals on a request the client ends ─────────────────────────────────────
    // The refused part is never read, so the parser never finishes; the request's 'close' then reads the
    // request as ended and stops nothing: a part staged AHEAD of the refused one is left with no owner.

    it('C2  CONTROL — a complete upload of one file in the single-file group: 200, its part staged where stagedParts() reads', async function (t) {
        if (!ready(t)) { return; }
        var s = await up('C2', B);
        var before = stagedParts();
        var session = await h2connect(B);
        var size = 4096;
        var r = await h2call(B, session, 'POST', 'p/upstage', Buffer.concat([filePart('one.bin', bytes(size), 'single'), CLOSING]), { 'content-type': CT });
        try { session.close(); } catch (e) { /* ignore */ }
        var added = stagedParts().filter(function (n) { return before.indexOf(n) < 0; });
        t.diagnostic('C2 reading: ' + JSON.stringify({ status: r.status, ended: r.ended, rst: r.rst, err: r.err || null, stagedAdded: added }));
        assert.equal(r.status, 200, JSON.stringify(summary(r)));
        assert.deepEqual(r.json.files, [{ name: 'one.bin', size: size, onDisk: size }]);
        assert.equal(added.length, 1, '[instrument] C2: the single-file group\'s accepted part is staged where stagedParts() reads: ' + JSON.stringify(added));
        await assertAnswering('C2', B, s.mark);
    });

    it('U3c the U3 refusal on a request the client ends: the part staged ahead of it does not stay on disk', async function (t) {
        if (!ready(t)) { return; }
        await complete(t, 'U3c', Buffer.concat([filePart('one.bin', bytes(4096), 'single'), filePart('two.bin', bytes(4096), 'single'), CLOSING]), { status: 400, message: MESSAGES.U3 });
    });

    it('U4c the U4 refusal on a request the client ends: the two parts staged ahead of it do not stay on disk', async function (t) {
        if (!ready(t)) { return; }
        await complete(t, 'U4c', Buffer.concat([filePart('one.bin', bytes(4096)), filePart('two.bin', bytes(4096)), filePart('three.bin', bytes(4096)), CLOSING]), { status: 400, message: MESSAGES.U4 });
    });

    // ── part 72: a zero receive window (the client never lets the answer finish) ──────────────────────
    // The close at the answer's 'finish' never runs, so on Bun 1.2 / 1.3 only a discard bounds what the
    // bundle holds; the bundle's rss is read while the stream is held (rv10b's ZFG shape, part 68).

    /** The bundle's memory through /_gina/info (process.memoryUsage() of the bundle process), in MB. */
    async function infoMem() {
        var r = await get(B, '_gina/info');
        var m = (r.json && r.json.memory) || null;
        if (!m) { return { status: r.status, err: r.err || null }; }
        var mb = function (v) { return Math.round((v || 0) / 1048576); };
        return { rss: mb(m.rss), heapUsed: mb(m.heapUsed), external: mb(m.external), arrayBuffers: mb(m.arrayBuffers) };
    }

    /** Stops the bundle (SIGTERM, forwarded by the launcher) and waits for its port to free, so up() boots a fresh one. */
    async function restartFresh(label) {
        if (isAlive(B)) {
            try { B.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 8000;
            while (Date.now() < until && isAlive(B)) { await sleep(150); }
            assert.ok(!isAlive(B), label + ': the bundle must stop on SIGTERM before a fresh boot');
        }
        var free = Date.now() + 8000;
        while (Date.now() < free && await isTcpPortOpen(B.port)) { await sleep(200); }
        assert.equal(await isTcpPortOpen(B.port), false, label + ': the port must be free before a fresh boot');
    }

    /** A session whose client advertises a zero receive window: the server can send headers, no answer body. */
    function h2connectZero(b) {
        return new Promise(function (resolve) {
            var session = http2.connect('https://127.0.0.1:' + b.port, { rejectUnauthorized: false, settings: { initialWindowSize: 0 } });
            session.on('error', function () {});
            session.once('connect', function () { resolve(session); });
            setTimeout(function () { resolve(session); }, 5000);
        });
    }

    /** A fresh bundle, one stream offered RETAIN_OFFER bytes under a zero window and KEPT open; rss read before and while held. */
    async function retain(t, label, first, wantStatus) {
        await restartFresh(label);
        var s = await up(label, B);
        await sleep(1500);
        var m0 = await infoMem();
        var session = await h2connectZero(B);
        var t0 = Date.now();
        var r = await heldPost(label, session, Object.assign({ 'content-type': CT }, XHR), first, { keep: true, bigLimit: RETAIN_OFFER, feedMs: 20000 });
        var pushMs = Date.now() - t0;
        var m1 = await infoMem();
        await sleep(2000);
        var m2 = await infoMem();
        var stillOpen = !!(r.stream && !r.stream.destroyed);
        try { if (stillOpen) { r.stream.close(http2.constants.NGHTTP2_CANCEL); } } catch (e) { /* ignore */ }
        try { session.close(); } catch (e) { /* ignore */ }
        var grownMB = ( typeof(m0.rss) == 'number' && typeof(m1.rss) == 'number' && typeof(m2.rss) == 'number' ) ? Math.max(m1.rss, m2.rss) - m0.rss : null;
        t.diagnostic(label + ' RETENTION ' + JSON.stringify({ status: r.status, ended: r.ended, serverClosed: r.serverClosed, rst: r.rst, stillOpenAtRead: stillOpen,
            tAnswerMs: r.tAnswerMs, tCloseMs: r.tCloseMs, pushMs: pushMs, pushedAfterAnswerMB: Math.round(r.pushedAfterAnswer / 1048576), stalled: r.stalled, err: r.err,
            infoBefore: m0, infoHeld: m1, infoHeld2s: m2, grownMB: grownMB }));
        assert.equal(typeof(m0.rss), 'number', '[instrument] ' + label + ': the bundle\'s rss is read before the push: ' + JSON.stringify(m0));
        assert.equal(typeof(m2.rss), 'number', '[instrument] ' + label + ': the bundle\'s rss is read while the stream is held: ' + JSON.stringify(m2));
        assert.equal(r.status, wantStatus, label + ': the refusal\'s headers arrive: ' + JSON.stringify(summary(r)));
        assert.ok(grownMB < RETAIN_BOUND_MB, label + ': the bundle holds ' + grownMB + ' MB more while the stream is held (' + Math.round(r.pushedAfterAnswer / 1048576) + ' MB pushed after the answer)');
        // part 73: on Node.js the client is held at the stream window after a refusal it never reads (develop's
        // behaviour, and the documented one); on Bun what it sends is discarded by design (#B1076), so only the
        // memory bound applies there. By runtime, never by version.
        if (RUNTIME === process.execPath) {
            assert.ok(r.stalled && r.pushedAfterAnswer <= 1048576, label + ': on Node.js the client is held at the stream window (stalled ' + r.stalled + ', ' + r.pushedAfterAnswer + ' B pushed after the answer)');
        }
        await assertAnswering(label, B, s.mark);
        return r;
    }

    it('ZU1 a zero receive window, the U1 shape (an unconfigured group): the bundle does not hold what the client keeps sending', async function (t) {
        if (!ready(t)) { return; }
        await retain(t, 'ZU1', fileHead('a.bin', 'nope'), 400);
    });

    it('ZU7f a zero receive window, the U7f shape (the guard\'s 500 for a throw in the \'file\' listener): the bundle does not hold what the client keeps sending', async function (t) {
        if (!ready(t)) { return; }
        await retain(t, 'ZU7f', fileHead('a.bin', 'throwy'), 500);
    });

    it('ZU6 a zero receive window, the U6 shape (the write stream\'s 500, answered from its own \'error\' listener): the bundle does not hold what the client keeps sending', async function (t) {
        if (!ready(t)) { return; }
        await retain(t, 'ZU6', fileHead('a.bin', 'probe'), 500);
    });

    // part 73: the same refusal with 512 KB of the part in the FIRST write, so the parser has stopped taking
    // input (the unread part) before the write stream's asynchronous 'error' answers: Node's unpipe() then
    // runs the pipe's pending drain handler, which resumes a request that still has a 'data' listener
    it('ZU6b a zero receive window, the U6 shape with 512 KB of the part in the first write: the bundle does not hold what the client keeps sending', async function (t) {
        if (!ready(t)) { return; }
        await retain(t, 'ZU6b', Buffer.concat([fileHead('a.bin', 'probe'), bytes(512 * 1024)]), 500);
    });

    // ── part 72: HTTP/1.1 (TLS, ALPN http/1.1, the same bundle) ───────────────────────────────────────
    // There is no stream to close over HTTP/1.1: these arms assert the answer and a bundle that keeps
    // answering, and record what the socket does (closed, stalled, what was pushed after the answer).

    /** One POST over HTTP/1.1 with a chunked body the client never ends, fed like heldPost; the socket's fate recorded. */
    async function heldPostH1(t, label, first) {
        var s = await up(label, B);
        var r = { label: label, alpn: null, status: null, body: '', socketClosed: false, err: null, tAnswerMs: null, tCloseMs: null, pushedAfterAnswer: 0, stalled: false };
        var t0 = Date.now(), closedAt = null;
        var req = https.request({ host: '127.0.0.1', port: B.port, method: 'POST', path: B.webroot + 'p/upstage', agent: false, rejectUnauthorized: false,
            ALPNProtocols: ['http/1.1'], headers: Object.assign({ 'transfer-encoding': 'chunked', 'content-type': CT }, XHR) });
        req.on('socket', function (so) {
            so.on('secureConnect', function () { r.alpn = so.alpnProtocol; });
            so.on('close', function () { if (closedAt === null) { closedAt = Date.now() - t0; } });
        });
        req.on('response', function (res) { r.status = res.statusCode; r.tAnswerMs = Date.now() - t0; res.on('data', function (d) { r.body += d; }); res.on('error', function () {}); });
        req.on('error', function (e) { r.err = r.err || (e.code || e.message); });
        var sent = 0, piece = bytes(PIECE), until = Date.now() + FEED_MS;
        var count = function (n) { if (r.status !== null) { r.pushedAfterAnswer += n; } };
        req.write(first); sent += first.length; count(first.length);
        while (Date.now() < until && closedAt === null && !req.destroyed && sent + PIECE <= PUSH_LIMIT) {
            var ok;
            try { ok = req.write(piece); } catch (e) { r.err = r.err || (e.code || e.message); break; }
            sent += PIECE; count(PIECE);
            if (!ok) {
                var drained = await new Promise(function (res) {
                    var tm = setTimeout(function () { req.removeListener('drain', onDrain); res(false); }, STALL_MS);
                    var onDrain = function () { clearTimeout(tm); res(true); };
                    req.once('drain', onDrain);
                });
                if (!drained) { r.stalled = true; break; }
            }
        }
        var late = Date.now() + LATE_MS;
        while (closedAt === null && Date.now() < late) { await sleep(50); }
        r.socketClosed = closedAt !== null; r.tCloseMs = closedAt;
        try { req.destroy(); } catch (e) { /* ignore */ }
        t.diagnostic(label + ' HTTP/1.1 ' + JSON.stringify({ alpn: r.alpn, status: r.status, socketClosed: r.socketClosed, tAnswerMs: r.tAnswerMs, tCloseMs: r.tCloseMs,
            pushedAfterAnswer: r.pushedAfterAnswer, stalled: r.stalled, err: r.err, body: r.body.slice(0, 160) }));
        assert.equal(r.alpn, 'http/1.1', '[instrument] ' + label + ': the connection negotiated HTTP/1.1');
        await assertAnswering(label, B, s.mark);
        return r;
    }

    it('HC  CONTROL over HTTP/1.1 (TLS, ALPN http/1.1): a complete upload answers 200 on that protocol, its part staged', async function (t) {
        if (!ready(t)) { return; }
        if (h1Skip) { t.skip(h1Skip); return; }
        var s = await up('HC', B);
        var before = stagedParts();
        var size = 4096;
        var body = Buffer.concat([filePart('ok.bin', bytes(size)), CLOSING]);
        var r = await new Promise(function (resolve) {
            var out = { alpn: null, status: null, body: '' };
            var req = https.request({ host: '127.0.0.1', port: B.port, method: 'POST', path: B.webroot + 'p/upstage', agent: false, rejectUnauthorized: false,
                ALPNProtocols: ['http/1.1'], headers: { 'content-type': CT, 'content-length': body.length } });
            req.on('socket', function (so) { so.on('secureConnect', function () { out.alpn = so.alpnProtocol; }); });
            req.on('response', function (res) { out.status = res.statusCode; res.on('data', function (d) { out.body += d; }); res.on('end', function () { resolve(out); }); });
            req.on('error', function (e) { out.err = e.code || e.message; resolve(out); });
            req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
            req.end(body);
        });
        var added = stagedParts().filter(function (n) { return before.indexOf(n) < 0; });
        t.diagnostic('HC reading: ' + JSON.stringify({ alpn: r.alpn, status: r.status, err: r.err || null, body: String(r.body).slice(0, 160), stagedAdded: added }));
        assert.equal(r.alpn, 'http/1.1', '[instrument] HC: the connection negotiated HTTP/1.1');
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(JSON.parse(r.body).files, [{ name: 'ok.bin', size: size, onDisk: size }]);
        assert.equal(added.length, 1, '[instrument] HC: the accepted part is staged where stagedParts() reads');
        await assertAnswering('HC', B, s.mark);
    });

    it('HU1 the U1 refusal over HTTP/1.1, a chunked body never ended: the 400 arrives and the bundle keeps answering (the socket recorded)', async function (t) {
        if (!ready(t)) { return; }
        if (h1Skip) { t.skip(h1Skip); return; }
        var r = await heldPostH1(t, 'HU1', fileHead('a.bin', 'nope'));
        assert.equal(r.status, 400, 'HU1: answered 400: ' + JSON.stringify(r).slice(0, 300));
    });

    it('HU8 the U8 refusal over HTTP/1.1, then a file part the client keeps feeding: the 400 arrives and the bundle keeps answering (the socket recorded)', async function (t) {
        if (!ready(t)) { return; }
        if (h1Skip) { t.skip(h1Skip); return; }
        var r = await heldPostH1(t, 'HU8', Buffer.concat([fieldPart('t', 'x'.repeat(2048)), fileHead('a.bin')]));
        assert.equal(r.status, 400, 'HU8: answered 400: ' + JSON.stringify(r).slice(0, 300));
    });
});
