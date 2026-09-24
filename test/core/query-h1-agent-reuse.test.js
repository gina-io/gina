/**
 * #P44 / S4 — HTTP/1.1 hop connection reuse. `self.query()` over HTTP/1.x used to
 * build `new browser.Agent(options)` on EVERY call (the comment read "Shared Agent"),
 * so every hop opened a fresh TCP connection, used it once, and left it in TIME_WAIT.
 * The fix caches one keep-alive Agent per (scheme + pool signature) on the engine
 * instance and reuses it; Node's own socket pool (getName) then segregates connections
 * by authority + TLS. TLS options are NOT baked into the shared agent (they ride the
 * per-request options), or a baked ca would override a different upstream's ca.
 * gina's `options.protocol` (its transport-version string, 'http/1.1') IS carried into the
 * agent: Node's request() requires `options.protocol === agent.protocol`, so a pool-only
 * agent (Node's 'http:') throws ERR_INVALID_PROTOCOL on every gina h1 call. The per-call
 * agent this replaces inherited the protocol from options; the first shared-agent draft
 * dropped it and broke every HTTP/1 query — §02/§03 run gina's real protocol shape to
 * guard that regression.
 *
 * Sections:
 *   01 — source pins: the per-call `new browser.Agent(options)` is gone from the HTTP/1
 *        handler; the handler calls the shared-agent helper; the helper is defined and
 *        builds pool-only from `poolOpts`; the cache lives on self.serverInstance;
 *        the isRetryableMethod call-site count is unchanged (CONTROL).
 *   02 — behavioural on the REAL extracted helper bytes (injected fake self): same
 *        scheme reuses one agent; a different scheme -> a different agent; no TLS is
 *        baked into the agent; a caller-supplied real Agent wins (escape hatch); a
 *        per-call pool override gets its own agent (the signature key); the cache
 *        persists on serverInstance.
 *
 * Red-first: every 01 pin and every 02 arm goes red on the pre-change bytes — the
 * helper does not exist, so the extraction returns null (02 fails) and the source
 * pins fail (the per-call `new browser.Agent(options)` is still present).
 */
'use strict';

var assert = require('node:assert');
var { describe, it } = require('node:test');
var fs   = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');

var FW     = require('../fw');
var SOURCE = path.join(FW, 'core', 'controller', 'controller.js');
var SRC    = fs.readFileSync(SOURCE, 'utf8');

function region(startNeedle, endNeedle) {
    var a = SRC.indexOf(startNeedle); assert.ok(a > -1, 'anchor missing: ' + startNeedle);
    var b = SRC.indexOf(endNeedle, a); assert.ok(b > a, 'end anchor missing: ' + endNeedle);
    return SRC.slice(a, b);
}

// Extract a `var NAME = function(...) { ... }` block by brace-matching from the source.
function extractFn(src, decl) {
    var start = src.indexOf(decl);
    if (start < 0) return null;
    var i = src.indexOf('{', start), depth = 0;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; }
        else if (src[i] === '}') { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
    }
    return null;
}

// Load the REAL helper bytes with an injected `self` (the only identifier it closes over).
// Eval a function EXPRESSION (not a `var` declaration): in strict mode a var declared inside
// eval does not leak to the caller, but an eval'd expression still resolves `self` from the
// enclosing scope, so the returned function closes over the injected fake self.
function loadHelper(fakeSelf) {
    var text = extractFn(SRC, 'var _getSharedHttp1Agent = function');
    assert.ok(text, '_getSharedHttp1Agent must be defined in controller.js');
    var funcExpr = text.slice(text.indexOf('function'));   // strip "var _getSharedHttp1Agent = "
    var self = fakeSelf;                                    // eslint-disable-line no-unused-vars — closed over below
    return eval('(' + funcExpr + ')');                     // eslint-disable-line no-eval
}

