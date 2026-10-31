/**
 * #B1062 — stopping the upload of a multipart request that will not reach its action.
 *
 * The multipart branch of core/server.js gained one shared stop, abortMultipart(), reached from the
 * part stream's 'error' listener, from the parser's 'error' listener, from the request's 'close' and
 * from a byte counter that applies `upload.maxFieldsSize` whatever the body's framing.
 *
 * 01  source pins (comment-stripped): where each piece sits, and what stays verbatim.
 * 02  premises on the REAL parser: what the design rides on, in the runtime that runs this file (the
 *     unit suite also runs under Bun).
 * 03  abortMultipart(), extracted from the source and run on real write streams and files.
 *
 * Seam: B1062_SERVER_SRC=<path to a core/server.js> reads THAT file (red-first on the file before this
 * change: the 01 and 03 arms fail, the premises do not depend on it).
 *
 * The booted-bundle arms: test/integration/container-boot-multipart-abort-b1062.test.js.
 */
var { describe, it, before, after } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');
var os     = require('os');
var stream = require('stream');
var Busboy = require('@rhinostone/busboy');

var FW         = require('../fw');
var SERVER_SRC = process.env.B1062_SERVER_SRC || path.join(FW, 'core/server.js');
var LF         = '\n';

var BOUNDARY = '----b1062unit';
var HEADERS  = { 'content-type': 'multipart/form-data; boundary=' + BOUNDARY };

function stripLineComments(src) {
    return src.split(LF).filter(function (l) { return l.trim().indexOf('//') !== 0; }).join(LF);
}
function countOf(text, needle) { return text.split(needle).length - 1; }
function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function fileHead(filename) {
    return '--' + BOUNDARY + '\r\nContent-Disposition: form-data; name="f"; filename="' + filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n';
}

// ─── 01 — source pins ─────────────────────────────────────────────────────────
describe('01 - #B1062 source pins (comment-stripped)', function () {
    var active;
    before(function () { active = stripLineComments(fs.readFileSync(SERVER_SRC, 'utf8')); });

    /** The body of the 'file' listener, up to the listener that follows it. */
    function fileListener() {
        var a = active.indexOf("busboy.on('file', function(fieldname, file, info) {");
        var b = active.indexOf('var resumeAfterMultipart', a);
        assert.ok(a > -1 && b > a, "[instrument] the 'file' listener is located");
        return active.slice(a, b);
    }

    it("01.1  the part stream's listener comes first in the 'file' listener, ahead of every refusal", function () {
        var body = fileListener();
        var listener = body.indexOf("file.on('error', guardMultipartListener(function onPartStreamError() {");
        assert.ok(listener > -1, 'the listener is registered through the guard');
        ['too many upload fields', 'is not a configured upload group', 'is not an allowed extension', 'multiple uploads not allowed', 'is not creatable', 'simulateWriteError'].forEach(function (refusal) {
            var at = body.indexOf(refusal);
            assert.ok(at > -1, '[instrument] ' + refusal + ' is found in the listener');
            assert.ok(listener < at, 'the listener comes before: ' + refusal);
        });
        assert.equal(body.slice(0, listener).indexOf('return'), -1, 'nothing returns ahead of the listener');
    });

    it('01.2  nothing is staged once the upload has stopped: the gate sits ahead of the write stream', function () {
        var body = fileListener();
        var gate = body.indexOf('if ( multipartAborted ) {');
        var cws  = body.indexOf('fs.createWriteStream(');
        assert.ok(gate > body.indexOf('onPartStreamError'), 'the gate follows the listener');
        assert.ok(gate > -1 && cws > gate, 'the gate precedes the write stream');
    });

    it('01.3  abortMultipart stops the request feeding the parser, then the write streams, once', function () {
        assert.equal(countOf(active, 'var abortMultipart = function abortMultipart() {'), 1, 'declared once');
        var a = active.indexOf('var abortMultipart = function abortMultipart() {');
        var body = active.slice(a, active.indexOf("busboy.on('error', function onBusboyError", a));
        var order = ['if ( multipartAborted ) {', 'multipartAborted = true;', 'request.unpipe(busboy);', 'writeStream.destroy();'];
        var last = -1;
        order.forEach(function (step) {
            var at = body.indexOf(step);
            assert.ok(at > last, 'in order: ' + step);
            last = at;
        });
        assert.equal(body.indexOf('busboy.destroy('), -1, 'the parser is not destroyed: that would report an error for a stop that is not a parse failure');
    });

    it('01.4  onBusboyError stops the upload on a failed parse, and still answers 400', function () {
        var a = active.indexOf("busboy.on('error', function onBusboyError");
        var body = active.slice(a, active.indexOf("busboy.on('finish'", a));
        var log  = body.indexOf('[ onParseError ]');
        var stop = body.indexOf('abortMultipart();');
        var say  = body.indexOf("throwError(response, 400, 'Malformed multipart/form-data request', next);");
        assert.ok(log > -1 && log < stop && stop < say, 'the upload stops ahead of the answer');
    });



    it('01.7  the two lines five suites pin stay as they were', function () {
        assert.match(active, /delete busboy\.on;\s*request\.pipe\(busboy\);/);
        assert.equal(countOf(active, 'request.pipe(busboy)'), 1);
    });

    it("01.8  throwError's JSON branch does not write to an HTTP/2 stream that has closed", function () {
        var send = active.indexOf('var __ginaSendErrJSON = function(errBody) {');
        assert.ok(send > -1, '[instrument] the JSON send is located');
        var ahead = active.slice(send - 200, send);
        assert.ok(ahead.indexOf('if (stream.destroyed || stream.closed) { return; }') > -1, 'the guard precedes the send');
    });

});

