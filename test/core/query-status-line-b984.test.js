'use strict';
/**
 * self.query() — a 4xx / 5xx answer whose body carries no gina `status` is an error carrying its HTTP status (#B984)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http` and `node:http2` upstreams (the
 * standalone bootstrap of query-h2-stream-timeout-b967.test.js), with gina's own status-code map (`core/status.codes`,
 * read as core/config.js reads it).
 *
 * Up to 0.7.6 both transports decided error vs success on the BODY's `status` field only, and read the response's
 * status line for HTTP/2's 502 alone. So a 4xx or 5xx whose body carried no `status` (an empty body, text, JSON
 * without `status`, the HTML page a proxy in front of a bundle answers with itself) reached the caller as a
 * success: `{ status: 200, empty: true }` for an empty body over HTTP/2, `''` over HTTP/1.1, the body otherwise.
 * Since 0.7.7 such an answer, for a status the map knows, becomes `{ status, error, message }` (`error` the map's
 * label, `message` the body text, the JSON text, or the label for an empty body) and is delivered by the branch
 * that delivers gina's own body-`status` errors. A body carrying `status` still decides, and a status the map does
 * not know (599) is still delivered as a success.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var http2 = require('node:http2');
var util = require('util');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

// gina's own status-code map, read the way core/config.js reads it
var CODES = requireJSON(path.join(FW, 'core', 'status.codes'));
delete CODES._comment;

function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }

var HTML503 = '<html><body><h1>503 Service Temporarily Unavailable</h1></body></html>';
var HTML504 = '<html><body><h1>504 Gateway Time-out</h1></body></html>';
var HTML599 = '<html><body>599 Network Connect Timeout</body></html>';
var GINA404 = '{"status":404,"error":"Not Found","message":"gone"}';

// What both upstreams answer, per path: [HTTP status, content-type, body]
var ANSWERS = {
    '/fast'    : [200, 'application/json', '{"ok":true}'],
    '/js404'   : [404, 'application/json', GINA404],
    '/j200s404': [200, 'application/json', GINA404],
    '/empty'   : [200, null, undefined],
    '/e204'    : [204, null, undefined],
    '/e404'    : [404, null, undefined],
    '/t404'    : [404, 'text/plain', 'Not Found'],
    '/j404'    : [404, 'application/json', '{"error":"Not Found"}'],
    '/h503'    : [503, 'text/html', HTML503],
    '/h504'    : [504, 'text/html', HTML504],
    '/h599'    : [599, 'text/html', HTML599]
};
function answerFor(p) { return ANSWERS[String(p).split('?')[0]] || [500, 'text/plain', 'unknown path']; }

function listen(server, S) {
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); });
    });
}
function mkUpstream2() {
    var server = http2.createServer();
    var S = { sessions: [] };
    server.on('session', function (s) { S.sessions.push(s); s.on('error', function () {}); });
    server.on('stream', function (stream, headers) {
        var a = answerFor(headers[':path']);
        stream.on('error', function () {});
        stream.on('data', function () {});
        var h = { ':status': a[0] };
        if (a[1]) { h['content-type'] = a[1]; }
        try { stream.respond(h); stream.end(a[2]); } catch (e) {}
    });
    return listen(server, S);
}
function mkUpstream1() {
    var S = { sockets: [] };
    var server = http.createServer(function (req, res) {
        var a = answerFor(req.url);
        req.on('data', function () {});
        var h = {};
        if (a[1]) { h['content-type'] = a[1]; }
        res.writeHead(a[0], h);
        res.end(a[2]);
    });
    server.on('connection', function (sock) { S.sockets.push(sock); });
    return listen(server, S);
}
function closeUpstream(u) {
    if (!u) { return; }
    (u.S.sessions || u.S.sockets).forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { u.server.close(); } catch (e) {}
}

var thrown = [];
function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r984', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb984', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: CODES, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r984: {} } }
            },
            rule: 'r984', control: 'act', bundle: 'tb984', controller: '/controllers/t984.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t984'), _cacheIsEnabled: 'false', _http2Sessions: [] };
    // a non-2xx goes to the callback (#Q1, #B405): an answer through throwError() is recorded and fails the arm
    inst.throwError = function (e) { thrown.push(e); };
    return inst;
}
function opts(o) {
    return { protocol: o.h1 ? 'http/1.1' : 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + o.port, host: '127.0.0.1',
             port: o.port, path: o.path, method: o.method || 'GET' };
}
// One self.query() call in callback form; resolves with { err, result }.
function q(inst, o) {
    return new Promise(function (res) {
        inst.query(opts(o), o.data || {}, function (err, result) { res({ err: err, result: result }); });
    });
}
function assertError(r, status, message, label) {
    assert.ok(r.err, label + ': delivered as an error, got the success ' + JSON.stringify(r.result));
    assert.equal(r.err.status, status, label + ': the HTTP status');
    assert.equal(r.err.error, CODES[String(status)], label + ': the map\'s label');
    if (typeof message !== 'undefined') { assert.equal(r.err.message, message, label + ': the message'); }
    assert.equal(r.result, undefined, label + ': no data beside the error');
}
function assertSuccess(r, label) {
    assert.equal(r.err, false, label + ': delivered as a success, got the error ' + JSON.stringify(r.err));
}

// Every client session the controller opens (it calls the module's connect at request time).
var _connect = http2.connect;
var opened = [];

before(function () {
    http2.connect = function () { var s = _connect.apply(http2, arguments); opened.push(s); return s; };
    setContext('bundle', 'tb984');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb984: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65529 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65529'
        } } } }
    });
});
after(function () {
    http2.connect = _connect;
    opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
});

describe('01 - source: each transport reads the status line before its body-status decision', function () {
    var live = strip(fs.readFileSync(SOURCE, 'utf8'));
    var H1 = 'var handleHTTP1ClientRequest = function(';
    var H2 = 'var handleHTTP2ClientRequest = function(';
    var H1_DECISION = "if ( data.status && !/^2/.test(data.status) && typeof(local.options.conf.server.coreConfiguration.statusCodes[data.status]) != 'undefined' ) {";
    var H2_DECISION = "if (data.status && !/^2/.test(data.status) && typeof statusCodes[data.status] !== 'undefined') {";
    var h1 = live.indexOf(H1), h2 = live.indexOf(H2);
    var s1 = live.slice(h1, h2);
    var s2 = live.slice(h2, live.indexOf(H2_DECISION, h2) + H2_DECISION.length);

    it('the anchors are found once in each handler (controls: they hold on the code before the change too)', function () {
        assert.ok(h1 > -1 && h2 > h1, 'both handlers are found, HTTP/1.1 first');
        assert.equal(live.indexOf(H1, h1 + 1), -1, 'one HTTP/1.1 handler');
        assert.equal(live.indexOf(H2, h2 + 1), -1, 'one HTTP/2 handler');
        assert.equal(s1.split(H1_DECISION).length - 1, 1, 'one body-status decision in the HTTP/1.1 handler');
        assert.equal(s2.split(H2_DECISION).length - 1, 1, 'the HTTP/2 slice ends at its body-status decision');
        assert.equal(s2.split('data = { status: 200, empty: true };').length - 1, 1, 'the empty stamp is still live, for an empty 2xx and an unmapped status');
        assert.equal(s2.split('local.res.writeHead(data.status, data.headers)').length - 1, 1, 'the HTTP/2 redirect intercept');
    });

    it('HTTP/1.1: the status line is read after the body is parsed, and before the decision', function () {
        var parse = s1.indexOf('data = JSON.parse(data)', s1.indexOf("res.on('end', function onEnd(err) {"));
        var read = s1.indexOf('statusCodes[res.statusCode]');
        var decision = s1.indexOf(H1_DECISION);
        assert.ok(read > -1, 'the HTTP/1.1 handler reads the status line against the map');
        assert.equal(s1.indexOf('statusCodes[res.statusCode]', read + 1), -1, 'at one site');
        assert.ok(parse > -1 && read > parse && read < decision, 'between the JSON parse and the decision');
    });

    it('HTTP/2: an empty mapped 4xx / 5xx is left empty, and the status line is read above the redirect intercept', function () {
        var emptyIf = s2.indexOf('if (!data || data.trim() === "") {');
        var stamp = s2.indexOf('data = { status: 200, empty: true };');
        var parse = s2.indexOf('data = JSON.parse(data);', stamp);
        var redirect = s2.indexOf('local.res.writeHead(data.status, data.headers)');
        var first = s2.indexOf('statusCodes[httpStatus]');
        var second = s2.indexOf('statusCodes[httpStatus]', first + 1);
        assert.ok(first > -1 && second > first, 'the HTTP/2 handler reads the status line against the map at two sites');
        assert.equal(s2.indexOf('statusCodes[httpStatus]', second + 1), -1, 'at two sites only');
        assert.ok(emptyIf > -1 && first > emptyIf && first < stamp, 'the empty branch tests the status before it stamps an empty success');
        assert.ok(parse > -1 && second > parse && second < redirect, 'the decision input is built after the JSON parse, above the redirect intercept');
    });
});

describe('02 - HTTP/2: a 4xx / 5xx without a gina status is an error carrying its status', function () {
    var u = null, inst = null;
    before(async function () { u = await mkUpstream2(); inst = makeInst(); thrown.length = 0; });
    after(function () { closeUpstream(u); });

    it('GET: an empty, a text and a JSON-without-status 404, and a proxy\'s HTML 503 / 504 page', async function () {
        assertError(await q(inst, { port: u.port, path: '/e404' }), 404, CODES['404'], 'empty 404');
        assertError(await q(inst, { port: u.port, path: '/t404' }), 404, 'Not Found', 'text 404');
        assertError(await q(inst, { port: u.port, path: '/j404' }), 404, '{"error":"Not Found"}', 'JSON 404 without status');
        assertError(await q(inst, { port: u.port, path: '/h503' }), 503, HTML503, 'HTML 503');
        assertError(await q(inst, { port: u.port, path: '/h504' }), 504, HTML504, 'HTML 504');
    });

    it('HEAD and POST follow the same rule', async function () {
        assertError(await q(inst, { port: u.port, path: '/e404', method: 'HEAD' }), 404, undefined, 'HEAD empty 404');
        assertError(await q(inst, { port: u.port, path: '/t404', method: 'HEAD' }), 404, undefined, 'HEAD 404');
        assertError(await q(inst, { port: u.port, path: '/t404', method: 'POST', data: { a: 1 } }), 404, 'Not Found', 'POST text 404');
        assertError(await q(inst, { port: u.port, path: '/h503', method: 'POST', data: { a: 1 } }), 503, HTML503, 'POST HTML 503');
    });

    it('controls: a 2xx stays a success, and a body carrying `status` still decides', async function () {
        var r = await q(inst, { port: u.port, path: '/fast' });
        assertSuccess(r, 'GET 200 JSON'); assert.deepEqual(r.result, { ok: true });
        r = await q(inst, { port: u.port, path: '/empty' });
        assertSuccess(r, 'GET empty 200'); assert.deepEqual(r.result, { status: 200, empty: true });
        r = await q(inst, { port: u.port, path: '/e204' });
        assertSuccess(r, 'GET 204'); assert.deepEqual(r.result, { status: 200, empty: true });
        assertSuccess(await q(inst, { port: u.port, path: '/fast', method: 'HEAD' }), 'HEAD 200');
        r = await q(inst, { port: u.port, path: '/fast', method: 'POST', data: { a: 1 } });
        assertSuccess(r, 'POST 200 JSON'); assert.deepEqual(r.result, { ok: true });
        assertError(await q(inst, { port: u.port, path: '/js404' }), 404, 'gone', 'a 404 carrying gina\'s status keeps its fields');
        assertError(await q(inst, { port: u.port, path: '/js404', method: 'POST', data: { a: 1 } }), 404, 'gone', 'POST, the same');
        assertError(await q(inst, { port: u.port, path: '/j200s404' }), 404, 'gone', 'a 200 whose body says status 404');
        assert.equal(thrown.length, 0, 'nothing was answered through throwError()');
    });

    it('a status the map does not know (599) is still delivered as a success', async function () {
        assert.equal(typeof CODES['599'], 'undefined', 'precondition: 599 is not in gina\'s map');
        var r = await q(inst, { port: u.port, path: '/h599' });
        assertSuccess(r, 'GET 599'); assert.equal(r.result, HTML599);
    });
});

describe('03 - HTTP/1.1: a 4xx / 5xx without a gina status is an error carrying its status', function () {
    var u = null, inst = null;
    before(async function () { u = await mkUpstream1(); inst = makeInst(); thrown.length = 0; });
    after(function () { closeUpstream(u); });

    it('GET: an empty, a text and a JSON-without-status 404, and a proxy\'s HTML 503 / 504 page', async function () {
        assertError(await q(inst, { port: u.port, path: '/e404', h1: true }), 404, CODES['404'], 'empty 404');
        assertError(await q(inst, { port: u.port, path: '/t404', h1: true }), 404, 'Not Found', 'text 404');
        assertError(await q(inst, { port: u.port, path: '/j404', h1: true }), 404, '{"error":"Not Found"}', 'JSON 404 without status');
        assertError(await q(inst, { port: u.port, path: '/h503', h1: true }), 503, HTML503, 'HTML 503');
        assertError(await q(inst, { port: u.port, path: '/h504', h1: true }), 504, HTML504, 'HTML 504');
    });

    it('HEAD and POST follow the same rule', async function () {
        assertError(await q(inst, { port: u.port, path: '/e404', method: 'HEAD', h1: true }), 404, undefined, 'HEAD empty 404');
        assertError(await q(inst, { port: u.port, path: '/t404', method: 'HEAD', h1: true }), 404, undefined, 'HEAD 404');
        assertError(await q(inst, { port: u.port, path: '/t404', method: 'POST', data: { a: 1 }, h1: true }), 404, 'Not Found', 'POST text 404');
        assertError(await q(inst, { port: u.port, path: '/h503', method: 'POST', data: { a: 1 }, h1: true }), 503, HTML503, 'POST HTML 503');
    });

    it('controls: a 2xx stays a success, and a body carrying `status` still decides', async function () {
        var r = await q(inst, { port: u.port, path: '/fast', h1: true });
        assertSuccess(r, 'GET 200 JSON'); assert.deepEqual(r.result, { ok: true });
        r = await q(inst, { port: u.port, path: '/empty', h1: true });
        assertSuccess(r, 'GET empty 200'); assert.equal(r.result, '');
        r = await q(inst, { port: u.port, path: '/e204', h1: true });
        assertSuccess(r, 'GET 204'); assert.equal(r.result, '');
        assertSuccess(await q(inst, { port: u.port, path: '/fast', method: 'HEAD', h1: true }), 'HEAD 200');
        r = await q(inst, { port: u.port, path: '/fast', method: 'POST', data: { a: 1 }, h1: true });
        assertSuccess(r, 'POST 200 JSON'); assert.deepEqual(r.result, { ok: true });
        assertError(await q(inst, { port: u.port, path: '/js404', h1: true }), 404, 'gone', 'a 404 carrying gina\'s status keeps its fields');
        assertError(await q(inst, { port: u.port, path: '/js404', method: 'POST', data: { a: 1 }, h1: true }), 404, 'gone', 'POST, the same');
        assertError(await q(inst, { port: u.port, path: '/j200s404', h1: true }), 404, 'gone', 'a 200 whose body says status 404');
        assert.equal(thrown.length, 0, 'nothing was answered through throwError()');
    });

    it('a status the map does not know (599) is still delivered as a success', async function () {
        assert.equal(typeof CODES['599'], 'undefined', 'precondition: 599 is not in gina\'s map');
        var r = await q(inst, { port: u.port, path: '/h599', h1: true });
        assertSuccess(r, 'GET 599'); assert.equal(r.result, HTML599);
    });
});

describe('04 - the promisified call rejects, and the onComplete handle delivers the error first', function () {
    var u2 = null, u1 = null, inst = null;
    before(async function () { u2 = await mkUpstream2(); u1 = await mkUpstream1(); inst = makeInst(); });
    after(function () { closeUpstream(u2); closeUpstream(u1); });

    [['HTTP/2', false], ['HTTP/1.1', true]].forEach(function (t) {
        it(t[0] + ': a text 404 rejects the promisified call and reaches onComplete as err', async function () {
            var port = t[1] ? u1.port : u2.port;
            await assert.rejects(util.promisify(inst.query)(opts({ port: port, path: '/t404', h1: t[1] }), {}), function (e) {
                return e && e.status === 404 && e.error === CODES['404'] && e.message === 'Not Found';
            }, 'the promisified call rejects with the error object');
            var r = await new Promise(function (res) {
                inst.query(opts({ port: port, path: '/t404', h1: t[1] }), {}).onComplete(function (err, data) { res({ err: err, data: data }); });
            });
            assert.ok(r.err && r.err.status === 404, 'onComplete gets the error first: ' + JSON.stringify(r.err));
            assert.equal(r.data, undefined, 'and no data');
            var ok = await util.promisify(inst.query)(opts({ port: port, path: '/fast', h1: t[1] }), {});
            assert.deepEqual(ok, { ok: true }, 'control: a 200 still resolves');
        });
    });
});
