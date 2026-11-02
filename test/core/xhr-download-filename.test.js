'use strict';
// #B290 — the XHR blob-download filename parse carried two defects in ONE statement,
// duplicated in TWO bundled modules (utils/events.js `handleXhr` readyState-4 branch,
// and the validator's own XHR completion handler in core/plugins/lib/validator):
//   (a) matching the header with '\=(.*)' and dereferencing [0] — String.match returns
//       null when the header carries no `=` (e.g. a foreign `attachment; inline`), so
//       the handler threw AFTER appendChild + createObjectURL, leaking the detached
//       anchor and the object URL. Gina's own emitters always append `filename=`, so
//       this fired on foreign or proxied headers only.
//   (b) on an RFC 6266 quoted-string the surrounding quotes were retained in
//       `a.download` — dormant while gina emitted unquoted filenames, ARMED the moment
//       #B297 quotes the emission. The old expression also swallowed everything to
//       end-of-line, folding a trailing extended parameter into the name.
// The parse now lives in ONE top-level pure function in utils/events.js —
// getFilenameFromContentDisposition — called by both copies (the same shim-global
// mechanism listenToXhrEvents already rides across these files). This file EXECUTES
// the shipped bytes (extract-and-execute, no replica) and pins the two call sites +
// dist fidelity.
//
// Red-first (validated 2026-08-07 against `git show HEAD:` pre-#B290 bytes):
//   - the §00 extraction control fails pre-fix (the helper does not exist);
//   - the retired-statement negatives read 1 per source file pre-fix, 0 post;
//   - dist gina.min.js: retired string literal 2 pre / 0 post; helper name 0 pre /
//     3 post (def + 2 call sites); the filename regex literal 0 pre / 1 post.

var { describe, it, before } = require('node:test');
var assert = require('node:assert/strict');
var fs   = require('fs');
var path = require('path');

var FW = require('../fw');

var EVENTS_SRC    = path.join(FW, 'core/asset/plugin/src/vendor/gina/utils/events.js');
var VALIDATOR_SRC = path.join(FW, 'core/plugins/lib/validator/src/main.js');
var DIST_JS       = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.js');
var DIST_MIN      = path.join(FW, 'core/asset/plugin/dist/vendor/gina/js/gina.min.js');

var _cache = {};
function read(p) { return _cache[p] || (_cache[p] = fs.readFileSync(p, 'utf8')); }

function countOf(haystack, needle) {
    var c = 0, i = haystack.indexOf(needle);
    while (i > -1) { c++; i = haystack.indexOf(needle, i + needle.length); }
    return c;
}

// started-flag brace walker (the house extraction shape) — safe here: the helper body
// carries no brace inside any string or regex literal.
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

var DECL      = 'function getFilenameFromContentDisposition(';
var CALL      = 'a.download = getFilenameFromContentDisposition(contentDisposition);';
// JS string below encodes the source bytes: .match('\=(.*)')[0].substring(1)
var OLD_PARSE = ".match('\\=(.*)')[0].substring(1)";

var parseFilename = null;

before(function () {
    var fnSrc = extractFunction(read(EVENTS_SRC), DECL);
    parseFilename = new Function('return (' + fnSrc + ');')();
});


// ── 00 — instrument controls ──────────────────────────────────────────────────

