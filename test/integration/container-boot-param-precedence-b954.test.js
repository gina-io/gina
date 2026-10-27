/**
 * #B954 / #B957 — a URL placeholder's value wins over a query or body key of the same name, on the
 * first request to a METHOD:PATH and on every later one, in a booted bundle.
 *
 * A route declares `/b954-<kind>/:grp/:id`; the client sends `?id=99` or `{ "id": "99" }` while the
 * URL carries `43`. Before 0.7.6 the answer depended on the request:
 *  - the first request to a METHOD:PATH (the routing loop's match) copied `req.params` over the
 *    method's bag on GET, HEAD, PUT and PATCH, so the URL value won there; the warm route cache served
 *    every later request without that copy, and the router fills the bag only where the client sent
 *    no key of that name, so the client's value won from the second request on (#B957);
 *  - POST had no copy at all; on DELETE the URL value won only when a regex requirement covered the
 *    placeholder (#B954);
 *  - `req.body`, which processRequestData makes the same object as `req.post` / `req.put` /
 *    `req.patch`, was a separate object holding the client's keys on the first request only.
 * Since 0.7.6 a block after the routing loop copies `req.params` over the bag the action reads on
 * every matched request, with the loop's coercion of 'false' / 'true' / 'on', and points `req.body`
 * back at the bag when it was the bag before routing.
 *
 * The scene: one bundle, an echo action answering what reaches it (`req[method]`, `req.params`
 * minus the engine's `0`, `req.body`, and whether `req.body` IS the bag), in its JSON body and in
 * an `x-b954-echo` header (a HEAD answer has no body). The requests run in `before()`, in order, so
 * each path's first request is the cold one and the next the warm one.
 *
 *   01  controls that hold on both sides of the fix
 *   02  a same-name key, cold then warm, per method (the URL value wins on both)
 *   03  a warm request carrying the key after a cold one without it
 *   04  the 'true' segment coerced to a boolean, cold and warm, and on DELETE with a query string;
 *       a 'null' segment left the string 'null' (the loop's coercion is 'false' / 'true' / 'on')
 *   05  req.body is the bag on PUT, PATCH and POST, cold and warm; left alone on an empty body
 *   06  where the client's value stays readable: req.originalUrl (GET), req.query (DELETE),
 *       req.rawBody (PUT, PATCH, POST) — controls that hold on both sides of the fix
 *
 * Every request carries a client timeout, so a pre-fix run FAILS instead of hanging the suite.
 *
 * Isolation: the container-boot-delete-partial-b956.test.js shape — a throwaway HOME under
 * os.tmpdir(), its own port window (13970), project:rm + rmSync at teardown. Seam:
 * `B954_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded by THAT tree's
 * CLI (red-first against a pre-fix tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-param-precedence-b954.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b954-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'pp' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 13970;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;

var GINA_ROOT = process.env.B954_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;
var answers = {};

var BODY = '{"id":"99","x":"1"}';

// [label, method, path under the webroot, JSON body or null] — sent in this order, once each
var ARMS = [
    // 01 controls
    ['ctl.nokey',     'GET',    'b954-get/g5/46?x=1',        null],
    ['ctl.reject',    'GET',    'b954-get/g1/notanumber',    null],
    // 02 a same-name key: the first request to the path (cold), then the next (warm)
    ['get.cold',      'GET',    'b954-get/g2/43?id=99',      null],
    ['get.warm',      'GET',    'b954-get/g2/43?id=99',      null],
    ['head.cold',     'HEAD',   'b954-get/g3/43?id=99',      null],
    ['head.warm',     'HEAD',   'b954-get/g3/43?id=99',      null],
    ['put.cold',      'PUT',    'b954-put/g2/43',            BODY],
    ['put.warm',      'PUT',    'b954-put/g2/43',            BODY],
    ['patch.cold',    'PATCH',  'b954-patch/g2/43',          BODY],
    ['patch.warm',    'PATCH',  'b954-patch/g2/43',          BODY],
    ['post.cold',     'POST',   'b954-post/g2/43',           BODY],
    ['post.warm',     'POST',   'b954-post/g2/43',           BODY],
    ['delreq.cold',   'DELETE', 'b954-del-req/g2/43?id=99',  null],
    ['delreq.warm',   'DELETE', 'b954-del-req/g2/43?id=99',  null],
    ['delnoreq.cold', 'DELETE', 'b954-del-noreq/g2/43?id=99', null],
    ['delnoreq.warm', 'DELETE', 'b954-del-noreq/g2/43?id=99', null],
    ['delval.cold',   'DELETE', 'b954-del-val/g2/43?id=99',  null],
    ['delval.warm',   'DELETE', 'b954-del-val/g2/43?id=99',  null],
    // 03 the key arrives on the warm request only
    ['getlate.cold',  'GET',    'b954-get/g4/43',            null],
    ['getlate.warm',  'GET',    'b954-get/g4/43?id=99',      null],
    ['putlate.cold',  'PUT',    'b954-put/g4/43',            '{"x":"1"}'],
    ['putlate.warm',  'PUT',    'b954-put/g4/43',            BODY],
    // 04 coercion of a 'true' segment
    ['coerce.cold',   'GET',    'b954-get-noreq/true/7',     null],
    ['coerce.warm',   'GET',    'b954-get-noreq/true/7',     null],
    ['delcoerce',     'DELETE', 'b954-del-req/true/7?x=1',   null],
    ['nullseg.cold',  'GET',    'b954-get/null/7',           null],
    ['nullseg.warm',  'GET',    'b954-get/null/7',           null],
    // 05 an empty POST body: req.body was never the bag
    ['postempty',     'POST',   'b954-post/g6/43',           null]
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
 * @param {string|null} body - a JSON body, or null
 * @returns {Promise<object>} `{ status, headers, body }` or `{ status: null, err }`
 */
