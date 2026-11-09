'use strict';
/**
 * #B1119 — `self.downloadFromURL(url)` sent an `https` url that names no port, such as the
 * guide's `https://example.com/brand/logo.png`, to port 80: the method's defaults carried
 * `port: 80` and the port was replaced only when the url named one, so Node's https client
 * opened TLS on port 80 (its own default, 443, applies only when no port is given) and the
 * download answered 500. The port now follows the scheme when neither the url nor
 * `options.port` gives one: 443 for `https`, 80 for `http`.
 *
 * #B1120 — the « protocol upgrade » override, meant to send a url aimed at the host of an
 * `app.json` `proxy` entry (`bundle@project`) on another port to that bundle's port, set the
 * host to the port number instead: the request was never made and the method answered 500.
 * It now sets the port.
 *
 * The method runs for real through `createTestInstance` against two in-process servers on
 * 127.0.0.1 ephemeral ports: a TLS server (a throwaway self-signed certificate made with
 * openssl, trusted through `options.ca`, so certificate verification stays on) and a plain HTTP
 * server. The real ports 443 and 80 are never used: a request on them carries a mapping agent
 * (`options.agent`) that maps the port Node chose (443 to the TLS server, 80 to the HTTP server)
 * and records it, and `http.get` / `https.get` are wrapped for this file to read the options
 * that reach them, to answer a `.invalid` host themselves, and to refuse a request to 127.0.0.1
 * on no port, 80 or 443 that carries no mapping agent. throwError is replaced by a recorder.
 * Arms marked CONTROL pin unchanged behaviour and pass on the pre-fix bytes too. §04 and §04b
 * pin the source with its comment lines stripped.
 *
 * Seam: GINA_B1119_CONTROLLER — the controller module to require (a pre-fix copy must sit
 * beside the real file so its relative requires resolve).
 */

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var os       = require('node:os');
var http     = require('node:http');
var https    = require('node:https');
var nodePath = require('node:path');
var EventEmitter = require('node:events');
var net      = require('node:net');
var { Writable } = require('node:stream');
var { execFileSync } = require('node:child_process');

// `_isLocalScope` is read once when the controller module loads: outside the local scope is the
// production default
process.env.NODE_SCOPE_IS_LOCAL = 'false';

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');
var CONTROLLER_SRC = process.env.GINA_B1119_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');

process.env.NODE_PATH = (process.env.NODE_PATH || '') + nodePath.delimiter + FW;
require('node:module').Module._initPaths();
require(nodePath.join(FW, 'helpers'));
require(nodePath.join(ROOT, 'utils', 'prototypes'));
setPath('gina', { core: nodePath.join(FW, 'core') });
// a framework global the bundle runtime defines (downloadFromURL builds a tmp path from it)
if (typeof(global.GINA_TMPDIR) == 'undefined') { global.GINA_TMPDIR = os.tmpdir(); }

var SuperController = require(CONTROLLER_SRC);

var CONF = {
    bundle: 'b', encoding: 'utf-8',
    content: { routing: { r: {} }, templates: { _common: {} } },
    server: { coreConfiguration: {
        statusCodes: { '200': 'OK', '500': 'Internal Server Error' },
        mime: { pdf: 'application/pdf' }
    } }
};

/**
 * A mock response whose setHeader enforces Node's header-value rule, as ServerResponse does.
 *
 * @inner
 * @returns {object} The mock response (a Writable, so `pipeline()` can write into it).
 */
function strictRes() {
    var chunks = [];
    var res = new Writable({ write: function (c, e, cb) { chunks.push(c); cb(); } });
    res.headers = {};
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = function (k, v) { http.validateHeaderValue(k, v); res.headers[k.toLowerCase()] = v; };
    res.getHeader = function (k) { return res.headers[k.toLowerCase()]; };
    res.getHeaders = function () { var o = {}; for (var k in res.headers) { o[k] = res.headers[k]; } return o; };
    res.removeHeader = function (k) { delete res.headers[k.toLowerCase()]; };
    res.body = function () { return Buffer.concat(chunks).toString(); };
    return res;
}

/**
 * A throwaway self-signed certificate for 127.0.0.1, made with openssl in a temp dir that is
 * removed before returning.
 *
 * @inner
 * @returns {{key: Buffer, cert: Buffer}}
 */
