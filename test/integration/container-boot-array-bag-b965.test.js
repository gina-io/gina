/**
 * #B965 — a URL placeholder named with digits only stays out of a top-level JSON array body, on the first
 * request to a path and on every later one, in a booted bundle.
 *
 * Since #B953 a top-level JSON array body is `req.post` / `req.patch` (the same object as `req.body`) on
 * every request. On a warm route-cache hit that bag is the array the request arrived with, and the router's
 * fill (lib/routing writes a URL value where the bag has none of that name) made a placeholder named with
 * digits only an element past the array's end: rule `/…/:grp/:5`, body `[{"a":"1"},2]` — the first request
 * got the array at length 2, every later one at length 6 with 3 holes and the URL value as element 5. Since
 * 0.7.6 the array keeps its arrival length on every request, and that value is in `req.params` only.
 *
 * The scene: one bundle, an echo action answering what reaches it — whether the bag (`req[method]`) is an
 * array, its own keys, its `length`, how many holes it has, whether `req.body` IS the bag, and
 * `req.params`. The requests run in `before()`, in order, so each path's first request is the cold one and
 * the next ones the warm route-cache path.
 *
 *   01  controls that hold on both sides of the fix: an index inside the array (`:1`), and an object body
 *       beside `:5`
 *   02  `:5` beside an array body, POST (three requests) and PATCH: the array at its arrival length on
 *       every request, the URL value in `req.params`
 *
 * Every request carries a client timeout, so a failing run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-array-bag-b953.test.js shape — a throwaway HOME under os.tmpdir(), its own
 * port window (14150), project:rm + rmSync at teardown. Seam: `B965_GINA_ROOT=<tree>` boots THAT tree's
 * launcher against a project scaffolded by THAT tree's CLI (red-first against a pre-fix tree, zero
 * shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-array-bag-b965.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b965-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ad' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14150;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;

var GINA_ROOT = process.env.B965_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

var ARR  = '[{"a":"1"},2]';
var OBJ  = '{"a":"1","id":"99"}';
var JSON_TYPE = 'application/json';

// [rule name, url, method]
var RULES = [
    ['b965_post',  '/b965-post/:grp/:5',  'POST'],
    ['b965_patch', '/b965-patch/:grp/:5', 'PATCH'],
    ['b965_in',    '/b965-in/:grp/:1',    'POST'],
    ['b965_obj',   '/b965-obj/:grp/:5',   'POST']
];

// [label, method, path under the webroot, body, content type] — sent in this order, once each
var ARMS = [
    // 01 controls
    ['in.cold',     'POST',  'b965-in/g1/x',    ARR, JSON_TYPE],
    ['in.warm',     'POST',  'b965-in/g1/x',    ARR, JSON_TYPE],
    ['obj.cold',    'POST',  'b965-obj/g1/x',   OBJ, JSON_TYPE],
    ['obj.warm',    'POST',  'b965-obj/g1/x',   OBJ, JSON_TYPE],
    // 02 `:5` beside an array body
    ['post.cold',   'POST',  'b965-post/g1/x',  ARR, JSON_TYPE],
    ['post.warm',   'POST',  'b965-post/g1/x',  ARR, JSON_TYPE],
    ['post.warm2',  'POST',  'b965-post/g1/x',  ARR, JSON_TYPE],
    ['patch.cold',  'PATCH', 'b965-patch/g1/x', ARR, JSON_TYPE],
    ['patch.warm',  'PATCH', 'b965-patch/g1/x', ARR, JSON_TYPE]
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
 * One request with a client timeout: an unanswered request resolves with
 * `{ status: null, err: 'timeout' }` instead of waiting forever.
 *
 * @inner
 * @param {string} method - the HTTP method
 * @param {string} reqPath - path including the webroot
 * @param {string|null} body - the request body, or null
 * @param {string|null} contentType - the content type, or null for none
 * @returns {Promise<object>} `{ status, headers, body, json }` or `{ status: null, err }`
 */
function request(method, reqPath, body, contentType) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var headers = {};
        if (body != null) { headers['content-length'] = Buffer.byteLength(body); }
        if (contentType) { headers['content-type'] = contentType; }
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, headers: headers, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: data, json: json });
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, headers: {}, body: '', json: null }); });
        if (body != null) { req.write(body); }
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
 * The `param` of a rule: the echo control, and each `:placeholder` of its url bound to itself (digits
 * included, as lib/routing reads them).
 *
 * @inner
 * @param {string} url - the rule's url
 * @returns {object} the rule's `param`
 */