function request(method, reqPath, body) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var headers = body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {};
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method, headers: headers, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () { resolve({ status: res.statusCode, headers: res.headers, body: data }); });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, headers: {}, body: '' }); });
        if (body) { req.write(body); }
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

/** Adds the rules and the echo action this file drives to the scaffold. */
function installScene() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    var REQ   = { grp: '/^[a-z0-9]+$/', id: '/^[0-9]+$/' };
    var PARAM = function () { return { control: 'b954Echo', grp: ':grp', id: ':id' }; };
    r.b954_get       = { namespace: 'content', url: '/b954-get/:grp/:id',       method: 'GET',    requirements: REQ, param: PARAM() };
    r.b954_get_noreq = { namespace: 'content', url: '/b954-get-noreq/:grp/:id', method: 'GET',                       param: PARAM() };
    r.b954_put       = { namespace: 'content', url: '/b954-put/:grp/:id',       method: 'PUT',    requirements: REQ, param: PARAM() };
    r.b954_patch     = { namespace: 'content', url: '/b954-patch/:grp/:id',     method: 'PATCH',  requirements: REQ, param: PARAM() };
    r.b954_post      = { namespace: 'content', url: '/b954-post/:grp/:id',      method: 'POST',   requirements: REQ, param: PARAM() };
    r.b954_del_req   = { namespace: 'content', url: '/b954-del-req/:grp/:id',   method: 'DELETE', requirements: REQ, param: PARAM() };
    r.b954_del_noreq = { namespace: 'content', url: '/b954-del-noreq/:grp/:id', method: 'DELETE',                    param: PARAM() };
    r.b954_del_val   = { namespace: 'content', url: '/b954-del-val/:grp/:id',   method: 'DELETE', requirements: { grp: '/^[a-z0-9]+$/', id: 'validator::{ isInteger: true }' }, param: PARAM() };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b954Echo = function(req, res) {',
        '        var m = String(req.method || "get").toLowerCase();',
        '        var own = function (o) { if (o === null || typeof(o) != "object") { return null; } var r = {}; Object.keys(o).forEach(function (k) { if (k !== "0" && typeof(o[k]) != "function") { r[k] = o[k]; } }); return r; };',
        '        var out = { method: req.method, bag: own(req[m]), params: own(req.params), body: own(req.body), bodyIsBag: (req.body === req[m]), query: own(req.query), rawBody: (typeof(req.rawBody) == "string") ? req.rawBody : null, originalUrl: (typeof(req.originalUrl) == "string") ? req.originalUrl : null };',
        '        res.setHeader("x-b954-echo", encodeURIComponent(JSON.stringify(out)));',
        '        self.renderJSON(out);',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}

