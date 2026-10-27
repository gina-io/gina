/**
 * #B672 — an error object an action passes to `self.throwError()` on several requests gives each
 * request its own error answer, and is never written, in a booted bundle. (Found again as #B991
 * in the #B988 review; #B991 is an alias of #B672.)
 *
 * Before 0.7.6 the one-argument form `self.throwError({ error, fields | errors | flash })` made
 * the action's object the TARGET of `lib/merge` (controller.js, the ApiError merge), so every
 * later write landed in it: the incident ref, the callsite stack (HTML), and the custom error
 * page's data (`isRenderingCustomError`, `bundle`, `pathname`, `status`, `title`). A module-level
 * object passed again then answered with the first request's ref, and on the HTML path the stack
 * written by request 1 sent request 2 down another branch, which dropped `fields`. The
 * three-argument form never merged into the object, but the inline fallback page of the local
 * scope rewrote the object's own `stack` on every call.
 *
 * The scene: one bundle with views and a custom `errors/500.html` that prints the status, the
 * ref, the pathname and a `fields` marker; one module-level object per shape on `global` (so a
 * dev re-require of the controller cannot replace it), and the same shape built fresh per
 * request as the control. The requests run in `before()`, in order: request 1 then request 2
 * for each rule, then `peek`, which answers what the shared objects hold.
 *
 *   01  controls: a fresh object, HTML and XHR, gets its own ref and its `fields` on each request
 *   02  the same object, one-argument form, HTML: request 2 gets its own ref and its `fields`
 *   03  the same object, one-argument form, XHR: request 2 gets its own ref
 *   04  the three-argument form (custom page and inline fallback page) and `peek`: every shared
 *       object holds what the action gave it, nothing more, and its `stack` unchanged
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-render-reuse-b988.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14250), project:rm + rmSync at teardown. Seam:
 * `B672_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-throwerror-reuse-b672.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b672-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'te' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14250;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B672_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

/** The shape every API-error object of the scene has. */
var API_ERROR = '{ error: "Bad input", fields: { name: "required" } }';
/** The stack-bearing object of the fallback arm. */
var STACK_ERROR = '{ error: "E1", message: "M1", stack: "Error: M1\\n    at frame (file.js:1:1)" }';

// [rule, url, action, its body]
var RULES = [
    ['b672freshhtml', '/b672-freshhtml/:id', 'b672FreshHtml', 'return self.throwError(' + API_ERROR + ');'],
    ['b672apihtml',   '/b672-apihtml/:id',   'b672ApiHtml',   'if (!global.__b672A) { global.__b672A = ' + API_ERROR + '; } return self.throwError(global.__b672A);'],
    ['b672freshxhr',  '/b672-freshxhr/:id',  'b672FreshXhr',  'return self.throwError(' + API_ERROR + ');'],
    ['b672apixhr',    '/b672-apixhr/:id',    'b672ApiXhr',    'if (!global.__b672X) { global.__b672X = ' + API_ERROR + '; } return self.throwError(global.__b672X);'],
    ['b672three',     '/b672-three/:id',     'b672Three',     'if (!global.__b672T) { global.__b672T = ' + API_ERROR + '; } return self.throwError(res, 500, global.__b672T);'],
    ['b672stack',     '/b672-stack/:id',     'b672Stack',     'if (!global.__b672S) { global.__b672S = ' + STACK_ERROR + '; } return self.throwError(res, 503, global.__b672S);']
];

