/**
 * #B722 — isaac's own event streams (`/_gina/release/events`, `/_gina/logs`, `/_gina/agent`)
 * answer over HTTP/2.
 *
 * The defect: each handler built ONE header set for both protocols, and it carried
 * `connection: keep-alive`. HTTP/2 forbids connection-specific headers, so node's
 * `stream.respond()` threw `ERR_HTTP2_INVALID_CONNECTION_HEADERS`; lib/proc.js logged the throw
 * as a warn and the client never received response headers. Over HTTP/1.1 the same handlers
 * streamed, so only an HTTP/2 client (a browser on an `http/2.0` bundle's own port) was hit.
 *
 * The fix: the shared set no longer carries `connection`; the HTTP/1.1 branch adds it to its own
 * `writeHead()` call, so an HTTP/1.1 client still gets `connection: keep-alive`.
 *
 * Instrument: each handler's whole `if ( … ) { … }` statement is EXTRACTED from the shipped
 * source (from its section comment to the next one) and EXECUTED inside the request handler of a
 * REAL node server — http2 (h2c) for the HTTP/2 arms, http for the HTTP/1.1 controls — so node's
 * own header validation judges the headers, not a replica. The framework symbols the statement
 * reads (the gates, `lib`, `process.gina`, the powered-by helper) are passed in as stubs. A throw
 * from the handler is recorded and reported, so a red run names the error node raised. Controls:
 * every handler streams over HTTP/1.1 before and after the fix (the extraction and the stubs are
 * complete), and a url the handler does not own gets no answer from it — the harness then answers
 * 404 itself, so the extracted condition is proven to be the real gate.
 *
 * Red-first seam (the #B498 harness name): GINA_ISAAC_SRC points the file at another tree's
 * `core/server.isaac.js`.
 *
 * Run standalone:
 *   node --test test/core/isaac-event-streams-h2-b722.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');
var http   = require('http');
var http2  = require('http2');

var FW        = require('../fw');
var ISAAC_SRC = process.env.GINA_ISAAC_SRC || path.join(FW, 'core/server.isaac.js');
var SRC       = fs.readFileSync(ISAAC_SRC, 'utf8');

var PARAMS = ['isCacheless', 'request', 'response', 'process', 'console', 'lib', '_setPoweredByHeader', '_agentKeyValid', 'server', 'options', 'env'];


// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/**
 * The handler statement that follows a unique section comment: from the first `if (` after it
 * to the next `// ── ` section comment. Every anchor exists once in the tree before the fix and
 * after it, so a red run fails on behaviour, never on a missing anchor.
 *
 * @param {string} anchor - The section comment that opens the handler
 * @param {string} label - For assertion messages
 * @returns {string} The `if (…) { … }` statement
 */
function statementAfter(anchor, label) {
    var at = SRC.indexOf(anchor);
    assert.ok(at > -1, label + ': anchor not found: ' + anchor);
    assert.equal(SRC.indexOf(anchor, at + 1), -1, label + ': the anchor must be unique');
    var ifAt  = SRC.indexOf('if (', at);
    var endAt = SRC.indexOf('// ── ', ifAt);
    assert.ok(ifAt > at && endAt > ifAt, label + ': could not bound the statement');
    var text = SRC.slice(ifAt, endAt).trim();
    assert.ok(/\}$/.test(text), label + ': the statement must end with its closing brace');
    return text;
}

var HANDLERS = {
    'release events': {
        text : statementAfter('// SSE — mirrors the /_gina/logs stream shape: registers a closer in', 'release events'),
        path : '/_gina/release/events'
    },
    'logs': {
        text : statementAfter('// ── Server-side log streaming — SSE at /_gina/logs in dev mode ──', 'logs'),
        path : '/_gina/logs'
    },
    'agent': {
        text : statementAfter('// ── Inspector agent — combined SSE at /_gina/agent in dev mode ──', 'agent'),
        path : '/_gina/agent'
    }
};


// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** The stubs one handler run reads; `seen` records what it did. */
function makeDeps() {
    var seen = { info: [], listeners: 0 };
    var proc = {
        gina           : { _sseConnections: new Set() },
        on             : function () { seen.listeners++; },
        removeListener : function () { seen.listeners--; }
    };
    var lib = {
        releaseWatch : {
            isActive  : function () { return true; },
            getStatus : function () { return { stale: false }; },
            subscribe : function () { return function () {}; }
        },
        admin      : { isClientAllowed: function () { return true; } },
        instrument : { isActive: function () { return false; } }
    };
    return {
        seen : seen,
        args : [
            true,                                   // isCacheless — the dev gate
            null, null,                             // request, response — set per call
            proc,
            { info: function (m) { seen.info.push(String(m)); }, warn: function () {}, error: function () {} },
            lib,
            function (h) { return h; },             // _setPoweredByHeader
            function () { return true; },           // _agentKeyValid
            { _lastGinaData: null },                // server — no snapshot: the agent sends its "connected" frame
            { bundle: 'web' },                      // options
            'dev'                                   // env
        ]
    };
}

/**
 * Runs one extracted handler on a real server and reads the first chunk a client gets.
 *
 * @param {string} name - A HANDLERS key
 * @param {string} proto - 'h2' (http2 over cleartext) or 'h1'
 * @param {string} [reqPath] - Defaults to the handler's own path
 * @returns {Promise<{status: ?number, headers: object, body: string, thrown: ?Error, deps: object}>}
 */
