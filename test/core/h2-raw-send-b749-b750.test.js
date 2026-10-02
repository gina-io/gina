'use strict';
/**
 * #B750 + #B749 — two ways a send on the RAW HTTP/2 stream disagreed with the
 * compat response object in front of it.
 *
 * #B750 — five strict-mode sites assigned `headersSent = true` after a send:
 * `serveRenderCacheHit` in core/server.js (the redis L2 warm), both HTTP/2 branches
 * of render-nunjucks' `sendHtmlResponse`, and both send branches of render-xml.
 * `headersSent` is a getter-only accessor on BOTH Node response classes, so each
 * assignment threw a TypeError after the bytes had gone out: an unhandled rejection
 * per nunjucks render and per L2 warm (whose access-log line was skipped),
 * render-xml's cleanup skipped and, on HTTP/1.1, `next()` called on a response that
 * had already ended. THE FIX drops each assignment and keeps it as a `// was:` line;
 * the getter already reports the send.
 *
 * #B749 — the server-level `throwError` answers an HTTP/2 request with a raw
 * `stream.respond(header)`, so the compat response's `statusCode` kept its default
 * 200 and a 'finish' reader (the metrics hook) counted every such error as a
 * success. THE FIX sets `res.statusCode = code` in both raw send helpers, before the
 * respond, inside a try/catch: the setter throws on an invalid code, undefined
 * among them, which respond() still sends as 200.
 *
 * Why the older suites missed #B750: their fake responses carry a plain, writable
 * `headersSent`, on which a strict-mode assignment succeeds. Every behaviour arm
 * below runs on a REAL `Http2ServerResponse` or `ServerResponse`.
 *
 * WHICH PINS CAN GO RED — read this before trusting a green run:
 *   §00     instrument controls. They read no gina source and hold on any bytes:
 *           they prove the scene reproduces the strict-mode throw and the
 *           200-at-finish mechanism, so a green §02–§05 is not the harness failing
 *           to model the defect.
 *   §01     source pins on ACTIVE code (whole comment lines dropped — never the
 *           naive block-comment regex, #B754), each with its raw `// was:` line as
 *           the strip's control. Red on the pre-change bytes.
 *   §02–§05 behaviour, red on the pre-change bytes, except §03's undefined-code
 *           control, which guards the try/catch on both sides. A helper lifted out
 *           of server.js or render-nunjucks is compiled with 'use strict' restored:
 *           a `new Function` body is sloppy, and there the pre-change assignment
 *           could not throw (§00a).
 * Validated red-first against `git show HEAD:<file>` of the three sources.
 */
var { describe, it, after } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');

var FW           = require('../fw');
var SERVER_SRC   = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var NUNJUCKS_SRC = fs.readFileSync(path.join(FW, 'core/controller/controller.render-nunjucks.js'), 'utf8');
var XML_PATH     = path.join(FW, 'core/controller/controller.render-xml.js');
var XML_SRC      = fs.readFileSync(XML_PATH, 'utf8');
var lib          = require(path.join(FW, 'lib'));
var renderXML    = require(XML_PATH);

var DOC = '<?xml version="1.0" encoding="UTF-8"?><Document><Amt Ccy="EUR">1.00</Amt></Document>';


// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Drop every whole comment line — `//` lines and the lines of a JSDoc or block
 * comment (those starting with `*`, `/*` or `/**`) — the #B752 stripper. A pin on
 * the result cannot be satisfied by the prose that documents it.
 *
 * @param {string} src
 * @returns {string}
 */
function noCommentLines(src) {
    return src.split('\n').filter(function(l) {
        return !/^\s*\/\//.test(l) && !/^\s*\/?\*/.test(l);
    }).join('\n');
}

/**
 * Count the non-overlapping occurrences of a literal.
 *
 * @param {string} hay
 * @param {string} needle
 * @returns {number}
 */
function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}

/**
 * Return the text of the function whose declaration starts at `startNeedle`, up to
 * its matching closing brace. Quoted strings and comments are skipped while
 * counting braces.
 *
 * @param {string} src
 * @param {string} startNeedle - the declaration text, ending with its opening `{`
 * @returns {string}
 */
