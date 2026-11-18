'use strict';
// #B1073 — a download name above U+00FF (a decomposed accent, a typographic apostrophe, CJK,
// emoji) reached a Content-Disposition header raw. Node refuses such a header value on
// HTTP/1.1 (ERR_INVALID_CHAR) and cuts each UTF-16 unit to its low byte on HTTP/2. Measured
// live on a booted bundle (2026-11-02, isaac, both protocols): downloadFromURL and
// downloadFromLocal answered 500 on HTTP/1.1; serveFromStorage({ download: true }) EXITED THE
// PROCESS on HTTP/1.1, because its setHeader runs inside the storage driver's callback, so the
// throw was an uncaughtException; on HTTP/2 the name came out mangled (`1J.pdf`) or missing.
//
// The fix: formatAttachmentDisposition NFC-normalises, keeps today's exact bytes for every
// name Node accepts, and otherwise emits a Latin-1 `filename` fallback plus the RFC 8187
// `filename*=UTF-8''…` parameter; it never throws. serveFromStorage's driver callbacks run
// through a guard (a throw answers 500, never exits the process). The browser parse prefers
// `filename*`.
//
// Seams (red-first without touching a shared tree, the #B473 / #B464 shape):
//   GINA_B1073_CONTROLLER — controller.js to read, extract and require (a pre-fix copy must
//                           sit beside the real file so its relative requires resolve);
//   GINA_B1073_EVENTS     — utils/events.js to extract the browser parse from;
//   GINA_B1073_DIST_MIN   — gina.min.js to pin (run before the rebuild: the dist arms go red).
// Arms marked CONTROL pin unchanged behaviour and must stay green on the pre-fix bytes.

var { describe, it, before, after } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var os       = require('node:os');
var http     = require('node:http');
var nodePath = require('node:path');
var { Readable, Writable } = require('node:stream');

var ROOT = nodePath.join(__dirname, '..', '..');
var FW   = require('../fw');

var CONTROLLER_SRC = process.env.GINA_B1073_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');
var EVENTS_SRC     = process.env.GINA_B1073_EVENTS || nodePath.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var DIST_MIN       = process.env.GINA_B1073_DIST_MIN || nodePath.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var SRC    = fs.readFileSync(CONTROLLER_SRC, 'utf8');
var EVENTS = fs.readFileSync(EVENTS_SRC, 'utf8');

function countOf(haystack, needle) {
    var c = 0, i = haystack.indexOf(needle);
    while (i > -1) { c++; i = haystack.indexOf(needle, i + needle.length); }
    return c;
}

// started-flag brace walker (the house extraction shape): both helpers carry no brace inside
// a string or regex literal
function extractFunction(src, decl) {
    var declIdx = src.indexOf(decl);
    if (declIdx === -1) { throw new Error('declaration `' + decl + '` not found'); }
    if (src.indexOf(decl, declIdx + 1) !== -1) { throw new Error('declaration `' + decl + '` is not unique'); }
    var i = declIdx, depth = 0, started = false;
    for (; i < src.length; i++) {
        if (src[i] === '{') { depth++; started = true; }
        else if (src[i] === '}') { depth--; if (started && depth === 0) { i++; break; } }
    }
    if (!started || depth !== 0) { throw new Error('brace walk did not terminate balanced'); }
    return src.slice(declIdx, i);
}

var format = new Function('return (' + extractFunction(SRC, 'function formatAttachmentDisposition(') + ');')();
var parse  = new Function('return (' + extractFunction(EVENTS, 'function getFilenameFromContentDisposition(') + ');')();

// Node's own header-value check: the instrument that threw in production
function nodeAccepts(value) {
    try { http.validateHeaderValue('content-disposition', value); return true; } catch (e) { return false; }
}

