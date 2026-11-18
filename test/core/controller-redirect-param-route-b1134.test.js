'use strict';
/**
 * #B1134 — a routing.json redirect route names its target in `param.route`:
 * `{ "control": "redirect", "route": "<rule>" }`, as redirect()'s JSDoc documents. The router
 * calls `controller.redirect(req, res, next)`, so the route reaches redirect() in its OBJECT form,
 * whose branch read `route = req.routing.param.route` and looked the name up as written, while
 * config.js keys every route `<rule lowercased>@<bundle>` and deletes the bare key:
 *   - a bare name (`"login"`), a mixed-case one (`"Login"`, `"Login@b"`) or one with an env suffix
 *     (`"login@b/dev"`) missed, and forward404Unless answered 404;
 *   - `"other@c"`, a route of another bundle, kept `bundle` at the current bundle, so no hostname
 *     was added: the Location was the other bundle's path, relative, on this host. The string form
 *     (`self.redirect('other@c')`) adds that bundle's hostname.
 * Only `"<rule lowercased>@<bundle>"` worked. Reproduced 2026-11-15 on develop, booted and in memory.
 *
 * The fix resolves `param.route` as the string form does since #B1125, as lib.routing.getRoute()
 * resolves a name: lowercased; without `@bundle` a route of the current bundle; with
 * `@bundle[/env]` that bundle and env, so the existing step that prefixes another bundle's hostname
 * runs.
 *
 * §01 — source pins (comment lines dropped).
 * §02 — the object form through createTestInstance, real HTTP/1.1 responses.
 * §03 — the same over HTTP/2 (an h2c server, the compat response).
 * §04 — another bundle's route: its hostname.
 * §05 — CONTROLS: the string form (#B1125) and the path form.
 *
 * Seam: GINA_B1134_CONTROLLER names another controller file (a pre-fix copy beside the real one)
 * for a red-first run; the CONTROL tests pass on both.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');
var Module = require('module');

var FW      = require('../fw');
var SRC_CTL = process.env.GINA_B1134_CONTROLLER || path.join(FW, 'core/controller/controller.js');

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

/**
 * The number of times `needle` occurs in `hay`.
 *
 * @inner
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function countOf(hay, needle) { return hay.split(needle).length - 1; }

var RAW  = fs.readFileSync(SRC_CTL, 'utf8');
var LIVE = live(RAW);

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('#B1134 §01 — how redirect() resolves `param.route`', function () {

    it('CONTROL: the object-form branch still reads `param.route` (extraction control)', function () {
        assert.equal(countOf(LIVE, 'route = req.routing.param.route;'), 1);
        assert.equal(countOf(RAW, '{ "control": "redirect", "route": "one-valid-route" }'), 1);
    });

    it('the name is split into `<name>@<bundle>` and an env suffix', function () {
        assert.equal(countOf(LIVE, 'var _jsonRoute = route.split(/\\//);'), 1);
        assert.equal(countOf(LIVE, 'env = _jsonRoute[1];'), 1);
        assert.equal(countOf(LIVE, 'bundle = _jsonRoute[1];'), 1);
    });

    it('both forms lowercase the name; without `@bundle` it names a route of the current bundle', function () {
        assert.equal(countOf(LIVE, "route = _jsonRoute[0].toLowerCase() +'@'+ bundle;"), 1);
        assert.equal(countOf(LIVE, "route = route.toLowerCase() +'@'+ bundle;"), 1);
    });

    it('CONTROL: the string form\'s #B1125 lines are unchanged', function () {
        assert.equal(countOf(LIVE, "rte = route = req.toLowerCase() +'@'+ bundle;"), 1);
        assert.equal(countOf(LIVE, "rte = route = rteArr[0].toLowerCase() +'@'+ bundle;"), 1);
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
var OTHER_HOSTNAME = 'http://127.0.0.1:19999';   // bundle `c`'s hostname: nothing listens there, only the Location is read
var SuperController = null, LIB = null;
var CUR = null;
var S1 = null, S2 = null, P1 = 0, P2 = 0;

/**
 * The webroot as a URL prefix: '' for `/`, '/dashboard' for `/dashboard/`.
 *
 * @inner
 * @param {string} wroot
 * @returns {string}
 */
