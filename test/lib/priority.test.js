'use strict';
/**
 * lib/priority (#H12) — RFC 9218 Extensible Priorities: the `Priority` header field.
 *
 * Behavioural suite against the REAL module. It is dependency-free and pure,
 * so every claim is driven, not shape-matched. The normative source is
 * RFC 9218 §4 (member semantics, the MUST-ignore rules) over RFC 8941 §4.2
 * (dictionary grammar; a grammar failure ignores the whole field).
 *
 * Suites:
 *  01 — parse(): absent / non-string input → RFC defaults, `present:false`
 *  02 — parse(): the six forms Chrome 151 sends over h2 (measured 2026-08-27) + `i` alone
 *  03 — parse(): RFC 9218 §4 MUST-ignore rules — out-of-range, wrong type, unknown
 *       members, member parameters, last-wins duplicates, inner lists
 *  04 — parse(): RFC 8941 grammar failures ignore the WHOLE field
 *  05 — parse(): multiple field lines combine with ", " (RFC 8941 §4.2 step 1)
 *  06 — serialize(): explicit `u` always emitted (RFC 9218 §8), `i` only when true,
 *       invalid input dropped, round-trip identity
 *  07 — normalizeUrgency(): integer 0–7 or the default
 *  08 — resolveOutbound(): the four-rung chain query() runs, incl. the
 *       case-insensitive caller-wins rung and the explicit-option-never-falls-through rule
 *  09 — source structure: pure (no require), 'use strict', the exported surface
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');
var fs     = require('fs');

var FW       = require('../fw');
var priority = require(path.join(FW, 'lib/priority/src/main.js'));
var SRC      = fs.readFileSync(path.join(FW, 'lib/priority/src/main.js'), 'utf8');

var DEFAULTS_ABSENT  = { urgency: 3, incremental: false, present: false };
var DEFAULTS_PRESENT = { urgency: 3, incremental: false, present: true  };

function P(u, i) { return { urgency: u, incremental: i, present: true }; }


// ─── 01 — absent / non-string ─────────────────────────────────────────────────

describe('01 - parse(): absent or non-string input yields the RFC defaults with present:false', function() {

    it('undefined, null, a number, an object → defaults, present:false', function() {
        [undefined, null, 42, {}, true].forEach(function(v) {
            assert.deepEqual(priority.parse(v), DEFAULTS_ABSENT, 'input: ' + JSON.stringify(v));
        });
    });

    it('an empty string is an empty dictionary — present, all defaults', function() {
        assert.deepEqual(priority.parse(''), DEFAULTS_PRESENT);
    });

    it('returns a fresh object every call (a consumer mutating one cannot poison the next)', function() {
        var a = priority.parse('u=1');
        a.urgency = 7;
        assert.equal(priority.parse('u=1').urgency, 1);
    });
});


// ─── 02 — the measured browser forms ──────────────────────────────────────────

describe('02 - parse(): the forms a browser actually sends', function() {

    it('the six Chrome forms + the bare incremental flag', function() {
        assert.deepEqual(priority.parse('u=0, i'), P(0, true));   // document
        assert.deepEqual(priority.parse('u=0'),    P(0, false));  // render-blocking CSS, whole
        assert.deepEqual(priority.parse('u=1'),    P(1, false));  // blocking script
        assert.deepEqual(priority.parse('u=1, i'), P(1, true));   // fetch(), favicon
        assert.deepEqual(priority.parse('u=2, i'), P(2, true));   // <img>
        assert.deepEqual(priority.parse('u=3'),    P(3, false));
        assert.deepEqual(priority.parse('i'),      P(3, true));   // urgency defaults to 3
    });

    it('the full urgency range 0–7 round-trips', function() {
        for (var u = 0; u <= 7; u++) {
            assert.equal(priority.parse('u=' + u).urgency, u);
        }
    });

    it('optional whitespace around the comma and the boolean forms of i', function() {
        assert.deepEqual(priority.parse('u=1 ,i'),     P(1, true));
        assert.deepEqual(priority.parse('u=1,i'),      P(1, true));
        assert.deepEqual(priority.parse('  u=1, i  '), P(1, true));
        assert.deepEqual(priority.parse('u=1, i=?1'),  P(1, true));
        assert.deepEqual(priority.parse('u=1, i=?0'),  P(1, false));
    });
});


// ─── 03 — RFC 9218 §4 MUST-ignore rules ───────────────────────────────────────

describe('03 - parse(): out-of-range, wrong-type, unknown members and parameters are ignored INDIVIDUALLY', function() {

    it('u out of range → u ignored (default 3), the rest of the field still counts', function() {
        assert.deepEqual(priority.parse('u=8, i'),  P(3, true));
        assert.deepEqual(priority.parse('u=-1, i'), P(3, true));
        assert.deepEqual(priority.parse('u=99'),    DEFAULTS_PRESENT);
    });

    it('u of the wrong type → ignored: decimal, string, token, boolean, byte sequence', function() {
        assert.deepEqual(priority.parse('u=1.5'),    DEFAULTS_PRESENT);
        assert.deepEqual(priority.parse('u="1"'),    DEFAULTS_PRESENT);
        assert.deepEqual(priority.parse('u=abc'),    DEFAULTS_PRESENT);
        assert.deepEqual(priority.parse('u=?1'),     DEFAULTS_PRESENT);
        assert.deepEqual(priority.parse('u=:AQ==:'), DEFAULTS_PRESENT);
    });

    it('i of the wrong type → ignored (default false): the Integer 1 is NOT true', function() {
        assert.deepEqual(priority.parse('u=1, i=1'),     P(1, false));
        assert.deepEqual(priority.parse('u=1, i="yes"'), P(1, false));
        assert.deepEqual(priority.parse('u=1, i=true'),  P(1, false));
    });

    it('unknown members are ignored, known ones still read', function() {
        assert.deepEqual(priority.parse('u=1, x=5, foo="bar", i'), P(1, true));
        assert.deepEqual(priority.parse('x=5'), DEFAULTS_PRESENT);
        assert.deepEqual(priority.parse('*key=1, u=2'), P(2, false)); // `*` is a legal key start
    });

    it('member parameters are validated and dropped', function() {
        assert.deepEqual(priority.parse('u=1;q=0.5, i;x'),      P(1, true));
        assert.deepEqual(priority.parse('u=1;a;b=2;c="s", i'),  P(1, true));
    });

    it('a repeated key overwrites — last wins (RFC 8941 §4.2.2)', function() {
        assert.deepEqual(priority.parse('u=1, u=2'),   P(2, false));
        assert.deepEqual(priority.parse('i, i=?0'),    P(3, false));
        assert.deepEqual(priority.parse('u=9, u=4'),   P(4, false));
        assert.deepEqual(priority.parse('u=4, u=9'),   DEFAULTS_PRESENT); // the last one is out of range
    });

    it('an inner-list value is the wrong type and is ignored, the rest of the field still counts', function() {
        assert.deepEqual(priority.parse('u=(1 2), i'),              P(3, true));
        assert.deepEqual(priority.parse('u=(), i'),                 P(3, true));
        assert.deepEqual(priority.parse('u=("a";p=1 :AA==:);x, i'), P(3, true));
    });
});


// ─── 04 — RFC 8941 grammar failures ───────────────────────────────────────────

describe('04 - parse(): a grammar failure ignores the WHOLE field (present:false, all defaults)', function() {

    it('every malformed shape reads exactly as an absent header', function() {
        [
            'U=1',          // key must start lcalpha or *
            'u=1,',         // trailing comma
            ',u=1',         // leading comma
            'u = 1',        // SP before =
            'u=1,, i',      // empty member
            'u="unterminated',
            'u=1;',         // parameter without a key
            '1',            // not a key
            'u==1',
            'u=1 i',        // members not comma-separated
            'i=?2',         // boolean must be ?0/?1
            'i=?',
            'u=:abc',       // unterminated byte sequence
            'u=:a*b:',      // non-base64 byte
            'u=(1 2',       // unterminated inner list
            'u=(1,2)',      // inner-list items are space-separated
            'u=1' + String.fromCharCode(1), // a control character is not a member separator
            'u=1234567890123456',           // > 15 digits
            'u=--1'
        ].forEach(function(v) {
            assert.deepEqual(priority.parse(v), DEFAULTS_ABSENT, 'input: ' + JSON.stringify(v));
        });
    });

    it('never throws, whatever the input', function() {
        var hostile = ['\\', '"', '"\\', ';', '=', '(', ')', ':', '?', '?1', 'u=', 'u=;', 'i;=', 'u=1;=2', 'u=ÿ'];
        hostile.forEach(function(v) {
            assert.doesNotThrow(function() { priority.parse(v); }, 'input: ' + JSON.stringify(v));
        });
        assert.doesNotThrow(function() { priority.parse(new Array(5000).join('u=1, ') + 'u=1'); });
    });
});


// ─── 05 — multiple field lines ────────────────────────────────────────────────

describe('05 - parse(): an array of field lines combines with ", "', function() {

    it('two lines read as one dictionary, last wins across lines', function() {
        assert.deepEqual(priority.parse(['u=5', 'i']),    P(5, true));
        assert.deepEqual(priority.parse(['u=1', 'u=2']),  P(2, false));
    });

    it('a malformed line poisons the combined field, as the RFC requires', function() {
        assert.deepEqual(priority.parse(['u=1', 'U=2']), DEFAULTS_ABSENT);
    });

    it('an empty array is an empty dictionary', function() {
        // [].join(', ') is '' — present, all defaults
        assert.deepEqual(priority.parse([]), DEFAULTS_PRESENT);
    });
});


// ─── 06 — serialize() ─────────────────────────────────────────────────────────

describe('06 - serialize(): explicit u always emitted, i only when true, invalid input dropped', function() {

    it('the wire forms', function() {
        assert.equal(priority.serialize({ urgency: 0, incremental: true }),  'u=0, i');
        assert.equal(priority.serialize({ urgency: 3 }),                     'u=3');   // explicit default IS emitted (RFC 9218 §8)
        assert.equal(priority.serialize({ incremental: true }),              'i');
        assert.equal(priority.serialize({ urgency: 7, incremental: false }), 'u=7');
    });

    it('nothing to say → empty string', function() {
        [undefined, null, {}, 'u=1', 42, { incremental: false }].forEach(function(v) {
            assert.equal(priority.serialize(v), '', 'input: ' + JSON.stringify(v));
        });
    });

    it('invalid urgency is DROPPED, never thrown or clamped; a non-boolean incremental is ignored', function() {
        assert.equal(priority.serialize({ urgency: 9 }),         '');
        assert.equal(priority.serialize({ urgency: -1 }),        '');
        assert.equal(priority.serialize({ urgency: 1.5 }),       '');
        assert.equal(priority.serialize({ urgency: '1' }),       '');
        assert.equal(priority.serialize({ urgency: NaN }),       '');
        assert.equal(priority.serialize({ incremental: 'yes' }), '');
        assert.equal(priority.serialize({ urgency: 9, incremental: true }), 'i');
    });

    it('round-trip identity for every valid parse', function() {
        ['u=0, i', 'u=0', 'u=1', 'u=1, i', 'u=2, i', 'u=3', 'i', 'u=7'].forEach(function(v) {
            var once  = priority.parse(v);
            var twice = priority.parse(priority.serialize(once));
            assert.deepEqual(twice, once, 'input: ' + v);
        });
    });
});


// ─── 07 — normalizeUrgency() ──────────────────────────────────────────────────

describe('07 - normalizeUrgency(): an integer 0–7, else the default', function() {

    it('accepts the range and rejects everything else', function() {
        for (var u = 0; u <= 7; u++) { assert.equal(priority.normalizeUrgency(u), u); }
        [8, -1, 1.5, '1', null, undefined, NaN, Infinity, true, {}].forEach(function(v) {
            assert.equal(priority.normalizeUrgency(v), 3, 'input: ' + String(v));
        });
    });
});


// ─── 08 — resolveOutbound() ───────────────────────────────────────────────────

describe('08 - resolveOutbound(): the four-rung outbound chain', function() {
    var inboundU0     = { urgency: 0, incremental: true,  present: true  };
    var inboundAbsent = { urgency: 3, incremental: false, present: false };

    it('rung 1 — a caller-set header wins, in any casing, and is left untouched (null = do nothing)', function() {
        assert.equal(priority.resolveOutbound({ headers: { priority: 'u=6' }, option: { urgency: 0 }, inbound: inboundU0 }), null);
        assert.equal(priority.resolveOutbound({ headers: { Priority: 'u=6' }, option: { urgency: 0 }, inbound: inboundU0 }), null);
        assert.equal(priority.resolveOutbound({ headers: { PRIORITY: 'i' },  inbound: inboundU0 }), null);
    });

    it('rung 1 does not fire on an empty or non-string header value', function() {
        assert.equal(priority.resolveOutbound({ headers: { priority: '' },   inbound: inboundU0 }), 'u=0, i');
        assert.equal(priority.resolveOutbound({ headers: { priority: null }, inbound: inboundU0 }), 'u=0, i');
    });

    it('rung 2 — option:false suppresses everything, including an inbound value', function() {
        assert.equal(priority.resolveOutbound({ headers: {}, option: false, inbound: inboundU0 }), null);
    });

    it('rung 3 — an explicit option is normalized: object form and wire-string form', function() {
        assert.equal(priority.resolveOutbound({ headers: {}, option: { urgency: 5 }, inbound: inboundU0 }), 'u=5');
        assert.equal(priority.resolveOutbound({ headers: {}, option: { urgency: 2, incremental: true } }), 'u=2, i');
        assert.equal(priority.resolveOutbound({ headers: {}, option: 'u=4, i' }), 'u=4, i');
        assert.equal(priority.resolveOutbound({ headers: {}, option: 'i' }), 'u=3, i'); // normalized form makes the default explicit
    });

    it('rung 3 — an explicit option that says nothing NEVER falls through to the inbound value', function() {
        assert.equal(priority.resolveOutbound({ headers: {}, option: {},             inbound: inboundU0 }), null);
        assert.equal(priority.resolveOutbound({ headers: {}, option: { urgency: 9 }, inbound: inboundU0 }), null);
        assert.equal(priority.resolveOutbound({ headers: {}, option: 'U=1',          inbound: inboundU0 }), null); // malformed string
        assert.equal(priority.resolveOutbound({ headers: {}, option: 42,             inbound: inboundU0 }), null);
    });

    it('rung 4 — a present inbound header propagates in normalized form', function() {
        assert.equal(priority.resolveOutbound({ headers: {}, inbound: inboundU0 }), 'u=0, i');
        assert.equal(priority.resolveOutbound({ headers: {}, inbound: { urgency: 3, incremental: false, present: true } }), 'u=3');
        assert.equal(priority.resolveOutbound({ inbound: priority.parse('u=2, i') }), 'u=2, i');
    });

    it('rung 5 — nothing inbound, nothing asked → null', function() {
        assert.equal(priority.resolveOutbound({ headers: {}, inbound: inboundAbsent }), null);
        assert.equal(priority.resolveOutbound({ headers: {}, inbound: null }), null);
        assert.equal(priority.resolveOutbound({}), null);
        assert.equal(priority.resolveOutbound(), null);
    });

    it('never mutates the headers map it reads', function() {
        var h = { 'x-request-id': 'abc' };
        priority.resolveOutbound({ headers: h, inbound: inboundU0 });
        assert.deepEqual(h, { 'x-request-id': 'abc' });
    });
});


// ─── 09 — source structure ────────────────────────────────────────────────────

describe('09 - source structure', function() {

    it("is pure: 'use strict', no require() of anything (comments stripped; the JSDoc example is the control)", function() {
        assert.ok(/^'use strict';/.test(SRC), "starts with 'use strict'");
        // The module docblock's @example legitimately shows `require('lib/priority')`,
        // so strip comments before asserting absence — and assert the RAW text still
        // contains the token, or a broken strip would pass this pin vacuously.
        var code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
        assert.ok(SRC.indexOf('require(') > -1, 'control: the docblock example must still mention require(');
        assert.equal(code.indexOf('require('), -1, 'the module must stay dependency-free');
    });

    it('exports exactly the documented surface', function() {
        assert.deepEqual(Object.keys(priority).sort(), [
            'DEFAULT_URGENCY', 'HEADER_NAME', 'URGENCY_MAX', 'URGENCY_MIN',
            'normalizeUrgency', 'parse', 'resolveOutbound', 'serialize'
        ]);
        assert.equal(priority.DEFAULT_URGENCY, 3);
        assert.equal(priority.URGENCY_MIN, 0);
        assert.equal(priority.URGENCY_MAX, 7);
        assert.equal(priority.HEADER_NAME, 'priority');
    });
});
