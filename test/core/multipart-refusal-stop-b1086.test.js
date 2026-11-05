/**
 * #B1086 — stopRefusedMultipart(): a multipart request that gina refuses while it parses the body stops its
 * upload, and its HTTP/2 stream closes once the answer has gone out.
 *
 * 01  source pins (comment-stripped): the stop is declared once, after abortMultipart and ahead of the
 *     parser's 'error' listener, and runs abortMultipart(), request.pause(), then closeStreamAfterAnswer(request); each of the
 *     nine refusals the busboy listeners answer is followed by it — in the 'file' listener the 400s for too
 *     many files, an unconfigured group, a disallowed extension and a second file in a single-file group,
 *     the 500 of an upload directory that cannot be created; the write stream's 500; the 400s of the two
 *     text-field caps; the guard's 500 — and nothing else calls it.
 * 02  the stop, extracted from the source and run on stand-ins: the order (abort, hold, close), the request it holds and closes, and that
 *     it answers nothing.
 *
 * Seam: B1086_SERVER_SRC=<path to a core/server.js> reads THAT file (red-first on the file before this
 * change: every 01 arm fails and the 02 arms are cancelled, their before() finding no stop).
 *
 * The booted-bundle arms: test/integration/container-boot-h2-upload-refusal-b1086.test.js.
 */
var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW         = require('../fw');
var SERVER_SRC = process.env.B1086_SERVER_SRC || path.join(FW, 'core/server.js');
var LF         = '\n';
var DECL       = 'var stopRefusedMultipart = function stopRefusedMultipart() {';
var CALL       = 'stopRefusedMultipart();';

function stripLineComments(src) {
    return src.split(LF).filter(function (l) { return l.trim().indexOf('//') !== 0; }).join(LF);
}
function countOf(text, needle) { return text.split(needle).length - 1; }

// The nine refusals, each by a fragment of its answer's line found once in the source; `after` names the
// line that sits between the answer and the stop, when there is one.
var REFUSALS = [
    { label: "the 'file' listener's 400, too many files",             answer: "throwError(response, 400, 'too many upload fields (max '+ maxFields" },
    { label: "the 'file' listener's 400, an unconfigured group",       answer: "is not a configured upload group. See the `upload.groups` definition in settings.json.');" },
    { label: "the 'file' listener's 400, a disallowed extension",      answer: "is not an allowed extension. See `'+ escapeLogControlChars(fileGroup) +'` upload group definition.');" },
    { label: "the 'file' listener's 400, a second file",               answer: "throwError(response, 400, 'multiple uploads not allowed. See `'+ fileGroup +'` upload group definition.');" },
    { label: "the 'file' listener's 500, an uncreatable directory",    answer: "is not creatable ('+ fileUploadDir +')\\n' + mkdirErr, next);" },
    { label: "the write stream's 500",                                answer: "throwError(response, 500, 'Internal server error\\n' + err, next);", after: 'this.close();' },
    { label: "the text field's 400, past maxTextFieldSize",            answer: "throwError(response, 400, 'multipart text field `'+ escapeLogControlChars(name)" },
    { label: "the text fields' 400, past maxTextFields",               answer: "throwError(response, 400, 'too many multipart text fields (max '+ maxTextFields" },
    { label: "the guard's 500",                                       answer: "throwError(response, 500, 'Could not evaluate ' + request.method + ' request data.\\n'" }
];

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('01 - #B1086 source pins (comment-stripped)', function () {
    var lines;
    before(function () { lines = stripLineComments(fs.readFileSync(SERVER_SRC, 'utf8')).split(LF); });

    function lineOf(fragment) {
        var hits = [];
        lines.forEach(function (l, i) { if (l.indexOf(fragment) > -1) { hits.push(i); } });
        assert.equal(hits.length, 1, '[instrument] found once: ' + fragment);
        return hits[0];
    }

    it('01.1  the stop is declared once, after abortMultipart and ahead of the parser\'s \'error\' listener, and runs abortMultipart(), then request.pause(), then closeStreamAfterAnswer(request)', function () {
        var text = lines.join(LF);
        assert.equal(countOf(text, DECL), 1, 'declared once');
        var at = text.indexOf(DECL);
        assert.ok(text.indexOf('var abortMultipart = function abortMultipart() {') < at, 'after abortMultipart');
        assert.ok(at < text.indexOf("busboy.on('error', function onBusboyError(err) {"), "ahead of the parser's 'error' listener");
        var body = text.slice(at + DECL.length, text.indexOf(LF + lines[lineOf(DECL)].match(/^\s*/)[0] + '};', at));
        assert.deepEqual(body.split(LF).map(function (l) { return l.trim(); }).filter(Boolean), ['abortMultipart();', 'request.pause();', 'closeStreamAfterAnswer(request);']);
    });

    REFUSALS.forEach(function (r, i) {
        it('01.' + (i + 2) + '  ' + r.label + ': the stop follows the answer', function () {
            var at = lineOf(r.answer);
            if (r.after) {
                assert.equal(lines[at + 1].trim(), r.after, '[instrument] the line after the answer: ' + r.after);
                at += 1;
            }
            assert.equal(lines[at + 1].trim(), CALL, 'the line after: ' + JSON.stringify(lines[at + 1]));
        });
    });

    it('01.11  nothing else calls the stop: nine calls, each a statement line of its own', function () {
        // its JSDoc's @example line (` * stopRefusedMultipart();`) is not a call: count statement lines only
        assert.equal(lines.filter(function (l) { return l.trim() === CALL; }).length, REFUSALS.length);
        assert.equal(countOf(lines.filter(function (l) { return !/^\s*\*/.test(l); }).join(LF), CALL), REFUSALS.length, 'and no other code line holds it');
    });
});

// ─── 02 — the stop, on stand-ins ──────────────────────────────────────────────
describe('02 - #B1086 stopRefusedMultipart (extracted from core/server.js), on stand-ins', function () {
    var make;
    before(function () {
        var raw = fs.readFileSync(SERVER_SRC, 'utf8');
        var a = raw.indexOf(DECL);
        assert.ok(a > -1, '[instrument] the stop must be found');
        var indent = raw.slice(raw.lastIndexOf(LF, a) + 1, a);
        var b = raw.indexOf(LF + indent + '};', a);
        assert.ok(b > a, '[instrument] its end must be found');
        var text = raw.slice(a, b + LF.length + indent.length + 2);
        make = function (calls, request) {
            return new Function('abortMultipart', 'closeStreamAfterAnswer', 'request', text + LF + 'return stopRefusedMultipart;')(
                function () { calls.push('abort'); },
                function (rq) { calls.push(rq === request ? 'close(request)' : 'close(another)'); return true; },
                request);
        };
    });

    it('02.1  the upload stops first, then the request is held, then its stream closes once its answer has gone out', function () {
        var calls = [], request = { pause: function () { calls.push('pause'); } };
        var ret = make(calls, request)();
        assert.deepEqual(calls, ['abort', 'pause', 'close(request)']);
        assert.equal(ret, undefined, 'it answers nothing and returns nothing');
    });

    it('02.2  called twice (two refusals on one request): each call is passed on; abortMultipart and closeStreamAfterAnswer are the ones that run once', function () {
        var calls = [], request = { pause: function () { calls.push('pause'); } };
        var stop = make(calls, request);
        stop(); stop();
        assert.deepEqual(calls, ['abort', 'pause', 'close(request)', 'abort', 'pause', 'close(request)']);
    });
});