function extract(src, startNeedle) {
    var i = src.indexOf(startNeedle);
    assert.ok(i > -1, 'declaration not found: ' + startNeedle);
    var j = i + startNeedle.length - 1, depth = 0, quote = null;
    for (; j < src.length; j++) {
        var c = src[j], n = src[j + 1];
        if (quote) {
            if (c === '\\') { j++; continue; }
            if (c === quote) { quote = null; }
            continue;
        }
        if (c === '/' && n === '/') { j = src.indexOf('\n', j); if (j < 0) { break; } continue; }
        if (c === '/' && n === '*') { j = src.indexOf('*/', j + 2) + 1; continue; }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') { depth++; }
        else if (c === '}') { depth--; if (depth === 0) { break; } }
    }
    assert.equal(depth, 0, 'the declaration must brace-balance: ' + startNeedle);
    return src.slice(i, j + 1);
}

/**
 * Compile `body` as a STRICT function of `params`. A `new Function` body is sloppy
 * by default; without the directive a lifted pre-change `headersSent` assignment
 * could not throw, and the red-first run could not tell the bytes apart (§00a).
 *
 * @param {string[]} params
 * @param {string} body
 * @returns {Function}
 */
function compileStrict(params, body) {
    return Function.apply(null, params.concat(["'use strict';\n" + body]));
}

/**
 * Lift a function out of its source and return it, with the identifiers it closes
 * over passed in as `params` / `args`.
 *
 * @param {string} src
 * @param {string} startNeedle - the declaration text, ending with its opening `{`
 * @param {string} name        - the declared name
 * @param {string[]} params    - the closed-over identifiers
 * @param {Array} args         - their values
 * @returns {Function}
 */
function lift(src, startNeedle, name, params, args) {
    var text = extract(src, startNeedle);
    var body = text + (text.indexOf('var ') === 0 ? ';' : '') + '\nreturn ' + name + ';';
    return compileStrict(params, body).apply(null, args);
}

var servers = [];
after(function() { servers.forEach(function(s) { try { s.close(); } catch (e) {} }); });

/**
 * Resolve after `ms`, so a scene waiting on a server-side event cannot hang the file.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
    return new Promise(function(r) { var t = setTimeout(r, ms); if (t.unref) { t.unref(); } });
}

/**
 * One request over a real HTTP/2 connection. `handler(req, res)` answers it on the
 * server. Resolves once the client holds the whole response AND the server response
 * has closed (so any 'finish' listener has run), or 2 s after the client's end.
 *
 * @param {function(object, object): void} handler
 * @param {object} [reqHeaders] - extra request headers, e.g. `{ ':method': 'HEAD' }`
 * @returns {Promise<{headers: object, body: string}>}
 */
async function h2(handler, reqHeaders) {
    var server = http2.createServer();
    servers.push(server);
    var closed, serverSide = new Promise(function(r) { closed = r; });
    server.on('request', function(req, res) {
        res.on('close', function() { closed(); });
        handler(req, res);
    });
    await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
    var client = http2.connect('http://127.0.0.1:' + server.address().port);
    try {
        var out = await new Promise(function(resolve, reject) {
            var req = client.request(Object.assign({ ':path': '/' }, reqHeaders || {}));
            var headers = null, chunks = [];
            req.on('response', function(h) { headers = h; });
            req.on('data', function(d) { chunks.push(d); });
            req.on('end', function() { resolve({ headers: headers, body: Buffer.concat(chunks).toString() }); });
            req.on('error', reject);
            req.end();
        });
        await Promise.race([serverSide, delay(2000)]);
        return out;
    } finally {
        client.close();
        server.close();
    }
}

/**
 * One GET over a real HTTP/1.1 connection, with the same contract as `h2()`.
 *
 * @param {function(object, object): void} handler
 * @returns {Promise<{status: number, body: string}>}
 */
async function h1(handler) {
    var server = http.createServer();
    servers.push(server);
    var closed, serverSide = new Promise(function(r) { closed = r; });
    server.on('request', function(req, res) {
        res.on('close', function() { closed(); });
        handler(req, res);
    });
    await new Promise(function(r) { server.listen(0, '127.0.0.1', r); });
    try {
        var out = await new Promise(function(resolve, reject) {
            http.get({ host: '127.0.0.1', port: server.address().port, path: '/', agent: false }, function(r) {
                var chunks = [];
                r.on('data', function(d) { chunks.push(d); });
                r.on('end', function() { resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString() }); });
            }).on('error', reject);
        });
        await Promise.race([serverSide, delay(2000)]);
        return out;
    } finally {
        server.close();
    }
}

/** A logger stand-in that records what it is given. */
function recordingConsole() {
    var seen = { info: [], warn: [], error: [] };
    return {
        seen  : seen,
        info  : function(m) { seen.info.push(String(m)); },
        warn  : function(m) { seen.warn.push(String(m)); },
        error : function(m) { seen.error.push(String(m)); },
        debug : function() {}
    };
}