describe('00 - extraction controls', function () {

    it('the declaration exists exactly once, at top level (shim-global mechanism)', function () {
        assert.equal(countOf(read(EVENTS_SRC), DECL), 1);
        assert.match(read(EVENTS_SRC), /^function getFilenameFromContentDisposition\(/m,
            'a column-0 declaration cannot be nested — this IS the scope invariant');
    });

    it('the extraction produced a callable (real bytes, no replica)', function () {
        assert.equal(typeof parseFilename, 'function');
    });

    it('the validator does NOT carry a duplicate definition (single source of truth)', function () {
        assert.equal(read(VALIDATOR_SRC).indexOf(DECL), -1);
    });
});


// ── 01 — behavioral matrix on the extracted shipped bytes ─────────────────────

describe('01 - the extracted parse handles every header shape', function () {

    it('quoted-string with spaces — delimiters stripped (the #B297 emission shape)', function () {
        assert.equal(parseFilename('attachment; filename="Monthly Report 2026.pdf"'),
            'Monthly Report 2026.pdf');
    });

    it('bare token', function () {
        assert.equal(parseFilename('attachment; filename=report.pdf'), 'report.pdf');
    });

    it('unquoted value with spaces — the legacy emission keeps parsing identically (back-compat)', function () {
        assert.equal(parseFilename('attachment; filename=Monthly Report 2026.pdf'),
            'Monthly Report 2026.pdf');
    });

    it('a bare token stops at the parameter boundary instead of swallowing the line', function () {
        assert.equal(parseFilename('attachment; filename=a.pdf; size=3'), 'a.pdf');
    });

    it('escaped quote inside a quoted-string is unescaped', function () {
        assert.equal(parseFilename('attachment; filename="a \\"b\\".pdf"'), 'a "b".pdf');
    });

    it('escaped backslash inside a quoted-string is unescaped', function () {
        assert.equal(parseFilename('attachment; filename="a\\\\b.pdf"'), 'a\\b.pdf');
    });

    it('defect (a) shape: a disposition without a filename parameter returns "" instead of throwing', function () {
        assert.equal(parseFilename('attachment'), '');
        assert.equal(parseFilename('attachment; inline'), '');
    });

    it('a missing header (null) returns "" instead of throwing', function () {
        assert.equal(parseFilename(null), '');
    });

    // #B1073 (test change approved by Martin Luther ETOUMAN NDAMBWE, 2026-11-02, answered by
    // 18:24:13 WAT): the parse now decodes and prefers the RFC 8187 extended parameter, as
    // browsers do. Until then these two arms pinned « filename* is never read » ('' and
    // 'plain.pdf'); the no-fold intent they carried stays asserted.
    it('the extended star-parameter alone is decoded', function () {
        assert.equal(parseFilename("attachment; filename*=UTF-8''a%20b.pdf"), 'a b.pdf');
    });

    it('when both parameters are present the extended one wins — still no fold', function () {
        assert.equal(parseFilename("attachment; filename*=UTF-8''x.pdf; filename=plain.pdf"),
            'x.pdf');
    });

    it('an empty quoted-string yields ""', function () {
        assert.equal(parseFilename('attachment; filename=""'), '');
    });

    it('SUBTRACT — the retired expression throws on the no-equals shape and keeps quotes on the quoted shape', function () {
        // one-expression replica of the RETIRED statement, as the pre-fix arm
        var oldParse = function (contentDisposition) {
            return contentDisposition.match('\=(.*)')[0].substring(1);
        };
        assert.throws(function () { oldParse('attachment; inline'); }, TypeError);
        assert.equal(oldParse('attachment; filename="a.pdf"'), '"a.pdf"');
    });
});


// ── 02 — wiring: both copies call the shared helper; the retired parse is gone ─

describe('02 - call-site wiring in both bundled modules', function () {

    it('events.js readyState-4 blob branch calls the helper exactly once', function () {
        assert.equal(countOf(read(EVENTS_SRC), CALL), 1);
    });

    it('the validator XHR completion handler calls the helper exactly once', function () {
        assert.equal(countOf(read(VALIDATOR_SRC), CALL), 1);
    });

    it('the retired statement is gone from both sources', function () {
        assert.equal(countOf(read(EVENTS_SRC), OLD_PARSE), 0);
        assert.equal(countOf(read(VALIDATOR_SRC), OLD_PARSE), 0);
    });
});


// ── 03 — dist fidelity (pre/post counts measured against git show HEAD) ───────

describe('03 - dist fidelity', function () {

    it('gina.js (unminified) carries zero retired statements and both call sites', function () {
        assert.equal(countOf(read(DIST_JS), OLD_PARSE), 0);
        assert.equal(countOf(read(DIST_JS), CALL), 2,
            'both modules concatenate verbatim, so the identical statement appears twice');
    });

    it('gina.min.js: the helper name survives Closure (top-level global) — def + 2 calls', function () {
        // identifier tokens cannot be split by a line wrap — wrap-immune needle
        assert.equal(countOf(read(DIST_MIN), 'getFilenameFromContentDisposition'), 3);
    });

    it('gina.min.js: the filename regex literal shipped (0 pre / 1 post)', function () {
        // a regex literal cannot span a line wrap — wrap-immune needle
        assert.equal(countOf(read(DIST_MIN), 'match(/filename\\s*=\\s*(?:'), 1);
    });

    it("gina.min.js: the retired parse's string literal is gone (2 pre / 0 post)", function () {
        // string literal — wrap-immune; shorter than the full statement on purpose so a
        // future wrap between punctuation tokens cannot make this negative pass vacuously
        assert.equal(countOf(read(DIST_MIN), "'=(.*)'"), 0);
    });
});
