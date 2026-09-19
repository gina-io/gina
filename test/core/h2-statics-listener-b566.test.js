'use strict';
/**
 * #B566 — the once-per-instance HTTP/2 'stream' listener is gone.
 *
 * THE DEFECT: `handleStatics` registered ONE `'stream'` listener per server instance from
 * inside the first HTTP/2 static request's file-read callback, closing over THAT request's
 * `request`/`response`/`filename` bindings for the life of the process. Every later HTTP/2
 * static was served by that listener (it won the dispatch race against the async file read),
 * with the reply headers folded from the CAPTURED response — so one client's `Set-Cookie`,
 * request id and CORS headers reached every other client; an HTML static the listener had
 * not seen was served raw as a binary; and a directory's index URL died for the process
 * lifetime once the directory itself had been requested. Measured live on shipped bytes
 * (record: the #B566 design note and harness).
 *
 * THE FIX: the listener, its server-push handler and every piece of per-instance state they
 * shared are removed. Every HTTP/2 static is served by `handleStatics` on the request's OWN
 * `response.stream`, which already did so for the first request of every URL.
 *
 * WHICH PINS CAN GO RED — read this before trusting a green run:
 *   §01 negative, whole-file, comment-stripped: the removed machinery is absent. Every needle
 *       reads > 0 on the pre-fix source (validated red-first via `git show`), so each is a
 *       real discrimination, not decoration.
 *   §02 positive: the per-request send path survives — the pins that stop §01 passing on an
 *       empty or truncated file.
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs     = require('fs');
var path   = require('path');

var FW     = require('../fw');
var SERVER = fs.readFileSync(path.join(FW, 'core/server.js'), 'utf8');
var ROUTER = fs.readFileSync(path.join(FW, 'core/router.js'), 'utf8');

/** Strip block comments and line comments so no pin can be satisfied — or tripped — by prose. */
function code(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(function(l) { return !/^\s*\/\//.test(l); }).join('\n');
}
function count(hay, needle) {
    var n = 0, i = 0;
    while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
    return n;
}
var SERVER_CODE = code(SERVER);
var ROUTER_CODE = code(ROUTER);

/** The `handleStatics` body: from its declaration form to the next top-level JSDoc opener. */
function handleStaticsBody() {
    var decl = 'var handleStatics = function(staticProps, request, response, next) {';
    var i = SERVER.indexOf(decl);
    assert.ok(i > -1, 'handleStatics must keep its 4-parameter declaration form');
    var j = SERVER.indexOf('\n    /**', i);
    assert.ok(j > i, 'a JSDoc block must follow handleStatics');
    return code(SERVER.slice(i, j));
}

describe('01 - the once-per-instance stream listener and its machinery are gone (#B566)', function() {

    // Each needle is code-shaped (a member access or a call), never a bare word, so the
    // comments that still NAME the removed listener to explain its removal cannot match.
    var GONE = [
        "self.instance.on('stream'",
        '.on(\'stream\'',
        'onHttp2Stream',
        '_http2streamEventInitalized',
        '_getAssetFilenameFromUrl',
        'self.instance._isXMLRequest',
        'pushStream(',
        'pushAllowed',
        'self._referrer',
        'self._responseHeaders',
        'self._isStatic',
        'self._options'
    ];

    GONE.forEach(function(needle) {
        it('server.js no longer contains ' + JSON.stringify(needle), function() {
            assert.equal(count(SERVER_CODE, needle), 0, 'found ' + needle + ' in core/server.js (comment-stripped)');
        });
    });

    it('router.js no longer resets the listener latch at setServerInstance', function() {
        assert.equal(count(ROUTER_CODE, '_http2streamEventInitalized'), 0);
        assert.equal(count(ROUTER_CODE, 'this.setServerInstance = function(serverInstance) {'), 1,
            'setServerInstance itself must survive — only the latch line goes');
    });
});

describe('02 - handleStatics serves every HTTP/2 static on the request\'s own stream', function() {

    it('binds the stream from the per-request response exactly once', function() {
        assert.equal(count(handleStaticsBody(), 'stream = response.stream;'), 1);
    });

    it('keeps its two HTTP/2 send shapes — sendfile for binaries, respond+end for text', function() {
        var body = handleStaticsBody();
        assert.equal(count(body, 'stream.respondWithFile(filename, header)'), 1, 'the binary send (sendfile) must remain');
        assert.match(body, /stream\.respond\(header\);\s*\n\s*stream\.end\(file\);/, 'the text send must remain');
    });

    it('guards its send on the compat response (which reflects any raw-stream send), never on the removed listener', function() {
        var body = handleStaticsBody();
        assert.equal(count(body, 'if (response.headersSent) {'), 1);
        assert.equal(count(body, 'if (!response.headersSent) {'), 1);
    });

    it('no longer stamps anything on the server instance from inside the file-read callback', function() {
        assert.equal(count(handleStaticsBody(), 'self.instance.'), 0,
            'handleStatics must not write per-request state onto the shared server instance');
    });
});