// [label, path under the webroot, sent as an XHR] — sent in this order, once each
var ARMS = [
    ['freshhtml.1', 'b672-freshhtml/1?q=one', false],
    ['freshhtml.2', 'b672-freshhtml/2?q=two', false],
    ['apihtml.1',   'b672-apihtml/1?q=one',   false],
    ['apihtml.2',   'b672-apihtml/2?q=two',   false],
    ['freshxhr.1',  'b672-freshxhr/1',        true],
    ['freshxhr.2',  'b672-freshxhr/2',        true],
    ['apixhr.1',    'b672-apixhr/1',          true],
    ['apixhr.2',    'b672-apixhr/2',          true],
    ['three.1',     'b672-three/1?q=one',     false],
    ['three.2',     'b672-three/2?q=two',     false],
    ['stack.1',     'b672-stack/1',           false],
    ['stack.2',     'b672-stack/2',           false],
    ['peek',        'b672-peek',              false]
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
 * @param {boolean} xhr - send `X-Requested-With: XMLHttpRequest`
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
 * Turns views on for the bundle (`"template": true` after the webroot of settings.server.json,
 * count-guarded), adds the rules and the actions this file drives, and the custom 500 page.
 *
 * @inner
 * @returns {void}
 */
function installScene() {
    var bundleDir = path.join(PROJ_DIR, 'src', BUNDLE);

    var ss = path.join(bundleDir, 'config', 'settings.server.json');
    var sst = fs.readFileSync(ss, 'utf8');
    var wm = sst.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (wm.length !== 1) { throw new Error('settings.server.json webroot anchor count ' + wm.length); }
    fs.writeFileSync(ss, sst.replace(wm[0], wm[0] + ',\n    "template": true'));

    var rf = path.join(bundleDir, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    RULES.forEach(function (rule) {
        // a `:placeholder` of the url is declared in `param`, bound to itself
        r[rule[0]] = { namespace: 'content', url: rule[1], method: 'GET', param: { control: rule[2], id: ':id' } };
    });
    r.b672peek = { namespace: 'content', url: '/b672-peek', method: 'GET', param: { control: 'b672Peek' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = RULES.map(function (rule) {
        return '    this.' + rule[2] + ' = function(req, res) { ' + rule[3] + ' };';
    }).concat([
        '    this.b672Peek = function(req, res) {',
        '        var keys = function (o) { return (o && typeof(o) == "object") ? Object.keys(o).sort() : null; };',
        '        self.renderJSON({',
        '            apiHtml: keys(global.__b672A), apiXhr: keys(global.__b672X),',
        '            three: keys(global.__b672T), stack: keys(global.__b672S),',
        '            stackValue: (global.__b672S) ? global.__b672S.stack : null',
        '        });',
        '    };',
        ''
    ]).join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + '\n' + anchor));

    var errorsDir = path.join(bundleDir, 'templates', 'html', 'errors');
    fs.mkdirSync(errorsDir, { recursive: true });
    fs.writeFileSync(path.join(errorsDir, '500.html'),
        '<!doctype html><html><body><p id="b672">STATUS=[{{ page.data.status }}] REF=[{{ page.data.ref }}] '
        + 'PATH=[{{ page.data.pathname }}] FIELDS=[{{ page.data.fields.name }}]</p></body></html>\n');
}

/**
 * The values a custom error page printed, asserted to come from a 500 HTML answer of the page.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {object} `{ status, ref, path, fields }`
 */
function pageOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 500, label + ': expected 500 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 400) + ')');
    var m = /STATUS=\[([^\]]*)\] REF=\[([^\]]*)\] PATH=\[([^\]]*)\] FIELDS=\[([^\]]*)\]/.exec(a.body);
    assert.ok(m, label + ': the custom page answered (body: ' + String(a.body).slice(0, 300) + ')');
    return { status: m[1], ref: m[2], path: m[3], fields: m[4] };
}

/**
 * The JSON error body an XHR arm received, asserted to be a 500 JSON answer.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {object} the parsed body
 */
function jsonOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 500, label + ': expected 500 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 400) + ')');
    assert.ok(a.json && typeof(a.json) == 'object', label + ': a JSON body (got ' + String(a.body).slice(0, 300) + ')');
    return a.json;
}

/**
 * The pathname of the request an arm sent: the engines take the query string off `req.url`
 * before any controller runs (server.isaac.js, server.js), so the error page's `pathname`
 * never carries it.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {string} the webroot-prefixed path, without its query string
 */
function pathOf(label) {
    for (var i = 0; i < ARMS.length; i++) { if (ARMS[i][0] === label) { return webroot + ARMS[i][1].split('?')[0]; } }
    throw new Error('no arm ' + label);
}


