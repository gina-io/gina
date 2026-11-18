'use strict';
/**
 * #B1122 — redirect() took its status from `req.routing.param.code || 301` and
 * handed it to writeHead unchecked. `req.routing.param` is the raw routing config,
 * so a route that binds a URL segment under the name `code` (`"url": "/item/:code"`
 * with `"param": { "control": "item", "code": ":code" }`, the binding shape the
 * routing guide teaches for any key) left the literal `:code` there, and every
 * redirect that read that block failed:
 *   - over HTTP/1.1, `res.writeHead(':code')` threw RangeError
 *     ERR_HTTP_INVALID_STATUS_CODE inside the async method, so its promise
 *     rejected and the router's catch answered 500. The URL and route-name forms
 *     read the route that dispatched the action; the relative-path form reads the
 *     route its matcher resolves, when the matcher runs; HEAD as GET;
 *   - over HTTP/2, Node's compat writeHead does not validate the status, and the
 *     response went out as 200: a page showing the redirect's JSON body instead of
 *     a redirect.
 * Reproduced 2026-11-10 on develop with the real method and real responses.
 *
 * The fix honours only the five statuses whose Location the client follows (301,
 * 302, 303, 307, 308), read with writeHead's own coercion so every value that
 * redirected before still does; anything else answers the documented default, 301,
 * and a non-empty one is logged once per route and value.
 *
 * §01 — source pins (comment lines dropped): the helper, its status list, the call.
 * §02 — the real redirect() through createTestInstance, real HTTP/1.1 responses.
 * §03 — the same over HTTP/2 (an h2c server, the compat response).
 * §04 — the status values: honoured, refused, absent.
 * §05 — the log line: once per route and value.
 *
 * Seam: GINA_B1122_CONTROLLER names another controller file (a pre-fix copy beside
 * the real one) for a red-first run; the CONTROL tests pass on both.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');
var Module = require('module');

var FW      = require('../fw');
var SRC_CTL = process.env.GINA_B1122_CONTROLLER || path.join(FW, 'core/controller/controller.js');

/**
 * Drop full-line comments so a pin cannot be satisfied by prose.
 *
 * @inner
 * @param {string} src
 * @returns {string}
 */
function live(src) {
    return src.split('\n').filter(function (l) {
        var t = l.trim();
        return !( t.indexOf('//') === 0 || t.indexOf('/*') === 0 || t.indexOf('*') === 0 );
    }).join('\n');
}
function countOf(hay, needle) { return hay.split(needle).length - 1; }

var RAW  = fs.readFileSync(SRC_CTL, 'utf8');
var LIVE = live(RAW);

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('#B1122 §01 — the status redirect() answers with', function () {

    it('CONTROL: the redirect body still ends in writeHead(code, headInfos) (extraction control)', function () {
        assert.equal(countOf(LIVE, 'res.writeHead(code, headInfos);'), 1);
        assert.ok(LIVE.indexOf('this.redirect = async function(req, res, next) {') > -1);
    });

    it('a module-level redirectStatus() honours exactly 301, 302, 303, 307 and 308', function () {
        assert.equal(countOf(LIVE, 'function redirectStatus(value, rule) {'), 1, 'one definition');
        assert.ok(LIVE.indexOf('\nfunction redirectStatus(value, rule) {') > -1, 'at module level (no indentation)');
        assert.equal(countOf(LIVE, 'var REDIRECT_STATUSES = [301, 302, 303, 307, 308];'), 1, 'the status list');
    });

    it('the status line calls redirectStatus(); the old read survives in comments only', function () {
        assert.equal(countOf(LIVE, 'var code        = redirectStatus(req.routing.param.code, req.routing.rule || req.routing.name);'), 1);
        assert.equal(countOf(LIVE, 'req.routing.param.code || 301'), 0, 'not in live code');
        assert.ok(RAW.indexOf('// was: var code        = req.routing.param.code || 301;') > -1, 'kept as a was: comment');
    });
});

// ─── the driver ───────────────────────────────────────────────────────────────
var BOOTSTRAPPED = false;
function bootstrap() {
    if (BOOTSTRAPPED) return;
    process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
    Module._initPaths();
    require(path.join(FW, 'helpers'));
    require(path.join(FW, '..', '..', 'utils', 'prototypes'));
    setPath('gina', { core: path.join(FW, 'core') });
    BOOTSTRAPPED = true;
}

