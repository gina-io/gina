/**
 * #B992 — an object an action passes to `self.renderJSON()` on several requests is never written
 * by the Inspector sidecars, in a booted bundle with the Inspector open.
 *
 * In development, opening the Inspector (`GET <webroot>/_gina/inspector`) switches profiling on
 * until the bundle restarts: from then on each request records a timeline, and renderJSON() adds
 * it to the response as `__ginaFlow` (and the request's query log as `__ginaQueries` when it ran a
 * query). Up to 0.7.5 both were assigned on the object the action passed, so an object passed on
 * more than one request (a module-level object, a memoized response) kept them, and every later
 * response built from it sent them. Since 0.7.6 they are written into a copy of the object
 * (`renderData.copyOwn()`, core/controller/render-data.js), made at the first write.
 *
 * The scene: one bundle; one module-level object on `global` (so a dev re-require of the
 * controller cannot replace it), the same shape built fresh per request as the control, and
 * `peek`, which answers the keys the shared object holds. The requests run in `before()`, in this
 * order: shared.0 and peek.0 before the Inspector is opened, then the Inspector page, then
 * shared.1, shared.2, fresh.1 and peek.1.
 *
 *   01  controls: before the Inspector is opened the answer carries no `__ginaFlow` and the shared
 *       object holds its own keys; the Inspector page answers 200
 *   02  with the Inspector open, every answer carries a `__ginaFlow` timeline and the action's
 *       data (the shared object on two requests, a fresh object as the control)
 *   03  peek: the shared object still holds only the keys the action gave it (0.7.5: it gained
 *       `__ginaFlow`)
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-throwerror-reuse-b672.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14300), project:rm + rmSync at teardown; the Inspector switch
 * only reaches that throwaway bundle. Seam: `B992_GINA_ROOT=<tree>` boots THAT tree's launcher
 * against a project scaffolded by THAT tree's CLI (red-first against a pre-fix tree, zero
 * shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-renderjson-sidecar-b992.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b992-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rj' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14300;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B992_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

/** The shape every object of the scene has. */
var SHAPE = '{ name: "b992", nested: { n: 1 } }';

// [rule, url, action, its body]
var RULES = [
    ['b992shared', '/b992-shared/:id', 'b992Shared', 'if (!global.__b992S) { global.__b992S = ' + SHAPE + '; } self.renderJSON(global.__b992S);'],
    ['b992fresh',  '/b992-fresh/:id',  'b992Fresh',  'self.renderJSON(' + SHAPE + ');']
];

