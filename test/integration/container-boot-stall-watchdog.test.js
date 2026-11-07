/**
 * Stall watchdog (`settings.json > server.stallWatchdog`), through a booted `http/2.0` + https
 * bundle (isaac) under bin/gina-container — the container shape: GINA_LOG_STDOUT=true, so the
 * bundle's fd 1 IS the container's log and the MQ flow is off.
 *
 * A worker thread watches a heartbeat the main thread bumps every 250 ms; after `threshold` of
 * silence it writes ONE crit line itself, while the main thread is still blocked, naming the
 * silence and the application requests in flight (oldest first, each with the id its answer
 * echoes in X-Request-Id). When the main thread resumes, a warn line gives the whole silence.
 * The bundle is booted four times (the setting and the log format are read once at boot):
 *
 *   01  text mode, `{ enabled: true, threshold: "2s", captureFrames: false }`: a PUT whose body
 *       is still on its way, then a GET whose action blocks the main thread 6 s. The log, read 4 s
 *       into the block, already holds the crit line naming BOTH requests (the PUT first: it
 *       entered first, before its body was read); the warn line follows the block; the boot
 *       announced the watchdog.
 *   02  JSON mode: the same, as one JSON object at crit with `stall.inFlight` carrying the ids.
 *   03  setting off (the control): the same block, and no stall line anywhere.
 *   04  text mode, the frames on (the default): the same line names the blocked thread's call
 *       frames first, innermost first: the action, relative to the project root, then the
 *       framework's own frames, relative to the framework directory.
 *
 * Isolation: the container-boot-request-entry-line.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14700), a self-signed certificate under that HOME,
 * project:rm + rmSync at teardown. Seam: `SW_GINA_ROOT=<tree>` boots THAT tree's launcher
 * against a project scaffolded by THAT tree's CLI.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-stall-watchdog.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-sw-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'sw' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14700;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;
var BLOCK_MS         = 6000;
var READ_AT_MS       = 4000;
var PUT_GAP_MS       = 5500;

var GINA_ROOT = process.env.SW_GINA_ROOT || path.resolve(__dirname, '../..');
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

/** HTTP/1.1 over TLS, a fresh connection: the body's two `parts` are written `gapMs` apart. */
function h1(method, fullPath, parts, gapMs) {
    return new Promise(function (resolve) {
        var body = (parts || []).join('');
        var hdrs = {};
        if (parts) { hdrs['content-type'] = 'application/json'; hdrs['content-length'] = Buffer.byteLength(body); }
        var req = https.request({
            host: '127.0.0.1', port: bundlePort, path: fullPath, method: method, headers: hdrs,
            rejectUnauthorized: false, agent: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, body: data, headers: res.headers, at: Date.now() }); });
        });
        req.setTimeout(30000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', headers: {}, at: Date.now() }); });
        if (!parts) { req.end(); return; }
        req.write(parts[0]);
        setTimeout(function () { req.end(parts[1]); }, gapMs);
    });
}

