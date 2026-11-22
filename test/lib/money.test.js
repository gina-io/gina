'use strict';
/**
 * lib/money (#FIN5) — behavioral suite against the REAL module
 *
 * The module is dependency-free and dual-context, so it loads standalone —
 * no framework bootstrap, no source pins needed for the logic: every claim
 * here is driven, not shape-matched. The one structural suite (§07) locks
 * the dual-publish shell and the BigInt constructor-form rule that keeps the
 * module parseable by every tool in the browser-bundle build chain.
 *
 * Suites:
 *  01 — exponent(): defaults, exceptions, malformed codes
 *  02 — parse(): wire strings in, exactness, strict precision, rejects floats
 *  03 — fromMinor()/toMinor(): integer forms in, JSON-safe string out
 *  04 — arithmetic: add/subtract/multiply exactness incl. beyond
 *       Number.MAX_SAFE_INTEGER, the float-hazard control, mismatch guards
 *  05 — compare(): three-way + guards
 *  06 — format(): canonical wire strings, round-trip identity
 *  07 — source structure: dual-publish shell, no BigInt literals
 */
var { describe, it } = require('node:test');
var assert = require('node:assert/strict');
var path   = require('path');

var FW    = require('../fw');
var money = require(path.join(FW, 'lib/money/src/main.js'));
var SRC   = require('fs').readFileSync(path.join(FW, 'lib/money/src/main.js'), 'utf8');
var commentStrip = require('../strip-comments');


// ─── 01 — exponent() ──────────────────────────────────────────────────────────

describe('01 - exponent(): ISO 4217 minor units', function() {

    it('defaults to 2 for unlisted well-formed codes', function() {
        assert.equal(money.exponent('EUR'), 2);
        assert.equal(money.exponent('USD'), 2);
        assert.equal(money.exponent('XXX'), 2); // unlisted — ISO default
    });

    it('carries the 0-exponent exceptions', function() {
        assert.equal(money.exponent('JPY'), 0);
        assert.equal(money.exponent('KRW'), 0);
        assert.equal(money.exponent('XOF'), 0);
    });

    it('carries the 3- and 4-exponent exceptions', function() {
        assert.equal(money.exponent('BHD'), 3);
        assert.equal(money.exponent('KWD'), 3);
        assert.equal(money.exponent('TND'), 3);
        assert.equal(money.exponent('CLF'), 4);
    });

    it('is case-insensitive on input', function() {
        assert.equal(money.exponent('jpy'), 0);
        assert.equal(money.exponent('eUr'), 2);
    });

    it('throws on malformed codes', function() {
        assert.throws(function(){ money.exponent('EU'); },   TypeError);
        assert.throws(function(){ money.exponent('EURO'); }, TypeError);
        assert.throws(function(){ money.exponent('E1R'); },  TypeError);
        assert.throws(function(){ money.exponent(978); },    TypeError); // numeric ISO code is not the alpha code
        assert.throws(function(){ money.exponent(''); },     TypeError);
    });
});


// ─── 02 — parse() ─────────────────────────────────────────────────────────────

