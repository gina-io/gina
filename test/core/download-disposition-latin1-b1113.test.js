'use strict';
// #B1113 — a download name holding a Latin-1 letter (U+0080–U+00FF: « résumé.pdf », « naïve © ñ.pdf »)
// reached the Content-Disposition header as raw bytes in `filename="…"`. Node sends those bytes, but
// Chromium and WebKit decode a header's bytes as UTF-8, and saved the download with U+FFFD in place of
// each such letter. Measured 2026-11-07 on develop 148e9eef3 (Chromium 156, WebKit 27.2, a link click
// from a UTF-8 page): « r�sum�.pdf » in both; curl -OJ, which reads only `filename`, did the same. A
// name above U+00FF already got `filename*` (#B1073), but its fallback kept Latin-1 letters raw too.
//
// The fix: formatAttachmentDisposition keeps the plain form for printable ASCII (and tab) only. Any
// other name gets an all-ASCII `filename` fallback (accents dropped: NFKD, then the combining accents
// U+0300–U+036F removed; `?` for any other non-ASCII character), then the RFC 8187
// `filename*=UTF-8''…` parameter, which browsers prefer. Server-side only: the browser parse already
// reads `filename*` first.
//
// Seams (red-first without touching a shared tree):
//   GINA_B1113_CONTROLLER — controller.js to read and extract formatAttachmentDisposition from;
//   GINA_B1113_EVENTS     — utils/events.js to extract the browser parse from.
// Arms marked CONTROL pin unchanged behaviour and must stay green on the pre-fix bytes.

var { describe, it } = require('node:test');
var assert   = require('node:assert/strict');
var fs       = require('node:fs');
var http     = require('node:http');
var nodePath = require('node:path');

var FW = require('../fw');

var CONTROLLER_SRC = process.env.GINA_B1113_CONTROLLER || nodePath.join(FW, 'core/controller/controller.js');
var EVENTS_SRC     = process.env.GINA_B1113_EVENTS || nodePath.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');

var SRC    = fs.readFileSync(CONTROLLER_SRC, 'utf8');
var EVENTS = fs.readFileSync(EVENTS_SRC, 'utf8');

// started-flag brace walker (the house extraction shape): both helpers carry no brace inside a
// string, a regex literal or a comment
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

var FORMAT_SRC = extractFunction(SRC, 'function formatAttachmentDisposition(');
var format = new Function('return (' + FORMAT_SRC + ');')();
var parse  = new Function('return (' + extractFunction(EVENTS, 'function getFilenameFromContentDisposition(') + ');')();

// Node's own header-value check
function nodeAccepts(value) {
    try { http.validateHeaderValue('content-disposition', value); return true; } catch (e) { return false; }
}
// the property the fix adds: no byte above 0x7F in the value
function asciiOnly(value) {
    return /^[\x00-\x7f]*$/.test(value);
}


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - instrument controls', function () {

    it('CONTROL - both extractions produced callables (real bytes, no replica)', function () {
        assert.equal(typeof format, 'function');
        assert.equal(typeof parse, 'function');
        assert.ok(FORMAT_SRC.split('\n').length > 10, 'the walk stopped inside the function');
    });

    it('CONTROL - the ASCII instrument fires: it refuses a Latin-1 letter and accepts a quote', function () {
        assert.equal(asciiOnly('a\u00E9'), false);
        assert.equal(asciiOnly('attachment; filename="a \\"b\\".pdf"'), true);
    });

    it('CONTROL - the header instrument fires: Node refuses U+2019 and accepts a Latin-1 value', function () {
        assert.equal(nodeAccepts('attachment; filename="l\u2019offre.pdf"'), false);
        assert.equal(nodeAccepts('attachment; filename="r\u00E9sum\u00E9.pdf"'), true);
    });
});


// ── 01 — a Latin-1 name: an all-ASCII fallback plus filename* ─────────────────

