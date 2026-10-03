'use strict';
/**
 * #P49 — the fast lane's two writers, `ctx.json()` and `ctx.error()`.
 *
 * `ctx.json()` keeps the controller's render-json contract and `ctx.error()`
 * answers with the controller's throwError JSON envelope, without building a
 * controller. Each is driven here on stubs (call order, exact values) and on
 * real loopback HTTP/1.1 and HTTP/2 servers (what the wire carries).
 *
 *  §01 ctx.json() on HTTP/1.x — the content type from the conf, a byte
 *      content-length, the status from a `status` key with its reason phrase,
 *      `errno` alone, unlisted statuses, a string payload, an invalid one, a
 *      falsy one, HEAD, a second call, an already-answered response, the
 *      access line, the Flow bars; then a real HTTP/1.1 exchange.
 *  §02 param.responseDto — projected on a 2xx only; an unregistered DTO warns
 *      and sends the payload unshaped; the dev-only missing-required warn.
 *  §03 the idempotency record — called once, at the stringify point, with the
 *      status and the content type already set; never without a capture.
 *  §04 HTTP/2 — the raw stream (the frame, the folded headers, HEAD, a
 *      destroyed stream) and the #B562 shim, with the REAL installH2SendShim
 *      bytes from core/server.js and a wrapping session middleware; then real
 *      h2c exchanges.
 *  §05 ctx.error() — parity with the REAL controller throwError, driven
 *      through SuperController.createTestInstance in both scopes: the body's
 *      keys in order and their values (the ref aside), the status, the content
 *      type, and the pairing line.
 *  §06 ctx.error() — what only the lane does: a content-length, an answer
 *      where a controller throws or ignores the call, an invalid status, a
 *      throwing writeHead, a late call, headers set earlier kept on the wire.
 *  §07 pauseRequest() — the same snapshot as the controller's.
 *
 * Seam: `GINA_LANE_MAIN=<file>` loads that file instead of the tree's
 * `lib/lane`.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');

var FW        = require('../fw');
var LANE_MAIN = process.env.GINA_LANE_MAIN || path.join(FW, 'lib/lane/src/main.js');
var SRC_CTL   = path.join(FW, 'core/controller/controller.js');
var SRC_SRV   = path.join(FW, 'core/server.js');

var ENV_KEYS = ['NODE_ENV_IS_DEV', 'NODE_SCOPE_IS_LOCAL'];
var ENV0 = {};
ENV_KEYS.forEach(function (k) { ENV0[k] = process.env[k]; delete process.env[k]; });
after(function () {
    ENV_KEYS.forEach(function (k) {
        if ( typeof(ENV0[k]) == 'undefined' ) { delete process.env[k]; } else { process.env[k] = ENV0[k]; }
    });
});

// The controller needs the framework's globals (helpers, the `gina` path).
process.env.NODE_PATH = ( process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '' ) + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
setPath('gina', { core: path.join(FW, 'core') });

var LOGGER      = require(path.join(FW, 'lib/logger'));
var DTO         = require(path.join(FW, 'lib/dto'));
var IDEMPOTENCY = require(path.join(FW, 'lib/idempotency'));

var HEX6  = /^[0-9A-F]{6}$/;
var FRAME = /\n\s+at\s/;


// ─── shared fixtures ─────────────────────────────────────────────────────────
/** The status table as core/config.js builds it (comments and `_comment` dropped). */
function loadStatusCodes() {
    var raw  = fs.readFileSync(path.join(FW, 'core/status.codes'), 'utf8');
    var json = JSON.parse(raw.split('\n').filter(function (l) { return l.trim().indexOf('//') !== 0; }).join('\n'));
    delete json._comment;
    return json;
}
var STATUS = loadStatusCodes();

function makeConf(o) {
    o = o || {};
    return {
        bundle   : 'b',
        encoding : o.encoding || 'utf8',
        server   : {
            protocol          : o.protocol || 'http/1.1',
            coreConfiguration : { statusCodes: STATUS, mime: { json: o.json || 'application/json', html: 'text/html' } }
        },
        content  : { routing: {}, templates: { _common: {} }, settings: {} }
    };
}
var CONF    = makeConf();
var H2_CONF = makeConf({ protocol: 'http/2.0' });

function makeReq(o) {
    o = o || {};
    return {
        method      : o.method || 'GET',
        url         : o.url || '/x',
        headers     : { 'user-agent': 'node-test', 'accept-language': 'en' },
        params      : o.params || {},
        get         : {},
        routing     : o.routing || { rule: 'r@b', bundle: 'b', param: { lane: 'l', control: 'action' } },
        _ginaReqId  : 'REQ-P49',
        session     : o.session,
        originalUrl : o.originalUrl,
        _devTimeline: o.timeline,
        _idemCapture: o.idem
    };
}

/** An HTTP/1-shaped response stub recording every write. */
function makeRes(out, o) {
    out = out || {};
    o = o || {};
    out.heads = out.heads || [];
    out.ends  = out.ends || 0;
    var headers = {};
    var sent = !!o.alreadySent;
    var res = {
        statusCode    : 200,
        statusMessage : undefined,
        setHeader     : function (k, v) {
            if ( sent ) { throw new Error('ERR_HTTP_HEADERS_SENT'); }
            headers[String(k).toLowerCase()] = v;
            return this;
        },
        getHeader     : function (k) { return headers[String(k).toLowerCase()]; },
        getHeaders    : function () { return Object.assign({}, headers); },
        writeHead     : function (code, h) {
            if ( o.throwOnWriteHead ) { throw new Error('writeHead failed in the stub'); }
            out.heads.push({ code: code, headers: h });
            this.statusCode = code;
            for (var k in h) { headers[k.toLowerCase()] = h[k]; }
            sent = true;
            return this;
        },
        end           : function (chunk) {
            out.body = ( chunk == null ) ? '' : String(chunk);
            ++out.ends;
            sent = true;
            return this;
        }
    };
    Object.defineProperty(res, 'headersSent', { get: function () { return sent; } });
    out.headers = headers;
    return res;
}

