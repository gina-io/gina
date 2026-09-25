'use strict';
/**
 * self.query() over HTTP/2 — session resilience (#B612, #B613; bundle-to-bundle audit 2026-09-24)
 *
 * Real bytes: the real controller's `query()` is driven against bare `node:http2`
 * servers (the §40b standalone-bootstrap idiom of controller.test.js).
 *
 * #B613 — the client sent an RST_STREAM(NO_ERROR) after EVERY completed response
 *   (`_finalizeStream` ran `req.close()` while `req.closed` was still false), and the
 *   target's nghttp2 reset rate limit (1,000 burst, 33/s) GOAWAY'd the cached session
 *   with INTERNAL_ERROR, silently, after ~1,000 calls — in-flight calls then failed with
 *   "Session closed with error code 2". Arm §02 makes that visible cheaply by lowering
 *   the server's own limit (`streamResetBurst: 5`).
 * #B612 — an in-flight SAFE-method call cut by a server GOAWAY surfaced as
 *   ERR_HTTP2_SESSION_ERROR and was not retried (the whitelist held only
 *   ERR_HTTP2_STREAM_ERROR / ECONNRESET); a session destroyed between the cache read
 *   and the send made `client.request()` THROW synchronously with no guard.
 *
 * Red-first (2026-09-24): §02, §03 and §05 fail on the pre-fix controller, §04 holds
 * on both (the #B53 non-safe-method control).
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');
var http2 = require('node:http2');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
var C = http2.constants;

process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

// A bare h2c server whose per-stream behaviour is the arm's `onStream(stream, session, S)`.
function mkServer(onStream, opts) {
    var server = http2.createServer(opts || {});
    var S = { streams: 0, sessions: [], aborted: 0, closeCodes: {} };
    server.on('session', function(session) {
        S.sessions.push(session);
        session.on('error', function() {});
        session.on('stream', function(stream) {
            S.streams++;
            stream.on('error', function() {});
            stream.on('aborted', function() { S.aborted++; });
            stream.on('close', function() { S.closeCodes[stream.rstCode] = (S.closeCodes[stream.rstCode] || 0) + 1; });
            onStream(stream, session, S);
        });
    });
    return new Promise(function(res) {
        server.listen(0, '127.0.0.1', function() { res({ server: server, S: S, port: server.address().port }); });
    });
}
function ok200(stream) {
    stream.respond({ ':status': 200, 'content-type': 'application/json' });
    stream.end('{"ok":true}');
}
function closeServer(h) {
    h.S.sessions.forEach(function(s) { try { s.destroy(); } catch (e) {} });
    try { h.server.close(); } catch (e) {}
}

function makeInst() {
    var inst = SuperController.createTestInstance({
        req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'rq', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
        res: { setHeader: function(){}, end: function(){}, writeHead: function(){}, getHeaders: function(){ return {}; }, statusCode: 200 },
        options: {
            conf: {
                bundle: 'tbq', encoding: 'utf-8',
                server: { protocol: 'http/1.1', scheme: 'http',
                          coreConfiguration: { statusCodes: { '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                          supportedRequestMethods: { get: 1, post: 1 } },
                content: { routing: { rq: {} } }
            },
            rule: 'rq', control: 'act', bundle: 'tbq', controller: '/controllers/tq.js'
        }
    });
    inst.serverInstance = { _cached: new Map(), _cachePath: '/tmp/gina-tq', _cacheIsEnabled: 'false', _http2Sessions: [] };
    inst.throwError = function() {};
    return inst;
}
// The cached client session for an authority — the cache stores {value, cleanup} wrappers.
function cachedSession(inst, port) {
    var entry = inst.serverInstance._cached.get('http2session:http://127.0.0.1:' + port);
    return entry && entry.value ? entry.value : entry;
}
function destroyClientSessions(inst) {
    try { inst.serverInstance._cached.forEach(function(entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
}
function q(inst, port, method, data) {
    return new Promise(function(res) {
        var opts = { protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + port, host: '127.0.0.1',
                     port: port, path: '/x', method: method || 'GET', requestTimeout: '2s' };
        inst.query(opts, data || {}, function(err, result) { res({ err: err, result: result }); });
    });
}

before(function() {
    setContext('bundle', 'tbq');
    setContext('env', 'dev');
    setContext('gina', {
        ports: { 'http/1.1': { http: {} }, 'http/2.0': { http: {} } },
        config: { envConf: { tbq: { dev: {
            server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65530 },
            host: '127.0.0.1', hostname: 'http://127.0.0.1:65530'
        } } } }
    });
});

describe('01 - source pins (#B612 / #B613)', function() {
    var src = fs.readFileSync(SOURCE, 'utf8');
    var h2Start = src.indexOf('var handleHTTP2ClientRequest = function(');
    var h2End   = src.indexOf('var getSession = function()');
    var block   = src.slice(h2Start, h2End);

    it('#B613 — _finalizeStream carries no live req.close(); the retired line survives as a replaced: comment (control)', function() {
        var helperIdx = block.indexOf('var _finalizeStream = function _finalizeStream()');
        assert.ok(helperIdx > -1);
        var endIdx = block.indexOf('};', helperIdx);
        assert.equal(stripLineComments(block.slice(helperIdx, endIdx)).indexOf('req.close('), -1, 'no live close() in the helper');
        assert.ok(block.slice(helperIdx - 1500, helperIdx).indexOf('// replaced: try { if (!req.closed && !req.destroyed) { req.close(); } } catch (e) {}') > -1,
            'control: the retired line is recorded above the helper');
    });

    it('#B612 — ERR_HTTP2_SESSION_ERROR is in the stream-error retry whitelist, under the #B53 method gate, and the branch drops the tracker entry', function() {
        var cond = "(errorCode === 'ERR_HTTP2_STREAM_ERROR' || errorCode === 'ERR_HTTP2_SESSION_ERROR' || errorCode === 'ECONNRESET') && isRetryableMethod(options[':method'], options.retryUnsafe)";
        var condIdx = block.indexOf(cond);
        assert.ok(condIdx > -1, 'expected the three-code whitelist conjoined with the method gate');
        var branch = block.slice(condIdx, block.indexOf('handleHTTP2ClientRequest(browser, options, callback, _eNext', condIdx));
        assert.ok(branch.indexOf('cache.delete(sessKey);') > -1, 'the retry branch evicts the cache entry');
        assert.ok(branch.indexOf('_http2Sessions.splice(') > -1, 'the retry branch splices the tracker too (it was the only retry branch that did not)');
    });

    it('#B612 — client.request() is guarded: a synchronous throw evicts, retries on a fresh session regardless of method, and exhausts into a typed 503', function() {
        var sendIdx = block.indexOf('var _sendRequest = function _sendRequest()');
        var tryIdx  = block.indexOf('try {', sendIdx);
        var reqIdx  = block.indexOf('req = client.request(headers);', tryIdx);
        var catchIdx = block.indexOf('} catch (_reqErr) {', reqIdx);
        assert.ok(sendIdx > -1 && tryIdx > sendIdx && reqIdx > tryIdx && catchIdx > reqIdx, 'request() is inside a try/catch at the top of _sendRequest');
        var guardBody = block.slice(catchIdx, block.indexOf('let isFinished', catchIdx));
        assert.ok(guardBody.indexOf('if (retryCount < HTTP2_MAX_RETRIES) {') > -1, 'bare-budget retry (pre-send: no method gate)');
        assert.equal(guardBody.indexOf('isRetryableMethod('), -1, 'no method gate on a pre-send failure');
        assert.ok(guardBody.indexOf('cache.delete(sessKey);') > -1 && guardBody.indexOf('_http2Sessions.splice(') > -1, 'evicts cache + tracker');
        assert.ok(/status\s*:\s*503/.test(guardBody) && /retryable\s*:\s*false/.test(guardBody), 'the exhausted terminal is a typed 503, not retryable');
        assert.ok(guardBody.indexOf('if (_swallowIfNonCritical(_sessGoneErr)) return;') > -1, 'H3 swallow ordering kept');
    });
});

describe('02 - #B613 live: completed calls on one cached session no longer feed the target\'s reset rate limit', function() {
    // The server's OWN nghttp2 limit is lowered to a 5-frame burst so the pre-fix
    // behaviour (one RST_STREAM per completed response) shows within a dozen calls:
    // staggered responders keep streams in flight when the trip lands, so the failure
    // is visible as errors — and, on both sides, as GOAWAY events on the client session.
    var h = null, inst = null;
    before(async function() {
        var n = 0;
        h = await mkServer(function(stream) {
            n++;
            var delay = 10 + (n % 8) * 10;
            setTimeout(function() { if (!stream.closed && !stream.destroyed) { try { ok200(stream); } catch (e) {} } }, delay);
        }, { streamResetBurst: 5, streamResetRate: 1 });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('3 batches of 8 concurrent GETs: every call answers, the cached session sees no GOAWAY, the server saw no aborted stream', async function() {
        var results = [];
        var goaways = [];
        for (var b = 0; b < 3; b++) {
            var batch = [];
            for (var i = 0; i < 8; i++) { batch.push(q(inst, h.port, 'GET')); }
            var r = await Promise.all(batch);
            results = results.concat(r);
            if (b === 0) {
                var sess = cachedSession(inst, h.port);
                assert.ok(sess && !sess.destroyed, 'the first batch cached one live session');
                sess.on('goaway', function(code) { goaways.push(code); });
            }
            await sleep(50);
        }
        var failed = results.filter(function(x) { return x.err; });
        assert.equal(failed.length, 0, 'no call failed (pre-fix: in-flight calls died with "Session closed with error code 2"): ' + JSON.stringify(failed.map(function(x) { return x.err && (x.err.code + ' ' + x.err.message); })));
        assert.equal(results.filter(function(x) { return x.result && x.result.ok === true; }).length, 24, 'all 24 bodies delivered');
        assert.deepEqual(goaways, [], 'the cached session was never GOAWAY\'d by the target');
        assert.equal(h.S.aborted, 0, 'no stream was cut short');
        assert.equal(h.S.sessions.length, 1, 'ONE client session carried all 24 calls');
    });
});

describe('03 - #B612 live: an in-flight GET cut by a server GOAWAY is retried on a fresh session', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream, session, S) {
            if (S.streams === 2) { session.goaway(C.NGHTTP2_ENHANCE_YOUR_CALM); session.close(); return; } // the in-flight call dies
            ok200(stream);
        });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('call 1 establishes the cached session; call 2 is cut by the GOAWAY and answers through a retry', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err && a.result && a.result.ok === true, 'call 1 answered');
        var b = await q(inst, h.port, 'GET');
        assert.ok(!b.err, 'call 2 answered after the GOAWAY (pre-fix: ' + (b.err && (b.err.code + ' ' + b.err.message)) + ')');
        assert.equal(b.result && b.result.ok, true);
        assert.equal(h.S.streams, 3, 'the retry reached the server as a third stream');
        assert.equal(h.S.sessions.length, 2, 'on a fresh session');
    });
});

describe('04 - #B53 control: an in-flight POST cut by a server GOAWAY is NOT retried (not opted in with retryUnsafe)', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream, session, S) {
            if (S.streams === 2) { session.goaway(C.NGHTTP2_ENHANCE_YOUR_CALM); session.close(); return; }
            ok200(stream);
        });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    it('the POST surfaces the typed STREAM_ERROR and the server saw no third stream', async function() {
        var a = await q(inst, h.port, 'POST', { a: 1 });
        assert.ok(!a.err, 'call 1 answered');
        var b = await q(inst, h.port, 'POST', { a: 2 });
        assert.ok(b.err, 'the POST must not be replayed');
        assert.equal(b.err.code, 'STREAM_ERROR');
        await sleep(100);
        assert.equal(h.S.streams, 2, 'no retry stream');
    });
});

describe('05 - #B612 live: a session gone between the cache read and the send is retried, for any method', function() {
    var h = null, inst = null;
    before(async function() {
        h = await mkServer(function(stream) { ok200(stream); });
        inst = makeInst();
    });
    after(function() { destroyClientSessions(inst); closeServer(h); });

    function armSyncThrowOnce(inst, port, code) {
        var sess = cachedSession(inst, port);
        assert.ok(sess, 'a session is cached');
        var real = sess.request;
        var thrown = { n: 0 };
        sess.request = function() {
            thrown.n++;
            sess.request = real;
            throw Object.assign(new Error('The session has been destroyed'), { code: code });
        };
        return thrown;
    }

    it('GET: request() throws ERR_HTTP2_INVALID_SESSION once — the call still answers, through a fresh session', async function() {
        var a = await q(inst, h.port, 'GET');
        assert.ok(!a.err, 'call 1 answered');
        var thrown = armSyncThrowOnce(inst, h.port, 'ERR_HTTP2_INVALID_SESSION');
        var b = await q(inst, h.port, 'GET');
        assert.equal(thrown.n, 1, 'the throw was exercised');
        assert.ok(!b.err, 'call 2 answered (pre-fix: ' + (b.err && (b.err.code + ' ' + b.err.message)) + ')');
        assert.equal(b.result && b.result.ok, true);
        assert.equal(h.S.sessions.length, 2, 'a fresh session was opened');
    });

    it('POST: the same pre-send throw is also retried — nothing was sent, so replay-safety does not apply', async function() {
        // MEASURED 2026-09-24 (this arm, first run): after the GET arm's retry replaced the
        // session, the cache held NO entry for the authority — the dead session's own
        // asynchronous 'close' listener evicts BY KEY and took the fresh replacement with
        // it, leaving that replacement an orphan (alive, keepalive ticking, in no cache).
        // That is the session-leak mechanism the bundle-to-bundle audit filed as F3, owned
        // by the session-lifecycle slice (identity-checked eviction); here one plain call
        // re-establishes a cached session before the arm's own measurement.
        var re = await q(inst, h.port, 'GET');
        assert.ok(!re.err, 're-established');
        var thrown = armSyncThrowOnce(inst, h.port, 'ERR_HTTP2_GOAWAY_SESSION');
        var c = await q(inst, h.port, 'POST', { a: 3 });
        assert.equal(thrown.n, 1);
        assert.ok(!c.err, 'the POST answered through a fresh session');
        assert.equal(c.result && c.result.ok, true);
    });
});