describe('01 - a Latin-1 name gets an all-ASCII fallback (accents dropped) and filename*', function () {

    var cases = {
        'r\u00E9sum\u00E9.pdf'                 : "attachment; filename=\"resume.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf",
        'Accus\u00E9 de r\u00E9ception.pdf'    : "attachment; filename=\"Accuse de reception.pdf\"; filename*=UTF-8''Accus%C3%A9%20de%20r%C3%A9ception.pdf",
        'na\u00EFve \u00A9 \u00F1.pdf'        : "attachment; filename=\"naive ? n.pdf\"; filename*=UTF-8''na%C3%AFve%20%C2%A9%20%C3%B1.pdf",
        'Gr\u00FC\u00DFe \u00C5ngstr\u00F6m.txt' : "attachment; filename=\"Gru?e Angstrom.txt\"; filename*=UTF-8''Gr%C3%BC%C3%9Fe%20%C3%85ngstr%C3%B6m.txt",
        '\u00DF\u00E6\u00F8.pdf'              : "attachment; filename=\"???.pdf\"; filename*=UTF-8''%C3%9F%C3%A6%C3%B8.pdf",
        'c1\u0085.pdf'                          : "attachment; filename=\"c1?.pdf\"; filename*=UTF-8''c1%C2%85.pdf",
        '\u00E9 "q" \\.pdf'                     : "attachment; filename=\"e \\\"q\\\" \\\\.pdf\"; filename*=UTF-8''%C3%A9%20%22q%22%20%5C.pdf"
    };
    Object.keys(cases).forEach(function (name) {
        it(JSON.stringify(name) + ': exact value', function () {
            assert.equal(format(name), cases[name]);
        });
    });

    it('a decomposed name (e followed by U+0301) gives the precomposed name\'s value', function () {
        assert.equal(format('re\u0301sume\u0301.pdf'), cases['r\u00E9sum\u00E9.pdf']);
    });

    it('the value holds no byte above 0x7F and Node accepts it', function () {
        Object.keys(cases).forEach(function (name) {
            var v = format(name);
            assert.equal(asciiOnly(v), true, JSON.stringify(name) + ' -> ' + v);
            assert.equal(nodeAccepts(v), true, v);
        });
    });
});


// ── 02 — a name above U+00FF: its fallback drops accents too ──────────────────

describe('02 - a name above U+00FF: the fallback drops accents, the rest is unchanged', function () {

    it('a Latin-1 letter beside U+2019: the fallback reads « e », not the raw byte', function () {
        assert.equal(format('caf\u00E9\u2019s.pdf'),
            "attachment; filename=\"cafe?s.pdf\"; filename*=UTF-8''caf%C3%A9%E2%80%99s.pdf");
    });

    it('a compatibility ligature decomposes into ASCII letters', function () {
        assert.equal(format('\uFB01le.pdf'),
            "attachment; filename=\"file.pdf\"; filename*=UTF-8''%EF%AC%81le.pdf");
    });

    it('a fullwidth quote and backslash become ASCII and stay escaped in the fallback', function () {
        assert.equal(format('\uFF02q\uFF3C.pdf'),
            "attachment; filename=\"\\\"q\\\\.pdf\"; filename*=UTF-8''%EF%BC%82q%EF%BC%BC.pdf");
    });

    var unchanged = {
        'l\u2019offre.pdf'     : "attachment; filename=\"l?offre.pdf\"; filename*=UTF-8''l%E2%80%99offre.pdf",
        '\u5831\u544A.pdf'    : "attachment; filename=\"??.pdf\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.pdf",
        'doc-\uD83D\uDCC4.pdf': "attachment; filename=\"doc-??.pdf\"; filename*=UTF-8''doc-%F0%9F%93%84.pdf",
        '100%\u2019.pdf'       : "attachment; filename=\"100%?.pdf\"; filename*=UTF-8''100%25%E2%80%99.pdf"
    };
    Object.keys(unchanged).forEach(function (name) {
        it('CONTROL - ' + JSON.stringify(name) + ' keeps its #B1073 value', function () {
            assert.equal(format(name), unchanged[name]);
        });
    });
});


// ── 03 — a printable ASCII name keeps its exact bytes ─────────────────────────

describe('03 - a printable ASCII name keeps the exact bytes it had (CONTROL on pre-fix)', function () {

    var keep = {
        'proof.pdf'               : 'attachment; filename="proof.pdf"',
        'monthly report 2026.pdf' : 'attachment; filename="monthly report 2026.pdf"',
        'a "b".pdf'               : 'attachment; filename="a \\"b\\".pdf"',
        'a\\b.pdf'                : 'attachment; filename="a\\\\b.pdf"',
        'tab\there.pdf'           : 'attachment; filename="tab\there.pdf"',
        '100%.pdf'                : 'attachment; filename="100%.pdf"',
        ''                        : 'attachment; filename=""'
    };
    Object.keys(keep).forEach(function (name) {
        it('CONTROL - ' + JSON.stringify(name), function () {
            assert.equal(format(name), keep[name]);
        });
    });

    it('CONTROL - a non-string is coerced, never thrown on', function () {
        assert.equal(format(42), 'attachment; filename="42"');
    });
});


