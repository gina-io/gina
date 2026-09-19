'use strict';
/**
 * #B562 — on HTTP/2, middleware that installs itself by wrapping `res.writeHead` /
 * `res.end` is inert on a rendered response, because the render delegates terminate
 * on the raw HTTP/2 stream and call neither. #B550 fixed the `redirect()` exits; this
 * closes the ordinary render path.
 *
 * THE FIX: `installH2SendShim(res)` puts a base `writeHead`/`write`/`end` on the
 * response BEFORE the bundle middleware chain runs, so such middleware wraps OURS.
 * The shim is TRANSPARENT — unless a delegate registers `res._ginaRawSend`, every call
 * forwards to the original, leaving redirects, statics, error pages and `/_gina/*`
 * byte-identical. When a delegate registers one, the body is buffered and the raw send
 * runs INSIDE the base `end()`, which a session middleware invokes only after its store
 * write completes — so the response cannot outrun the record it depends on.
 *
 * WHICH PINS CAN GO RED — read this before trusting a green run:
 *   §01 §03 pin THE FIX in source. Red on pre-change source (validated red-first).
 *   §02     pins the shim's BEHAVIOUR by executing the extracted helper. Red pre-change
 *           (the helper does not exist), so extraction itself is the discriminator.
 *   §04     pins the MECHANISM on real Node HTTP/2 objects. It is the positive
 *           counterpart to #B550 §04, which pins that an UNSHIMMED raw-stream send fires
 *           neither hook. §04 here needs the shim, so it IS fix-sensitive.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http2  = require('http2');

var FW          = require('../fw');
var SERVER      = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var RENDER_JSON = fs.readFileSync(path.join(FW, 'core/controller/controller.render-json.js'), 'utf8');

/** Strip line comments so a pin cannot be satisfied by the prose that documents it. */
function activeLines(src) {
    return src.split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
}
var SERVER_CODE      = activeLines(SERVER);
var RENDER_JSON_CODE = activeLines(RENDER_JSON);
function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}

/**
 * Extract `installH2SendShim` from server.js source and compile it in an isolated
 * scope. The helper is closure-free by construction — it reads only its `res`
 * parameter and the `Buffer` global — so a `new Function` harness models it faithfully.
 */
function extractShim() {
    var decl = 'var installH2SendShim = function(res) {';
    var i = SERVER.indexOf(decl);
    assert.ok(i > -1, 'installH2SendShim must be declared at module scope in core/server.js');
    var j = i + decl.length - 1, depth = 0;
    do {
        if (SERVER[j] === '{') depth++;
        else if (SERVER[j] === '}') depth--;
        j++;
    } while (depth > 0 && j < SERVER.length);
    assert.ok(depth === 0, 'the helper must brace-balance');
    var src = SERVER.slice(i, j) + ';';
    return new Function('Buffer', src + ' return installH2SendShim;')(Buffer);
}

/** A stand-in response carrying the three methods plus a stream, recording originals. */
function fakeRes(withStream) {
    var seen = { writeHead: 0, write: 0, end: 0, endArgs: [] };
    var res = {
        statusCode: 200,
        writeHead: function() { seen.writeHead++; return res; },
        write:     function(c) { seen.write++; return true; },
        end:       function(c) { seen.end++; seen.endArgs.push(c); return res; }
    };
    if (withStream) res.stream = { respond: function() {}, end: function() {} };
    res._seen = seen;
    return res;
}

describe('01 - core/server.js: the shim exists and runs before the middleware chain', function() {
    it('declares the helper at module scope', function() {
        assert.ok(SERVER_CODE.indexOf('var installH2SendShim = function(res) {') > -1,
            'expected a module-scope installH2SendShim declaration');
    });
    it('is invoked at BOTH isaac middleware-chain entries', function() {
        assert.equal(count(SERVER_CODE, 'installH2SendShim('), 3,
            'expected 1 declaration + exactly 2 call sites (statics entry and routed entry)');
    });
    it('each call precedes its dispatcher construction', function() {
        var parts = SERVER_CODE.split('installH2SendShim(');
        assert.equal(parts.length, 4, 'instrument check: 3 occurrences split into 4 parts');
        // for both call sites, the dispatcher is constructed after the shim call
        [2, 3].forEach(function(n) {
            var after = parts[n];
            var disp  = after.indexOf('createNextMiddleware()');
            assert.ok(disp > -1 && disp < 400,
                'call site ' + (n - 1) + ' must be immediately above createNextMiddleware()');
        });
    });
    it('the transparency guard is present on all three methods', function() {
        assert.equal(count(SERVER_CODE, 'if (res._ginaRawSend) return res;'), 1, 'writeHead guard');
        assert.equal(count(SERVER_CODE, 'if (!res._ginaRawSend) return _oWrite.apply(res, arguments);'), 1, 'write guard');
        assert.equal(count(SERVER_CODE, 'if (!res._ginaRawSend) return _oEnd.apply(res, arguments);'), 1, 'end guard');
    });
});

