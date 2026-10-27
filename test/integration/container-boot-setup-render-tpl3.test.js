/**
 * #TPL3 — a template a route middleware renders sees the filters the bundle registers in
 * `controllers/setup.js`, from the first request after boot, in a booted bundle.
 *
 * The router runs `setup.js` only for a request that reaches a controller action: the route
 * middlewares run first, and the reserved hooks (`onReady`, `setup`) run in their `done` callback.
 * A middleware that answers with `self.render()` never calls `done`, so before 0.7.6 its template
 * saw no bundle filter until an earlier request had run `setup.js` on the same engine (the swig
 * engine is shared per template root and outlives the request): a 500 `Invalid filter` from boot
 * until a controller request, and on every request for a route set whose middleware renders them
 * all. Since 0.7.6 a swig render runs `setup.js` on its engine when that engine has not yet run
 * this `setup.js` module, with the router's receiver; the router records its own runs on the
 * engine, so an action request still runs it once.
 *
 * The scene: one bundle whose `setup.js` registers `tpl3stamp` and a bundle `nl2br` (gina's own
 * `nl2br` must still win), and logs each run with the request URL and which of the router's 15
 * receiver members it received; a route middleware `tpl3.paint` that answers with `self.render()`;
 * a route without middleware whose action renders the same template. The requests run in
 * `before()`, in order, so the first render after boot is the middleware's.
 *
 *   01  the first render after boot is a middleware's: the filter renders, setup.js ran once at
 *       the render with the router's members
 *   02  controls that hold on both sides of the fix
 *   03  the same scene booted from a prod build (`bundle:build --env=prod`, then NODE_ENV=prod):
 *       the first middleware render, an action's single run, and no second run for the engine
 *   04  `page.environment.packageVersion`: the version in the project's own package.json, dev and prod
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-param-precedence-b954.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14050), project:rm + rmSync at teardown. Seam:
 * `TPL3_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-setup-render-tpl3.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-tpl3-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'pt' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14050;
var SETUP_LOG  = path.join(FAKE_HOME, 'setup-runs.log');

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.TPL3_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

// the members the router hands setup.js (router.js, the #B807 receiver)
var SETUP_MEMBERS = [
    'engine', 'getConfig', 'checkBundleStatus', 'getLocales', 'getFormsRules', 'throwError', 'redirect',
    'render', 'renderJSON', 'renderWithoutLayout', 'isXMLRequest', 'isWithCredentials', 'isPopinContext',
    'isCacheless', 'requireController'
];

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {}, runsDuring = {};

// [label, path under the webroot] — sent in this order, once each, to the dev boot
var ARMS = [
    ['mw.cold',  'tpl3-mw?n=1'],
    ['mw.plain', 'tpl3-mw-plain?n=2'],
    ['ctrl',     'tpl3-ctrl?n=3'],
    ['mw.warm',  'tpl3-mw?n=4'],
    ['ver',      'tpl3-ver?n=5']
];
// then to a prod boot of the same scene (an offline `bundle:build --env=prod`, then NODE_ENV=prod)
var PROD_ARMS = [
    ['prod.mw.cold', 'tpl3-mw?n=11'],
    ['prod.ctrl',    'tpl3-ctrl?n=12'],
    ['prod.mw.warm', 'tpl3-mw?n=13'],
    ['prod.ver',     'tpl3-ver?n=14']
];
// the version written into the scaffold's package.json, read back as page.environment.packageVersion
var PACKAGE_VERSION = '9.8.7-tpl3';


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
 * @returns {Promise<object>} `{ status, headers, body }` or `{ status: null, err }`
 */
function get(reqPath) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: 'GET', rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: data }); });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, headers: {}, body: '' }); });
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

/** The setup.js runs logged so far, one object per run. */
function setupRuns() {
    if (!fs.existsSync(SETUP_LOG)) { return []; }
    return fs.readFileSync(SETUP_LOG, 'utf8').split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
}