/** Capture (and silence) the logger the lane and the controller write to. */
function captureLogs() {
    var levels = ['info', 'warn', 'error', 'debug'];
    var saved  = {};
    var out    = { info: [], warn: [], error: [], debug: [] };
    levels.forEach(function (l) {
        saved[l]  = LOGGER[l];
        LOGGER[l] = function () { out[l].push(Array.prototype.slice.call(arguments).join(' ')); };
    });
    out.restore = function () { levels.forEach(function (l) { LOGGER[l] = saved[l]; }); };
    return out;
}

/**
 * A fresh lane copy with the dev and scope flags read now (the module caches
 * both on first use): `error()` reads the scope, `dispatch()` the dev flag.
 *
 * @param {{dev?: boolean, local?: boolean}} [o]
 * @returns {object} the lane module
 */
function laneScoped(o) {
    o = o || {};
    if ( o.dev )   { process.env.NODE_ENV_IS_DEV = 'true'; }
    if ( o.local ) { process.env.NODE_SCOPE_IS_LOCAL = 'true'; }
    var id = require.resolve(LANE_MAIN);
    delete require.cache[id];
    var api = require(LANE_MAIN);
    var savedGetContext = global.getContext;
    global.getContext   = function () { return undefined; };
    var logs = captureLogs();
    try {
        new api.LaneContext(makeReq(), makeRes(), {}, CONF).error(500, 'warm-up');
        api.dispatch({ missing: true, rule: 'w', bundle: 'b', lane: 'w', control: 'w' }, makeReq(), makeRes(), null, null, CONF);
    } finally {
        logs.restore();
        global.getContext = savedGetContext;
        delete process.env.NODE_ENV_IS_DEV;
        delete process.env.NODE_SCOPE_IS_LOCAL;
    }
    return api;
}

var _prod = null;
/** The production, non-local copy. */
function prod() {
    if ( !_prod ) { _prod = laneScoped(); }
    return _prod;
}

/** Write through `ctx.json()` on stubs; returns what was written and logged. */
function writeJson(payload, o) {
    o = o || {};
    var out  = {};
    var api  = o.api || prod();
    var req  = makeReq(o.req);
    var res  = o.res || makeRes(out, o.resOpt);
    var ctx  = new api.LaneContext(req, res, { lane: 'l', control: 'action' }, o.conf || CONF);
    var logs = captureLogs();
    var ret;
    try { ret = ctx.json(payload); } finally { logs.restore(); }
    return { out: out, res: res, req: req, ctx: ctx, ret: ret, logs: logs };
}

/**
 * Extract a `var <name> = function(...) { … };` declaration by walking its
 * braces, and compile it in global scope.
 */
function extractFunction(src, decl) {
    var at = src.indexOf(decl);
    assert.ok(at > -1, 'declaration found: ' + decl);
    assert.equal(src.indexOf(decl, at + 1), -1, 'declared exactly once: ' + decl);
    var i = src.indexOf('{', at), depth = 0, started = false, end = -1;
    for (; i < src.length; ++i) {
        if ( src[i] === '{' ) { depth++; started = true; }
        else if ( src[i] === '}' ) { depth--; if ( started && depth === 0 ) { end = i + 1; break; } }
    }
    assert.ok(end > at, 'balanced body');
    return new Function('return (' + src.substring(src.indexOf('function', at), end) + ');')();
}
var installH2SendShim = extractFunction(fs.readFileSync(SRC_SRV, 'utf8'), 'var installH2SendShim = function(res) {');

/** A session-like middleware wrapping writeHead (a cookie on headers) and end. */
function wrapLikeSession(res, seen) {
    var writeHead = res.writeHead;
    var end       = res.end;
    res.writeHead = function () {
        seen.writeHead = ( seen.writeHead || 0 ) + 1;
        if ( !res.headersSent ) { res.setHeader('set-cookie', 'sid=lane-shim'); }
        return writeHead.apply(res, arguments);
    };
    res.end = function () {
        seen.end = ( seen.end || 0 ) + 1;
        return end.apply(res, arguments);
    };
}


// ─── real loopback servers ───────────────────────────────────────────────────
function listen(srv) {
    return new Promise(function (resolve) { srv.listen(0, '127.0.0.1', function () { resolve(srv.address().port); }); });
}
function closeServer(srv) {
    return new Promise(function (resolve) {
        if ( typeof(srv.closeAllConnections) == 'function' ) { srv.closeAllConnections(); }
        ( srv._laneSessions || [] ).forEach(function (s) { try { s.destroy(); } catch (e) { /* gone */ } });
        srv.close(function () { resolve(); });
    });
}
/**
 * A handler whose failure answers the client (a 599 carrying the error) instead of
 * leaving it waiting: a broken arm must fail on its assertion, never hang the file.
 */