// ─── 00 — instrument controls ────────────────────────────────────────────────

describe('00 - instrument controls (read no gina source; hold on any bytes)', function() {
    it('a: a STRICT assignment to headersSent throws on a real Http2ServerResponse; a sloppy one does not', async function() {
        var strict = compileStrict(['res'], 'res.headersSent = true;');
        var sloppy = new Function('res', 'res.headersSent = true;');
        var got = {};
        await h2(function(req, res) {
            res.end('x');
            try { strict(res); got.strict = 'no throw'; } catch (e) { got.strict = e.constructor.name; }
            try { sloppy(res); got.sloppy = 'no throw'; } catch (e) { got.sloppy = e.constructor.name; }
        });
        assert.equal(got.strict, 'TypeError', 'the scene must reproduce the #B750 throw');
        assert.equal(got.sloppy, 'no throw', 'and the strict directive must be what makes it throw');
    });

    it('b: after a raw stream.respond(404), finish still reads statusCode 200 (the #B749 mechanism)', async function() {
        var atFinish;
        var out = await h2(function(req, res) {
            res.on('finish', function() { atFinish = res.statusCode; });
            res.stream.respond({ ':status': 404 });
            res.stream.end('nf');
        });
        assert.equal(out.headers[':status'], 404, 'the wire carries the raw frame\'s status');
        assert.equal(atFinish, 200, 'the scene must reproduce the #B749 mislabel');
    });

    it('c: a STRICT assignment to headersSent throws on a real HTTP/1.1 ServerResponse after end()', async function() {
        var strict = compileStrict(['res'], 'res.headersSent = true;');
        var got;
        await h1(function(req, res) {
            res.end('x');
            try { strict(res); got = 'no throw'; } catch (e) { got = e.constructor.name; }
        });
        assert.equal(got, 'TypeError', 'the scene must reproduce the render-xml HTTP/1.1 throw');
    });
});


// ─── 01 — source pins ────────────────────────────────────────────────────────

describe('01 - source: no headersSent assignment in active code; the raw send helpers set the status', function() {
    var SERVER_CODE   = noCommentLines(SERVER_SRC);
    var NUNJUCKS_CODE = noCommentLines(NUNJUCKS_SRC);
    var XML_CODE      = noCommentLines(XML_SRC);

    it('core/server.js', function() {
        assert.equal((SERVER_CODE.match(/\.headersSent\s*=\s*true/g) || []).length, 0,
            'no headersSent assignment may remain in active code');
        assert.equal(count(SERVER_SRC, '// was: res.headersSent = true;'), 1,
            'control: the removed assignment is kept as a `// was:` line');
    });

    it('controller.render-nunjucks.js', function() {
        assert.equal((NUNJUCKS_CODE.match(/\.headersSent\s*=\s*true/g) || []).length, 0,
            'no headersSent assignment may remain in active code');
        assert.equal(count(NUNJUCKS_SRC, '// was: res.headersSent = true;'), 2,
            'control: both removed assignments (HEAD and body over HTTP/2) are kept as `// was:` lines');
    });

    it('controller.render-xml.js', function() {
        assert.equal((XML_CODE.match(/\.headersSent\s*=\s*true/g) || []).length, 0,
            'no headersSent assignment may remain in active code');
        assert.equal(count(XML_SRC, '// was: response.headersSent = true;'), 2,
            'control: both removed assignments (HTTP/2 and HTTP/1.1) are kept as `// was:` lines');
    });

    it('both throwError raw send helpers set res.statusCode before stream.respond(header)', function() {
        ['__ginaSendErrJSON', '__ginaSendErrHTML'].forEach(function(name) {
            var body = extract(SERVER_CODE, 'var ' + name + ' = function(errBody) {');
            var set  = body.indexOf('try { res.statusCode = code; } catch (e) {}');
            var resp = body.indexOf('stream.respond(header);');
            assert.ok(set > -1, name + ' must set res.statusCode');
            assert.ok(resp > set, name + ': the status must be set BEFORE the raw respond');
        });
    });
});


// ─── 02 — serveRenderCacheHit (#B750) ────────────────────────────────────────