function runHandler(name, proto, reqPath) {
    var fn     = new Function(PARAMS.join(','), HANDLERS[name].text);
    var deps   = makeDeps();
    var thrown = null;
    var srv    = (proto === 'h2' ? http2 : http).createServer();
    srv.on('request', function (request, response) {
        var args = deps.args.slice();
        args[1] = request; args[2] = response;
        try { fn.apply(null, args); }
        catch (e) {
            thrown = e;
            try { if (response.stream) { response.stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } else { response.destroy(); } } catch (_e) { /* gone */ }
            return;
        }
        // the statement did not answer: its condition refused the url
        if (!response.headersSent) { response.writeHead(404, { 'x-b722-unowned': '1' }); response.end(); }
    });
    return new Promise(function (resolve) {
        srv.listen(0, '127.0.0.1', function () {
            var port = srv.address().port, done = false, session = null, req = null;
            function fin(r) {
                if (done) { return; }
                done = true;
                r.thrown = thrown; r.deps = deps;
                try { if (req) { req.destroy(); } } catch (e) { /* gone */ }
                try { if (session) { session.destroy(); } } catch (e) { /* gone */ }
                srv.close();
                if (srv.closeAllConnections) { srv.closeAllConnections(); }
                resolve(r);
            }
            var p = reqPath || HANDLERS[name].path;
            if (proto === 'h2') {
                var st = null, hd = {}, body = '';
                session = http2.connect('http://127.0.0.1:' + port);
                session.on('error', function () { /* the arm reads its stream */ });
                req = session.request({ ':method': 'GET', ':path': p });
                req.on('response', function (h) { st = h[':status']; hd = h; });
                req.on('data', function (c) { body += c; fin({ status: st, headers: hd, body: body }); });
                req.on('close', function () { fin({ status: st, headers: hd, body: body, rst: req.rstCode }); });
                req.on('error', function (e) { fin({ status: st, headers: hd, body: body, err: e.message }); });
                req.setTimeout(3000, function () { fin({ status: st, headers: hd, body: body, timeout: true }); });
                req.end();
            } else {
                req = http.request({ host: '127.0.0.1', port: port, path: p, method: 'GET', agent: false }, function (res) {
                    var b = '';
                    res.on('data', function (c) { b += c; fin({ status: res.statusCode, headers: res.headers, body: b }); });
                    res.on('end', function () { fin({ status: res.statusCode, headers: res.headers, body: b }); });
                });
                req.on('error', function (e) { fin({ status: null, headers: {}, body: '', err: e.message }); });
                req.setTimeout(3000, function () { fin({ status: null, headers: {}, body: '', timeout: true }); });
                req.end();
            }
        });
    });
}

function show(r) {
    return JSON.stringify({ status: r.status, ctype: r.headers && r.headers['content-type'], body: (r.body || '').slice(0, 24),
        thrown: r.thrown ? (r.thrown.code || r.thrown.message) : null, rst: r.rst, err: r.err, timeout: r.timeout });
}

function assertStreams(r, label) {
    assert.equal(r.thrown, null, label + ': the handler threw ' + show(r));
    assert.equal(r.status, 200, label + ': ' + show(r));
    assert.match(String(r.headers['content-type'] || ''), /^text\/event-stream/, label + ': ' + show(r));
    assert.ok((r.body || '').indexOf(':ok') === 0, label + ': the stream opens with its `:ok` comment ' + show(r));
    // the rest of the shared set still travels on both protocols
    assert.equal(r.headers['cache-control'], 'no-cache, no-store', label + ': cache-control');
    assert.equal(r.headers['x-content-type-options'], 'nosniff', label + ': x-content-type-options');
}


// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('isaac event streams over HTTP/2 (#B722)', function () {

    Object.keys(HANDLERS).forEach(function (name, i) {
        var n = '0' + (i + 1);

        it(n + '.1  ' + name + ' — streams to an HTTP/2 client (pre-fix: ERR_HTTP2_INVALID_CONNECTION_HEADERS)', async function () {
            assertStreams(await runHandler(name, 'h2'), name + ' over HTTP/2');
        });

        it(n + '.2  ' + name + ' — control: streams to an HTTP/1.1 client, with `connection: keep-alive`', async function () {
            var r = await runHandler(name, 'h1');
            assertStreams(r, name + ' over HTTP/1.1');
            assert.equal(r.headers['connection'], 'keep-alive', name + ' over HTTP/1.1 keeps the header: ' + show(r));
        });

        it(n + '.3  ' + name + ' — control: the extracted condition is the handler\'s gate (a url it does not own gets no answer from it)', async function () {
            var r = await runHandler(name, 'h2', '/_gina/not-an-endpoint');
            assert.equal(r.thrown, null, name + ': ' + show(r));
            assert.equal(r.status, 404, name + ': the harness answered, not the handler: ' + show(r));
            assert.equal(r.headers['x-b722-unowned'], '1', name + ': ' + show(r));
            assert.equal(r.deps.seen.listeners, 0, name + ': the handler must not have subscribed');
        });
    });
});