describe('01 - #P44 source pins', function () {
    var h1 = region('var handleHTTP1ClientRequest = function', 'var handleHTTP2ClientRequest = function');

    it('the per-call `new browser.Agent(options)` is gone from the HTTP/1 handler', function () {
        assert.strictEqual(h1.indexOf('new browser.Agent(options)'), -1,
            'the HTTP/1 handler must not build a fresh Agent per call');
    });

    it('the HTTP/1 handler assigns the shared cached agent', function () {
        assert.ok(h1.indexOf('options.agent = _getSharedHttp1Agent(browser, options)') > -1,
            'the handler must use the shared-agent helper');
    });

    it('the helper is defined and constructs the agent from pool-only opts', function () {
        var fn = extractFn(SRC, 'var _getSharedHttp1Agent = function');
        assert.ok(fn, 'helper defined');
        assert.ok(fn.indexOf('new browser.Agent(poolOpts)') > -1, 'constructs from a pool-only object, not the full options');
        assert.ok(/keepAlive\s*:\s*true/.test(fn), 'keepAlive is forced true');
    });

    it('the helper carries gina\'s transport protocol into the agent (Node\'s protocol check)', function () {
        var fn = extractFn(SRC, 'var _getSharedHttp1Agent = function');
        assert.ok(fn.indexOf('poolOpts.protocol = options.protocol') > -1,
            'the shared agent must carry options.protocol, or request() throws ERR_INVALID_PROTOCOL');
    });

    it('the cache lives on self.serverInstance._h1Agents (survives dev hot-reload)', function () {
        var fn = extractFn(SRC, 'var _getSharedHttp1Agent = function');
        assert.ok(fn.indexOf('self.serverInstance') > -1 && fn.indexOf('_h1Agents') > -1,
            'the agent cache must live on the engine instance, not a module variable');
    });

    it('CONTROL: isRetryableMethod is still invoked at exactly 5 sites (S4 changes none)', function () {
        var n = (SRC.match(/isRetryableMethod\(options/g) || []).length;
        assert.strictEqual(n, 5, 'S4 must not change the retry-guard call sites');
    });
});

describe('02 - #P44 behavioural: the real helper caches, reuses, and bakes no TLS', function () {
    function freshSelf() { return { serverInstance: {} }; }

    it('same scheme returns the SAME agent (reuse)', function () {
        var h = loadHelper(freshSelf());
        var a1 = h(http, { scheme: 'http' });
        var a2 = h(http, { scheme: 'http' });
        assert.strictEqual(a1, a2, 'repeated calls reuse one agent');
        assert.ok(a1 instanceof http.Agent, 'an http.Agent');
        assert.strictEqual(a1.keepAlive, true, 'keep-alive is on');
    });

    it('a different scheme returns a DIFFERENT agent (https.Agent)', function () {
        var h = loadHelper(freshSelf());
        var a1 = h(http,  { scheme: 'http' });
        var a2 = h(https, { scheme: 'https' });
        assert.notStrictEqual(a1, a2);
        assert.ok(a2 instanceof https.Agent, 'an https.Agent for https');
    });

    it('no TLS is baked into the shared agent (per-request ca is Node\'s to honour)', function () {
        var h = loadHelper(freshSelf());
        var a = h(https, { scheme: 'https', ca: 'PEMDATA', rejectUnauthorized: false });
        assert.strictEqual(a.options.ca, undefined, 'the agent must not carry a baked ca');
        assert.strictEqual(a.options.rejectUnauthorized, undefined, 'the agent must not carry a baked rejectUnauthorized');
    });

    it('the agent carries gina\'s transport protocol (\'http/1.1\'), so Node\'s request() check matches', function () {
        var h = loadHelper(freshSelf());
        var a = h(http, { scheme: 'http', protocol: 'http/1.1' });
        assert.strictEqual(a.protocol, 'http/1.1', 'agent.protocol must equal gina\'s options.protocol');
        // and it is still the one cached agent for that shape
        assert.strictEqual(h(http, { scheme: 'http', protocol: 'http/1.1' }), a, 'reused for the same protocol');
    });

    it('a caller-supplied real Agent wins (escape hatch)', function () {
        var h = loadHelper(freshSelf());
        var custom = new http.Agent({ keepAlive: true });
        assert.strictEqual(h(http, { scheme: 'http', agent: custom }), custom);
    });

    it('a per-call pool override gets its own agent (the signature key)', function () {
        var h = loadHelper(freshSelf());
        var a1 = h(http, { scheme: 'http' });
        var a2 = h(http, { scheme: 'http', maxSockets: 5 });
        assert.notStrictEqual(a1, a2, 'a different pool signature -> a different agent');
        assert.strictEqual(a2.maxSockets, 5, 'the override is honoured, not silently ignored');
    });

    it('the cache persists on self.serverInstance across calls', function () {
        var self = freshSelf();
        var h = loadHelper(self);
        h(http, { scheme: 'http' });
        h(http, { scheme: 'http' });
        assert.ok(self.serverInstance._h1Agents && Object.keys(self.serverInstance._h1Agents).length === 1,
            'exactly one agent cached for one scheme + default pool');
    });
});

describe('03 - #P44 real socket reuse through the shared agent (end-to-end round-trips)', function () {
    function freshSelf() { return { serverInstance: {} }; }

    it('5 sequential requests via the shared agent reuse ONE connection; per-call agents do not', async function () {
        var helper = loadHelper(freshSelf());
        var server = http.createServer(function (q, p) { p.setHeader('x-rport', String(q.socket.remotePort)); p.end('ok'); });
        await new Promise(function (r) { server.listen(0, '127.0.0.1', r); });
        var port = server.address().port;
        // gina's REAL request shape: options.protocol is its transport-version string
        // ('http/1.1'). A shared agent that does not carry it makes request() throw
        // ERR_INVALID_PROTOCOL here — the regression the first draft shipped.
        function get(agent) {
            return new Promise(function (resolve, reject) {
                var q = http.request({ host: '127.0.0.1', port: port, path: '/', agent: agent, protocol: 'http/1.1' }, function (res) {
                    res.on('data', function () {});
                    res.on('end', function () { resolve(res.headers['x-rport']); });
                });
                q.on('error', reject);
                q.end();
            });
        }
        try {
            // shared agent (what the fix hands the handler), built from gina's options shape
            var shared = helper(http, { scheme: 'http', protocol: 'http/1.1' });
            var reused = [];
            for (var i = 0; i < 5; i++) { reused.push(await get(shared)); }
            var distinctReused = new Set(reused).size;
            // control: a fresh Agent per call (the pre-fix shape, protocol inherited) opens a new connection each time
            var perCall = [];
            for (var j = 0; j < 5; j++) { perCall.push(await get(new http.Agent({ keepAlive: true, protocol: 'http/1.1' }))); }
            var distinctPerCall = new Set(perCall).size;
            assert.strictEqual(distinctReused, 1, 'the shared agent reuses ONE connection for 5 sequential calls (got ports: ' + reused.join(',') + ')');
            assert.ok(distinctPerCall >= 4, 'a fresh agent per call opens a new connection each time (control distinct=' + distinctPerCall + ')');
        } finally {
            server.close();
        }
    });
});