// ── 04 — totality and the round trip through the browser parse ────────────────

describe('04 - every value is ASCII, accepted by Node, and parses back to the name', function () {

    var names = ['r\u00E9sum\u00E9.pdf', 're\u0301sume\u0301.pdf', 'Accus\u00E9 de r\u00E9ception.pdf',
        'na\u00EFve \u00A9 \u00F1.pdf', 'caf\u00E9\u2019s.pdf', '\uFB01le.pdf', '\u00E9 "q" \\.pdf', 'l\u2019offre.pdf',
        '\u5831\u544A.pdf', 'proof.pdf', 'a "b".pdf'];
    names.forEach(function (name) {
        // the browser parse prefers filename*, and a raw Latin-1 filename parsed right too, so the
        // round trip holds on the pre-fix bytes: a CONTROL
        it('CONTROL - parse(format(' + JSON.stringify(name) + ')) names the file', function () {
            assert.equal(parse(format(name)), name.normalize('NFC'));
        });
    });

    it('2,000 random names (Latin-1, every plane, lone surrogates, controls): ASCII, accepted, no throw', function () {
        var seed = 1113;
        var rnd = function () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        var latin1Seen = 0;
        for (var n = 0; n < 2000; n++) {
            var len = 1 + Math.floor(rnd() * 12), s = '';
            for (var j = 0; j < len; j++) {
                var r = rnd();
                if (r < 0.1) { s += String.fromCharCode(Math.floor(rnd() * 0x20)); }
                else if (r < 0.2) { s += String.fromCharCode(0xD800 + Math.floor(rnd() * 0x800)); }
                else if (r < 0.55) { s += String.fromCharCode(0x80 + Math.floor(rnd() * 0x80)); latin1Seen++; }
                else if (r < 0.8) { s += String.fromCharCode(0x20 + Math.floor(rnd() * 0x5F)); }
                else { s += String.fromCodePoint(Math.floor(rnd() * 0x110000)); }
            }
            var v;
            assert.doesNotThrow(function () { v = format(s); });
            assert.equal(asciiOnly(v), true, JSON.stringify(s) + ' -> ' + JSON.stringify(v));
            assert.equal(nodeAccepts(v), true, JSON.stringify(s) + ' -> ' + JSON.stringify(v));
        }
        assert.ok(latin1Seen > 1000, 'the generator drew Latin-1 characters: ' + latin1Seen);
    });
});


// ── 05 — source pins ──────────────────────────────────────────────────────────

describe('05 - pins', function () {

    // comment lines stripped before an absence is asserted: the fix's own was: comments name the
    // old test; the raw text must still hold one, so a broken strip cannot pass vacuously
    var codeOnly = FORMAT_SRC.split('\n').filter(function (l) { return !/^\s*\/\//.test(l); }).join('\n');

    it('the plain form is kept for printable ASCII and tab only', function () {
        assert.ok(codeOnly.indexOf('/^[\\t\\x20-\\x7e]*$/.test(name)') > -1, 'the ASCII test is in the code');
        assert.equal(codeOnly.indexOf('\\x80-\\xff'), -1, 'no Latin-1 range is left in the code');
        assert.ok(FORMAT_SRC.indexOf('was: if ( /^[\\t\\x20-\\x7e\\x80-\\xff]*$/.test(name) )') > -1, 'the was: comment keeps the old test');
    });

    it('the fallback drops accents (NFKD, U+0300-U+036F) and keeps ASCII only', function () {
        assert.ok(codeOnly.indexOf(".normalize('NFKD').replace(/[\\u0300-\\u036f]/g, '')") > -1);
        assert.ok(codeOnly.indexOf(".replace(/[^\\x20-\\x7e]/g, '?')") > -1);
        assert.equal(codeOnly.indexOf('\\xa0-\\xff'), -1, 'the old Latin-1 fallback range is gone from the code');
    });

    it('CONTROL - the three controller emitters call formatAttachmentDisposition', function () {
        var calls = SRC.split('\n').filter(function (l) {
            return !/^\s*(\/\/|\*)/.test(l) && /formatAttachmentDisposition\(/.test(l) && !/function formatAttachmentDisposition\(/.test(l);
        });
        assert.equal(calls.length, 3, calls.join('\n'));
    });
});
