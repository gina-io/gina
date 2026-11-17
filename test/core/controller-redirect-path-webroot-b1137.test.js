'use strict';
/**
 * #B1137 — a redirect that uses `param.path` under a non-root webroot.
 *
 * A routing.json redirect route (`"param": { "control": "redirect", "path": "/general" }`) and a
 * custom action that hands its request to `self.redirect(req, res, next)` read `param.path`. Under a
 * webroot such as `/web/`, config.js meant to prefix that path with the webroot at boot, but its
 * conditional bound to the whole sum (`localWroot + (test) ? a : b`), so the path only lost its
 * first character and the Location was relative: `/general` sent `general`, `general` sent `eneral`
 * and `/` an empty Location. The fix leaves `param.path` as written in config.js, and redirect()
 * adds the webroot when its request-object form uses `param.path`: not for the string form, a
 * `route` target, `ignoreWebRoot`, the webroot `/` or an absolute URL.
 *
 * This file drives the REAL redirect() through createTestInstance, with real HTTP/1.1 and HTTP/2
 * (h2c, the compat response the engine writes to) responses, and `param.path` as config.js now
 * leaves it. A pre-fix redirect() answers such a path without the webroot. The booted test
 * (test/integration/container-boot-redirect-path-webroot-b1137.test.js) covers routing.json end to
 * end; the scaffold has no cleartext HTTP/2 port, hence HTTP/2 here.
 *
 * §01 — source pins (comment lines dropped): the insert in redirect(); the rewrite gone from config.js.
 * §02 — HTTP/1.1: paths that get the webroot, a POST, `code`, a custom action; the controls.
 * §03 — HTTP/2: the same shapes.
 *
 * Seams: GINA_B1137_CONTROLLER names another controller file (a pre-fix copy beside the real one)
 * and GINA_B1137_CONFIG another config.js, for a red-first run; the CONTROL tests pass on both.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');
var Module = require('module');

var FW      = require('../fw');
var SRC_CTL = process.env.GINA_B1137_CONTROLLER || path.join(FW, 'core/controller/controller.js');
var SRC_CFG = process.env.GINA_B1137_CONFIG || path.join(FW, 'core/config.js');

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

var RAW      = fs.readFileSync(SRC_CTL, 'utf8');
var LIVE     = live(RAW);
var CFG_RAW  = fs.readFileSync(SRC_CFG, 'utf8');
var CFG_LIVE = live(CFG_RAW);

var ANCHOR  = "var path        = originalUrl || req.routing.param.path || '';";
var NEXT    = 'var url         = req.routing.param.url;';
var JOIN    = "path = wroot + ( ( path.charAt(0) === '/' ) ? path.substring(1) : path );";
var OLD_CFG = "routing[rule].param.path = localWroot + ( /^\\//.test(routing[rule].param.path) ) ? routing[rule].param.path.substring(1) : routing[rule].param.path";

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('#B1137 §01 — redirect() adds the webroot to `param.path`; config.js no longer rewrites it', function () {

    it('CONTROL: the anchor line and the line after it are still there (extraction control)', function () {
        assert.equal(countOf(LIVE, ANCHOR), 1);
        assert.equal(countOf(LIVE, NEXT), 1);
    });

    it('the webroot join sits between the anchor and the next line, behind its five conditions', function () {
        var a = LIVE.indexOf(ANCHOR), n = LIVE.indexOf(NEXT), j = LIVE.indexOf(JOIN);
        assert.equal(countOf(LIVE, JOIN), 1, 'the join, once, in live code');
        assert.ok(a > -1 && j > a && n > j, 'anchor < join < next');
        var block = LIVE.substring(a, j);
        ['!originalUrl', '&& !route', '&& path', '&& !req.routing.param.ignoreWebRoot', '&& wroot.length > 1',
            "&& !/^([a-z][a-z0-9+.\\-]*:)?\\/\\//i.test(path)"].forEach(function (c) {
            assert.ok(block.indexOf(c) > -1, 'condition: ' + c);
        });
    });

    it('config.js leaves `param.path` as written: the rewrite survives as a `was:` comment only', function () {
        assert.equal(countOf(CFG_LIVE, 'routing[rule].param.path = localWroot'), 0, 'not in live code');
        assert.equal(countOf(CFG_RAW, '// was:     ' + OLD_CFG), 1, 'kept as a was: comment');
    });

    it('CONTROL: config.js\'s live extraction is not empty (the url rewrite test below the old block is live)', function () {
        assert.equal(countOf(CFG_LIVE, "if ( typeof(routing[rule].param.ignoreWebRoot) == 'undefined' || !routing[rule].param.ignoreWebRoot ) {"), 1);
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

var STATUS_CODES = { '200': 'OK', '301': 'Moved Permanently', '302': 'Found', '303': 'See Other', '404': 'Not Found', '500': 'Internal Server Error' };
var SuperController = null, LIB = null;
var CUR = null;
var S1 = null, S2 = null, P1 = 0, P2 = 0;

/**
 * The webroot as a URL prefix: '' for `/`, '/web' for `/web/`.
 *
 * @inner
 * @param {string} wroot
 * @returns {string}
 */