var URL_T = 'https://login.example.test/login';
var STATUS_CODES = { '200': 'OK', '301': 'Moved Permanently', '302': 'Found', '303': 'See Other', '404': 'Not Found', '500': 'Internal Server Error' };
var SuperController = null, LIB = null, REAL_GRBU = null;
var CUR = null;
var S1 = null, S2 = null, P1 = 0, P2 = 0;

/**
 * A route object as the engine leaves it on `req.routing`.
 *
 * @inner
 * @param {string} rule
 * @param {object} param
 * @returns {object}
 */
function route(rule, param) { return { rule: rule, name: rule, url: '/x/:code', bundle: 'b', method: 'GET', param: param }; }

function routingTable() {
    return {
        'login@b' : { url: '/login', bundle: 'b', method: 'GET', param: { control: 'login' } }
    };
}

function onRequest(req, res) {
    var rec = CUR;
    if (!rec || req.headers['x-arm'] !== rec.id) { res.writeHead(599); res.end('no arm'); return; }
    req.routing = JSON.parse(JSON.stringify(rec.current));
    req.get = {}; req.post = {}; req.params = {}; req._ginaReqId = 'REQ-B1122';
    var next = function () {};
    var p = null;
    try {
        var inst = SuperController.createTestInstance({ req: req, res: res, next: next, options: {
            rule: rec.current.rule, control: 'y', encoding: 'utf8', isXMLRequest: false, isUsingTemplate: false,
            conf: {
                bundle: 'b', env: 'dev', encoding: 'utf8',
                hostname: 'http://127.0.0.1:' + rec.port, host: '127.0.0.1:' + rec.port,
                server: { scheme: 'http', webroot: '/', protocolShort: rec.h2 ? 'http/2' : 'http/1.1',
                    coreConfiguration: { statusCodes: STATUS_CODES, mime: { html: 'text/html', json: 'application/json' } } },
                content: { routing: routingTable(), templates: { _common: {} } }
            } } });
        p = rec.objectForm ? inst.redirect(req, res, next) : inst.redirect.apply(inst, rec.args);
    } catch (e) {
        rec.syncThrow = e;
    }
    Promise.resolve(p).then(function () {
        rec.settled = 'resolved';
        if (!res.headersSent) { res.writeHead(598); res.end(); }
    }, function (err) {
        rec.settled = 'rejected';
        rec.rejection = err;
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('router stand-in: redirect() rejected'); }
    });
}

function h1(port, id, method) {
    return new Promise(function (resolve) {
        var r = http.request({ host: '127.0.0.1', port: port, path: '/x/abc', method: method, agent: false,
            headers: { 'x-arm': id, 'connection': 'close' } }, function (resp) {
            resp.resume();
            resp.on('end', function () { resolve({ status: resp.statusCode, location: resp.headers.location || null }); });
        });
        r.on('error', function (e) { resolve({ error: e.code || e.message }); });
        r.setTimeout(5000, function () { r.destroy(new Error('client timeout')); });
        r.end();
    });
}
function h2(port, id, method) {
    return new Promise(function (resolve) {
        var client = http2.connect('http://127.0.0.1:' + port);
        var out = { status: null, location: null }, done = false;
        function fin(extra) { if (done) return; done = true; try { client.close(); } catch (e) {} if (extra) Object.assign(out, extra); resolve(out); }
        client.on('error', function (e) { fin({ error: e.code || e.message }); });
        var s = client.request({ ':method': method, ':path': '/x/abc', 'x-arm': id });
        s.on('response', function (h) { out.status = h[':status']; out.location = h.location || null; });
        s.on('data', function () {});
        s.on('end', function () { fin(); });
        s.on('error', function (e) { fin({ error: e.code || e.message }); });
        s.setTimeout(5000, function () { fin({ error: 'client timeout' }); });
        s.end();
    });
}
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }

var ARM_N = 0;
/**
 * Drive the real redirect() once and read what the client received.
 *
 * @inner
 * @param {object} o - `{ current, args, method, h2, objectForm, target }`
 * @returns {Promise<{settled: string, rejection: ?Error, client: object, warns: string[], matcherCalls: number}>}
 */
async function drive(o) {
    var rec = { id: 'arm-' + (++ARM_N), current: o.current, args: o.args, objectForm: !!o.objectForm, h2: !!o.h2,
        port: o.h2 ? P2 : P1, target: o.target || null, settled: null, rejection: null, syncThrow: null, warns: [], matcherCalls: 0 };
    setContext('gina', { config: { bundle: 'b', env: 'dev', getRouting: routingTable,
        envConf: { b: { dev: { hostname: 'http://127.0.0.1:' + rec.port, server: { webroot: '/' } } } } } });
    CUR = rec;
    var client = o.h2 ? await h2(P2, rec.id, o.method || 'GET') : await h1(P1, rec.id, o.method || 'GET');
    for (var k = 0; k < 40 && rec.settled === null; k++) { await wait(10); }
    CUR = null;
    assert.equal(rec.syncThrow, null, 'harness: redirect() threw synchronously');
    return { settled: rec.settled, rejection: rec.rejection, client: client, warns: rec.warns, matcherCalls: rec.matcherCalls };
}