function selfSigned() {
    var dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1119-tls-'));
    try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', nodePath.join(dir, 'k.pem'),
            '-out', nodePath.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        return { key: fs.readFileSync(nodePath.join(dir, 'k.pem')), cert: fs.readFileSync(nodePath.join(dir, 'c.pem')) };
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

var TLS = null, tlsSrv = null, httpSrv = null, P = 0, Q = 0, CLOSED = 0;
var tlsSeen = [], httpSeen = [], httpConns = 0, gets = [];
var origGet = null, origHttpsGet = null;

/**
 * An emitter that fails on the next tick: what the wrapped get returns for a request it answers itself.
 *
 * @inner
 */
function refused(tag) {
    var ee = new EventEmitter();
    setImmediate(function () { ee.emit('error', new Error(tag)); });
    return ee;
}

/**
 * Wrap `http.get` / `https.get` for this file: record the options that reach it, answer a
 * `.invalid` host, and refuse 127.0.0.1 on no port, 80 or 443 without a mapping agent.
 *
 * @inner
 */
function guarded(mod, orig) {
    return function (opts) {
        var o = opts || {};
        var mapped = !!(o.agent && o.agent.b1119Map);
        gets.push({ module: mod, host: o.host, port: o.port, mapped: mapped });
        if (typeof(o.host) == 'string') {
            if (/\.invalid$/.test(o.host)) { return refused('B1119-TEST-NO-NETWORK'); }
            var pt = (o.port == null) ? null : String(o.port);
            if (o.host !== '127.0.0.1' || (!mapped && (pt === null || pt === '80' || pt === '443'))) {
                return refused('B1119-TEST-GUARD');
            }
        }
        return orig.apply(this, arguments);
    };
}

/**
 * An agent that maps the port Node chose before connecting, and records it.
 *
 * @inner
 * @param {function} Base - `https.Agent` or `http.Agent`
 * @param {object} map - port Node chose -> port connected to
 * @returns {object} The agent; `agent.asked` lists the ports Node chose.
 */
function mapAgent(Base, map) {
    var a = new Base({ keepAlive: false });
    a.b1119Map = map;
    a.asked = [];
    var orig = a.createConnection;
    a.createConnection = function (options, cb) {
        a.asked.push(options.port);
        var k = String(options.port);
        var to = Object.prototype.hasOwnProperty.call(map, k) ? map[k] : options.port;
        return orig.call(this, Object.assign({}, options, { port: to }), cb);
    };
    return a;
}
function tlsAgent() { return mapAgent(https.Agent, { '443': P, '80': Q }); }
function httpAgent() { return mapAgent(http.Agent, { '80': Q }); }

before(function (t, ready) {
    TLS = selfSigned();
    origGet = http.get;
    origHttpsGet = https.get;
    http.get = guarded('http', origGet);
    https.get = guarded('https', origHttpsGet);
    tlsSrv = https.createServer({ key: TLS.key, cert: TLS.cert }, function (req, res) {
        tlsSeen.push({ path: req.url, host: req.headers.host });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('TLSBYTES');
    });
    httpSrv = http.createServer(function (req, res) {
        httpSeen.push({ path: req.url, host: req.headers.host });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('HTTPBYTES');
    });
    httpSrv.on('connection', function () { httpConns++; });
    tlsSrv.listen(0, '127.0.0.1', function () {
        P = tlsSrv.address().port;
        httpSrv.listen(0, '127.0.0.1', function () {
            Q = httpSrv.address().port;
            // a port nothing listens on: bound, read, closed
            var tmp = net.createServer();
            tmp.listen(0, '127.0.0.1', function () { CLOSED = tmp.address().port; tmp.close(ready); });
        });
    });
});
after(function () {
    if (origGet) { http.get = origGet; }
    if (origHttpsGet) { https.get = origHttpsGet; }
    [tlsSrv, httpSrv].forEach(function (s) {
        if (!s) { return; }
        try { s.closeAllConnections(); } catch (e) {}
        s.close();
    });
});

/**
 * A request outside the controller, through the wrapped get: the instrument controls.
 *
 * @inner
 * @returns {Promise<{status: ?number, body: ?string, error: ?string}>}
 */
function direct(mod, opts) {
    return new Promise(function (resolve) {
        var r = { status: null, body: null, error: null }, done = false;
        function end() { if (done) { return; } done = true; clearTimeout(timer); resolve(r); }
        var req = mod.get(opts, function (res) {
            var ch = [];
            res.on('data', function (c) { ch.push(c); });
            res.on('end', function () { r.status = res.statusCode; r.body = Buffer.concat(ch).toString(); end(); });
        });
        req.on('error', function (e) { r.error = (e.code ? e.code + ' ' : '') + e.message; end(); });
        var timer = setTimeout(function () { r.error = r.error || 'TIMEOUT'; end(); }, 5000);
    });
}

/**
 * Run downloadFromURL with throwError replaced by a recorder, and report how it ended.
 *
 * @inner
 * @param {string} url - the url argument
 * @param {*} [opts] - the options argument (left out of the call when undefined)
 * @param {object} [setup] - `app` (what getConfig('app') returns) and `envConf` (set on the global
 *  context for the protocol-upgrade block, restored after the call)
 * @returns {Promise<object>} `{ settled, thrown, finished, ms, body, tls, http, httpConns, gets, asked }`
 */
function drive(url, opts, setup) {
    return new Promise(function (resolve) {
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {},
                _ginaReqId: 'REQ-B1119' },
            res: res, options: { rule: 'r', conf: CONF }
        });
        inst.getConfig = function (name) {
            return (name === 'app' && setup && setup.app) ? JSON.parse(JSON.stringify(setup.app)) : {};
        };
        var ctx = getContext(), saved = null;
        if (setup && setup.envConf) {
            saved = { gina: ctx.gina, env: ctx.env };
            ctx.gina = { config: { envConf: setup.envConf } };
            ctx.env = 'dev';
        }
        var out = { settled: 'pending', thrown: null, finished: false, ms: null };
        var started = Date.now();
        var t0 = tlsSeen.length, h0 = httpSeen.length, c0 = httpConns, g0 = gets.length, reported = false;
        inst.throwError = function (r, code, e) {
            out.thrown = { code: code, message: (e && e.message) ? e.message : String(e) };
            res.end();
        };
        res.on('finish', function () { out.finished = true; });
        function report() {
            if (reported) { return; }
            reported = true;
            out.ms = Date.now() - started;
            if (saved) { ctx.gina = saved.gina; ctx.env = saved.env; }
            out.body = res.body();
            out.tls = tlsSeen.slice(t0);
            out.http = httpSeen.slice(h0);
            out.httpConns = httpConns - c0;
            out.gets = gets.slice(g0);
            out.asked = (opts && opts.agent && opts.agent.asked) ? opts.agent.asked.slice() : null;
            resolve(out);
        }
        var timer = setTimeout(report, 5000);
        var p = (typeof(opts) == 'undefined') ? inst.downloadFromURL(url) : inst.downloadFromURL(url, opts);
        Promise.resolve(p).then(
            function () { out.settled = 'resolved'; },
            function (e) { out.settled = 'rejected: ' + ((e && e.message) ? e.message : String(e)); }
        ).then(function () {
            // the response's `finish` is emitted asynchronously after `end()`
            setTimeout(function () { clearTimeout(timer); report(); }, 30);
        });
    });
}

