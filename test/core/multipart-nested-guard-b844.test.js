/**
 * #B844 — the multipart guard: the callbacks nested in a file part, its log lines, and
 * busboy's own `on`.
 *
 * #B843 wrapped the three Busboy listeners of the multipart branch (core/server.js) so that
 * an exception raised in one of them is answered. The callbacks those listeners only
 * REGISTER — the write stream's 'error' and 'finish' handlers, the close callback, the file
 * stream's 'end' handler and the cleanup timer's callback — ran outside the wrapper, and an
 * exception raised in one of them ended the bundle. #B844 wraps each where it is registered,
 * logs the stack when the guard does not answer, writes the exception message with its
 * control characters as visible escapes (#B830), and removes the `on` override before the
 * request is piped, so that what the stream plumbing registers is not wrapped.
 *
 * 01  source pins (comment-stripped): each registration carries the wrapper, no unwrapped
 *     form is left, and the override is removed between the end-of-body registration and
 *     the pipe.
 * 02  the guard, extracted from the source and run with stubs: the answering branch, the
 *     non-answering branches, the escaped message, pass-through.
 * 03  the override, extracted from the source and applied to a real Busboy instance: with the
 *     removal the pipe's own listener is removable again; without it (the control) it is not.
 *
 * The booted-bundle arms: test/integration/container-boot-multipart-nested-throw-b844.test.js.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var stream = require('stream');
var EventEmitter = require('events');

var FW         = require('../fw');
var SERVER_SRC = path.join(FW, 'core/server.js');
var LF         = '\n';

function stripLineComments(src) {
    return src.split(LF).filter(function (l) { return l.trim().indexOf('//') !== 0; }).join(LF);
}
function countOf(text, needle) { return text.split(needle).length - 1; }

/** Text of a top-level function declaration of core/server.js, by name. */
function topLevelFunction(src, name) {
    var a = src.indexOf('function ' + name + '(');
    var b = src.indexOf(LF + '}' + LF, a);
    assert.ok(a > -1 && b > a, '[instrument] ' + name + ' must be found');
    return src.slice(a, b + 2);
}

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('01 - #B844 source pins (comment-stripped)', function () {
    var active;
    before(function () { active = stripLineComments(fs.readFileSync(SERVER_SRC, 'utf8')); });

    var WRAPPED = [
        ["writeStreams[index].on('error', guardMultipartListener(function(err) {", "writeStreams[index].on('error', function", "the write stream's 'error' handler"],
        ["writeStreams[index].on('finish', guardMultipartListener(function() {",  "writeStreams[index].on('finish', function", "the write stream's 'finish' handler"],
        ['this.close( guardMultipartListener(function onUploaded(){',              'this.close( function onUploaded',           'the close callback'],
        ["file.on('end', guardMultipartListener(function() {",                     "file.on('end', function",                   "the file stream's 'end' handler"],
        ['setTimeout(guardMultipartListener((tmpFilename) => {',                   'setTimeout((tmpFilename)',                  "the cleanup timer's callback"]
    ];

    WRAPPED.forEach(function (w, i) {
        it('01.' + (i + 1) + '  ' + w[2] + ' is registered through the wrapper, once, and no unwrapped form is left', function () {
            assert.equal(countOf(active, w[0]), 1, 'the wrapped registration: ' + w[0]);
            assert.equal(active.indexOf(w[1]), -1, 'no unwrapped registration: ' + w[1]);
        });
    });

    it('01.6  the `on` override is removed once, after the end-of-body registration and before the pipe', function () {
        var fin  = active.indexOf("busboy.on('finish'");
        var del  = active.indexOf('delete busboy.on;');
        var pipe = active.indexOf('request.pipe(busboy)');
        assert.ok(fin > 0 && pipe > fin, '[instrument] the registration and the pipe are located');
        assert.equal(countOf(active, 'delete busboy.on;'), 1, 'exactly one removal');
        assert.ok(del > fin && del < pipe, 'the removal sits between the last guarded registration and the pipe');
        assert.ok(active.indexOf('busboy.on = function (ev, fn) {') < fin, 'the override is installed before the registrations');
    });
});