describe('02 - serveRenderCacheHit (core/server.js) on a real HTTP/2 response', function() {
    it('serves an L2 warm without throwing and writes its access-log line', async function() {
        var log  = recordingConsole();
        var self = {
            conf     : { app: { prod: { server: { protocol: 'http/2.0' } } } },
            appName  : 'app',
            env      : 'prod',
            instance : { _cacheName: 'gina-cache' }
        };
        var serve = lift(SERVER_SRC, 'var serveRenderCacheHit = function(req, res, hit, source) {',
            'serveRenderCacheHit', ['self', 'lib', 'console'], [self, lib, log]);
        var hit = {
            content         : '<p>cached</p>',
            ttl             : 600,
            createdAt       : new Date(),
            visibility      : 'public',
            responseHeaders : { 'content-type': 'text/html; charset=utf-8' }
        };
        var thrown = null, returned;
        var out = await h2(function(req, res) {
            try { returned = serve(req, res, hit, 'redis'); } catch (e) { thrown = e; }
        });
        assert.equal(thrown, null, 'pre-#B750 this threw after the send: ' + (thrown && thrown.message));
        assert.equal(returned, true);
        assert.equal(out.headers[':status'], 200);
        assert.equal(out.body, '<p>cached</p>');
        assert.match(String(out.headers['cache-status']), /^gina-cache; hit; ttl=\d+; detail=redis$/);
        assert.equal(log.seen.info.length, 1, 'the access-log line must be written');
        assert.match(log.seen.info[0], /^GET \[200\]\[gina-cache; hit; ttl=\d+; detail=redis\] \/$/);
    });
});


// ─── 03 — the throwError raw send helpers (#B749) ────────────────────────────

describe('03 - throwError raw send helpers (core/server.js): the compat response carries the code', function() {
    /**
     * Lift one helper bound to this request, call it directly, and record what a
     * 'finish' reader (the metrics hook) would read.
     */
    function sendDirect(name, code, contentType) {
        var atFinish, thrown = null;
        return h2(function(req, res) {
            var header = { ':status': code, 'content-type': contentType };
            var send = lift(SERVER_SRC, 'var ' + name + ' = function(errBody) {', name,
                ['res', 'header', 'stream', 'code'], [res, header, res.stream, code]);
            res.on('finish', function() { atFinish = res.statusCode; });
            try { send(JSON.stringify({ status: code })); } catch (e) { thrown = e; }
        }).then(function(out) {
            return { out: out, atFinish: atFinish, thrown: thrown };
        });
    }

    [
        ['__ginaSendErrJSON', 404, 'application/json; charset=utf-8'],
        ['__ginaSendErrJSON', 405, 'application/json; charset=utf-8'],
        ['__ginaSendErrJSON', 500, 'application/json; charset=utf-8'],
        ['__ginaSendErrHTML', 404, 'text/html; charset=utf-8']
    ].forEach(function(c) {
        it(c[0] + ' ' + c[1] + ', direct send: finish reads ' + c[1], async function() {
            var r = await sendDirect(c[0], c[1], c[2]);
            assert.equal(r.thrown, null);
            assert.equal(r.out.headers[':status'], c[1], 'the wire carries the code (unchanged by the fix)');
            assert.equal(r.atFinish, c[1], 'pre-#B749 finish read 200');
        });
    });

    it('__ginaSendErrJSON 404 through the #B562 shim (writeHead swallowed): finish reads 404', async function() {
        var shim = lift(SERVER_SRC, 'var installH2SendShim = function(res) {', 'installH2SendShim', ['Buffer'], [Buffer]);
        var atFinish, thrown = null;
        var out = await h2(function(req, res) {
            shim(res);
            var header = { ':status': 404, 'content-type': 'application/json; charset=utf-8' };
            var send = lift(SERVER_SRC, 'var __ginaSendErrJSON = function(errBody) {', '__ginaSendErrJSON',
                ['res', 'header', 'stream', 'code'], [res, header, res.stream, 404]);
            res.on('finish', function() { atFinish = res.statusCode; });
            try {
                res._ginaRawSend = send;
                res.writeHead(404);
                res.end('{"status":404}');
            } catch (e) { thrown = e; }
        });
        assert.equal(thrown, null);
        assert.equal(out.headers[':status'], 404);
        assert.equal(out.body, '{"status":404}', 'the shim buffers the body and hands it to the raw send');
        assert.equal(atFinish, 404, 'pre-#B749 the shim swallowed writeHead(404) and finish read 200');
    });

    it('control: an undefined code still sends, as 200, and nothing throws', async function() {
        var r = await sendDirect('__ginaSendErrJSON', undefined, 'application/json; charset=utf-8');
        assert.equal(r.thrown, null, 'the setter throws on undefined — the try/catch must keep the send going');
        assert.equal(r.out.headers[':status'], 200, 'respond() sends an undefined :status as 200');
        assert.equal(r.atFinish, 200);
    });
});


