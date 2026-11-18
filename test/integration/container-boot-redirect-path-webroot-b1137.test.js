/**
 * #B1137 — real-bytes boot: a redirect that uses `param.path` under a non-root webroot.
 *
 * config.js meant to prefix every route's `param.path` with the bundle's webroot at boot, but its
 * conditional bound to the whole sum (`localWroot + (test) ? a : b`), so under a webroot such as
 * `/demo/` the path only lost its first character: a redirect route's `/general` sent the relative
 * Location `general`, `general` sent `eneral`, `/` an empty Location, an absolute URL lost its first
 * letter, and the other readers of `param.path` (a page route's template path, an action reading
 * it) got the cut value too. The fix leaves `param.path` as written in config.js; redirect() adds
 * the webroot when its request-object form uses `param.path` (a redirect route, or a custom action
 * calling `self.redirect(req, res, next)`), not for a `route` target, `ignoreWebRoot`, the webroot
 * `/` or an absolute URL.
 *
 * This file boots the REAL `bin/gina-container` ONCE against a scaffolded project under the
 * scaffold's own non-root webroot, with the routes below added to the bundle's routing.json, two
 * actions added to its content controller, one to its main controller and one page template, then
 * requests each route without following redirects:
 *
 *   §02 redirect routes                         before the fix          after
 *       P1 path `/b1137/deep/home`              `b1137/deep/home`       `<w>b1137/deep/home`
 *       P2 path `/documentation/`               `documentation/`        `<w>documentation/`
 *       P3 path `/general`                      `general`               `<w>general`
 *       P4 path `general`                       `eneral`                `<w>general`
 *       P7 path `/`                             empty                   `<w>`
 *       P8 path `/b1137/users/:id`, GET …/42    `b1137/users/42`        `<w>b1137/users/42`
 *       P9 path `https://example.com/b1137`     `ttps://example.com/…`  as written
 *       P10 a POST, path `/general`             303 `general`           303 `<w>general`
 *       P11 `keep-params`, GET …?x=1            `b1137/kp?x=1`          `<w>b1137/kp?x=1`
 *   §03 the other readers of `param.path`
 *       R1 a page route whose `param.path` is its template file          500 → 200
 *       E1 an action that reads its route's `param.path`                 `upstream/…` → `/upstream/…`
 *       X1 a custom action calling `self.redirect(req, res, next)`       `b1137/deep/home` → `<w>b1137/deep/home`
 *   §04 CONTROLS (the same before and after): a JSON route; a `route` target; `ignoreWebRoot` with
 *       the url and the path written with the webroot; the target page; the bare webroot's automatic
 *       redirect (`ignoreWebRoot` set by config.js: `<w>` once, never twice).
 *
 * Measured 2026-11-16 on develop and on the fix through a booted driver (webroot `/web/`), the
 * values of the table above. HTTP/2 is covered by
 * test/core/controller-redirect-path-webroot-b1137.test.js (the scaffold has no cleartext HTTP/2 port).
 *
 * Isolation: the container-boot.test.js shape — a throwaway HOME under os.tmpdir(), its own port
 * window (14800; the other container-boot files use windows up to 14750 and the suite runs files in
 * parallel), project:rm + rmSync at teardown. The real ~/.gina is never touched. Module-path seam:
 * `B1137_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's CLI.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-redirect-path-webroot-b1137.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http   = require('http');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP      = Date.now();
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rw-home-' + STAMP);   // $HOME override → <FAKE_HOME>/.gina
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rw' + STAMP;                                       // valid [a-z0-9_.]+ project name
var BUNDLE     = 'demo';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var SRC        = path.join(PROJ_DIR, 'src', BUNDLE);
var PORT_START = 14800;                                              // own window — see the header

var BOOT_TIMEOUT_MS  = 30000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT  = process.env.B1137_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI        = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER  = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, {
    HOME           : FAKE_HOME,
    GINA_LOG_STDOUT: 'true'
});
delete CHILD_ENV.GINA_HOMEDIR;   // must derive from HOME, not inherit the dev's value

var MARK        = 'B1137-RENDER-OK';
var UPSTREAM    = '/upstream/b1137/ping';
var skip        = false;
var skipReason  = '';
var setupError  = null;
var bundlePort  = null;
var webroot     = '/';        // normalised, `/demo/`
var booted      = null;       // { child, exit, out }


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isTcpPortOpen(port) {
    return new Promise(function(resolve) {
        var sock = new net.Socket();
        sock.setTimeout(800);
        sock.on('connect', function() { sock.destroy(); resolve(true);  });
        sock.on('error',   function() { resolve(false); });
        sock.on('timeout', function() { sock.destroy(); resolve(false); });
        sock.connect(port, '127.0.0.1');
    });
}

/**
 * One request to the bundle; redirects are never followed.
 *
 * @inner
 * @param {string} method
 * @param {string} reqPath - The full request path, webroot included
 * @returns {Promise<{status: (number|null), location: (string|null), body: string, err: (string|undefined)}>}
 */