function guarded(handler) {
    return function (req, res) {
        try {
            handler(req, res);
        } catch (err) {
            try { res.statusCode = 599; res.end('handler threw: ' + ( err && err.stack || err )); } catch (e) { /* already answered */ }
        }
    };
}
/** An h2c server whose sessions are tracked, so closeServer() can end them. */
function h2Server(handler) {
    var srv = http2.createServer(guarded(handler));
    srv._laneSessions = [];
    srv.on('session', function (s) { srv._laneSessions.push(s); });
    return srv;
}
function h1Request(port, method, p, headers) {
    return new Promise(function (resolve, reject) {
        var req = http.request({ host: '127.0.0.1', port: port, method: method, path: p, agent: false, headers: headers || {} }, function (res) {
            var chunks = [];
            res.on('data', function (c) { chunks.push(c); });
            res.on('end', function () {
                resolve({ status: res.statusCode, message: res.statusMessage, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
            });
        });
        req.setTimeout(10000, function () { req.destroy(new Error('h1 request timeout')); });
        req.on('error', reject);
        req.end();
    });
}
function h2Request(port, method, p) {
    return new Promise(function (resolve, reject) {
        var client = http2.connect('http://127.0.0.1:' + port);
        client.on('error', reject);
        var req = client.request({ ':method': method, ':path': p });
        var headers = null;
        var chunks = [];
        req.on('response', function (h) { headers = h; });
        req.on('data', function (c) { chunks.push(c); });
        req.on('end', function () {
            client.close();
            resolve({ headers: headers, body: Buffer.concat(chunks).toString('utf8') });
        });
        req.setTimeout(10000, function () { req.close(); client.destroy(); reject(new Error('h2 request timeout')); });
        req.on('error', function (e) { client.destroy(); reject(e); });
        req.end();
    });
}
/** Stamp what core/server.js sets on a request before the lane runs. */
function asLaneRequest(req) {
    req.routing    = { rule: 'r@b', bundle: 'b', param: { lane: 'l', control: 'action' } };
    req._ginaReqId = 'REQ-LIVE';
    return req;
}


// ─── 00 — the harness ────────────────────────────────────────────────────────
describe('#P49 lane writers §00 — the harness (green without the lane)', function () {

    it('the controller driver writes the real throwError envelope', function () {
        var c = controllerDriver(false)(function () { return [404, 'harness probe']; });
        assert.equal(c.heads[0].code, 404);
        var b = JSON.parse(c.body);
        assert.deepEqual(Object.keys(b), ['status', 'error', 'message', 'ref']);
        assert.equal(b.message, 'harness probe');
        assert.equal(c.logs.length, 1);
    });

    it('the extracted shim installs on a response with a stream, and forwards when no raw send is registered', function () {
        var ends = 0;
        var res = { stream: {}, writeHead: function () {}, write: function () {}, end: function () { ++ends; } };
        installH2SendShim(res);
        assert.equal(res._ginaSendShim, true);
        res.end('x');
        assert.equal(ends, 1);
    });

    it('a real loopback HTTP/1.1 server round-trips', async function () {
        var srv = http.createServer(guarded(function (req, res) { res.end('pong'); }));
        var port = await listen(srv);
        try {
            assert.equal((await h1Request(port, 'GET', '/')).body, 'pong');
        } finally {
            await closeServer(srv);
        }
    });
});


// ─── 01 — ctx.json() on HTTP/1.x ────────────────────────────────────────────
describe('#P49 lane writers §01 — ctx.json() on HTTP/1.x', function () {

    it('the content type comes from the conf (mime.json + encoding); a byte content-length; one end()', function () {
        var w = writeJson({ name: 'Zoë ☕' }, { conf: makeConf({ json: 'application/vnd.test+json', encoding: 'utf-8' }) });
        assert.equal(w.ret, true);
        assert.equal(w.out.headers['content-type'], 'application/vnd.test+json; charset=utf-8');
        assert.equal(w.out.body, '{"name":"Zoë ☕"}');
        assert.equal(w.out.headers['content-length'], Buffer.byteLength(w.out.body, 'utf8'));
        assert.notEqual(w.out.headers['content-length'], w.out.body.length, 'control: bytes, not characters');
        assert.equal(w.out.ends, 1);
        assert.equal(w.res.statusCode, 200);
        assert.equal(w.out.heads.length, 0, 'the status line comes from res.statusCode, as render-json');
    });

    it('a `status` key naming a listed non-200 code sets the status and its reason phrase; the key stays in the body', function () {
        var w = writeJson({ status: 404, error: 'gone' });
        assert.equal(w.res.statusCode, 404);
        assert.equal(w.res.statusMessage, 'Not Found');
        assert.deepEqual(JSON.parse(w.out.body), { status: 404, error: 'gone' });
        assert.ok(w.logs.info.indexOf('GET [404] /x') > -1, 'the access line carries the status');
        var c = writeJson({ status: 201, id: 1 });
        assert.equal(c.res.statusCode, 201);
        assert.equal(c.res.statusMessage, 'Created');
    });

    it('over HTTP/2 the status is set and no reason phrase (RFC 9113 §8.3.2)', function () {
        var out = {};
        var res = makeRes(out);
        res.stream = null;   // a compat response without a raw stream is written as HTTP/1.x
        var w = writeJson({ status: 409 }, { conf: H2_CONF, res: res });
        assert.equal(w.res.statusCode, 409);
        assert.equal(w.res.statusMessage, undefined);
    });

    it('`errno` alone never sets the status; with a listed `status` it does', function () {
        assert.equal(writeJson({ errno: 5 }).res.statusCode, 200);
        assert.equal(writeJson({ errno: 5, status: 503 }).res.statusCode, 503);
    });

    it('an unlisted status is ignored: `_comment`, `toString`, 299, "abc", 200', function () {
        ['_comment', 'toString', 299, 'abc', 200].forEach(function (s) {
            var w = writeJson({ status: s });
            assert.equal(w.res.statusCode, 200, JSON.stringify(s));
            assert.equal(w.res.statusMessage, undefined, JSON.stringify(s));
        });
    });

    it('a string payload is parsed first; an invalid one answers the 500 envelope', function () {
        assert.equal(writeJson('{"a":1}').out.body, '{"a":1}');
        var bad = writeJson('{not json');
        assert.equal(bad.out.heads[0].code, 500);
        var b = JSON.parse(bad.out.body);
        assert.equal(b.status, 500);
        assert.match(b.message, /JSON/);
        assert.match(b.ref, HEX6);
        assert.equal(bad.logs.error.length, 1, 'one pairing line');
    });

    it('a falsy payload sends {}; an array is sent as given', function () {
        [undefined, null, 0, '', false].forEach(function (v) {
            assert.equal(writeJson(v).out.body, '{}', JSON.stringify(v));
        });
        assert.equal(writeJson([1, 2]).out.body, '[1,2]');
    });

    it('HEAD: the content-length the body would have had, and no body', function () {
        var w = writeJson({ a: 'é' }, { req: { method: 'HEAD' } });
        assert.equal(w.out.headers['content-length'], Buffer.byteLength('{"a":"é"}', 'utf8'));
        assert.equal(w.out.body, '');
        assert.equal(w.out.ends, 1);
    });

    it('writes once: a second call is ignored and logged, returning false', function () {
        var w = writeJson({ first: 1 });
        var logs = captureLogs();
        var second;
        try { second = w.ctx.json({ second: 2 }); } finally { logs.restore(); }
        assert.equal(second, false);
        assert.equal(w.out.ends, 1);
        assert.equal(w.out.body, '{"first":1}');
        assert.ok(logs.warn.some(function (l) { return l.indexOf('[ Lane ] json() called after the response was released — ignoring: {"second":2}') === 0; }), JSON.stringify(logs.warn));
    });

    it('a response already answered (by a middleware) is left alone, logged, false', function () {
        var w = writeJson({ a: 1 }, { resOpt: { alreadySent: true } });
        assert.equal(w.ret, false);
        assert.equal(w.out.ends, 0);
        assert.equal(w.ctx.res, null, 'released');
        assert.ok(w.logs.warn.length === 1);
    });

    it('the Flow bars: response-write then total, when the request carries a timeline', function () {
        var tl = { requestStart: Date.now() - 2, entries: [] };
        writeJson({ a: 1 }, { req: { timeline: tl } });
        assert.deepEqual(tl.entries.map(function (e) { return e.label; }), ['response-write', 'total']);
        assert.equal(tl.entries[0].cat, 'response');
        assert.equal(tl.entries[1].cat, 'total');
    });

    it('a real HTTP/1.1 exchange: status line with its reason, content-type, content-length, headers set earlier kept, HEAD', async function () {
        var api = prod();
        var srv = http.createServer(guarded(function (req, res) {
            asLaneRequest(req);
            res.setHeader('x-request-id', 'REQ-LIVE');
            res.setHeader('access-control-allow-origin', '*');
            var ctx  = new api.LaneContext(req, res, { lane: 'l', control: 'action' }, CONF);
            var logs = captureLogs();
            try {
                ctx.json( /missing/.test(req.url) ? { status: 404, error: 'no such item' } : { items: ['a', 'é'] });
            } finally { logs.restore(); }
        }));
        var port = await listen(srv);
        try {
            var ok = await h1Request(port, 'GET', '/items');
            assert.equal(ok.status, 200);
            assert.equal(ok.headers['content-type'], 'application/json; charset=utf8');
            assert.equal(ok.headers['content-length'], String(Buffer.byteLength(ok.body)));
            assert.equal(ok.headers['transfer-encoding'], undefined, 'a length, not chunked');
            assert.equal(ok.headers['x-request-id'], 'REQ-LIVE');
            assert.equal(ok.headers['access-control-allow-origin'], '*');
            assert.deepEqual(JSON.parse(ok.body), { items: ['a', 'é'] });
            var nf = await h1Request(port, 'GET', '/missing');
            assert.equal(nf.status, 404);
            assert.equal(nf.message, 'Not Found');
            assert.deepEqual(JSON.parse(nf.body), { status: 404, error: 'no such item' });
            var head = await h1Request(port, 'HEAD', '/items');
            assert.equal(head.status, 200);
            assert.equal(head.headers['content-length'], ok.headers['content-length']);
            assert.equal(head.body, '');
        } finally {
            await closeServer(srv);
        }
    });
});


// ─── 02 — param.responseDto ──────────────────────────────────────────────────
describe('#P49 lane writers §02 — param.responseDto', function () {

    before(function () {
        DTO.register('LaneUserView', DTO.object({
            id     : DTO.integer().required(),
            name   : DTO.string(),
            secret : DTO.string().exclude()
        }));
    });
    function routed(dtoName) {
        return { rule: 'r@b', bundle: 'b', param: { lane: 'l', control: 'action', responseDto: dtoName } };
    }

    it('shapes a 2xx payload: undeclared fields dropped, excluded ones removed', function () {
        var w = writeJson({ id: 1, name: 'Ada', secret: 's', extra: true }, { req: { routing: routed('LaneUserView') } });
        assert.deepEqual(JSON.parse(w.out.body), { id: 1, name: 'Ada' });
    });

    it('leaves a non-2xx payload unshaped (an error is never mangled by a success DTO)', function () {
        var w = writeJson({ status: 404, error: 'gone', secret: 's' }, { req: { routing: routed('LaneUserView') } });
        assert.deepEqual(JSON.parse(w.out.body), { status: 404, error: 'gone', secret: 's' });
    });

    it('an unregistered DTO warns and sends the payload unshaped', function () {
        var w = writeJson({ id: 1, extra: true }, { req: { routing: routed('NoSuchDto') } });
        assert.deepEqual(JSON.parse(w.out.body), { id: 1, extra: true });
        assert.ok(w.logs.warn.some(function (l) { return l.indexOf('[ Lane ] responseDto `NoSuchDto` is not registered') === 0; }), JSON.stringify(w.logs.warn));
    });

    it('dev mode warns about a declared required field the payload lacks; production does not', function () {
        var dev = writeJson({ name: 'no id' }, { api: laneScoped({ dev: true }), req: { routing: routed('LaneUserView') } });
        assert.ok(dev.logs.warn.some(function (l) { return /declares required field\(s\) the payload does not carry: id$/.test(l); }), JSON.stringify(dev.logs.warn));
        var prd = writeJson({ name: 'no id' }, { req: { routing: routed('LaneUserView') } });
        assert.equal(prd.logs.warn.length, 0);
    });
});


// ─── 03 — the idempotency record ─────────────────────────────────────────────
describe('#P49 lane writers §03 — the idempotency record', function () {

    var original;
    var calls = [];
    before(function () {
        original = IDEMPOTENCY.record;
        IDEMPOTENCY.record = function (req, res, body) {
            calls.push({ req: req, body: body, status: res.statusCode, contentType: res.getHeader('content-type'), ended: !!res.headersSent });
        };
    });
    after(function () { IDEMPOTENCY.record = original; });

    it('records once, with the body written, after the status and the content type are set and before the write', function () {
        calls.length = 0;
        var cap = {};
        var w = writeJson({ status: 201, id: 9 }, { req: { idem: cap } });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].req._idemCapture, cap);
        assert.equal(calls[0].body, w.out.body);
        assert.equal(calls[0].status, 201);
        assert.equal(calls[0].contentType, 'application/json; charset=utf8');
        assert.equal(calls[0].ended, false, 'recorded before the response is written');
    });

    it('records nothing without a capture', function () {
        calls.length = 0;
        writeJson({ id: 1 });
        assert.equal(calls.length, 0);
    });
});


