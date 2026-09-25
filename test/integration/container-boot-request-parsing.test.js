/**
 * #B588 / #B589 / #B590 / #B591 / #B592 — real-bytes request parsing through a
 * booted bundle.
 *
 * The unit files pin the helper and the source; this one boots the REAL
 * `bin/gina-container` against a scaffolded project carrying a GET+POST `/echo`
 * route that renders what the framework handed the action, and drives it over
 * HTTP/1.1 on the default engine (isaac):
 *
 *   01  urlencoded bodies — an encoded &/=/% inside a value is data, decoded once
 *   02  GET queries — a value whose text holds %0A/%22/%25 keeps every parameter;
 *       an HTML-form bracket key still nests (isaac now decodes keys)
 *   03  logs — a malformed body / a not-JSON query value leave no content in the log
 *   04  the result object's prototype is never swapped
 *   05  the bundle survives every #B591 shape (inheritedData, a bracket GET key,
 *       a urlencoded field, a multipart field name) — these run LAST, because
 *       pre-fix the inheritedData one EXITS the process (exit 143)
 *
 * Isolation: the container-boot-init-failure.test.js shape — a throwaway HOME
 * under os.tmpdir(), its own port window (9850; init-failure uses 9800,
 * container-boot 9700), project:rm + rmSync at teardown. Seam:
 * `B588_GINA_ROOT=<tree>` boots THAT tree's launcher against a project scaffolded
 * by THAT tree's CLI (red-first against the main tree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-request-parsing.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-rp-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'rp' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 9850;

var BOOT_TIMEOUT_MS  = 25000;
var POLL_INTERVAL_MS = 250;

var GINA_ROOT = process.env.B588_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

var FORM = 'application/x-www-form-urlencoded';


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

function request(method, reqPath, body, headers) {
    var lib = (scheme === 'https') ? https : http;
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method,
            headers: headers || {}, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json });
            });
        });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null }); });
        if (body != null) { req.write(body); }
        req.end();
    });
}

function get(rawQuery)             { return request('GET',  webroot + 'echo?' + rawQuery); }
function post(body, contentType)   { return request('POST', webroot + 'echo', body, { 'content-type': contentType, 'content-length': Buffer.byteLength(body) }); }
function multipart(fields) {
    var boundary = '----ginaB588' + STAMP;
    var body = '';
    fields.forEach(function (f) {
        body += '--' + boundary + '\r\nContent-Disposition: form-data; name="' + f[0] + '"\r\n\r\n' + f[1] + '\r\n';
    });
    body += '--' + boundary + '--\r\n';
    return request('POST', webroot + 'echo', body, { 'content-type': 'multipart/form-data; boundary=' + boundary, 'content-length': Buffer.byteLength(body) });
}

function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** The liveness probe every attack arm ends with: the process is up AND a control GET answers. */
async function assertAlive(label) {
    await sleep(150);
    assert.ok(isChildAlive(), label + ': the bundle process must survive — exit: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1500));
    var ctl = await get('x=plain&y=1');
    assert.equal(ctl.status, 200, label + ': the control GET must still answer');
    assert.deepEqual(ctl.json.get, { x: 'plain', y: '1' });
}

/** Adds the echo route + action to the scaffold (the same shape as the live harness). */
function installEchoRoute() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.echo_get  = { namespace: 'content', url: '/echo', method: 'GET',  param: { control: 'echo' } };
    r.echo_post = { namespace: 'content', url: '/echo', method: 'POST', param: { control: 'echo' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var action = [
        '    this.echo = function(req, res) {',
        '        var show = function (v) { return (typeof v === "undefined") ? "__undefined__" : v; };',
        '        var keys = function (v) { return (v && typeof v === "object") ? Object.keys(v) : null; };',
        '        var protoOk = function (v) { return (v && typeof v === "object") ? (Object.getPrototypeOf(v) === Object.prototype) : null; };',
        '        self.renderJSON({ method: req.method, get: show(req.get), getKeys: keys(req.get), post: show(req.post), postKeys: keys(req.post), postProtoOk: protoOk(req.post), getProtoOk: protoOk(req.get) });',
        '    };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, action + anchor));
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('22 - container-boot-request-parsing — urlencoded and query parsing through a booted bundle (#B588 #B589 #B590 #B591 #B592)', function () {

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

        try { installEchoRoute(); } catch (e) { setupError = 'echo route install failed: ' + (e.message || e); return; }

        var pe = readJSON(projectsPath)[PROJ], env = pe.def_env || 'dev', proto = pe.def_protocol;
        scheme = pe.def_scheme || 'http';
        try { bundlePort = readJSON(portsReversePath)[key][env][proto][scheme]; } catch (e) { bundlePort = null; }
        if (!bundlePort) { setupError = 'could not resolve the bound port for ' + key; return; }
        try {
            var ssj = fs.readFileSync(path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'settings.server.json'), 'utf8');
            var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + BUNDLE);
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

    // ── 01 urlencoded bodies ──────────────────────────────────────────────

    it('01.1  P1/P6/P9 — an encoded &, = or % inside a value is data, decoded once', async function (t) {
        if (!ready(t)) return;
        var r = await post('field=a%26b&other=1', FORM);
        assert.equal(r.status, 200); assert.deepEqual(r.json.post, { field: 'a&b', other: '1' });
        r = await post('field=a%3Db&other=1', FORM);
        assert.deepEqual(r.json.post, { field: 'a=b', other: '1' });
        r = await post('field=100%2525&other=1', FORM);
        assert.deepEqual(r.json.post, { field: '100%25', other: '1' });
    });

    it('01.2  P3/P4 — a value can no longer add or override another field; a genuine later field still wins', async function (t) {
        if (!ready(t)) return;
        var r = await post('role=user&bio=hi%26role%3Dadmin', FORM);
        assert.deepEqual(r.json.post, { role: 'user', bio: 'hi&role=admin' });
        r = await post('bio=hi%26role%3Dadmin&role=user', FORM);
        assert.deepEqual(r.json.post, { bio: 'hi&role=admin', role: 'user' });
    });

    it('01.3  P2/P7/P8/P5 controls — space, plus, literal +, and an application/json body verbatim', async function (t) {
        if (!ready(t)) return;
        assert.deepEqual((await post('field=a%20b&other=1', FORM)).json.post, { field: 'a b', other: '1' });
        assert.deepEqual((await post('field=a%2Bb&other=1', FORM)).json.post, { field: 'a+b', other: '1' });
        assert.deepEqual((await post('field=a+b&other=1', FORM)).json.post,   { field: 'a b', other: '1' });
        assert.deepEqual((await post('{"field":"a&b","other":"1"}', 'application/json')).json.post, { field: 'a&b', other: '1' });
    });

    it('01.4  P11/P12/P13 — bare tokens stay strings, nesting is unchanged, quoted tokens keep their quotes', async function (t) {
        if (!ready(t)) return;
        assert.deepEqual((await post('a=true&b=false&c=on&d=null&e=TRUE', FORM)).json.post, { a: 'true', b: 'false', c: 'on', d: 'null', e: 'TRUE' });
        assert.deepEqual((await post('user%5Bname%5D=Alice&b%5B%5D=x&b%5B%5D=y&k&z=', FORM)).json.post, { user: { name: 'Alice' }, b: { '': 'y' }, z: '' });
        assert.deepEqual((await post('a=%22true%22&b=1', FORM)).json.post, { a: '"true"', b: '1' });
    });

    it('01.5  a hand-built body with RAW quotes keeps them and still nests (the value http-methods §19d asserts)', async function (t) {
        if (!ready(t)) return;
        var r = await post('user[name]=Ada&user[age]=37&ok="true"', FORM);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.post, { user: { name: 'Ada', age: '37' }, ok: '"true"' });
    });

    it('01.6  D4 — an encoded & or = inside a KEY is data: a key can no longer override a field', async function (t) {
        if (!ready(t)) return;
        var r = await post('role=user&a%26role%3Dadmin=x', FORM);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.post, { role: 'user', 'a&role=admin': 'x' });
    });

    it('01.7  D1 — a JSON value inside a field keeps its own types: a quoted "true" stays a string', async function (t) {
        if (!ready(t)) return;
        var r = await post('f=%7B%22t%22%3A%22true%22%2C%22b%22%3Atrue%7D&y=1', FORM);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.post, { f: { t: 'true', b: true }, y: '1' });
    });

    // ── 02 GET queries ────────────────────────────────────────────────────

    it('02.1  G1/G2/G3 — a value whose text holds %0A, %22 or %25 keeps every parameter, verbatim', async function (t) {
        if (!ready(t)) return;
        var r = await get('x=line%20%250A%20break&y=1');
        assert.equal(r.status, 200); assert.deepEqual(r.json.get, { x: 'line %0A break', y: '1' });
        r = await get('x=say%20%2522hi%2522&y=1');
        assert.deepEqual(r.json.get, { x: 'say %22hi%22', y: '1' });
        r = await get('x=100%2525%20sure&y=1');
        assert.deepEqual(r.json.get, { x: '100%25 sure', y: '1' });
    });

    it('02.2  G4/G5/G6/G9 — plain values, an HTML-form bracket key (isaac decodes keys now), coercion and last-wins are unchanged', async function (t) {
        if (!ready(t)) return;
        assert.deepEqual((await get('x=plain&y=1')).json.get, { x: 'plain', y: '1' });
        assert.deepEqual((await get('user%5Bname%5D=Alice&y=1')).json.get, { user: { name: 'Alice' }, y: '1' });
        assert.deepEqual((await get('a=true&b=false&c=on&d=null&e=TRUE')).json.get, { a: true, b: false, c: true, d: null, e: true });
        assert.deepEqual((await get('a=1&a=2&b%5B%5D=x&b%5B%5D=y')).json.get, { a: '2', b: { '': 'y' } });
        assert.deepEqual((await get('f=%7B%22active%22%3A1%7D&y=1')).json.get, { f: { active: 1 }, y: '1' }, 'a JSON value still unwraps');
    });

    it('02.3  D5 — a + in a query KEY is a space on isaac too (express\'s qs already did so); an encoded %2B keeps its plus', async function (t) {
        if (!ready(t)) return;
        assert.deepEqual((await get('a+b=1&y=1')).json.get, { 'a b': '1', y: '1' });
        assert.deepEqual((await get('a%2Bb=1&y=1')).json.get, { 'a+b': '1', y: '1' });
    });

    // ── 03 logs ───────────────────────────────────────────────────────────

    it('03.1  #B590 — a malformed non-JSON-labelled body is answered 500 and the log carries no content', async function (t) {
        if (!ready(t)) return;
        var mark = childOut.length;
        var r = await post('{"user":"u","password":"hunter2-B590"', 'text/plain');
        assert.equal(r.status, 500);
        await sleep(300);
        var tail = childOut.slice(mark);
        assert.ok(tail.indexOf('[365] could not parse body') > -1, 'the metadata line is logged:\n' + tail.slice(-800));
        assert.ok(tail.indexOf('hunter2-B590') < 0, 'the body must not reach the log:\n' + tail.slice(-800));
    });

    it('03.2  #B590 — a not-JSON {-leading query value is delivered as a string and the isaac warn carries no content', async function (t) {
        if (!ready(t)) return;
        var mark = childOut.length;
        var r = await get('f=%7Bnot-json-SECRET-B590&y=1');
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.get, { f: '{not-json-SECRET-B590', y: '1' });
        await sleep(300);
        var tail = childOut.slice(mark);
        assert.ok(tail.indexOf('Could not convert to JSON or Array') > -1, 'the warn is logged:\n' + tail.slice(-800));
        assert.ok(tail.indexOf('SECRET-B590') < 0, 'the value must not reach the log:\n' + tail.slice(-800));
    });

    // ── 04 prototype ──────────────────────────────────────────────────────

    it('04.1  #B592 — a __proto__ pair never swaps the request object\'s prototype (urlencoded and query)', async function (t) {
        if (!ready(t)) return;
        var r = await post('__proto__=%7B%22polluted%22%3A1%7D&a=1', FORM);
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.postKeys, ['a']);
        assert.equal(r.json.postProtoOk, true, 'req.post must keep Object.prototype');
        r = await get('__proto__=%7B%22polluted%22%3A1%7D&a=1');
        assert.equal(r.json.getProtoOk, true, 'req.get must keep Object.prototype');
        assert.deepEqual((await get('x=plain&y=1')).json.get, { x: 'plain', y: '1' }, 'the next request is unaffected');
    });

    // ── 05 #B591 — LAST: pre-fix the inheritedData arm exits the process ──

    it('05.1  #B591 — a urlencoded field named 0[a] nests and answers 200 (was 500)', async function (t) {
        if (!ready(t)) return;
        var r = await post('0%5Ba%5D=1&other=1', FORM);
        assert.equal(r.status, 200, 'got ' + r.status + ' ' + r.body.slice(0, 200));
        assert.deepEqual(r.json.post, { '0': { a: '1' }, other: '1' });
        await assertAlive('05.1');
    });

    it('05.2  #B591 — a multipart text field named 0[a] nests and answers 200; the process survives', async function (t) {
        if (!ready(t)) return;
        var r = await multipart([ ['0[a]', '1'], ['other', '1'] ]);
        assert.equal(r.status, 200, 'got ' + r.status + ' ' + r.body.slice(0, 200));
        assert.deepEqual(r.json.post, { '0': { a: '1' }, other: '1' });
        await assertAlive('05.2');
    });

    it('05.3  #B591 — a GET bracket key 0[a] (decoded by isaac now) nests; the process survives', async function (t) {
        if (!ready(t)) return;
        var r = await get('0%5Ba%5D=1&y=1');
        assert.equal(r.status, 200);
        assert.deepEqual(r.json.get, { '0': { a: '1' }, y: '1' });
        await assertAlive('05.3');
    });

    it('05.4  #B591 — GET ?inheritedData=0%5Ba%5D%3D1 answers 200 and the bundle SURVIVES (pre-fix: exit 143)', async function (t) {
        if (!ready(t)) return;
        var r = await get('inheritedData=0%5Ba%5D%3D1&y=1');
        assert.equal(r.status, 200, 'got ' + r.status + ' — exit: ' + JSON.stringify(childExit));
        assert.deepEqual(r.json.get, { y: '1', '0': { a: '1' } });
        await assertAlive('05.4');
    });
});
