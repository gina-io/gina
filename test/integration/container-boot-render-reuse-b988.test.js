/**
 * #B988 — an object an action passes to several renders gives each request its own page, in a
 * booted bundle.
 *
 * Before 0.7.6 the swig delegate combined the action's object with gina's render data by making
 * it the TARGET of `lib/merge`, which fills the keys a target lacks: a layoutless render wrote
 * gina's whole page envelope into the object, a render of an object with its own `page` wrote
 * `page.view` (and `page.environment`) into that member, and `lib/merge`'s target-wins rule kept
 * those values on every later request. So a second request through the same object rendered
 * the first request's `page.view.url` — and, in a bundle with sessions and the Csrf plugin, its
 * session id and CSRF token (measured on the r2 and r3 scenes of the #B988 record; this file
 * needs no session package, so it reads `page.view.url`, which every page carries). Since
 * 0.7.6 every delegate combines a per-render copy (`core/controller/render-data.js`).
 *
 * The scene: one bundle with views, one module-level object per shape on `global` (so a dev
 * re-require of the controller cannot replace it), and the same shape built fresh per request
 * as the control. Each page prints the URL its template was given. The requests run in
 * `before()`, in order: request 1 then request 2 for each rule, then `peek`, which answers the
 * keys the shared objects hold.
 *
 *   01  controls: a fresh object, layoutless and with its own `page`, shows its own URL on both
 *       requests
 *   02  the same object on both requests, layoutless and with its own `page`: request 2 shows
 *       its own URL (0.7.5: request 1's)
 *   03  the layout render of an object without `page` shows its own URL on both requests, and
 *       `peek`: every shared object holds the keys the action gave it, nothing more
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-array-bag-b965.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14200), project:rm + rmSync at teardown. Seam:
 * `B988_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-render-reuse-b988.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b988-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rr' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14200;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B988_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

// [rule, url, action, how the action renders, the layout the template extends (null: none)]
var RULES = [
    ['b988reusenl',   '/b988-reusenl/:id',   'b988ReuseNl',   'if (!global.__b988NL) { global.__b988NL = { title: "NL" }; } self.renderWithoutLayout(global.__b988NL);', null],
    ['b988freshnl',   '/b988-freshnl/:id',   'b988FreshNl',   'self.renderWithoutLayout({ title: "NL" });', null],
    ['b988reusepage', '/b988-reusepage/:id', 'b988ReusePage', 'if (!global.__b988P) { global.__b988P = { page: { data: { title: "P" } } }; } self.render(global.__b988P);', 'layouts/main.html'],
    ['b988freshpage', '/b988-freshpage/:id', 'b988FreshPage', 'self.render({ page: { data: { title: "P" } } });', 'layouts/main.html'],
    ['b988reuse',     '/b988-reuse/:id',     'b988Reuse',     'if (!global.__b988L) { global.__b988L = { title: "L" }; } self.render(global.__b988L);', 'layouts/main.html'],
    ['b988fresh',     '/b988-fresh/:id',     'b988Fresh',     'self.render({ title: "L" });', 'layouts/main.html']
];

// [label, path under the webroot] — sent in this order, once each
var ARMS = [
    ['freshnl.1',   'b988-freshnl/1'],
    ['freshnl.2',   'b988-freshnl/2'],
    ['freshpage.1', 'b988-freshpage/1'],
    ['freshpage.2', 'b988-freshpage/2'],
    ['reusenl.1',   'b988-reusenl/1'],
    ['reusenl.2',   'b988-reusenl/2'],
    ['reusepage.1', 'b988-reusepage/1'],
    ['reusepage.2', 'b988-reusepage/2'],
    ['reuse.1',     'b988-reuse/1'],
    ['reuse.2',     'b988-reuse/2'],
    ['fresh.1',     'b988-fresh/1'],
    ['fresh.2',     'b988-fresh/2'],
    ['peek',        'b988-peek']
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
 * @returns {Promise<object>} `{ status, body, json }` or `{ status: null, err }`
 */