describe('02 - BEHAVIOUR: the extracted shim', function() {
    it('does nothing on a response with no HTTP/2 stream', function() {
        var shim = extractShim(), res = fakeRes(false);
        shim(res);
        assert.equal(res._ginaSendShim, undefined, 'no shim on an HTTP/1.1 response');
    });
    it('installs once — a second call is a no-op', function() {
        var shim = extractShim(), res = fakeRes(true);
        shim(res);
        var first = res.end;
        shim(res);
        assert.equal(res.end, first, 'the second install must not re-wrap');
    });
    it('is TRANSPARENT when no deferred send is registered', function() {
        var shim = extractShim(), res = fakeRes(true);
        shim(res);
        res.writeHead(200); res.write('a'); res.end('b');
        assert.deepEqual(
            { writeHead: res._seen.writeHead, write: res._seen.write, end: res._seen.end },
            { writeHead: 1, write: 1, end: 1 },
            'every call must reach the original method');
    });
    it('suppresses writeHead once a deferred send is registered', function() {
        var shim = extractShim(), res = fakeRes(true);
        shim(res);
        res._ginaRawSend = function() {};
        res.writeHead(200);
        assert.equal(res._seen.writeHead, 0, 'the original writeHead must not fire — the raw send writes the frame');
    });
    it('runs the deferred send from end(), with the buffered body', function() {
        var shim = extractShim(), res = fakeRes(true);
        shim(res);
        var got = [];
        res._ginaRawSend = function(body) { got.push(body); };
        res.writeHead(200);
        res.write('hello ');
        res.end('world');
        assert.equal(got.length, 1, 'the deferred send must run exactly once');
        assert.equal(got[0].toString(), 'hello world', 'write() and end() chunks must both reach it, in order');
        assert.equal(res._seen.end, 0, 'the original end must not fire on the deferred path');
    });
    it('does not re-send when end() is called twice', function() {
        var shim = extractShim(), res = fakeRes(true);
        shim(res);
        var n = 0;
        res._ginaRawSend = function() { n++; };
        res.end('x');
        res.end('x');
        assert.equal(n, 1, 'the deferred send is one-shot');
    });
});

describe('03 - render-json.js: both raw-stream sites defer through the shim', function() {
    it('each site registers a deferred send', function() {
        assert.equal(count(RENDER_JSON_CODE, 'response._ginaRawSend = __ginaSendHead;'), 1, 'HEAD site');
        assert.equal(count(RENDER_JSON_CODE, 'response._ginaRawSend = __ginaSendBody;'), 1, 'body site');
    });
    it('each site drives writeHead then end, and keeps a direct fallback', function() {
        assert.equal(count(RENDER_JSON_CODE, 'if (response._ginaSendShim) {'), 2, 'one branch per site');
        assert.equal(count(RENDER_JSON_CODE, '__ginaSendHead();'), 1, 'HEAD fallback when no shim');
        assert.equal(count(RENDER_JSON_CODE, '__ginaSendBody(data);'), 1, 'body fallback when no shim');
    });
    it('the registration precedes the writeHead that fires the header hook', function() {
        var reg = RENDER_JSON_CODE.indexOf('response._ginaRawSend = __ginaSendBody;');
        var wh  = RENDER_JSON_CODE.indexOf('response.writeHead(response.statusCode || 200);', reg);
        assert.ok(reg > -1 && wh > reg, 'the deferred send must be registered before writeHead suppresses it');
    });
});

var servers = [];
after(function() { servers.forEach(function(s) { try { s.close(); } catch (e) {} }); });