function prefix(wroot) { return (wroot === '/') ? '' : wroot.replace(/\/$/, ''); }

/**
 * The routing table in gina's key shape (`<rule>@<bundle>`), the urls carrying the webroot.
 * `go@b` is the redirect route under test; `other@c` belongs to another bundle.
 *
 * @inner
 * @param {string} wroot
 * @returns {object}
 */
function routingTable(wroot) {
    return {
        'go@b'    : { url: prefix(wroot) + '/go', bundle: 'b', method: 'GET', param: { control: 'redirect' } },
        'login@b' : { url: prefix(wroot) + '/login', bundle: 'b', method: 'GET', param: { control: 'login' } },
        'other@c' : { url: '/c/other', bundle: 'c', method: 'GET', param: { control: 'other' } }
    };
}

function onRequest(req, res) {
    var rec = CUR;
    if (!rec || req.headers['x-arm'] !== rec.id) { res.writeHead(599); res.end('no arm'); return; }
    req.routing = { rule: 'go@b', name: 'go@b', url: prefix(rec.wroot) + '/go', bundle: 'b', method: 'GET', param: JSON.parse(JSON.stringify(rec.param)) };
    req.get = {}; req.post = {}; req.params = {}; req._ginaReqId = 'REQ-B1134';
    var next = function () {};
    var p = null;
    try {
        var inst = SuperController.createTestInstance({ req: req, res: res, next: next, options: {
            rule: 'go@b', control: 'redirect', encoding: 'utf8', isXMLRequest: false, isUsingTemplate: false,
            conf: {
                bundle: 'b', env: 'dev', encoding: 'utf8',
                hostname: 'http://127.0.0.1:' + rec.port, host: '127.0.0.1:' + rec.port,
                server: { scheme: 'http', webroot: rec.wroot, protocolShort: rec.h2 ? 'http/2' : 'http/1.1',
                    coreConfiguration: { statusCodes: STATUS_CODES, mime: { html: 'text/html', json: 'application/json' } } },
                content: { routing: routingTable(rec.wroot), templates: { _common: {} } }
            } } });
        // the router's call for a routing.json redirect route: controller[param.control](request, response, next)
        p = (rec.args) ? inst.redirect.apply(inst, rec.args) : inst.redirect(req, res, next);
    } catch (e) {
        rec.syncThrow = e;
    }
    Promise.resolve(p).then(function () {
        // a 404 goes through throwError, which may answer after redirect() resolved
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
        var r = http.request({ host: '127.0.0.1', port: port, path: '/go', method: method, agent: false,
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
        var s = client.request({ ':method': method, ':path': '/go', 'x-arm': id });
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
 * @param {object} o - `{ route, wroot, method, h2, param, args }`: `route` builds the redirect
 *   route's `param` (`{ control: 'redirect', route: <route> }`); `param` replaces it whole;
 *   `args` calls the string form instead of the object form
 * @returns {Promise<{settled: string, rejection: ?Error, client: object}>}
 */
async function drive(o) {
    var param = o.param || { control: 'redirect', route: o.route };
    var rec = { id: 'arm-' + (++ARM_N), args: o.args || null, wroot: o.wroot || '/', h2: !!o.h2, param: param,
        port: o.h2 ? P2 : P1, settled: null, rejection: null, syncThrow: null };
    var table = routingTable(rec.wroot);
    setContext('gina', { config: { bundle: 'b', env: 'dev', getRouting: function () { return table; },
        envConf: {
            b: { dev: { hostname: 'http://127.0.0.1:' + rec.port, server: { webroot: rec.wroot } } },
            c: { dev: { hostname: OTHER_HOSTNAME, server: { webroot: '/c/' } } }
        } } });
    CUR = rec;
    var client = o.h2 ? await h2(P2, rec.id, o.method || 'GET') : await h1(P1, rec.id, o.method || 'GET');
    for (var k = 0; k < 60 && rec.settled === null; k++) { await wait(10); }
    CUR = null;
    assert.equal(rec.syncThrow, null, 'harness: redirect() threw synchronously');
    return { settled: rec.settled, rejection: rec.rejection, client: client };
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

// ─── 02 — HTTP/1.1 ────────────────────────────────────────────────────────────
describe('#B1134 §02 — `param.route` names a route of the current bundle, over HTTP/1.1', function () {

    it('a bare name redirects to the route under the default webroot `/` (was: 404)', async function () {
        assertAnswer(await drive({ route: 'login', wroot: '/' }), 301, '/login');
    });

    it('a bare name redirects to the route under `/dashboard/` (was: 404)', async function () {
        assertAnswer(await drive({ route: 'login', wroot: '/dashboard/' }), 301, '/dashboard/login');
    });

    it('a name in mixed case redirects (was: 404; config.js lowercases rule names)', async function () {
        assertAnswer(await drive({ route: 'Login', wroot: '/' }), 301, '/login');
    });

    it('`Name@bundle` in mixed case redirects (was: 404)', async function () {
        assertAnswer(await drive({ route: 'Login@b', wroot: '/' }), 301, '/login');
    });

    it('`name@bundle/env` redirects (was: 404)', async function () {
        assertAnswer(await drive({ route: 'login@b/dev', wroot: '/' }), 301, '/login');
    });

    it('a POST answers 303, as with `route@bundle` (was: 404)', async function () {
        assertAnswer(await drive({ route: 'login', wroot: '/', method: 'POST' }), 303, '/login');
    });

    it('the redirect route\'s `code: 302` is honoured (was: 404)', async function () {
        assertAnswer(await drive({ param: { control: 'redirect', route: 'login', code: 302 }, wroot: '/' }), 302, '/login');
    });

    it('CONTROL: `name@bundle` in lowercase answers 301', async function () {
        assertAnswer(await drive({ route: 'login@b', wroot: '/' }), 301, '/login');
    });

    it('CONTROL: a name of no route answers 404, never a redirect', async function () {
        var r = await drive({ route: 'nosuch', wroot: '/' });
        assert.equal(r.settled, 'resolved', 'redirect() resolved' + (r.rejection ? ' (rejected: ' + r.rejection.name + ': ' + r.rejection.message + ')' : ''));
        assert.equal(r.client.status, 404);
        assert.equal(r.client.location, null);
    });
});

// ─── 03 — HTTP/2 ──────────────────────────────────────────────────────────────
describe('#B1134 §03 — the same over HTTP/2 (compat response)', function () {

    it('a bare name redirects to the route (was: 404)', async function () {
        assertAnswer(await drive({ route: 'login', wroot: '/', h2: true }), 301, '/login');
    });

    it('CONTROL: `name@bundle` answers 301', async function () {
        assertAnswer(await drive({ route: 'login@b', wroot: '/', h2: true }), 301, '/login');
    });
});

// ─── 04 — another bundle ──────────────────────────────────────────────────────
describe('#B1134 §04 — `param.route` names another bundle\'s route: that bundle\'s hostname', function () {

    it('`other@c` redirects to bundle `c`\'s hostname (was: a relative `/c/other` on this host)', async function () {
        assertAnswer(await drive({ route: 'other@c', wroot: '/' }), 301, OTHER_HOSTNAME + '/c/other');
    });

    it('`Other@c` in mixed case does too (was: 404)', async function () {
        assertAnswer(await drive({ route: 'Other@c', wroot: '/' }), 301, OTHER_HOSTNAME + '/c/other');
    });
});

// ─── 05 — the string form and the path form ───────────────────────────────────
describe('#B1134 §05 — CONTROLS: the other redirect forms', function () {

    it('CONTROL: the string form `self.redirect(\'login\')` answers 301 (#B1125)', async function () {
        assertAnswer(await drive({ param: { control: 'y' }, args: ['login'], wroot: '/' }), 301, '/login');
    });

    it('CONTROL: the string form `self.redirect(\'other@c\')` reaches bundle `c`\'s hostname', async function () {
        assertAnswer(await drive({ param: { control: 'y' }, args: ['other@c'], wroot: '/' }), 301, OTHER_HOSTNAME + '/c/other');
    });

    it('CONTROL: a redirect route\'s `param.path` answers 301', async function () {
        assertAnswer(await drive({ param: { control: 'redirect', path: '/login' }, wroot: '/' }), 301, '/login');
    });
});
