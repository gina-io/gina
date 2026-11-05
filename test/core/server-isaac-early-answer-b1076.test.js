'use strict';
/**
 * core/server.isaac.early-answer.js — the early-answer hooks of an HTTP/2 request on Bun (#B1076).
 *
 * The module is framework-free, so these arms drive the REAL functions against a stand-in stream:
 * an EventEmitter carrying the server-stream members the hooks use (respond, close, resume,
 * endAfterHeaders, closed, destroyed). Both runtime rules are driven on any runtime through
 * arm()'s `isBun` argument, so the file runs unchanged under `node --test` and `bun test`.
 *
 * What the runtimes themselves keep, discard and close under a zero receive window (Bun 1.2 / 1.3
 * keep what the client sends into a stream answered before its body was read) is measured by
 * booted scenes outside this suite; here, the contract of each hook, and its wiring (§08).
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path = require('path');
var fs = require('fs');
var EventEmitter = require('events');

var FW = require('../fw');
var earlyAnswer = require(path.join(FW, 'core', 'server.isaac.early-answer.js'));
var NO_ERROR = require('http2').constants.NGHTTP2_NO_ERROR;

/**
 * A stand-in server stream: records each respond / close / resume call.
 * @param {object} [opts]
 * @param {boolean} [opts.endAfterHeaders] - the request body ended with its headers (a GET)
 * @param {boolean} [opts.respondThrows]   - respond() throws after recording the call
 * @param {boolean} [opts.resumeThrows]    - resume() throws after recording the call
 * @returns {EventEmitter}
 */
function makeStream(opts) {
    var o = opts || {};
    var s = new EventEmitter();
    s.endAfterHeaders = ( o.endAfterHeaders === true );
    s.closed = false;
    s.destroyed = false;
    s.calls = { respond: [], close: [], resume: 0 };
    s.respond = function (headers, options) {
        s.calls.respond.push({ self: this, headers: headers, options: options });
        if ( o.respondThrows ) { throw new Error('respond failed'); }
        return 'respond-return';
    };
    s.close = function (code) { s.calls.close.push(code); s.closed = true; };
    s.resume = function () {
        s.calls.resume++;
        if ( o.resumeThrows ) { throw new Error('resume failed'); }
        return s;
    };
    return s;
}

/** A compatibility-request stand-in whose body reader listens on the stream, as Bun's does. */
function makeRequest(stream) {
    var request = { stream: stream };
    stream.on('data', function compatBodyReader() {});
    return request;
}

describe('01 - the module surface and the runtime rule', function () {

    it('exports the five hooks and the two constants', function () {
        ['arm', 'discard', 'discardThroughRequest', 'keepOpen', 'isArmed'].forEach(function (name) {
            assert.equal(typeof(earlyAnswer[name]), 'function', name);
        });
        assert.equal(earlyAnswer.NGHTTP2_NO_ERROR, NO_ERROR);
        assert.equal(NO_ERROR, 0);
    });

    it('RUNTIME_IS_BUN is decided by the runtime this file runs on', function () {
        assert.equal(earlyAnswer.RUNTIME_IS_BUN, ( typeof(process.versions.bun) == 'string' ));
    });
});

describe('02 - Node.js rule (isBun false): nothing is armed', function () {

    it('arm() returns false and leaves the stream as it was', function () {
        var stream = makeStream();
        var original = stream.respond;
        var request = makeRequest(stream);
        assert.equal(earlyAnswer.arm(request, false), false);
        assert.equal(stream.respond, original, 'respond is not wrapped');
        assert.equal(stream.listenerCount('finish'), 0, 'no close is armed');
        assert.equal(earlyAnswer.isArmed(request), false);
    });

    it('an answer then its finish: no discard, no close', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.arm(request, false);
        stream.respond({ ':status': 403 });
        stream.emit('finish');
        assert.equal(stream.calls.resume, 0);
        assert.equal(stream.listenerCount('data'), 1, 'the body reader stays');
        assert.deepEqual(stream.calls.close, []);
        assert.equal(earlyAnswer.discard(request), false, 'a stop discards nothing either');
        assert.equal(stream.calls.resume, 0);
    });

    it('only `true` arms: a truthy non-boolean does not', function () {
        var request = makeRequest(makeStream());
        assert.equal(earlyAnswer.arm(request, 1), false);
        assert.equal(earlyAnswer.arm(request, 'yes'), false);
        assert.equal(earlyAnswer.isArmed(request), false);
    });
});

