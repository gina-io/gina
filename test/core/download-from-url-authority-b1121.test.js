'use strict';
/**
 * #B1121 — `self.downloadFromURL(url)` read the port with a pattern that matched `:<digits>/`
 * anywhere in the url, so a path segment such as `/files/a:1/x.pdf`, or a query holding another
 * url with a port, set the port; and it took the host as the text before the first `/` with its
 * first `:<digits>` cut out, so a `user:password@` stayed in the host and an IPv6 literal lost
 * part of its address (`[::1]` became `[:]`). The host and the port now come from the url's
 * authority only (what follows `scheme://` up to the first `/`, `?` or `#`), an IPv6 literal goes
 * without its brackets, as in Node's own request options for a URL, and a url carrying
 * credentials answers 500 through `throwError()`, naming `options.auth`, without a request. The
 * path goes out byte for byte as before.
 *
 * The method runs for real through `createTestInstance`. `http.get` / `https.get` are wrapped for
 * this file: they record the options that reach them, pass a request through to Node only when it
 * targets one of this file's own servers (127.0.0.1 and, when the host can bind it, ::1, each on an
 * ephemeral port), and answer every other request themselves with an error, so nothing leaves the
 * process and no name is resolved. throwError is replaced by a recorder. Arms marked CONTROL pin
 * unchanged behaviour and pass on the pre-fix bytes too. §05 pins the source with its comment
 * lines stripped.
 *
 * Seam: GINA_B1121_CONTROLLER — the controller module to require (a pre-fix copy must sit beside
 * the real file so its relative requires resolve).
 */

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var os       = require('node:os');
var http     = require('node:http');
var https    = require('node:https');
var nodePath = require('node:path');
var EventEmitter = require('node:events');
var { Writable } = require('node:stream');

// `_isLocalScope` is read once when the controller module loads: outside the local scope is the
// production default
process.env.NODE_SCOPE_IS_LOCAL = 'false';

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');
var CONTROLLER_SRC = process.env.GINA_B1121_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');

process.env.NODE_PATH = (process.env.NODE_PATH || '') + nodePath.delimiter + FW;
require('node:module').Module._initPaths();
require(nodePath.join(FW, 'helpers'));
require(nodePath.join(ROOT, 'utils', 'prototypes'));
setPath('gina', { core: nodePath.join(FW, 'core') });
// a framework global the bundle runtime defines (downloadFromURL builds a tmp path from it)
if (typeof(global.GINA_TMPDIR) == 'undefined') { global.GINA_TMPDIR = os.tmpdir(); }

var SuperController = require(CONTROLLER_SRC);

var BS = String.fromCharCode(92);
var CONF = {
    bundle: 'b', encoding: 'utf-8',
    content: { routing: { r: {} }, templates: { _common: {} } },
    server: { coreConfiguration: {
        statusCodes: { '200': 'OK', '500': 'Internal Server Error' },
        mime: { pdf: 'application/pdf' }
    } }
};
var CREDENTIALS_MESSAGE = 'The url carries credentials (`user:password@`): pass them in `options.auth` instead.';

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

var srv4 = null, srv6 = null, Q = 0, V6 = 0, V6_REASON = null;
var seen = [], gets = [];
var origGet = null, origHttpsGet = null;

/**
 * An emitter that fails on the next tick: what the wrapped get returns for a request it answers itself.
 *
 * @inner
 * @param {string} tag - the error message
 * @returns {EventEmitter}
 */
function refused(tag) {
    var ee = new EventEmitter();
    setImmediate(function () { ee.emit('error', new Error(tag)); });
    return ee;
}

/**
 * Wrap `http.get` / `https.get` for this file: record the options that reach them, pass a request
 * through only when it targets one of this file's servers, and answer every other request with an
 * error (no connection, no name resolution).
 *
 * @inner
 * @param {string} mod - `http` or `https`
 * @param {function} orig - Node's own get
 * @returns {function}
 */