/** HTTP/2 over the boot's session. */
function h2(method, fullPath) {
    return new Promise(function (resolve) {
        var status = null, data = '', hdrs = {};
        var stream = h2session.request({ ':method': method, ':path': fullPath });
        stream.setTimeout(30000, function () { stream.close(http2.constants.NGHTTP2_CANCEL); });
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
 * The log's lines as `{ level, message, obj }`: each JSON line parsed, or each text line with
 * its colour codes and `[date] [level][bundle]` prefix taken apart.
 *
 * @param {string} out - The child's stdout and stderr
 * @param {boolean} json - JSON log mode
 * @returns {Array<{level: string, message: string, obj: ?Object}>}
 */
function lines(out, json) {
    var list = [];
    out.split('\n').forEach(function (line) {
        if (json) {
            var obj = null;
            try { obj = JSON.parse(line); } catch (e) { return; }
            if (obj && typeof obj.message == 'string') { list.push({ level: obj.level, message: obj.message.replace(/\s+$/, ''), obj: obj }); }
            return;
        }
        var plain = line.replace(/\x1b\[[0-9;]*m/g, '');
        var m = plain.match(/^\[[^\]]*\] \[([a-z]+)\s*\]\[[^\]]*\] (.*)$/);
        if (m) { list.push({ level: m[1], message: m[2].replace(/\s+$/, ''), obj: null }); }
    });
    return list;
}

function stallLines(out, json) {
    return lines(out, json).filter(function (l) { return l.message.indexOf('[ STALL ] main thread blocked') === 0; });
}
function resumeLines(out, json) {
    return lines(out, json).filter(function (l) { return l.message.indexOf('[ STALL ] main thread resumed') === 0; });
}

/** Routes and actions: a GET whose action blocks the main thread, a PUT. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.sw_block = { namespace: 'content', url: '/sw/block', method: 'GET', param: { control: 'swBlock' } };
    r.sw_put   = { namespace: 'content', url: '/sw/put',   method: 'PUT', param: { control: 'swPut' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.swBlock = function(req, res) {',
        '        var until = Date.now() + ' + BLOCK_MS + ';',
        '        while (Date.now() < until) { /* the main thread is blocked */ }',
        '        self.renderJSON({ ok: true });',
        '    };',
        '    this.swPut = function(req, res) {',
        '        self.renderJSON({ ok: true, keys: Object.keys(req.put || {}) });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/** protocol http/2.0 + scheme https, spliced after the scaffold's webroot line (comments kept). */
function spliceHttp2(file) {
    var s = fs.readFileSync(file, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol/scheme'); }
    fs.writeFileSync(file, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https"'));
}

/**
 * settings.server.json without the watchdog block (`on` false), with it and the frames off
 * (`on` true: arms 01/02 test the line without them), or with the frames on, the default
 * (`on` 'frames'), after the scheme line.
 */
function writeSetting(on) {
    if (!on) { fs.writeFileSync(ssFile, ssBase); return; }
    var anchor = '"scheme": "https"';
    if (ssBase.split(anchor).length !== 2) { throw new Error('scheme anchor count ' + (ssBase.split(anchor).length - 1)); }
    var block = (on === 'frames')
        ? '{ "enabled": true, "threshold": "2s" }'
        : '{ "enabled": true, "threshold": "2s", "captureFrames": false }';
    fs.writeFileSync(ssFile, ssBase.replace(anchor, anchor + ',\n    "stallWatchdog": ' + block));
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
    await sleep(500);
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

/** A PUT whose body is still on its way, then a blocking GET; the log read during the block. */
async function drive() {
    var p = { block: webroot + 'sw/block', put: webroot + 'sw/put' };
    var r = { paths: p };
    var health = await h1('GET', '/_gina/health/check');
    r.healthStatus = health.status;
    var putPending = h1('PUT', p.put, ['{"a":', '1}'], PUT_GAP_MS);
    await sleep(300);
    r.blockSent = Date.now();
    var blockPending = h2('GET', p.block);
    await sleep(READ_AT_MS);
    r.snapshot = childOut; r.snapshotAt = Date.now();
    r.block = await blockPending;
    r.put = await putPending;
    await sleep(800);
    r.out = childOut;
    // SW_DUMP=<file prefix> keeps each boot's output for reading
    if (process.env.SW_DUMP) { fs.writeFileSync(process.env.SW_DUMP + '-' + (++dumpCount) + '.log', childOut); }
    return r;
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot-stall-watchdog — the stall watchdog (server.stallWatchdog)', function () {

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

    /** The arms shared by the two boots with the setting on; returns the stall line. */
    function assertOn(r, json) {
        var putId   = r.put.headers['x-request-id'];
        var blockId = r.block.headers['x-request-id'];
        assert.equal(r.healthStatus, 200);
        assert.equal(r.block.status, 200);
        assert.equal(r.put.status, 200, 'the PUT completed once its body arrived');
        assert.ok(putId && blockId, 'both answers echo an X-Request-Id');
        assert.ok(r.block.at - r.blockSent >= BLOCK_MS, 'the action blocked ' + BLOCK_MS + ' ms (' + (r.block.at - r.blockSent) + ')');
        assert.ok(r.snapshotAt < r.block.at, 'the log was read before the blocking answer');

        var boot = lines(r.out, json).filter(function (l) { return l.message.indexOf('[stallWatchdog] watching the main thread: a silence of 2.0s or more is reported') === 0; });
        assert.equal(boot.length, 1, 'the boot announced the watchdog (the thread started)');

        var during = stallLines(r.snapshot, json);
        assert.equal(during.length, 1, 'ONE crit line, already in the log while the main thread is blocked');
        assert.equal(during[0].level, 'crit');
        var msg = during[0].message;
        var re  = new RegExp('^\\[ STALL \\] main thread blocked: no heartbeat for \\d+\\.\\ds — in flight 2: '
            + 'PUT ' + r.paths.put.replace(/\//g, '\\/') + ' \\[ req ' + putId + ' \\] \\d+\\.\\ds, '
            + 'GET ' + r.paths.block.replace(/\//g, '\\/') + ' \\[ req ' + blockId + ' \\] \\d+\\.\\ds$');
        assert.match(msg, re, 'it names the PUT waiting for its body, then the blocking GET, by the ids their answers echo');
        assert.equal(msg.indexOf('/_gina/'), -1, 'no /_gina/* request in the ring');

        assert.equal(stallLines(r.out, json).length, 1, 'one line per stall');
        var resumed = resumeLines(r.out, json);
        assert.equal(resumed.length, 1, 'one warn line once the main thread resumes');
        assert.equal(resumed[0].level, 'warn');
        var secs = Number((resumed[0].message.match(/no heartbeat for (\d+\.\d)s in all$/) || [])[1]);
        assert.ok(secs >= BLOCK_MS / 1000 - 0.5 && secs <= BLOCK_MS / 1000 + 2, 'the whole silence, about the block: ' + secs);
        return during[0];
    }

    describe('01 - text log mode, setting on', function () {
        var r = null, err = null;
        before(async function () {
            if (skip || setupError) { return; }
            err = await boot(true, 'text');
            if (!err) { r = await drive(); }
            await stop();
        });
        it('01.1 - the crit line names both requests while the main thread is blocked; the warn line follows', function (t) {
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
        it('02.1 - the same line, as one JSON object at crit, with `stall.inFlight` carrying the ids', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            var line  = assertOn(r, true);
            var stall = line.obj.stall;
            assert.ok(stall && typeof stall.ms == 'number' && stall.ms >= 2000, 'stall.ms');
            assert.equal(stall.runtime, 'node');
            assert.equal(stall.captured, false);
            assert.deepEqual(stall.inFlight.map(function (e) { return e.id; }), [r.put.headers['x-request-id'], r.block.headers['x-request-id']]);
            assert.deepEqual(stall.inFlight.map(function (e) { return e.method; }), ['PUT', 'GET']);
            assert.equal(line.obj.bundle, line.obj.group);
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
        it('03.1 - the same block, and no stall line anywhere', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            assert.equal(r.block.status, 200);
            assert.ok(r.block.at - r.blockSent >= BLOCK_MS, 'the action blocked (the control is live)');
            assert.ok(lines(r.out, true).length > 0, 'the reader parses the log (an instrument that can fire)');
            assert.equal(r.out.indexOf('[ STALL ]'), -1, 'no stall line');
            assert.equal(r.out.indexOf('[stallWatchdog]'), -1, 'no watchdog at all');
        });
    });

    describe('04 - text log mode, the frames on (the default)', function () {
        var r = null, err = null;
        before(async function () {
            if (skip || setupError) { return; }
            err = await boot('frames', 'text');
            if (!err) { r = await drive(); }
            await stop();
        });
        it('04.1 - the crit line names the action\'s frame, relative to the project, the framework\'s, relative to its directory, then both requests', function (t) {
            if (skip) { return t.skip(skipReason); }
            assert.equal(setupError, null, setupError);
            assert.equal(err, null, err);
            var putId   = r.put.headers['x-request-id'];
            var blockId = r.block.headers['x-request-id'];
            assert.equal(r.block.status, 200);
            assert.ok(putId && blockId, 'both answers echo an X-Request-Id');
            assert.ok(r.snapshotAt < r.block.at, 'the log was read before the blocking answer');

            var during = stallLines(r.snapshot, false);
            assert.equal(during.length, 1, 'ONE crit line, already in the log while the main thread is blocked');
            var msg = during[0].message;
            var m = msg.match(/^\[ STALL \] main thread blocked: no heartbeat for \d+\.\ds — frames: (.+) — in flight 2: PUT (\S+) \[ req (\S+) \] \d+\.\ds, GET (\S+) \[ req (\S+) \] \d+\.\ds$/);
            assert.ok(m, msg);
            var frames = m[1].split(' <- ');
            assert.match(frames[0], /swBlock \(src\/web\/controllers\/controller\.content\.js:\d+:\d+\)$/, 'the innermost frame is the action, relative to the project: ' + m[1]);
            assert.ok(frames.some(function (f) { return /\((core|lib)\/[^)]+\.js:\d+:\d+\)$/.test(f); }), 'a framework frame, relative to the framework directory: ' + m[1]);
            assert.equal(m[1].indexOf(PROJ_DIR), -1, 'no absolute project path: ' + m[1]);
            assert.deepEqual([m[2], m[3], m[4], m[5]], [r.paths.put, putId, r.paths.block, blockId]);

            assert.equal(stallLines(r.out, false).length, 1, 'one line per stall');
            assert.equal(resumeLines(r.out, false).length, 1, 'the warn line follows');
        });
    });
});
