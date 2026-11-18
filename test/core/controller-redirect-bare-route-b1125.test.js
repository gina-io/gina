'use strict';
/**
 * #B1125 — redirect() given a route name without `@bundle` (`self.redirect('home')`,
 * documented by the method's JSDoc as « will use same bundle » and by the
 * controller guide) built the name it looked up from the webroot's characters:
 * `wroot.match(/[^/]/g).join('') +'-'+ name`. config.js keys every route
 * `<rule lowercased>@<bundle>`, so that name never existed:
 *   - under the default webroot `/`, `'/'.match(/[^/]/g)` is null and `.join`
 *     threw a TypeError inside the async method: its promise rejected and the
 *     router's catch answered 500, on every method and over HTTP/2 alike;
 *   - under any other webroot (`/dashboard/` → `dashboard-home`) the lookup
 *     missed and forward404Unless answered 404.
 * The `@` form did not lowercase its name, so `Home@b` missed the lowercased key
 * and answered 404. Reproduced 2026-11-15 on develop with the real method and
 * real responses.
 *
 * The fix resolves a name the way lib.routing.getRoute() does: a name without
 * `@bundle` names a route of the current bundle, and the name is lowercased in
 * both forms.
 *
 * §01 — source pins (comment lines dropped): both resolution lines.
 * §02 — the real redirect() through createTestInstance, real HTTP/1.1 responses.
 * §03 — the same over HTTP/2 (an h2c server, the compat response).
 * §04 — mixed case, a name of no route, an env suffix.
 *
 * Seam: GINA_B1125_CONTROLLER names another controller file (a pre-fix copy beside
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
var SRC_CTL = process.env.GINA_B1125_CONTROLLER || path.join(FW, 'core/controller/controller.js');

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
var OLD_JOIN = "wroot.match(/[^/]/g).join('') +'-'+ req";

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('#B1125 §01 — how redirect() resolves a route name', function () {

    it('CONTROL: the route-name branch is still there (extraction control)', function () {
        assert.equal(countOf(LIVE, 'if ( /\\@/.test(req) ) {'), 1);
        assert.equal(countOf(LIVE, 'req.routing.param.route = routing[rte]'), 1);
    });

    it('a name without `@bundle` resolves to `<name lowercased>@<current bundle>`; the webroot join survives in comments only', function () {
        assert.equal(countOf(LIVE, "rte = route = req.toLowerCase() +'@'+ bundle;"), 1);
        assert.equal(countOf(LIVE, OLD_JOIN), 0, 'not in live code');
        assert.ok(RAW.indexOf("// was: rte = route = ( req === '/'+conf.bundle+'-' ) ? req : " + OLD_JOIN + ';') > -1, 'kept as a was: comment');
    });

    it('the `@` form lowercases its name too', function () {
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
 *
 * @inner
 * @param {string} wroot
 * @returns {object}
 */
function routingTable(wroot) {
    return {
        'cur@b'   : { url: prefix(wroot) + '/x', bundle: 'b', method: 'GET', param: { control: 'y' } },
        'login@b' : { url: prefix(wroot) + '/login', bundle: 'b', method: 'GET', param: { control: 'login' } }
    };
}