function guarded(mod, orig) {
    return function (opts) {
        var o = opts || {};
        gets.push({ module: mod, host: o.host, port: o.port, path: o.path, auth: o.auth });
        var mine = (o.host === '127.0.0.1' && Q > 0 && Number(o.port) === Q)
            || (o.host === '::1' && V6 > 0 && Number(o.port) === V6);
        if (!mine) { return refused('B1121-TEST-NO-NETWORK'); }
        return orig.apply(this, arguments);
    };
}

/**
 * A server answering with fixed bytes and recording the path and the Host header it receives.
 *
 * @inner
 * @param {string} bytes - the response body
 * @returns {object} The server.
 */
function recordingServer(bytes) {
    return http.createServer(function (req, res) {
        seen.push({ path: req.url, host: req.headers.host, bytes: bytes });
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end(bytes);
    });
}

before(function (t, ready) {
    origGet = http.get;
    origHttpsGet = https.get;
    http.get = guarded('http', origGet);
    https.get = guarded('https', origHttpsGet);
    srv4 = recordingServer('V4BYTES');
    srv4.listen(0, '127.0.0.1', function () {
        Q = srv4.address().port;
        srv6 = recordingServer('V6BYTES');
        srv6.once('error', function (e) { V6 = 0; V6_REASON = e.code || e.message; srv6 = null; ready(); });
        srv6.listen(0, '::1', function () { V6 = srv6.address().port; ready(); });
    });
});
after(function () {
    if (origGet) { http.get = origGet; }
    if (origHttpsGet) { https.get = origHttpsGet; }
    [srv4, srv6].forEach(function (s) {
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
        req.on('error', function (e) { r.error = e.message; end(); });
        var timer = setTimeout(function () { r.error = r.error || 'TIMEOUT'; end(); }, 5000);
    });
}

/**
 * Run downloadFromURL with throwError replaced by a recorder, and report how it ended.
 *
 * @inner
 * @param {string} url - the url argument
 * @param {*} [opts] - the options argument (left out of the call when undefined)
 * @returns {Promise<object>} `{ settled, thrown, finished, body, seen, gets }`
 */
function drive(url, opts) {
    return new Promise(function (resolve) {
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {},
                _ginaReqId: 'REQ-B1121' },
            res: res, options: { rule: 'r', conf: CONF }
        });
        inst.getConfig = function () { return {}; };
        var out = { settled: 'pending', thrown: null, finished: false };
        var s0 = seen.length, g0 = gets.length, reported = false;
        inst.throwError = function (r, code, e) {
            out.thrown = { code: code, message: (e && e.message) ? e.message : String(e) };
            res.end();
        };
        res.on('finish', function () { out.finished = true; });
        function report() {
            if (reported) { return; }
            reported = true;
            out.body = res.body();
            out.seen = seen.slice(s0);
            out.gets = gets.slice(g0);
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

function assertOneGet(out, want) {
    assert.equal(out.gets.length, 1, 'one request reaches get (got: ' + JSON.stringify(out.gets) + ')');
    Object.keys(want).forEach(function (k) {
        assert.equal(out.gets[0][k], want[k], k + ' (got: ' + JSON.stringify(out.gets[0]) + ')');
    });
}

function assertCredentialsRefused(out, secret) {
    assert.ok(out.thrown, 'throwError answered (settled: ' + out.settled + ', gets: ' + JSON.stringify(out.gets) + ')');
    assert.equal(out.thrown.code, 500);
    assert.equal(out.thrown.message, CREDENTIALS_MESSAGE);
    assert.equal(out.thrown.message.indexOf(secret), -1, 'the message does not repeat the credentials');
    assert.equal(out.gets.length, 0, 'no request (got: ' + JSON.stringify(out.gets) + ')');
}


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - a request to this file\'s 127.0.0.1 server passes through and is answered', async function () {
        var r = await direct(http, { host: '127.0.0.1', port: Q, path: '/c0' });
        assert.equal(r.error, null);
        assert.equal(r.status, 200);
        assert.equal(r.body, 'V4BYTES');
    });

    it('CONTROL - any other request is answered by the guard, without a connection', async function () {
        var a = await direct(https, { host: 'h.invalid', port: 443, path: '/c1' });
        var b = await direct(http, { host: '127.0.0.1', port: (Q === 65535) ? Q - 1 : Q + 1, path: '/c2' });
        assert.equal(a.error, 'B1121-TEST-NO-NETWORK');
        assert.equal(b.error, 'B1121-TEST-NO-NETWORK');
        assert.equal(seen.filter(function (s) { return s.path === '/c1' || s.path === '/c2'; }).length, 0);
    });

    it('CONTROL - a url with no file extension is refused before any request', async function () {
        var out = await drive('https://h.invalid/x');
        assert.equal(out.thrown && out.thrown.code, 500);
        assert.ok(/extension not found/.test(out.thrown.message), out.thrown.message);
        assert.equal(out.gets.length, 0);
    });
});

