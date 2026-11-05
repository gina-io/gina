/**
 * #B1080 — `self.sendTrailers(fields)` delivers its fields on every render delegate over HTTP/2.
 *
 * Node's HTTP/2 compatibility response registers its own 'wantTrailers' listener when it is built, and that
 * listener sends the compat response's own trailer list. The render delegates send on the raw stream and, before
 * this change, registered a second 'wantTrailers' listener that called the stream's `sendTrailers()`: it ran
 * after the compat's, met ERR_HTTP2_TRAILERS_ALREADY_SENT inside its best-effort try/catch, and the fields never
 * left (a Node bundle sent no trailer block, a Bun bundle an empty one). The delegates now hand each field to the
 * compat response first (`response.addTrailers()`, a field it refuses is dropped), and keep the raw listener for a
 * stream with no compat response. The compat response sends every field in one call after the body, and a field the
 * HTTP/2 layer cannot send would make that call throw outside the delegates' try/catch (the stream waits for its
 * trailers, or the bundle stops): `sendTrailers()` therefore records only the fields the layer can send.
 *
 * This file boots the REAL `bin/gina-container` (isaac, the default engine) with `server.protocol: "http/2.0"`
 * and `scheme: "https"`, in five bundles, one project each, booted one after another:
 *   sw   swig on disk with the template cache on: renderJSON, renderStream, renderXML, a swig page (its compile,
 *        then its cache hit), an invalid field beside a valid one, a 204, a HEAD, and an action that answers on
 *        the raw stream itself (its field through `res.addTrailers()`; its own 'wantTrailers' listener, recorded),
 *        and an action that records a field and then calls throwError(500): the custom 500 page and the JSON
 *        error body (an XHR request) carry no field, since throwError() drops the recorded fields; last, the fields
 *        the HTTP/2 layer cannot send (a content-type array, connection, te: gzip, then a non-token name), each
 *        beside a valid one: sendTrailers() drops them when it records them, so the valid one arrives and the
 *        bundle still answers; and string values holding a character outside Node's header-value rule (a CR LF, a
 *        control character, an emoji), beside a valid one: dropped when they are recorded, so the valid one arrives
 *   sws  the same delegates with a bundle middleware, so every answer goes through the #B562 send shim
 *   swa  swig through a memory loader (render-swig-async)
 *   nj   nunjucks on disk (render-nunjucks)
 *   nja  nunjucks through a memory loader (render-nunjucks-async)
 * Controls: each bundle reports the runtime it runs on, and it must be the one the run asked for; a page or a
 * JSON answer without sendTrailers() carries no field; every answer comes from its own action (its marker); the
 * second swig request is a cache hit (its template is rewritten in between and the answer still shows the first
 * text); the session still answers after the last arm.
 *
 * Isolation: the container-boot-render-session-b989.test.js shape — a throwaway HOME under os.tmpdir(), its own
 * port windows (14600–14649, one window of 10 per bundle), a self-signed certificate under that HOME, project:rm
 * + rmSync at teardown. nunjucks is project-only: the framework's devDependency is linked into the two nunjucks
 * projects. Seams: `B1080_GINA_ROOT=<tree>` boots THAT tree's launcher against projects scaffolded by THAT
 * tree's CLI (red-first against a tree without this change, with no write to it); `B1080_RUNTIME=<path to a bun
 * binary>` boots the bundles on it (the CLI stays on this runtime).
 *
 * Run standalone:
 *   node --test test/integration/container-boot-h2-trailers-b1080.test.js
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var net    = require('net');
var http2  = require('http2');
var fs     = require('fs');
var os     = require('os');
var path   = require('path');
var { spawnSync, spawn, execFileSync } = require('child_process');


// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

var STAMP     = Date.now();
var FAKE_HOME = path.join(os.tmpdir(), 'gina-b1080-home-' + STAMP);
var GINA_HOME = path.join(FAKE_HOME, '.gina');

var BOOT_TIMEOUT_MS    = 25000;
var POLL_INTERVAL_MS   = 250;
var REQUEST_TIMEOUT_MS = 8000;

var GINA_ROOT = process.env.B1080_GINA_ROOT || path.resolve(__dirname, '../..');
var CLI       = path.join(GINA_ROOT, 'bin', 'cli');
var CONTAINER = path.join(GINA_ROOT, 'bin', 'gina-container');
var RUNTIME   = process.env.B1080_RUNTIME || process.execPath;

var CHILD_ENV = Object.assign({}, process.env, { HOME: FAKE_HOME, GINA_LOG_STDOUT: 'true' });
delete CHILD_ENV.GINA_HOMEDIR;

// [bundle, label, port window start, mode, with a bundle middleware, template cache on]
var BUNDLES = [
    ['sw',  'swig on disk',                 14600, 'swig',           false, true],
    ['sws', 'swig on disk, a middleware',   14610, 'swig',           true,  false],
    ['swa', 'swig, memory loader',          14620, 'swig-async',     false, false],
    ['nj',  'nunjucks on disk',             14630, 'nunjucks',       false, false],
    ['nja', 'nunjucks, memory loader',      14640, 'nunjucks-async', false, false]
];

// [rule, url, action, body]
var RULES = [
    ['b1080_runtime',  '/b1080/runtime',   'b1080Runtime',   'self.renderJSON({ rule: "b1080_runtime", runtime: (process.versions && process.versions.bun) ? "bun " + process.versions.bun : "node " + process.version });'],
    ['b1080_json',     '/b1080/json',      'b1080Json',      'self.sendTrailers({ "x-b1080": "json" }); self.renderJSON({ rule: "b1080_json" });'],
    ['b1080_jsonnone', '/b1080/jsonnone',  'b1080JsonNone',  'self.renderJSON({ rule: "b1080_jsonnone" });'],
    ['b1080_stream',   '/b1080/stream',    'b1080Stream',    'self.sendTrailers({ "x-b1080": "stream" }); self.renderStream((async function* () { yield "b1080_stream "; yield "two"; })(), "text/plain");'],
    ['b1080_xml',      '/b1080/xml',       'b1080Xml',       'self.sendTrailers({ "x-b1080": "xml" }); self.renderXML("<r>b1080_xml</r>");'],
    ['b1080_html',     '/b1080/html',      'b1080Html',      'self.sendTrailers({ "x-b1080": "html" }); self.render({ title: "H" });'],
    ['b1080_none',     '/b1080/none',      'b1080None',      'self.render({ title: "N" });'],
    ['b1080_bad',      '/b1080/bad',       'b1080Bad',       'self.sendTrailers({ "bad field": "x", "x-b1080": "bad" }); self.renderJSON({ rule: "b1080_bad" });'],
    ['b1080_204',      '/b1080/nocontent', 'b1080NoContent', 'self.sendTrailers({ "x-b1080": "204" }); self.renderJSON({ status: 204, rule: "b1080_204" });'],
    // an action that answers on the raw stream itself: through the compat response's addTrailers(), and through its own listener
    ['b1080_rawadd',   '/b1080/rawadd',    'b1080RawAdd',    'var st = res.stream; if (!st) { self.renderJSON({ rule: "b1080_rawadd", h1: true }); return; } res.addTrailers({ "x-b1080": "rawadd" }); st.respond({ ":status": 200, "content-type": "text/plain" }, { waitForTrailers: true }); st.end("b1080_rawadd");'],
    ['b1080_rawsend',  '/b1080/rawsend',   'b1080RawSend',   'var st = res.stream; if (!st) { self.renderJSON({ rule: "b1080_rawsend", h1: true }); return; } st.respond({ ":status": 200, "content-type": "text/plain" }, { waitForTrailers: true }); st.once("wantTrailers", function () { try { st.sendTrailers({ "x-b1080": "rawsend" }); } catch (e) { /* already sent */ } }); st.end("b1080_rawsend");'],
    // an error answer after sendTrailers(): throwError() drops the recorded fields (the custom page, the JSON body)
    ['b1080_err',      '/b1080/err',       'b1080Err',       'self.sendTrailers({ "x-b1080": "err" }); self.throwError(500, new Error("b1080_err"));'],
    ['b1080_errnone',  '/b1080/errnone',   'b1080ErrNone',   'self.throwError(500, new Error("b1080_errnone"));'],
    // fields the HTTP/2 layer cannot send, each beside a valid one: sendTrailers() drops them when it records them
    ['b1080_carr',     '/b1080/carr',      'b1080CArr',      'self.sendTrailers({ "content-type": ["a", "b"], "x-b1080": "carr" }); self.renderJSON({ rule: "b1080_carr" });'],
    ['b1080_cconn',    '/b1080/cconn',     'b1080CConn',     'self.sendTrailers({ "connection": "close", "x-b1080": "cconn" }); self.renderJSON({ rule: "b1080_cconn" });'],
    ['b1080_cte',      '/b1080/cte',       'b1080CTe',       'self.sendTrailers({ "te": "gzip", "x-b1080": "cte" }); self.renderJSON({ rule: "b1080_cte" });'],
    // string values holding a character outside Node's header-value rule (a CR LF, a control character, an emoji), beside a valid field
    ['b1080_cval',     '/b1080/cval',      'b1080CVal',      'self.sendTrailers({ "x-crlf": "a\\r\\nb", "x-ctl": "a\\u0001b", "x-emoji": "a\\ud83d\\ude00b", "x-b1080": "cval" }); self.renderJSON({ rule: "b1080_cval" });'],
    ['b1080_ctok',     '/b1080/ctok',      'b1080CTok',      'self.sendTrailers({ "x(y)": "v", "x-b1080": "ctok" }); self.renderJSON({ rule: "b1080_ctok" });']
];