function paramOf(url) {
    var p = { control: 'b965Echo' };
    (url.match(/:[-_a-z0-9]+/g) || []).forEach(function (k) { p[k.slice(1)] = k; });
    return p;
}

/** Adds the rules and the echo action this file drives to the scaffold. */
function installScene() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    RULES.forEach(function (rule) {
        r[rule[0]] = { namespace: 'content', url: rule[1], method: rule[2], param: paramOf(rule[1]) };
    });
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b965Echo = function(req, res) {',
        '        var m = String(req.method || "get").toLowerCase(), bag = req[m], holes = 0;',
        '        if (Array.isArray(bag)) { for (var i = 0; i < bag.length; i++) { if (!Object.prototype.hasOwnProperty.call(bag, i)) { holes++; } } }',
        '        var params = {}; Object.keys(req.params || {}).forEach(function (k) { if (k !== "0") { params[k] = req.params[k]; } });',
        '        self.renderJSON({ method: req.method, bagIsArray: Array.isArray(bag), bagKeys: (bag && typeof(bag) == "object") ? Object.keys(bag) : null,',
        '            bagLength: (bag && typeof(bag) == "object" && "length" in bag) ? bag.length : null, holes: holes,',
        '            bag5: (bag && typeof(bag) == "object" && "5" in bag) ? bag["5"] : null, bodyIsBag: (req.body === bag), params: params });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/**
 * The echo of an arm, asserted to be a 200 JSON answer from the echo action.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {object} the echo
 */
function echoOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 200, label + ': expected 200 from the echo action (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 300) + ')');
    assert.ok(a.json && Object.prototype.hasOwnProperty.call(a.json, 'bagIsArray'), label + ': expected the echo action\'s answer');
    return a.json;
}


// ---------------------------------------------------------------------------
// 01 – 02 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-array-bag — a digits-only placeholder stays out of an array body on every request (#B965)', function () {

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

        // every arm, in order: a path's first request is its cold one, the next its warm one
        for (var i = 0; i < ARMS.length; i++) {
            answers[ARMS[i][0]] = await request(ARMS[i][1], webroot + ARMS[i][2], ARMS[i][3], ARMS[i][4]);
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

    // ── 01 controls: hold on both sides of the fix ──────────────────────────

    it('01.1  CONTROL — an index inside the array (`:1`): the array at length 2, no holes, the value in req.params, cold and warm', async function (t) {
        if (!ready(t)) return;
        ['in.cold', 'in.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, true, label);
            assert.equal(e.bagLength, 2, label);
            assert.equal(e.holes, 0, label);
            assert.deepEqual(e.bagKeys, ['0', '1', 'grp'], label);
            assert.equal(e.params['1'], 'x', label + ': req.params');
            assert.equal(e.bodyIsBag, true, label);
        });
    });

    it('01.2  CONTROL — an object body beside `:5`: the URL value is the bag\'s key 5, the same on both requests', async function (t) {
        if (!ready(t)) return;
        var cold = echoOf('obj.cold'), warm = echoOf('obj.warm');
        assert.equal(cold.bagIsArray, false);
        assert.equal(cold.bag5, 'x');
        assert.deepEqual(warm, cold);
    });

    // ── 02 `:5` beside an array body ────────────────────────────────────────

    [
        ['POST, three requests', ['post.cold', 'post.warm', 'post.warm2']],
        ['PATCH, two requests',  ['patch.cold', 'patch.warm']]
    ].forEach(function (row, n) {
        it('02.' + (n + 1) + '  ' + row[0] + ' — the array keeps its arrival length on every request; the URL value is in req.params only', async function (t) {
            if (!ready(t)) return;
            var first = echoOf(row[1][0]);
            row[1].forEach(function (label) {
                var e = echoOf(label);
                assert.equal(e.bagIsArray, true, label + ': the bag is the array');
                assert.equal(e.bagLength, 2, label + ': its arrival length (0.7.6 develop before #B965: 6 on a warm request)');
                assert.equal(e.holes, 0, label + ': no holes');
                assert.deepEqual(e.bagKeys, ['0', '1', 'grp'], label + ': its elements and the named placeholder');
                assert.equal(e.bag5, null, label + ': no element 5');
                assert.equal(e.params['5'], 'x', label + ': the value is in req.params');
                assert.equal(e.bodyIsBag, true, label + ': req.body is the bag');
                assert.deepEqual(e, first, label + ': the same as the first request');
            });
        });
    });
});
