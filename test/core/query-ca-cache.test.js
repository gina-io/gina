/**
 * #B633 — an https `self.query()` reads its CA file from disk only when the file changed.
 *
 * Before: both client handlers ran `fs.readFileSync(options.ca)` on every https call — `query()`
 * clones its options per call, so `options.ca` starts as a path each time — about 25 µs per call,
 * and on HTTP/2 even when a cached session made the CA unnecessary. Now `_readQueryCa` caches the
 * read Buffer per path on the engine instance (`serverInstance._caCache`) and revalidates it with
 * one `fs.statSync` per call, so a CA replaced on disk is still used by the next call.
 *
 * Sections:
 *   01 — source pins: no live `readFileSync(options.ca)` is left; both handlers use the helper;
 *        the helper stats and compares inode, size, mtime and ctime, and falls back to the plain
 *        read when the stat fails.
 *   02 — behavioural, through the REAL controller (`createTestInstance` + live https upstreams),
 *        counting `fs.readFileSync` calls on the CA path:
 *        a) HTTP/1.1 + https: five calls read the CA once;
 *        b) HTTP/2 + https: five calls read the CA once;
 *        c) a CA replaced on disk (write + rename, the inode change a Kubernetes Secret update
 *           makes) is read again by the very next call and used by it: the upstream signed by
 *           the new CA is accepted, the one signed by the old CA is refused;
 *        d) a missing CA file fails the call with the same `open` error as before, and nothing
 *           is cached for it.
 *
 * Red-first: 02a and 02b count five reads, and the 01 pins fail, on the pre-change bytes.
 */
'use strict';

var assert = require('node:assert');
var { describe, it, before, after } = require('node:test');
var fs    = require('fs');
var path  = require('path');
var os    = require('os');
var https = require('https');
var http2 = require('http2');
var { execFileSync } = require('child_process');

var FW = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + FW;
require('module').Module._initPaths();
require(path.join(FW, 'helpers'));
require(path.join(FW, '..', '..', 'utils', 'prototypes'));
setPath('gina', { core: path.join(FW, 'core') });
var SuperController = require(SOURCE);

var SRC = fs.readFileSync(SOURCE, 'utf8');

function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1');
}
function region(src, startNeedle, endNeedle) {
    var a = src.indexOf(startNeedle); assert.ok(a > -1, 'anchor missing: ' + startNeedle);
    var b = src.indexOf(endNeedle, a); assert.ok(b > a, 'end anchor missing: ' + endNeedle);
    return src.slice(a, b);
}

// ── 01 — source pins ────────────────────────────────────────────────────────