// ─── 02 — the guard, extracted and run with stubs ─────────────────────────────
describe('02 - #B844 the guard (extracted from core/server.js)', function () {
    var guardText, helpers;

    before(function () {
        var raw = fs.readFileSync(SERVER_SRC, 'utf8');
        var a = raw.indexOf('var guardMultipartListener = function (fn) {');
        var b = raw.indexOf('// The wrap is applied by overriding busboy.on IN PLACE', a);
        assert.ok(a > -1 && b > a, '[instrument] the guard must be found');
        assert.equal(raw.indexOf('var guardMultipartListener = function (fn) {', a + 1), -1, '[instrument] the guard is declared once');
        guardText = raw.slice(a, b);
        helpers = topLevelFunction(raw, 'escapeLogControlChars') + LF + topLevelFunction(raw, 'escapeLogDetailKeepFrames');
    });

    /** Runs fn through the guard with the given request/response state; returns what was called. */
    function run(state, fn, method) {
        var calls = { error: [], throwError: [], stop: [] };
        var response = { headersSent: !!state.headersSent };
        var request  = { handled: !!state.handled, method: method || 'POST' };
        var next     = function next() {};
        var guard = new Function('response', 'request', 'throwError', 'next', 'console', 'stopRefusedMultipart',
            helpers + LF + guardText + LF + 'return guardMultipartListener;')(
            response, request,
            function (res, code, msg, nx) { calls.throwError.push({ res: res, code: code, msg: String(msg), next: nx }); },
            next,
            { error: function () { calls.error.push(Array.prototype.slice.call(arguments).map(String)); } },
            function () { calls.stop.push('stop@' + calls.throwError.length); });
        var out = { calls: calls, request: request, response: response, next: next, threw: null };
        try { out.ret = guard(fn).call({ tag: 'ctx' }, 1, 2); } catch (e) { out.threw = e; }
        return out;
    }
    /** An engine exception whose message quotes a property name holding a line feed. */
    function raiseQuotingALineFeed() { return null['a' + LF + 'FORGED']; }
    function isFrameOnly(text) { return text.split(LF).slice(1).every(function (l) { return /^\s+at\s/.test(l); }); }

    it('02.1  PREMISE — the engine quotes a property name as written, line feed included', function () {
        var msg = '';
        try { raiseQuotingALineFeed(); } catch (e) { msg = e.message; }
        assert.ok(msg.indexOf('a' + LF + 'FORGED') > -1, 'the message holds the real line feed: ' + JSON.stringify(msg));
    });

    it('02.2  nothing answered yet — one 500 through throwError, the request is marked, nothing is rethrown', function () {
        var r = run({}, raiseQuotingALineFeed, 'PUT');
        assert.equal(r.threw, null, 'the guard never rethrows');
        assert.equal(r.calls.throwError.length, 1);
        assert.equal(r.calls.throwError[0].code, 500);
        assert.equal(r.calls.throwError[0].res, r.response);
        assert.equal(r.calls.throwError[0].next, r.next);
        assert.equal(r.calls.throwError[0].msg.indexOf('Could not evaluate PUT request data.' + LF), 0, r.calls.throwError[0].msg.slice(0, 80));
        assert.match(r.calls.throwError[0].msg, /\n\s+at\s/, 'the stack goes to throwError, which logs it on the pairing line');
        assert.equal(r.request.handled, true);
        assert.deepEqual(r.calls.stop, ['stop@1'], '#B1086 — the upload stops, after the answer');
    });

    it('02.3  the message line is written with visible escapes: no argument holds a real line feed', function () {
        var r = run({}, raiseQuotingALineFeed);
        assert.equal(r.calls.error.length, 1, 'one line on the answering branch');
        assert.equal(r.calls.error[0].length, 1, 'one argument: the escaped line');
        assert.equal(r.calls.error[0][0].indexOf('[ busboy ] [ onListenerThrow ] '), 0);
        assert.equal(r.calls.error[0][0].indexOf(LF), -1, JSON.stringify(r.calls.error[0][0]));
        assert.ok(r.calls.error[0][0].indexOf('a\\nFORGED') > -1, 'the line feed is shown as backslash + n: ' + JSON.stringify(r.calls.error[0][0]));
    });

    [['02.4', { headersSent: true }, 'the response is already sent'],
     ['02.5', { handled: true },     'the request is already handed off']].forEach(function (c) {
        it(c[0] + '  ' + c[2] + ' — no second answer, and the stack is logged with only its frame breaks', function () {
            var r = run(c[1], raiseQuotingALineFeed);
            assert.equal(r.threw, null);
            assert.equal(r.calls.throwError.length, 0, 'nothing answers twice');
            assert.equal(r.calls.error.length, 2, 'the message line, then the stack line');
            var line = r.calls.error[1][0];
            assert.equal(line.indexOf('[ busboy ] [ onListenerThrow ] not answered: '), 0, line.slice(0, 80));
            assert.match(line, /\n\s+at\s/, 'the stack is there');
            assert.ok(isFrameOnly(line), 'a real line break only before a frame line: ' + JSON.stringify(line.slice(0, 200)));
            assert.ok(line.indexOf('a\\nFORGED') > -1, 'the quoted line feed is a visible escape there too');
            assert.deepEqual(r.calls.stop, [], '#B1086 — nothing stops a request already answered or handed off');
        });
    });

    it('02.6  a thrown value that is not an Error is answered too', function () {
        var r = run({}, function () { throw 'plain text'; });
        assert.equal(r.threw, null);
        assert.equal(r.calls.throwError.length, 1);
        assert.ok(r.calls.throwError[0].msg.indexOf('plain text') > -1);
        assert.ok(r.calls.error[0].join(' ').indexOf('plain text') > -1, 'and it is logged');
        assert.deepEqual(r.calls.stop, ['stop@1'], '#B1086 — the upload stops, after the answer');
    });

    it('02.7  `this`, the arguments and the return value pass through, and nothing is logged', function () {
        var r = run({}, function (x, y) { return [this.tag, x, y].join(','); });
        assert.equal(r.ret, 'ctx,1,2');
        assert.equal(r.calls.error.length, 0);
        assert.equal(r.calls.throwError.length, 0);
        assert.equal(r.request.handled, false);
        assert.deepEqual(r.calls.stop, [], '#B1086 — nothing throws, nothing stops');
    });
});

