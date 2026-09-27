/**
 * #P47 F6 — the HTTP/2 client stamped `status: 200` onto every JSON-shaped
 * upstream body that carried no `status`, and logged
 * `[<rule>] Response status code is undefined: switching to 200` on every such
 * call, with no gate. The HTTP/1.1 client never did either, so the same
 * upstream answer reached the caller as `{ a: 1 }` over HTTP/1.1 and as
 * `{ a: 1, status: 200 }` over HTTP/2 — and `self.forward()`, which relays the
 * query result with `renderJSON()`, carried the extra key into the end
 * client's body. On a JSON string body (`"[]"`, which the unanchored `\[\]`
 * alternative of the parse test lets through) the stamp threw in strict mode,
 * so HTTP/2 turned the upstream's success into `{ status: 500, error }`.
 *
 * Fix: the stamp and its warn are removed (kept as `// replaced:` comments at
 * the site). The error/success branch below the parse is unchanged — an
 * absent `status` already reads as success there — so only bodies WITHOUT
 * `status` change, and a body that carries one, numeric or not, is delivered
 * as it came.
 */

'use strict';

var assert = require('node:assert');
var { describe, it, before } = require('node:test');
var fs   = require('fs');
var path = require('path');
var http  = require('http');
var http2 = require('http2');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

function stripLineComments(text) {
    return text.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
}

describe('01 - #P47 F6 source pins: the h2 parse block delivers the parsed body as is', function() {

    var src = fs.readFileSync(SOURCE, 'utf8');
    var ANCHOR = '// 4. Data Parsing & Validation';
    var END    = '} else if (!data && req.aborted && req.destroyed) {';

    it('the parse block anchors are unique', function() {
        assert.equal(src.split(ANCHOR).length - 1, 1, 'the h2 parse-block comment must be unique');
        assert.equal(src.split(END).length - 1, 1, 'the block end must be unique');
    });

    it('NO live status stamp or warn remains in the parse block (comment-stripped, with strip control)', function() {
        var at = src.indexOf(ANCHOR);
        var block = src.slice(at, src.indexOf(END, at));
        assert.ok(block.length > 0 && block.length < 2500, 'the block slice is bounded (' + block.length + ' chars)');
        var live = stripLineComments(block);
        assert.equal(live.indexOf('data.status = 200'), -1, 'no status is stamped onto a status-less body');
        assert.equal(live.indexOf('switching to 200'), -1, 'no per-call warn');
        assert.ok(live.indexOf('data = JSON.parse(data);') > -1, 'the parse itself stays live');
        // instrument control (can-fail): the RAW block keeps the removed lines as
        // `// replaced:` comments, so the strip must be doing real work
        assert.ok(block.indexOf('data.status = 200') > -1, 'control: the removed stamp survives as a comment');
        assert.ok(block.indexOf('switching to 200') > -1, 'control: the removed warn survives as a comment');
        assert.ok(block.indexOf('#P47') > -1, 'the change is annotated in place');
    });
});