// [label, method, path under the webroot, extra request headers] — sent in this order, once each; '@rewrite' rewrites the swig page
var XHR = { 'x-requested-with': 'XMLHttpRequest' };
var ARMS = {
    sw: [
        ['rt', 'GET', 'b1080/runtime'], ['json', 'GET', 'b1080/json'], ['stream', 'GET', 'b1080/stream'], ['xml', 'GET', 'b1080/xml'],
        ['html.miss', 'GET', 'b1080/html'], ['@rewrite'], ['html.hit', 'GET', 'b1080/html'],
        ['none', 'GET', 'b1080/none'], ['jsonnone', 'GET', 'b1080/jsonnone'], ['bad', 'GET', 'b1080/bad'],
        ['204', 'GET', 'b1080/nocontent'], ['head', 'HEAD', 'b1080/json'],
        ['raw.add', 'GET', 'b1080/rawadd'], ['raw.send', 'GET', 'b1080/rawsend'],
        ['err', 'GET', 'b1080/err'], ['err.xhr', 'GET', 'b1080/err', XHR], ['errnone', 'GET', 'b1080/errnone'],
        ['carr', 'GET', 'b1080/carr'], ['cconn', 'GET', 'b1080/cconn'], ['cte', 'GET', 'b1080/cte'], ['cval', 'GET', 'b1080/cval'], ['ctok', 'GET', 'b1080/ctok'],
        ['after', 'GET', 'b1080/jsonnone']
    ],
    sws: [
        ['rt', 'GET', 'b1080/runtime'], ['json', 'GET', 'b1080/json'], ['stream', 'GET', 'b1080/stream'], ['xml', 'GET', 'b1080/xml'],
        ['html.miss', 'GET', 'b1080/html'], ['none', 'GET', 'b1080/none'], ['jsonnone', 'GET', 'b1080/jsonnone'],
        ['head', 'HEAD', 'b1080/json'], ['raw.add', 'GET', 'b1080/rawadd'], ['raw.send', 'GET', 'b1080/rawsend'],
        ['after', 'GET', 'b1080/jsonnone']
    ],
    swa: [['rt', 'GET', 'b1080/runtime'], ['html.miss', 'GET', 'b1080/html'], ['none', 'GET', 'b1080/none'], ['after', 'GET', 'b1080/jsonnone']],
    nj:  [['rt', 'GET', 'b1080/runtime'], ['html.miss', 'GET', 'b1080/html'], ['none', 'GET', 'b1080/none'], ['after', 'GET', 'b1080/jsonnone']],
    nja: [['rt', 'GET', 'b1080/runtime'], ['html.miss', 'GET', 'b1080/html'], ['none', 'GET', 'b1080/none'], ['after', 'GET', 'b1080/jsonnone']]
};

