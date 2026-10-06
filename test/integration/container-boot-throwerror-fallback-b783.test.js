/**
 * #B783 — an XHR request answered through `throwError(err)` with `err.fallback`
 * must get a response.
 *
 * `throwError()` marks the controller as processing an error, then hands an
 * error that carries a `fallback` to `redirect()`. Before the fix the mark was
 * still set when `redirect()` answered an XHR request: its two JSON exits (the
 * request carries params, or it comes from a popin) go through `renderJSON()`,
 * which writes nothing while the controller is processing an error, so the
 * request was never answered. A non-XHR request was unaffected, because that
 * exit writes the 30x itself.
 *
 *   01  source pin — the mark is cleared inside the fallback interception,
 *       before either hand-off to redirect()
 *   02  boot arms over HTTP/1.1 on the default engine:
 *       - controls that must answer on both sides of the fix: the target route,
 *         redirect() without a prior throwError (XHR exit and popin exit), and
 *         the fallback on the exits that write the 30x themselves
 *       - the defect: POST, PUT and GET XHR requests with params, and a popin
 *         request, each answered with the `isXhrRedirect` JSON
 *       - #B794: redirect() classifies an absolute URL on a dot-less host
 *         (`http://localhost:<port>/…`) as a URL, not as a route name, so a
 *         direct redirect to it and a route-object fallback (whose `toUrl()` is
 *         such a URL on a localhost bundle) answer instead of a 404
 *
 * Every request carries a client timeout, so a pre-fix run FAILS on the
 * defect arms instead of hanging the suite.
 *
 * Isolation: the container-boot-request-parsing.test.js shape — a throwaway
 * HOME under os.tmpdir(), its own port window (11300), project:rm + rmSync at
 * teardown. Seam: `B783_GINA_ROOT=<tree>` boots THAT tree's launcher against a
 * project scaffolded by THAT tree's CLI, and the §01 pin reads THAT tree's
 * controller (red-first against a pre-fix worktree, zero shared-tree touch).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-throwerror-fallback-b783.test.js
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
var FAKE_HOME  = path.join(os.tmpdir(), 'gina-b783-home-' + STAMP);
var GINA_HOME  = path.join(FAKE_HOME, '.gina');
var PROJ       = 'fb' + STAMP;
var BUNDLE     = 'web';
var PROJ_DIR   = path.join(FAKE_HOME, 'proj');
var PORT_START = 11300;

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 5000;

var GINA_ROOT = process.env.B783_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

var skip = false, skipReason = '', setupError = null;
var bundlePort = null, scheme = 'http', webroot = '/' + BUNDLE + '/';
var child = null, childOut = '', childExit = null;

var FORM = 'application/x-www-form-urlencoded';
var XHR  = { 'x-requested-with': 'XMLHttpRequest' };


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolves the controller source of the tree under test — the test/fw.js
 * rule (the framework dir named by package.json's version), applied to the
 * seam tree.
 *
 * @inner
 * @returns {string} absolute path to that tree's core/controller/controller.js
 */
function controllerSource() {
    var version = JSON.parse(fs.readFileSync(path.join(GINA_ROOT, 'package.json'), 'utf8')).version;
    return path.join(GINA_ROOT, 'framework', 'v' + version, 'core', 'controller', 'controller.js');
}

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
 * @param {string} method - HTTP method
 * @param {string} reqPath - path including the webroot
 * @param {string|null} body - urlencoded body, or null for none
 * @param {object} [headers] - extra request headers
 * @returns {Promise<object>} `{ status, body, json, location }` or `{ status: null, err }`
 */
