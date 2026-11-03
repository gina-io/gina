/**
 * #B1071 — closeStreamAfterAnswer(request): closing the HTTP/2 stream of a request whose body is no
 * longer read, once its answer has gone out.
 *
 * 01  source pins (comment-stripped): the helper sits at module scope, four stops call it (the 431
 *     before the body is read, the 400 of a failed parse, the 431 by the byte counter, the 413 past
 *     server.maxBodySize) and the two request.destroy() lines stay.
 * 02  the helper, extracted from the source and run on stand-in streams: when it closes, with which
 *     code, and when it does nothing.
 *
 * Seam: B1071_SERVER_SRC=<path to a core/server.js> reads THAT file (red-first on the file before this
 * change: 01.1 and 01.2 fail and the 02 arms are cancelled, their before() finding no helper; 01.3
 * holds on both).
 *
 * The booted-bundle arms: test/integration/container-boot-h2-stream-close-b1071.test.js.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var EventEmitter = require('events');

var FW         = require('../fw');
var SERVER_SRC = process.env.B1071_SERVER_SRC || path.join(FW, 'core/server.js');
var LF         = '\n';
var NO_ERROR   = require('http2').constants.NGHTTP2_NO_ERROR;

function stripLineComments(src) {
    return src.split(LF).filter(function (l) { return l.trim().indexOf('//') !== 0; }).join(LF);
}
function countOf(text, needle) { return text.split(needle).length - 1; }

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('01 - #B1071 source pins (comment-stripped)', function () {
    var active;
    before(function () { active = stripLineComments(fs.readFileSync(SERVER_SRC, 'utf8')); });

    /** The text between two anchors, each found once, the second after the first. */
    function region(from, to) {
        var a = active.indexOf(from);
        var b = active.indexOf(to, a);
        assert.ok(a > -1 && b > a, '[instrument] the region is located: ' + from);
        assert.equal(countOf(active, from), 1, '[instrument] its first anchor is unique: ' + from);
        return active.slice(a, b);
    }

    it('01.1  the helper is declared once, at module scope, ahead of parseByteSize', function () {
        var decl = LF + 'var closeStreamAfterAnswer = function(request) {';
        assert.equal(countOf(active, decl), 1);
        assert.ok(active.indexOf(decl) < active.indexOf(LF + 'var parseByteSize = function(value) {'));
    });

    it('01.2  four stops call it, each after its answer', function () {
        assert.equal(countOf(active, 'closeStreamAfterAnswer(request);'), 4);

        // the 431 sent before the body is read: answer, close, then return what the answer returned
        assert.match(active, /var answered = throwError\(response, 431, 'Attachment exceeded maximum file size \[ '\+ opt\.maxFieldsSize \+' \]'\);\s*closeStreamAfterAnswer\(request\);\s*return answered;/);

        // the 400 of a failed parse: after the guarded answer
        var parse = region("busboy.on('error', function onBusboyError(err) {", "busboy.on('finish'");
        var at400 = parse.indexOf("throwError(response, 400, 'Malformed multipart/form-data request', next);");
        assert.ok(at400 > -1 && parse.indexOf('closeStreamAfterAnswer(request);') > at400, 'the 400: the close follows the answer');

        // the 431 by the byte counter: after the guarded answer, before the destroy
        var counter = region("request.on('data', guardMultipartListener(function onMultipartChunk(chunk) {", 'delete busboy.on;');
        var at431 = counter.indexOf("throwError(response, 431, 'Attachment exceeded maximum file size [ '+ opt.maxFieldsSize +' ]');");
        var c431 = counter.indexOf('closeStreamAfterAnswer(request);');
        assert.ok(at431 > -1 && c431 > at431 && counter.indexOf('try { request.destroy() } catch (destroyErr) {}') > c431, 'the 431: answer, close, destroy');

        // the 413 past server.maxBodySize: after the answer, before the destroy
        var cap = region("throwError(response, 413, 'Request body exceeded maximum size [ '+ _bodySrv.maxBodySize +' ]', next);", "request.on('end', function onEnd() {");
        var c413 = cap.indexOf('closeStreamAfterAnswer(request);');
        assert.ok(c413 > -1 && cap.indexOf('try { request.destroy() } catch (destroyErr) {}') > c413, 'the 413: answer, close, destroy');
    });

    it('01.3  the two request.destroy() lines stay as they were', function () {
        assert.equal(countOf(active, 'try { request.destroy() } catch (destroyErr) {}'), 2);
    });
});