function prefix(wroot) { return (wroot === '/') ? '' : wroot.replace(/\/$/, ''); }

/**
 * The routing table in gina's key shape (`<rule>@<bundle>`), the urls carrying the webroot.
 *
 * @inner
 * @param {string} wroot
 * @param {object} param - The current route's `param`
 * @returns {object}
 */
function routingTable(wroot, param) {
    return {
        'go@b'    : { url: prefix(wroot) + '/x', bundle: 'b', method: 'GET, POST', param: param },
        'login@b' : { url: prefix(wroot) + '/login', bundle: 'b', method: 'GET', param: { control: 'login' } }
    };
}

function onRequest(req, res) {
    var rec = CUR;
    if (!rec || req.headers['x-arm'] !== rec.id) { res.writeHead(599); res.end('no arm'); return; }
    var param = JSON.parse(JSON.stringify(rec.param));
    req.routing = { rule: 'go@b', name: 'go@b', url: prefix(rec.wroot) + '/x', bundle: 'b', method: 'GET, POST', param: param };
    req.get = {}; req.post = {}; req.params = {}; req._ginaReqId = 'REQ-B1137';
    var next = function () { rec.nextCalls++; };
    var p = null;
    try {
        var inst = SuperController.createTestInstance({ req: req, res: res, next: next, options: {
            rule: 'go@b', control: param.control || 'b1137custom', encoding: 'utf8', isXMLRequest: false, isUsingTemplate: false,
            conf: {
                bundle: 'b', env: 'dev', encoding: 'utf8',
                hostname: 'http://127.0.0.1:' + rec.port, host: '127.0.0.1:' + rec.port,
                server: { scheme: 'http', webroot: rec.wroot, protocolShort: rec.h2 ? 'http/2' : 'http/1.1',
                    coreConfiguration: { statusCodes: STATUS_CODES, mime: { html: 'text/html', json: 'application/json' } } },
                content: { routing: routingTable(rec.wroot, param), templates: { _common: {} } }
            } } });
        // the router's `redirect` control and a custom action both call the request-object form
        p = (rec.args) ? inst.redirect.apply(inst, rec.args) : inst.redirect(req, res, next);
    } catch (e) {
        rec.syncThrow = e;
    }
    Promise.resolve(p).then(function () {
        var tries = 0;
        (function poll() {
            if (res.headersSent || tries >= 12) {
                if (!res.headersSent) { res.writeHead(598); res.end(); }
                rec.settled = 'resolved';
                return;
            }
            tries++; setTimeout(poll, 25);
        })();
    }, function (err) {
        rec.settled = 'rejected';
        rec.rejection = err;
        if (!res.headersSent) { res.writeHead(500, { 'content-type': 'text/plain' }); res.end('router stand-in: redirect() rejected'); }
    });
}