// ─── 02 — premises on the real parser ─────────────────────────────────────────
describe('02 - #B1062 premises on the real parser', function () {

    function drive(chunks, onEvent) {
        var seen = { partError: null, parserError: null, files: [], order: [], finish: false };
        var bb = Busboy({ headers: HEADERS, defParamCharset: 'utf8' });
        bb.on('file', function (name, file, info) {
            seen.files.push(info.filename);
            seen.order.push('file:' + info.filename);
            file.on('error', function (e) { seen.partError = e; seen.order.push('partError'); });
            if (onEvent) { onEvent('file', bb, file); }
            file.resume();
        });
        bb.on('error', function (e) { seen.parserError = e; seen.order.push('parserError'); if (onEvent) { onEvent('error', bb, null); } });
        bb.on('finish', function () { seen.finish = true; seen.order.push('finish'); });
        chunks.forEach(function (c) { bb.write(c); });
        return { bb: bb, seen: seen };
    }

    it('02.1  a body ending inside a file part errors the part stream and the parser, and never finishes', async function () {
        var d = drive([Buffer.from(fileHead('x.bin') + 'partial')]);
        d.bb.end();
        await sleep(30);
        assert.ok(d.seen.partError, 'the part stream got an error');
        assert.ok(d.seen.parserError, 'the parser got an error');
        assert.equal(d.seen.finish, false);
    });

    it('02.2  CONTROL — a complete body errors neither, and finishes', async function () {
        var d = drive([Buffer.from(fileHead('x.bin') + 'whole\r\n--' + BOUNDARY + '--\r\n')]);
        d.bb.end();
        await sleep(30);
        assert.equal(d.seen.partError, null);
        assert.equal(d.seen.parserError, null);
        assert.equal(d.seen.finish, true);
    });

    it('02.3  a parser no longer fed, with a part stream open, stays silent: no finish and no error', async function () {
        var src = new stream.PassThrough();
        var seen = { partError: null, parserError: null, finish: false };
        var bb = Busboy({ headers: HEADERS, defParamCharset: 'utf8' });
        bb.on('file', function (name, file) { file.on('error', function (e) { seen.partError = e; }); file.resume(); });
        bb.on('error', function (e) { seen.parserError = e; });
        bb.on('finish', function () { seen.finish = true; });
        src.pipe(bb);
        src.write(Buffer.from(fileHead('x.bin') + 'partial'));
        await sleep(10);
        src.unpipe(bb);
        src.end();
        await sleep(30);
        assert.deepEqual(seen, { partError: null, parserError: null, finish: false });
    });

    it("02.4  a malformed part header is reported without stopping the parser: the rest of the chunk still reaches 'file'", async function () {
        var body = fileHead('a.bin') + 'aa\r\n--' + BOUNDARY + '\r\nBad Header Line\r\n\r\nxx\r\n' + fileHead('after.bin') + 'bb\r\n--' + BOUNDARY + '--\r\n';
        var d = drive([Buffer.from(body)]);
        await sleep(30);
        var at = d.seen.order.indexOf('parserError');
        var late = d.seen.order.indexOf('file:after.bin');
        assert.ok(at > -1 && late > at, "'file' fires after the error, for the rest of the same chunk: " + d.seen.order.join(','));
    });
});

