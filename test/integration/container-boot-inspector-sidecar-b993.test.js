/**
 * #B993 — during a production instrumentation window, a request carrying `x-gina-inspector: true`
 * gets no Inspector sidecar, in a booted bundle.
 *
 * `self.query()` sets that header on a cross-bundle call during a window, and up to 0.7.6
 * renderJSON() then added the request's timeline (`__ginaFlow`) and query log (`__ginaQueries`) to
 * the JSON body. Any client can send the header, so while a window was open an unauthenticated
 * request received its own raw query log and timeline. Since 0.7.7 the sidecars are attached in
 * dev only; the window's capture leaves over the authenticated `/_gina/agent` channel.
 *
 * The scene: one bundle whose `settings.json` enables `inspector.instrumentation` under a literal
 * key, one JSON route; a prod release (`bundle:build --env=prod --scope=local`) booted with
 * `NODE_ENV=prod NODE_SCOPE=local`. The requests run in `before()`, in this order: the window
 * status, the route with the header (window closed), a wrong key, the window opened, the route
 * without the header, the route with the header, the window closed, the route with the header.
 * The timeline is the observable: it shares `__ginaQueries`' gate, and needs no datastore.
 *
 *   01  controls: the endpoint answers its status, refuses a wrong key, opens and closes the
 *       window; with the window closed the header gets no sidecar
 *   02  with the window open: the header gets no `__ginaFlow` [red before the fix]; no header,
 *       no sidecar either
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-renderjson-sidecar-b992.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14400), project:rm + rmSync at teardown. Seam:
 * `B993_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI; against a pre-fix tree arm 02.1 fails with the timeline in the body, which is the proof
 * the arm can see a sidecar.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-inspector-sidecar-b993.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b993-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ins' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14400;
var KEY        = 'b993-instrument-key-' + STAMP;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B993_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

var WITH_HEADER = { 'x-gina-inspector': 'true' };


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
 * One request with a client timeout: an unanswered request resolves with
 * `{ status: null, err: 'timeout' }` instead of waiting forever.
 *
 * @inner
 * @param {string} method - `GET` or `POST`
 * @param {string} reqPath - path including the webroot
 * @param {object} [headers] - request headers
 * @param {string} [body] - a request body (sent as JSON)
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(method, reqPath, headers, body) {
    var lib = (scheme === 'https') ? https : http;
    var h = Object.assign({ 'Accept': 'application/json' }, headers || {});
    if (body) { h['content-type'] = 'application/json'; h['content-length'] = Buffer.byteLength(body); }
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, headers: h, rejectUnauthorized: false
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
        if (body) { req.write(body); }
        req.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/**
 * Parses a scaffolded config file: drops `//` and `/* *\/` comments outside JSON strings.
 *
 * @inner
 * @param {string} file
 * @returns {object}
 */
function readJSONC(file) {
    var s = fs.readFileSync(file, 'utf8'), o = '', i = 0, inStr = false;
    while (i < s.length) {
        var c = s[i], n = s[i + 1];
        if (inStr) {
            o += c;
            if (c === '\\') { o += n; i += 2; continue; }
            if (c === '"') { inStr = false; }
            i++; continue;
        }
        if (c === '"') { inStr = true; o += c; i++; continue; }
        if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') { i++; } continue; }
        if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) { i++; } i += 2; continue; }
        o += c; i++;
    }
    return JSON.parse(o);
}

/**
 * Enables the instrumentation window in the bundle's settings.json, adds the JSON route and its
 * action.
 *
 * @inner
 * @returns {void}
 */
function installScene() {
    var bundleDir = path.join(PROJ_DIR, 'src', BUNDLE);

    var sf = path.join(bundleDir, 'config', 'settings.json');
    var s  = readJSONC(sf);
    s.inspector = s.inspector || {};
    s.inspector.instrumentation = { enabled: true, key: KEY, defaultWindowSeconds: 120, maxWindowSeconds: 600 };
    fs.writeFileSync(sf, JSON.stringify(s, null, 2));

    var rf = path.join(bundleDir, 'config', 'routing.json');
    var r  = readJSONC(rf);
    r.b993 = { namespace: 'content', url: '/b993', method: 'GET', param: { control: 'b993' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var c  = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (c.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (c.split(anchor).length - 1)); }
    fs.writeFileSync(cf, c.replace(anchor, function () {
        return '    this.b993 = function(req, res) { self.renderJSON({ name: "b993" }); };\n' + anchor;
    }));
}

/**
 * The JSON body an arm received, asserted to be a 200 JSON answer.
 *
 * @inner
 * @param {string} label - an arm label
 * @returns {object} the parsed body
 */
function jsonOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 200, label + ': expected 200 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 400) + ')');
    assert.ok(a.json && typeof(a.json) == 'object', label + ': a JSON body (got ' + String(a.body).slice(0, 300) + ')');
    return a.json;
}