describe('03 - Bun rule: what is never armed', function () {

    it('no request, or a request with no stream (HTTP/1.1)', function () {
        assert.equal(earlyAnswer.arm(undefined, true), false);
        assert.equal(earlyAnswer.arm(null, true), false);
        assert.equal(earlyAnswer.arm({}, true), false);
        assert.equal(earlyAnswer.arm({ stream: null }, true), false);
    });

    it('a stream without close() or without respond()', function () {
        var noClose = makeStream(); noClose.close = undefined;
        var noRespond = makeStream(); noRespond.respond = undefined;
        assert.equal(earlyAnswer.arm(makeRequest(noClose), true), false);
        assert.equal(earlyAnswer.arm(makeRequest(noRespond), true), false);
    });

    it('a request whose body ended with its headers (a GET, a HEAD)', function () {
        var stream = makeStream({ endAfterHeaders: true });
        var original = stream.respond;
        var request = makeRequest(stream);
        assert.equal(earlyAnswer.arm(request, true), false);
        assert.equal(stream.respond, original);
        assert.equal(stream.listenerCount('finish'), 0);
        assert.equal(earlyAnswer.isArmed(request), false);
    });
});

describe('04 - Bun rule: an early answer (keepOpen() never called)', function () {

    it('the answer goes out through the original respond(), then the body is discarded', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        assert.equal(earlyAnswer.arm(request, true), true);
        assert.equal(earlyAnswer.isArmed(request), true);
        var headers = { ':status': 403 };
        var options = { endStream: false };
        var ret = stream.respond(headers, options);
        assert.equal(ret, 'respond-return', 'the return value passes through');
        assert.equal(stream.calls.respond.length, 1);
        assert.equal(stream.calls.respond[0].self, stream, 'called on the stream');
        assert.equal(stream.calls.respond[0].headers, headers);
        assert.equal(stream.calls.respond[0].options, options);
        assert.equal(stream.listenerCount('data'), 0, 'the body reader is detached');
        assert.equal(stream.calls.resume, 1, 'the stream flows into nothing');
        assert.equal(request._ginaBodyDiscarded, true);
    });

    it('the stream closes with NO_ERROR once the answer has finished, once', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        stream.respond({ ':status': 403 });
        assert.deepEqual(stream.calls.close, [], 'nothing is closed before the answer finishes');
        stream.emit('finish');
        assert.deepEqual(stream.calls.close, [NO_ERROR]);
        stream.emit('finish');
        assert.deepEqual(stream.calls.close, [NO_ERROR], 'a once listener');
    });

    it('a second respond() on the same stream discards nothing more', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        stream.respond({ ':status': 200 });
        stream.respond({ ':status': 200 });
        assert.equal(stream.calls.respond.length, 2);
        assert.equal(stream.calls.resume, 1);
    });

    it('the close at finish skips a stream already closed or destroyed', function () {
        var closed = makeStream();
        earlyAnswer.arm(makeRequest(closed), true);
        closed.closed = true;
        closed.emit('finish');
        assert.deepEqual(closed.calls.close, []);
        var destroyed = makeStream();
        earlyAnswer.arm(makeRequest(destroyed), true);
        destroyed.destroyed = true;
        destroyed.emit('finish');
        assert.deepEqual(destroyed.calls.close, []);
    });

    it('a respond() that throws: the throw propagates and nothing is discarded', function () {
        var stream = makeStream({ respondThrows: true });
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        assert.throws(function () { stream.respond({ ':status': 403 }); }, /respond failed/);
        assert.equal(stream.calls.resume, 0);
        assert.equal(stream.listenerCount('data'), 1);
        assert.notEqual(request._ginaBodyDiscarded, true);
    });
});