function h1(port, id, method) {
    return new Promise(function (resolve) {
        var r = http.request({ host: '127.0.0.1', port: port, path: '/x', method: method, agent: false,
            headers: { 'x-arm': id, 'connection': 'close' } }, function (resp) {
            resp.resume();
            resp.on('end', function () { resolve({ status: resp.statusCode, location: (typeof(resp.headers.location) == 'string') ? resp.headers.location : null }); });
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
        var s = client.request({ ':method': method, ':path': '/x', 'x-arm': id });
        s.on('response', function (h) { out.status = h[':status']; out.location = (typeof(h.location) == 'string') ? h.location : null; });
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
 * @param {object} o - `{ param, wroot, method, h2, args }`: `args` calls the string form, else the request-object form
 * @returns {Promise<{settled: string, rejection: ?Error, nextCalls: number, client: object}>}
 */
async function drive(o) {
    var rec = { id: 'arm-' + (++ARM_N), args: o.args || null, wroot: o.wroot || '/web/', h2: !!o.h2,
        param: o.param || { control: 'redirect' }, port: o.h2 ? P2 : P1,
        settled: null, rejection: null, syncThrow: null, nextCalls: 0 };
    var table = routingTable(rec.wroot, rec.param);
    setContext('gina', { config: { bundle: 'b', env: 'dev', getRouting: function () { return table; },
        envConf: { b: { dev: { hostname: 'http://127.0.0.1:' + rec.port, server: { webroot: rec.wroot } } } } } });
    CUR = rec;
    var client = o.h2 ? await h2(P2, rec.id, o.method || 'GET') : await h1(P1, rec.id, o.method || 'GET');
    for (var k = 0; k < 60 && rec.settled === null; k++) { await wait(10); }
    CUR = null;
    assert.equal(rec.syncThrow, null, 'harness: redirect() threw synchronously');
    return { settled: rec.settled, rejection: rec.rejection, nextCalls: rec.nextCalls, client: client };
}

var SAVED_LOGGER = {};

before(async function () {
    bootstrap();
    process.env.NODE_SCOPE_IS_LOCAL = 'false';
    delete require.cache[require.resolve(SRC_CTL)];
    SuperController = require(SRC_CTL);
    LIB = require(path.join(FW, 'lib'));
    ['debug', 'info', 'warn', 'error'].forEach(function (lv) {
        SAVED_LOGGER[lv] = LIB.logger[lv];
        LIB.logger[lv] = function () {};
    });
    S1 = http.createServer(onRequest);
    S2 = http2.createServer();
    S2.on('request', onRequest);
    P1 = await new Promise(function (r) { S1.listen(0, '127.0.0.1', function () { r(S1.address().port); }); });
    P2 = await new Promise(function (r) { S2.listen(0, '127.0.0.1', function () { r(S2.address().port); }); });
});

after(async function () {
    if (LIB) { Object.keys(SAVED_LOGGER).forEach(function (k) { LIB.logger[k] = SAVED_LOGGER[k]; }); }
    await Promise.all([S1, S2].filter(Boolean).map(function (s) { return new Promise(function (r) { s.close(function () { r(); }); }); }));
});

function assertAnswer(r, status, location) {
    assert.equal(r.settled, 'resolved', 'redirect() resolved' + (r.rejection ? ' (rejected: ' + r.rejection.name + ': ' + r.rejection.message + ')' : ''));
    assert.equal(r.client.status, status);
    assert.equal(r.client.location, location);
}
function redirectParam(extra) { return Object.assign({ control: 'redirect' }, extra); }

// ─── 02 — HTTP/1.1 ────────────────────────────────────────────────────────────
describe('#B1137 §02 — a redirect that uses `param.path` under the webroot `/web/`, over HTTP/1.1', function () {

    it('`/b1137/deep/home` answers `/web/b1137/deep/home`', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: '/b1137/deep/home' }) }), 301, '/web/b1137/deep/home');
    });

    it('`/general` and `general` both answer `/web/general`', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: '/general' }) }), 301, '/web/general');
        assertAnswer(await drive({ param: redirectParam({ path: 'general' }) }), 301, '/web/general');
    });

    it('`/` answers the webroot itself, `/web/`', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: '/' }) }), 301, '/web/');
    });

    it('a POST answers 303 to `/web/general`, and the route\'s `code: 302` is honoured', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: '/general' }), method: 'POST' }), 303, '/web/general');
        assertAnswer(await drive({ param: redirectParam({ path: '/general', code: 302 }) }), 302, '/web/general');
    });

    it('a custom action\'s `self.redirect(req, res, next)` on a route that declares `param.path` (no `control`) answers `/web/b1137/deep/home`', async function () {
        assertAnswer(await drive({ param: { path: '/b1137/deep/home' } }), 301, '/web/b1137/deep/home');
    });

    it('CONTROL: `ignoreWebRoot` with the full path answers the path as written', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: '/web/preferences/general', ignoreWebRoot: true }) }), 301, '/web/preferences/general');
    });

    it('CONTROL: under the webroot `/` the path is answered as written', async function () {
        assertAnswer(await drive({ wroot: '/', param: redirectParam({ path: '/b1137/home' }) }), 301, '/b1137/home');
    });

    it('CONTROL: an absolute URL, with a scheme or protocol-relative, is answered as written', async function () {
        assertAnswer(await drive({ param: redirectParam({ path: 'https://example.com/b1137' }) }), 301, 'https://example.com/b1137');
        assertAnswer(await drive({ param: redirectParam({ path: '//example.com/b1137' }) }), 301, '//example.com/b1137');
    });

    it('CONTROL: a `route` target answers the target route\'s url, its webroot once', async function () {
        assertAnswer(await drive({ param: redirectParam({ route: 'login@b' }) }), 301, '/web/login');
    });

    it('CONTROL: the string form `self.redirect(\'/login\')` adds the webroot once, as before', async function () {
        assertAnswer(await drive({ args: ['/login'] }), 301, '/web/login');
    });
});

// ─── 03 — HTTP/2 ──────────────────────────────────────────────────────────────
describe('#B1137 §03 — the same over HTTP/2 (compat response)', function () {

    it('`/b1137/deep/home`, `/general`, `general` and `/` answer under `/web/`', async function () {
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: '/b1137/deep/home' }) }), 301, '/web/b1137/deep/home');
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: '/general' }) }), 301, '/web/general');
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: 'general' }) }), 301, '/web/general');
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: '/' }) }), 301, '/web/');
    });

    it('a POST answers 303 to `/web/general`', async function () {
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: '/general' }), method: 'POST' }), 303, '/web/general');
    });

    it('a custom action\'s `self.redirect(req, res, next)` answers `/web/b1137/deep/home`', async function () {
        assertAnswer(await drive({ h2: true, param: { path: '/b1137/deep/home' } }), 301, '/web/b1137/deep/home');
    });

    it('CONTROL: `ignoreWebRoot` and the webroot `/` answer the path as written', async function () {
        assertAnswer(await drive({ h2: true, param: redirectParam({ path: '/web/preferences/general', ignoreWebRoot: true }) }), 301, '/web/preferences/general');
        assertAnswer(await drive({ h2: true, wroot: '/', param: redirectParam({ path: '/b1137/home' }) }), 301, '/b1137/home');
    });
});