describe('01 - #B633 source pins', function () {
    var LIVE = stripComments(SRC);

    it('no live `readFileSync(options.ca)` is left; both call sites use the helper (control: the helper call survives the comment strip)', function () {
        assert.strictEqual((LIVE.match(/readFileSync\(options\.ca\)/g) || []).length, 0, 'no per-call read of the CA');
        assert.strictEqual((LIVE.match(/options\.ca = _readQueryCa\(options\.ca\)/g) || []).length, 2, 'both handlers read through the helper');
    });

    it('each handler reads its CA through the helper', function () {
        var h1 = region(LIVE, 'var handleHTTP1ClientRequest = function', 'var handleHTTP2ClientRequest = function');
        var h2 = region(LIVE, 'var handleHTTP2ClientRequest = function', 'var getSession = function()');
        assert.ok(h1.indexOf('_readQueryCa(options.ca)') > -1, 'HTTP/1 handler');
        assert.ok(h2.indexOf('_readQueryCa(options.ca)') > -1, 'HTTP/2 handler');
    });

    it('the helper revalidates with one stat on inode, size, mtime and ctime, and falls back to the read when the stat fails', function () {
        var fn = region(LIVE, 'var _readQueryCa = function', 'var handleHTTP1ClientRequest = function');
        assert.ok(fn.indexOf('fs.statSync(caPath)') > -1, 'stat');
        ['hit.ino === st.ino', 'hit.size === st.size', 'hit.mtimeMs === st.mtimeMs', 'hit.ctimeMs === st.ctimeMs'].forEach(function (k) {
            assert.ok(fn.indexOf(k) > -1, 'compares ' + k);
        });
        assert.ok(/catch \(statErr\) \{\s*return fs\.readFileSync\(caPath\);/.test(fn), 'a failed stat returns the plain read, so its error is unchanged');
        assert.ok(fn.indexOf('inst._caCache.size >= QUERY_CA_MAX') > -1, 'the cache is capped');
    });
});

// ── 02 — behavioural, through the real controller ───────────────────────────

describe('02 - #B633 behavioural: the CA file is read once, and again only when it changes', function () {

    var CALLER = 'tb633caller';
    var TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b633-'));

    // Count fs.readFileSync calls per registered CA path. The controller calls
    // `fs.readFileSync(...)` through the shared `fs` module object, so the wrapper sees them.
    var reads = {};
    var _readFileSync = fs.readFileSync;
    function watch(p) { reads[p] = 0; return p; }

    // Every HTTP/2 client session this file opens, so teardown can close them all.
    var opened = [];
    var _connect = http2.connect;

    before(function () {
        fs.readFileSync = function (p) {
            if (typeof p === 'string' && Object.prototype.hasOwnProperty.call(reads, p)) { reads[p]++; }
            return _readFileSync.apply(fs, arguments);
        };
        http2.connect = function () { var s = _connect.apply(http2, arguments); opened.push(s); return s; };
        setContext('bundle', CALLER);
        setContext('env', 'dev');
        setContext('gina', {
            ports: { 'http/1.1': { http: {}, https: {} }, 'http/2.0': { http: {}, https: {} } },
            config: { envConf: { tb633caller: { dev: {
                server: { resolvers: [], credentials: {}, protocol: 'http/1.1', scheme: 'http', port: 65531, webroot: '/' },
                host: '127.0.0.1', hostname: 'http://127.0.0.1:65531'
            } } } }
        });
    });
    after(function () {
        fs.readFileSync = _readFileSync;
        http2.connect = _connect;
        opened.forEach(function (s) { try { s.destroy(); } catch (e) {} });
        try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
    });

    function makeInst() {
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r633', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
            res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
            options: {
                conf: {
                    bundle: CALLER, encoding: 'utf-8',
                    server: { protocol: 'http/1.1', scheme: 'http',
                              coreConfiguration: { statusCodes: { '404': 'Not Found', '500': 'Internal Server Error', '503': 'Service Unavailable' }, mime: { json: 'application/json' } },
                              supportedRequestMethods: { get: 1, post: 1 } },
                    content: { routing: { r633: {} } }
                },
                rule: 'r633', control: 'act', bundle: CALLER, controller: '/controllers/t633.js'
            }
        });
        inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t633'), _cacheIsEnabled: 'false', _http2Sessions: [] };
        inst.throwError = function () {};
        return inst;
    }
    function teardown(inst) {
        var agents = inst.serverInstance._h1Agents;
        if (agents && typeof agents.forEach === 'function') { agents.forEach(function (a) { try { a.destroy(); } catch (e) {} }); }
        inst.serverInstance._cached.forEach(function (entry) { var s = entry && entry.value ? entry.value : entry; if (s && typeof s.destroy === 'function') { try { s.destroy(); } catch (e) {} } });
    }
    function selfSigned(tag) {
        var dir = fs.mkdtempSync(path.join(TMP, tag + '-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        return { key: _readFileSync(path.join(dir, 'k.pem')), cert: _readFileSync(path.join(dir, 'c.pem')) };
    }
    function h1Upstream(name, tls) {
        return new Promise(function (resolve) {
            var srv = https.createServer({ key: tls.key, cert: tls.cert }, function (req, res) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ name: name }));
            });
            srv.listen(0, '127.0.0.1', function () {
                resolve({ port: srv.address().port, close: function () { try { srv.closeAllConnections(); } catch (e) {} try { srv.close(); } catch (e) {} } });
            });
        });
    }
    function h2Upstream(name, tls) {
        return new Promise(function (resolve) {
            var srv = http2.createSecureServer({ key: tls.key, cert: tls.cert });
            var sessions = [];
            srv.on('session', function (s) { sessions.push(s); s.on('error', function () {}); });
            srv.on('stream', function (stream) {
                stream.on('error', function () {});
                stream.respond({ ':status': 200, 'content-type': 'application/json' });
                stream.end(JSON.stringify({ name: name }));
            });
            srv.listen(0, '127.0.0.1', function () {
                resolve({ port: srv.address().port, close: function () { sessions.forEach(function (s) { try { s.destroy(); } catch (e) {} }); try { srv.close(); } catch (e) {} } });
            });
        });
    }
    function call(inst, opts) {
        return new Promise(function (resolve) {
            inst.query(Object.assign({ path: '/up', method: 'GET', requestTimeout: '3s', maxRetry: 0 }, opts), {}, function (err, result) {
                resolve({ err: err, result: result });
            });
        });
    }
    function h1(port, ca) { return { protocol: 'http/1.1', scheme: 'https', host: '127.0.0.1', port: port, ca: ca }; }
    function h2(port, ca) { return { protocol: 'http/2.0', scheme: 'https', hostname: 'https://127.0.0.1:' + port, host: '127.0.0.1', port: port, ca: ca }; }
    function errText(e) { return JSON.stringify(e && (e.code || e.message || e)); }

    it('a) HTTP/1.1 + https: five calls read the CA file once', async function () {
        var t = selfSigned('a'); var up = await h1Upstream('A', t); var inst = makeInst();
        var ca = watch(path.join(TMP, 'a-ca.pem')); fs.writeFileSync(ca, t.cert);
        try {
            for (var i = 0; i < 5; i++) {
                var r = await call(inst, h1(up.port, ca));
                assert.strictEqual(r.err, false, 'call ' + i + ' failed: ' + errText(r.err));
                assert.strictEqual(r.result.name, 'A');
            }
            assert.strictEqual(reads[ca], 1, 'the CA was read ' + reads[ca] + ' times for 5 calls');
        } finally { teardown(inst); up.close(); }
    });

    it('b) HTTP/2 + https: five calls read the CA file once', async function () {
        var t = selfSigned('b'); var up = await h2Upstream('B', t); var inst = makeInst();
        var ca = watch(path.join(TMP, 'b-ca.pem')); fs.writeFileSync(ca, t.cert);
        try {
            for (var i = 0; i < 5; i++) {
                var r = await call(inst, h2(up.port, ca));
                assert.strictEqual(r.err, false, 'call ' + i + ' failed: ' + errText(r.err));
                assert.strictEqual(r.result.name, 'B');
            }
            assert.strictEqual(reads[ca], 1, 'the CA was read ' + reads[ca] + ' times for 5 calls');
        } finally { teardown(inst); up.close(); }
    });

    it('c) a CA replaced on disk is read again by the next call and used by it', async function () {
        var t1 = selfSigned('c1'), t2 = selfSigned('c2');
        var u1 = await h1Upstream('U1', t1), u2 = await h1Upstream('U2', t2); var inst = makeInst();
        var ca = watch(path.join(TMP, 'c-ca.pem')); fs.writeFileSync(ca, t1.cert);
        try {
            var r = await call(inst, h1(u1.port, ca));
            assert.strictEqual(r.err, false, 'before rotation, U1 (old CA) verifies: ' + errText(r.err));
            r = await call(inst, h1(u1.port, ca));
            assert.strictEqual(r.err, false);
            assert.strictEqual(reads[ca], 1, 'unchanged file: one read');
            // rotate: a new file renamed over the old path (a new inode, as a K8s Secret update makes)
            var tmp = path.join(TMP, '.c-ca.pem.new'); fs.writeFileSync(tmp, t2.cert); fs.renameSync(tmp, ca);
            r = await call(inst, h1(u2.port, ca));
            assert.strictEqual(r.err, false, 'after rotation, U2 (new CA) verifies: ' + errText(r.err));
            assert.strictEqual(r.result.name, 'U2');
            assert.strictEqual(reads[ca], 2, 'the replaced file was read again');
            r = await call(inst, h1(u1.port, ca));
            assert.ok(r.err, 'after rotation, U1 (old CA only) is refused — the old CA is no longer used');
        } finally { teardown(inst); u1.close(); u2.close(); }
    });

    it('d) a missing CA file fails the call with the same `open` error, and nothing is cached for it', async function () {
        var inst = makeInst();
        var missing = path.join(TMP, 'no-such-dir', 'ca.pem');
        try {
            var r = await call(inst, h1(9, missing));
            assert.ok(r.err, 'the call fails');
            assert.strictEqual(r.err.code, 'ENOENT', errText(r.err));
            assert.ok(/open/.test(r.err.message), 'the read error, as before: ' + r.err.message);
            var cache = inst.serverInstance._caCache;
            assert.ok(!cache || !cache.has(missing), 'no cache entry for a file that could not be read');
        } finally { teardown(inst); }
    });
});