function request(method, reqPath, body, headers) {
    var lib = (scheme === 'https') ? https : http;
    var h = Object.assign({}, headers || {});
    if (body != null) { h['content-type'] = FORM; h['content-length'] = Buffer.byteLength(body); }
    return new Promise(function (resolve) {
        var req = lib.request({
            host: '127.0.0.1', port: bundlePort, path: reqPath, method: method,
            headers: h, rejectUnauthorized: false
        }, function (res) {
            var data = '';
            res.on('data', function (c) { data += c; });
            res.on('end', function () {
                var json = null;
                try { json = JSON.parse(data); } catch (e) { /* not JSON */ }
                resolve({ status: res.statusCode, body: data, json: json, location: res.headers.location || null });
            });
        });
        req.setTimeout(REQUEST_TIMEOUT_MS, function () { req.destroy(new Error('timeout')); });
        req.on('error', function (e) { resolve({ status: null, err: e.message, body: '', json: null, location: null }); });
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
 * Asserts the request was answered with redirect()'s XHR JSON.
 *
 * @inner
 * @param {object} r - result of request()
 * @param {string} label - arm label for the messages
 * @returns {object} the parsed JSON body
 */
function assertXhrRedirect(r, label) {
    assert.notEqual(r.status, null, label + ': the request was never answered (' + r.err + ')');
    assert.equal(r.status, 200, label + ': expected the 200 isXhrRedirect answer, got ' + r.status + ' ' + r.body.slice(0, 200));
    assert.ok(r.json && r.json.isXhrRedirect === true, label + ': the body is not the isXhrRedirect JSON: ' + r.body.slice(0, 200));
    return r.json;
}

/** Adds the target route and the actions this file drives to the scaffold. */
function installRoutes() {
    var rf = path.join(PROJ_DIR, 'src', BUNDLE, 'config', 'routing.json');
    var cf = path.join(PROJ_DIR, 'src', BUNDLE, 'controllers', 'controller.content.js');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    r.b783_target = { namespace: 'content', url: '/target', method: 'GET',            param: { control: 'b783Target' } };
    r.b783_fbstr  = { namespace: 'content', url: '/fb-str', method: 'GET, POST, PUT', param: { control: 'b783FbStr' } };
    r.b783_redir  = { namespace: 'content', url: '/redir',  method: 'GET, POST',      param: { control: 'b783Redir' } };
    r.b783_fbrte  = { namespace: 'content', url: '/fb-rte', method: 'GET, POST',      param: { control: 'b783FbRte' } };
    r.b794_abs    = { namespace: 'content', url: '/abs',    method: 'GET',            param: { control: 'b794Abs' } };
    r.b794_dotted = { namespace: 'content', url: '/abs-dotted', method: 'GET',        param: { control: 'b794AbsDotted' } };
    r.b794_name   = { namespace: 'content', url: '/to-name', method: 'GET',           param: { control: 'b794ToName' } };
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = [
        '    this.b783Target = function(req, res) { self.renderJSON({ landed: true, method: req.method, get: req.get }); };',
        '    this.b783FbStr  = function(req, res) { var e = new Error("b783 boom"); e.fallback = "' + webroot + 'target"; return self.throwError(e); };',
        '    this.b783Redir  = function(req, res) { return self.redirect("' + webroot + 'target", true); };',
        '    this.b783FbRte  = function(req, res) { var e = new Error("b783 boom"); e.fallback = require("gina").lib.routing.getRoute("b783_target@' + BUNDLE + '"); return self.throwError(e); };',
        '    this.b794Abs       = function(req, res) { return self.redirect("http://localhost:' + bundlePort + webroot + 'target"); };',
        '    this.b794AbsDotted = function(req, res) { return self.redirect("http://127.0.0.1:' + bundlePort + webroot + 'target"); };',
        '    this.b794ToName    = function(req, res) { return self.redirect("b794-no-such-route"); };',
        ''
    ].join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + anchor));
}


// ---------------------------------------------------------------------------
// 01 — source pin
// ---------------------------------------------------------------------------

describe('01 - source pin: the error mark is cleared before the fallback hand-off (#B783)', function () {

    it('01.1 the fallback interception clears isProcessingError before either redirect() hand-off', function () {
        var raw   = fs.readFileSync(controllerSource(), 'utf8');
        var start = raw.indexOf('// fallback interception');
        var end   = raw.indexOf('// allowing this.throwError(err)', start);
        assert.ok(start > -1 && end > start, 'the fallback interception anchors are gone');
        var region = raw.slice(start, end);
        // controls: the region is the one this pin means
        assert.equal(region.split('return self.redirect(').length - 1, 2,
            'the fallback interception no longer holds its two redirect() hand-offs');
        // code only: a comment naming the assignment must not satisfy the pin
        var code = region.split('\n').map(function (l) { return l.replace(/(^|\s)\/\/.*$/, ''); }).join('\n');
        var clear = code.indexOf('self.isProcessingError = false');
        assert.ok(clear > -1, 'nothing clears isProcessingError inside the fallback interception');
        assert.ok(clear < code.indexOf('return self.redirect('),
            'isProcessingError is cleared after a redirect() hand-off, too late for it');
    });

    it('01.2 #B794 — the absolute-URL classifier accepts a dot-less host and still rejects route names and paths', function () {
        var raw   = fs.readFileSync(controllerSource(), 'utf8');
        var head  = '    var isValidURL = function(url){';
        var start = raw.indexOf(head);
        assert.ok(start > -1, 'the isValidURL declaration is gone');
        var end   = raw.indexOf('\n    }\n', start);
        assert.ok(end > start, 'the end of isValidURL was not found');
        var isValidURL = new Function(raw.slice(start, end + 6) + '\nreturn isValidURL;')();
        // controls: what the classifier accepted and refused before #B794 must not move
        assert.equal(isValidURL('https://example.com/a?b=1'), true,  'a dotted host must stay a URL');
        assert.equal(isValidURL('http://127.0.0.1:3100/x'),   true,  'an IPv4 host must stay a URL');
        assert.equal(isValidURL('home'),                      false, 'a route name must not become a URL');
        assert.equal(isValidURL('settings@account'),          false, 'a cross-bundle route name must not become a URL');
        assert.equal(isValidURL('/dashboard'),                false, 'a relative path must not become a URL');
        assert.equal(isValidURL('http:/broken'),              false, 'a malformed URL must not become a URL');
        // the defect: a host without a dot
        assert.equal(isValidURL('http://localhost:3100/web/target'), true, 'a localhost URL is not classified as a URL');
        assert.equal(isValidURL('http://localhost'),                 true, 'a bare localhost URL is not classified as a URL');
        assert.equal(isValidURL('https://api-svc:8443/v1?x=1'),      true, 'a single-label host is not classified as a URL');
        assert.equal(isValidURL('http://[::1]:3100/x'),              true, 'a bracketed IPv6 host is not classified as a URL');
    });
});


// ---------------------------------------------------------------------------
// 02 — boot arms
// ---------------------------------------------------------------------------

describe('02 - container-boot-throwerror-fallback — an XHR request answered through a throwError fallback (#B783)', function () {

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

        try { installRoutes(); } catch (e) { setupError = 'route install failed: ' + (e.message || e); return; }

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

    // ── controls: answered on both sides of the fix ─────────────────────────

    it('02.1  CONTROL — the target route answers (the harness can observe an answer)', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', webroot + 'target');
        assert.equal(r.status, 200, 'the target route did not answer: ' + (r.err || r.body.slice(0, 200)));
        assert.equal(r.json && r.json.landed, true);
    });

    it('02.2  CONTROL — redirect() without a prior throwError answers an XHR POST with params', async function (t) {
        if (!ready(t)) return;
        var json = assertXhrRedirect(await request('POST', webroot + 'redir', 'a=1', XHR), 'redirect() XHR exit');
        assert.ok(String(json.location).indexOf(webroot + 'target') === 0, 'unexpected location: ' + json.location);
    });

    it('02.3  CONTROL — redirect() without a prior throwError answers a popin request', async function (t) {
        if (!ready(t)) return;
        var json = assertXhrRedirect(await request('POST', webroot + 'redir', null, Object.assign({ 'x-gina-popin-id': 'p1' }, XHR)), 'redirect() popin exit');
        assert.ok(json.popin && String(json.popin.url).indexOf(webroot + 'target') === 0, 'unexpected popin: ' + JSON.stringify(json.popin));
    });

    it('02.4  CONTROL — the fallback answers a non-XHR POST with params: 303 to the target', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', webroot + 'fb-str', 'a=1');
        assert.equal(r.status, 303, 'expected 303, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
        assert.ok(String(r.location).indexOf(webroot + 'target') === 0, 'unexpected location: ' + r.location);
    });

    it('02.5  CONTROL — the fallback answers an XHR POST WITHOUT params: 303 to the target', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', webroot + 'fb-str', null, XHR);
        assert.equal(r.status, 303, 'expected 303, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
    });

    it('02.6  CONTROL — the fallback answers a non-XHR GET: 301 to the target', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', webroot + 'fb-str');
        assert.equal(r.status, 301, 'expected 301, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
    });

    // ── the defect: the JSON exits after throwError ─────────────────────────

    it('02.7  an XHR POST with params is answered with the isXhrRedirect JSON', async function (t) {
        if (!ready(t)) return;
        var json = assertXhrRedirect(await request('POST', webroot + 'fb-str', 'a=1', XHR), 'POST XHR + body');
        assert.ok(String(json.location).indexOf(webroot + 'target') === 0, 'unexpected location: ' + json.location);
        assert.ok(String(json.location).indexOf('inheritedData=') > -1, 'the params did not ride the redirect: ' + json.location);
    });

    it('02.8  an XHR PUT with params is answered with the isXhrRedirect JSON', async function (t) {
        if (!ready(t)) return;
        assertXhrRedirect(await request('PUT', webroot + 'fb-str', 'a=1', XHR), 'PUT XHR + body');
    });

    it('02.9  an XHR GET with a query is answered with the isXhrRedirect JSON', async function (t) {
        if (!ready(t)) return;
        assertXhrRedirect(await request('GET', webroot + 'fb-str?a=1', null, XHR), 'GET XHR + query');
    });

    it('02.10 a popin request is answered with the popin JSON', async function (t) {
        if (!ready(t)) return;
        var json = assertXhrRedirect(await request('POST', webroot + 'fb-str', null, Object.assign({ 'x-gina-popin-id': 'p1' }, XHR)), 'popin');
        assert.ok(json.popin && String(json.popin.url).indexOf(webroot + 'target') === 0, 'unexpected popin: ' + JSON.stringify(json.popin));
    });

    it('02.11 the bundle is still up and the target still answers', async function (t) {
        if (!ready(t)) return;
        assert.ok(isChildAlive(), 'the bundle process exited: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1500));
        var r = await request('GET', webroot + 'target');
        assert.equal(r.status, 200, 'the target route stopped answering');
    });

    // ── #B794: an absolute URL on a dot-less host is a URL, not a route name ──

    it('02.12 #B794 CONTROL — a redirect to an absolute URL on a dotted host answers 301 with that location', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', webroot + 'abs-dotted');
        assert.equal(r.status, 301, 'expected 301, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
        assert.equal(r.location, 'http://127.0.0.1:' + bundlePort + webroot + 'target');
    });

    it('02.13 #B794 CONTROL — a redirect to an unknown route name still answers 404', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', webroot + 'to-name');
        assert.equal(r.status, 404, 'a route name is no longer sent to the route branch: ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
    });

    it('02.14 #B794 — a redirect to an absolute URL on localhost answers 301 with that location', async function (t) {
        if (!ready(t)) return;
        var r = await request('GET', webroot + 'abs');
        assert.equal(r.status, 301, 'expected 301, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
        assert.equal(r.location, 'http://localhost:' + bundlePort + webroot + 'target');
    });

    it('02.15 #B794 — a route-object fallback answers a non-XHR POST with a 303 to the target', async function (t) {
        if (!ready(t)) return;
        var r = await request('POST', webroot + 'fb-rte', 'a=1');
        assert.equal(r.status, 303, 'expected 303, got ' + r.status + ' ' + (r.err || r.body.slice(0, 200)));
        assert.ok(String(r.location).indexOf(webroot + 'target') > -1, 'unexpected location: ' + r.location);
    });

    it('02.16 #B794 — a route-object fallback answers an XHR POST with params with the isXhrRedirect JSON', async function (t) {
        if (!ready(t)) return;
        var json = assertXhrRedirect(await request('POST', webroot + 'fb-rte', 'a=1', XHR), 'route-object fallback, POST XHR + body');
        assert.ok(String(json.location).indexOf(webroot + 'target') > -1, 'unexpected location: ' + json.location);
    });

    it('02.17 the bundle is still up after the #B794 arms', async function (t) {
        if (!ready(t)) return;
        assert.ok(isChildAlive(), 'the bundle process exited: ' + JSON.stringify(childExit) + '\n' + childOut.slice(-1500));
    });
});