// ─── 02 — the helper, on stand-in streams ─────────────────────────────────────
describe('02 - #B1071 closeStreamAfterAnswer (extracted from core/server.js), on stand-in streams', function () {
    var closeStreamAfterAnswer;

    before(function () {
        var raw = fs.readFileSync(SERVER_SRC, 'utf8');
        var a = raw.indexOf('var closeStreamAfterAnswer = function(request) {');
        var b = raw.indexOf('var parseByteSize = function(value) {', a);
        assert.ok(a > -1 && b > a, '[instrument] the helper is located');
        closeStreamAfterAnswer = new Function('require', raw.slice(a, b) + LF + 'return closeStreamAfterAnswer;')(require);
    });

    /** A server stream's surface as the helper reads it: its state flags, 'finish', and close(code). */
    function standIn(state) {
        var s = new EventEmitter();
        s.writableFinished = !!state.finished;
        s.closed = !!state.closed;
        s.destroyed = !!state.destroyed;
        s.calls = [];
        s.close = function (code) { s.calls.push(code); s.closed = true; };
        return s;
    }

    it('02.1  a request with no stream (HTTP/1.1), or whose stream has no close(): false, nothing done', function () {
        assert.equal(closeStreamAfterAnswer(undefined), false);
        assert.equal(closeStreamAfterAnswer(null), false);
        assert.equal(closeStreamAfterAnswer({}), false);
        assert.equal(closeStreamAfterAnswer({ stream: null }), false);
        var noClose = new EventEmitter();
        assert.equal(closeStreamAfterAnswer({ stream: noClose }), false);
        assert.equal(noClose.listenerCount('finish'), 0, 'no listener is left on it');
    });

    it('02.2  a stream whose answer has gone out: closed at once, with NO_ERROR, once', function () {
        var s = standIn({ finished: true });
        assert.equal(closeStreamAfterAnswer({ stream: s }), true);
        assert.deepEqual(s.calls, [NO_ERROR]);
        assert.equal(NO_ERROR, 0);
        assert.equal(s.listenerCount('finish'), 0, 'nothing waits for a finish that has passed');
    });

    it("02.3  a stream still sending its answer: nothing at once, then closed with NO_ERROR at its 'finish', once", function () {
        var s = standIn({});
        assert.equal(closeStreamAfterAnswer({ stream: s }), true);
        assert.deepEqual(s.calls, [], 'not closed while the answer is going out');
        s.emit('finish');
        assert.deepEqual(s.calls, [NO_ERROR]);
        s.emit('finish');
        assert.deepEqual(s.calls, [NO_ERROR], 'a second finish closes nothing more');
    });

    it("02.4  a stream that closes, or is destroyed, before its answer has gone out: nothing at its 'finish'", function () {
        var closed = standIn({});
        closeStreamAfterAnswer({ stream: closed });
        closed.closed = true;
        closed.emit('finish');
        assert.deepEqual(closed.calls, []);

        var destroyed = standIn({});
        closeStreamAfterAnswer({ stream: destroyed });
        destroyed.destroyed = true;
        destroyed.emit('finish');
        assert.deepEqual(destroyed.calls, []);
    });

    it('02.5  a stream already closed, or destroyed, when its answer had gone out: not closed again', function () {
        var closed = standIn({ finished: true, closed: true });
        assert.equal(closeStreamAfterAnswer({ stream: closed }), true);
        assert.deepEqual(closed.calls, []);

        var destroyed = standIn({ finished: true, destroyed: true });
        assert.equal(closeStreamAfterAnswer({ stream: destroyed }), true);
        assert.deepEqual(destroyed.calls, []);
    });

    it('02.6  called twice for one request (two stops on the same answer): one close', function () {
        var s = standIn({});
        closeStreamAfterAnswer({ stream: s });
        closeStreamAfterAnswer({ stream: s });
        s.emit('finish');
        assert.deepEqual(s.calls, [NO_ERROR]);
    });
});