/**
 * Asserts that an answer carries neither sidecar.
 *
 * @inner
 * @param {string} label - an arm label
 * @returns {void}
 */
function assertNoSidecar(label) {
    var j = jsonOf(label);
    assert.equal(j.name, 'b993', label + ': the action\'s data');
    assert.equal(Object.prototype.hasOwnProperty.call(j, '__ginaFlow'), false,
        label + ': #B993 — the timeline reached the client: ' + JSON.stringify(j.__ginaFlow || '').slice(0, 300));
    assert.equal(Object.prototype.hasOwnProperty.call(j, '__ginaQueries'), false, label + ': #B993 — the query log reached the client');
}


// ---------------------------------------------------------------------------
// 01 – 02 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-inspector-sidecar — a header-carrying request gets no Inspector sidecar in a production instrumentation window (#B993)', function () {

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

        var pe = readJSON(projectsPath)[PROJ], proto = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = readJSON(portsReversePath)[key].prod[proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the prod port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }

        try { installScene(); } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

        // the prod release the launcher boots outside the dev env
        var b = runCli(['bundle:build', BUNDLE, '@' + PROJ, '--env=prod', '--scope=local']);
        var relRoot = path.join(PROJ_DIR, 'releases', BUNDLE, 'local', 'prod');
        var rel = fs.existsSync(relRoot) ? fs.readdirSync(relRoot) : [];
        if (rel.length === 0) { setupError = 'bundle:build produced no prod release under ' + relRoot + '\n' + (b.stdout + b.stderr).slice(-1500); return; }

        // ONE boot for every arm
        var bootEnv = Object.assign({}, CHILD_ENV, { NODE_ENV: 'prod', NODE_SCOPE: 'local' });
        child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: bootEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

        var instrument = webroot + '_gina/instrument', route = webroot + 'b993', auth = { 'x-gina-inspector-key': KEY };
        answers.status  = await request('GET',  instrument, auth);
        answers.closed  = await request('GET',  route, WITH_HEADER);
        answers.badKey  = await request('POST', instrument, { 'x-gina-inspector-key': 'wrong' }, JSON.stringify({ enable: true, ttlSeconds: 120 }));
        answers.open    = await request('POST', instrument, auth, JSON.stringify({ enable: true, ttlSeconds: 120 }));
        answers.plain   = await request('GET',  route);
        answers.header  = await request('GET',  route, WITH_HEADER);
        answers.close   = await request('POST', instrument, auth, JSON.stringify({ enable: false }));
        answers.after   = await request('GET',  route, WITH_HEADER);
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

    // ── 01 controls ──

    it('01.1  CONTROL — the endpoint answers the window status (closed) to the key', async function (t) {
        if (!ready(t)) return;
        var j = jsonOf('status');
        assert.equal(j.active, false, 'the window starts closed');
    });

    it('01.2  CONTROL — a wrong key is refused (401), the right key opens the window, then closes it', async function (t) {
        if (!ready(t)) return;
        assert.equal(answers.badKey.status, 401, 'a wrong key must be refused (got ' + answers.badKey.status + ')');
        assert.equal(jsonOf('open').active, true, 'the window opened');
        assert.equal(jsonOf('close').active, false, 'the window closed');
    });

    it('01.3  CONTROL — with the window closed, before and after, the header gets no sidecar', async function (t) {
        if (!ready(t)) return;
        assertNoSidecar('closed');
        assertNoSidecar('after');
    });

    // ── 02 the window open ──

    it('02.1  with the window open, a request carrying x-gina-inspector: true gets no sidecar', async function (t) {
        if (!ready(t)) return;
        assertNoSidecar('header');
    });

    it('02.2  CONTROL — with the window open, a request without the header gets no sidecar', async function (t) {
        if (!ready(t)) return;
        assertNoSidecar('plain');
    });
});