/**
 * The echo of an arm, read from the `x-b954-echo` header (a HEAD answer has no body), asserted to
 * be a 200 answer from the echo action.
 *
 * @inner
 * @param {string} label - an ARMS label
 * @returns {object} `{ method, bag, params, body, bodyIsBag }`
 */
function echoOf(label) {
    var a = answers[label];
    assert.ok(a, label + ': the arm was not sent');
    assert.equal(a.status, 200, label + ': expected 200 from the echo action (got ' + a.status + ': ' + String(a.err || a.body || '').slice(0, 300) + ')');
    var h = a.headers && a.headers['x-b954-echo'];
    assert.ok(h, label + ': expected the x-b954-echo header from the action');
    return JSON.parse(decodeURIComponent(h));
}


// ---------------------------------------------------------------------------
// 01 – 05 — boot arms
// ---------------------------------------------------------------------------

describe('container-boot-param-precedence — the URL value wins over a same-name client key, cold and warm (#B954, #B957)', function () {

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
            answers[ARMS[i][0]] = await request(ARMS[i][1], webroot + ARMS[i][2], ARMS[i][3]);
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

    it('01.1  CONTROL — without a same-name key, the URL values and the query key all reach req.get', async function (t) {
        if (!ready(t)) return;
        var e = echoOf('ctl.nokey');
        assert.equal(e.bag.grp, 'g5');
        assert.equal(e.bag.id, '46');
        assert.ok(Object.prototype.hasOwnProperty.call(e.bag, 'x'), 'the query key reaches req.get');
        assert.deepEqual(e.params, { grp: 'g5', id: '46' });
    });

    it('01.2  CONTROL — a value a requirement rejects answers 404 and never reaches the action', async function (t) {
        if (!ready(t)) return;
        var a = answers['ctl.reject'];
        assert.equal(a.status, 404, 'expected 404 (got ' + a.status + ')');
        assert.equal(a.headers['x-b954-echo'], undefined, 'the echo action must not have answered');
    });

    it('01.3  CONTROL — the first GET with a same-name key already took the URL value (unchanged)', async function (t) {
        if (!ready(t)) return;
        assert.equal(echoOf('get.cold').bag.id, '43');
    });

    it('01.4  CONTROL — a DELETE route whose regex requirements cover its placeholders already took the URL value (unchanged)', async function (t) {
        if (!ready(t)) return;
        assert.equal(echoOf('delreq.cold').bag.id, '43');
        assert.equal(echoOf('delreq.warm').bag.id, '43');
    });

    // ── 02 a same-name key, cold then warm ──────────────────────────────────

    [
        ['GET',               'get'],
        ['HEAD',              'head'],
        ['PUT',               'put'],
        ['PATCH',             'patch'],
        ['POST',              'post'],
        ['DELETE, regex',     'delreq'],
        ['DELETE, no requirement', 'delnoreq'],
        ['DELETE, validator::',    'delval']
    ].forEach(function (row, n) {
        it('02.' + (n + 1) + '  ' + row[0] + ' — the URL value wins on the first request and on the next one; req.params holds it', async function (t) {
            if (!ready(t)) return;
            var cold = echoOf(row[1] + '.cold'), warm = echoOf(row[1] + '.warm');
            assert.equal(cold.bag.id, '43', 'cold: the bag the action reads');
            assert.equal(warm.bag.id, '43', 'warm: the bag the action reads');
            assert.equal(cold.params.id, '43', 'cold: req.params.id');
            assert.equal(warm.params.id, '43', 'warm: req.params.id');
        });
    });

    it('02.9  the other body key reaches the bag on PUT, PATCH and POST, cold and warm', async function (t) {
        if (!ready(t)) return;
        ['put', 'patch', 'post'].forEach(function (m) {
            assert.equal(echoOf(m + '.cold').bag.x, '1', m + ' cold');
            assert.equal(echoOf(m + '.warm').bag.x, '1', m + ' warm');
        });
    });

    // ── 03 the key arrives on the warm request only ─────────────────────────

    it('03.1  GET — a warm request carrying the key after a cold one without it reads the URL value', async function (t) {
        if (!ready(t)) return;
        assert.equal(echoOf('getlate.cold').bag.id, '43', 'control: the cold request carried no key');
        assert.equal(echoOf('getlate.warm').bag.id, '43');
    });

    it('03.2  PUT — the same', async function (t) {
        if (!ready(t)) return;
        assert.equal(echoOf('putlate.cold').bag.id, '43', 'control: the cold request carried no key');
        assert.equal(echoOf('putlate.warm').bag.id, '43');
    });

    // ── 04 coercion ─────────────────────────────────────────────────────────

    it('04.1  a "true" segment is the boolean true in the bag and in req.params, cold and warm', async function (t) {
        if (!ready(t)) return;
        var cold = echoOf('coerce.cold'), warm = echoOf('coerce.warm');
        assert.strictEqual(cold.bag.grp, true, 'cold bag');
        assert.strictEqual(warm.bag.grp, true, 'warm bag');
        assert.strictEqual(cold.params.grp, true, 'cold req.params');
        assert.strictEqual(warm.params.grp, true, 'warm req.params');
    });

    it('04.2  DELETE with a query string — the "true" segment is coerced too', async function (t) {
        if (!ready(t)) return;
        var e = echoOf('delcoerce');
        assert.strictEqual(e.bag.grp, true);
        assert.equal(e.bag.x, '1', 'control: the query key stays a string');
    });

    it('04.3  a "null" segment stays the string "null" in the bag and in req.params, cold and warm', async function (t) {
        if (!ready(t)) return;
        var cold = echoOf('nullseg.cold'), warm = echoOf('nullseg.warm');
        assert.strictEqual(cold.bag.grp, 'null', 'cold bag');
        assert.strictEqual(warm.bag.grp, 'null', 'warm bag');
        assert.strictEqual(cold.params.grp, 'null', 'cold req.params');
        assert.strictEqual(warm.params.grp, 'null', 'warm req.params');
    });

    // ── 05 req.body ─────────────────────────────────────────────────────────

    it('05.1  PUT, PATCH, POST — req.body IS the bag, holding the URL value, cold and warm', async function (t) {
        if (!ready(t)) return;
        ['put', 'patch', 'post'].forEach(function (m) {
            ['cold', 'warm'].forEach(function (w) {
                var e = echoOf(m + '.' + w);
                assert.equal(e.bodyIsBag, true, m + ' ' + w + ': req.body === req.' + m);
                assert.equal(e.body.id, '43', m + ' ' + w + ': req.body.id');
            });
        });
    });

    it('05.2  CONTROL — an empty POST body: req.body was never the bag and stays apart; the bag holds the URL values', async function (t) {
        if (!ready(t)) return;
        var e = echoOf('postempty');
        assert.equal(e.bodyIsBag, false);
        assert.deepEqual(e.bag, { grp: 'g6', id: '43' });
    });

    // ── 06 where the client's value stays readable (the documented escape hatches) ──

    it('06.1  GET — the client\'s value stays in req.originalUrl', async function (t) {
        if (!ready(t)) return;
        var e = echoOf('get.warm');
        assert.ok(e.originalUrl && e.originalUrl.indexOf('id=99') > -1, 'req.originalUrl: ' + e.originalUrl);
    });

    it('06.2  DELETE — the client\'s value stays in req.query', async function (t) {
        if (!ready(t)) return;
        assert.equal(echoOf('delnoreq.warm').query.id, '99');
    });

    it('06.3  PUT, PATCH, POST — the client\'s value stays in req.rawBody', async function (t) {
        if (!ready(t)) return;
        ['put', 'patch', 'post'].forEach(function (m) {
            assert.equal(echoOf(m + '.warm').rawBody, BODY, m);
        });
    });
});