var NAMES = {
    dec   : 're\u0301sume\u0301.pdf',
    apos  : 'l\u2019offre.pdf',
    cjk   : '\u5831\u544A.pdf',
    emoji : 'doc-\uD83D\uDCC4.pdf'
};
var EXPECT = {
    dec   : 'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
    apos  : 'attachment; filename="l?offre.pdf"; filename*=UTF-8\'\'l%E2%80%99offre.pdf',
    cjk   : 'attachment; filename="??.pdf"; filename*=UTF-8\'\'%E5%A0%B1%E5%91%8A.pdf',
    emoji : 'attachment; filename="doc-??.pdf"; filename*=UTF-8\'\'doc-%F0%9F%93%84.pdf'
};


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - both extractions produced callables (real bytes, no replica)', function () {
        assert.equal(typeof format, 'function');
        assert.equal(typeof parse, 'function');
    });

    it('CONTROL - the header instrument fires: Node refuses U+2019 and accepts a Latin-1 value', function () {
        assert.equal(nodeAccepts('attachment; filename="l\u2019offre.pdf"'), false);
        assert.equal(nodeAccepts('attachment; filename="r\u00E9sum\u00E9.pdf"'), true);
    });
});


// ── 01 — an ASCII name keeps today's exact bytes (CONTROL on pre-fix); a Latin-1 name gets filename* (#B1113)

describe('01 - an ASCII name keeps the exact bytes emitted before #B1073; a Latin-1 name gets filename* (#B1113)', function () {

    var keep = {
        'proof.pdf'                 : 'attachment; filename="proof.pdf"',
        'monthly report 2026.pdf'   : 'attachment; filename="monthly report 2026.pdf"',
        'a "b".pdf'                 : 'attachment; filename="a \\"b\\".pdf"',
        'a\\b.pdf'                  : 'attachment; filename="a\\\\b.pdf"',
        'tab\there.pdf'             : 'attachment; filename="tab\there.pdf"',
        '100%.pdf'                  : 'attachment; filename="100%.pdf"',
        ''                          : 'attachment; filename=""'
    };
    Object.keys(keep).forEach(function (name) {
        it('CONTROL - ' + JSON.stringify(name), function () {
            assert.equal(format(name), keep[name]);
        });
    });

    // #B1113 — these two were CONTROLs here: their Latin-1 letters were kept as raw bytes, which
    // Chromium and WebKit decode as UTF-8 (U+FFFD in the saved name); they now get an all-ASCII
    // fallback (accents dropped) and filename*
    var latin1 = {
        'r\u00E9sum\u00E9.pdf'      : 'attachment; filename="resume.pdf"; filename*=UTF-8\'\'r%C3%A9sum%C3%A9.pdf',
        'na\u00EFve \u00A9 \u00F1.pdf' : 'attachment; filename="naive ? n.pdf"; filename*=UTF-8\'\'na%C3%AFve%20%C2%A9%20%C3%B1.pdf'
    };
    Object.keys(latin1).forEach(function (name) {
        it(JSON.stringify(name) + ' gets an all-ASCII fallback and filename* (#B1113)', function () {
            assert.equal(format(name), latin1[name]);
        });
    });

    it('CONTROL - a non-string is coerced, never thrown on', function () {
        assert.equal(format(42), 'attachment; filename="42"');
    });
});


// ── 02 — the four reproduced shapes ───────────────────────────────────────────

describe('02 - the reproduced names now give a header Node accepts, naming the file exactly', function () {

    Object.keys(NAMES).forEach(function (k) {
        it(k + ': exact value', function () {
            assert.equal(format(NAMES[k]), EXPECT[k]);
        });
        it(k + ': Node accepts it (the pre-fix value threw ERR_INVALID_CHAR)', function () {
            assert.equal(nodeAccepts(format(NAMES[k])), true);
        });
    });

    it('NFC: the decomposed name yields the same bytes as the precomposed one', function () {
        assert.equal(format(NAMES.dec), format('r\u00E9sum\u00E9.pdf'));
    });
});