describe('05 - Bun rule: keepOpen() before the answer (the body is read, or the stream stays open)', function () {

    it('the answer neither discards the body nor closes the stream', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        earlyAnswer.keepOpen(request);
        stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
        stream.emit('finish');
        assert.equal(stream.calls.respond.length, 1, 'the answer still goes out');
        assert.equal(stream.calls.resume, 0);
        assert.equal(stream.listenerCount('data'), 1, 'the body reader stays');
        assert.deepEqual(stream.calls.close, []);
        assert.equal(earlyAnswer.isArmed(request), true, 'it stays armed for a parse-time stop');
    });

    it('keepOpen() on a request that was never armed changes nothing else', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.keepOpen(request);
        assert.equal(earlyAnswer.isArmed(request), false);
        assert.doesNotThrow(function () { earlyAnswer.keepOpen(undefined); });
        assert.doesNotThrow(function () { earlyAnswer.keepOpen(null); });
    });
});

describe('06 - discard() at a parse-time stop (closeStreamAfterAnswer, #B1071)', function () {

    it('an armed request whose body was being read: its body is discarded, once', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        earlyAnswer.keepOpen(request);
        assert.equal(earlyAnswer.discard(request), true);
        assert.equal(stream.listenerCount('data'), 0);
        assert.equal(stream.calls.resume, 1);
        assert.equal(earlyAnswer.discard(request), false, 'once per request');
        assert.equal(stream.calls.resume, 1);
    });

    it('nothing is discarded on a request that was never armed', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        assert.equal(earlyAnswer.discard(request), false);
        assert.equal(earlyAnswer.discard(undefined), false);
        assert.equal(earlyAnswer.discard({}), false);
        assert.equal(stream.calls.resume, 0);
        assert.equal(stream.listenerCount('data'), 1);
    });

    it('nothing is discarded on a closed or destroyed stream', function () {
        var closed = makeStream();
        var a = makeRequest(closed);
        earlyAnswer.arm(a, true);
        closed.closed = true;
        assert.equal(earlyAnswer.discard(a), false);
        assert.equal(closed.calls.resume, 0);
        var destroyed = makeStream();
        var b = makeRequest(destroyed);
        earlyAnswer.arm(b, true);
        destroyed.destroyed = true;
        assert.equal(earlyAnswer.discard(b), false);
        assert.equal(destroyed.calls.resume, 0);
    });

    it('a stream that throws as it resumes: discard() does not throw, and does not try twice', function () {
        var stream = makeStream({ resumeThrows: true });
        var request = makeRequest(stream);
        earlyAnswer.arm(request, true);
        assert.equal(earlyAnswer.discard(request), true);
        assert.equal(earlyAnswer.discard(request), false);
        assert.equal(stream.calls.resume, 1);
    });
});

describe('07 - arm() once per request', function () {

    it('a second arm() changes nothing: one wrapper, one close', function () {
        var stream = makeStream();
        var request = makeRequest(stream);
        assert.equal(earlyAnswer.arm(request, true), true);
        var wrapped = stream.respond;
        assert.equal(earlyAnswer.arm(request, true), true);
        assert.equal(stream.respond, wrapped, 'not wrapped twice');
        assert.equal(stream.listenerCount('finish'), 1);
        stream.respond({ ':status': 403 });
        assert.equal(stream.calls.respond.length, 1);
        assert.equal(stream.calls.resume, 1);
    });
});

