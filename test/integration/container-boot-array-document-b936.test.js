/**
 * #B936 / #B594 — a top-level JSON array reaches the action as the array of its parsed elements, in a
 * booted bundle.
 *
 * test/lib/format-data-array-document-b936.test.js drives the real helper (`formatDataFromString`) and
 * pins the source and the built bundles. This file drives the two request paths that hand the helper a
 * `[`-leading document, through the REAL `bin/gina-container` against a scaffolded project carrying a
 * GET+POST `/echo` route that renders what the framework handed the action, over HTTP/1.1 on the default
 * engine (isaac):
 *
 *   01  the defect: a GET or HEAD whose only parameter is `inheritedData=[…]` (isaac keeps a lone value
 *       as a string, which reaches the helper), and a `[`-leading POST body not labelled
 *       `application/json` (no content type, `text/plain`, `application/x-www-form-urlencoded`). Before
 *       the fix the helper returned a circular value and each answered 500 (« Converting circular
 *       structure to JSON », raised in renderJSON); the process survived.
 *   02  controls that hold on both sides of the fix: `inheritedData=[1]` beside another parameter
 *       (isaac's multi-parameter branch JSON-parses the value, so the helper never sees it), an object
 *       `inheritedData`, an `application/json` array body (verbatim JSON.parse, #B28), a plain GET.
 *
 * Before 0.7.6 the boot's FIRST POST to a path, whatever its content type, reached the action with
 * `req.post` re-keyed by index (`{ "0": …, "1": … }`) while `req.body` kept the array, and every later
 * POST got the array itself (#B953: on a cold route the routing loop matched on an `Object.assign`
 * copy of the bag). The POST arms pin `req.body` and the element values of `req.post`, which hold on
 * both sides of that fix; container-boot-array-bag-b953.test.js pins the container.
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-request-parsing.test.js shape — a throwaway HOME under os.tmpdir(), its
 * own port window (13150), project:rm + rmSync at teardown. Seam: `B936_GINA_ROOT=<tree>` boots THAT
 * tree's launcher against a project scaffolded by THAT tree's CLI (red-first against a pre-fix tree,
 * zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-array-document-b936.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-ad-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ad' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 13150;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 10000;

var GINA_ROOT = process.env.B936_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

var ARRAY_BODY = '[{"a":"1"},2]';


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

function request(method, reqPath, body, headers) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method,
            headers: headers || {}, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('client timeout after ' + REQUEST_TIMEOUT_MS + ' ms')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        if (body != null) { req.write(body); }
        req.end();
    });
}

function get(rawQuery)  { return request('GET',  webroot + 'echo?' + rawQuery); }
function head(rawQuery) { return request('HEAD', webroot + 'echo?' + rawQuery); }
function post(body, contentType) {
    var h = { 'content-length': Buffer.byteLength(body) };
    if (contentType) { h['content-type'] = contentType; }
    return request('POST', webroot + 'echo', body, h);
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** What the answer says, for a failure message: the status and the head of the body. */
function said(r) { return 'status ' + r.status + (r.err ? ' (' + r.err + ')' : '') + ': ' + String(r.body || '').slice(0, 240); }

