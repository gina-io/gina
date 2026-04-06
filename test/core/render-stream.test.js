'use strict';
/**
 * renderStream — controller.render-stream.js unit tests
 *
 * Strategy: inject mock deps (self, local, headersSent) and fake HTTP
 * objects, then drive the async IIFE through its paths.
 *
 * Suites:
 *  01 — controller.js: renderStream method wired correctly
 *  02 — render-stream.js: guards (double-render, isProcessingError, headersSent)
 *  03 — SSE framing: text/event-stream chunks are wrapped as data: …\n\n
 *  04 — raw content-type: chunks written verbatim
 *  05 — HTTP/1.1: headers set, write/end called in order
 *  06 — HTTP/2: stream.respond + stream.write + stream.end
 *  07 — connection-close detection: destroyed/writableEnded mid-stream
 *  08 — error handling: throwError called on iterable rejection
 *  09 — cleanup: local.req/res/next nulled on all exit paths
 */
var { describe, it, before }  = require('node:test');
var assert  = require('node:assert/strict');
var path    = require('path');
var fs      = require('fs');

var FW              = require('../fw');
var CONTROLLER_SRC  = path.join(FW, 'core/controller/controller.js');
var RENDER_STREAM   = path.join(FW, 'core/controller/controller.render-stream.js');

var renderStream = require(RENDER_STREAM);

// ─── helpers ─────────────────────────────────────────────────────────────────

async function* from(items) { for (var i of items) yield i; }

function makeLocal(overrides) {
    return Object.assign({
        req  : {},
        res  : { getHeaders: function() { return {}; }, headersSent: false, statusCode: 200,
                 setHeader: function() {}, write: function() {}, end: function() {},
                 writableEnded: false, destroyed: false },
        next : null,
        options: { renderingStack: [], conf: { server: { protocol: 'http/1.1' }, encoding: 'utf-8',
            coreConfiguration: { mime: { json: 'application/json' } } } }
    }, overrides);
}

function makeDeps(localOverrides, selfOverrides) {
    var local = makeLocal(localOverrides);
    var _headersSent = false;
    var self = Object.assign({ isProcessingError: false, throwError: function() {} }, selfOverrides);
    var headersSent = function() { return _headersSent; };
    headersSent._set = function(v) { _headersSent = v; };
    return { self: self, local: local, headersSent: headersSent };
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }


// ─── 01 — controller.js source ───────────────────────────────────────────────

describe('01 - renderStream: controller.js wiring', function() {

    var src;
    before(function() { src = fs.readFileSync(CONTROLLER_SRC, 'utf8'); });

    it('defines this.renderStream on SuperController', function() {
        assert.ok(/this\.renderStream\s*=\s*function/.test(src));
    });

    it('delegates to controller.render-stream', function() {
        assert.ok(/controller\.render-stream/.test(src));
    });

    it('cache-busts controller.render-stream in cacheless mode', function() {
        var block = src.slice(src.indexOf('this.renderStream'), src.indexOf('this.renderStream') + 1100);
        assert.ok(/isCacheless/.test(block));
        assert.ok(/delete require\.cache/.test(block));
    });

    it('passes asyncIterable, contentType, and deps to the delegate', function() {
        var block = src.slice(src.indexOf('this.renderStream'), src.indexOf('this.renderStream') + 1100);
        assert.ok(/asyncIterable/.test(block));
        assert.ok(/contentType/.test(block));
        assert.ok(/self\s*:\s*self/.test(block));
        assert.ok(/local\s*:\s*local/.test(block));
        assert.ok(/headersSent\s*:\s*headersSent/.test(block));
    });

    it('renderStream appears after renderJSON in the source', function() {
        assert.ok(src.indexOf('this.renderStream') > src.indexOf('this.renderJSON'));
    });
});


// ─── 02 — guards ─────────────────────────────────────────────────────────────

describe('02 - renderStream: guards', function() {

    it('returns false when renderingStack.length > 1', function() {
        var deps = makeDeps({ options: { renderingStack: [1, 2],
            conf: { server: { protocol: 'http/1.1' }, encoding: 'utf-8',
                coreConfiguration: { mime: {} } } } });
        var result = renderStream(from([]), 'text/event-stream', deps);
        assert.strictEqual(result, false);
    });

    it('returns undefined (early) when isProcessingError is true', function() {
        var deps = makeDeps({}, { isProcessingError: true });
        var result = renderStream(from([]), 'text/event-stream', deps);
        assert.strictEqual(result, undefined);
    });

    it('nulls locals and returns when headers already sent', function() {
        var deps = makeDeps();
        deps.headersSent._set(true);
        renderStream(from([]), 'text/event-stream', deps);
        assert.strictEqual(deps.local.req, null);
        assert.strictEqual(deps.local.res, null);
        assert.strictEqual(deps.local.next, null);
    });
});


// ─── 03 — SSE framing ────────────────────────────────────────────────────────