// ── 03 — RFC 8187 / RFC 6266 details ──────────────────────────────────────────

describe('03 - RFC 8187 encoding and the fallback', function () {

    it("' ( ) * are percent-encoded in filename* (outside RFC 8187 attr-char)", function () {
        assert.equal(format('l\u2019offre (1)*.pdf'),
            'attachment; filename="l?offre (1)*.pdf"; filename*=UTF-8\'\'l%E2%80%99offre%20%281%29%2A.pdf');
    });

    it('a percent sign is encoded in filename* and kept in the fallback', function () {
        assert.equal(format('100%\u2019.pdf'),
            'attachment; filename="100%?.pdf"; filename*=UTF-8\'\'100%25%E2%80%99.pdf');
    });

    it('a quote and a backslash stay escaped in the fallback', function () {
        assert.equal(format('a "b" \u2019.pdf'),
            'attachment; filename="a \\"b\\" ?.pdf"; filename*=UTF-8\'\'a%20%22b%22%20%E2%80%99.pdf');
    });

    it('filename precedes filename* (RFC 6266 appendix D order)', function () {
        var v = format(NAMES.apos);
        assert.ok(v.indexOf('filename="') < v.indexOf('filename*='));
    });
});


// ── 04 — totality: never throws, never returns a value Node refuses ───────────

describe('04 - the formatter is total', function () {

    var odd = ['\uD83D.pdf', 'x\uDCC4.pdf', 'a\r\nb.pdf', 'nul\u0000.pdf', 'del\u007f.pdf', 'c1\u0085.pdf',
        'mix\uD83D\u2019\r.pdf', '\u0301', '\uFEFF.pdf'];

    odd.forEach(function (name) {
        // U+0085 is a C1 control Node already accepts: that arm is a CONTROL (green on pre-fix bytes)
        it((name === 'c1\u0085.pdf' ? 'CONTROL - ' : '') + 'accepted by Node: ' + JSON.stringify(name), function () {
            var v;
            assert.doesNotThrow(function () { v = format(name); });
            assert.equal(nodeAccepts(v), true, v);
        });
    });

    it('2,000 random names (every plane, lone surrogates, controls): no throw, every value accepted', function () {
        var seed = 1073;
        var rnd = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        for (var n = 0; n < 2000; n++) {
            var len = 1 + Math.floor(rnd() * 12), s = '';
            for (var j = 0; j < len; j++) {
                var r = rnd();
                if (r < 0.15) { s += String.fromCharCode(Math.floor(rnd() * 0x20)); }
                else if (r < 0.3) { s += String.fromCharCode(0xD800 + Math.floor(rnd() * 0x800)); }
                else if (r < 0.6) { s += String.fromCharCode(0x20 + Math.floor(rnd() * 0xE0)); }
                else { s += String.fromCodePoint(Math.floor(rnd() * 0x110000)); }
            }
            var v = format(s);
            assert.equal(nodeAccepts(v), true, JSON.stringify(s) + ' -> ' + v);
        }
    });
});


// ── 05 — the browser parse reads filename* ────────────────────────────────────

describe('05 - getFilenameFromContentDisposition prefers filename*', function () {

    it('UTF-8 extended value is decoded', function () {
        assert.equal(parse(EXPECT.apos), 'l\u2019offre.pdf');
    });

    it('ISO-8859-1 extended value is decoded', function () {
        assert.equal(parse("attachment; filename*=ISO-8859-1''r%E9sum%E9.pdf"), 'r\u00E9sum\u00E9.pdf');
    });

    it('a language tag between the quotes is skipped', function () {
        assert.equal(parse("attachment; filename*=UTF-8'fr'l%E2%80%99offre.pdf"), 'l\u2019offre.pdf');
    });

    it('a (non-conformant) quoted extended value is tolerated', function () {
        assert.equal(parse('attachment; filename*="UTF-8\'\'%E5%A0%B1.pdf"'), '\u5831.pdf');
    });

    it('CONTROL - malformed percent-encoding falls back to the plain parameter', function () {
        assert.equal(parse("attachment; filename=\"fallback.pdf\"; filename*=UTF-8''%E2%80.pdf"), 'fallback.pdf');
    });

    it('CONTROL - an unknown charset falls back to the plain parameter', function () {
        assert.equal(parse("attachment; filename=\"fallback.pdf\"; filename*=KOI8-R''%C1.pdf"), 'fallback.pdf');
    });

    it('CONTROL - a header without filename* parses as before', function () {
        assert.equal(parse('attachment; filename="monthly report.pdf"'), 'monthly report.pdf');
    });
});