describe('02 - #P47 F6 behavioral: h2 delivers what h1 delivers', function() {

    before(function() {
        setContext('bundle', 'tb47');
        setContext('env', 'dev');
        setContext('gina', {
            ports: { 'http/1.1': { http: {} }, 'http/2.0': { http: {} } },
            config: { envConf: { tb47: { dev: {
                server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65517 },
                host: '127.0.0.1', hostname: 'http://127.0.0.1:65517'
            } } } }
        });
    });

    function makeInst() {
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r47', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
            res: { setHeader: function(){}, end: function(){}, writeHead: function(){}, getHeaders: function(){ return {}; }, statusCode: 200 },
            options: {
                conf: {
                    bundle: 'tb47', encoding: 'utf-8',
                    server: { protocol: 'http/1.1', scheme: 'http',
                              coreConfiguration: { statusCodes: { '201': 'Created', '404': 'Not Found', '500': 'Internal Server Error', '502': 'Bad Gateway', '503': 'Service Unavailable' }, mime: { json: 'application/json', txt: 'text/plain' } },
                              supportedRequestMethods: { get: 1 } },
                    content: { routing: { r47: {} } }
                },
                rule: 'r47', control: 'act', bundle: 'tb47', controller: '/controllers/t47.js'
            }
        });
        inst.serverInstance = { _cached: new Map(), _cachePath: '/tmp/gina-t47', _cacheIsEnabled: 'false', _http2Sessions: [] };
        var thrown = [];
        inst.throwError = function() {
            var a = arguments[0];
            thrown.push({ msg: String((a && (a.message || a.msg || a.error)) || a), status: a && a.status });
        };
        return { inst: inst, thrown: thrown };
    }
    function destroy(h) {
        try { h.inst.serverInstance._cached.forEach(function(v) { if (v && typeof v.destroy === 'function') { v.destroy(); } }); } catch (e) {}
        try { (h.inst.serverInstance._http2Sessions || []).forEach(function(s) { if (s && typeof s.destroy === 'function') { s.destroy(); } }); } catch (e) {}
    }
    function waitFor(fn, cap) {
        return new Promise(function(resolve, reject) {
            var t0 = Date.now();
            (function poll() {
                if (fn()) { return resolve(); }
                if (Date.now() - t0 > cap) { return reject(new Error('waitFor timeout')); }
                setTimeout(poll, 15);
            })();
        });
    }
    // Deterministic teardown (the 41bca5f2d lesson): track the upstream's
    // sessions / sockets and destroy them on close, and unref the listener, so
    // no straggler holds the file's event loop open.
    function h2Upstream(body) {
        return new Promise(function(resolve) {
            var sessions = [];
            var srv = http2.createServer(function(req, res) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(body);
            });
            srv.on('session', function(sess) { sessions.push(sess); });
            srv.listen(0, '127.0.0.1', function() {
                srv.unref();
                resolve({ port: srv.address().port, close: function() {
                    sessions.forEach(function(sess) { try { sess.destroy(); } catch (e) {} });
                    try { srv.close(); } catch (e) {}
                } });
            });
        });
    }
    function h1Upstream(body) {
        return new Promise(function(resolve) {
            var srv = http.createServer(function(req, res) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(body);
            });
            srv.listen(0, '127.0.0.1', function() {
                srv.unref();
                resolve({ port: srv.address().port, close: function() {
                    try { srv.closeAllConnections(); } catch (e) {}
                    try { srv.close(); } catch (e) {}
                } });
            });
        });
    }
    function h2Opts(P) {
        return { protocol: 'http/2.0', scheme: 'http', hostname: 'http://127.0.0.1:' + P, host: '127.0.0.1', port: P, path: '/x', method: 'GET', requestTimeout: '2s', headers: { 'content-type': 'application/json' } };
    }
    function h1Opts(P) {
        return { protocol: 'http/1.1', scheme: 'http', host: '127.0.0.1', port: P, path: '/x', method: 'GET', requestTimeout: '2s', maxRetry: 0, headers: { 'content-type': 'application/json' } };
    }
    // One call against a fresh upstream; resolves with the callback's arguments
    // and every console.warn line emitted while the call was in flight.
    async function callOnce(transport, body) {
        var s = transport === 'h2' ? await h2Upstream(body) : await h1Upstream(body);
        var h = makeInst(), got = [], warns = [];
        var origWarn = console.warn;
        console.warn = function() { warns.push(Array.prototype.join.call(arguments, ' ')); };
        try {
            h.inst.query(transport === 'h2' ? h2Opts(s.port) : h1Opts(s.port), {}, function(err, data) { got.push({ err: err, data: data }); });
            await waitFor(function() { return got.length || h.thrown.length; }, 3000);
        } finally {
            console.warn = origWarn;
            destroy(h);
            s.close();
        }
        return { got: got, warns: warns, thrown: h.thrown };
    }
    function ownStatus(data) {
        return data !== null && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'status');
    }
    var STAMP_WARN = /Response status code is undefined/;

    it('warn-capture control (can-fail): a warn from the same h2 end handler IS captured', async function() {
        // An empty body makes the h2 end handler log '[HTTP2] Empty response
        // received' — a real framework warn from the handler under test, so a
        // spy that could not see that handler's warns would fail here.
        var r = await callOnce('h2', '');
        assert.equal(r.got.length, 1, 'the call settles');
        assert.ok(r.warns.some(function(w) { return /\[HTTP2\] Empty response received/.test(w); }),
            'the spy sees warns emitted inside the h2 end handler: ' + JSON.stringify(r.warns));
    });

    it('h2 {"a":1}: the caller gets { a: 1 } — no status key is added', async function() {
        var r = await callOnce('h2', '{"a":1}');
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.deepStrictEqual(r.got[0].data, { a: 1 }, 'pre-fix measured: { a: 1, status: 200 }');
        assert.equal(ownStatus(r.got[0].data), false);
        assert.equal(r.thrown.length, 0);
    });

    it('h2 {"a":1}: no "switching to 200" warn is logged', async function() {
        var r = await callOnce('h2', '{"a":1}');
        assert.equal(r.got.length, 1);
        assert.deepStrictEqual(r.warns.filter(function(w) { return STAMP_WARN.test(w); }), [],
            'pre-fix: one warn line per status-less call');
    });

    it('h1 {"a":1} parity control: HTTP/1.1 delivered { a: 1 } before and after', async function() {
        var r = await callOnce('h1', '{"a":1}');
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.deepStrictEqual(r.got[0].data, { a: 1 });
        assert.deepStrictEqual(r.warns.filter(function(w) { return STAMP_WARN.test(w); }), []);
    });

    it('h2 "[]" (a JSON string body) succeeds with the string — it was a 500', async function() {
        var r = await callOnce('h2', JSON.stringify('[]'));
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false,
            'pre-fix: the stamp on a string threw in strict mode and delivered { status: 500, error }');
        assert.strictEqual(r.got[0].data, '[]');
        assert.equal(r.thrown.length, 0);
    });

    it('h1 "[]" parity control: HTTP/1.1 delivered the string before and after', async function() {
        var r = await callOnce('h1', JSON.stringify('[]'));
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.strictEqual(r.got[0].data, '[]');
    });

    it('h2 [{"id":1}]: an array body arrives without a status property', async function() {
        var r = await callOnce('h2', '[{"id":1}]');
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.ok(Array.isArray(r.got[0].data));
        assert.deepStrictEqual(Array.prototype.slice.call(r.got[0].data), [{ id: 1 }]);
        assert.equal(ownStatus(r.got[0].data), false, 'pre-fix: the array carried status 200');
    });

    it('control: a numeric status in the body is delivered as it came', async function() {
        var r = await callOnce('h2', '{"status":201,"a":1}');
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.deepStrictEqual(r.got[0].data, { status: 201, a: 1 });
        assert.deepStrictEqual(r.warns.filter(function(w) { return STAMP_WARN.test(w); }), []);
    });

    it('control: a non-numeric status (a domain value) is kept, not overwritten', async function() {
        var r = await callOnce('h2', '{"status":"active","a":1}');
        assert.equal(r.got.length, 1);
        assert.strictEqual(r.got[0].err, false);
        assert.deepStrictEqual(r.got[0].data, { status: 'active', a: 1 });
    });
});