// ─── 04 — HTTP/2 ─────────────────────────────────────────────────────────────
describe('#P49 lane writers §04 — HTTP/2: the raw stream and the #B562 shim', function () {

    /** A compat response stub carrying a raw stream stub. */
    function h2Stub(o) {
        o = o || {};
        var rec = { responds: [], ends: [], compatWriteHead: 0, compatEnd: 0 };
        var stream = {
            headersSent : false,
            destroyed   : !!o.destroyed,
            closed      : false,
            respond     : function (h) { rec.responds.push(h); this.headersSent = true; },
            end         : function (chunk) { rec.ends.push(chunk === undefined ? undefined : String(chunk)); }
        };
        var headers = {};
        var res = {
            stream        : stream,
            statusCode    : 200,
            setHeader     : function (k, v) { headers[String(k).toLowerCase()] = v; },
            getHeader     : function (k) { return headers[String(k).toLowerCase()]; },
            getHeaders    : function () { return Object.assign({}, headers); },
            writeHead     : function () { rec.compatWriteHead++; return this; },
            write         : function () { return true; },
            end           : function () { rec.compatEnd++; return this; }
        };
        Object.defineProperty(res, 'headersSent', { get: function () { return stream.headersSent; } });
        return { res: res, stream: stream, rec: rec };
    }

    it('raw stream: one respond frame (content type, :status, the headers set earlier folded in) and end(body)', function () {
        var s = h2Stub();
        s.res.setHeader('x-request-id', 'REQ-P49');
        s.res.setHeader('content-type', 'text/plain');   // the frame's own key wins
        var w = writeJson({ status: 422, error: 'bad' }, { conf: H2_CONF, res: s.res });
        assert.equal(w.ret, true);
        assert.equal(s.rec.responds.length, 1);
        assert.deepEqual(s.rec.responds[0], { 'content-type': 'application/json; charset=utf8', ':status': 422, 'x-request-id': 'REQ-P49' });
        assert.deepEqual(s.rec.ends, ['{"status":422,"error":"bad"}']);
        assert.equal(s.rec.compatWriteHead + s.rec.compatEnd, 0, 'the compat layer is bypassed');
    });

    it('raw stream HEAD: the length in the frame, end() without a body', function () {
        var s = h2Stub();
        writeJson({ a: 1 }, { conf: H2_CONF, res: s.res, req: { method: 'HEAD' } });
        assert.equal(s.rec.responds[0]['content-length'], Buffer.byteLength('{"a":1}'));
        assert.equal(s.rec.responds[0][':status'], 200);
        assert.deepEqual(s.rec.ends, [undefined]);
    });

    it('a destroyed stream (the client left) is not written, logged, false', function () {
        var s = h2Stub({ destroyed: true });
        var w = writeJson({ a: 1 }, { conf: H2_CONF, res: s.res });
        assert.equal(w.ret, false);
        assert.equal(s.rec.responds.length, 0);
        assert.ok(w.logs.warn.some(function (l) { return l.indexOf('[ Lane ] Stream already destroyed') === 0; }));
    });

    it('the #B562 shim (the real bytes): a session middleware\'s writeHead and end run, its cookie reaches the frame', function () {
        var s = h2Stub();
        installH2SendShim(s.res);
        assert.equal(s.res._ginaSendShim, true, 'control: the shim installed');
        var seen = {};
        wrapLikeSession(s.res, seen);
        writeJson({ ok: true }, { conf: H2_CONF, res: s.res });
        assert.equal(seen.writeHead, 1, 'the middleware saw writeHead');
        assert.equal(seen.end, 1, 'the middleware saw end');
        assert.equal(s.rec.responds.length, 1);
        assert.equal(s.rec.responds[0]['set-cookie'], 'sid=lane-shim');
        assert.equal(s.rec.responds[0][':status'], 200);
        assert.deepEqual(s.rec.ends, ['{"ok":true}']);
        assert.equal(s.rec.compatWriteHead + s.rec.compatEnd, 0, 'the shim swallowed the compat writes');
        assert.equal(s.res._ginaRawSend, null, 'the raw send is consumed');
    });

    it('the #B562 shim on HEAD: the middleware runs, the frame carries the length and the cookie, no body', function () {
        var s = h2Stub();
        installH2SendShim(s.res);
        var seen = {};
        wrapLikeSession(s.res, seen);
        writeJson({ a: 1 }, { conf: H2_CONF, res: s.res, req: { method: 'HEAD' } });
        assert.equal(seen.end, 1);
        assert.equal(s.rec.responds[0]['set-cookie'], 'sid=lane-shim');
        assert.equal(s.rec.responds[0]['content-length'], Buffer.byteLength('{"a":1}'));
        assert.deepEqual(s.rec.ends, [undefined]);
    });

    it('real h2c: the raw path and the shim path put the status, the folded headers and the body on the wire', async function () {
        var api = prod();
        var srv = h2Server(function (req, res) {
            asLaneRequest(req);
            res.setHeader('x-request-id', 'REQ-LIVE');
            if ( /shim/.test(req.url) ) {
                installH2SendShim(res);
                wrapLikeSession(res, {});
            }
            var ctx  = new api.LaneContext(req, res, { lane: 'l', control: 'action' }, H2_CONF);
            var logs = captureLogs();
            try {
                if ( /err/.test(req.url) ) {
                    res.setHeader('retry-after', '7');
                    ctx.error(503, 'busy');
                } else {
                    ctx.json({ status: 202, path: req.url });
                }
            } finally { logs.restore(); }
        });
        var port = await listen(srv);
        try {
            var raw = await h2Request(port, 'GET', '/raw');
            assert.equal(raw.headers[':status'], 202);
            assert.equal(raw.headers['content-type'], 'application/json; charset=utf8');
            assert.equal(raw.headers['x-request-id'], 'REQ-LIVE');
            assert.deepEqual(JSON.parse(raw.body), { status: 202, path: '/raw' });
            var shim = await h2Request(port, 'GET', '/shim');
            assert.equal(shim.headers[':status'], 202);
            assert.equal(shim.headers['set-cookie'][0] || shim.headers['set-cookie'], 'sid=lane-shim');
            assert.deepEqual(JSON.parse(shim.body), { status: 202, path: '/shim' });
            var head = await h2Request(port, 'HEAD', '/shim');
            assert.equal(head.headers[':status'], 202);
            assert.equal(head.body, '');
            var err = await h2Request(port, 'GET', '/err');
            assert.equal(err.headers[':status'], 503);
            assert.equal(err.headers['retry-after'], '7', 'a header set before the error is kept');
            assert.equal(err.headers['x-request-id'], 'REQ-LIVE');
            assert.equal(JSON.parse(err.body).message, 'busy');
            var errShim = await h2Request(port, 'GET', '/err-shim');
            assert.equal(errShim.headers[':status'], 503);
            assert.equal(errShim.headers['set-cookie'][0] || errShim.headers['set-cookie'], 'sid=lane-shim', 'the error writer goes through the wrapping middleware too');
            assert.equal(errShim.headers['content-length'], String(Buffer.byteLength(errShim.body)));
        } finally {
            await closeServer(srv);
        }
    });
});