describe('02 - parse(): strict wire strings', function() {

    it('parses the canonical forms exactly', function() {
        var a = money.parse('19.99', 'EUR');
        assert.equal(a.currency, 'EUR');
        assert.equal(a.exponent, 2);
        assert.equal(a.minor, BigInt('1999'));
    });

    it('scales short fractions up, never guesses on long ones', function() {
        assert.equal(money.parse('19.9', 'EUR').minor, BigInt('1990'));
        assert.equal(money.parse('7', 'EUR').minor,    BigInt('700'));
        assert.throws(function(){ money.parse('1.005', 'EUR'); }, /fractional digit/);
    });

    it('handles negatives, including sub-unit ones', function() {
        assert.equal(money.parse('-0.05', 'EUR').minor, BigInt('-5'));
        assert.equal(money.parse('-3', 'JPY').minor,    BigInt('-3'));
    });

    it('respects the currency exponent (JPY takes no fraction, BHD takes 3)', function() {
        assert.equal(money.parse('150', 'JPY').minor,   BigInt('150'));
        assert.throws(function(){ money.parse('150.5', 'JPY'); }, /fractional digit/);
        assert.equal(money.parse('1.250', 'BHD').minor, BigInt('1250'));
    });

    it('REJECTS a number input — floats are the hazard, not an input format', function() {
        assert.throws(function(){ money.parse(19.99, 'EUR'); }, /WIRE STRING/);
    });

    it('rejects malformed strings', function() {
        ['', '1,50', '1.2.3', 'abc', '1e3', '+5', '.5', '5.', '1 000'].forEach(function(bad) {
            assert.throws(function(){ money.parse(bad, 'EUR'); }, TypeError, 'should reject `' + bad + '`');
        });
    });

    it('trims surrounding whitespace only', function() {
        assert.equal(money.parse(' 12.00 ', 'EUR').minor, BigInt('1200'));
    });
});


// ─── 03 — fromMinor() / toMinor() ─────────────────────────────────────────────

describe('03 - fromMinor()/toMinor()', function() {

    it('accepts integer number, integer string and bigint', function() {
        assert.equal(money.fromMinor(1999, 'EUR').minor,          BigInt('1999'));
        assert.equal(money.fromMinor('250', 'JPY').minor,         BigInt('250'));
        assert.equal(money.fromMinor(BigInt('-5'), 'EUR').minor,  BigInt('-5'));
    });

    it('rejects non-integer numbers and garbage strings', function() {
        assert.throws(function(){ money.fromMinor(19.99, 'EUR'); },  /INTEGER/);
        assert.throws(function(){ money.fromMinor('1.5', 'EUR'); },  TypeError);
        assert.throws(function(){ money.fromMinor(Infinity, 'EUR'); }, TypeError);
        assert.throws(function(){ money.fromMinor(NaN, 'EUR'); },    TypeError);
    });

    it('toMinor() returns a JSON-safe decimal string', function() {
        assert.equal(money.toMinor(money.parse('19.99', 'EUR')), '1999');
        assert.equal(money.toMinor(money.parse('-0.05', 'EUR')), '-5');
        assert.equal(typeof money.toMinor(money.parse('1', 'EUR')), 'string');
    });
});


// ─── 04 — arithmetic ──────────────────────────────────────────────────────────

describe('04 - arithmetic: exact where floats are not', function() {

    it('CONTROL — the float hazard is real on this runtime', function() {
        // The defect class the module exists for. If this ever fails, the
        // JS numeric model changed and the module premise needs re-review.
        assert.notEqual(0.1 + 0.2, 0.3);
    });

    it('0.10 + 0.20 = 0.30, exactly', function() {
        var sum = money.add(money.parse('0.10', 'EUR'), money.parse('0.20', 'EUR'));
        assert.equal(money.format(sum), '0.30');
    });

    it('stays exact beyond Number.MAX_SAFE_INTEGER minor units', function() {
        // 2^53 = 9007199254740992: (2^53 + 1) is unrepresentable as a float —
        // float math collapses it onto 2^53 and the +1 vanishes. BigInt keeps it.
        var big = money.fromMinor('9007199254740993', 'EUR');
        var sum = money.add(big, money.fromMinor(1, 'EUR'));
        assert.equal(money.toMinor(sum), '9007199254740994');
        assert.notEqual(9007199254740993 + 1, 9007199254740994); // the float collapse, as a control
    });

    it('subtract() is exact and sign-correct', function() {
        var d = money.subtract(money.parse('1.00', 'EUR'), money.parse('1.05', 'EUR'));
        assert.equal(money.format(d), '-0.05');
    });

    it('multiply() takes integer factors in all three forms', function() {
        var unit = money.parse('19.99', 'EUR');
        assert.equal(money.format(money.multiply(unit, 3)),          '59.97');
        assert.equal(money.format(money.multiply(unit, '3')),        '59.97');
        assert.equal(money.format(money.multiply(unit, BigInt(3))),  '59.97');
    });

    it('multiply() rejects fractional factors — rounding is the application\'s', function() {
        assert.throws(function(){ money.multiply(money.parse('1.00', 'EUR'), 0.21); }, /INTEGER factor/);
        assert.throws(function(){ money.multiply(money.parse('1.00', 'EUR'), '1.5'); }, TypeError);
    });

    it('currency mismatch always throws — on add, subtract and compare', function() {
        var eur = money.parse('1.00', 'EUR');
        var usd = money.parse('1.00', 'USD');
        assert.throws(function(){ money.add(eur, usd); },      /currency mismatch/);
        assert.throws(function(){ money.subtract(eur, usd); }, /currency mismatch/);
        assert.throws(function(){ money.compare(eur, usd); },  /currency mismatch/);
    });

    it('non-amount shapes are refused, not coerced', function() {
        assert.throws(function(){ money.add(money.parse('1', 'EUR'), { minor: 100 }); }, /not a money amount/);
        assert.throws(function(){ money.format({ currency: 'EUR', minor: 100 }); },      /not a money amount/); // number minor = not ours
    });
});