// ---------------------------------------------------------------------------
// 01 – 04 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-throwerror-reuse — an error object passed to throwError on several requests gives each its own answer (#B672)', function () {

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
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (va.status !== 0) { setupError = 'view:add failed: ' + (va.stderr || va.stdout).slice(-600); return; }

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

        // every arm, in order: request 1 then request 2 of each rule, then peek
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

    // ── 01 controls: a fresh object per request ─────────────────────────────

    it('01.1  CONTROL — a fresh object, HTML: each request gets its own ref, its own pathname and its fields', async function (t) {
        if (!ready(t)) return;
        var p1 = pageOf('freshhtml.1'), p2 = pageOf('freshhtml.2');
        assert.ok(p1.ref && p2.ref, 'both pages carry a ref');
        assert.notEqual(p2.ref, p1.ref, 'two refs');
        assert.equal(p1.path, pathOf('freshhtml.1'));
        assert.equal(p2.path, pathOf('freshhtml.2'));
        assert.equal(p1.fields, 'required');
        assert.equal(p2.fields, 'required');
    });

    it('01.2  CONTROL — a fresh object, XHR: each request gets its own ref', async function (t) {
        if (!ready(t)) return;
        var j1 = jsonOf('freshxhr.1'), j2 = jsonOf('freshxhr.2');
        assert.ok(j1.ref && j2.ref, 'both answers carry a ref');
        assert.notEqual(j2.ref, j1.ref, 'two refs');
    });

    // ── 02 – 03 the same object, one-argument form ──────────────────────────

    it('02.1  the same object, one-argument form, HTML: request 2 gets its own ref (0.7.5: request 1\'s)', async function (t) {
        if (!ready(t)) return;
        var p1 = pageOf('apihtml.1'), p2 = pageOf('apihtml.2');
        assert.equal(p2.path, pathOf('apihtml.2'), 'request 2\'s own pathname');
        assert.ok(p1.ref && p2.ref, 'both pages carry a ref');
        assert.notEqual(p2.ref, p1.ref, 'request 2\'s own ref');
    });

    it('02.2  the same object, one-argument form, HTML: request 2 still shows its fields (0.7.5: dropped)', async function (t) {
        if (!ready(t)) return;
        assert.equal(pageOf('apihtml.1').fields, 'required');
        assert.equal(pageOf('apihtml.2').fields, 'required', 'request 2\'s fields');
    });

    it('03.1  the same object, one-argument form, XHR: request 2 gets its own ref (0.7.5: request 1\'s)', async function (t) {
        if (!ready(t)) return;
        var j1 = jsonOf('apixhr.1'), j2 = jsonOf('apixhr.2');
        assert.ok(j1.ref && j2.ref, 'both answers carry a ref');
        assert.notEqual(j2.ref, j1.ref, 'request 2\'s own ref');
    });

    // ── 04 the three-argument form, and peek ────────────────────────────────

    it('04.1  CONTROL — the same object, three-argument form, custom page: each request gets its own ref and pathname', async function (t) {
        if (!ready(t)) return;
        var p1 = pageOf('three.1'), p2 = pageOf('three.2');
        assert.notEqual(p2.ref, p1.ref, 'two refs');
        assert.equal(p2.path, pathOf('three.2'));
    });

    it('04.2  the inline fallback page (no file for 503) answers both requests', async function (t) {
        if (!ready(t)) return;
        ['stack.1', 'stack.2'].forEach(function (label) {
            var a = answers[label];
            assert.ok(a, label + ': the arm was not sent');
            assert.equal(a.status, 503, label + ': expected 503 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 300) + ')');
        });
    });

    it('04.3  peek: every shared object holds the keys the action gave it, nothing more, and its stack unchanged', async function (t) {
        if (!ready(t)) return;
        var a = answers.peek;
        assert.equal(a.status, 200, 'peek: ' + String(a.err || a.body).slice(0, 300));
        assert.ok(a.json, 'peek answers JSON');
        assert.deepEqual(a.json.three, ['error', 'fields'], 'CONTROL: the three-argument object, which no path merges into');
        // one comparison, so a failing run shows every shared object's state at once
        assert.deepEqual({
            apiHtml    : a.json.apiHtml,
            apiXhr     : a.json.apiXhr,
            stack      : a.json.stack,
            stackValue : a.json.stackValue
        }, {
            apiHtml    : ['error', 'fields'],
            apiXhr     : ['error', 'fields'],
            stack      : ['error', 'message', 'stack'],
            stackValue : 'Error: M1\n    at frame (file.js:1:1)'
        }, 'the shared objects (0.7.5: the one-argument objects gained gina\'s keys, and the fallback page rewrote the stack)');
    });
});