// ─── 03 — the override and its removal, on a real Busboy instance ─────────────
describe('03 - #B844 the `on` override is removed before the pipe (review F3)', function () {
    var overrideText;

    before(function () {
        var raw = fs.readFileSync(SERVER_SRC, 'utf8');
        var a = raw.indexOf('var _realBusboyOn = busboy.on.bind(busboy);');
        var b = raw.indexOf("busboy.on('field', function onMultipartField", a);
        assert.ok(a > -1 && b > a, '[instrument] the override must be found');
        overrideText = raw.slice(a, b);
    });

    /** The source's override on a fresh Busboy, three own listeners, then a pipe and an unpipe. */
    function drive(removeOverride) {
        var Busboy = require('@rhinostone/busboy');
        var busboy = Busboy({ headers: { 'content-type': 'multipart/form-data; boundary=x' } });
        var wrapped = 0, ownFinish = 0;
        new Function('busboy', 'guardMultipartListener', overrideText)(busboy, function (fn) { wrapped++; return function () { return fn.apply(this, arguments); }; });
        busboy.on('field', function () {});
        busboy.on('file', function () {});
        busboy.on('finish', function () { ownFinish++; });
        if (removeOverride) { delete busboy.on; }
        var src = new stream.PassThrough();
        src.pipe(busboy);
        var afterPipe = busboy.listenerCount('finish');
        src.unpipe(busboy);
        var afterUnpipe = busboy.listenerCount('finish');
        busboy.emit('finish');
        return { wrapped: wrapped, afterPipe: afterPipe, afterUnpipe: afterUnpipe, ownFinish: ownFinish,
                 ownProperty: Object.prototype.hasOwnProperty.call(busboy, 'on'), prototypeOn: busboy.on === EventEmitter.prototype.on };
    }

    it('03.1  CONTROL — without the removal the pipe\'s own listener is wrapped and unpipe leaves it', function () {
        var r = drive(false);
        assert.equal(r.wrapped, 4, 'three own registrations plus the one pipe() makes');
        assert.equal(r.afterUnpipe, 2, 'the wrapped listener is not removed');
    });

    it('03.2  with the removal only the three own registrations are wrapped, and unpipe removes the pipe\'s listener', function () {
        var r = drive(true);
        assert.equal(r.wrapped, 3);
        assert.equal(r.ownProperty, false, 'no own `on` is left on the instance');
        assert.equal(r.prototypeOn, true, 'busboy.on is the prototype method again');
        assert.equal(r.afterPipe, 2);
        assert.equal(r.afterUnpipe, 1, 'only the guarded own listener stays');
        assert.equal(r.ownFinish, 1, 'and it still runs');
    });
});
