/**
 * #B953 — a top-level JSON array body reaches the action as the array, on the first request to a path
 * and on every later one, in a booted bundle.
 *
 * processRequestData parses a `[`-leading POST or PATCH body into an array and makes it `req.post` /
 * `req.patch`, the same object as `req.body`. Before 0.7.6 the routing loop matched on an
 * `Object.assign` copy of that bag, which keys an array by index, while the warm route cache (keyed by
 * the concrete path) served every later request without the copy. So the first request to each path
 * got `{ "0": …, "1": … }`, a separate object from `req.body`, and the next one the array itself; and
 * a `true` URL segment beside an array body was a boolean on the first request only. Since 0.7.6 the
 * bag is the array on every request, `req.body` is that array, and the URL placeholders sit on it as
 * named properties with the 0.7.6 coercion, except under the names the array answers for itself
 * (`length`, its methods), whose values stay in `req.params`.
 *
 * The scene: one bundle, an echo action answering what reaches it — the bag (`req[method]`), whether
 * it is an array, its own non-index keys, its `length` and `typeof .map`, whether `req.body` IS the
 * bag, and `req.params` minus the engine's `0`. The requests run in `before()`, in order, so each
 * path's first request is the cold one and the next the warm one.
 *
 *   01  controls that hold on both sides of the fix: a PUT array body (processRequestData merges it
 *       into an object keyed by index, on every request) and a POST object body
 *   02  the array on every request: POST (`application/json`, and unlabelled), POST and PATCH with
 *       placeholders, and a new path on a rule already warm
 *   03  the URL placeholders on the array, cold and warm
 *   04  a `true` segment beside an array body: a boolean in the bag and in req.params, cold and warm
 *   05  placeholders named `length` and `map`: the array keeps its own, the values are in req.params
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-param-precedence-b954.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (14100), project:rm + rmSync at teardown. Seam:
 * `B953_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-array-bag-b953.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b953-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'ab' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 14100;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;

var GINA_ROOT = process.env.B953_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

var ARR  = '[{"a":"1"},2]';
var OBJ  = '{"id":"99","x":"1"}';
var JSON_TYPE = 'application/json';

// [rule name, url, method]
var RULES = [
    ['b953_post',       '/b953-post',                'POST'],
    ['b953_post_bare',  '/b953-post-bare',           'POST'],
    ['b953_post_p',     '/b953-post-p/:grp/:id',     'POST'],
    ['b953_patch_p',    '/b953-patch-p/:grp/:id',    'PATCH'],
    ['b953_flag',       '/b953-flag/:grp/:flag',     'POST'],
    ['b953_patch_flag', '/b953-patch-flag/:grp/:flag', 'PATCH'],
    ['b953_len',        '/b953-len/:grp/:length',    'POST'],
    ['b953_map',        '/b953-map/:grp/:map',       'POST'],
    ['b953_put_p',      '/b953-put-p/:grp/:id',      'PUT'],
    ['b953_obj_p',      '/b953-obj-p/:grp/:id',      'POST']
];

// [label, method, path under the webroot, body, content type] — sent in this order, once each
var ARMS = [
    // 01 controls
    ['put.cold',        'PUT',   'b953-put-p/g1/42',       ARR, JSON_TYPE],
    ['put.warm',        'PUT',   'b953-put-p/g1/42',       ARR, JSON_TYPE],
    ['obj.cold',        'POST',  'b953-obj-p/g1/42',       OBJ, JSON_TYPE],
    ['obj.warm',        'POST',  'b953-obj-p/g1/42',       OBJ, JSON_TYPE],
    // 02 / 03 the array on every request, with and without placeholders
    ['post.cold',       'POST',  'b953-post',              ARR, JSON_TYPE],
    ['post.warm',       'POST',  'b953-post',              ARR, JSON_TYPE],
    ['bare.cold',       'POST',  'b953-post-bare',         ARR, null],
    ['bare.warm',       'POST',  'b953-post-bare',         ARR, null],
    ['postp.cold',      'POST',  'b953-post-p/g1/42',      ARR, JSON_TYPE],
    ['postp.warm',      'POST',  'b953-post-p/g1/42',      ARR, JSON_TYPE],
    ['postp.newpath',   'POST',  'b953-post-p/g1/43',      ARR, JSON_TYPE],
    ['patchp.cold',     'PATCH', 'b953-patch-p/g1/42',     ARR, JSON_TYPE],
    ['patchp.warm',     'PATCH', 'b953-patch-p/g1/42',     ARR, JSON_TYPE],
    // 04 a `true` segment
    ['flag.cold',       'POST',  'b953-flag/g1/true',      ARR, JSON_TYPE],
    ['flag.warm',       'POST',  'b953-flag/g1/true',      ARR, JSON_TYPE],
    ['patchflag.cold',  'PATCH', 'b953-patch-flag/g1/true', ARR, JSON_TYPE],
    ['patchflag.warm',  'PATCH', 'b953-patch-flag/g1/true', ARR, JSON_TYPE],
    // 05 the array's own names
    ['len.cold',        'POST',  'b953-len/g1/5',          ARR, JSON_TYPE],
    ['len.warm',        'POST',  'b953-len/g1/5',          ARR, JSON_TYPE],
    ['map.cold',        'POST',  'b953-map/g1/world',      ARR, JSON_TYPE],
    ['map.warm',        'POST',  'b953-map/g1/world',      ARR, JSON_TYPE]
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
 * The `param` of a rule: the echo control, and each `:placeholder` of its url bound to itself.
 *
 * @inner
 * @param {string} url - the rule's url
 * @returns {object} the rule's `param`
 */