describe('03 - renderStream: SSE framing', function() {

    it('wraps each chunk as data: {chunk}\\n\\n for text/event-stream', async function() {
        var written = [];
        var deps = makeDeps();
        deps.local.res.write = function(d) { written.push(d); };
        deps.local.res.end   = function() {};

        renderStream(from(['hello', 'world']), 'text/event-stream', deps);
        await sleep(50);

        assert.deepEqual(written, ['data: hello\n\n', 'data: world\n\n']);
    });

    it('defaults to text/event-stream when contentType is omitted', async function() {
        var written = [];
        var deps = makeDeps();
        deps.local.res.write = function(d) { written.push(d); };
        deps.local.res.end   = function() {};

        renderStream(from(['token']), undefined, deps);
        await sleep(50);

        assert.ok(written[0].startsWith('data: '));
    });

    it('sets x-accel-buffering: no for SSE (disables nginx buffering)', async function() {
        var headers = {};
        var deps = makeDeps();
        deps.local.res.setHeader = function(k, v) { headers[k.toLowerCase()] = v; };
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        renderStream(from([]), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(headers['x-accel-buffering'], 'no');
    });

    it('converts Buffer chunks to UTF-8 string before SSE framing', async function() {
        var written = [];
        var deps = makeDeps();
        deps.local.res.write = function(d) { written.push(d); };
        deps.local.res.end   = function() {};

        renderStream(from([Buffer.from('buffered')]), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(written[0], 'data: buffered\n\n');
    });
});


// ─── 04 — raw content-type ───────────────────────────────────────────────────

describe('04 - renderStream: raw (non-SSE) content-type', function() {

    it('writes chunks verbatim for application/octet-stream', async function() {
        var written = [];
        var deps = makeDeps();
        deps.local.res.write = function(d) { written.push(d); };
        deps.local.res.end   = function() {};

        renderStream(from(['chunk1', 'chunk2']), 'application/octet-stream', deps);
        await sleep(50);

        assert.deepEqual(written, ['chunk1', 'chunk2']);
    });

    it('does not wrap chunks in data: prefix for text/plain', async function() {
        var written = [];
        var deps = makeDeps();
        deps.local.res.write = function(d) { written.push(d); };
        deps.local.res.end   = function() {};

        renderStream(from(['line']), 'text/plain', deps);
        await sleep(50);

        assert.strictEqual(written[0], 'line');
        assert.ok(!written[0].startsWith('data:'));
    });
});


// ─── 05 — HTTP/1.1 path ──────────────────────────────────────────────────────

describe('05 - renderStream: HTTP/1.1 response path', function() {

    it('sets content-type header', async function() {
        var headers = {};
        var deps = makeDeps();
        deps.local.res.setHeader = function(k, v) { headers[k.toLowerCase()] = v; };
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        renderStream(from([]), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(headers['content-type'], 'text/event-stream');
    });

    it('sets cache-control: no-cache', async function() {
        var headers = {};
        var deps = makeDeps();
        deps.local.res.setHeader = function(k, v) { headers[k.toLowerCase()] = v; };
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        renderStream(from([]), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(headers['cache-control'], 'no-cache');
    });

    it('sets connection: keep-alive', async function() {
        var headers = {};
        var deps = makeDeps();
        deps.local.res.setHeader = function(k, v) { headers[k.toLowerCase()] = v; };
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        renderStream(from([]), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(headers['connection'], 'keep-alive');
    });

    it('calls response.end() after all chunks are written', async function() {
        var ended = false;
        var deps = makeDeps();
        deps.local.res.write = function() {};
        deps.local.res.end   = function() { ended = true; };

        renderStream(from(['a', 'b']), 'text/event-stream', deps);
        await sleep(50);

        assert.ok(ended, 'response.end() should have been called');
    });

    it('sets response.headersSent = true after streaming', async function() {
        var deps = makeDeps();
        var res = deps.local.res;   // capture before finally nulls local.res
        res.write = function() {};
        res.end   = function() {};

        renderStream(from(['x']), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(res.headersSent, true);
    });
});


// ─── 06 — HTTP/2 path ────────────────────────────────────────────────────────

describe('06 - renderStream: HTTP/2 stream path', function() {

    function makeHttp2Deps(pendingHeaders) {
        var responded = null;
        var written   = [];
        var ended     = false;
        var stream2   = {
            headersSent : false,
            destroyed   : false,
            closed      : false,
            respond     : function(h) { responded = h; stream2.headersSent = true; },
            write       : function(d) { written.push(d); },
            end         : function()  { ended = true; }
        };
        var deps = makeDeps();
        deps.local.res.stream     = stream2;
        deps.local.res.getHeaders = function() { return pendingHeaders || {}; };
        deps.local.res.headersSent = false;
        return { deps: deps, stream2: stream2, get responded() { return responded; },
                 get written() { return written; }, get ended() { return ended; } };
    }

    it('calls stream.respond() with :status 200 before writing', async function() {
        var h = makeHttp2Deps();
        renderStream(from(['tok']), 'text/event-stream', h.deps);
        await sleep(50);
        assert.ok(h.responded, 'stream.respond() should have been called');
        assert.strictEqual(h.responded[':status'], 200);
    });

    it('includes content-type in stream.respond() headers', async function() {
        var h = makeHttp2Deps();
        renderStream(from([]), 'text/event-stream', h.deps);
        await sleep(50);
        assert.strictEqual(h.responded['content-type'], 'text/event-stream');
    });

    it('merges pending response headers (CORS etc.) into stream.respond()', async function() {
        var h = makeHttp2Deps({ 'access-control-allow-origin': '*' });
        renderStream(from([]), 'text/event-stream', h.deps);
        await sleep(50);
        assert.strictEqual(h.responded['access-control-allow-origin'], '*');
    });

    it('does not overwrite :status with pending headers', async function() {
        var h = makeHttp2Deps({ ':status': 204 });
        renderStream(from([]), 'text/event-stream', h.deps);
        await sleep(50);
        // :status should remain 200 — pending headers must not clobber it
        assert.strictEqual(h.responded[':status'], 200);
    });

    it('calls stream.write() for each chunk', async function() {
        var h = makeHttp2Deps();
        renderStream(from(['a', 'b', 'c']), 'text/event-stream', h.deps);
        await sleep(50);
        assert.deepEqual(h.written, ['data: a\n\n', 'data: b\n\n', 'data: c\n\n']);
    });

    it('calls stream.end() after all chunks', async function() {
        var h = makeHttp2Deps();
        renderStream(from(['x']), 'text/event-stream', h.deps);
        await sleep(50);
        assert.ok(h.ended, 'stream.end() should have been called');
    });

    it('sets response.headersSent = true after HTTP/2 stream ends', async function() {
        var h = makeHttp2Deps();
        var res = h.deps.local.res;  // capture before finally nulls local.res
        renderStream(from([]), 'text/event-stream', h.deps);
        await sleep(50);
        assert.strictEqual(res.headersSent, true);
    });

    it('skips writing if stream is already destroyed before start', async function() {
        var h = makeHttp2Deps();
        h.stream2.destroyed = true;
        var called = false;
        h.stream2.respond = function() { called = true; };
        renderStream(from(['tok']), 'text/event-stream', h.deps);
        await sleep(50);
        assert.ok(!called, 'respond should not be called on a destroyed stream');
    });
});


// ─── 07 — connection-close detection ─────────────────────────────────────────

describe('07 - renderStream: connection-close detection', function() {

    it('stops writing HTTP/1.1 chunks when response.writableEnded becomes true mid-stream', async function() {
        var written = [];
        var deps = makeDeps();
        var count = 0;
        deps.local.res.write = function(d) {
            written.push(d);
            count++;
            if (count >= 1) deps.local.res.writableEnded = true;
        };
        deps.local.res.end = function() {};

        async function* slow() { yield 'first'; yield 'second'; yield 'third'; }

        renderStream(slow(), 'text/plain', deps);
        await sleep(100);

        assert.strictEqual(written.length, 1);
    });

    it('stops writing HTTP/2 chunks when stream.destroyed becomes true mid-stream', async function() {
        var written = [];
        var stream2 = {
            headersSent: false, destroyed: false, closed: false,
            respond: function() { stream2.headersSent = true; },
            write  : function(d) { written.push(d); stream2.destroyed = true; },
            end    : function() {}
        };
        var deps = makeDeps();
        deps.local.res.stream     = stream2;
        deps.local.res.getHeaders = function() { return {}; };

        async function* slow() { yield 'a'; yield 'b'; yield 'c'; }

        renderStream(slow(), 'text/plain', deps);
        await sleep(100);

        assert.strictEqual(written.length, 1);
    });
});


// ─── 08 — error handling ─────────────────────────────────────────────────────

describe('08 - renderStream: error handling', function() {

    it('calls self.throwError(response, 500, err) when the iterable rejects', async function() {
        var thrownCode = null, thrownErr = null;
        var deps = makeDeps({}, {
            throwError: function(res, code, err) { thrownCode = code; thrownErr = err; }
        });
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        async function* bad() { yield 'ok'; throw new Error('boom'); }

        renderStream(bad(), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(thrownCode, 500);
        assert.ok(thrownErr instanceof Error);
        assert.strictEqual(thrownErr.message, 'boom');
    });
});


// ─── 09 — cleanup ────────────────────────────────────────────────────────────

describe('09 - renderStream: cleanup (locals nulled)', function() {

    it('nulls local.req, local.res, local.next after successful HTTP/1.1 stream', async function() {
        var deps = makeDeps();
        deps.local.req  = {};
        deps.local.next = function() {};
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        renderStream(from(['x']), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(deps.local.req,  null);
        assert.strictEqual(deps.local.res,  null);
        assert.strictEqual(deps.local.next, null);
    });

    it('nulls locals even when the iterable throws', async function() {
        var deps = makeDeps({}, { throwError: function() {} });
        deps.local.req  = {};
        deps.local.next = function() {};
        deps.local.res.write = function() {};
        deps.local.res.end   = function() {};

        async function* bad() { throw new Error('fail'); }

        renderStream(bad(), 'text/event-stream', deps);
        await sleep(50);

        assert.strictEqual(deps.local.req,  null);
        assert.strictEqual(deps.local.res,  null);
        assert.strictEqual(deps.local.next, null);
    });
});
