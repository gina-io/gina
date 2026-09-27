/**
 * #P46 S6 A — the cold routing loop's candidate index, through a booted bundle.
 *
 * The unit file (test/core/server-route-candidates.test.js) proves the index is a superset
 * of what the loop accepts, over one copy of the loop and the real `compareUrls`. This one
 * boots the REAL `bin/gina-container` (isaac, the default engine, the default http/1.1
 * protocol) and sends the requests over HTTP, so the index runs where the engine calls it,
 * over the routing table config.js builds (webroot prefixed, comma urls normalised,
 * framework-injected rules included). Arms:
 *
 *   01  the right rule answers for each shape the index classifies differently: a static
 *       path, a parameter, an inline parameter (`page:number`), a rule with two requirements
 *       not bound in its url (evaluated for every request), and a generic rule declared last
 *       that an earlier specific rule must still beat
 *   02  prototype-named paths — `/constructor`, `/toString`, `/__proto__`, `/hasOwnProperty`,
 *       inside and outside the webroot — answer 404 promptly (a plain-object index resolves
 *       inherited members and throws; the lookup sits outside any try in the engine, so a
 *       throw would leave the request without an answer)
 *   03  a path no rule can match answers 404 (the empty-set fast path)
 *
 * The same answers hold before the index is wired (the full scan gives them); this file
 * pins that they still hold once it is. Every arm uses its own path, because the warm route
 * cache is keyed by method + path.
 *
 * Isolation: the container-boot-route-confusion.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (9600; route-method uses 9900, route-confusion 9950),
 * project:rm + rmSync at teardown. Seam: `P46_GINA_ROOT=<tree>` boots THAT tree's launcher
 * against a project scaffolded by THAT tree's CLI.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-route-candidates.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-p46-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'p46' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 9600;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;
var PROMPT_MS        = 5000;

var GINA_ROOT = process.env.P46_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, webroot = '/' + BUNDLE;
var child = null, childOut = '', childExit = null;


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
 * One HTTP/1.1 request on a fresh connection; `absPath` starts with `/`. `ms` is the time
 * the answer may take — past it the request is destroyed and reported as `timeout`.
 */
function request(method, absPath, ms) {
    var started = Date.now();
    return new Promise(function (resolve) {
        var req = http.request({ host: '127.0.0.1', port: bundlePort, path: absPath, method: method, agent: false }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json, ms: Date.now() - started });
            });
        });
        req.setTimeout(ms || 15000, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null, ms: Date.now() - started }); });
        req.end();
    });
}

/** A request on a path under the bundle's webroot. */
function get(p, ms) { return request('GET', webroot + p, ms); }

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** The fixture rules; every one runs the same echo action. Declaration order is deliberate. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var add = function (name, url, extra) {
        r[name] = Object.assign({ namespace: 'content', url: url, method: 'GET', param: { control: 'p46echo' } }, extra || {});
    };
    add('p46_static', '/p46/static/a');
    add('p46_item',   '/p46/items/:id', { requirements: { id: '/^[0-9]+$/' }, param: { control: 'p46echo', id: ':id' } });
    // no requirement: an inline parameter captures the WHOLE segment (#B646), so a numeric
    // requirement would reject `page3` — the arm pins that the index keeps the rule, not that bug
    add('p46_inline', '/p46/articles/page:number', { param: { control: 'p46echo', number: ':number' } });
    add('p46_two',    '/p46/two', { requirements: { q: '/^[a-z]+$/', r: '/^[a-z]+$/' }, param: { control: 'p46echo', q: ':q', r: ':r' } });
    add('p46_ctor',   '/p46/constructor');
    add('p46_generic', '/p46/:x/:y', { param: { control: 'p46echo', x: ':x', y: ':y' } });   // a :key matches only once `param` declares it
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = [
        '    this.p46echo = function(req, res) {',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || null });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));
}

/** Which rule answered, or null. */
function rule(r) { return (r && r.json && r.json.rule) ? r.json.rule.replace(/@.*$/, '') : null; }
function show(r) { return JSON.stringify({ status: r.status, rule: rule(r), ms: r.ms, err: r.err || undefined }); }


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('25 - container-boot-route-candidates — the candidate index answers as the full scan does (#P46)', function () {

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

    // ── 01 the right rule answers ─────────────────────────────────────────

    it('01.1  a static path, a parameter and an inline parameter reach their rules', async function (t) {
        if (!ready(t)) return;
        var r = await get('p46/static/a');
        assert.equal(rule(r), 'p46_static', show(r));
        r = await get('p46/items/42');
        assert.equal(rule(r), 'p46_item', show(r));
        r = await get('p46/articles/page3');
        assert.equal(rule(r), 'p46_inline', show(r));
    });

    it('01.2  a rule with two requirements not bound in its url still answers for a query carrying both', async function (t) {
        if (!ready(t)) return;
        var r = await get('p46/two?q=abc&r=def');
        assert.equal(rule(r), 'p46_two', show(r));
    });

    it('01.3  a static rule named like an Object.prototype member answers on its own path', async function (t) {
        if (!ready(t)) return;
        var r = await get('p46/constructor');
        assert.equal(rule(r), 'p46_ctor', show(r));
    });

    it('01.4  the generic rule declared last answers what no earlier rule matches, and loses to them', async function (t) {
        if (!ready(t)) return;
        var r = await get('p46/foo/bar');
        assert.equal(rule(r), 'p46_generic', show(r));
        r = await get('p46/items/43');
        assert.equal(rule(r), 'p46_item', 'the earlier specific rule still wins: ' + show(r));
    });

    // ── 02 prototype-named paths ──────────────────────────────────────────

    it('02.1  prototype-named paths answer 404 promptly, inside and outside the webroot', async function (t) {
        if (!ready(t)) return;
        var paths = ['/constructor', '/toString', '/__proto__', '/hasOwnProperty', webroot + 'toString', webroot + '__proto__/x'];
        for (var i = 0; i < paths.length; i++) {
            var r = await request('GET', paths[i], PROMPT_MS);
            assert.equal(r.status, 404, paths[i] + ' ' + show(r));
        }
    });

    // ── 03 unmatched paths ────────────────────────────────────────────────

    it('03.1  a path no rule can match answers 404', async function (t) {
        if (!ready(t)) return;
        var r = await get('p46/nothing/here/at/all', PROMPT_MS);
        assert.equal(r.status, 404, show(r));
    });

});