// ─── 05 — ctx.error() parity with the controller ─────────────────────────────
/**
 * The controller side: controller.js loaded under a scope (it reads the scope
 * at load), its real throwError driven through createTestInstance as an XHR.
 */
function controllerDriver(isLocal) {
    process.env.NODE_SCOPE_IS_LOCAL = isLocal ? 'true' : 'false';
    delete require.cache[require.resolve(SRC_CTL)];
    var SuperController = require(SRC_CTL);
    delete process.env.NODE_SCOPE_IS_LOCAL;
    return function drive(argsFn) {
        var out  = {};
        var res  = makeRes(out);
        var req  = makeReq();
        var options = { rule: 'r', control: 'action', encoding: 'utf8', isXMLRequest: true, isUsingTemplate: true, conf: CONF };
        var inst = SuperController.createTestInstance({ req: req, res: res, next: function () {}, options: options });
        var logs = captureLogs();
        try {
            out.ret = inst.throwError.apply(inst, argsFn(res));
        } finally { logs.restore(); }
        out.logs = logs.error;
        return out;
    };
}
/** The lane side, on the same request and configuration. */
function laneDriver(isLocal) {
    var api = laneScoped({ local: isLocal });
    return function drive(argsFn) {
        var out  = {};
        var res  = makeRes(out);
        var ctx  = new api.LaneContext(makeReq(), res, { lane: 'l', control: 'action' }, CONF);
        var logs = captureLogs();
        try {
            out.ret = ctx.error.apply(ctx, argsFn(res));
        } finally { logs.restore(); }
        out.logs = logs.error;
        return out;
    };
}