// [label, path under the webroot, sent as an XHR] — sent in this order, once each
var ARMS = [
    ['shared.0',  'b992-shared/0',  true],
    ['peek.0',    'b992-peek',      true],
    ['inspector', '_gina/inspector', false],
    ['shared.1',  'b992-shared/1',  true],
    ['shared.2',  'b992-shared/2',  true],
    ['fresh.1',   'b992-fresh/1',   true],
    ['peek.1',    'b992-peek',      true]
];


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
 * One GET with a client timeout: an unanswered request resolves with
 * `{ status: null, err: 'timeout' }` instead of waiting forever.
 *
 * @inner
 * @param {string} reqPath - path including the webroot
 * @param {boolean} xhr - send `X-Requested-With: XMLHttpRequest` and accept JSON
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(reqPath, xhr) {
    var lib = (scheme === 'https') ? https : http;
    var headers = xhr ? { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json' } : { 'Accept': 'text/html' };
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: 'GET', headers: headers, rejectUnauthorized: false
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

/**
 * Adds the rules and the actions this file drives: the shared object's route, the fresh
 * object's route and `peek`.
 *
 * @inner
 * @returns {void}
 */
function installScene() {
    var bundleDir = path.join(PROJ_DIR, 'src', BUNDLE);

    var rf = path.join(bundleDir, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    RULES.forEach(function (rule) {
        // a `:placeholder` of the url is declared in `param`, bound to itself
        r[rule[0]] = { namespace: 'content', url: rule[1], method: 'GET', param: { control: rule[2], id: ':id' } };
    });
    r.b992peek = { namespace: 'content', url: '/b992-peek', method: 'GET', param: { control: 'b992Peek' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = RULES.map(function (rule) {
        return '    this.' + rule[2] + ' = function(req, res) { ' + rule[3] + ' };';
    }).concat([
        '    this.b992Peek = function(req, res) {',
        '        var keys = function (o) { return (o && typeof(o) == "object") ? Object.keys(o).sort() : null; };',
        '        self.renderJSON({ shared: keys(global.__b992S), nested: keys(global.__b992S && global.__b992S.nested) });',
        '    };',
        ''
    ]).join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + '\n' + anchor));
}

/**
 * The JSON body an arm received, asserted to be a 200 JSON answer.
 *
 * @inner
 * @param {string} label - an ARMS label
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
 * Asserts that an answer carries the request's timeline as `__ginaFlow`: a non-empty array
 * holding the `total` entry renderJSON() records for the response.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @param {object} j - the parsed body of that arm
 * @returns {void}
 */
function assertFlow(label, j) {
    assert.ok(Array.isArray(j.__ginaFlow), label + ': __ginaFlow is an array (got ' + JSON.stringify(j.__ginaFlow) + ')');
    assert.ok(j.__ginaFlow.length > 0, label + ': __ginaFlow has entries');
    assert.ok(j.__ginaFlow.some(function (e) { return e && e.label === 'total'; }), label + ': __ginaFlow holds the response\'s total entry');
}


// ---------------------------------------------------------------------------
// 01 – 03 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-renderjson-sidecar — an object passed to renderJSON on several requests is never written by the Inspector sidecars (#B992)', function () {

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

        // every arm, in order: before the Inspector, the Inspector page, then with it open
        for (var i = 0; i < ARMS.length; i++) {
            answers[ARMS[i][0]] = await request(webroot + ARMS[i][1], ARMS[i][2]);
        }
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

    // ── 01 controls: before the Inspector is opened, and the Inspector page ──

    it('01.1  CONTROL — before the Inspector is opened, the answer carries no __ginaFlow and the shared object holds its own keys', async function (t) {
        if (!ready(t)) return;
        var j = jsonOf('shared.0');
        assert.equal(j.name, 'b992');
        assert.equal(Object.prototype.hasOwnProperty.call(j, '__ginaFlow'), false, 'no timeline before the Inspector is opened');
        assert.deepEqual(jsonOf('peek.0').shared, ['name', 'nested']);
    });

    it('01.2  CONTROL — the Inspector page answers 200 (it switched profiling on for this bundle)', async function (t) {
        if (!ready(t)) return;
        var a = answers.inspector;
        assert.ok(a, 'inspector: the arm was not sent');
        assert.equal(a.status, 200, 'inspector: expected 200 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 300) + ')');
    });

    // ── 02 the Inspector open ────────────────────────────────────────────────

    it('02.1  with the Inspector open, both answers built from the shared object carry a __ginaFlow timeline and the action\'s data', async function (t) {
        if (!ready(t)) return;
        ['shared.1', 'shared.2'].forEach(function (label) {
            var j = jsonOf(label);
            assert.equal(j.name, 'b992', label);
            assert.deepEqual(j.nested, { n: 1 }, label);
            assertFlow(label, j);
        });
    });

    it('02.2  CONTROL — with the Inspector open, a fresh object\'s answer carries a __ginaFlow timeline too', async function (t) {
        if (!ready(t)) return;
        var j = jsonOf('fresh.1');
        assert.equal(j.name, 'b992');
        assertFlow('fresh.1', j);
    });

    // ── 03 peek ──────────────────────────────────────────────────────────────

    it('03.1  peek: the shared object still holds only the keys the action gave it (0.7.5: it gained __ginaFlow)', async function (t) {
        if (!ready(t)) return;
        var j = jsonOf('peek.1');
        // one comparison, so a failing run shows the whole state at once
        assert.deepEqual({ shared: j.shared, nested: j.nested }, { shared: ['name', 'nested'], nested: ['n'] },
            'the shared object (0.7.5: renderJSON() wrote __ginaFlow into it)');
    });
});
