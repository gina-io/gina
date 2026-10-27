/**
 * #B956 — a DELETE route whose `requirements` cover only some of its URL placeholders matches, in a
 * booted bundle.
 *
 * The router matches a DELETE route that declares `requirements` in a branch of its own, which skipped
 * a placeholder without a requirement instead of scoring it: such a route never reached the match
 * score and answered 404 on every request, while the same route on GET matched. The branch now accepts
 * any non-empty segment for that placeholder, as the GET path does, and sets `req.delete` and
 * `req.params` from it.
 *
 * The scene: one bundle, an echo action answering what reaches it (`req[method]` and `req.params`,
 * own data properties only), behind four rules of one url shape `/<prefix>/:grp/:id`:
 * DELETE with a regex requirement on `id` only (both placeholders bound), the same on GET, DELETE
 * with requirements on both placeholders, and DELETE with a requirement on `id` only and `grp` not
 * bound in `param`.
 *
 *   01  controls that hold on both sides of the fix: the GET twin matches; the fully covered DELETE
 *       matches; a value a requirement rejects answers 404
 *   02  #B956: the partly covered DELETE route answers, with req.params and req.delete set from the
 *       URL, with or without a query string
 *   03  the unbound placeholder stays out of req.params and still reaches req.delete
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-delete-params-b955.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (13960), project:rm + rmSync at teardown. Seam:
 * `B956_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-delete-partial-b956.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b956-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'dq' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 13960;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;

var GINA_ROOT = process.env.B956_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var drives = {};


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
 * @param {string} method - the HTTP method
 * @param {string} reqPath - path including the webroot
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(method, reqPath) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, rejectUnauthorized: false
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

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Adds the rules and the echo action this file drives to the scaffold. */
function installScene() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var ID_ONLY = { id: '/^[0-9]+$/' };
    var BOTH    = { grp: '/^[a-z0-9]+$/', id: '/^[0-9]+$/' };
    r.b956_del_mixed   = { namespace: 'content', url: '/del-mixed/:grp/:id',   method: 'DELETE', requirements: ID_ONLY, param: { control: 'b956Echo', grp: ':grp', id: ':id' } };
    r.b956_get_mixed   = { namespace: 'content', url: '/get-mixed/:grp/:id',   method: 'GET',    requirements: ID_ONLY, param: { control: 'b956Echo', grp: ':grp', id: ':id' } };
    r.b956_del_both    = { namespace: 'content', url: '/del-both/:grp/:id',    method: 'DELETE', requirements: BOTH,    param: { control: 'b956Echo', grp: ':grp', id: ':id' } };
    r.b956_del_unbound = { namespace: 'content', url: '/del-unbound/:grp/:id', method: 'DELETE', requirements: ID_ONLY, param: { control: 'b956Echo', id: ':id' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b956Echo = function(req, res) {',
        '        var m = String(req.method || "get").toLowerCase();',
        '        var p = {}; if (req.params) { Object.keys(req.params).forEach(function (k) { if (k !== "0") { p[k] = req.params[k]; } }); }',
        '        var b = null; if (req[m]) { b = {}; Object.keys(req[m]).forEach(function (k) { if (typeof(req[m][k]) != "function") { b[k] = req[m][k]; } }); }',
        '        self.renderJSON({ method: req.method, bag: b, params: p });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/**
 * Requests `method reqPath` once (memoised per method + path) and returns the answer.
 *
 * @inner
 * @param {string} method
 * @param {string} reqPath - path under the webroot, without the leading webroot
 * @returns {Promise<{status: (number|null), err: (string|null), body: string, json: (object|null)}>}
 */
async function drive(method, reqPath) {
    var key = method + ' ' + reqPath;
    if (drives[key]) { return drives[key]; }
    var r = await request(method, webroot + reqPath);
    drives[key] = { status: r.status, err: r.err || null, body: r.body, json: r.json };
    return drives[key];
}

/** The echo answer of a drive, asserted to be a 200 JSON answer from the action. */
function echoOf(d, label) {
    assert.equal(d.status, 200, label + ': expected 200 from the echo action (got ' + d.status + ': ' + String(d.err || d.body || '').slice(0, 300) + ')');
    assert.ok(d.json && typeof(d.json.params) == 'object', label + ': expected the echo JSON — got ' + String(d.body).slice(0, 300));
    return d.json;
}


// ---------------------------------------------------------------------------
// 01 – 03 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-delete-partial — a DELETE route whose requirements cover only some placeholders (#B956)', function () {

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

        var pe = readJSON(projectsPath)[PROJ], env = pe.def_env || 'dev', proto = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = readJSON(portsReversePath)[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }

        try { installScene(); } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

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

    // ── 01 controls: hold on both sides of the fix ──────────────────────────

    it('01.1  CONTROL — the same shape on GET answers, with both placeholders in req.params', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('GET', 'get-mixed/g1/42'), 'get-mixed');
        assert.deepEqual(e.params, { grp: 'g1', id: '42' });
    });

    it('01.2  CONTROL — a DELETE route whose requirements cover both placeholders answers (unchanged)', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('DELETE', 'del-both/g1/42'), 'del-both');
        assert.deepEqual(e.bag, { grp: 'g1', id: '42' });
    });

    it('01.3  CONTROL — a value a requirement rejects answers 404 and never reaches the action', async function (t) {
        if (!ready(t)) return;
        var d = await drive('DELETE', 'del-mixed/g1/notanumber');
        assert.equal(d.status, 404, 'expected 404 (got ' + d.status + ')');
        assert.equal(!!(d.json && d.json.params), false, 'the echo action must not have answered');
    });

    // ── 02 #B956 ─────────────────────────────────────────────────────────────

    it('02.1  #B956 — the partly covered DELETE route answers, with req.params and req.delete from the URL', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('DELETE', 'del-mixed/g1/42'), 'del-mixed');
        assert.equal(e.method, 'DELETE');
        assert.deepEqual(e.params, { grp: 'g1', id: '42' });
        assert.deepEqual(e.bag, { grp: 'g1', id: '42' });
    });

    it('02.2  #B956 — the same with a query string: req.params keeps the URL values', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('DELETE', 'del-mixed/g1/42?x=1'), 'del-mixed?x=1');
        assert.deepEqual(e.params, { grp: 'g1', id: '42' });
        assert.equal(e.bag.x, '1', 'the query key reaches req.delete');
    });

    // ── 03 the unbound placeholder ───────────────────────────────────────────

    it('03.1  #B956 — a placeholder the route does not bind in param stays out of req.params, the bound one is set', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('DELETE', 'del-unbound/g1/42'), 'del-unbound');
        assert.deepEqual(e.params, { id: '42' });
    });

    it('03.2  #B956 — req.delete carries both values on that route', async function (t) {
        if (!ready(t)) return;
        var e = echoOf(await drive('DELETE', 'del-unbound/g1/42'), 'del-unbound');
        assert.deepEqual(e.bag, { grp: 'g1', id: '42' });
    });
});
