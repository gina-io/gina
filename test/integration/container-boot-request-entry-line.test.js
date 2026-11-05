/**
 * Stall observability — the opt-in request-entry line (`settings.json > server.logRequestStart`),
 * through a booted `http/2.0` + https bundle (isaac), for HTTP/1.1 and HTTP/2 clients.
 *
 * gina logs a request when it completes. With `server.logRequestStart: true` an application
 * request also writes `METHOD [>] /path [ req <id> ]` at info, as the first step of
 * core/server.js's non-static branch, before its body is read, so a request that blocks the
 * bundle is in the log before it blocks. The bundle is booted three times; the setting and the
 * log format change between boots (both are read once at boot):
 *
 *   01  text mode, setting on: one entry line per application request, carrying the id the
 *       answer echoes in X-Request-Id, before that request's completion line, over HTTP/1.1 and
 *       HTTP/2; a 404; no query string in the path; an inbound X-Request-Id kept; a blocking
 *       action (its line is in the log while the action blocks) and a PUT whose body arrives in
 *       two parts (its line is in the log before the second part is sent); no line for
 *       /_gina/health/check (GET and HEAD) or a static file.
 *   02  JSON mode, setting on: the same message text, and the JSON line carries `requestId`
 *       (the echoed id) and a numeric `durationMs`.
 *   03  setting off (the control): the same requests write no entry line, while their
 *       completion lines are read, so the reader fires.
 *
 * Isolation: the container-boot-head-b675.test.js shape — a throwaway HOME under os.tmpdir(),
 * its own port window (14600), a self-signed certificate under that HOME, project:rm + rmSync at
 * teardown. Seam: `RL_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded
 * by THAT tree's CLI.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-request-entry-line.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rl-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rl' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14600;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;
var BLOCK_MS         = 1500;

var GINA_ROOT = process.env.RL_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;
delete CHILD_ENV.GINA_LOG_FORMAT;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE + '/', ssFile = null, ssBase = null;
var child = null, childOut = '', childExit = null, h2session = null, dumpCount = 0;


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

/** HTTP/1.1 over TLS: a fresh connection per request, no ALPN offer of h2. `parts` are written `gapMs` apart. */
function h1(method, fullPath, headers, parts, gapMs, onGap) {
    return new Promise(function (resolve) {
        var body = (parts || []).join('');
        var hdrs = Object.assign({}, headers || {});
        if (parts) { hdrs['content-type'] = 'application/json'; hdrs['content-length'] = Buffer.byteLength(body); }
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: fullPath, method: method, headers: hdrs,
            rejectUnauthorized: false, agent: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, body: data, headers: res.headers, at: Date.now() }); });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', headers: {}, at: Date.now() }); });
        if (!parts) { req.end(); return; }
        req.write(parts[0]);
        setTimeout(function () {
            if (onGap) { onGap(); }
            req.end(parts[1]);
        }, gapMs);
    });
}

