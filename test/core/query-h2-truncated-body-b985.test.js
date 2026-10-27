'use strict';
/**
 * self.query() over HTTP/2 — a response body cut short mid-transfer is a premature close, not a success (#B985)
 *
 * Real bytes: the real controller's `query()` is driven against a bare `node:http2` upstream through a TCP proxy that
 * can cut the connection mid-body (a FIN, or a silent drop that gina's own keepalive deadline then tears down), the
 * shape of query-h2-incomplete-stream-b981.test.js. GINA_B985_CONTROLLER points the file's controller arms (and its
 * source pins) at another copy of controller.js placed in the same directory, and GINA_B985_GNA its warmup arm at
 * another copy of gina's core/gna.js placed beside it: that is how it was checked red-first against the code before
 * this change.
 *
 * Before this change (0.7.6, Node 22–26 and Bun 1.2 / 1.3; Bun 1.4 already retried the teardown case through its
 * stream-cancel error): a response whose body was cut short reached the caller as a success carrying the partial body
 * (or as an uncoded 500 when the partial body was JSON), whether a FIN cut it, gina's own keepalive deadline tore the
 * session down under it, or the boot warmup's deadline did. The end-of-stream guard read only a missing response or an
 * empty body on a destroyed session, and never the response's content-length.
 * Since this change a body shorter than its content-length, and any body on a session gina tore down itself, follow
 * the premature-close rule: a safe method is sent again, an unsafe one fails PREMATURE_CLOSE (503). A body with no
 * content-length cut by a FIN or a reset, with no teardown of gina's, is still taken as received (#B1004).
 */

var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http2 = require('node:http2');

var FW = require('../fw');

var SOURCE = process.env.GINA_B985_CONTROLLER || path.join(FW, 'core', 'controller', 'controller.js');
var GNA = process.env.GINA_B985_GNA || path.join(FW, 'core', 'gna.js');

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });

var SuperController = require(SOURCE);

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// Drops comment lines, so a source pin reads code only.
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*(\/\/|\/\*\*|\*(\s|\/|$))/.test(l); }).join('\n'); }

// A bare h2c upstream. Its first hit on /partial sends the headers and 3 of 6 body bytes and never ends the stream
// (later hits send the whole body); /partialcl does the same with `content-length: 6`; /cfin answers a complete body
// with its length; /head6 declares a length of 6 and sends no body; /utf8cl answers 3 characters in 6 bytes with a
// length of 6; /fast answers a small JSON body. Every hit is counted per path.
function mkUpstream() {
    var server = http2.createServer();
    var S = { hits: {}, sessions: [] };
    server.on('session', function (s) { S.sessions.push(s); s.on('error', function () {}); });
    server.on('stream', function (stream, headers) {
        var p = String(headers[':path']).split('?')[0];
        S.hits[p] = (S.hits[p] || 0) + 1;
        var n = S.hits[p];
        stream.on('error', function () {});
        stream.on('data', function () {});
        try {
            if (p === '/partial') {
                stream.respond({ ':status': 200, 'content-type': 'text/plain' });
                if (n === 1) { stream.write('abc'); } else { stream.end('abcdef'); }
            } else if (p === '/partialcl') {
                stream.respond({ ':status': 200, 'content-type': 'text/plain', 'content-length': '6' });
                if (n === 1) { stream.write('abc'); } else { stream.end('abcdef'); }
            } else if (p === '/cfin') {
                stream.respond({ ':status': 200, 'content-type': 'text/plain', 'content-length': String(Buffer.byteLength('abcdef-CFINMARK')) });
                stream.end('abcdef-CFINMARK');
            } else if (p === '/head6') {
                stream.respond({ ':status': 200, 'content-type': 'text/plain', 'content-length': '6' }, { endStream: true });
            } else if (p === '/utf8cl') {
                stream.respond({ ':status': 200, 'content-type': 'text/plain; charset=utf-8', 'content-length': String(Buffer.byteLength('ééé')) });
                stream.end('ééé');
            } else {
                stream.respond({ ':status': 200, 'content-type': 'application/json' });
                stream.end('{"ok":true}');
            }
        } catch (e) {}
    });
    return new Promise(function (res) { server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); }); });
}
function closeUpstream(h) {
    if (!h) { return; }
    h.S.sessions.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}

