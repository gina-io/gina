/**
 * #B1146, #B1148, #B692, #B1154 — in a booted bundle, a rule whose URL segment made the route matcher
 * throw no longer stops the route loop, and a matcher that still throws answers the request once.
 *
 * lib/routing threw on three segment shapes: a `:` with no name after it (`/t/12:`, #B1146), a segment
 * that is not a valid regular expression (`/rx/:id)`, #B1148), and, on a rule with requirements, a
 * segment holding two placeholders reached through a decodable %-escape (`/shop/item-:sku-:lang` and
 * `/shop/item-1%202-fr`, #B692). The route loop of core/server.js answered each throw with a 500 naming
 * the rule and tried no later rule; it then ran its 404 as well, which logged a second error line, with
 * a ref of its own, for the same request (#B1154). The matcher no longer throws on these shapes, and a
 * matcher that still throws (a requirement that is not a valid regular expression) answers 500 once.
 *
 * The scene: one bundle, an echo action answering the rule that reached it and its `req.params` (own
 * data properties only), behind these rules, in this order:
 *   t_lone  `/t/12:`                                        then  t_any    `/t/:any`
 *   rx_bad  `/rx/:id)`                                      then  rx_any   `/rx/:any`
 *   sku_two `/shop/item-:sku-:lang` (requirements on both)  then  sku_any  `/shop/:any`
 *   req_bad `/req/:id`, its requirement `/^[0-9+$/` (a `]` missing)
 *   ok      `/ok`
 *
 *   01  controls that hold on both sides of the fix: `/ok` answers; `/t/12:` as written answers from
 *       t_lone; `/shop/item-12-fr`, without an escape, answers from sku_any
 *   02  #B1146: `/t/12x` answers from t_any, and no line « needs your attention » is logged for it
 *   03  #B1148: `/rx/42` answers from rx_bad itself, its placeholder taking the whole segment
 *   04  #B692: `/shop/item-1%202-fr` answers from sku_any
 *   05  #B1154: `/req/42` answers 500, the bundle logs a « GET [ 500 ] » line and no « GET [ 404 ] »
 *       line for it, and the bundle still answers `/ok`
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-delete-partial-b956.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14850), project:rm + rmSync at teardown. Seam:
 * `B1154_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's CLI
 * (red-first against a pre-fix tree, zero shared-tree touch): 02, 03, 04 and 05.1 red; 01 and 05.2
 * green.
 *
 * Run standalone:
 *   node --test test/integration/container-boot-route-throws-b1154.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b1154-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rt' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14850;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;
var LOG_SETTLE_MS      = 300;
var LOG_WAIT_MS        = 3000;

var GINA_ROOT = process.env.B1154_GINA_ROOT || path.resolve(__dirname, '../..');
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
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, rejectUnauthorized: false, agent: false
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
 * The lines of a log slice that hold `needle`, counted once per line: a JSON log line carries its
 * message twice (`message` and `msg`).
 *
 * @inner
 * @param {string} log - a slice of the bundle's output
 * @param {RegExp} needle
 * @returns {number}
 */
function linesWith(log, needle) {
    return log.split('\n').filter(function (l) { return needle.test(l); }).length;
}