// ── 01 — the port comes from the url's authority only ─────────────────────────

describe('01 - #B1121: the port comes from the url\'s authority only', function () {

    it('a path segment holding `:1/` does not set the port: the download comes from options.port', async function () {
        var out = await drive('http://127.0.0.1/files/a:1/x.pdf', { port: Q });
        assertDownloaded(out, 'V4BYTES');
        assert.deepEqual(out.seen.map(function (s) { return s.path; }), ['/files/a:1/x.pdf']);
        assert.equal(out.seen[0].host, '127.0.0.1:' + Q);
    });

    it('a query holding another url with a port does not set the port', async function () {
        var out = await drive('http://127.0.0.1/dl?src=http://o.invalid:9/x.pdf', { port: Q });
        assertDownloaded(out, 'V4BYTES');
        assert.deepEqual(out.seen.map(function (s) { return s.path; }), ['/dl?src=http://o.invalid:9/x.pdf']);
    });

    it('an https url with `:1/` in its path and no port reaches https.get with port 443', async function () {
        var out = await drive('https://h.invalid/files/a:1/x.pdf');
        assertOneGet(out, { module: 'https', host: 'h.invalid', port: 443, path: '/files/a:1/x.pdf' });
    });

    it('an empty port after the host is no port: the host loses its colon, the port is 443', async function () {
        var out = await drive('https://h.invalid:/x.pdf');
        assertOneGet(out, { module: 'https', host: 'h.invalid', port: 443, path: '/x.pdf' });
    });

    it('CONTROL - the url\'s own port comes before a later `:1/`', async function () {
        var out = await drive('https://h.invalid:8443/files/a:1/x.pdf');
        assertOneGet(out, { module: 'https', host: 'h.invalid', port: 8443, path: '/files/a:1/x.pdf' });
    });
});

// ── 02 — an IPv6 literal ──────────────────────────────────────────────────────

describe('02 - #B1121: an IPv6 literal keeps its address', function () {

    it('`https://[::1]:8443/x.pdf` reaches https.get as host `::1`, port 8443', async function () {
        var out = await drive('https://[::1]:8443/x.pdf');
        assertOneGet(out, { module: 'https', host: '::1', port: 8443, path: '/x.pdf' });
    });

    it('`https://[::1]/x.pdf` reaches https.get as host `::1`, port 443', async function () {
        var out = await drive('https://[::1]/x.pdf');
        assertOneGet(out, { module: 'https', host: '::1', port: 443, path: '/x.pdf' });
    });

    it('downloads from a server on [::1], whose Host header carries the brackets', async function (t) {
        if (!V6) { t.skip('::1 cannot be bound here: ' + V6_REASON); return; }
        var out = await drive('http://[::1]:' + V6 + '/x.pdf');
        assertDownloaded(out, 'V6BYTES');
        assert.equal(out.seen.length, 1);
        assert.equal(out.seen[0].path, '/x.pdf');
        assert.equal(out.seen[0].host, '[::1]:' + V6);
    });
});

// ── 03 — credentials in the url ───────────────────────────────────────────────