// per bundle: { proj, projDir, port, webroot, mode, error, answers, log }
var state = {};
var skip = false, skipReason = '', setupError = null;
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

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function isChildAlive() { return child && child.exitCode === null && child.signalCode === null; }
function readJSON(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function runCli(args) {
    var r = spawnSync(process.execPath, [CLI].concat(args), { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function hasOpenssl() {
    try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch (e) { return false; }
}

/**
 * One HTTP/2 request on an open session, with a client timeout: what arrived, the trailer block included.
 *
 * @inner
 * @param {object} session - an open `ClientHttp2Session`
 * @param {string} method - GET or HEAD
 * @param {string} reqPath - path including the webroot
 * @param {object} [extra] - extra request headers
 * @returns {Promise<{status: (number|null), body: string, trailers: (object|null), ended: boolean, rst: (number|null), err: (string|null)}>}
 */
function h2request(session, method, reqPath, extra) {
    return new Promise(function (resolve) {
        var out = { status: null, body: '', trailers: null, ended: false, rst: null, err: null };
        var st;
        try { st = session.request(Object.assign({ ':method': method, ':path': reqPath }, extra || {})); } catch (e) { out.err = e.code || e.message; resolve(out); return; }
        st.setTimeout(REQUEST_TIMEOUT_MS, function () { out.err = 'timeout'; st.close(http2.constants.NGHTTP2_CANCEL); });
        st.on('response', function (h) { out.status = h[':status']; });
        st.on('trailers', function (h) { out.trailers = h; });
        st.on('data', function (d) { out.body += d; });
        st.on('end', function () { out.ended = true; });
        st.on('error', function (e) { out.err = e.code || e.message; });
        st.on('close', function () { out.rst = st.rstCode; resolve(out); });
        st.end();
    });
}

function show(a) {
    return JSON.stringify({ status: a.status, trailers: a.trailers, ended: a.ended, rst: a.rst, err: a.err, body: String(a.body || '').slice(0, 80) });
}

/** The `x-b1080` field of an answer's trailer block, or undefined when none arrived. */
function fieldOf(a) { return (a && a.trailers) ? a.trailers['x-b1080'] : undefined; }

/**
 * The page line every HTML rule prints.
 *
 * @inner
 * @param {string} rule - the rule name
 * @param {string} mark - first | second
 * @returns {string} the line
 */
function pageLine(rule, mark) { return '<p id="b1080">RULE=[' + rule + '] MARK=[' + mark + '] TITLE=[{{ title }}]</p>'; }

/**
 * Inserts one top-level key into the bundle's `config/settings.json` (a commented file), after its opening
 * brace, count-guarded.
 *
 * @inner
 * @param {string} bundleDir - the bundle's directory
 * @param {string} keyJson - `"key": <json>`
 * @returns {void}
 */
function spliceSettings(bundleDir, keyJson) {
    var sf = path.join(bundleDir, 'config', 'settings.json');
    var t = fs.readFileSync(sf, 'utf8');
    var m = t.match(/^\{[ \t]*$/mg) || [];
    if (m.length !== 1) { throw new Error('settings.json opening-brace anchor count ' + m.length); }
    fs.writeFileSync(sf, t.replace(/^\{[ \t]*$/m, '{\n    ' + keyJson + ','));
}

/**
 * protocol http/2.0 + scheme https, views on, and (when asked) the template cache on, spliced after the
 * scaffold's webroot line (comments kept).
 *
 * @inner
 * @param {string} bundleDir - the bundle's directory
 * @param {boolean} cacheOn - turn the template cache on
 * @returns {void}
 */
function spliceServerSettings(bundleDir, cacheOn) {
    var ss = path.join(bundleDir, 'config', 'settings.server.json');
    var s = fs.readFileSync(ss, 'utf8');
    var m = s.match(/"webroot"[ \t]*:[ \t]*"[^"]*"/g) || [];
    if (m.length !== 1) { throw new Error('webroot anchor count ' + m.length); }
    if (/"protocol"\s*:/.test(s) || /"scheme"\s*:/.test(s) || /"cache"\s*:/.test(s)) { throw new Error('the scaffold already declares protocol, scheme or cache'); }
    fs.writeFileSync(ss, s.replace(m[0], m[0] + ',\n    "protocol": "http/2.0",\n    "scheme": "https",\n    "template": true'
        + (cacheOn ? ',\n    "cache": { "enable": true }' : '')));
}

/** The self-signed certificate triple isaac reads for https (key, certificate, CA bundle). */
function makeCertificate() {
    var dir = path.join(GINA_HOME, 'certificates', 'scopes', 'local', 'localhost');
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'private.key'),
        '-out', path.join(dir, 'certificate.crt'), '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    fs.copyFileSync(path.join(dir, 'certificate.crt'), path.join(dir, 'ca_bundle.crt'));
}

/**
 * Writes one bundle's scene: the rules, the actions, the templates its engine reads (on disk, or in its memory
 * loader), and, when asked, a pass-through bundle middleware.
 *
 * @inner
 * @param {Array} bd - a BUNDLES row
 * @returns {void}
 */
function installScene(bd) {
    var bundle = bd[0], mode = bd[3], withMiddleware = bd[4];
    var bundleDir = path.join(state[bundle].projDir, 'src', bundle);

    if (withMiddleware) {
        fs.writeFileSync(path.join(bundleDir, 'index.js'), [
            "var myapp = require('gina');",
            "myapp.onInitialize(function(event, app) {",
            "    // #B1080 scene: a pass-through middleware, so every answer goes through the #B562 send shim",
            "    app.use(function (req, res, next) { next(); });",
            "    event.emit('complete', app);",
            "});",
            "myapp.onError(function(err, req, res, next) { next(err); });",
            "myapp.start();",
            ""
        ].join('\n'));
    }

    spliceServerSettings(bundleDir, bd[5]);

    var rf = path.join(bundleDir, 'config', 'routing.json');
    var strip = function (raw) { return raw.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); };
    var r = JSON.parse(strip(fs.readFileSync(rf, 'utf8')));
    RULES.forEach(function (rule) {
        r[rule[0]] = { namespace: 'content', url: rule[1], method: 'GET', param: { control: rule[2] } };
    });
    fs.writeFileSync(rf, JSON.stringify(r, null, 2));

    var cf = path.join(bundleDir, 'controllers', 'controller.content.js');
    var s = fs.readFileSync(cf, 'utf8');
    var anchor = '    this.home = function(req, res) {';
    if (s.split(anchor).length !== 2) { throw new Error('controller anchor count ' + (s.split(anchor).length - 1)); }
    var actions = RULES.map(function (rule) { return '    this.' + rule[2] + ' = function(req, res) { ' + rule[3] + ' };'; }).join('\n');
    fs.writeFileSync(cf, s.replace(anchor, actions + '\n' + anchor));

    var td = path.join(bundleDir, 'templates', 'html', 'content');
    if (!fs.existsSync(td)) { throw new Error('no templates/html/content (did view:add run?)'); }

    if (mode === 'swig' || mode === 'nunjucks') {
        var layout = "'layouts/main.html'";
        if (mode === 'nunjucks') {
            fs.writeFileSync(path.join(bundleDir, 'templates', 'html', 'layouts', 'b1080nj.html'),
                '<!doctype html>\n<html>\n<head><title>b1080</title></head>\n<body>{% block content %}{% endblock %}</body>\n</html>\n');
            layout = '"layouts/b1080nj.html"';
            spliceSettings(bundleDir, '"render": { "engine": "nunjucks" }');
        }
        ['b1080_html', 'b1080_none'].forEach(function (rule) {
            fs.writeFileSync(path.join(td, rule + '.html'), '{% extends ' + layout + ' %}\n{% block content %}' + pageLine(rule, 'first') + '{% endblock %}\n');
        });
        if (mode === 'swig') {
            // the custom 500 page the error arms are answered with (guides/error-pages.md)
            var ed = path.join(bundleDir, 'templates', 'html', 'errors');
            fs.mkdirSync(ed, { recursive: true });
            fs.writeFileSync(path.join(ed, '500.html'), '<!DOCTYPE html>\n<html>\n<head><title>e</title></head>\n<body><p id="b1080err">ERRPAGE=[{{ page.data.status }}]</p></body>\n</html>\n');
        }
    } else {
        // names as resolveTemplatePath() builds them for a memory loader: `<namespace>/<rule>.html`
        var map = { 'layout.html': '<!doctype html><html><head><title>b1080</title></head><body>{% block body %}{% endblock %}</body></html>' };
        ['b1080_html', 'b1080_none'].forEach(function (rule) {
            map['content/' + rule + '.html'] = '{% extends "layout.html" %}{% block body %}' + pageLine(rule, 'first') + '{% endblock %}';
        });
        var engine = (mode === 'swig-async') ? 'swig' : 'nunjucks';
        var tpl = {}; tpl[engine] = { loader: { type: 'memory', templates: map } };
        spliceSettings(bundleDir, '"template": ' + JSON.stringify(tpl));
        if (engine === 'nunjucks') { spliceSettings(bundleDir, '"render": { "engine": "nunjucks" }'); }
    }
}

async function stopChild() {
    if (isChildAlive()) {
        try { child.kill('SIGTERM'); } catch (e) { /* ignore */ }
        var until = Date.now() + 8000;
        while (Date.now() < until && isChildAlive()) { await sleep(150); }
        if (isChildAlive()) {
            // SIGKILL cannot be forwarded: signal the bundle process too, or it outlives the run
            var m = childOut.match(/\[ FRAMEWORK \]\[ (\d+) \]/);
            if (m) { try { process.kill(Number(m[1]), 'SIGKILL'); } catch (e) { /* gone */ } }
            try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
        }
    }
}

/**
 * Boots one bundle, sends its arms in order over one HTTP/2 session, and stops it.
 *
 * @inner
 * @param {string} bundle - the bundle name
 * @returns {Promise<void>} resolves when the bundle has stopped; failures land in `state[bundle].error`
 */
async function runBundle(bundle) {
    var st = state[bundle];
    child = null; childOut = ''; childExit = null;
    child = spawn(RUNTIME, [CONTAINER, bundle, '@' + st.proj], { env: CHILD_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', function (d) { childOut += d; });
    child.stderr.on('data', function (d) { childOut += d; });
    child.on('exit', function (code, signal) { childExit = { code: code, signal: signal }; });
    var deadline = Date.now() + BOOT_TIMEOUT_MS, up = false;
    while (Date.now() < deadline && !childExit) {
        if (await isTcpPortOpen(st.port)) { up = true; break; }
        await sleep(POLL_INTERVAL_MS);
    }
    if (!up) {
        st.error = bundle + ' did not come up: exit ' + JSON.stringify(childExit) + '\n' + childOut.slice(-2000);
    } else {
        await sleep(300);
        var session = http2.connect('https://127.0.0.1:' + st.port, { rejectUnauthorized: false });
        session.on('error', function () { /* an arm reads its own stream error */ });
        await new Promise(function (resolve) { session.once('connect', resolve); setTimeout(resolve, 5000); });
        var arms = ARMS[bundle];
        for (var i = 0; i < arms.length; i++) {
            if (arms[i][0] === '@rewrite') {
                var page = path.join(st.projDir, 'src', bundle, 'templates', 'html', 'content', 'b1080_html.html');
                fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('MARK=[first]', 'MARK=[second]'));
                continue;
            }
            st.answers[arms[i][0]] = await h2request(session, arms[i][1], st.webroot + arms[i][2], arms[i][3]);
        }
        try { session.close(); } catch (e) { /* ignore */ }
    }
    st.log = childOut.slice(-2000);
    await stopChild();
}


// ---------------------------------------------------------------------------
// 01 – 05 — boot arms, one block per bundle
// ---------------------------------------------------------------------------

describe('container-boot-h2-trailers — self.sendTrailers() delivers its fields on every render delegate over HTTP/2 (#B1080)', function () {

    before(async function () {
        if (process.platform === 'win32') { skip = true; skipReason = 'gina-container is Unix-centric (win32 not supported)'; return; }
        if (!hasOpenssl()) { skip = true; skipReason = 'openssl is not available to mint the test certificate'; return; }
        var projectsPath     = path.join(GINA_HOME, 'projects.json');
        var portsReversePath = path.join(GINA_HOME, 'ports.reverse.json');
        var njkSrc           = path.join(GINA_ROOT, 'node_modules', 'nunjucks');
        if (!fs.existsSync(path.join(njkSrc, 'package.json'))) { setupError = 'nunjucks (a devDependency) is not installed under ' + GINA_ROOT; return; }

        // one project per bundle
        for (var i = 0; i < BUNDLES.length; i++) {
            var b = BUNDLES[i][0], proj = 'tr' + b + STAMP, projDir = path.join(FAKE_HOME, 'proj-' + b);
            state[b] = { proj: proj, projDir: projDir, port: null, webroot: '/' + b + '/', mode: BUNDLES[i][3], error: null, answers: {}, log: '' };
            fs.mkdirSync(projDir, { recursive: true });
            runCli(['project:add', '@' + proj, '--path=' + projDir]);
            if (!fs.existsSync(projectsPath) || !readJSON(projectsPath)[proj]) { setupError = 'project:add did not register @' + proj; return; }
            var env = readJSON(projectsPath)[proj].def_env || 'dev';
            runCli(['bundle:add', b, '@' + proj, '--start-port-from=' + BUNDLES[i][2]]);
            var key = b + '@' + proj;
            if (!fs.existsSync(portsReversePath) || !readJSON(portsReversePath)[key]) { setupError = 'bundle:add did not register ' + key; return; }
            var va = runCli(['view:add', b, '@' + proj]);
            if (va.status !== 0) { setupError = 'view:add ' + b + ' failed: ' + (va.stderr || va.stdout).slice(-600); return; }
            try { state[b].port = readJSON(portsReversePath)[key][env]['http/2.0']['https']; } catch (e) { state[b].port = null; }
            if (!state[b].port) { setupError = 'could not resolve the http/2.0 https port for ' + key; return; }
            try {
                var ssj = fs.readFileSync(path.join(projDir, 'src', b, 'config', 'settings.server.json'), 'utf8');
                var wr  = (ssj.match(/"webroot"\s*:\s*"([^"]*)"/) || [])[1] || ('/' + b);
                state[b].webroot = wr.replace(/\/+$/, '') + '/';
            } catch (e) { /* keep the default */ }

            // the project must load the tree under test (the #B422 Franken-boot trap)
            try {
                var target = fs.realpathSync(path.join(projDir, 'node_modules', 'gina'));
                if (target !== fs.realpathSync(GINA_ROOT)) { setupError = b + ': node_modules/gina resolves to ' + target + ', not ' + GINA_ROOT; return; }
            } catch (e) { setupError = b + ': node_modules/gina is not linked: ' + (e.message || e); return; }

            // nunjucks is project-only: link the framework's devDependency into the project
            if (/^nunjucks/.test(BUNDLES[i][3])) {
                fs.symlinkSync(njkSrc, path.join(projDir, 'node_modules', 'nunjucks'));
            }
        }

        try {
            BUNDLES.forEach(function (bd) { installScene(bd); });
            makeCertificate();
        } catch (e) { setupError = 'scene install failed: ' + (e.message || e); return; }

        // one boot per bundle, one after another
        for (var j = 0; j < BUNDLES.length; j++) {
            await runBundle(BUNDLES[j][0]);
        }
    });

    after(async function () {
        await stopChild();
        Object.keys(state).forEach(function (b) {
            try { runCli(['project:rm', '@' + state[b].proj, '--force']); } catch (e) { /* ignore */ }
            try { fs.rmdirSync(path.join(os.homedir(), '.' + state[b].proj)); } catch (e) { /* absent or non-empty: leave it */ }
        });
        try { fs.rmSync(FAKE_HOME, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    });

    function ready(t, bundle) {
        if (skip) { t.skip(skipReason); return false; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        assert.equal(state[bundle].error, null, 'boot failed: ' + state[bundle].error);
        return true;
    }

    /**
     * Records an arm's reading, then asserts it answered with its own action's text and carried the field.
     *
     * @inner
     * @param {object} t - the test context
     * @param {string} bundle - the bundle name
     * @param {string} label - an ARMS label
     * @param {number} status - the expected status
     * @param {string} marker - text the answer's body carries ('' for none)
     * @param {(string|undefined)} field - the expected `x-b1080` value, or undefined for none
     * @returns {object} the answer
     */
    function check(t, bundle, label, status, marker, field) {
        var a = state[bundle].answers[label];
        assert.ok(a, bundle + ' ' + label + ': the arm was not sent');
        t.diagnostic(bundle + ' ' + label + ' READING ' + show(a));
        assert.equal(a.status, status, bundle + ' ' + label + ': the status: ' + show(a));
        assert.equal(a.err, null, bundle + ' ' + label + ': no stream error: ' + show(a));
        if (marker) { assert.ok(a.body.indexOf(marker) > -1, bundle + ' ' + label + ': from its own action: ' + show(a)); }
        assert.equal(fieldOf(a), field, bundle + ' ' + label + ': the x-b1080 trailer field: ' + show(a));
        return a;
    }

    it('00.1  control: every bundle ran on the runtime this run asked for (B1080_RUNTIME, or this one)', function (t) {
        if (skip) { t.skip(skipReason); return; }
        assert.equal(setupError, null, 'setup failed: ' + setupError);
        var want = (RUNTIME === process.execPath) ? '"runtime":"node ' : '"runtime":"bun ';
        BUNDLES.forEach(function (bd) {
            assert.equal(state[bd[0]].error, null, bd[0] + ': boot failed: ' + state[bd[0]].error);
            check(t, bd[0], 'rt', 200, want, undefined);
        });
    });

    it('01.1  sw (swig on disk): renderJSON, renderStream and renderXML send the field (pre-fix: none)', function (t) {
        if (!ready(t, 'sw')) return;
        check(t, 'sw', 'json', 200, '"b1080_json"', 'json');
        check(t, 'sw', 'stream', 200, 'b1080_stream two', 'stream');
        check(t, 'sw', 'xml', 200, '<r>b1080_xml</r>', 'xml');
    });

    it('01.2  sw: a swig page sends the field on its compile and on its cache hit (pre-fix: none)', function (t) {
        if (!ready(t, 'sw')) return;
        check(t, 'sw', 'html.miss', 200, 'RULE=[b1080_html] MARK=[first]', 'html');
        // control: the template was rewritten after the first answer, and the second still shows the first text
        check(t, 'sw', 'html.hit', 200, 'RULE=[b1080_html] MARK=[first]', 'html');
    });

    it('01.3  sw: an invalid field beside a valid one — the valid one arrives, the answer completes (pre-fix: none)', function (t) {
        if (!ready(t, 'sw')) return;
        var a = check(t, 'sw', 'bad', 200, '"b1080_bad"', 'bad');
        assert.equal(a.trailers['bad field'], undefined, 'the invalid field is dropped: ' + show(a));
    });

    it('01.4  sw: controls — a page and a JSON answer without sendTrailers() carry no field; the session still answers', function (t) {
        if (!ready(t, 'sw')) return;
        check(t, 'sw', 'none', 200, 'RULE=[b1080_none]', undefined);
        check(t, 'sw', 'jsonnone', 200, '"b1080_jsonnone"', undefined);
        check(t, 'sw', 'after', 200, '"b1080_jsonnone"', undefined);
    });

    it('01.5  sw: a 204 and a HEAD (recorded)', function (t) {
        if (!ready(t, 'sw')) return;
        ['204', 'head'].forEach(function (label) { t.diagnostic('sw ' + label + ' READING ' + show(state.sw.answers[label])); });
    });

    it('01.6  sw: an action answering on the raw stream sends its field through res.addTrailers(); its own listener (recorded)', function (t) {
        if (!ready(t, 'sw')) return;
        check(t, 'sw', 'raw.add', 200, 'b1080_rawadd', 'rawadd');
        t.diagnostic('sw raw.send READING ' + show(state.sw.answers['raw.send']));
    });

    it('01.7  sw: an error answer after sendTrailers() carries no field — the custom 500 page and the JSON error body (without throwError()\'s drop, the page carries it)', function (t) {
        if (!ready(t, 'sw')) return;
        check(t, 'sw', 'err', 500, 'ERRPAGE=[500]', undefined);
        var x = check(t, 'sw', 'err.xhr', 500, '"status"', undefined);
        assert.equal(x.body.indexOf('ERRPAGE'), -1, 'err.xhr: a JSON error body, not the page: ' + show(x));
        // control: the same error with no recorded field
        check(t, 'sw', 'errnone', 500, 'ERRPAGE=[500]', undefined);
    });

    it('01.8  sw: a field the HTTP/2 layer cannot send (a content-type array, connection, te: gzip, a non-token name) is dropped when it is recorded: the valid field beside it arrives and the bundle still answers (without the check, the stream waits or the bundle stops)', function (t) {
        if (!ready(t, 'sw')) return;
        [['carr', '"b1080_carr"', 'content-type'], ['cconn', '"b1080_cconn"', 'connection'], ['cte', '"b1080_cte"', 'te'], ['ctok', '"b1080_ctok"', 'x(y)']].forEach(function (row) {
            var a = check(t, 'sw', row[0], 200, row[1], row[0]);
            assert.equal(a.trailers[row[2]], undefined, row[0] + ': the field the layer cannot send is dropped: ' + show(a));
        });
        // the bundle answers after the last of them (without the check, the non-token name stops it)
        check(t, 'sw', 'after', 200, '"b1080_jsonnone"', undefined);
    });

    it('01.9  sw: a string value holding a character outside Node\'s header-value rule (a CR LF, a control character, an emoji) is dropped when it is recorded: the valid field beside it arrives and the stream ends', function (t) {
        if (!ready(t, 'sw')) return;
        var a = check(t, 'sw', 'cval', 200, '"b1080_cval"', 'cval');
        assert.deepEqual(Object.keys(a.trailers).sort(), ['x-b1080'], 'only the valid field arrives: ' + show(a));
    });

    it('02.1  sws (a middleware, the #B562 shim): renderJSON, renderStream, renderXML and a swig page send the field (pre-fix: none)', function (t) {
        if (!ready(t, 'sws')) return;
        check(t, 'sws', 'json', 200, '"b1080_json"', 'json');
        check(t, 'sws', 'stream', 200, 'b1080_stream two', 'stream');
        check(t, 'sws', 'xml', 200, '<r>b1080_xml</r>', 'xml');
        check(t, 'sws', 'html.miss', 200, 'RULE=[b1080_html] MARK=[first]', 'html');
    });

    it('02.2  sws: controls — no field without sendTrailers(); the session still answers; a HEAD (recorded)', function (t) {
        if (!ready(t, 'sws')) return;
        check(t, 'sws', 'none', 200, 'RULE=[b1080_none]', undefined);
        check(t, 'sws', 'jsonnone', 200, '"b1080_jsonnone"', undefined);
        check(t, 'sws', 'after', 200, '"b1080_jsonnone"', undefined);
        t.diagnostic('sws head READING ' + show(state.sws.answers.head));
    });

    it('02.3  sws: an action answering on the raw stream sends its field through res.addTrailers(); its own listener (recorded)', function (t) {
        if (!ready(t, 'sws')) return;
        check(t, 'sws', 'raw.add', 200, 'b1080_rawadd', 'rawadd');
        t.diagnostic('sws raw.send READING ' + show(state.sws.answers['raw.send']));
    });

    [['swa', '03'], ['nj', '04'], ['nja', '05']].forEach(function (row) {
        var b = row[0], nn = row[1];
        it(nn + '.1  ' + b + ' (' + BUNDLES.filter(function (bd) { return bd[0] === b; })[0][1] + '): a page sends the field (pre-fix: none)', function (t) {
            if (!ready(t, b)) return;
            check(t, b, 'html.miss', 200, 'RULE=[b1080_html] MARK=[first]', 'html');
        });
        it(nn + '.2  ' + b + ': controls — a page without sendTrailers() carries no field; the session still answers', function (t) {
            if (!ready(t, b)) return;
            check(t, b, 'none', 200, 'RULE=[b1080_none]', undefined);
            check(t, b, 'after', 200, '"b1080_jsonnone"', undefined);
        });
    });
});


// ---------------------------------------------------------------------------
// 06 — source: each of the 8 trailer sites hands the fields to the compat response before its raw listener
// ---------------------------------------------------------------------------

describe('container-boot-h2-trailers — source: each trailer site hands its fields to the compat response, and keeps its raw listener (#B1080)', function () {

    it('06.1  the 8 sites in the 7 delegates call addTrailers() before their own wantTrailers listener', function () {
        var cdir = path.join(GINA_ROOT, 'framework', 'v' + require(path.join(GINA_ROOT, 'package.json')).version, 'core', 'controller');
        var files = { 'controller.render-json.js': 1, 'controller.render-nunjucks-async.js': 1, 'controller.render-nunjucks.js': 1,
            'controller.render-stream.js': 1, 'controller.render-swig-async.js': 1, 'controller.render-swig.js': 2, 'controller.render-xml.js': 1 };
        var total = 0;
        Object.keys(files).forEach(function (f) {
            // code lines only: a comment that names the call does not count
            var code = fs.readFileSync(path.join(cdir, f), 'utf8').split('\n').filter(function (l) { return !/^\s*(\/\/|\*)/.test(l); }).join('\n');
            var adds = [], listens = [], at = -1;
            while ((at = code.indexOf('.addTrailers(_tf)', at + 1)) > -1) { adds.push(at); }
            at = -1;
            while ((at = code.indexOf("stream.once('wantTrailers'", at + 1)) > -1) { listens.push(at); }
            assert.equal(listens.length, files[f], f + ': the raw wantTrailers listeners are kept');
            assert.equal(adds.length, files[f], f + ': one addTrailers() per site');
            for (var i = 0; i < adds.length; i++) {
                assert.ok(adds[i] < listens[i], f + ' site ' + (i + 1) + ': addTrailers() runs before the listener is registered');
                if (i > 0) { assert.ok(adds[i] > listens[i - 1], f + ' site ' + (i + 1) + ': each site has its own call'); }
            }
            total += adds.length;
        });
        assert.equal(total, 8);
    });
});