describe('08 - wiring in the two engine files (whole-line comments stripped)', function () {

    /**
     * Source with its whole-line `//` comments removed. Block comments are left in place: a
     * block-comment regex would also match the `/*` of code strings such as '/_gina/*' and remove
     * real code. Every needle below is a code statement no comment of these files carries.
     */
    function code(file) {
        return fs.readFileSync(path.join(FW, 'core', file), 'utf8')
            .split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');
    }
    function count(hay, needle) {
        var n = 0, i = 0;
        while ((i = hay.indexOf(needle, i)) > -1) { n++; i += needle.length; }
        return n;
    }
    var ISAAC = code('server.isaac.js');
    var SERVER = code('server.js');

    it('server.isaac.js arms every request at the top of its request listener, before any answer', function () {
        var listener = ISAAC.indexOf("server.on('request', (request, response) => {");
        var stamp = ISAAC.indexOf('request.originalUrl = request.url;', listener);
        var arm = ISAAC.indexOf('_earlyAnswer.arm(request, _earlyAnswer.RUNTIME_IS_BUN);');
        var firstGina = ISAAC.indexOf("'/_gina/", listener);
        assert.ok(listener > -1 && stamp > listener && firstGina > listener, 'anchors');
        assert.equal(count(ISAAC, '_earlyAnswer.arm(request, _earlyAnswer.RUNTIME_IS_BUN);'), 1);
        assert.ok(arm > stamp && arm < firstGina, 'armed after the URL stamp and before the first /_gina/ answer');
        assert.equal(count(ISAAC, "var _earlyAnswer = require('./server.isaac.early-answer');"), 1);
    });

    it('server.isaac.js keeps its three server-sent-event streams open (keepOpen(), inline)', function () {
        assert.equal(count(ISAAC, 'request._ginaStreamKeepOpen = true;'), 3);
        assert.equal(count(ISAAC, '_earlyAnswer.keepOpen('), 0, 'the handler blocks hold no module reference');
    });

    it('core/server.js keeps a routed request open where its body read starts', function () {
        var branch = SERVER.indexOf('} else { // not a static request');
        var keep = SERVER.indexOf('earlyAnswer.keepOpen(request);', branch);
        var init = SERVER.indexOf('request.body    = ( typeof(request.body) != \'undefined\' ) ? request.body : {};', branch);
        assert.ok(branch > -1 && init > branch, 'anchors');
        assert.equal(count(SERVER, 'earlyAnswer.keepOpen(request);'), 1);
        assert.ok(keep > branch && keep < init, 'first thing in the non-static branch');
    });

    it('core/server.js discards at its parse-time stops, inside closeStreamAfterAnswer', function () {
        var a = SERVER.indexOf('var closeStreamAfterAnswer = function(request) {');
        var b = SERVER.indexOf('var parseByteSize = function(value) {', a);
        assert.ok(a > -1 && b > a, 'anchors');
        assert.equal(count(SERVER, 'earlyAnswer.discard(request);'), 1);
        var at = SERVER.indexOf('earlyAnswer.discard(request);');
        assert.ok(at > a && at < b);
        assert.ok(SERVER.slice(a, b).indexOf('if ( request._ginaStreamCloseArmed === true ) { earlyAnswer.discard(request); }') > -1,
            'guarded by the plain flag, so an unarmed request never reaches the module');
        assert.equal(count(SERVER, "var earlyAnswer     = require('./server.isaac.early-answer');"), 1);
    });

    it('core/server.js sends an armed binary static buffered, and keeps respondWithFile() otherwise', function () {
        var armed = SERVER.indexOf('if ( isBinary && earlyAnswer.isArmed(request) ) {');
        var sendfile = SERVER.indexOf('} else if (isBinary) {');
        var file = SERVER.indexOf('stream.respondWithFile(filename, header)');
        assert.equal(count(SERVER, 'if ( isBinary && earlyAnswer.isArmed(request) ) {'), 1);
        assert.ok(armed > -1 && sendfile > armed && file > sendfile, 'the buffered send comes first, sendfile in the else');
        var buffered = SERVER.slice(armed, sendfile);
        assert.ok(buffered.indexOf('stream.respond(header);') > -1 && buffered.indexOf('stream.end(buf);') > -1);
    });

    it('core/server.js discards a static answer\'s body through the request, before any answer of handleStatics', function () {
        var a = SERVER.indexOf('var handleStatics = function(staticProps, request, response, next) {');
        var b = SERVER.indexOf('var onRequest = function() {', a);
        var take = SERVER.indexOf('stream = response.stream;', a);
        assert.ok(a > -1 && b > a && take > a && take < b, 'anchors');
        assert.equal(count(SERVER, 'earlyAnswer.discardThroughRequest(request);'), 1);
        var at = SERVER.indexOf('earlyAnswer.discardThroughRequest(request);', a);
        var firstAnswer = ['throwError(', 'stream.respond(', 'stream.respondWithFile(', 'response.writeHead(', 'response.end('].reduce(function (min, n) {
            var i = SERVER.indexOf(n, take);
            return ( i > -1 && i < min ) ? i : min;
        }, b);
        assert.ok(firstAnswer < b, 'handleStatics answers after the stream is taken');
        assert.ok(at > take && at < firstAnswer, 'right after the stream is taken, before the first answer');
    });
});