function restoreLogger(logger, saved) { Object.keys(saved).forEach(function (k) { logger[k] = saved[k]; }); }
var SAVED_LOGGER = {};

before(async function () {
    bootstrap();
    process.env.NODE_SCOPE_IS_LOCAL = 'false';
    delete require.cache[require.resolve(SRC_CTL)];
    SuperController = require(SRC_CTL);
    LIB = require(path.join(FW, 'lib'));
    ['debug', 'info', 'warn'].forEach(function (lv) {
        SAVED_LOGGER[lv] = LIB.logger[lv];
        LIB.logger[lv] = function () {
            var line = Array.prototype.slice.call(arguments).map(String).join(' ');
            if (lv === 'warn' && CUR && line.indexOf('which is not a redirect status') > -1) { CUR.warns.push(line); }
        };
    });
    REAL_GRBU = LIB.routing.getRouteByUrl;
    LIB.routing.getRouteByUrl = async function () {
        if (CUR) { CUR.matcherCalls++; }
        if (CUR && CUR.target) { return JSON.parse(JSON.stringify(CUR.target)); }
        return REAL_GRBU.apply(this, arguments);
    };
    S1 = http.createServer(onRequest);
    S2 = http2.createServer();
    S2.on('request', onRequest);
    P1 = await new Promise(function (r) { S1.listen(0, '127.0.0.1', function () { r(S1.address().port); }); });
    P2 = await new Promise(function (r) { S2.listen(0, '127.0.0.1', function () { r(S2.address().port); }); });
});

after(async function () {
    if (LIB) { LIB.routing.getRouteByUrl = REAL_GRBU; restoreLogger(LIB.logger, SAVED_LOGGER); }
    await Promise.all([S1, S2].filter(Boolean).map(function (s) { return new Promise(function (r) { s.close(function () { r(); }); }); }));
});

function assertRedirect(r, status, location) {
    assert.equal(r.settled, 'resolved', 'redirect() resolved' + (r.rejection ? ' (rejected: ' + r.rejection.code + ' ' + r.rejection.message + ')' : ''));
    assert.equal(r.client.status, status);
    assert.equal(r.client.location, location);
}

// ─── 02 — HTTP/1.1 ────────────────────────────────────────────────────────────
describe('#B1122 §02 — a route that binds `:code`, over HTTP/1.1', function () {

    it('the URL form answers 301 with its Location (was: writeHead threw, 500)', async function () {
        var r = await drive({ current: route('url-form@b', { control: 'y', code: ':code' }), args: [URL_T] });
        assertRedirect(r, 301, URL_T);
    });

    it('the route-name form answers 301', async function () {
        var r = await drive({ current: route('name-form@b', { control: 'y', code: ':code' }), args: ['login@b'] });
        assertRedirect(r, 301, '/login');
    });

    it('a relative path whose matched TARGET route binds `:code` answers 301', async function () {
        var r = await drive({ current: route('rel-form@b', { control: 'y' }), args: ['/login', false],
            target: { rule: 'target@b', name: 'target@b', url: '/login', bundle: 'b', method: 'GET', param: { control: 'login', code: ':code' } } });
        assert.equal(r.matcherCalls, 1, 'the matcher ran');
        assertRedirect(r, 301, '/login');
    });

    it('HEAD answers 301, as GET', async function () {
        var r = await drive({ current: route('head-form@b', { control: 'y', code: ':code' }), args: [URL_T], method: 'HEAD' });
        assertRedirect(r, 301, URL_T);
    });

    it('CONTROL: no `code` answers 301, `302` answers 302, POST answers 303', async function () {
        assertRedirect(await drive({ current: route('ctl-none@b', { control: 'y' }), args: [URL_T] }), 301, URL_T);
        assertRedirect(await drive({ current: route('ctl-302@b', { control: 'y', code: 302 }), args: [URL_T] }), 302, URL_T);
        assertRedirect(await drive({ current: route('ctl-post@b', { control: 'y', code: ':code' }), args: [URL_T], method: 'POST' }), 303, URL_T);
    });

    it('CONTROL: a redirect route declaring `code: 302` answers 302 (the route object form)', async function () {
        var r = await drive({ current: { rule: 'old@b', name: 'old@b', url: '/old', bundle: 'b', method: 'GET',
            param: { control: 'redirect', url: 'https://x.example.test/', code: 302 } }, objectForm: true });
        assertRedirect(r, 302, 'https://x.example.test/');
    });

    it('CONTROL: a relative path with one argument under webroot `/` does not call the matcher, and answers 301', async function () {
        var r = await drive({ current: route('rel-one@b', { control: 'y', code: ':code' }), args: ['/login'] });
        assert.equal(r.matcherCalls, 0);
        assertRedirect(r, 301, '/login');
    });
});

