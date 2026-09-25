/**
 * #B650 — a query key named like an `Object.prototype` member no longer lets a request
 * reach a rule whose path differs from its own, through a booted bundle.
 *
 * The unit file (test/lib/routing-inherited-keys-b650.test.js) drives the real
 * `compareUrls` in-process; this one boots the REAL `bin/gina-container` (isaac, the default
 * engine, the default http/1.1 protocol) and sends the requests over HTTP, so the query
 * parser that builds `req.get` is part of the path under test. Arms:
 *
 *   01  controls — each rule answers on its own path; another path, plain values under the
 *       same names, and a rule without requirements answer 404; a requirement the rule
 *       declares still gates a key carried in the query
 *   02  crafted keys (values shaped like the inherited function's source) no longer reach
 *       a rule through another path — pre-fix they did, one leading segment per key,
 *       including a path outside the bundle's webroot
 *   03  a match on its own path with crafted keys leaves `req.params.toString` a function
 *       (pre-fix: the action received it as a string)
 *
 * Every arm uses its own path, because the warm route cache is keyed by method + path.
 * Isolation: the container-boot-route-method.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (9950; route-method uses 9900), project:rm + rmSync at
 * teardown. Seam: `B650_GINA_ROOT=<tree>` boots THAT tree's launcher against a project
 * scaffolded by THAT tree's CLI.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-route-confusion.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rc-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rc' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 9950;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B650_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE;
var child = null, childOut = '', childExit = null;

var K2 = ['toString', 'valueOf'];
var K3 = K2.concat('toLocaleString');
var K4 = K3.concat('isPrototypeOf');


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
 * A value that passes `new RegExp(String(Object.prototype[name]))` on this engine (the
 * bundle runs on the same runtime as this test): the function's own source with its empty
 * `()` group dropped and its `[native code]` class reduced to one member.
 */
function craft(name) {
    return String(Object.prototype[name]).replace('()', '').replace('[native code]', 'n');
}

/** A query string carrying one crafted value per name, after any own `extra` pairs. */
function crafted(names, extra) {
    var pairs = [];
    Object.keys(extra || {}).forEach(function (k) { pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(extra[k])); });
    names.forEach(function (n) { pairs.push(n + '=' + encodeURIComponent(craft(n))); });
    return '?' + pairs.join('&');
}

/** One HTTP/1.1 request on a fresh connection; `absPath` starts with `/`. */
function request(method, absPath) {
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.setTimeout(15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        req.end();
    });
}

/** A request on a path under the bundle's webroot. */
function get(p, method) { return request(method || 'GET', webroot + p); }

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** The fixture rules; every one runs the same echo action. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var add = function (name, url, method, extra) {
        r[name] = Object.assign({ namespace: 'content', url: url, method: method, param: { control: 'b650echo' } }, extra || {});
    };
    var idReq = { requirements: { id: '/^[0-9]+$/' }, param: { control: 'b650echo', id: ':id' } };
    add('b650_api',    '/api/foo',          'GET', { requirements: { id: '/^[0-9]+$/' } });
    add('b650_admin',  '/admin/users/:id',  'GET', idReq);
    add('b650_admin2', '/admin2/users/:id', 'GET', idReq);
    add('b650_bar',    '/api/bar',          'GET');
    add('b650_search', '/search',           'GET', { requirements: { q: '/^[a-z]+$/' }, param: { control: 'b650echo', q: ':q' } });
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = [
        '    this.b650echo = function(req, res) {',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || null, getKeys: Object.keys(req.get || {}),',
        '            paramsToString: typeof (req.params && req.params.toString) });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));
}

