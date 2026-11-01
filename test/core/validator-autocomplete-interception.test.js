/**
 * FormValidator — the Safari `autocomplete="off"` gate (#B135)
 *
 * The workaround's UA gate matches REAL Safari only: every Chromium UA carries
 * the "Safari/537.36" token, so the bare /safari/i test ran this WebKit
 * workaround on Chrome/Edge/Brave/Opera where it was never intended (the
 * handleAutoComplete header comment states the Safari intent).
 *
 * The keydown interception this file also pinned (#B134, its §§ 01-04) was
 * removed by #B1055: `validator-autocomplete-readonly-b1055.test.js` pins what
 * stays. §§ 05-06 keep their numbers.
 *
 * Run: node --test test/core/validator-autocomplete-interception.test.js
 */

var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var fs = require('fs');
var path = require('path');

var FW = require(path.join(__dirname, '..', 'fw'));
var MAIN_PATH = path.join(FW, 'core', 'plugins', 'lib', 'validator', 'src', 'main.js');
var DIST_JS_PATH = path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js', 'gina.js');
var DIST_MIN_PATH = path.join(FW, 'core', 'asset', 'plugin', 'dist', 'vendor', 'gina', 'js', 'gina.min.js');

var mainSrc = fs.readFileSync(MAIN_PATH, 'utf8');
var distSrc = fs.readFileSync(DIST_JS_PATH, 'utf8');
var distMin = fs.readFileSync(DIST_MIN_PATH, 'utf8');

// ============================================================================
// Helpers
// ============================================================================

// Strip line comments the replace-code convention leaves behind (the house
// idiom) so negative pins never trip on the commented-out pre-fix block.
function stripComments(src) {
    return src.split('\n').filter(function (l) {
        return !/^\s*(\/\/|\*|\/\*)/.test(l);
    }).join('\n');
}

// Occurrence count that is safe on minified single-line files (`grep -c`
// counts LINES, not occurrences — measured while designing these pins).
function count(hay, needle) {
    return hay.split(needle).length - 1;
}

// ============================================================================
// 05 — #B135: the UA gate matches REAL Safari only
// ============================================================================

// The registerForLiveChecking block — end-anchored on the next declaration.
var rlcStart = mainSrc.indexOf('var registerForLiveChecking = function');
var rlcEnd = mainSrc.indexOf('var bindUploadResetOrDeleteTrigger');
var rlcSlice = (rlcStart > -1 && rlcEnd > rlcStart) ? mainSrc.substring(rlcStart, rlcEnd) : '';

// The full gate sub-expression, extracted as REAL bytes (no replica to drift).
var GATE_RE = /\/safari\/i\.test\(navigator\.userAgent\)\s*&&\s*!\/chrom\(e\|ium\)\/i\.test\(navigator\.userAgent\)/;

describe('05 - #B135 source pins + UA matrix: real-Safari-only gate', function () {

    it('05.1 - the narrowed gate exists once, inside the !isCustomEl guard, before the autocomplete read', function () {
        assert.ok(rlcStart > -1 && rlcEnd > rlcStart, 'registerForLiveChecking block not found');
        var active = stripComments(rlcSlice);
        var m = active.match(new RegExp(GATE_RE.source, 'g'));
        assert.ok(m && m.length === 1, 'the safari && !chrom(e|ium) gate must appear exactly once');
        var guardIdx = active.indexOf('if ( !isCustomEl ) {');
        var gateIdx = active.search(GATE_RE);
        var acReadIdx = active.indexOf("$el.getAttribute('autocomplete')");
        assert.ok(guardIdx > -1 && gateIdx > guardIdx, 'the gate must sit inside the !isCustomEl guard');
        assert.ok(acReadIdx > guardIdx && acReadIdx < gateIdx, 'the autocomplete read feeds the gate');
    });

    it('05.2 - the EXTRACTED gate expression classifies a real UA matrix', function () {
        var exprMatch = stripComments(rlcSlice).match(GATE_RE);
        assert.ok(exprMatch, 'gate extraction failed');
        // Execute the real bytes against each UA.
        var gate = new Function('navigator', 'return ( ' + exprMatch[0] + ' );');
        var matrix = [
            // [description, userAgent, expected]
            ['Chrome macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', false],
            ['Edge Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0', false],
            ['Opera', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 OPR/112.0.0.0', false],
            ['HeadlessChrome', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36', false],
            ['Firefox desktop (no safari token)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0', false],
            ['Safari macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15', true],
            ['Safari iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', true],
            // WebKit-on-iOS third-party browsers stay matched BY DESIGN — they
            // run Safari's engine, so the workaround applies.
            ['Chrome iOS (CriOS, WebKit)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1', true]
        ];
        matrix.forEach(function (row) {
            assert.equal(gate({ userAgent: row[1] }), row[2],
                row[0] + ' must ' + (row[2] ? '' : 'NOT ') + 'be intercepted');
        });
    });

    it('05.3 - subtract: the PRE-fix bare /safari/i gate matched Chromium (the defect)', function () {
        // PRE-fix predicate shape — kept ONLY to demonstrate what the fix removes.
        var preFixGate = function (navigator) { return /safari/i.test(navigator.userAgent); };
        var chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
        assert.equal(preFixGate({ userAgent: chromeUA }), true,
            'pre-fix, Chromium was intercepted — this is the reported mis-scope');
    });
});

// ============================================================================
// 06 — #B135 dist fidelity — validated red-first (0 pre-fix in both artifacts)
// ============================================================================

describe('06 - #B135 dist fidelity: the narrowed gate reaches the bundle', function () {

    it('06.1 - gina.min.js carries the chrom(e|ium) exclusion regex', function () {
        // Closure preserves regex literals verbatim. Pre-fix artifact: 0.
        assert.ok(count(distMin, 'chrom(e|ium)') >= 1,
            'the Chromium-exclusion regex must reach the minified bundle');
    });

    it('06.2 - unminified gina.js carries the literal narrowed gate', function () {
        assert.ok(distSrc.indexOf('!/chrom(e|ium)/i.test(navigator.userAgent)') > -1);
    });
});
