'use strict';
/**
 * self.query() over HTTP/1.1 — a requestTimeout fails with its own error, and a response that stalls after its
 * headers calls back instead of hanging (#B969)
 *
 * Real bytes: the real controller's `query()` is driven against a bare `node:http` upstream (the standalone
 * bootstrap of query-status-line-b984.test.js).
 *
 * Up to 0.7.7 the HTTP/1.1 timeout destroyed the request with no error. Before the response had started, the
 * call then failed like a reset connection: `ECONNRESET` « socket hang up », rewritten to « `Controller::query()`
 * could not connect to [ … ] using port N » when the port is a registered bundle port, with no `status` and no
 * `retryCount`. Once the response headers had arrived, the call never called back at all. Since 0.7.8 the
 * timeout destroys the request with an `Error` coded `ETIMEDOUT`, `status: 503` and `retryCount` (the attempt it
 * was on), message « [HTTP1] No response from <hostname> after <time> », in both cases. The re-send rule is
 * unchanged (a safe method, or a `retryUnsafe` call, is re-sent up to `maxRetry` times), a refused connection
 * still reads « could not connect », and the #MS5 circuit breaker still counts the timeout.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var os = require('os');
var net = require('net');
var path = require('path');
var http = require('http');
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

var TIMEOUT     = '600ms';  // the caller's requestTimeout; the error's label reads « 600ms »
var SLOW_MS     = 2500;     // a live upstream answering after the timeout of every attempt
var DEADLINE_MS = 15000;    // a call that has not called back by then is reported as hung (0.7.7, stalled response)
var BUNDLE      = 'web@t969/dev';

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function strip(text) { return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n'); }

function answer(res) {
    if (res.destroyed || res.writableEnded) { return; }
    try { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); } catch (e) {}
}
// A bare HTTP/1.1 upstream: /fast* answers at once, /slow* after SLOW_MS, /stall* sends its headers and the
// start of its body at once, then stalls SLOW_MS. Every request is recorded with its client port.
function mkUpstream() {
    var S = { paths: [], ports: [], sockets: [], timers: [] };
    var server = http.createServer(function (req, res) {
        var p = String(req.url).split('?')[0];
        S.paths.push(p);
        S.ports.push(req.socket.remotePort);
        req.on('data', function () {});
        res.on('error', function () {});
        if (/^\/fast/.test(p)) { return answer(res); }
        if (/^\/slow/.test(p)) { S.timers.push(setTimeout(function () { answer(res); }, SLOW_MS)); return; }
        if (/^\/stall/.test(p)) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.write('{"ok":');
            S.timers.push(setTimeout(function () {
                if (res.destroyed || res.writableEnded) { return; }
                try { res.end('true}'); } catch (e) {}
            }, SLOW_MS));
            return;
        }
        res.writeHead(404);
        res.end();
    });
    server.keepAliveTimeout = 30000; // an idle pooled socket is never closed by the upstream during a describe
    server.on('connection', function (sock) { S.sockets.push(sock); sock.on('error', function () {}); });
    return new Promise(function (res) {
        server.listen(0, '127.0.0.1', function () { res({ server: server, S: S, port: server.address().port }); });
    });
}
function closeUpstream(u) {
    if (!u) { return; }
    u.S.timers.forEach(clearTimeout);
    u.S.sockets.forEach(function (s) { try { s.destroy(); } catch (e) {} });
    try { u.server.close(); } catch (e) {}
}
// A port nothing listens on: bound once, then released.
function deadPort() {
    return new Promise(function (res) {
        var s = net.createServer();
        s.listen(0, '127.0.0.1', function () { var p = s.address().port; s.close(function () { res(p); }); });
    });
}
// Register a port as a bundle's port, as the framework does for every bundle it starts: the « could not
// connect » rewrite names it.
function registerPort(port) { getContext('gina').ports['http/1.1'].http[port] = BUNDLE; }

var thrown = [];
function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r969', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tb969', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: CODES, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { r969: {} } }
            },
            rule: 'r969', control: 'act', bundle: 'tb969', controller: '/controllers/t969.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t969'), _cacheIsEnabled: 'false', _http2Sessions: [] };
    // every answer here reaches the callback: one through throwError() is recorded and fails the arm
    inst.throwError = function (e) { thrown.push(e); };
    return inst;
}
function destroyAgents(inst) {
    if (!inst || !(inst.serverInstance._h1Agents instanceof Map)) { return; }
    inst.serverInstance._h1Agents.forEach(function (a) { try { a.destroy(); } catch (e) {} });
}
function opts(o) {
    var x = { protocol: 'http/1.1', scheme: 'http', hostname: 'http://127.0.0.1:' + o.port, host: '127.0.0.1',
              port: o.port, path: o.path, method: o.method || 'GET', requestTimeout: o.requestTimeout || TIMEOUT };
    if (o.retryUnsafe) { x.retryUnsafe = true; }
    return x;
}
// One self.query() call in callback form. Resolves at its first callback with { err, result, ms, hung, calls() },
// or with hung: true when no callback came within DEADLINE_MS.
function q(inst, o) {
    var t0 = Date.now(), n = 0, settled = false;
    return new Promise(function (res) {
        var timer = setTimeout(function () {
            if (settled) { return; }
            settled = true;
            res({ err: null, result: undefined, ms: Date.now() - t0, hung: true, calls: function () { return n; } });
        }, DEADLINE_MS);
        inst.query(opts(o), o.data || {}, function (err, result) {
            n++;
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            res({ err: err, result: result, ms: Date.now() - t0, hung: false, calls: function () { return n; } });
        });
    });
}
function errText(e) { return e ? JSON.stringify({ code: e.code, status: e.status, retryCount: e.retryCount, message: e.message }) : String(e); }
function count(list, item) { return list.filter(function (x) { return x === item; }).length; }
function noResponse(port) { return '[HTTP1] No response from http://127.0.0.1:' + port + ' after 600ms'; }
// The timeout's error, as every arm below expects it.
function assertTimeout(r, port, retryCount, label) {
    assert.equal(r.hung, false, label + ': the call called back (0.7.7, a stalled response: never) within ' + DEADLINE_MS + ' ms');
    assert.ok(r.err instanceof Error, label + ': a native Error, got ' + errText(r.err));
    assert.equal(r.err.code, 'ETIMEDOUT', label + ': coded ETIMEDOUT (0.7.7: ECONNRESET) ' + errText(r.err));
    assert.equal(r.err.status, 503, label + ': status 503, as an HTTP/2 timeout ' + errText(r.err));
    assert.equal(r.err.retryCount, retryCount, label + ': the attempt it was on ' + errText(r.err));
    assert.equal(r.err.message, noResponse(port), label + ': the message names the timeout');
    assert.doesNotMatch(r.err.message, /could not connect/, label + ': never « could not connect »');
    assert.equal(r.result, undefined, label + ': no data beside the error');
}

before(function () {
    setContext('bundle', 'tb969');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
        config: { envConf: { tb969: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65529 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65529'
        } } } }
    });
});

describe('01 - source: the HTTP/1.1 timeout destroys the request with its own error; the re-send rule is untouched', function () {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var live = strip(src);
    var H1 = 'var handleHTTP1ClientRequest = function(';
    var RETRY = 'if (retryCount < Math.min(options.maxRetry, 10) && isRetryableMethod(options.method, options.retryUnsafe)) {';
    var h1 = live.indexOf(H1);
    var end = live.indexOf("if (req) { // don't touch this please", h1);
    var at = live.indexOf('req.setTimeout(', h1);
    var handler = live.slice(h1, end);
    var block = live.slice(at, end);

    it('controls: the handler, its timeout and its re-send line are found once; the file keeps its 4 re-send gates', function () {
        assert.ok(h1 > -1, 'the HTTP/1.1 handler is found');
        assert.equal(live.indexOf(H1, h1 + 1), -1, 'one HTTP/1.1 handler');
        assert.ok(at > h1 && end > at, 'its timeout is found, above the write');
        assert.equal(handler.split('req.setTimeout(').length - 1, 1, 'one timeout in the handler');
        assert.equal(handler.split(RETRY).length - 1, 1, 'the re-send line, unchanged');
        assert.equal((src.match(/isRetryableMethod\(options/g) || []).length, 4, 'the 4 re-send gates');
    });

    it('the timeout destroys the request with an Error coded ETIMEDOUT, status 503, carrying the attempt', function () {
        assert.ok(block.indexOf("new Error('[HTTP1] No response from '") > -1, 'a native Error named for the timeout');
        assert.match(block, /\.code\s*=\s*'ETIMEDOUT';/, 'coded ETIMEDOUT');
        assert.match(block, /\.status\s*=\s*503;/, 'status 503');
        assert.match(block, /\.retryCount\s*=\s*retryCount;/, 'the attempt it was on');
        assert.match(block, /req\.destroy\(\s*[A-Za-z_$][\w$]*\s*\)/, 'the request is destroyed with that error');
        assert.equal(block.indexOf('req.destroy()'), -1, 'never without one (0.7.7: « socket hang up », or no callback once the response had started)');
    });
});

describe('02 - a live but slow upstream: the timeout fails ETIMEDOUT / 503, never « could not connect »', function () {
    var u = null, inst = null;
    before(async function () { u = await mkUpstream(); registerPort(u.port); inst = makeInst(); thrown.length = 0; });
    after(function () { destroyAgents(inst); closeUpstream(u); });

    it('control: a fast GET answers', async function () {
        var r = await q(inst, { port: u.port, path: '/fast/0' });
        assert.equal(r.err, false, 'answered: ' + errText(r.err));
        assert.deepEqual(r.result, { ok: true });
    });

    it('a slow GET is re-sent as before, then fails ETIMEDOUT / 503 / retryCount 2', async function () {
        var r = await q(inst, { port: u.port, path: '/slow/g' });
        assertTimeout(r, u.port, 2, 'slow GET');
        assert.ok(r.ms >= 3000 && r.ms < 10000, 'three attempts and two pauses, after ' + r.ms + ' ms');
        await sleep(100);
        assert.equal(count(u.S.paths, '/slow/g'), 3, 'the upstream ran it 3 times (the re-send rule is unchanged): ' + JSON.stringify(u.S.paths));
        assert.equal(r.calls(), 1, 'one callback');
    });

    it('a slow POST fails ETIMEDOUT / 503 / retryCount 0 at requestTimeout, and is not re-sent', async function () {
        var r = await q(inst, { port: u.port, path: '/slow/p', method: 'POST', data: { a: 1 } });
        assertTimeout(r, u.port, 0, 'slow POST');
        assert.ok(r.ms >= 500 && r.ms < 3000, 'at requestTimeout, after ' + r.ms + ' ms');
        await sleep(100);
        assert.equal(count(u.S.paths, '/slow/p'), 1, 'the upstream ran it once: ' + JSON.stringify(u.S.paths));
        assert.equal(r.calls(), 1, 'one callback');
        assert.equal(thrown.length, 0, 'nothing was answered through throwError()');
    });
});

describe('03 - a response that stalls after its headers: the call fails ETIMEDOUT instead of never calling back', function () {
    var u = null, inst = null;
    before(async function () { u = await mkUpstream(); registerPort(u.port); inst = makeInst(); thrown.length = 0; });
    after(function () { destroyAgents(inst); closeUpstream(u); });

    it('a POST whose response stalls fails ETIMEDOUT / 503 / retryCount 0, once', async function () {
        var r = await q(inst, { port: u.port, path: '/stall/p', method: 'POST', data: { a: 1 } });
        assertTimeout(r, u.port, 0, 'stalled POST');
        assert.ok(r.ms >= 500 && r.ms < 3000, 'at requestTimeout, after ' + r.ms + ' ms');
        await sleep(400);
        assert.equal(r.calls(), 1, 'one callback: the stalled body is never delivered as well');
        assert.equal(count(u.S.paths, '/stall/p'), 1, 'one upstream run');
    });

    it('a GET whose response stalls is re-sent as before, then fails ETIMEDOUT / 503 / retryCount 2, once', async function () {
        var r = await q(inst, { port: u.port, path: '/stall/g' });
        assertTimeout(r, u.port, 2, 'stalled GET');
        await sleep(400);
        assert.equal(r.calls(), 1, 'one callback');
        assert.equal(count(u.S.paths, '/stall/g'), 3, 'three upstream runs: ' + JSON.stringify(u.S.paths));
        assert.equal(thrown.length, 0, 'nothing was answered through throwError()');
    });
});

describe('04 - controls: a refused connection still reads « could not connect »', function () {
    var port = 0, inst = null;
    before(async function () { port = await deadPort(); registerPort(port); inst = makeInst(); });
    after(function () { destroyAgents(inst); });

    it('a GET to a registered port nothing listens on fails ECONNREFUSED « could not connect », after its re-sends', async function () {
        var r = await q(inst, { port: port, path: '/fast/d' });
        assert.equal(r.hung, false, 'the call called back');
        assert.ok(r.err instanceof Error, 'a native Error: ' + errText(r.err));
        assert.ok(r.err.code === 'ECONNREFUSED' || (r.err.cause && r.err.cause.code === 'ECONNREFUSED'), 'ECONNREFUSED: ' + errText(r.err));
        assert.match(r.err.message, /could not connect to \[ web@t969\/dev \] using port \d+/, 'the rewrite names the bundle');
        assert.equal(r.err.status, undefined, 'no status of its own');
        assert.ok(r.ms >= 1400, 'after two re-sends (500 ms, then 1 s): ' + r.ms + ' ms');
    });
});

describe('05 - the #MS5 circuit breaker counts the timeout', function () {
    var u = null, inst = null;
    before(async function () {
        u = await mkUpstream();
        inst = makeInst();
        inst.serverInstance._queryCircuitBreaker = { enabled: true, failureThreshold: 2, cooldownMs: 30000 };
    });
    after(function () { destroyAgents(inst); closeUpstream(u); });

    it('two timed-out POSTs open the circuit: the next call fails CIRCUIT_OPEN without reaching the upstream', async function () {
        assertTimeout(await q(inst, { port: u.port, path: '/slow/b1', method: 'POST', data: { a: 1 } }), u.port, 0, 'first POST');
        assertTimeout(await q(inst, { port: u.port, path: '/slow/b2', method: 'POST', data: { a: 1 } }), u.port, 0, 'second POST');
        var r = await q(inst, { port: u.port, path: '/fast/b' });
        assert.ok(r.err, 'the GET failed: the circuit is open');
        assert.equal(r.err.code, 'CIRCUIT_OPEN', errText(r.err));
        assert.equal(r.err.status, 503);
        assert.equal(count(u.S.paths, '/fast/b'), 0, 'the upstream never received it: ' + JSON.stringify(u.S.paths));
    });
});

describe('06 - the 503 travels: the onComplete handle and the promisified call', function () {
    var u = null, inst = null;
    before(async function () { u = await mkUpstream(); inst = makeInst(); });
    after(function () { destroyAgents(inst); closeUpstream(u); });

    it('through onComplete, a timed-out POST arrives as { status: 503, error } (0.7.7: 500)', async function () {
        var r = await new Promise(function (res) {
            inst.query(opts({ port: u.port, path: '/slow/h', method: 'POST' }), { a: 1 }).onComplete(function (err, data) { res({ err: err, data: data }); });
        });
        assert.ok(r.err, 'an error');
        assert.equal(r.err.status, 503, 'the wrap keeps the error\'s status: ' + JSON.stringify({ status: r.err.status }));
        assert.ok(r.err.error instanceof Error, 'the native Error inside');
        assert.equal(r.err.error.code, 'ETIMEDOUT');
        assert.equal(r.data, undefined, 'no data');
    });

    it('the promisified call rejects with the native Error', async function () {
        await assert.rejects(util.promisify(inst.query)(opts({ port: u.port, path: '/slow/r', method: 'POST' }), { a: 1 }), function (e) {
            return e instanceof Error && e.code === 'ETIMEDOUT' && e.status === 503 && e.message === noResponse(u.port);
        }, 'rejects with the timeout\'s error');
        var ok = await util.promisify(inst.query)(opts({ port: u.port, path: '/fast/r' }), {});
        assert.deepEqual(ok, { ok: true }, 'control: a fast call still resolves');
    });
});