function request(method, reqPath) {
    return new Promise(function(resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, agent: false }, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end',  function() { resolve({ status: res.statusCode, location: (typeof(res.headers.location) == 'string') ? res.headers.location : null, body: body }); });
        });
        req.setTimeout(15000, function() { req.destroy(new Error('client timeout')); });
        req.on('error', function(e) { resolve({ status: null, location: null, body: '', err: e.code || e.message }); });
        req.end();
    });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }

function isChildAlive(child) { return child && child.exitCode === null && child.signalCode === null; }

function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** A scaffolded config file: full-line `//` comments dropped, then JSON. */
function readConfig(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8').split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n'));
}

function countOf(hay, needle) { return hay.split(needle).length - 1; }

/**
 * The routes this file adds to the scaffold's own (`<rule>: <route>`); `tplRoot` is the bundle's
 * `templates/html` directory, as the scaffold registered it.
 *
 * @inner
 * @param {string} tplRoot
 * @returns {object}
 */
function addedRoutes(tplRoot) {
    function redirectRoute(url, extra) { return { namespace: 'content', url: url, method: 'GET', param: Object.assign({ control: 'redirect' }, extra) }; }
    return {
        b1137ok   : { namespace: 'content', url: '/b1137/ok', method: 'GET', param: { control: 'b1137show' } },
        ctarget   : { namespace: 'content', url: '/preferences/general', method: 'GET', param: { control: 'b1137show' } },
        b1137p1   : redirectRoute('/b1137/p1',              { path: '/b1137/deep/home' }),
        b1137p2   : redirectRoute('/b1137/p2',              { path: '/documentation/' }),
        b1137p3   : redirectRoute('/preferences/legacy',    { path: '/general' }),
        b1137p4   : redirectRoute('/preferences/slashless', { path: 'general' }),
        b1137p7   : redirectRoute('/b1137/p7',              { path: '/' }),
        b1137p8   : redirectRoute('/b1137/u/:id',           { id: ':id', path: '/b1137/users/:id' }),
        b1137p9   : redirectRoute('/b1137/p9',              { path: 'https://example.com/b1137' }),
        b1137p11  : redirectRoute('/b1137/p11',             { path: '/b1137/kp', 'keep-params': true }),
        b1137p10  : { namespace: 'content', url: '/b1137/p10', method: 'GET, POST', param: { control: 'redirect', path: '/general' } },
        b1137c1   : redirectRoute('/preferences/document',  { route: 'ctarget@' + BUNDLE }),
        b1137ig   : redirectRoute(webroot + 'b1137/ig',     { path: webroot + 'b1137/ig/target', ignoreWebRoot: true }),
        b1137rnd  : { url: '/b1137/render', method: 'GET', param: { control: 'b1137render', path: tplRoot + '/b1137/page' } },
        b1137echo : { namespace: 'content', url: '/b1137/echo', method: 'GET', param: { control: 'b1137echo', path: UPSTREAM } },
        b1137cust : { namespace: 'content', url: '/b1137/custom', method: 'GET', param: { control: 'b1137custom', path: '/b1137/deep/home' } }
    };
}