var ERR_403  = Object.assign(new Error('not yours'), { status: 403 });
var ERR      = new Error('plain failure');
var ERR_404  = new Error('item 7 not found');
var INNER    = new Error('inner cause');
var ERR_CAUSE = new Error('outer failure', { cause: INNER });
var STACK    = new Error('stack as text').stack;

/** [label, (res) => args]; plain objects are built per call (the controller's merge writes into them). */
var SHAPES = [
    ['{status:422, error, fields}',          function () { return [{ status: 422, error: 'Validation failed', fields: { email: { isEmail: 'Invalid email' } } }]; }],
    ['{status:422, error, fields, ref}',     function () { return [{ status: 422, error: 'Validation failed', fields: { a: { r: 'm' } }, ref: 'R-2' }]; }],
    ['{status:401, error}',                  function () { return [{ status: 401, error: 'Unauthorized' }]; }],
    ['{status:400, error, message}',         function () { return [{ status: 400, error: 'Bad Request', message: 'dropped by both' }]; }],
    ['{status:500, message}',                function () { return [{ status: 500, message: 'only a message' }]; }],
    ['{status:422, error, errors:[…]}',      function () { return [{ status: 422, error: 'Unprocessable Entity', errors: [{ path: '/a', message: 'x' }] }]; }],
    ['{status:409, error, ref}',             function () { return [{ status: 409, error: 'Conflict', ref: 'X-1' }]; }],
    ['{status:"abc", error} (invalid)',      function () { return [{ status: 'abc', error: 'odd' }]; }],
    ['{status:500, error, stack}',           function () { return [{ status: 500, error: 'with a stack', stack: STACK }]; }],
    ['Error with status 403',                function () { return [ERR_403]; }],
    ['plain Error',                          function () { return [ERR]; }],
    ['(404, "Not found")',                   function () { return [404, 'Not found']; }],
    ['(500, err)',                           function () { return [500, ERR]; }],
    ['(500, err with cause)',                function () { return [500, ERR_CAUSE]; }],
    ['(500, err.stack)',                     function () { return [500, STACK]; }],
    ['(422, {error, fields})',               function () { return [422, { error: 'Validation failed', fields: { a: { r: 'm' } } }]; }],
    ['(404, {error, message})',              function () { return [404, { error: 'Missing', message: 'no such thing' }]; }],
    ['("a sentence")',                       function () { return ['a sentence']; }],
    ['(res, 404, err)',                      function (res) { return [res, 404, ERR_404]; }],
    ['(res, 500, err with cause)',           function (res) { return [res, 500, ERR_CAUSE]; }],
    ['(res, 400, "plain")',                  function (res) { return [res, 400, 'plain']; }],
    ['(res, 500, err.stack)',                function (res) { return [res, 500, STACK]; }],
    ['(res, 500, {ref, message})',           function (res) { return [res, 500, { ref: 'ORDER-42', message: 'payment capture failed' }]; }]
];