/** HTTP/2 over the boot's session. */
function h2(method, fullPath, headers) {
    return new Promise(function (resolve) {
        var status = null, data = '', hdrs = {};
        var stream = h2session.request(Object.assign({ ':method': method, ':path': fullPath }, headers || {}));
        stream.setTimeout(15000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
        stream.on('response', function (h) { status = h[':status']; hdrs = h; });
        stream.on('data', function (c) { data += c; });
        stream.on('error', function (e) { resolve({ status: null, err: e.message, body: data, headers: hdrs, at: Date.now() }); });
        stream.on('close', function () { resolve({ status: status, body: data, headers: hdrs, at: Date.now() }); });
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
 * The log's messages in order: the `message` of each JSON line, or each text line with its
 * colour codes and its `[date] [level][bundle]` prefix removed.
 *
 * @param {string} out - The child's stdout and stderr
 * @param {boolean} json - JSON log mode
 * @returns {string[]} The messages
 */
function messages(out, json) {
    var list = [];
    out.split('\n').forEach(function (line) {
        if (json) {
            var obj = null;
            try { obj = JSON.parse(line); } catch (e) { return; }
            // the logger ends every message with a space
            if (obj && typeof obj.message == 'string') { list.push(obj.message.replace(/\s+$/, '')); }
            return;
        }
        var plain = line.replace(/\x1b\[[0-9;]*m/g, '');
        var m = plain.match(/^\[[^\]]*\] \[[^\]]*\]\[[^\]]*\] (.*)$/);
        if (m) { list.push(m[1].replace(/\s+$/, '')); }
    });
    return list;
}

/** The entry lines among the messages: { method, path, id, index }. */
function entries(msgs) {
    var list = [];
    msgs.forEach(function (msg, i) {
        var m = msg.match(/^(\S+) \[>\] (\S+) \[ req ([^ \]]+) \]$/);
        if (m) { list.push({ method: m[1], path: m[2], id: m[3], index: i }); }
    });
    return list;
}

function entriesFor(msgs, fullPath) { return entries(msgs).filter(function (e) { return e.path === fullPath; }); }
function completionIndex(msgs, method, code, fullPath) { return msgs.indexOf(method + ' [' + code + '] ' + fullPath); }

/** Routes and actions: a fast GET, a GET that blocks the main thread, a PUT. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.rl_fast  = { namespace: 'content', url: '/rl/fast',  method: 'GET', param: { control: 'rlFast' } };
    r.rl_block = { namespace: 'content', url: '/rl/block', method: 'GET', param: { control: 'rlBlock' } };
    r.rl_put   = { namespace: 'content', url: '/rl/put',   method: 'PUT', param: { control: 'rlPut' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.rlFast = function(req, res) {',
        '        self.renderJSON({ ok: true });',
        '    };',
        '    this.rlBlock = function(req, res) {',
        '        var until = Date.now() + ' + BLOCK_MS + ';',
        '        while (Date.now() < until) { /* the main thread is blocked */ }',
        '        self.renderJSON({ ok: true });',
        '    };',
        '    this.rlPut = function(req, res) {',
        '        self.renderJSON({ ok: true, keys: Object.keys(req.put || {}) });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));

    var src = path.join(PROJ_DIR, 'src', BUNDLE, 'public');
    if (!fs.existsSync(src)) { throw new Error('no public directory under ' + path.dirname(src)); }
    fs.mkdirSync(path.join(src, 'js'), { recursive: true });
    fs.writeFileSync(path.join(src, 'js', 'rl-static.js'), 'var rl = 1;\n');
}