/**
 * Adds the actions the routes above dispatch to: `b1137show`, `b1137custom` and `b1137echo` to the
 * content controller, `b1137render` to the main controller, and the page template (no `extends`,
 * so it renders without a layout). Returns an error string, or null.
 *
 * @inner
 * @returns {?string}
 */
function installActions() {
    var cf = path.join(SRC, 'controllers', 'controller.content.js');
    var c  = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (countOf(c, anchor) !== 1) { return 'content controller anchor count ' + countOf(c, anchor); }
    var act = [
        '    this.b1137show = function(req, res) {',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || "<none>", ok: true });',
        '    };',
        '    this.b1137custom = function(req, res, next) {',
        '        return self.redirect(req, res, next);',
        '    };',
        '    this.b1137echo = function(req, res) {',
        '        var p = (req.routing && req.routing.param) ? req.routing.param.path : undefined;',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || "<none>", path: (typeof(p) == "undefined") ? "<undefined>" : p });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, c.replace(anchor, function() { return act + anchor; }));
    var mf = path.join(SRC, 'controllers', 'controller.js');
    var m  = fs.readFileSync(mf, 'utf8');
    var manchor = '    var self = this;\n';
    if (countOf(m, manchor) !== 1) { return 'main controller anchor count ' + countOf(m, manchor); }
    var mact = [
        '    this.b1137render = function(req, res) {',
        '        self.render({ b1137: "render" });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(mf, m.replace(manchor, function() { return manchor + mact; }));
    var tplRoot = path.join(SRC, 'templates', 'html');
    fs.mkdirSync(path.join(tplRoot, 'b1137'), { recursive: true });
    fs.writeFileSync(path.join(tplRoot, 'b1137', 'page.html'), '<p id="b1137">' + MARK + '</p>\n');
    return null;
}