function onRequest(req, res) {
    var rec = CUR;
    if (!rec || req.headers['x-arm'] !== rec.id) { res.writeHead(599); res.end('no arm'); return; }
    req.routing = { rule: 'cur@b', name: 'cur@b', url: prefix(rec.wroot) + '/x', bundle: 'b', method: 'GET', param: rec.param || { control: 'y' } };
    req.get = {}; req.post = {}; req.params = {}; req._ginaReqId = 'REQ-B1125';
    var next = function () {};
    var p = null;
    try {
        var inst = SuperController.createTestInstance({ req: req, res: res, next: next, options: {
            rule: 'cur@b', control: 'y', encoding: 'utf8', isXMLRequest: false, isUsingTemplate: false,
            conf: {
                bundle: 'b', env: 'dev', encoding: 'utf8',
                hostname: 'http://127.0.0.1:' + rec.port, host: '127.0.0.1:' + rec.port,
                server: { scheme: 'http', webroot: rec.wroot, protocolShort: rec.h2 ? 'http/2' : 'http/1.1',
                    coreConfiguration: { statusCodes: STATUS_CODES, mime: { html: 'text/html', json: 'application/json' } } },
                content: { routing: routingTable(rec.wroot), templates: { _common: {} } }
            } } });
        p = inst.redirect.apply(inst, rec.args);
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
        var r = http.request({ host: '127.0.0.1', port: port, path: '/x', method: method, agent: false,
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
        var s = client.request({ ':method': method, ':path': '/x', 'x-arm': id });
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
 * @param {object} o - `{ args, wroot, method, h2, param }`
 * @returns {Promise<{settled: string, rejection: ?Error, client: object}>}
 */
async function drive(o) {
    var rec = { id: 'arm-' + (++ARM_N), args: o.args, wroot: o.wroot || '/', h2: !!o.h2, param: o.param || null,
        port: o.h2 ? P2 : P1, settled: null, rejection: null, syncThrow: null };
    var table = routingTable(rec.wroot);
    setContext('gina', { config: { bundle: 'b', env: 'dev', getRouting: function () { return table; },
        envConf: { b: { dev: { hostname: 'http://127.0.0.1:' + rec.port, server: { webroot: rec.wroot } } } } } });
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
describe('#B1125 §02 — a route name without `@bundle`, over HTTP/1.1', function () {

    it('under the default webroot `/` it redirects to the route (was: TypeError, 500)', async function () {
        assertAnswer(await drive({ args: ['login'], wroot: '/' }), 301, '/login');
    });

    it('under `/dashboard/` it redirects to the route (was: 404)', async function () {
        assertAnswer(await drive({ args: ['login'], wroot: '/dashboard/' }), 301, '/dashboard/login');
    });

    it('under a webroot named like the bundle (`/b/`) it redirects to the route (was: 404)', async function () {
        assertAnswer(await drive({ args: ['login'], wroot: '/b/' }), 301, '/b/login');
    });

    it('the current route\'s `code: 302` is honoured, and a POST answers 303, as with `route@bundle`', async function () {
        assertAnswer(await drive({ args: ['login'], wroot: '/dashboard/', param: { control: 'y', code: 302 } }), 302, '/dashboard/login');
        assertAnswer(await drive({ args: ['login'], wroot: '/', method: 'POST' }), 303, '/login');
    });

    it('with `ignoreWebRoot` true it answers as `route@bundle` with `true` does', async function () {
        var bare = await drive({ args: ['login', true], wroot: '/' });
        var ctl = await drive({ args: ['login@b', true], wroot: '/' });
        assertAnswer(bare, ctl.client.status, ctl.client.location);
        assertAnswer(ctl, 301, 'login');
    });

    it('CONTROL: `route@bundle` answers 301 under `/`, `/dashboard/` and `/b/`', async function () {
        assertAnswer(await drive({ args: ['login@b'], wroot: '/' }), 301, '/login');
        assertAnswer(await drive({ args: ['login@b'], wroot: '/dashboard/' }), 301, '/dashboard/login');
        assertAnswer(await drive({ args: ['login@b'], wroot: '/b/' }), 301, '/b/login');
    });

    it('CONTROL: a relative path answers 301', async function () {
        assertAnswer(await drive({ args: ['/login'], wroot: '/' }), 301, '/login');
    });
});

// ─── 03 — HTTP/2 ──────────────────────────────────────────────────────────────
describe('#B1125 §03 — the same over HTTP/2 (compat response)', function () {

    it('a route name without `@bundle` redirects to the route (was: TypeError, 500)', async function () {
        assertAnswer(await drive({ args: ['login'], wroot: '/', h2: true }), 301, '/login');
    });

    it('CONTROL: `route@bundle` answers 301', async function () {
        assertAnswer(await drive({ args: ['login@b'], wroot: '/', h2: true }), 301, '/login');
    });
});

// ─── 04 — mixed case, a name of no route, an env suffix ───────────────────────
describe('#B1125 §04 — names as lib.routing.getRoute() resolves them', function () {

    it('a name without `@bundle` in mixed case redirects (config.js lowercases rule names)', async function () {
        assertAnswer(await drive({ args: ['Login'], wroot: '/' }), 301, '/login');
    });

    it('`Name@bundle` in mixed case redirects (was: 404)', async function () {
        assertAnswer(await drive({ args: ['Login@b'], wroot: '/' }), 301, '/login');
    });

    it('a name without `@bundle` that names no route answers 404, never a redirect', async function () {
        var r = await drive({ args: ['nosuch'], wroot: '/' });
        assert.equal(r.settled, 'resolved', 'redirect() resolved' + (r.rejection ? ' (rejected: ' + r.rejection.name + ': ' + r.rejection.message + ')' : ''));
        assert.equal(r.client.status, 404);
        assert.equal(r.client.location, null);
    });

    it('CONTROL: `route@bundle/env` keeps resolving', async function () {
        assertAnswer(await drive({ args: ['login@b/dev'], wroot: '/' }), 301, '/login');
    });

    it('CONTROL: `name@bundle` of no route answers 404', async function () {
        var r = await drive({ args: ['nosuch@b'], wroot: '/' });
        assert.equal(r.settled, 'resolved');
        assert.equal(r.client.status, 404);
        assert.equal(r.client.location, null);
    });
});