/** The liveness probe every arm ends with: the process is up AND a control GET answers. */
async function assertAlive(label) {
    await sleep(150);
    assert.ok(isChildAlive(), label + ': the bundle process must survive — exit: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1500));
    var ctl = await get('x=plain&y=1');
    assert.equal(ctl.status, 200, label + ': the control GET must still answer');
    assert.deepEqual(ctl.json.get, { x: 'plain', y: '1' });
}

/** Adds the echo route + action to the scaffold (the container-boot-request-parsing.test.js shape). */
function installEchoRoute() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.echo_get  = { namespace: 'content', url: '/echo', method: 'GET',  param: { control: 'echo' } };
    r.echo_post = { namespace: 'content', url: '/echo', method: 'POST', param: { control: 'echo' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = [
        '    this.echo = function(req, res) {',
        '        var show = function (v) { return (typeof v === "undefined") ? "__undefined__" : v; };',
        '        self.renderJSON({ method: req.method, get: show(req.get), post: show(req.post), body: show(req.body) });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('container-boot — #B936 / #B594 a top-level JSON array reaches the action as its parsed elements', function () {

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

        try { installEchoRoute(); } catch (e) { setupError = 'echo route install failed: ' + (e.message || e); return; }

        var pe = readJSON(projectsPath)[PROJ], env = pe.def_env || 'dev', proto = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = readJSON(portsReversePath)[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
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

    // ── 01 the defect ─────────────────────────────────────────────────────

    it('01.1  #B936 — GET ?inheritedData=[1] alone answers 200 and the action reads its element (was 500)', async function (t) {
        if (!ready(t)) return;
        var r = await get('inheritedData=%5B1%5D');
        assert.equal(r.status, 200, said(r));
        assert.deepEqual(r.json.get, { '0': 1 });
        await assertAlive('01.1');
    });

    it('01.2  #B936 — HEAD ?inheritedData=[1] alone answers 200 (was 500)', async function (t) {
        if (!ready(t)) return;
        var r = await head('inheritedData=%5B1%5D');
        assert.equal(r.status, 200, said(r));
        await assertAlive('01.2');
    });

    it('01.3  #B936 — GET ?inheritedData=[{"a":"1"},2] alone carries both elements (was 500)', async function (t) {
        if (!ready(t)) return;
        var r = await get('inheritedData=' + encodeURIComponent(ARRAY_BODY));
        assert.equal(r.status, 200, said(r));
        assert.deepEqual(r.json.get, { '0': { a: '1' }, '1': 2 });
        await assertAlive('01.3');
    });

    /** req.body is the parsed array; req.post carries the same elements (its container: see #B953). */
    function assertArrayBody(label, r) {
        assert.equal(r.status, 200, label + ': ' + said(r));
        assert.deepEqual(r.json.body, [ { a: '1' }, 2 ], label + ': req.body must be the parsed array');
        assert.deepEqual(r.json.post['0'], { a: '1' }, label + ': req.post element 0');
        assert.equal(r.json.post['1'], 2, label + ': req.post element 1');
    }

    it('01.4  #B594 — a [-leading POST body with no content type, or text/plain, is parsed into its elements (was 500)', async function (t) {
        if (!ready(t)) return;
        assertArrayBody('no content type', await post(ARRAY_BODY, null));
        assertArrayBody('text/plain', await post(ARRAY_BODY, 'text/plain'));
        await assertAlive('01.4');
    });

    it('01.5  #B594 — a [-leading POST body labelled urlencoded is parsed into its elements (was 500)', async function (t) {
        if (!ready(t)) return;
        assertArrayBody('urlencoded', await post(ARRAY_BODY, 'application/x-www-form-urlencoded'));
        await assertAlive('01.5');
    });

    // ── 02 controls: the same on both sides of the fix ────────────────────

    it('02.1  CONTROL — inheritedData=[1] beside another parameter answers 200 (isaac JSON-parses it first)', async function (t) {
        if (!ready(t)) return;
        var r = await get('x=1&inheritedData=%5B1%5D');
        assert.equal(r.status, 200, said(r));
        assert.deepEqual(r.json.get, { '0': 1, x: '1' });
    });

    it('02.2  CONTROL — an object inheritedData alone answers 200', async function (t) {
        if (!ready(t)) return;
        var r = await get('inheritedData=' + encodeURIComponent('{"a":"1"}'));
        assert.equal(r.status, 200, said(r));
        assert.deepEqual(r.json.get, { a: '1' });
    });

    it('02.3  CONTROL — an application/json array body is parsed verbatim (#B28)', async function (t) {
        if (!ready(t)) return;
        var r = await post(ARRAY_BODY, 'application/json');
        assert.equal(r.status, 200, said(r));
        assert.deepEqual(r.json.post['0'], { a: '1' });
        assert.equal(r.json.post['1'], 2);
        await assertAlive('02.3');
    });
});