// ── 06 — round trip: server emission → browser parse ──────────────────────────

describe('06 - every name survives emit -> parse (both shipped sides)', function () {

    var names = [NAMES.dec, NAMES.apos, NAMES.cjk, NAMES.emoji, 'l\u2019offre (1)*.pdf', '100%\u2019.pdf',
        'a "b" \u2019.pdf', 'proof.pdf', 'r\u00E9sum\u00E9.pdf', 'a\\b \u5831.pdf'];
    names.forEach(function (name) {
        // a name Node already accepted round-trips on pre-fix bytes too: those arms are CONTROLs
        var control = /^[\x20-\x7e\xa0-\xff]*$/.test(name);
        it((control ? 'CONTROL - ' : '') + JSON.stringify(name), function () {
            var v = format(name);
            assert.equal(nodeAccepts(v), true, 'the emitted value must be a header Node sends: ' + v);
            assert.equal(parse(v), name.normalize('NFC'));
        });
    });
});


// ── 07..09 — behavioural, real SuperController (the §14 bootstrap) ────────────

process.env.NODE_PATH = (process.env.NODE_PATH || '') + nodePath.delimiter + FW;
require('node:module').Module._initPaths();
require(nodePath.join(FW, 'helpers'));
require(nodePath.join(ROOT, 'utils', 'prototypes'));
setPath('gina', { core: nodePath.join(FW, 'core') });

var storageLib      = require(nodePath.join(FW, 'lib', 'storage'));
var SuperController = require(CONTROLLER_SRC);

/**
 * A mock response whose setHeader enforces Node's header-value rule, as ServerResponse does
 * on HTTP/1.1, and which records removals.
 *
 * @inner
 * @returns {object} The mock response.
 */
function strictRes() {
    var chunks = [];
    var res = new Writable({ write: function (c, e, cb) { chunks.push(c); cb(); } });
    res.headers = {};
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = function (k, v) { http.validateHeaderValue(k, v); res.headers[k.toLowerCase()] = v; };
    res.getHeaders = function () { var o = {}; for (var k in res.headers) { o[k] = res.headers[k]; } return o; };
    res.removeHeader = function (k) { delete res.headers[k.toLowerCase()]; };
    res.body = function () { return Buffer.concat(chunks).toString(); };
    return res;
}

var roots = [];
var KEYS  = {};
var PLAIN_KEY = null;

before(function (t, done) {
    var root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1073-store-'));
    roots.push(root);
    var ok = storageLib.start({ drivers: { media: { adapter: 'local', strategy: 'sharded', root: root } }, default: 'media' });
    assert.ok(ok, 'storage must adopt the test driver');
    var all = Object.keys(NAMES).concat(['plain']), n = 0;
    all.forEach(function (k) {
        storageLib.get('media').put(Readable.from([Buffer.from('PDFBYTES')]), {
            originalName: (k === 'plain') ? 'proof.pdf' : NAMES[k], contentType: 'application/pdf'
        }, function (err, r) {
            assert.ifError(err);
            if (k === 'plain') { PLAIN_KEY = r.key; } else { KEYS[k] = r.key; }
            if (++n === all.length) { done(); }
        });
    });
});