// ─── 03 — abortMultipart, extracted from the source ───────────────────────────
describe('03 - #B1062 abortMultipart (extracted from core/server.js), on real streams and files', function () {
    var DIR;

    function load(request, busboy, writeStreams, fsStub, log) {
        var raw = fs.readFileSync(SERVER_SRC, 'utf8');
        var a = raw.indexOf('var multipartAborted = false;');
        var b = raw.indexOf('// #B97 — a malformed / empty / non-multipart body', a);
        assert.ok(a > -1 && b > a, '[instrument] abortMultipart must be found');
        return new Function('request', 'busboy', 'writeStreams', 'fs', 'console',
            raw.slice(a, b) + LF + 'return { abort: abortMultipart, state: function () { return { aborted: multipartAborted }; } };'
        )(request, busboy, writeStreams, fsStub || fs, Object.assign({ debug: function () {}, error: function () {} }, log || {}));
    }

    function parser() {
        var calls = { unpipe: 0 };
        return {
            calls: calls,
            request: { unpipe: function (d) { ++calls.unpipe; calls.unpipeArg = d; } },
            busboy: {}
        };
    }

    function tmp(name) { return path.join(DIR, name + '.part'); }

    before(function () { DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gina-b1062-unit-')); });
    after(function () { fs.rmSync(DIR, { recursive: true, force: true }); });

    it('03.1  it runs once: the request stops feeding the parser', function () {
        var p = parser();
        var m = load(p.request, p.busboy, []);
        m.abort();
        m.abort();
        assert.equal(p.calls.unpipe, 1);
        assert.equal(p.calls.unpipeArg, p.busboy);
        assert.equal(m.state().aborted, true);
    });

    it('03.2  a stream writing, a stream still opening and a stream already closed: each closes and no file stays', async function () {
        var writing = fs.createWriteStream(tmp('writing'));
        await new Promise(function (r) { writing.write(Buffer.alloc(1024, 65), r); });
        var closed = fs.createWriteStream(tmp('closed'));
        closed.write(Buffer.alloc(16, 66));
        await new Promise(function (r) { closed.end(); closed.on('close', r); });
        assert.equal(fs.existsSync(tmp('closed')), true, '[instrument] the closed stream left its file');
        var opening = fs.createWriteStream(tmp('opening'));

        var p = parser();
        load(p.request, p.busboy, [writing, closed, opening]).abort();

        await Promise.all([writing, opening].map(function (s) {
            return new Promise(function (r) { if (s.closed) { r(); } else { s.on('close', r); } });
        }));
        await sleep(50);
        assert.equal(writing.destroyed, true);
        assert.equal(opening.destroyed, true);
        ['writing', 'closed', 'opening'].forEach(function (n) {
            assert.equal(fs.existsSync(tmp(n)), false, n + ' must be gone');
        });
    });

    it('03.3  a destroyed stream emits no \'finish\', so nothing that counts them can resume', async function () {
        var finished = 0;
        var ws = fs.createWriteStream(tmp('nofinish'));
        ws.on('finish', function () { ++finished; });
        await new Promise(function (r) { ws.write(Buffer.alloc(8, 67), r); });
        var p = parser();
        load(p.request, p.busboy, [ws]).abort();
        await new Promise(function (r) { ws.on('close', r); });
        await sleep(30);
        assert.equal(finished, 0);
    });

    it('03.4  removing a file that is gone is silent; another failure is logged and does not throw', async function () {
        var logged = [], asked = [];
        var stubFs = { unlink: function (p, cb) { asked.push(p); var err = new Error('x'); err.code = /eacces/.test(p) ? 'EACCES' : 'ENOENT'; cb(err); } };
        var fake = function (name) {
            var s = new stream.Writable({ write: function (c, e, cb) { cb(); } });
            s.path = name;
            return s;
        };
        var p = parser();
        load(p.request, p.busboy, [fake('gone'), fake('eacces')], stubFs, { error: function () { logged.push(Array.prototype.slice.call(arguments)); } }).abort();
        await sleep(30);
        assert.equal(asked.filter(function (n) { return n === 'gone'; }).length, 2, '[instrument] the file that is gone was asked for, now and at close');
        assert.ok(logged.length > 0, 'the failure is logged');
        logged.forEach(function (l) {
            assert.equal(l[0], '[ busboy ] [ onStagedFileRemoveError ]');
            assert.equal(l[1].code, 'EACCES');
        });
    });
});