/** Adds the rules, the action, the middleware, setup.js and the templates this file drives. */
function installScene() {
    var src = path.join(PROJ_DIR, 'src', BUNDLE);
    var rf  = path.join(src, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.tpl3_mw       = { namespace: 'content', url: '/tpl3-mw',       method: 'GET', param: { control: 'tpl3page' },  middleware: ['middlewares.tpl3.paint'] };
    r.tpl3_mw_plain = { namespace: 'content', url: '/tpl3-mw-plain', method: 'GET', param: { control: 'tpl3plain' }, middleware: ['middlewares.tpl3.paint'] };
    r.tpl3_ctrl     = { namespace: 'content', url: '/tpl3-ctrl',     method: 'GET', param: { control: 'tpl3page' } };
    r.tpl3_ver      = { namespace: 'content', url: '/tpl3-ver',      method: 'GET', param: { control: 'tpl3ver' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    // the project's own package.json carries a known version
    var pf = path.join(PROJ_DIR, 'package.json');
    var pkg = fs.existsSync(pf) ? JSON.parse(fs.readFileSync(pf, 'utf8')) : { name: PROJ };
    pkg.version = PACKAGE_VERSION;
    fs.writeFileSync(pf, JSON.stringify(pkg, null, 2) + '\n');

    var cf = path.join(src, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    fs.writeFileSync(cf, s.replace(anchor, [
        "    this.tpl3page = function(req, res) { self.render({ who: 'ctrl' }); };",
        "    this.tpl3plain = function(req, res) { self.render({ who: 'ctrl-plain' }); };",
        "    this.tpl3ver = function(req, res) { self.render({ who: 'ver' }); };",
        ''
    ].join('\n') + anchor));

    fs.writeFileSync(path.join(src, 'controllers', 'setup.js'), [
        "var fs = require('fs');",
        'var MEMBERS = ' + JSON.stringify(SETUP_MEMBERS) + ';',
        'function SetupClass(req, res, next) {',
        '    var self = this, engine = this.engine;',
        "    if (engine && typeof(engine.setFilter) == 'function') {",
        "        engine.setFilter('tpl3stamp', function (x) { return 'STAMP<' + x + '>'; });",
        "        engine.setFilter('nl2br', function () { return 'BUNDLE-NL2BR'; });",
        '    }',
        "    var missing = MEMBERS.filter(function (k) { return typeof(self[k]) == 'undefined'; });",
        '    fs.appendFileSync(' + JSON.stringify(SETUP_LOG) + ', JSON.stringify({',
        "        url: (req && (req.originalUrl || req.url)) || null, engine: !!(engine && typeof(engine.setFilter) == 'function'), missing: missing",
        "    }) + '\\n');",
        '}',
        'module.exports = SetupClass;',
        ''
    ].join('\n'));

    var md = path.join(src, 'middlewares', 'tpl3');
    fs.mkdirSync(md, { recursive: true });
    fs.writeFileSync(path.join(md, 'index.js'), [
        'function Tpl3Middleware() {',
        '    var self = this;',
        "    this.paint = function(req, res, next, done) { self.render({ who: 'mw' }); };",
        '}',
        'module.exports = Tpl3Middleware;',
        ''
    ].join('\n'));

    // a render resolves content/<route rule name>.html
    var td = path.join(src, 'templates', 'html', 'content');
    var withFilters = "<div id=\"tpl3\">{{ who }}|{{ 'x'|tpl3stamp }}|{{ 'x'|nl2br }}</div>\n";
    fs.writeFileSync(path.join(td, 'tpl3_mw.html'), withFilters);
    fs.writeFileSync(path.join(td, 'tpl3_ctrl.html'), withFilters);
    fs.writeFileSync(path.join(td, 'tpl3_mw_plain.html'), '<div id="tpl3plain">{{ who }}</div>\n');
    fs.writeFileSync(path.join(td, 'tpl3_ver.html'), '<div id="tpl3ver">[{{ page.environment.packageVersion }}]</div>\n');
}

/**
 * The answer of an arm, asserted to be a 200.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {string} the body
 */
function bodyOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 200, label + ': expected 200 (got ' + a.status + ': ' + String(a.err || a.body || '').replace(/\s+/g, ' ').slice(0, 300) + ')');
    return a.body;
}


// ---------------------------------------------------------------------------
// 01 – 02 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-setup-render — a route middleware render sees the setup.js filters from boot (#TPL3)', function () {

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
        if (!fs.existsSync(path.join(PROJ_DIR, 'src', BUNDLE, 'templates', 'html', 'content'))) {
            setupError = 'view:add did not install the templates: ' + (va.stdout + va.stderr).slice(-800); return;
        }

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

        // the dev boot: every ARMS arm, in order; the setup.js runs each request caused are the log lines it added
        var devUp = await boot(CHILD_ENV, bundlePort);
        if (devUp !== true) { setupError = 'the dev bundle did not come up: ' + devUp; return; }
        await sendArms(ARMS);
        await stop();

        // the prod boot of the same scene
        var b = runCli(['bundle:build', BUNDLE, '@' + PROJ, '--env=prod', '--scope=local']);
        if (b.status !== 0) { setupError = 'bundle:build --env=prod failed: ' + (b.stdout + b.stderr).slice(-800); return; }
        try { bundlePort = readJSON(portsReversePath)[key].prod[proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the prod port for ' + key; return; }
        var prodUp = await boot(Object.assign({}, CHILD_ENV, { NODE_ENV: 'prod', NODE_SCOPE: 'local' }), bundlePort);
        if (prodUp !== true) { setupError = 'the prod bundle did not come up: ' + prodUp; return; }
        await sendArms(PROD_ARMS);
    });

    /**
     * Boots the bundle through the daemonless launcher and waits for its port.
     *
     * @inner
     * @param {object} env - the launcher's environment
     * @param {number} port - the port the bundle listens on
     * @returns {Promise<true|string>} `true` once the port opens, else the reason it did not
     */
    async function boot(env, port) {
        childOut = ''; childExit = null;
        child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: env, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', function (d) { childOut += d; });
        child.stderr.on('data', function (d) { childOut += d; });
        child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
        var deadline = Date.now() + BOOT_TIMEOUT_MS;
        while (Date.now() < deadline && !childExit) {
            if (await isTcpPortOpen(port)) { await sleep(300); return true; }
            await sleep(POLL_INTERVAL_MS);
        }
        return 'exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000);
    }

    /** Sends each arm in order and records the setup.js runs it caused. */
    async function sendArms(arms) {
        for (var i = 0; i < arms.length; i++) {
            var seen = setupRuns().length;
            answers[arms[i][0]] = await get(webroot + arms[i][1]);
            runsDuring[arms[i][0]] = setupRuns().slice(seen);
        }
    }

    /** Stops the running bundle: SIGTERM, then SIGKILL after 4 s. */
    async function stop() {
        if (isChildAlive()) {
            try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
            var until = Date.now() + 4000;
            while (Date.now() < until && isChildAlive()) { await sleep(150); }
            if (isChildAlive()) { try { child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        }
    }

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

    // ── 01 the first render after boot is a middleware's ─────────────────────

    it('01.1  [fix] a route middleware renders a template using a setup.js filter on the first request after boot', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('mw.cold');
        assert.ok(body.indexOf('mw|STAMP&lt;x&gt;|') > -1, 'expected the bundle filter in the middleware render (got ' + body.slice(0, 200) + ')');
    });

    it('01.2  [fix] setup.js ran once for that request, at the render, with the members the router gives it', async function (t) {
        if (!ready(t)) return;
        var runs = runsDuring['mw.cold'];
        assert.equal(runs.length, 1, 'expected one setup.js run during the first middleware render (got ' + JSON.stringify(runs) + ')');
        assert.equal(runs[0].url, webroot + 'tpl3-mw?n=1', 'the run received the middleware request');
        assert.equal(runs[0].engine, true, 'the run received the engine the render uses');
        assert.deepEqual(runs[0].missing, [], 'the run received the router receiver members');
    });

    it('01.3  [fix] gina\'s own nl2br still wins over the bundle\'s, in the first middleware render', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('mw.cold');
        assert.equal(body.indexOf('BUNDLE-NL2BR'), -1, 'the bundle nl2br must not replace gina\'s');
        assert.ok(/\|x<\/div>/.test(body), 'gina\'s nl2br rendered x unchanged (got ' + body.slice(0, 200) + ')');
    });

    // ── 02 controls: hold on both sides of the fix ──────────────────────────

    it('02.1  CONTROL — a route middleware renders a plain template', async function (t) {
        if (!ready(t)) return;
        assert.ok(bodyOf('mw.plain').indexOf('<div id="tpl3plain">mw</div>') > -1);
    });

    it('02.2  CONTROL — an action renders the template with the setup.js filter, and gina\'s nl2br wins there', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('ctrl');
        assert.ok(body.indexOf('ctrl|STAMP&lt;x&gt;|x</div>') > -1, 'got ' + body.slice(0, 200));
    });

    it('02.3  CONTROL — an action request runs setup.js exactly once, with the router\'s members', async function (t) {
        if (!ready(t)) return;
        var runs = runsDuring['ctrl'];
        assert.equal(runs.length, 1, 'expected one setup.js run during the action request (got ' + JSON.stringify(runs) + ')');
        assert.equal(runs[0].url, webroot + 'tpl3-ctrl?n=3');
        assert.deepEqual(runs[0].missing, []);
    });

    it('02.4  CONTROL — after an action request, a route middleware renders the template with the filter', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('mw.warm');
        assert.ok(body.indexOf('mw|STAMP&lt;x&gt;|x</div>') > -1, 'got ' + body.slice(0, 200));
        assert.ok(runsDuring['mw.warm'].length <= 1, 'at most one setup.js run per request (got ' + runsDuring['mw.warm'].length + ')');
    });

    // ── 03 the same scene, booted from a prod build ─────────────────────────

    it('03.1  [fix] prod — a route middleware renders the setup.js filter on the first request after boot, setup.js ran once at that render', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('prod.mw.cold');
        assert.ok(body.indexOf('mw|STAMP&lt;x&gt;|x</div>') > -1, 'got ' + body.slice(0, 200));
        var runs = runsDuring['prod.mw.cold'];
        assert.equal(runs.length, 1, 'expected one setup.js run (got ' + JSON.stringify(runs) + ')');
        assert.equal(runs[0].url, webroot + 'tpl3-mw?n=11');
        assert.deepEqual(runs[0].missing, []);
    });

    it('03.2  CONTROL — prod: an action request runs setup.js exactly once (the router\'s run)', async function (t) {
        if (!ready(t)) return;
        assert.ok(bodyOf('prod.ctrl').indexOf('ctrl|STAMP&lt;x&gt;|x</div>') > -1);
        var runs = runsDuring['prod.ctrl'];
        assert.equal(runs.length, 1, 'expected one setup.js run (got ' + JSON.stringify(runs) + ')');
        assert.equal(runs[0].url, webroot + 'tpl3-ctrl?n=12');
    });

    it('03.3  CONTROL — prod: a later middleware render does not run setup.js again (one run per engine)', async function (t) {
        if (!ready(t)) return;
        assert.ok(bodyOf('prod.mw.warm').indexOf('mw|STAMP&lt;x&gt;|x</div>') > -1);
        assert.deepEqual(runsDuring['prod.mw.warm'], [], 'the engine already ran this setup.js module');
    });

    // ── 04 page.environment.packageVersion ──────────────────────────────────

    it('04.1  [fix] dev — page.environment.packageVersion is the version in the project\'s package.json', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('ver');
        assert.ok(body.indexOf('<div id="tpl3ver">[' + PACKAGE_VERSION + ']</div>') > -1, 'got ' + body.slice(0, 200));
    });

    it('04.2  [fix] prod — page.environment.packageVersion is the version in the project\'s package.json', async function (t) {
        if (!ready(t)) return;
        var body = bodyOf('prod.ver');
        assert.ok(body.indexOf('<div id="tpl3ver">[' + PACKAGE_VERSION + ']</div>') > -1, 'got ' + body.slice(0, 200));
    });
});