function normaliseLine(line, ref) {
    return line.replace('][ Lane ][', '][ Controller ][').split('[ ref ' + ref + ' ]').join('[ ref <REF> ]');
}

[false, true].forEach(function (isLocal) {
    describe('#P49 lane writers §05 — ctx.error() parity with the controller throwError (' + ( isLocal ? 'local' : 'non-local' ) + ' scope)', function () {

        var ctl  = null;
        var lane = null;
        before(function () {
            ctl  = controllerDriver(isLocal);
            lane = laneDriver(isLocal);
        });

        it('control — the scopes took: the stack field is on the wire in local scope only', function () {
            var c = JSON.parse(ctl(function () { return [500, ERR]; }).body);
            var l = JSON.parse(lane(function () { return [500, ERR]; }).body);
            assert.equal('stack' in c, isLocal, 'controller');
            assert.equal('stack' in l, isLocal, 'lane');
        });

        SHAPES.forEach(function (shape) {
            it(shape[0], function () {
                var c = ctl(shape[1]);
                var l = lane(shape[1]);
                assert.equal(c.heads.length, 1, 'harness: the controller wrote one head');
                assert.equal(l.heads.length, 1, 'the lane wrote one head');
                assert.equal(l.heads[0].code, c.heads[0].code, 'status');
                assert.equal(l.heads[0].headers['content-type'], c.heads[0].headers['content-type'], 'content type');
                var cb = JSON.parse(c.body);
                var lb = JSON.parse(l.body);
                assert.deepEqual(Object.keys(lb), Object.keys(cb), 'keys and their order');
                Object.keys(cb).forEach(function (k) {
                    if ( k !== 'ref' ) { assert.deepEqual(lb[k], cb[k], 'value of ' + k); }
                });
                if ( HEX6.test(cb.ref) ) {
                    assert.match(lb.ref, HEX6, 'both mint');
                } else {
                    assert.equal(lb.ref, cb.ref, 'both honour the caller\'s ref');
                }
                if ( !isLocal ) {
                    Object.keys(lb).forEach(function (k) {
                        assert.ok(!( typeof(lb[k]) == 'string' && FRAME.test(lb[k]) ), 'no frame on the non-local wire: ' + k);
                    });
                }
                assert.equal(c.logs.length, 1, 'harness: one controller pairing line');
                assert.equal(l.logs.length, 1, 'one lane pairing line');
                assert.equal(normaliseLine(l.logs[0], lb.ref), normaliseLine(c.logs[0], cb.ref), 'the pairing line');
            });
        });
    });
});