describe('03 - #B1121: a url carrying credentials answers 500 without a request', function () {

    it('`user:password@` is refused; the message names options.auth, not the credentials', async function () {
        assertCredentialsRefused(await drive('https://u:secret@h.invalid/x.pdf'), 'secret');
    });

    it('a numeric password is refused too', async function () {
        assertCredentialsRefused(await drive('https://u:123@h.invalid/x.pdf'), '123');
    });

    it('a percent-encoded user name is refused too', async function () {
        assertCredentialsRefused(await drive('https://u%40x:p@h.invalid/x.pdf'), 'u%40x');
    });

    it('options.auth does not make credentials in the url acceptable', async function () {
        assertCredentialsRefused(await drive('https://u:secret@h.invalid/x.pdf', { auth: 'a:b' }), 'secret');
    });

    it('CONTROL - options.auth alone reaches https.get as `auth`', async function () {
        var out = await drive('https://h.invalid/x.pdf', { auth: 'a:b' });
        assertOneGet(out, { module: 'https', host: 'h.invalid', port: 443, path: '/x.pdf', auth: 'a:b' });
    });
});

// ── 04 — everything else goes out as before ───────────────────────────────────

describe('04 - CONTROL: every other url goes out as before', function () {

    it('CONTROL - an https url without a port: h.invalid, 443, /x.pdf', async function () {
        assertOneGet(await drive('https://h.invalid/x.pdf'), { module: 'https', host: 'h.invalid', port: 443, path: '/x.pdf' });
    });

    it('CONTROL - an http url without a port goes to port 80', async function () {
        assertOneGet(await drive('http://h.invalid/x.pdf'), { module: 'http', host: 'h.invalid', port: 80, path: '/x.pdf' });
    });

    it('CONTROL - a url without a scheme goes over http to port 80', async function () {
        assertOneGet(await drive('h.invalid/x.pdf'), { module: 'http', host: 'h.invalid', port: 80, path: '/x.pdf' });
    });

    it('CONTROL - a port in the url wins over options.port', async function () {
        assertOneGet(await drive('https://h.invalid:9443/x.pdf', { port: 8443 }), { host: 'h.invalid', port: 9443 });
    });

    it('CONTROL - the path goes out byte for byte: latin1, a percent-escape, dot segments, a backslash, a #', async function () {
        var paths = ['/caf' + String.fromCharCode(233) + '/x.pdf', '/a%20b/x.pdf', '/a/../b/x.pdf', '/a' + BS + 'b/x.pdf', '/a#b/x.pdf'];
        for (var i = 0; i < paths.length; i++) {
            var out = await drive('https://h.invalid' + paths[i]);
            assertOneGet(out, { host: 'h.invalid', port: 443, path: paths[i] });
        }
    });

    it('CONTROL - the host keeps its case', async function () {
        assertOneGet(await drive('https://H.INVALID/x.pdf'), { host: 'H.INVALID', port: 443 });
    });
});

// ── 05 — the source ───────────────────────────────────────────────────────────

/**
 * downloadFromURL's text between its head and its end marker, and the same with its comment
 * lines dropped (the `was:` comments quote the old lines).
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

describe('05 - #B1121 source', function () {

    it('the old port pattern survives in a `was:` comment only', function () {
        var b = downloadBody();
        var line = 'var port = url.match(/' + BS + ':' + BS + 'd+' + BS + '//) || null;';
        assert.ok(countOf(b.raw, line) >= 1, 'the `was:` comment holds it (the strip is checked)');
        assert.equal(countOf(b.code, line), 0);
    });

    it('the old host split survives in a `was:` comment only', function () {
        var b = downloadBody();
        var line = "requestOptions.host = parts[0].replace(/" + BS + ":" + BS + "d+/, '');";
        assert.ok(countOf(b.raw, line) >= 1, 'the `was:` comment holds it (the strip is checked)');
        assert.equal(countOf(b.code, line), 0);
    });

    it('the host and the port are read from the authority, and credentials are refused', function () {
        var b = downloadBody();
        assert.equal(countOf(b.code, 'var urlAuthorityEnd = urlRest.search(/[' + BS + '/?#]/);'), 1);
        assert.equal(countOf(b.code, 'requestOptions.host = urlHost;'), 1);
        assert.equal(countOf(b.code, CREDENTIALS_MESSAGE), 1);
    });
});