after(function () {
    try { storageLib.reset(); } catch (e) { /* already closed */ }
    roots.forEach(function (d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} });
});

/**
 * Drive serveFromStorage against a strict mock; settle on finish or throwError, with a bounded
 * guard so a pre-fix uncaught throw FAILS instead of hanging.
 *
 * @inner
 * @param {string}   key  - Storage key.
 * @param {object}   opts - serveFromStorage options.
 * @param {string}   [method] - Request method.
 * @param {object}   [headers] - Request headers.
 * @param {function} cb - cb({ status, headers, body, thrown }).
 * @returns {void}
 */
function serve(key, opts, method, headers, cb) {
    var res = strictRes(), settled = false;
    var settle = function (thrown) {
        if (settled) { return; }
        settled = true;
        cb({ status: res.statusCode, headers: res.headers, body: res.body(), thrown: thrown || null });
    };
    res.on('finish', function () { setTimeout(function () { settle(); }, 10); });
    var origEnd = res.end.bind(res);
    res.end = function (d) { res.headersSent = true; return origEnd(d); };
    var inst = SuperController.createTestInstance({ req: { method: method || 'GET', headers: headers || {} }, res: res });
    inst.throwError = function (r, code, e) { res.statusCode = code; settle({ code: code, err: e }); };
    inst.serveFromStorage('media', key, opts);
    setTimeout(function () { if (!settled) { settled = true; cb({ status: 'TIMEOUT', headers: res.headers, body: res.body(), thrown: null }); } }, 3000);
}

describe('07 - serveFromStorage, a stored name above U+00FF (the process-exit path)', function () {

    Object.keys(NAMES).forEach(function (k) {
        it(k + ': 200, the exact header, the bytes', function (t, done) {
            serve(KEYS[k], { download: true }, 'GET', {}, function (r) {
                assert.equal(r.thrown, null, 'no throwError: ' + (r.thrown && r.thrown.err && r.thrown.err.message));
                assert.equal(r.status, 200);
                assert.equal(r.headers['content-disposition'], EXPECT[k]);
                assert.equal(r.body, 'PDFBYTES');
                done();
            });
        });
    });

    it('HEAD with the same name answers with the header', function (t, done) {
        serve(KEYS.apos, { download: true }, 'HEAD', {}, function (r) {
            assert.equal(r.thrown, null);
            assert.equal(r.headers['content-disposition'], EXPECT.apos);
            done();
        });
    });

    it('304 (If-None-Match) with the same name answers 304', function (t, done) {
        serve(KEYS.cjk, { download: true }, 'GET', { 'if-none-match': '"' + KEYS.cjk + '"' }, function (r) {
            assert.equal(r.thrown, null);
            assert.equal(r.status, 304);
            assert.equal(r.headers['content-disposition'], EXPECT.cjk);
            done();
        });
    });
});

describe('08 - serveFromStorage guard: a header Node refuses answers 500, never exits', function () {

    it('an app-supplied cacheControl Node refuses: 500 through throwError, no strong ETag or caching left', function (t, done) {
        serve(PLAIN_KEY, { download: true, cacheControl: 'private, max-age=60 \u2019' }, 'GET', {}, function (r) {
            assert.ok(r.thrown, 'throwError must answer (pre-fix: the throw escaped the driver callback)');
            assert.equal(r.thrown.code, 500);
            assert.equal(r.headers['etag'], undefined, 'the object ETag must not ride a 500');
            assert.equal(r.headers['cache-control'], undefined, 'immutable caching must not ride a 500');
            done();
        });
    });

    it('CONTROL - the plain name still serves 200 with today\'s header', function (t, done) {
        serve(PLAIN_KEY, { download: true }, 'GET', {}, function (r) {
            assert.equal(r.thrown, null);
            assert.equal(r.status, 200);
            assert.equal(r.headers['content-disposition'], 'attachment; filename="proof.pdf"');
            done();
        });
    });
});

