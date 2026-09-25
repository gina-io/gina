/**
 * #P44 — `self.query()` over HTTP/1.x reuses connections through one keep-alive Agent per
 * upstream, cached on the engine instance.
 *
 * Before: `controller.js` built `new browser.Agent(options)` on EVERY call and discarded it,
 * so every call opened a new TCP connection and left it in TIME_WAIT (500 calls measured 500
 * connections). Now one agent per upstream is cached in `serverInstance._h1Agents` (a Map,
 * LRU, capped at 50) and reused.
 *
 * Why per UPSTREAM, never one agent shared across upstreams: for a `bundle@project` target,
 * `query()` sets `options.host` to the bare host and `options.hostname` to the FULL
 * configured URL (`scheme://host:port`, config.js). Node's request lets `hostname` win and
 * hands that URL to the agent; in `createSocket` the agent's own options win, so the socket
 * reaches the right upstream only because the agent carries the bare `host`. A single agent
 * shared across upstreams carries no host and every `bundle@project` call failed with
 * `getaddrinfo ENOTFOUND http://…` — a first draft of this fix shipped exactly that, and no
 * existing test caught it, because none drove a `bundle@project` target through a live
 * socket. §02 does.
 *
 * Sections:
 *   01 — source pins: the per-call agent is gone from live code; the handler uses the
 *        helper; the helper bakes the socket keys (host, protocol, TLS) and caps the cache;
 *        the isRetryableMethod count is unchanged (CONTROL).
 *   02 — behavioural through the REAL controller (`createTestInstance` + live servers):
 *        a) `bundle@project`, 5 sequential calls: no ENOTFOUND, ONE connection (the gap);
 *        b) two `bundle@project` upstreams: each reaches ITS server, one agent each;
 *        c) a direct host (no `@`) still works and reuses — the branch the old tests covered,
 *           green even on the shared-agent draft, which isolates the bundle@project defect;
 *        d) direct https upstreams with DIFFERENT CAs: both verify, one agent each (the
 *           baked-CA cross-over trap; not bundle@project, which fails TLS on every revision —
 *           #B636, pre-existing);
 *        e) the cache is capped at 50 and LRU; an agent evicted mid-request lets its
 *           in-flight request complete;
 *        f) a caller-supplied `options.agent` is ignored, as the per-call code ignored it:
 *           honouring it failed every call with ERR_INVALID_PROTOCOL (gina's transport-version
 *           `protocol` only matches an agent built from the request's own options).
 *
 * Red-first: 02a fails on the pre-change bytes (5 connections for 5 calls) AND on the
 * shared-agent draft (ENOTFOUND); the 01 pins fail on the pre-change bytes; 02f fails on
 * a draft that returned the caller's agent (ERR_INVALID_PROTOCOL).
 */
'use strict';

var assert = require('node:assert');
var { describe, it, before } = require('node:test');
var fs    = require('fs');
var path  = require('path');
var http  = require('http');
var https = require('https');
var os    = require('os');
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