// ─── 06 — ctx.error(): what only the lane does ───────────────────────────────
describe('#P49 lane writers §06 — ctx.error(): what only the lane does', function () {

    function laneError(args, o) {
        o = o || {};
        var out  = {};
        var res  = makeRes(out, o.resOpt);
        if ( o.preset ) { o.preset(res); }
        var ctx  = new (prod().LaneContext)(makeReq(), res, { lane: 'l', control: 'action' }, CONF);
        var logs = captureLogs();
        try { out.ret = ctx.error.apply(ctx, args); } finally { logs.restore(); }
        out.logs = logs;
        out.ctx  = ctx;
        out.json = function () { return JSON.parse(out.body); };
        return out;
    }

    it('a content-length matching the bytes of the body', function () {
        var e = laneError([404, 'pas trouvé ☕']);
        assert.equal(e.heads[0].headers['content-length'], Buffer.byteLength(e.body, 'utf8'));
    });

    it('(status) alone answers the status text, where the controller throws', function () {
        var e = laneError([404]);
        assert.equal(e.heads[0].code, 404);
        assert.deepEqual(Object.keys(e.json()), ['status', 'error', 'ref']);
        assert.equal(e.json().error, 'Not Found');
        var ctl = controllerDriver(false);
        assert.throws(function () { ctl(function () { return [404]; }); }, TypeError, 'control: the controller dereferences a null message');
    });

    it('() answers a bare 500', function () {
        var e = laneError([]);
        assert.equal(e.heads[0].code, 500);
        assert.deepEqual(Object.keys(e.json()), ['status', 'error', 'ref']);
        assert.equal(e.json().error, 'Internal Server Error');
    });

    it('(null, msg) answers a 500 carrying the message, where the controller ignores the call as a late one', function () {
        var e = laneError([null, 'x']);
        assert.equal(e.heads[0].code, 500);
        assert.equal(e.json().message, 'x');
        var c = controllerDriver(false)(function () { return [null, 'x']; });
        assert.equal(c.ret, false, 'control: the controller returns false');
        assert.equal(c.heads.length, 0, 'and writes nothing');
    });

    it('an invalid status falls back to 500', function () {
        [[42, 'x'], ['abc', 'x'], [{ status: 1000, error: 'e' }]].forEach(function (args) {
            assert.equal(laneError(args).heads[0].code, 500, JSON.stringify(args));
        });
    });

    it('a throwing writeHead is logged, not thrown, and the context is released', function () {
        var e;
        assert.doesNotThrow(function () { e = laneError([500, 'x'], { resOpt: { throwOnWriteHead: true } }); });
        assert.equal(e.ret, true);
        assert.ok(e.logs.error.some(function (l) { return l.indexOf('[ Lane ] could not write the error response (/x): ') === 0; }), JSON.stringify(e.logs.error));
        assert.equal(e.ctx.res, null);
    });

    it('a late call is ignored, logged, false — the first answer stands', function () {
        var e = laneError([404, 'first']);
        var logs = captureLogs();
        var second;
        try { second = e.ctx.error(500, 'second'); } finally { logs.restore(); }
        assert.equal(second, false);
        assert.equal(e.heads.length, 1);
        assert.equal(e.json().message, 'first');
        assert.ok(logs.warn.some(function (l) { return l.indexOf('[ Lane ] error() called after the response was released — ignoring: second') === 0; }), JSON.stringify(logs.warn));
    });

    it('the caller\'s error object is not rewritten', function () {
        var obj = { status: 422, error: 'Validation failed', fields: { a: { r: 'm' } } };
        laneError([obj]);
        assert.deepEqual(obj, { status: 422, error: 'Validation failed', fields: { a: { r: 'm' } } });
    });

    it('a real HTTP/1.1 exchange: headers set before the error are kept (Retry-After, X-Request-Id), with the length', async function () {
        var api = prod();
        var srv = http.createServer(guarded(function (req, res) {
            asLaneRequest(req);
            res.setHeader('x-request-id', 'REQ-LIVE');
            res.setHeader('retry-after', '30');
            var ctx  = new api.LaneContext(req, res, { lane: 'l', control: 'action' }, CONF);
            var logs = captureLogs();
            try { ctx.error(503, 'try again later'); } finally { logs.restore(); }
        }));
        var port = await listen(srv);
        try {
            var r = await h1Request(port, 'GET', '/busy');
            assert.equal(r.status, 503);
            assert.equal(r.headers['retry-after'], '30');
            assert.equal(r.headers['x-request-id'], 'REQ-LIVE');
            assert.equal(r.headers['content-type'], 'application/json; charset=utf8');
            assert.equal(r.headers['content-length'], String(Buffer.byteLength(r.body)));
            var b = JSON.parse(r.body);
            assert.deepEqual(Object.keys(b), ['status', 'error', 'message', 'ref']);
            assert.equal(b.error, 'Service Unavailable');
        } finally {
            await closeServer(srv);
        }
    });
});


// ─── 07 — pauseRequest() parity ──────────────────────────────────────────────
describe('#P49 lane writers §07 — pauseRequest(): the controller\'s snapshot', function () {

    function controllerPause(reqOpt, data, storage) {
        delete require.cache[require.resolve(SRC_CTL)];
        var SuperController = require(SRC_CTL);
        var out = {};
        var res = makeRes(out);
        var inst = SuperController.createTestInstance({
            req: makeReq(reqOpt), res: res, next: function () {},
            options: { rule: 'r', control: 'action', encoding: 'utf8', isXMLRequest: true, isUsingTemplate: true, conf: CONF }
        });
        var logs = captureLogs();
        try { out.ret = inst.pauseRequest(data, storage); } finally { logs.restore(); }
        return out;
    }
    function lanePause(reqOpt, data, storage) {
        var out = {};
        var ctx = new (prod().LaneContext)(makeReq(reqOpt), makeRes(out), { lane: 'l', control: 'action' }, CONF);
        var logs = captureLogs();
        try { out.ret = ctx.pauseRequest(data, storage); } finally { logs.restore(); }
        return out;
    }

    it('the same haltedRequest, key for key, into the session', function () {
        var reqOpt = { method: 'POST', url: '/orders', originalUrl: '/orders?step=2', params: { first: 'f', id: '7' } };
        var s1 = {}, s2 = {};
        controllerPause(Object.assign({ session: s1 }, reqOpt), { a: [1, { b: 2 }] });
        lanePause(Object.assign({ session: s2 }, reqOpt), { a: [1, { b: 2 }] });
        assert.ok(s1.haltedRequest, 'harness: the controller snapshotted');
        assert.deepEqual(Object.keys(s2.haltedRequest), Object.keys(s1.haltedRequest));
        assert.deepEqual(s2.haltedRequest, s1.haltedRequest);
    });

    it('the same snapshot into an explicit storage, and the same absence of params', function () {
        var st1 = {}, st2 = {};
        controllerPause({ params: { only: '1' } }, { z: 1 }, st1);
        lanePause({ params: { only: '1' } }, { z: 1 }, st2);
        assert.deepEqual(st2.haltedRequest, st1.haltedRequest);
        assert.ok(!('params' in st2.haltedRequest));
    });

    it('without a storage both answer 424', function () {
        var c = controllerPause({}, {});
        var l = lanePause({}, {});
        assert.equal(c.heads[0].code, 424, 'harness: the controller answered 424');
        assert.equal(l.heads[0].code, 424);
        assert.equal(JSON.parse(l.body).status, 424);
        assert.equal(c.ret, undefined);
        assert.equal(l.ret, undefined);
    });
});