// ─── 05 — compare() ───────────────────────────────────────────────────────────

describe('05 - compare()', function() {

    it('returns -1 / 0 / 1', function() {
        var a = money.parse('1.00', 'EUR'), b = money.parse('2.00', 'EUR');
        assert.equal(money.compare(a, b), -1);
        assert.equal(money.compare(b, a), 1);
        assert.equal(money.compare(a, money.parse('1.00', 'EUR')), 0);
    });
});


// ─── 06 — format() ────────────────────────────────────────────────────────────

describe('06 - format(): canonical wire strings', function() {

    it('always emits exactly the currency\'s fraction digits', function() {
        assert.equal(money.format(money.parse('20', 'EUR')),    '20.00');
        assert.equal(money.format(money.parse('19.9', 'EUR')),  '19.90');
        assert.equal(money.format(money.fromMinor(5, 'EUR')),   '0.05');
        assert.equal(money.format(money.fromMinor(-5, 'EUR')),  '-0.05');
        assert.equal(money.format(money.fromMinor(150, 'JPY')), '150');
        assert.equal(money.format(money.parse('1.250', 'BHD')), '1.250');
    });

    it('parse(format(x)) is the identity on minor units', function() {
        ['0.01', '19.99', '-0.05', '1234567.89'].forEach(function(s) {
            var a = money.parse(s, 'EUR');
            assert.equal(money.toMinor(money.parse(money.format(a), 'EUR')), money.toMinor(a));
        });
    });
});


// ─── 07 — source structure ────────────────────────────────────────────────────

describe('07 - source structure: dual-publish shell, constructor-form BigInt', function() {

    it('publishes for node AND AMD (the lib/cache dual-context shell)', function() {
        assert.ok(/module\.exports = Money/.test(SRC), 'node publish tail');
        assert.ok(/define\(function\(\) \{ return Money \}\)/.test(SRC), 'AMD publish tail');
    });

    it('contains NO BigInt literal — constructor form only', function() {
        // A `123n` literal is syntax some build-chain parsers reject; the
        // constructor form is a plain call every parser passes through.
        // Strip line/block comments so a doc mention can never satisfy or
        // trip the pin, then require zero digit+n literals in code.
        var active = commentStrip.lines(SRC);
        assert.equal((active.match(/\b\d+n\b/g) || []).length, 0, 'no BigInt literals in code');
        assert.ok(/BigInt\(/.test(active), 'constructor form present (the control that the sweep sees real code)');
    });

    it('declares zero requires — the dependency-free property the alias relies on', function() {
        var active = commentStrip.lines(SRC);
        assert.equal((active.match(/require\(/g) || []).length, 0, 'lib/money must stay dependency-free');
    });
});