function paramOf(url) {
    var p = { control: 'b953Echo' };
    (url.match(/:[a-z]+/g) || []).forEach(function (k) { p[k.slice(1)] = k; });
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
        '    this.b953Echo = function(req, res) {',
        '        var m = String(req.method || "get").toLowerCase(), bag = req[m];',
        '        var named = function (o) { if (o === null || typeof(o) != "object") { return null; } var r = {}; Object.keys(o).forEach(function (k) { if (!/^[0-9]+$/.test(k)) { r[k] = o[k]; } }); return r; };',
        '        self.renderJSON({ method: req.method, bag: (typeof(bag) == "undefined") ? "__undefined__" : bag, bagIsArray: Array.isArray(bag), bagNamed: named(bag),',
        '            bagLength: (bag && typeof(bag) == "object" && "length" in bag) ? bag.length : null, bagMapType: (bag && typeof(bag) == "object") ? typeof(bag.map) : null,',
        '            bodyIsArray: Array.isArray(req.body), bodyIsBag: (req.body === bag), params: named(req.params) });',
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
// 01 – 05 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-array-bag — a top-level JSON array body is the array on every request (#B953)', function () {

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

    it('01.1  CONTROL — a PUT array body is an object keyed by index on both requests, and req.body is it', async function (t) {
        if (!ready(t)) return;
        ['put.cold', 'put.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, false, label);
            assert.deepEqual(e.bag, { 0: { a: '1' }, 1: 2, grp: 'g1', id: '42' }, label);
            assert.equal(e.bodyIsBag, true, label);
        });
    });

    it('01.2  CONTROL — a POST object body: the URL value wins over the body key, the same on both requests', async function (t) {
        if (!ready(t)) return;
        var cold = echoOf('obj.cold'), warm = echoOf('obj.warm');
        assert.deepEqual(cold.bag, { id: '42', x: '1', grp: 'g1' });
        assert.deepEqual(warm, cold);
        assert.equal(cold.bodyIsBag, true);
    });

    // ── 02 the array on every request ───────────────────────────────────────

    [
        ['POST, application/json',          'post'],
        ['POST, no content type',           'bare'],
        ['POST with placeholders',          'postp'],
        ['PATCH with placeholders',         'patchp']
    ].forEach(function (row, n) {
        it('02.' + (n + 1) + '  ' + row[0] + ' — the bag is the parsed array on the first request and on the next one, and req.body is it', async function (t) {
            if (!ready(t)) return;
            var cold = echoOf(row[1] + '.cold'), warm = echoOf(row[1] + '.warm');
            assert.equal(cold.bagIsArray, true, 'cold: the bag is an array');
            assert.deepEqual(cold.bag, [{ a: '1' }, 2], 'cold: its elements');
            assert.equal(cold.bodyIsBag, true, 'cold: req.body is the bag');
            assert.equal(cold.bodyIsArray, true, 'cold: req.body is the array');
            assert.deepEqual(warm, cold, 'the warm request gets the same');
        });
    });

    it('02.5  a new path on a rule already warm gets the array too', async function (t) {
        if (!ready(t)) return;
        var e = echoOf('postp.newpath');
        assert.equal(e.bagIsArray, true);
        assert.deepEqual(e.bag, [{ a: '1' }, 2]);
        assert.equal(e.bodyIsBag, true);
        assert.deepEqual(e.bagNamed, { grp: 'g1', id: '43' });
    });

    // ── 03 the URL placeholders on the array ────────────────────────────────

    it('03.1  the URL placeholders are named properties of the array, and in req.params, cold and warm', async function (t) {
        if (!ready(t)) return;
        ['postp.cold', 'postp.warm', 'patchp.cold', 'patchp.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, true, label);
            assert.deepEqual(e.bagNamed, { grp: 'g1', id: '42' }, label);
            assert.deepEqual(e.params, { grp: 'g1', id: '42' }, label);
            assert.equal(e.bagLength, 2, label);
        });
    });

    // ── 04 a `true` segment ─────────────────────────────────────────────────

    it('04.1  a `true` segment beside an array body is a boolean in the bag and in req.params, on POST and PATCH, cold and warm', async function (t) {
        if (!ready(t)) return;
        ['flag.cold', 'flag.warm', 'patchflag.cold', 'patchflag.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, true, label);
            assert.strictEqual(e.bagNamed.flag, true, label + ': the bag');
            assert.strictEqual(e.params.flag, true, label + ': req.params');
        });
    });

    // ── 05 the array's own names ────────────────────────────────────────────

    it('05.1  a placeholder named `length`: the array keeps its length, the value is in req.params', async function (t) {
        if (!ready(t)) return;
        ['len.cold', 'len.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, true, label);
            assert.equal(e.bagLength, 2, label + ': the array\'s own length');
            assert.deepEqual(e.bag, [{ a: '1' }, 2], label);
            assert.equal(e.params.length, '5', label + ': req.params');
        });
    });

    it('05.2  a placeholder named `map`: the array keeps its method, the value is in req.params', async function (t) {
        if (!ready(t)) return;
        ['map.cold', 'map.warm'].forEach(function (label) {
            var e = echoOf(label);
            assert.equal(e.bagIsArray, true, label);
            assert.equal(e.bagMapType, 'function', label + ': the array\'s own method');
            assert.equal(e.params.map, 'world', label + ': req.params');
        });
    });
});