/** Adds the rules and the echo action this file drives to the scaffold. */
function installScene() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var add = function (name, url, extra) {
        r[name] = Object.assign({ namespace: 'content', url: url, method: 'GET', param: { control: 'b1154Echo' } }, extra || {});
    };
    add('b1154_t_lone',  '/t/12:');
    add('b1154_t_any',   '/t/:any',  { param: { control: 'b1154Echo', any: ':any' } });
    add('b1154_rx_bad',  '/rx/:id)', { param: { control: 'b1154Echo', id: ':id' } });
    add('b1154_rx_any',  '/rx/:any', { param: { control: 'b1154Echo', any: ':any' } });
    add('b1154_sku_two', '/shop/item-:sku-:lang', { requirements: { sku: '/^[0-9]+$/', lang: '/^[a-z]{2}$/' }, param: { control: 'b1154Echo', sku: ':sku', lang: ':lang' } });
    add('b1154_sku_any', '/shop/:any', { param: { control: 'b1154Echo', any: ':any' } });
    add('b1154_req_bad', '/req/:id', { requirements: { id: '/^[0-9+$/' }, param: { control: 'b1154Echo', id: ':id' } });
    add('b1154_ok',      '/ok');
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b1154Echo = function(req, res) {',
        '        var p = {}; if (req.params) { Object.keys(req.params).forEach(function (k) { if (k !== "0") { p[k] = req.params[k]; } }); }',
        '        self.renderJSON({ rule: (req.routing && req.routing.rule) || null, params: p });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/**
 * Requests `GET reqPath` once (memoised per path and tag) and returns the answer with the slice of the
 * bundle's output written while it was served: after the answer the slice is read until `waitFor`
 * holds (at most LOG_WAIT_MS), then once more after LOG_SETTLE_MS.
 *
 * @inner
 * @param {string} reqPath - path under the webroot, without the leading webroot
 * @param {object} [opts]
 * @param {string} [opts.tag] - a memo key suffix, to request the same path twice
 * @param {RegExp} [opts.waitFor] - a line the slice must hold before it is read
 * @returns {Promise<{status: (number|null), err: (string|null), body: string, json: (object|null), rule: (string|null), log: string}>}
 */
async function drive(reqPath, opts) {
    opts = opts || {};
    var key = reqPath + '#' + (opts.tag || '');
    if (drives[key]) { return drives[key]; }
    var from = childOut.length;
    var r = await request('GET', webroot + reqPath);
    if (opts.waitFor) {
        var until = Date.now() + LOG_WAIT_MS;
        while (Date.now() < until && linesWith(childOut.slice(from), opts.waitFor) === 0) { await sleep(50); }
    }
    await sleep(LOG_SETTLE_MS);
    var rule = (r.json && r.json.rule) ? String(r.json.rule).replace(/@.*$/, '') : null;
    drives[key] = { status: r.status, err: r.err || null, body: r.body, json: r.json, rule: rule, log: childOut.slice(from) };
    return drives[key];
}

/** The echo answer of a drive, asserted to be a 200 JSON answer from the action. */
function echoOf(d, label) {
    assert.equal(d.status, 200, label + ': expected 200 from the echo action (got ' + d.status + ': ' + String(d.err || d.body || '').slice(0, 300) + ')');
    assert.ok(d.json && typeof(d.json.params) == 'object', label + ': expected the echo JSON — got ' + String(d.body).slice(0, 300));
    return d.json;
}

var ATTENTION = /needs your attention/;


// ---------------------------------------------------------------------------
// 01 – 05 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-route-throws — a rule that made the matcher throw stops no route loop, and a throw answers once (#B1146, #B1148, #B692, #B1154)', function () {

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

    it('01.1  CONTROL — /ok answers from its rule', async function (t) {
        if (!ready(t)) return;
        var d = await drive('ok');
        echoOf(d, 'ok');
        assert.equal(d.rule, 'b1154_ok');
    });

    it('01.2  CONTROL — /t/12: as written answers from the nameless rule', async function (t) {
        if (!ready(t)) return;
        var d = await drive('t/12:');
        echoOf(d, 't/12:');
        assert.equal(d.rule, 'b1154_t_lone');
    });

    it('01.3  CONTROL — /shop/item-12-fr, without an escape, answers from the rule after the two-placeholder one', async function (t) {
        if (!ready(t)) return;
        var d = await drive('shop/item-12-fr');
        echoOf(d, 'shop/item-12-fr');
        assert.equal(d.rule, 'b1154_sku_any');
    });

    // ── 02 #B1146 ────────────────────────────────────────────────────────────

    it('02.1  #B1146 — /t/12x answers from the rule after the nameless one, and nothing « needs your attention »', async function (t) {
        if (!ready(t)) return;
        var d = await drive('t/12x');
        var e = echoOf(d, 't/12x');
        assert.equal(d.rule, 'b1154_t_any');
        assert.deepEqual(e.params, { any: '12x' });
        assert.equal(linesWith(d.log, ATTENTION), 0, 'no « needs your attention » line for this request: ' + d.log.slice(0, 600));
    });

    // ── 03 #B1148 ────────────────────────────────────────────────────────────

    it('03.1  #B1148 — /rx/42 answers from the /rx/:id) rule itself, its placeholder taking the whole segment', async function (t) {
        if (!ready(t)) return;
        var d = await drive('rx/42');
        var e = echoOf(d, 'rx/42');
        assert.equal(d.rule, 'b1154_rx_bad');
        assert.deepEqual(e.params, { id: '42' });
        assert.equal(linesWith(d.log, ATTENTION), 0, 'no « needs your attention » line for this request: ' + d.log.slice(0, 600));
    });

    // ── 04 #B692 ─────────────────────────────────────────────────────────────

    it('04.1  #B692 — /shop/item-1%202-fr answers from the rule after the two-placeholder one', async function (t) {
        if (!ready(t)) return;
        var d = await drive('shop/item-1%202-fr');
        echoOf(d, 'shop/item-1%202-fr');
        assert.equal(d.rule, 'b1154_sku_any');
        assert.equal(linesWith(d.log, ATTENTION), 0, 'no « needs your attention » line for this request: ' + d.log.slice(0, 600));
    });

    // ── 05 #B1154 ────────────────────────────────────────────────────────────

    it('05.1  #B1154 — a matcher that still throws answers 500 once: a « GET [ 500 ] » line, no « GET [ 404 ] » line', async function (t) {
        if (!ready(t)) return;
        var p500 = new RegExp('GET \\[ ?500 ?\\] ' + webroot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'req/42');
        var p404 = new RegExp('GET \\[ ?404 ?\\] ' + webroot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + 'req/42');
        var d = await drive('req/42', { waitFor: p500 });
        assert.equal(d.status, 500, 'expected 500 (got ' + d.status + ': ' + String(d.err || d.body || '').slice(0, 300) + ')');
        assert.ok(linesWith(d.log, p500) >= 1, 'control: the 500 must be logged (the log capture works): ' + d.log.slice(0, 600));
        assert.equal(linesWith(d.log, p404), 0, 'no second answer (404) may be logged for the same request: ' + d.log.slice(0, 1200));
    });

    it('05.2  CONTROL — the bundle still answers /ok afterwards', async function (t) {
        if (!ready(t)) return;
        var d = await drive('ok', { tag: 'end' });
        echoOf(d, 'ok (end)');
        assert.equal(d.rule, 'b1154_ok');
    });
});