function assertDownloaded(out, bytes) {
    assert.equal(out.settled, 'resolved', 'the method settles (got: ' + out.settled + ')');
    assert.equal(out.thrown, null, 'no throwError (got: ' + JSON.stringify(out.thrown) + ')');
    assert.equal(out.body, bytes, 'the upstream bytes reached the client');
}


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - the mapping agent sends port 443 to the TLS server and records the port Node chose', async function () {
        var a = tlsAgent();
        var r = await direct(https, { host: '127.0.0.1', port: 443, path: '/c0', agent: a, ca: TLS.cert });
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.body, 'TLSBYTES');
        assert.deepEqual(a.asked, [443]);
    });

    it('CONTROL - port 80 through the mapping agent reaches the HTTP server, where the TLS handshake fails', async function () {
        var a = tlsAgent(), c0 = httpConns;
        var r = await direct(https, { host: '127.0.0.1', port: 80, path: '/c1', agent: a, ca: TLS.cert });
        assert.equal(r.status, null);
        assert.ok(r.error, 'the request fails');
        assert.deepEqual(a.asked, [80]);
        assert.equal(httpConns - c0, 1, 'one connection reached the HTTP server');
    });

    it('CONTROL - with no port, Node\'s https client picks 443 itself', async function () {
        var a = tlsAgent();
        var r = await direct(https, { host: '127.0.0.1', path: '/c2', agent: a, ca: TLS.cert });
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.deepEqual(a.asked, [443]);
    });

    it('CONTROL - the TLS server verifies against its certificate on its own port', async function () {
        var r = await direct(https, { host: '127.0.0.1', port: P, path: '/c3', ca: TLS.cert });
        assert.equal(r.status, 200, JSON.stringify(r));
        assert.equal(r.body, 'TLSBYTES');
    });

    it('CONTROL - the guard refuses 127.0.0.1:443 without a mapping agent', async function () {
        var r = await direct(https, { host: '127.0.0.1', port: 443, path: '/c4', ca: TLS.cert });
        assert.equal(r.error, 'B1119-TEST-GUARD');
    });
});