describe('09 - downloadFromLocal and downloadFromURL emit a header Node accepts', function () {

    var tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'b1073-local-'));
    after(function () { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    var conf = {
        bundle: 'b', encoding: 'utf-8',
        content: { routing: { r: {} } },
        server: { coreConfiguration: { mime: { pdf: 'application/pdf' } } }
    };

    it('downloadFromLocal: the U+2019 name (pre-fix: setHeader threw, a 500)', function (t, done) {
        var file = nodePath.join(tmpDir, NAMES.apos);
        fs.writeFileSync(file, 'PDFBYTES');
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {} },
            res: res, options: { rule: 'r', conf: conf }
        });
        res.on('finish', function () {
            assert.equal(res.headers['content-disposition'], EXPECT.apos);
            assert.equal(res.body(), 'PDFBYTES');
            done();
        });
        try { inst.downloadFromLocal(file); } catch (e) { done(e); }
    });

    // an in-process upstream for downloadFromURL; it records the header each request carried
    var up = null, upPort = 0, seen = [];
    before(function (t, ready) {
        up = http.createServer(function (req, res) {
            seen.push(req.headers['content-disposition']);
            res.writeHead(200, { 'content-type': 'application/pdf' });
            res.end('UPBYTES');
        });
        up.listen(0, '127.0.0.1', function () { upPort = up.address().port; ready(); });
    });
    after(function () { if (up) { up.close(); } });

    it('downloadFromURL: the outgoing request and the response carry a header Node accepts', function (t, done) {
        // a framework global the bundle runtime defines (downloadFromURL builds a tmp path from it)
        if (typeof(global.GINA_TMPDIR) == 'undefined') { global.GINA_TMPDIR = os.tmpdir(); }
        var res = strictRes();
        var inst = SuperController.createTestInstance({
            req: { url: '/x', method: 'GET', routing: { rule: 'r' }, params: {}, get: {}, post: {}, headers: {} },
            res: res, options: { rule: 'r', conf: conf }
        });
        inst.getConfig = function () { return {}; };
        var failed = null, seenBefore = seen.length;
        inst.throwError = function (r, code, e) { failed = { code: code, err: e }; res.end(); };
        res.on('finish', function () {
            try {
                assert.equal(failed, null, 'no throwError: ' + (failed && failed.err && failed.err.message));
                assert.equal(seen.length - seenBefore, 1, 'the upstream request was made');
                assert.equal(seen[seen.length - 1], EXPECT.cjk);
                assert.equal(res.headers['content-disposition'], EXPECT.cjk);
                assert.equal(res.body(), 'UPBYTES');
                done();
            } catch (e) { done(e); }
        });
        Promise.resolve(inst.downloadFromURL('http://127.0.0.1:' + upPort + '/proof.pdf', { file: NAMES.cjk })).catch(done);
    });
});


// ── 10 — source and dist pins ─────────────────────────────────────────────────

describe('10 - pins', function () {

    it('all four serveFromStorage driver callbacks run through the guard', function () {
        assert.equal(countOf(SRC, 'guardServeCallback(function onServe'), 4);
    });

    it('the formatter emits the RFC 8187 parameter', function () {
        var fn = extractFunction(SRC, 'function formatAttachmentDisposition(');
        assert.ok(fn.indexOf("filename*=UTF-8\\'\\'") > -1);
        assert.ok(fn.indexOf(".normalize('NFC')") > -1);
    });

    it('gina.min.js carries the extended-parameter parse (run before the rebuild: red)', function () {
        var min = fs.readFileSync(DIST_MIN, 'utf8');
        assert.ok(countOf(min, 'filename\\*\\s*=\\s*') >= 1, 'the filename* regex literal');
        assert.ok(countOf(min, '"iso-8859-1"') + countOf(min, "'iso-8859-1'") >= 1, 'the ISO-8859-1 branch');
    });
});