describe('09 - discardThroughRequest() at a static answer (core/server.js handleStatics)', function () {

    /** A compatibility-request stand-in that records its own resume() calls. */
    function makeCompatRequest(stream, opts) {
        var o = opts || {};
        var request = makeRequest(stream);
        request.calls = { resume: 0 };
        request.resume = function () {
            request.calls.resume++;
            if ( o.resumeThrows ) { throw new Error('request resume failed'); }
            return request;
        };
        return request;
    }

    it('an armed request: the body is discarded through the request, and the stream keeps its readers', function () {
        var stream = makeStream();
        var request = makeCompatRequest(stream);
        earlyAnswer.arm(request, true);
        assert.equal(earlyAnswer.discardThroughRequest(request), true);
        assert.equal(request.calls.resume, 1);
        assert.equal(request._ginaBodyDiscarded, true);
        assert.equal(stream.listenerCount('data'), 1, 'the compatibility reader stays on the stream');
        assert.equal(stream.calls.resume, 0, 'the stream itself is not resumed');
    });

    it('the static answer that follows: the hook discards nothing more, and the stream still closes at finish', function () {
        var stream = makeStream();
        var request = makeCompatRequest(stream);
        earlyAnswer.arm(request, true);
        earlyAnswer.discardThroughRequest(request);
        stream.respond({ ':status': 200 });
        assert.equal(stream.calls.respond.length, 1);
        assert.equal(stream.listenerCount('data'), 1);
        assert.equal(stream.calls.resume, 0);
        stream.emit('finish');
        assert.deepEqual(stream.calls.close, [NO_ERROR]);
    });

    it('once per request: a second call, or discard() after it, does nothing', function () {
        var stream = makeStream();
        var request = makeCompatRequest(stream);
        earlyAnswer.arm(request, true);
        earlyAnswer.discardThroughRequest(request);
        assert.equal(earlyAnswer.discardThroughRequest(request), false);
        assert.equal(earlyAnswer.discard(request), false);
        assert.equal(request.calls.resume, 1);
        assert.equal(stream.calls.resume, 0);
        assert.equal(stream.listenerCount('data'), 1);
    });

    it('a request that was never armed (Node.js, HTTP/1.1, a GET without a body): nothing is done', function () {
        var stream = makeStream();
        var request = makeCompatRequest(stream);
        assert.equal(earlyAnswer.discardThroughRequest(request), false);
        assert.equal(earlyAnswer.discardThroughRequest(undefined), false);
        assert.equal(earlyAnswer.discardThroughRequest({}), false);
        assert.equal(request.calls.resume, 0);
        assert.equal(request._ginaBodyDiscarded, undefined);
        var get = makeStream({ endAfterHeaders: true });
        var g = makeCompatRequest(get);
        earlyAnswer.arm(g, true);
        assert.equal(earlyAnswer.discardThroughRequest(g), false);
        assert.equal(g.calls.resume, 0);
    });

    it('a request that throws as it resumes: no throw, and no second try', function () {
        var stream = makeStream();
        var request = makeCompatRequest(stream, { resumeThrows: true });
        earlyAnswer.arm(request, true);
        assert.equal(earlyAnswer.discardThroughRequest(request), true);
        assert.equal(earlyAnswer.discardThroughRequest(request), false);
        assert.equal(request.calls.resume, 1);
    });
});