// ── 01 — #B1119 ───────────────────────────────────────────────────────────────

describe('01 - #B1119: an https url that names no port goes to port 443', function () {

    it('downloads over TLS from port 443, with no port in the Host header', async function () {
        var out = await drive('https://127.0.0.1/proof.pdf', { agent: tlsAgent(), ca: TLS.cert });
        assert.deepEqual(out.asked, [443], 'the port Node chose (pre-fix: 80)');
        assertDownloaded(out, 'TLSBYTES');
        assert.equal(out.tls.length, 1);
        assert.equal(out.tls[0].host, '127.0.0.1');
        assert.equal(out.httpConns, 0, 'nothing reached the port-80 server');
    });

    it('with no options at all, the port that reaches https.get is 443', async function () {
        var out = await drive('https://files.invalid/brand/logo.pdf');
        assert.equal(out.gets.length, 1);
        assert.equal(out.gets[0].module, 'https');
        assert.equal(out.gets[0].port, 443);
    });

    it('with options that name no port, the port that reaches https.get is 443', async function () {
        var out = await drive('https://files.invalid/brand/logo.pdf', { contentDisposition: 'inline' });
        assert.equal(out.gets.length, 1);
        assert.equal(out.gets[0].port, 443);
    });
});


// ── 02 — CONTROL: ports that were given, and http ────────────────────────────

describe('02 - CONTROL: a port the url or the options name, and an http url', function () {

    it('CONTROL - an https url naming :443 downloads from port 443', async function () {
        var out = await drive('https://127.0.0.1:443/proof.pdf', { agent: tlsAgent(), ca: TLS.cert });
        assert.deepEqual(out.asked, [443]);
        assertDownloaded(out, 'TLSBYTES');
        assert.equal(out.tls[0].host, '127.0.0.1');
    });

    it('CONTROL - an https url naming another port goes to that port', async function () {
        var out = await drive('https://127.0.0.1:' + P + '/proof.pdf', { ca: TLS.cert });
        assertDownloaded(out, 'TLSBYTES');
        assert.equal(out.gets[0].port, P);
        assert.equal(out.tls[0].host, '127.0.0.1:' + P);
    });

    it('CONTROL - an http url that names no port goes to port 80', async function () {
        var out = await drive('http://127.0.0.1/proof.pdf', { agent: httpAgent() });
        assert.deepEqual(out.asked, [80]);
        assertDownloaded(out, 'HTTPBYTES');
        assert.equal(out.http[0].host, '127.0.0.1');
    });

    it('CONTROL - an http url with no options reaches http.get with port 80', async function () {
        var out = await drive('http://files.invalid/brand/logo.pdf');
        assert.equal(out.gets.length, 1);
        assert.equal(out.gets[0].module, 'http');
        assert.equal(out.gets[0].port, 80);
    });

    it('CONTROL - `options.port` is used when the url names no port', async function () {
        var out = await drive('https://127.0.0.1/proof.pdf', { port: P, ca: TLS.cert });
        assertDownloaded(out, 'TLSBYTES');
        assert.equal(out.gets[0].port, P);
    });

    it('CONTROL - a port in the url wins over `options.port`', async function () {
        var out = await drive('https://127.0.0.1:' + P + '/proof.pdf', { port: 1, ca: TLS.cert });
        assertDownloaded(out, 'TLSBYTES');
        assert.equal(out.gets[0].port, P);
    });
});


// ── 03 — CONTROL: the protocol-upgrade block's comparison ───────────────────

var APP = { proxy: { api: { hostname: 'api@proj' } } };
function envConf(host, port) {
    return { api: { dev: { host: host, hostname: 'https://' + host + ':' + port, server: { port: port } } } };
}