// ─── 03 — HTTP/2 ──────────────────────────────────────────────────────────────
describe('#B1122 §03 — the same route over HTTP/2 (compat response)', function () {

    it('answers 301 with its Location (was: 200, the redirect JSON as the page)', async function () {
        var r = await drive({ current: route('h2-form@b', { control: 'y', code: ':code' }), args: [URL_T], h2: true });
        assertRedirect(r, 301, URL_T);
    });

    it('CONTROL: no `code` answers 301', async function () {
        assertRedirect(await drive({ current: route('h2-none@b', { control: 'y' }), args: [URL_T], h2: true }), 301, URL_T);
    });
});

// ─── 04 — the status values ───────────────────────────────────────────────────
describe('#B1122 §04 — which values of `param.code` are honoured', function () {

    it('CONTROL: 303, "307", 308, " 302", "302.0" and [302] are honoured, as writeHead reads them', async function () {
        var cases = [ [303, 303], ['307', 307], [308, 308], [' 302', 302], ['302.0', 302], [[302], 302] ];
        for (var i = 0; i < cases.length; i++) {
            var r = await drive({ current: route('ok-' + i + '@b', { control: 'y', code: cases[i][0] }), args: [URL_T] });
            assertRedirect(r, cases[i][1], URL_T);
        }
    });

    it('200, 300, 304, 3020, "abc" and true answer 301', async function () {
        var values = [200, 300, 304, 3020, 'abc', true];
        for (var i = 0; i < values.length; i++) {
            var r = await drive({ current: route('no-' + i + '@b', { control: 'y', code: values[i] }), args: [URL_T] });
            assertRedirect(r, 301, URL_T);
        }
    });

    it('CONTROL: an absent, null, empty or zero `code` answers 301', async function () {
        var values = [undefined, null, '', 0];
        for (var i = 0; i < values.length; i++) {
            var p = { control: 'y' };
            if (typeof(values[i]) != 'undefined') { p.code = values[i]; }
            var r = await drive({ current: route('abs-' + i + '@b', p), args: [URL_T] });
            assertRedirect(r, 301, URL_T);
        }
    });
});

// ─── 05 — the log line ────────────────────────────────────────────────────────
describe('#B1122 §05 — a value that is not a redirect status is logged once per route and value', function () {

    it('a placeholder logs once, naming the route and the binding hint; the same route and value again logs nothing', async function () {
        var r1 = await drive({ current: route('once@b', { control: 'y', code: ':code' }), args: [URL_T] });
        assert.equal(r1.warns.length, 1);
        assert.ok(r1.warns[0].indexOf('route `once@b`') > -1, r1.warns[0]);
        assert.ok(r1.warns[0].indexOf('":code"') > -1, r1.warns[0]);
        assert.ok(r1.warns[0].indexOf('bind it under another name') > -1, r1.warns[0]);
        var r2 = await drive({ current: route('once@b', { control: 'y', code: ':code' }), args: [URL_T] });
        assert.equal(r2.warns.length, 0);
    });

    it('a mistyped status logs without the hint; another route with the same value logs again', async function () {
        var r1 = await drive({ current: route('typo-a@b', { control: 'redirect', url: URL_T, code: '3o2' }), objectForm: true });
        assert.equal(r1.warns.length, 1);
        assert.equal(r1.warns[0].indexOf('bind it under another name'), -1, r1.warns[0]);
        var r2 = await drive({ current: route('typo-b@b', { control: 'redirect', url: URL_T, code: '3o2' }), objectForm: true });
        assert.equal(r2.warns.length, 1);
    });

    it('CONTROL: an honoured or absent value logs nothing', async function () {
        assert.equal((await drive({ current: route('quiet-a@b', { control: 'y', code: 307 }), args: [URL_T] })).warns.length, 0);
        assert.equal((await drive({ current: route('quiet-b@b', { control: 'y' }), args: [URL_T] })).warns.length, 0);
    });
});