/** Same wrap contract #B550 §04/§05 models: on-headers wraps writeHead, a session wraps end. */
function installHooks(res, seen) {
    var prevWriteHead = res.writeHead, fired = false;
    res.writeHead = function() {
        if (!fired) { fired = true; seen.writeHead = true; res.setHeader('set-cookie', 'probe.sid=1; Path=/'); }
        return prevWriteHead.apply(res, arguments);
    };
    var prevEnd = res.end;
    res.end = function() { seen.end = true; return prevEnd.apply(res, arguments); };
}
function drive(handler, cb) {
    var server = http2.createServer();
    servers.push(server);
    server.listen(0, '127.0.0.1', function() {
        var client = http2.connect('http://127.0.0.1:' + server.address().port);
        var req = client.request({ ':path': '/' });
        var headers = null, chunks = [];
        req.on('response', function(h) { headers = h; });
        req.on('data', function(d) { chunks.push(d); });
        req.on('end', function() { client.close(); server.close(); cb(headers, Buffer.concat(chunks).toString()); });
    });
    server.on('request', handler);
}

describe('04 - MECHANISM: with the shim, a delegate-shaped raw send fires both hooks', function() {
    it('the cookie reaches the wire and the body is intact', function(t, done) {
        var shim = extractShim();
        var seen = {};
        drive(function(req, res) {
            shim(res);                       // installed BEFORE the hooks, as at the chain entry
            installHooks(res, seen);         // the middleware wraps OUR base
            res.setHeader('content-type', 'application/json');
            // what a converted delegate does at its send site:
            res._ginaRawSend = function(body) {
                var h = Object.assign({ ':status': 200 }, res.getHeaders());
                res.stream.respond(h);
                res.stream.end(body);
            };
            res.writeHead(res.statusCode || 200);
            res.end('{"ok":true}');
        }, function(headers, body) {
            assert.equal(seen.writeHead, true, 'the header hook must fire — this is what sets the cookie');
            assert.equal(seen.end, true, 'the end proxy must fire — this is what persists a session');
            assert.deepEqual(headers['set-cookie'], ['probe.sid=1; Path=/'],
                'the cookie set from the header hook must reach the raw HTTP/2 frame via the existing fold');
            assert.equal(body, '{"ok":true}', 'the body must survive buffering byte-for-byte');
            done();
        });
    });
});

describe('05 - every buffering delegate defers; render-stream deliberately does not', function() {
    // site counts are the anchored `.respond(` census: swig 5 (4 converted + the error
    // fallthrough, left on the raw path — see the note below), json/xml/nunjucks/
    // nunjucks-async/swig-async 2 each.
    var DELEGATES = {
        'controller.render-json.js':           { sites: 2, bodyParam: 'data' },
        'controller.render-xml.js':            { sites: 2, bodyParam: 'data' },
        'controller.render-swig.js':           { sites: 4, bodyParam: 'htmlContent' },
        'controller.render-nunjucks.js':       { sites: 2, bodyParam: 'html' },
        'controller.render-nunjucks-async.js': { sites: 2, bodyParam: 'html' },
        'controller.render-swig-async.js':     { sites: 2, bodyParam: 'html' }
    };
    Object.keys(DELEGATES).forEach(function(file) {
        var spec = DELEGATES[file];
        var code = activeLines(fs.readFileSync(path.join(FW, 'core/controller/', file), 'utf8'));
        it(file + ': every raw-stream site registers a deferred send', function() {
            assert.equal(count(code, '._ginaRawSend = __ginaSend'), spec.sites,
                'expected one registration per converted raw-stream send site');
        });
        it(file + ': the body closure takes the body as a PARAMETER, not the captured variable', function() {
            // If the closure read the captured variable instead, bytes a middleware had
            // transformed (compression) would be discarded while its headers still shipped.
            assert.ok(count(code, 'function(' + spec.bodyParam + ') {') >= 1,
                'expected a deferred-send closure parameterised on ' + spec.bodyParam);
        });
    });
    it('render-stream.js is deliberately NOT converted — it streams incrementally', function() {
        var code = fs.readFileSync(path.join(FW, 'core/controller/controller.render-stream.js'), 'utf8');
        assert.equal(count(code, '_ginaRawSend'), 0,
            'render-stream writes chunk-by-chunk from an async iterable; buffering it would ' +
            'change observable behaviour for SSE and Range responses. Tracked separately.');
        assert.ok(code.indexOf('for await (chunk of asyncIterable)') > -1,
            'instrument check: the incremental loop this deferral protects must still be here');
    });
});