// ─── 04 — render-nunjucks sendHtmlResponse (#B750) ───────────────────────────

describe('04 - render-nunjucks sendHtmlResponse on a real HTTP/2 response', function() {
    function liftSend(log) {
        return lift(NUNJUCKS_SRC, 'function sendHtmlResponse(local, html, req, res) {', 'sendHtmlResponse',
            ['console'], [log]);
    }
    var shim = lift(SERVER_SRC, 'var installH2SendShim = function(res) {', 'installH2SendShim', ['Buffer'], [Buffer]);

    it('body, direct send: no throw, the page reaches the client, headersSent reports the send', async function() {
        var send = liftSend(recordingConsole());
        var thrown = null, sentAfter;
        var out = await h2(function(req, res) {
            try { send({}, '<p>page</p>', req, res); } catch (e) { thrown = e; }
            sentAfter = res.headersSent;
        });
        assert.equal(thrown, null, 'pre-#B750 this threw after the send: ' + (thrown && thrown.message));
        assert.equal(out.headers[':status'], 200);
        assert.equal(out.body, '<p>page</p>');
        assert.equal(sentAfter, true, 'the getter reports the raw send without any assignment');
    });

    it('body through the #B562 shim: no throw, the page reaches the client', async function() {
        var send = liftSend(recordingConsole());
        var thrown = null;
        var out = await h2(function(req, res) {
            shim(res);
            try { send({}, '<p>page</p>', req, res); } catch (e) { thrown = e; }
        });
        assert.equal(thrown, null, 'pre-#B750 this threw after the send: ' + (thrown && thrown.message));
        assert.equal(out.headers[':status'], 200);
        assert.equal(out.body, '<p>page</p>');
    });

    it('HEAD: no throw, the headers arrive without a body', async function() {
        var send = liftSend(recordingConsole());
        var thrown = null;
        var out = await h2(function(req, res) {
            try { send({}, '<p>page</p>', req, res); } catch (e) { thrown = e; }
        }, { ':method': 'HEAD' });
        assert.equal(thrown, null, 'pre-#B750 this threw after the send: ' + (thrown && thrown.message));
        assert.equal(out.headers[':status'], 200);
        assert.equal(String(out.headers['content-length']), String(Buffer.byteLength('<p>page</p>')));
        assert.equal(out.body, '');
    });
});


// ─── 05 — render-xml, the real module (#B750) ────────────────────────────────

describe('05 - render-xml (the real module) on real responses', function() {
    /**
     * The 3-key deps contract controller.js passes, with its `headersSent(res)`
     * mirrored and `self.throwError` recording what reaches it.
     */
    function makeDeps(req, res, next) {
        var thrown = [];
        var local = {
            req     : req,
            res     : res,
            next    : next || null,
            options : { renderingStack: [], conf: { encoding: 'utf-8' } }
        };
        var self = {
            isProcessingError : false,
            throwError        : function() { thrown.push(Array.prototype.slice.call(arguments)); }
        };
        var headersSent = function(r) {
            var _r = (typeof(r) != 'undefined') ? r : local.res;
            if (!_r) { return true; }
            if (typeof(_r.stream) != 'undefined' && _r.stream.headersSent === true) { return true; }
            return _r.headersSent;
        };
        return { deps: { self: self, local: local, headersSent: headersSent }, local: local, thrown: thrown };
    }

    it('HTTP/2: nothing reaches throwError, the cleanup runs, the document reaches the client', async function() {
        var h;
        var out = await h2(function(req, res) {
            h = makeDeps(req, res, null);
            renderXML(DOC, null, h.deps);
        });
        assert.deepEqual(h.thrown.map(function(a) { return a[1]; }), [],
            'pre-#B750 the TypeError reached throwError(500) on a response already sent');
        assert.equal(h.local.res, null, 'the cleanup after the send must run');
        assert.equal(out.headers[':status'], 200);
        assert.equal(out.body, DOC);
    });

    it('HTTP/1.1: returns after the send; next() is not called on the ended response', async function() {
        var nextCalls = 0, h;
        var out = await h1(function(req, res) {
            h = makeDeps(req, res, function() { nextCalls++; });
            renderXML(DOC, null, h.deps);
        });
        assert.equal(nextCalls, 0, 'pre-#B750 the swallowed TypeError fell through to next()');
        assert.deepEqual(h.thrown, []);
        assert.equal(h.local.res, null, 'the cleanup must run');
        assert.equal(out.status, 200);
        assert.equal(out.body, DOC);
    });
});