// A TCP proxy in front of `targetPort` that forwards both ways until told to cut every connection it holds: `fin()`
// ends the client side (what a crashed or restarted upstream sends), `blackhole()` drops every byte from then on and
// keeps the connection open (a silent drop, which only gina's own keepalive deadline ends). With `finMarker` set, the
// client side is ended right behind the upstream chunk that carries it.
function mkProxy(targetPort) {
    var P = { conns: [], finMarker: null };
    var server = net.createServer(function (down) {
        var c = { down: down, up: null, dead: false };
        P.conns.push(c);
        down.on('error', function () {});
        c.up = net.connect(targetPort, '127.0.0.1');
        c.up.on('error', function () {});
        down.on('data', function (d) { if (!c.dead) { c.up.write(d); } });
        c.up.on('data', function (d) {
            if (c.dead) { return; }
            down.write(d);
            if (P.finMarker && d.indexOf(P.finMarker) !== -1) { c.dead = true; try { down.end(); } catch (e) {} }
        });
        down.on('close', function () { c.up.destroy(); });
        c.up.on('close', function () { if (!c.dead) { down.destroy(); } });
    });
    P.fin = function () { P.conns.forEach(function (c) { c.dead = true; try { c.down.end(); } catch (e) {} }); };
    P.blackhole = function () { P.conns.forEach(function (c) { c.dead = true; }); };
    return new Promise(function (res) { server.listen(0, '127.0.0.1', function () { P.server = server; P.port = server.address().port; res(P); }); });
}
function closeProxy(P) {
    if (!P) { return; }
    P.conns.forEach(function (c) { try { c.down.destroy(); } catch (e) {} try { if (c.up) { c.up.destroy(); } } catch (e) {} });
    try { P.server.close(); } catch (e) {}
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r985', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb985', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1, head: 1 } },
                content: { routing: { r985: {} } }
            },
            rule: 'r985', control: 'act', bundle: 'tb985', controller: '/controllers/t985.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t985'), _cacheIsEnabled: 'false', _http2Sessions: [] };
    inst.throwError = function () {};
    return inst;
}
// One self.query() call over h2c; resolves with { err, result, ms }.
function q(inst, o) {
    var t0 = Date.now();
    var opts = { protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + o.port, host: '127.0.0.1', port: o.port,
                 path: o.path, method: o.method || 'GET', requestTimeout: o.requestTimeout || '15s' };
    return new Promise(function (res) {
        inst.query(opts, o.data || {}, function (err, result) { res({ err: err, result: result, ms: Date.now() - t0 }); });
    });
}
// The body a call delivered, as text, whatever shape the controller handed it over in.
function bodyOf(r) { return (typeof r.result === 'string') ? r.result : JSON.stringify(r.result); }
function errText(e) { return e ? JSON.stringify({ code: e.code, status: e.status, retryCount: e.retryCount, message: String(e.message || (e.error && e.error.message) || '').slice(0, 90) }) : 'none'; }
function destroyClientSessions(inst) {
    if (!inst) { return; }
    try { inst.serverInstance._cached.forEach(function (entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
}

var _connect = http2.connect;
var opened = [];

before(function () {
    http2.connect = function () { var s = _connect.apply(http2, arguments); opened.push(s); return s; };
    setContext('bundle', 'tb985');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb985: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65528 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65528'
        } } } }
    });
});
after(function () {
    http2.connect = _connect;
    opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
});

