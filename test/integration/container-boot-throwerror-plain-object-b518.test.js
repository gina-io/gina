/**
 * #B518 — `throwError()` called with ONE plain object keeps the object's
 * `message` and its relay-safe `ref`.
 *
 * In the one-argument form the build kept only `status` and `error` of a plain
 * object: the object's `message` never reached the JSON body, and its `ref` was
 * replaced by a fresh one. The shape that meets this in practice is a relay
 * between bundles: `self.query()` hands its callback the upstream's JSON error
 * body as a plain object, so `return self.throwError(err)` answered the client
 * without the upstream's sentence, under a ref that no longer matched the
 * upstream's log line. The two- and three-argument forms already carried both.
 *
 *   01  boot arms over HTTP/1.1 on the default engine, XHR requests, JSON answers:
 *       - controls that carry `message` and honour a ref on both sides of the fix:
 *         a 1-arg Error with `status`, `(502, string)`, `(502, {…})`, `(res, 502, {…})`
 *       - the defect: a 1-arg `{status, error, message}`, a 1-arg
 *         `{status, message}`, a 1-arg object carrying `ref`, and a 1-arg
 *         `Error` carrying `ref` (its message was already kept)
 *       - a guard: an unsafe `ref` on a 1-arg object is still replaced
 *       - the relay: an action answers a `self.query()` error with `throwError(err)`
 *
 * Every request carries a client timeout. The bundle boots in the dev env and
 * the local scope, where `stack` stays on the wire; the scope rules for a copied
 * `message` are pinned in test/core/throwerror-plain-object-b518.test.js.
 *
 * Isolation: the container-boot-throwerror-fallback-b783.test.js shape — a
 * throwaway HOME under os.tmpdir(), its own port window (11350), project:rm +
 * rmSync at teardown. Seam: `B518_GINA_ROOT=<tree>` boots THAT tree's launcher
 * against a project scaffolded by THAT tree's CLI (red-first against a pre-fix
 * worktree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-throwerror-plain-object-b518.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var https  = require('https');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b518-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'po' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11350;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B518_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', proto = 'http/1.1', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

var XHR      = { 'x-requested-with': 'XMLHttpRequest' };
var SENTENCE = 'upstream refused';
var MINTED   = /^[0-9A-F]{6}$/;


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

/**
 * One XHR GET with a client timeout: an unanswered request resolves with
 * `{ status: null, err: 'timeout' }` instead of waiting forever.
 *
 * @inner
 * @param {string} reqPath - path including the webroot
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(reqPath) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: 'GET',
            headers: XHR, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        req.end();
    });
}

/**
 * Asserts the request was answered with a JSON error body and returns it.
 *
 * @inner
 * @param {object} r - result of request()
 * @param {number} status - the expected HTTP status
 * @param {string} label - arm label for the messages
 * @returns {object} the parsed JSON body
 */
function errorBody(r, status, label) {
    assert.notEqual(r.status, null, label + ': the request was never answered (' + r.err + ')');
    assert.equal(r.status, status, label + ': expected ' + status + ', got ' + r.status + ' ' + r.body.slice(0, 200));
    assert.ok(r.json && typeof r.json == 'object', label + ': the body is not JSON: ' + r.body.slice(0, 200));
    assert.equal(r.json.status, status, label + ': the body status is ' + r.json.status);
    return r.json;
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Adds the routes and the actions this file drives to the scaffold. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var names = ['k1', 'k2', 'k4', 'k5', 'p1', 'p2', 'p3', 'p3u', 'ke', 'up', 'relay'];
    names.forEach(function (n) {
        r['b518_' + n] = { namespace: 'content', url: '/' + n, method: 'GET', param: { control: 'b518' + n.charAt(0).toUpperCase() + n.slice(1) } };
    });
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));
    var upstream = '{ hostname: "127.0.0.1", port: ' + bundlePort + ', path: "' + webroot + 'up", method: "GET", protocol: "' + proto + '", scheme: "' + scheme + '" }';
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b518K1    = function(req, res) { var e = new Error("' + SENTENCE + '"); e.status = 502; return self.throwError(e); };',
        '    this.b518K2    = function(req, res) { return self.throwError(502, "' + SENTENCE + '"); };',
        '    this.b518K4    = function(req, res) { return self.throwError(502, { status: 502, error: "Bad Gateway", message: "' + SENTENCE + '", ref: "UP-4" }); };',
        '    this.b518K5    = function(req, res) { return self.throwError(res, 502, { message: "' + SENTENCE + '", ref: "UP-5" }); };',
        '    this.b518P1    = function(req, res) { return self.throwError({ status: 502, error: "Bad Gateway", message: "' + SENTENCE + '" }); };',
        '    this.b518P2    = function(req, res) { return self.throwError({ status: 502, message: "' + SENTENCE + '" }); };',
        '    this.b518P3    = function(req, res) { return self.throwError({ status: 502, error: "Bad Gateway", message: "' + SENTENCE + '", ref: "UP-1" }); };',
        '    this.b518P3u   = function(req, res) { return self.throwError({ status: 502, error: "Bad Gateway", message: "' + SENTENCE + '", ref: "x ][ ref FORGED" }); };',
        '    this.b518Ke    = function(req, res) { var e = new Error("' + SENTENCE + '"); e.status = 502; e.ref = "ORDER-42"; return self.throwError(e); };',
        '    this.b518Up    = function(req, res) { return self.throwError(res, 502, { message: "' + SENTENCE + '", ref: "UPSTREAM-1" }); };',
        '    this.b518Relay = function(req, res) { self.query(' + upstream + ', function (err, data) { if (err) { return self.throwError(err); } self.renderJSON({ unexpected: data }); }); };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}