describe('03 - CONTROL: an app.proxy entry the url does not ask to override keeps its answer', function () {

    it('CONTROL - the url names the bundle\'s own port: no override', async function () {
        var out = await drive('https://127.0.0.1:' + P + '/proof.pdf', { agent: tlsAgent(), ca: TLS.cert },
            { app: APP, envConf: envConf('127.0.0.1', P) });
        assert.deepEqual(out.asked, [P]);
        assertDownloaded(out, 'TLSBYTES');
    });

    it('CONTROL - the entry names another host: no override', async function () {
        var out = await drive('https://127.0.0.1:443/proof.pdf', { agent: tlsAgent(), ca: TLS.cert },
            { app: APP, envConf: envConf('other.invalid', P) });
        assert.deepEqual(out.asked, [443]);
        assertDownloaded(out, 'TLSBYTES');
    });

    it('CONTROL - an http url that names no port, for a bundle on port 80: no override', async function () {
        var out = await drive('http://127.0.0.1/proof.pdf', { agent: httpAgent() },
            { app: APP, envConf: envConf('127.0.0.1', 80) });
        assert.deepEqual(out.asked, [80]);
        assertDownloaded(out, 'HTTPBYTES');
    });
});


// ── 03b — #B1120 ─────────────────────────────────────────────────────────────

describe('03b - #B1120: a url aimed at a proxied bundle\'s host on another port goes to that bundle\'s port', function () {

    it('the url names :443, the bundle listens on another port: the request goes to the bundle\'s port', async function () {
        var out = await drive('https://127.0.0.1:443/proof.pdf', { agent: tlsAgent(), ca: TLS.cert },
            { app: APP, envConf: envConf('127.0.0.1', P) });
        assert.equal(out.thrown, null, 'no throwError (pre-fix: the host became the port number; got: ' + JSON.stringify(out.thrown) + ')');
        assert.deepEqual(out.asked, [P]);
        assertDownloaded(out, 'TLSBYTES');
    });

    it('the url names no port: the request goes to the bundle\'s port', async function () {
        var out = await drive('https://127.0.0.1/proof.pdf', { agent: tlsAgent(), ca: TLS.cert },
            { app: APP, envConf: envConf('127.0.0.1', P) });
        assert.deepEqual(out.asked, [P]);
        assertDownloaded(out, 'TLSBYTES');
    });

    it('the bundle\'s port is closed: the request fails at once with ECONNREFUSED', async function () {
        var out = await drive('https://127.0.0.1:443/proof.pdf', { agent: tlsAgent(), ca: TLS.cert },
            { app: APP, envConf: envConf('127.0.0.1', CLOSED) });
        assert.deepEqual(out.asked, [CLOSED], 'the request went to the bundle\'s port');
        assert.equal(out.settled, 'resolved');
        assert.ok(out.thrown && out.thrown.code === 500, 'a 500 through throwError');
        assert.match(out.thrown.message, /ECONNREFUSED/);
        assert.ok(out.ms < 2000, 'settled in ' + out.ms + ' ms');
    });
});


// ── 04 — source ──────────────────────────────────────────────────────────────

/**
 * downloadFromURL's source, raw and with its comment lines stripped.
 *
 * @inner
 * @returns {{raw: string, code: string}}
 */
function downloadBody() {
    var src = fs.readFileSync(CONTROLLER_SRC, 'utf8');
    var head = 'this.downloadFromURL = async function';
    var tail = '} // EO this.downloadFromURL()';
    assert.equal(src.split(head).length - 1, 1, 'one downloadFromURL definition');
    assert.equal(src.split(tail).length - 1, 1, 'one end marker');
    var raw = src.slice(src.indexOf(head), src.indexOf(tail));
    var code = raw.split('\n').filter(function (l) {
        var t = l.trim();
        return !(t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0);
    }).join('\n');
    return { raw: raw, code: code };
}
function countOf(s, needle) { return s.split(needle).length - 1; }

describe('04 - #B1119 source', function () {

    it('the defaults carry no port: the old line survives in a comment only', function () {
        var b = downloadBody();
        assert.ok(countOf(b.raw, 'port: 80,') >= 1, 'the `was:` comment holds it (the strip is checked)');
        assert.equal(countOf(b.code, 'port: 80,'), 0);
    });

    it('the port follows the scheme when neither the url nor the options give one', function () {
        var b = downloadBody();
        assert.equal(countOf(b.code, "requestOptions.port = ( scheme == 'https' ) ? 443 : 80;"), 1);
    });
});

describe('04b - #B1120 source', function () {

    it('the protocol-upgrade block sets the port, not the host', function () {
        var b = downloadBody();
        assert.ok(countOf(b.raw, 'requestOptions.host = bundleObj.port') >= 1, 'the `was:` comment holds it (the strip is checked)');
        assert.equal(countOf(b.code, 'requestOptions.host = bundleObj.port'), 0);
        assert.equal(countOf(b.code, 'requestOptions.port = bundleObj.port'), 1);
    });
});