describe('01 - source: the end guard reads the response length and gina\'s own teardown', function () {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var at = src.indexOf('handleHTTP2ClientRequest');
    var fnEnd = src.indexOf('var _onStreamIncomplete', at);
    var code = strip(src.slice(at, src.indexOf('this.query = function', at) > -1 ? src.indexOf('this.query = function', at) : src.length));

    it('controls: the anchors are found', function () {
        assert.ok(at > -1, 'handleHTTP2ClientRequest');
        assert.ok(fnEnd > at, '_onStreamIncomplete after it');
        assert.ok(code.indexOf("req.on('response', function onResponseHeaders") > -1, 'the response-headers listener');
    });

    it('the response\'s content-length is read when its headers arrive', function () {
        assert.ok(/declaredLength = \(typeof\(_cl\) == 'string' && \/\^\\d\+\$\/\.test\(_cl\.trim\(\)\)\) \? parseInt\(_cl, 10\)/.test(code), 'declaredLength parsed from content-length');
    });

    it('the end guard: no response, a body shorter than its length (not a HEAD, 204 or 304), a session gina tore down, an empty body on a cancelled stream', function () {
        assert.ok(/var _shortBody = declaredLength !== null && _bodyBuf\.length < declaredLength && !\/\^head\$\/i\.test\(options\[':method'\]\) && httpStatus !== 204 && httpStatus !== 304;/.test(code), '_shortBody');
        assert.ok(/if \(httpStatus === null \|\| _shortBody \|\| client\._ginaTornDown === true \|\| \(\(!data \|\| data\.trim\(\) === ""\) && req\.rstCode > 0\)\) \{\s*return _onStreamIncomplete\(\);/.test(code), 'the guard');
    });

    it('every destroy gina makes in handleHTTP2ClientRequest flags the session first', function () {
        var flagged = code.split('client._ginaTornDown = true; client.destroy();').length - 1;
        var all = code.split('client.destroy()').length - 1;
        assert.equal(flagged, 7, 'the 7 destroy sites flag the session');
        assert.equal(all, flagged, 'no destroy is left unflagged');
    });

    it('the boot warmup flags its 3 destroys (core/gna.js)', function () {
        var g = strip(fs.readFileSync(GNA, 'utf8'));
        var w = g.slice(g.indexOf('function warmupHTTP2Sessions() {'));
        assert.equal(w.split('_wClient._ginaTornDown = true; _wClient.destroy();').length - 1, 3, 'the 3 warmup destroys flag the session');
        assert.equal(w.split('_wClient.destroy()').length - 1, 3, 'no warmup destroy is left unflagged');
    });
});

describe('02 - a body shorter than its content-length, cut by a FIN: a GET is sent again, a POST fails PREMATURE_CLOSE', function () {
    var h = null, P = null, inst = null;
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('the GET gets the whole body from its second attempt (pre-fix: the 3-byte partial body as a success)', async function () {
        h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst();
        var w = await q(inst, { port: P.port, path: '/fast' });
        assert.ok(!w.err, 'control: the session is up: ' + errText(w.err));
        var call = q(inst, { port: P.port, path: '/partialcl' });
        await sleep(300);
        P.fin();
        var r = await call;
        assert.ok(!r.err, 'no error: ' + errText(r.err));
        assert.equal(bodyOf(r), 'abcdef', 'the whole body');
        assert.equal(h.S.hits['/partialcl'], 2, 'sent twice');
    });

    it('a POST on the same shape fails PREMATURE_CLOSE (503), sent once', async function () {
        destroyClientSessions(inst); closeProxy(P); closeUpstream(h);
        h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst();
        var w = await q(inst, { port: P.port, path: '/fast' });
        assert.ok(!w.err, 'control: the session is up: ' + errText(w.err));
        var call = q(inst, { port: P.port, path: '/partialcl', method: 'POST', data: { a: 1 } });
        await sleep(300);
        P.fin();
        var r = await call;
        assert.ok(r.err, 'an error, not a success: ' + bodyOf(r));
        assert.equal(r.err.code, 'PREMATURE_CLOSE', errText(r.err));
        assert.equal(r.err.status, 503, errText(r.err));
        assert.equal(h.S.hits['/partialcl'], 1, 'sent once');
    });
});

describe('03 - a body gina\'s own keepalive deadline cut short (a silent drop, no content-length): the GET is sent again', function () {
    var h = null, P = null, inst = null;
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('the GET gets the whole body after the deadline (pre-fix: the 3-byte partial body as a success, except on Bun 1.4)', async function () {
        h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst();
        var w = await q(inst, { port: P.port, path: '/fast' });
        assert.ok(!w.err, 'control: the session is up: ' + errText(w.err));
        var call = q(inst, { port: P.port, path: '/partial' });
        await sleep(300);
        P.blackhole();
        var r = await call;
        assert.ok(!r.err, 'no error: ' + errText(r.err));
        assert.equal(bodyOf(r), 'abcdef', 'the whole body');
        assert.equal(h.S.hits['/partial'], 2, 'sent twice');
    });
});

describe('04 - controls: complete bodies stay successes, sent once', function () {
    var h = null, P = null, inst = null;
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('a complete body with its length, a FIN right behind it', async function () {
        h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst();
        var w = await q(inst, { port: P.port, path: '/fast' });
        assert.ok(!w.err, 'control: the session is up: ' + errText(w.err));
        P.finMarker = Buffer.from('CFINMARK');
        var r = await q(inst, { port: P.port, path: '/cfin' });
        assert.ok(!r.err, 'no error: ' + errText(r.err));
        assert.equal(bodyOf(r), 'abcdef-CFINMARK');
        assert.equal(h.S.hits['/cfin'], 1, 'sent once');
    });

    it('a HEAD declaring a length of 6 with no body, and a UTF-8 body whose length counts bytes', async function () {
        destroyClientSessions(inst); closeProxy(P); closeUpstream(h);
        h = await mkUpstream(); inst = makeInst();
        var hd = await q(inst, { port: h.port, path: '/head6', method: 'HEAD' });
        assert.ok(!hd.err, 'HEAD: no error: ' + errText(hd.err));
        assert.equal(h.S.hits['/head6'], 1, 'HEAD sent once');
        var u = await q(inst, { port: h.port, path: '/utf8cl' });
        assert.ok(!u.err, 'UTF-8: no error: ' + errText(u.err));
        assert.equal(bodyOf(u), 'ééé');
        assert.equal(h.S.hits['/utf8cl'], 1, 'UTF-8 sent once');
    });
});

describe('05 - a body the boot warmup\'s keepalive deadline cut short, on a session the warmup opened: the GET is sent again', function () {
    var h = null, P = null, inst = null;
    after(function () { destroyClientSessions(inst); closeProxy(P); closeUpstream(h); });

    it('the GET gets the whole body (pre-fix: the 3-byte partial body as a success, except on Bun 1.4)', async function () {
        h = await mkUpstream(); P = await mkProxy(h.port); inst = makeInst();
        // core/gna.js's warmupHTTP2Sessions, lifted with every identifier it closes over injected
        // (as query-h2-session-lifecycle.test.js § 10 lifts it)
        var gsrc = fs.readFileSync(GNA, 'utf8');
        var gAt = gsrc.indexOf('function warmupHTTP2Sessions() {'), gEnd = gsrc.indexOf('}); // end setImmediate', gAt);
        assert.ok(gAt > -1 && gEnd > gAt, 'the warmup is found in ' + GNA);
        var CacheLib = require(path.join(FW, 'lib', 'cache'));
        var warmup = new Function('lib', 'instance', 'conf', '_warmupTargets', 'require', 'return (' + gsrc.slice(gAt, gEnd + 1) + ');')(
            { Cache: CacheLib }, inst.serverInstance, { server: {} }, ['http://127.0.0.1:' + P.port], require);
        warmup();
        var key = 'http2session:http://127.0.0.1:' + P.port, t0 = Date.now(), entry = null;
        while (Date.now() - t0 < 3000) {
            entry = inst.serverInstance._cached.get(key);
            if (entry && entry.value && typeof entry.value._lastPongAt === 'number') { break; }
            await sleep(20);
        }
        assert.ok(entry && entry.value && typeof entry.value._lastPongAt === 'number', 'control: the warmup opened and pinged the session');
        var call = q(inst, { port: P.port, path: '/partial' });
        await sleep(300);
        P.blackhole();
        var r = await call;
        assert.ok(!r.err, 'no error: ' + errText(r.err));
        assert.equal(bodyOf(r), 'abcdef', 'the whole body');
        assert.equal(h.S.hits['/partial'], 2, 'sent twice');
    });
});