/** protocol http/2.0 + scheme https, spliced after the scaffold's webroot line (comments kept). */
function spliceHttp2(file) {
    var s = fs.readFileSync(file, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol/scheme'); }
    fs.writeFileSync(file, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https"'));
}

/** settings.server.json with, or without, `"logRequestStart": true` after the scheme line. */
function writeSetting(on) {
    if (!on) { fs.writeFileSync(ssFile, ssBase); return; }
    var anchor = '"scheme": "https"';
    if (ssBase.split(anchor).length !== 2) { throw new Error('scheme anchor count ' + (ssBase.split(anchor).length - 1)); }
    fs.writeFileSync(ssFile, ssBase.replace(anchor, anchor + ',\n    "logRequestStart": true'));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}

/** Boots the bundle with the setting `on` and the log `format`; resolves an error string or null. */
async function boot(on, format) {
    writeSetting(on);
    childOut = ''; childExit = null;
    var env = Object.assign({}, CHILD_ENV, { GINA_LOG_FORMAT: format });
    child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { childOut += d; });
    child.stderr.on('data', function (d) { childOut += d; });
    child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while (Date.now() < deadline && !childExit) {
        if (await isTcpPortOpen(bundlePort)) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    if (!up) { return 'the bundle did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000); }
    await sleep(300);
    h2session = http2.connect('https://127.0.0.1:' + bundlePort, { rejectUnauthorized: false });
    h2session.on('error', function () { /* an arm reads its own stream error */ });
    await new Promise(function (resolve) { h2session.once('connect', resolve); setTimeout(resolve, 5000); });
    return null;
}

async function stop() {
    if (h2session) { try { h2session.close(); } catch (e) { /* ignore */ } h2session = null; }
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
    child = null;
    if (!bundlePort) { return; }
    var free = Date.now() + 8000;
    while (Date.now() < free && await isTcpPortOpen(bundlePort)) { await sleep(150); }
}

/** One full pass over the arms; returns what each arm read, for the boot's assertions. */
async function drive() {
    var p = {
        fast1: webroot + 'rl/fast', fast2: webroot + 'rl/fast?token=rlsecret123', block: webroot + 'rl/block',
        put: webroot + 'rl/put', nope: webroot + 'rl/nope', stat: webroot + 'js/rl-static.js'
    };
    var r = {};
    r.h1 = await h1('GET', p.fast1);
    r.h2 = await h2('GET', p.fast1);
    r.query = await h1('GET', p.fast2);
    r.inbound = await h2('GET', p.fast1, { 'x-request-id': 'rl-inbound-1' });
    r.nope = await h1('GET', p.nope);
    r.healthGet = await h1('GET', '/_gina/health/check');
    r.healthHead = await h2('HEAD', '/_gina/health/check');
    r.stat = await h1('GET', p.stat);

    // a blocking action: read the log while the action blocks
    var blockSent = Date.now();
    var pending = h2('GET', p.block);
    await sleep(Math.floor(BLOCK_MS / 2));
    r.blockSnapshot = childOut; r.blockSnapshotAt = Date.now();
    r.block = await pending; r.blockSent = blockSent;

    // a PUT whose body arrives in two parts: read the log before the second part is sent
    var snap = null;
    r.put = await h1('PUT', p.put, {}, ['{"a":', '1}'], 900, function () { snap = childOut; });
    r.putSnapshot = snap;
    await sleep(400);
    r.paths = p;
    r.out = childOut;
    // RL_DUMP=<file prefix> keeps each boot's output for reading
    if (process.env.RL_DUMP) { fs.writeFileSync(process.env.RL_DUMP + '-' + (++dumpCount) + '.log', childOut); }
    return r;
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot-request-entry-line — the opt-in request-entry line (server.logRequestStart)', function () {

    before(function () {
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
        // view:add gives the bundle its public directory (the static-file arm)
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (va.status !== 0) { setupError = 'view:add failed: ' + (va.stderr || va.stdout).slice(-500); return; }

        // the project must load the tree under test (the #B422 Franken-boot trap)
        try {
            var target = fs.realpathSync(path.join(PROJ_DIR, 'node_modules', 'gina'));
            if (target !== fs.realpathSync(GINA_ROOT)) { setupError = 'node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
        } catch (e) { setupError = 'node_modules/gina is not linked: ' + (e.message || e); return; }

        ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
        try {
            installRoutes();
            spliceHttp2(ssFile);
            ssBase = fs.readFileSync(ssFile, 'utf8');
            makeCertificate();
        } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/2.0']['https']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/2.0 https port for ' + key; return; }
        try {
            var wr = (ssBase.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
    });

    after(async function () {
        await stop();
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    /** The arms shared by the two boots with the setting on. */
    function assertOn(r, json) {
        var msgs = messages(r.out, json), p = r.paths;

        // HTTP/1.1 and HTTP/2: one entry line each, the id the answer echoes, before the completion line
        [['h1', r.h1], ['h2', r.h2]].forEach(function (pair) {
            var res = pair[1], id = res.headers['x-request-id'];
            assert.equal(res.status, 200, pair[0] + ' status');
            assert.ok(id, pair[0] + ' echoes an X-Request-Id');
            var mine = entries(msgs).filter(function (e) { return e.id === id; });
            assert.equal(mine.length, 1, pair[0] + ': one entry line for ' + id);
            assert.equal(mine[0].method, 'GET');
            assert.equal(mine[0].path, p.fast1);
        });
        var firstCompletion = completionIndex(msgs, 'GET', 200, p.fast1);
        assert.ok(firstCompletion > -1, 'the completion line is read');
        assert.ok(entriesFor(msgs, p.fast1)[0].index < firstCompletion, 'the entry line comes before the completion line');

        // no query string in the path, and the query's text nowhere in an entry line
        var qid = r.query.headers['x-request-id'];
        var q = entries(msgs).filter(function (e) { return e.id === qid; });
        assert.equal(r.query.status, 200);
        assert.equal(q.length, 1, 'one entry line for the query-string request');
        assert.equal(q[0].path, p.fast1, 'the path carries no query string');
        assert.equal(entries(msgs).filter(function (e) { return e.path.indexOf('rlsecret123') > -1; }).length, 0);

        // an inbound X-Request-Id is the line's id
        assert.equal(r.inbound.status, 200);
        assert.equal(r.inbound.headers['x-request-id'], 'rl-inbound-1');
        assert.equal(entries(msgs).filter(function (e) { return e.id === 'rl-inbound-1'; }).length, 1);

        // an unrouted request writes its entry line too
        assert.equal(r.nope.status, 404);
        assert.equal(entriesFor(msgs, p.nope).length, 1, 'a 404 has its entry line');

        // no line for the health route (GET, HEAD) or a static file
        assert.equal(r.healthGet.status, 200);
        assert.equal(r.healthHead.status, 200);
        assert.equal(entries(msgs).filter(function (e) { return e.path.indexOf('/_gina/') > -1; }).length, 0, 'no entry line for /_gina/*');
        assert.equal(r.stat.status, 200, 'the static file is served');
        assert.equal(entriesFor(msgs, p.stat).length, 0, 'no entry line for a static file');

        // the blocking action: its line is in the log while the action blocks
        assert.equal(r.block.status, 200);
        assert.ok(r.block.at - r.blockSent >= BLOCK_MS, 'the action blocked for ' + BLOCK_MS + ' ms (' + (r.block.at - r.blockSent) + ')');
        assert.ok(r.blockSnapshotAt < r.block.at, 'the log was read before the answer');
        assert.equal(entriesFor(messages(r.blockSnapshot, json), p.block).length, 1, 'the entry line is in the log while the action blocks');

        // the PUT: its line is in the log before the second part of its body is sent
        assert.equal(r.put.status, 200);
        assert.ok(r.putSnapshot !== null, 'the log was read between the two parts');
        assert.equal(entriesFor(messages(r.putSnapshot, json), p.put).length, 1, 'the entry line is in the log before the body ends');
        assert.equal(entriesFor(messages(r.putSnapshot, json), p.put)[0].method, 'PUT');
    }

    describe('01 - text log mode, setting on', function () {
        var r = null, err = null;
        before(async function () {
            if (skip || setupError) { return; }
            err = await boot(true, 'text');
            if (!err) { r = await drive(); }
            await stop();
        });
        it('01.1 - one entry line per application request, none for /_gina/* or a static file, written before a blocking action or a body ends', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            assertOn(r, false);
        });
    });

    describe('02 - JSON log mode, setting on', function () {
        var r = null, err = null;
        before(async function () {
            if (skip || setupError) { return; }
            err = await boot(true, 'json');
            if (!err) { r = await drive(); }
            await stop();
        });
        it('02.1 - the same lines, and each entry line carries requestId (the echoed id) and a numeric durationMs', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            assertOn(r, true);
            var id = r.h1.headers['x-request-id'], found = 0;
            r.out.split('\n').forEach(function (line) {
                var obj = null;
                try { obj = JSON.parse(line); } catch (e) { return; }
                if (obj && typeof obj.message == 'string' && obj.message.replace(/\s+$/, '') === 'GET [>] ' + r.paths.fast1 + ' [ req ' + id + ' ]') {
                    found++;
                    assert.equal(obj.requestId, id, 'the JSON line carries the request id');
                    assert.equal(typeof obj.durationMs, 'number', 'and a numeric durationMs');
                    assert.equal(obj.level, 'info');
                }
            });
            assert.equal(found, 1, 'the JSON entry line is read');
        });
    });

    describe('03 - setting off (the control)', function () {
        var r = null, err = null;
        before(async function () {
            if (skip || setupError) { return; }
            err = await boot(false, 'json');
            if (!err) { r = await drive(); }
            await stop();
        });
        it('03.1 - no entry line at all, while the completion lines are read', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            var msgs = messages(r.out, true);
            assert.equal(r.h1.status, 200);
            assert.equal(r.put.status, 200);
            assert.ok(completionIndex(msgs, 'GET', 200, r.paths.fast1) > -1, 'the reader sees the completion lines');
            assert.equal(entries(msgs).length, 0, 'no entry line');
            assert.equal(r.out.indexOf(' [>] '), -1, 'no entry marker anywhere in the output');
        });
    });
});