describe('01 - #P44 source pins', function () {
    var LIVE = stripComments(SRC);

    it('the per-call `new browser.Agent(options)` is gone from LIVE code (comments may still name it)', function () {
        assert.ok(SRC.indexOf('new browser.Agent(options)') > -1, 'instrument check: the raw source still names the old shape in a comment');
        assert.strictEqual((LIVE.match(/new browser\.Agent\(options\)/g) || []).length, 0,
            'no live per-call Agent construction');
    });

    it('the HTTP/1 handler takes its agent from the per-upstream helper', function () {
        var h1 = region(LIVE, 'var handleHTTP1ClientRequest = function', 'var handleHTTP2ClientRequest = function');
        assert.ok(h1.indexOf('options.agent = _getSharedHttp1Agent(browser, options)') > -1);
    });

    it('the helper bakes the socket keys — bare host, transport protocol, TLS — and never path/method/headers', function () {
        var keys = region(LIVE, 'var H1_AGENT_SOCKET_KEYS = [', '];');
        ['\'protocol\'', '\'host\'', '\'port\'', '\'ca\'', '\'rejectUnauthorized\'', '\'servername\''].forEach(function (k) {
            assert.ok(keys.indexOf(k) > -1, 'socket key baked: ' + k);
        });
        ['\'path\'', '\'method\'', '\'headers\'', '\'_body\''].forEach(function (k) {
            assert.strictEqual(keys.indexOf(k), -1, 'per-request key never baked: ' + k);
        });
    });

    it('the cache is keyed by Node\'s own pool key and capped', function () {
        var fn = region(LIVE, 'var _getSharedHttp1Agent = function', 'var handleHTTP1ClientRequest = function');
        assert.ok(fn.indexOf('browser.Agent.prototype.getName.call(') > -1, 'keyed by getName');
        assert.ok(/H1_AGENT_MAX\s*=\s*50/.test(LIVE), 'cap constant');
        assert.ok(fn.indexOf('inst._h1Agents.size >= H1_AGENT_MAX') > -1, 'cap enforced');
        assert.ok(fn.indexOf('keepSocketAlive = function() { return false; }') > -1, 'eviction is graceful');
    });

    it('CONTROL: isRetryableMethod is still invoked at exactly 5 sites', function () {
        assert.strictEqual((SRC.match(/isRetryableMethod\(options/g) || []).length, 5);
    });
});

// ── 02 — behavioural, through the real controller ───────────────────────────

describe('02 - #P44 behavioural: bundle@project calls reach their upstream and reuse one connection', function () {

    var CALLER = 'tp44caller';

    // envConf entry exactly as config.js builds one: `hostname` is the FULL URL.
    function envEntry(port, scheme, ca) {
        return {
            server: { resolvers: [], credentials: ca ? { ca: ca } : {}, protocol: 'http/1.1', scheme: scheme || 'http', port: port, webroot: '/' },
            host: '127.0.0.1',
            hostname: (scheme || 'http') + '://127.0.0.1:' + port
        };
    }
    function setEnv(targets) { // targets: { bundle: envEntry }
        var envConf = {}; envConf[CALLER] = { dev: envEntry(1, 'http') };
        Object.keys(targets).forEach(function (b) { envConf[b] = { dev: targets[b] }; });
        setContext('bundle', CALLER);
        setContext('env', 'dev');
        setContext('gina', { ports: { 'http/1.1': { http: {}, https: {} } }, config: { envConf: envConf } });
    }
    function makeInst() {
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', headers: {}, routing: { rule: 'r44', namespace: 'default', param: {} }, params: {}, get: {}, post: {} },
            res: { setHeader: function () {}, end: function () {}, writeHead: function () {}, getHeaders: function () { return {}; }, statusCode: 200 },
            options: {
                conf: {
                    bundle: CALLER, encoding: 'utf-8',
                    server: { protocol: 'http/1.1', scheme: 'http',
                              coreConfiguration: { statusCodes: { '404': 'Not Found', '500': 'Internal Server Error' }, mime: { json: 'application/json' } },
                              supportedRequestMethods: { get: 1, post: 1 } },
                    content: { routing: { r44: {} } }
                },
                rule: 'r44', control: 'act', bundle: CALLER, controller: '/controllers/t44.js'
            }
        });
        inst.serverInstance = { _cached: new Map(), _cachePath: path.join(os.tmpdir(), 'gina-t44'), _cacheIsEnabled: 'false', _http2Sessions: [] };
        inst.throwError = function () {};
        return inst;
    }
    function teardownAgents(inst) {
        var m = inst.serverInstance._h1Agents;
        if (m && typeof m.forEach === 'function') { m.forEach(function (a) { try { a.destroy(); } catch (e) {} }); }
    }
    // Each upstream answers JSON with the caller's source port, so reuse is observable.
    function upstream(name, tls) {
        return new Promise(function (resolve) {
            var handler = function (req, res) {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ name: name, rport: req.socket.remotePort }));
            };
            var srv = tls ? https.createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
            srv.listen(0, '127.0.0.1', function () {
                resolve({ port: srv.address().port, close: function () { try { srv.closeAllConnections(); } catch (e) {} try { srv.close(); } catch (e) {} } });
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
    function selfSigned() {
        var dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p44-tls-'));
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
        return { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
    }

    it('a) bundle@project: 5 sequential calls succeed (no ENOTFOUND) over ONE connection', async function () {
        var up = await upstream('A'); var inst = makeInst();
        try {
            setEnv({ tp44a: envEntry(up.port) });
            var ports = [];
            for (var i = 0; i < 5; i++) {
                var r = await call(inst, { hostname: 'tp44a@proj' });
                assert.strictEqual(r.err, false, 'call ' + i + ' failed: ' + JSON.stringify(r.err && (r.err.message || r.err.code || r.err)));
                assert.strictEqual(r.result.name, 'A');
                ports.push(r.result.rport);
            }
            assert.strictEqual(new Set(ports).size, 1, 'one reused connection, got source ports ' + ports.join(','));
        } finally { teardownAgents(inst); up.close(); }
    });

    it('b) two bundle@project upstreams: each call reaches ITS server, one agent each', async function () {
        var a = await upstream('A'); var b = await upstream('B'); var inst = makeInst();
        try {
            setEnv({ tp44a: envEntry(a.port), tp44b: envEntry(b.port) });
            var seq = ['tp44a', 'tp44b', 'tp44a', 'tp44b', 'tp44a'];
            for (var i = 0; i < seq.length; i++) {
                var r = await call(inst, { hostname: seq[i] + '@proj' });
                assert.strictEqual(r.err, false, JSON.stringify(r.err && (r.err.message || r.err)));
                assert.strictEqual(r.result.name, seq[i] === 'tp44a' ? 'A' : 'B', 'no cross-talk');
            }
            assert.strictEqual(inst.serverInstance._h1Agents.size, 2, 'one agent per upstream');
        } finally { teardownAgents(inst); a.close(); b.close(); }
    });

    it('c) CONTROL: a direct host (no @) still works and reuses one connection', async function () {
        var up = await upstream('D'); var inst = makeInst();
        try {
            setEnv({});
            var ports = [];
            for (var i = 0; i < 3; i++) {
                var r = await call(inst, { protocol: 'http/1.1', scheme: 'http', host: '127.0.0.1', port: up.port });
                assert.strictEqual(r.err, false, JSON.stringify(r.err && (r.err.message || r.err)));
                ports.push(r.result.rport);
            }
            assert.strictEqual(new Set(ports).size, 1, 'reused, got ' + ports.join(','));
        } finally { teardownAgents(inst); up.close(); }
    });

    // Direct https hosts, NOT bundle@project: an h1+https bundle@project call fails TLS
    // verification on every revision (the server name comes from the full-URL hostname — #B636,
    // pre-existing, measured identical on the pre-change bytes), so it cannot test S4. This arm
    // tests what S4 owns: each upstream's agent bakes ITS CA, so the agents must never be shared
    // across CAs, or one upstream's baked CA would be used to verify the other and fail.
    it('d) https upstreams with DIFFERENT CAs: both verify, one agent each (no CA cross-over)', async function () {
        var t1 = selfSigned(), t2 = selfSigned();
        var a = await upstream('SA', t1); var b = await upstream('SB', t2); var inst = makeInst();
        try {
            setEnv({});
            var target = { SA: { port: a.port, ca: t1.cert }, SB: { port: b.port, ca: t2.cert } };
            var seq = ['SA', 'SB', 'SA', 'SB'];
            for (var i = 0; i < seq.length; i++) {
                var t = target[seq[i]];
                var r = await call(inst, { protocol: 'http/1.1', scheme: 'https', host: '127.0.0.1', port: t.port, ca: t.ca });
                assert.strictEqual(r.err, false, seq[i] + ': ' + JSON.stringify(r.err && (r.err.message || r.err.code || r.err)));
                assert.strictEqual(r.result.name, seq[i]);
            }
            assert.strictEqual(inst.serverInstance._h1Agents.size, 2, 'one agent per upstream + CA');
        } finally { teardownAgents(inst); a.close(); b.close(); }
    });

    it('e) the cache is capped at 50 (LRU), and an agent evicted mid-request lets that request complete', async function () {
        // A slow route so one request is in flight while the cache overflows.
        var srv = http.createServer(function (req, res) {
            var slow = req.url === '/slow';
            setTimeout(function () { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, slow: slow })); }, slow ? 400 : 0);
        });
        await new Promise(function (r) { srv.listen(0, '127.0.0.1', r); });
        var P = srv.address().port; var inst = makeInst();
        try {
            setEnv({});
            // distinct pool settings -> distinct keys on ONE upstream (the cap is key-agnostic)
            var direct = function (i, extra) { return Object.assign({ protocol: 'http/1.1', scheme: 'http', host: '127.0.0.1', port: P, maxSockets: 1000 + i }, extra || {}); };
            var inflight = call(inst, direct(0, { path: '/slow' }));         // agent #0, in flight, oldest
            await new Promise(function (r) { setTimeout(r, 50); });
            for (var i = 1; i <= 50; i++) { var r = await call(inst, direct(i)); assert.strictEqual(r.err, false); }
            assert.strictEqual(inst.serverInstance._h1Agents.size, 50, 'capped at 50 after 51 distinct keys');
            var slowRes = await inflight;
            assert.strictEqual(slowRes.err, false, 'the in-flight request on the evicted agent completed: ' + JSON.stringify(slowRes.err && (slowRes.err.message || slowRes.err)));
            assert.strictEqual(slowRes.result.slow, true);
        } finally { teardownAgents(inst); try { srv.closeAllConnections(); } catch (e) {} srv.close(); }
    });

    it('f) a caller-supplied `options.agent` is ignored, as before — the call still reaches its upstream', async function () {
        var up = await upstream('F'); var inst = makeInst();
        var foreign = new http.Agent({ keepAlive: true });
        var used = 0; var origAdd = foreign.addRequest;
        foreign.addRequest = function () { used++; return origAdd.apply(this, arguments); };
        try {
            setEnv({ tp44f: envEntry(up.port) });
            var r = await call(inst, { hostname: 'tp44f@proj', agent: foreign });
            assert.strictEqual(r.err, false, 'the call failed: ' + JSON.stringify(r.err && (r.err.code || r.err.message || r.err)));
            assert.strictEqual(r.result.name, 'F');
            assert.strictEqual(used, 0, 'the caller\'s agent was not used');
            assert.strictEqual(inst.serverInstance._h1Agents.size, 1, 'the per-upstream agent served the call');
        } finally { teardownAgents(inst); foreign.destroy(); up.close(); }
    });
});