/** Which rule answered, or null. */
function rule(r) { return (r && r.json && r.json.rule) ? r.json.rule.replace(/@.*$/, '') : null; }
function show(r) { return JSON.stringify({ status: r.status, rule: rule(r), getKeys: r.json && r.json.getKeys, err: r.err || undefined }); }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('24 - container-boot-route-confusion — inherited-name query keys no longer reach a rule through another path (#B650)', function () {

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

        try { installRoutes(); } catch (e) { setupError = 'fixture install failed: ' + (e.message || e); return; }

        var env = readJSON(projectsPath)[PROJ].def_env || 'dev';
        try { bundlePort = readJSON(portsReversePath)[key][env]['http/1.1']['http']; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the http/1.1 http port for ' + key; return; }
        try {
            var ssFile = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json');
            var wr = (fs.readFileSync(ssFile, 'utf8').match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
            webroot = wr.replace(/\/+$/, '') + '/';
        } catch (e) { webroot = '/' + BUNDLE + '/'; }
        if (webroot === '/') { setupError = 'the scaffold webroot must not be "/" — arm 02.2 swaps it'; return; }

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
            var until = Date.now() + 12000;
            while (Date.now() < until && isChildAlive()) { await sleep(150); }
            if (isChildAlive()) {
                // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
                var m = childOut.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
                if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
                try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
            }
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

    // ── 01 controls ───────────────────────────────────────────────────────

    it('01.1  each rule answers on its own path', async function (t) {
        if (!ready(t)) return;
        var r = await get('admin/users/42');
        assert.equal(rule(r), 'b650_admin', show(r));
        r = await get('api/foo');
        assert.equal(rule(r), 'b650_api', show(r));
    });

    it('01.2  another path answers 404 — with no query, and with plain values under the same names', async function (t) {
        if (!ready(t)) return;
        var r = await get('public/users/42');
        assert.equal(r.status, 404, show(r));
        r = await get('public/users/43?toString=1&valueOf=2&toLocaleString=3');
        assert.equal(r.status, 404, show(r));
        assert.deepEqual(r.json && r.json.getKeys, undefined, 'a 404 carries no echo: ' + show(r));
    });

    it('01.3  a rule without requirements ignores crafted keys', async function (t) {
        if (!ready(t)) return;
        var r = await get('xyz/bar' + crafted(K3));
        assert.equal(r.status, 404, show(r));
    });

    it('01.4  a requirement the rule declares still gates a key carried in the query', async function (t) {
        if (!ready(t)) return;
        assert.equal(rule(await get('search?q=abc')), 'b650_search', 'a valid declared key');
        assert.equal((await get('search?q=abd' + '&q2=1')).status, 200, 'an unrelated extra key');
        var bad = await get('search?q=123');
        assert.notEqual(rule(bad), 'b650_search', 'an invalid declared key must not reach the rule: ' + show(bad));
    });

    // ── 02 crafted keys ───────────────────────────────────────────────────

    it('02.1  three keys: /public/users/44 no longer reaches /admin/users/:id (pre-fix: it did)', async function (t) {
        if (!ready(t)) return;
        var r = await get('public/users/44' + crafted(K3));
        assert.equal(r.status, 404, show(r));
    });

    it('02.2  two keys: a path OUTSIDE the webroot no longer reaches the api rule (pre-fix: it did)', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/zzz/api/foo' + crafted(K2));
        assert.notEqual(rule(r), 'b650_api', show(r));
    });

    it('02.3  three keys: /xyz/foo no longer reaches /api/foo (pre-fix: it did)', async function (t) {
        if (!ready(t)) return;
        var r = await get('xyz/foo' + crafted(K3));
        assert.equal(r.status, 404, show(r));
    });

    it('02.4  four keys: /a/b/users/45 no longer reaches /admin/users/:id (pre-fix: it did)', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', '/a/b/users/45' + crafted(K4));
        assert.notEqual(rule(r), 'b650_admin', show(r));
        assert.notEqual(rule(r), 'b650_admin2', show(r));
    });

    // ── 03 req.params ─────────────────────────────────────────────────────

    it('03.1  a match on its own path with crafted keys leaves req.params.toString a function (pre-fix: a string)', async function (t) {
        if (!ready(t)) return;
        // two keys swap only the leading position and the webroot, so no earlier rule can answer
        // this path and the arm isolates the overwrite (three would swap `admin2` too, and the
        // earlier-declared `admin` rule would answer — arm 02.1's confusion, not this one)
        var r = await get('admin2/users/46' + crafted(K2));
        assert.equal(rule(r), 'b650_admin2', 'control: the rule answers on its own path: ' + show(r));
        assert.deepEqual(r.json.getKeys.filter(function (k) { return K2.indexOf(k) > -1; }).sort(), K2.slice().sort(),
            'the crafted keys must reach req.get (the query parser keeps them): ' + show(r));
        assert.equal(r.json.paramsToString, 'function', show(r) + ' ' + r.body);
    });
});