function request(reqPath) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: 'GET', rejectUnauthorized: false
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
 * count-guarded) and adds the rules, the actions and the templates this file drives.
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
    r.b988peek = { namespace: 'content', url: '/b988-peek', method: 'GET', param: { control: 'b988Peek' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = RULES.map(function (rule) {
        return '    this.' + rule[2] + ' = function(req, res) { ' + rule[3] + ' };';
    }).concat([
        '    this.b988Peek = function(req, res) {',
        '        var keys = function (o) { return (o && typeof(o) == "object") ? Object.keys(o) : null; };',
        '        self.renderJSON({',
        '            nl: keys(global.__b988NL),',
        '            page: keys(global.__b988P), pageMember: keys(global.__b988P && global.__b988P.page),',
        '            pageData: keys(global.__b988P && global.__b988P.page && global.__b988P.page.data),',
        '            layout: keys(global.__b988L)',
        '        });',
        '    };',
        ''
    ]).join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + '\n' + anchor));

    var td = path.join(bundleDir, 'templates', 'html', 'content');
    if (!fs.existsSync(td)) { throw new Error('no templates/html/content (did view:add run?)'); }
    RULES.forEach(function (rule) {
        var line = '<p id="b988">RULE=[' + rule[0] + '] URL=[{{ page.view.url }}]</p>';
        var tpl = rule[4]
            ? '{% extends \'' + rule[4] + '\' %}\n{% block content %}' + line + '{% endblock %}\n'
            : line + '\n';
        fs.writeFileSync(path.join(td, rule[0] + '.html'), tpl);
    });
}

/**
 * The URL a page's template was given, asserted to come from a 200 HTML answer of the rule.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {string} the URL between `URL=[` and `]`
 */
function urlOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 200, label + ': expected 200 (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 400) + ')');
    var m = /RULE=\[([^\]]*)\] URL=\[([^\]]*)\]/.exec(a.body);
    assert.ok(m, label + ': the page carries the scene line (body: ' + String(a.body).slice(0, 300) + ')');
    return m[2];
}

/** The path a request was sent to. */
function pathOf(label) {
    for (var i = 0; i < ARMS.length; i++) { if (ARMS[i][0] === label) { return webroot + ARMS[i][1]; } }
    throw new Error('no arm ' + label);
}


// ---------------------------------------------------------------------------
// 01 – 03 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-render-reuse — an object passed to several renders gives each request its own page (#B988)', function () {

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
            answers[ARMS[i][0]] = await request(webroot + ARMS[i][1]);
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

    it('01.1  CONTROL — a fresh object, layoutless: each request shows its own URL', async function (t) {
        if (!ready(t)) return;
        assert.equal(urlOf('freshnl.1'), pathOf('freshnl.1'));
        assert.equal(urlOf('freshnl.2'), pathOf('freshnl.2'));
    });

    it('01.2  CONTROL — a fresh object with its own `page`: each request shows its own URL', async function (t) {
        if (!ready(t)) return;
        assert.equal(urlOf('freshpage.1'), pathOf('freshpage.1'));
        assert.equal(urlOf('freshpage.2'), pathOf('freshpage.2'));
    });

    // ── 02 the same object on both requests ─────────────────────────────────

    it('02.1  the same object, layoutless: request 2 shows its own URL (0.7.5: request 1\'s)', async function (t) {
        if (!ready(t)) return;
        assert.equal(urlOf('reusenl.1'), pathOf('reusenl.1'));
        assert.equal(urlOf('reusenl.2'), pathOf('reusenl.2'), 'request 2\'s own URL');
    });

    it('02.2  the same object with its own `page`: request 2 shows its own URL (0.7.5: request 1\'s)', async function (t) {
        if (!ready(t)) return;
        assert.equal(urlOf('reusepage.1'), pathOf('reusepage.1'));
        assert.equal(urlOf('reusepage.2'), pathOf('reusepage.2'), 'request 2\'s own URL');
    });

    // ── 03 a layout render of an object without `page`, and peek ────────────

    it('03.1  the same object without `page`, layout render: each request shows its own URL', async function (t) {
        if (!ready(t)) return;
        assert.equal(urlOf('reuse.1'), pathOf('reuse.1'));
        assert.equal(urlOf('reuse.2'), pathOf('reuse.2'));
        assert.equal(urlOf('fresh.2'), pathOf('fresh.2'), 'CONTROL: the fresh twin');
    });

    it('03.2  peek: every shared object holds the keys the action gave it, nothing more', async function (t) {
        if (!ready(t)) return;
        var a = answers.peek;
        assert.equal(a.status, 200, 'peek: ' + String(a.err || a.body).slice(0, 300));
        assert.ok(a.json, 'peek answers JSON');
        assert.deepEqual(a.json.nl, ['title'], 'the layoutless object (0.7.5: it gained `page`)');
        assert.deepEqual(a.json.page, ['page'], 'the object with its own page');
        assert.deepEqual(a.json.pageMember, ['data'], 'its `page` member (0.7.5: it gained `view`, `environment`, …)');
        assert.deepEqual(a.json.pageData, ['title'], 'its `page.data`');
        assert.deepEqual(a.json.layout, ['title'], 'the object without `page` on a layout render');
    });
});