// ---------------------------------------------------------------------------
// 01 — boot arms
// ---------------------------------------------------------------------------

describe('01 - container-boot-throwerror-plain-object — a one-argument plain object keeps its message and its ref (#B518)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
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

        var pe = readJSON(projectsPath)[PROJ], env = pe.def_env || 'dev';
        proto  = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = readJSON(portsReversePath)[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }

        try { installRoutes(); } catch (e) { setupError = 'route install failed: ' + (e.message || e); return; }

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
    });

    after(async function () {
        if (isChildAlive()) {
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 4000;
            while (Date.now() < until && isChildAlive()) { await sleep(150); }
            if (isChildAlive()) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
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

    // ── controls: carried on both sides of the fix ──────────────────────────

    it('01.1  CONTROL — a 1-arg Error with `status` carries its message', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'k1'), 502, 'Error + status');
        assert.equal(json.message, SENTENCE);
        assert.match(json.ref, MINTED);
    });

    it('01.2  CONTROL — `(502, string)` carries the status text in `error` and the string in `message`', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'k2'), 502, '(502, string)');
        assert.equal(json.error, 'Bad Gateway');
        assert.equal(json.message, SENTENCE);
    });

    it('01.3  CONTROL — `(502, {…})` carries the message and honours the ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'k4'), 502, '(502, {…})');
        assert.equal(json.message, SENTENCE);
        assert.equal(json.ref, 'UP-4');
    });

    it('01.4  CONTROL — `(res, 502, {…})` carries the message and honours the ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'k5'), 502, '(res, 502, {…})');
        assert.equal(json.message, SENTENCE);
        assert.equal(json.ref, 'UP-5');
    });

    // ── the defect: the one-argument plain object ───────────────────────────

    it('01.5  a 1-arg `{status, error, message}` carries its message; `error` is unchanged', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'p1'), 502, '{status, error, message}');
        assert.equal(json.error, 'Bad Gateway');
        assert.equal(json.message, SENTENCE, 'the object\'s message was dropped');
        assert.match(json.ref, MINTED);
    });

    it('01.6  a 1-arg `{status, message}` carries its message; `error` still holds that text', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'p2'), 502, '{status, message}');
        assert.equal(json.error, SENTENCE, '`error` changed for an object without `error`');
        assert.equal(json.message, SENTENCE, 'the object\'s message was dropped');
    });

    it('01.7  a 1-arg object keeps its relay-safe ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'p3'), 502, '{…, ref}');
        assert.equal(json.ref, 'UP-1', 'the object\'s ref was replaced by a fresh one');
        assert.equal(json.message, SENTENCE);
    });

    it('01.8  GUARD — an unsafe ref on a 1-arg object is still replaced by a fresh one', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'p3u'), 502, '{…, unsafe ref}');
        assert.match(json.ref, MINTED, 'an unsafe ref reached the wire: ' + json.ref);
    });

    it('01.9  a 1-arg Error keeps its relay-safe ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'ke'), 502, 'Error + ref');
        assert.equal(json.message, SENTENCE);
        assert.equal(json.ref, 'ORDER-42', 'the Error\'s ref was replaced by a fresh one');
    });

    // ── the relay between bundles ───────────────────────────────────────────

    it('01.10 CONTROL — the upstream answers with its message and its ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'up'), 502, 'upstream');
        assert.equal(json.message, SENTENCE);
        assert.equal(json.ref, 'UPSTREAM-1');
    });

    it('01.11 a `self.query()` error relayed with `throwError(err)` keeps the upstream\'s message and ref', async function (t) {
        if (!ready(t)) return;
        var json = errorBody(await request(webroot + 'relay'), 502, 'relay');
        assert.equal(json.error, 'Bad Gateway');
        assert.equal(json.message, SENTENCE, 'the upstream\'s sentence was dropped by the relay');
        assert.equal(json.ref, 'UPSTREAM-1', 'the relay answered under a ref that does not match the upstream\'s log line');
    });

    it('01.12 the bundle is still up', async function (t) {
        if (!ready(t)) return;
        assert.ok(isChildAlive(), 'the bundle process exited: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1500));
    });
});