/** SIGTERM (drain + exit 143), then SIGKILL; waits for the exit so the port is free. */
async function teardown(b) {
    if (!b) { return; }
    if (isChildAlive(b.child)) {
        try { b.child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 5000;
        while (Date.now() < until && isChildAlive(b.child)) { await sleep(150); }
        if (isChildAlive(b.child)) { try { b.child.kill('SIGKILL'); } catch (e) { /* ignore */ } }
        until = Date.now() + 2000;
        while (Date.now() < until && isChildAlive(b.child)) { await sleep(100); }
    }
    var freeBy = Date.now() + 3000;
    while (bundlePort && Date.now() < freeBy && await isTcpPortOpen(bundlePort)) { await sleep(150); }
}

function diagnostics() {
    if (!booted) { return '(no boot)'; }
    return 'exit: ' + JSON.stringify(booted.exit) + ' | alive: ' + isChildAlive(booted.child) + '\n'
        + 'output (last 3000 chars):\n' + (booted.out.slice(-3000) || '(empty)');
}

/** Each arm: the boot must have passed, the process must still be up. */
function ready(t) {
    if (skip) { t.skip(skipReason); return false; }
    assert.equal(setupError, null, 'setup failed: ' + setupError + '\n' + diagnostics());
    assert.ok(isChildAlive(booted.child), 'the bundle must still be up.\n' + diagnostics());
    return true;
}

async function assertRedirect(method, reqPath, status, location) {
    var r = await request(method, reqPath);
    assert.equal(r.status, status, method + ' ' + reqPath + ' — status (body: ' + String(r.body).slice(0, 200) + ')');
    assert.equal(r.location, location, method + ' ' + reqPath + ' — Location');
}

function w(rest) { return webroot + rest; }


// ---------------------------------------------------------------------------
// The boot
// ---------------------------------------------------------------------------

describe('#B1137 — container-boot: a redirect that uses `param.path` under a non-root webroot (real bytes)', function() {

    before(async function() {
        if (process.platform === 'win32') {
            skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)';
            return;
        }
        fs.mkdirSync(PROJ_DIR, { recursive: true });

        runCli(['project:add', '@' + PROJ, '--path=' + PROJ_DIR]);
        var projectsPath = path.join(GINA_HOME, 'projects.json');
        if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[PROJ]) {
            setupError = 'project:add did not register @' + PROJ + ' in ' + projectsPath; return;
        }
        runCli(['bundle:add', BUNDLE, '@' + PROJ, '--start-port-from=' + PORT_START]);
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var key = BUNDLE + '@' + PROJ;
        if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) {
            setupError = 'bundle:add did not register ' + key + ' in ports.reverse.json'; return;
        }
        var va = runCli(['view:add', BUNDLE, '@' + PROJ]);
        if (!fs.existsSync(path.join(SRC, 'templates', 'html', 'layouts', 'main.html'))) {
            setupError = 'view:add did not install the templates: ' + (va.stdout + va.stderr).slice(-800); return;
        }

        // The project must load the tree under test (the #B422 Franken-boot trap).
        var link = path.join(PROJ_DIR, 'node_modules', 'gina');
        try {
            var target = fs.realpathSync(link);
            if (target !== fs.realpathSync(GINA_ROOT)) {
                setupError = 'node_modules/gina resolves to ' + target + ', not the tree under test ' + GINA_ROOT; return;
            }
        } catch (e) {
            setupError = 'node_modules/gina is not linked in the scaffolded project: ' + (e.message || e); return;
        }

        var projects = readJSON(projectsPath), portsReverse = readJSON(portsReversePath);
        var pe = projects[PROJ], env = pe.def_env || 'dev', proto = pe.def_protocol, scheme = pe.def_scheme || 'http';
        if (scheme !== 'http' || !/^http\/1\.1$/.test(String(proto))) {
            setupError = 'the scaffold speaks ' + proto + '/' + scheme + '; this file requests http/1.1 over http'; return;
        }
        try { bundlePort = portsReverse[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        var ssj = fs.readFileSync(path.join(SRC, 'config', 'settings.server.json'), 'utf8');
        var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1];
        var t   = String(wr || '').replace(/^\/+|\/+$/g, '');
        if (!t) { setupError = 'the scaffold\'s webroot is `/` (read ' + JSON.stringify(wr) + '); this file needs a non-root webroot'; return; }
        webroot = '/' + t + '/';

        var routingFile = path.join(SRC, 'config', 'routing.json');
        var table;
        try { table = readConfig(routingFile); } catch (e) { setupError = 'could not read the scaffold routing.json: ' + (e.message || e); return; }
        var err = installActions();
        if (err) { setupError = err; return; }
        var add = addedRoutes(path.join(SRC, 'templates', 'html'));
        Object.keys(add).forEach(function(k) { table[k] = add[k]; });
        fs.writeFileSync(routingFile, JSON.stringify(table, null, 2));

        var child = spawn(process.execPath, [CONTAINER, BUNDLE, '@' + PROJ], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
        booted = { child: child, exit: null, out: '' };
        child.stdout.on('data', function(d) { booted.out += d; });
        child.stderr.on('data', function(d) { booted.out += d; });
        child.on('exit', function(code, signal) { booted.exit = { code: code, signal: signal }; });
        var deadline = Date.now() + BOOT_TIMEOUT_MS;
        while (Date.now() < deadline && !booted.exit) {
            if (await isTcpPortOpen(bundlePort)) { await sleep(300); return; }
            await sleep(POLL_INTERVAL_MS);
        }
        setupError = 'the bundle did not open its port within ' + BOOT_TIMEOUT_MS + ' ms';
    });

    after(async function() {
        await teardown(booted);
        try { runCli(['project:rm', '@' + PROJ, '--force']); } catch (e) { /* ignore */ }
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        // project:add may create an empty ~/.<project> on the REAL home even under HOME isolation
        // (boot-smoke recipes, 2026-07-30); the name is unique to this run.
        try { fs.rmdirSync(path.join(os.homedir(), '.' + PROJ)); } catch (e) { /* absent or non-empty: leave it */ }
    });

    // ── §02 — redirect routes ──────────────────────────────────────────────────
    it('§02.1 P1 `/b1137/deep/home` answers `<webroot>b1137/deep/home`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/p1'), 301, w('b1137/deep/home'));
    });

    it('§02.2 P2 `/documentation/` answers `<webroot>documentation/`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/p2'), 301, w('documentation/'));
    });

    it('§02.3 P3 `/general` and P4 `general` both answer `<webroot>general`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('preferences/legacy'), 301, w('general'));
        await assertRedirect('GET', w('preferences/slashless'), 301, w('general'));
    });

    it('§02.4 P7 `/` answers the webroot itself', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/p7'), 301, webroot);
    });

    it('§02.5 P8 a placeholder path, `/b1137/users/:id` from GET …/u/42, answers `<webroot>b1137/users/42`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/u/42'), 301, w('b1137/users/42'));
    });

    it('§02.6 P9 an absolute URL is answered as written', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/p9'), 301, 'https://example.com/b1137');
    });

    it('§02.7 P10 a POST answers 303 to `<webroot>general`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('POST', w('b1137/p10'), 303, w('general'));
    });

    it('§02.8 P11 `keep-params` carries the query onto `<webroot>b1137/kp`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/p11?x=1'), 301, w('b1137/kp?x=1'));
    });

    // ── §03 — the other readers of `param.path` ────────────────────────────────
    it('§03.1 R1 a page route whose `param.path` is its template file renders it', async function(t) {
        if (!ready(t)) { return; }
        var r = await request('GET', w('b1137/render'));
        assert.equal(r.status, 200, 'status (body: ' + String(r.body).slice(0, 200) + ')');
        assert.ok(String(r.body).indexOf(MARK) > -1, 'the template\'s marker; first 200 chars: ' + String(r.body).slice(0, 200));
    });

    it('§03.2 E1 an action reads its route\'s `param.path` as written', async function(t) {
        if (!ready(t)) { return; }
        var r = await request('GET', w('b1137/echo'));
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.body).path, UPSTREAM);
    });

    it('§03.3 X1 a custom action calling `self.redirect(req, res, next)` answers `<webroot>b1137/deep/home`', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/custom'), 301, w('b1137/deep/home'));
    });

    // ── §04 — controls ────────────────────────────────────────────────────────
    it('§04.1 CONTROL: a JSON route and the redirect target page answer 200', async function(t) {
        if (!ready(t)) { return; }
        var a = await request('GET', w('b1137/ok'));
        assert.equal(a.status, 200);
        assert.equal(JSON.parse(a.body).ok, true);
        var b = await request('GET', w('preferences/general'));
        assert.equal(b.status, 200);
    });

    it('§04.2 CONTROL: a `route` target answers the target\'s url, its webroot once', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('preferences/document'), 301, w('preferences/general'));
    });

    it('§04.3 CONTROL: `ignoreWebRoot` with the url and the path written with the webroot answers the path as written', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', w('b1137/ig'), 301, w('b1137/ig/target'));
    });

    it('§04.4 CONTROL: the bare webroot\'s automatic redirect answers the webroot once', async function(t) {
        if (!ready(t)) { return; }
        await assertRedirect('GET', webroot.replace(/\/$/, ''), 302, webroot);
    });
});
